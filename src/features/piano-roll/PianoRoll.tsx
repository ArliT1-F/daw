import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { ProjectCommand } from '../../core/commands';
import { createStableId, type Note, type Pattern, type Project } from '../../core/project/model';
import type { TransportState } from '../../core/transport';
import { ticksPerBar, ticksPerBeat, formatTickPosition } from '../../core/time/ticks';
import { PanelFrame } from '../../components/PanelFrame';
import {
  ALL_PITCHES,
  DEFAULT_KEY_HEIGHT,
  DEFAULT_LENGTH_ID,
  DEFAULT_NOTE_VELOCITY,
  DEFAULT_PX_PER_STEP,
  DEFAULT_SNAP_ID,
  DRAG_THRESHOLD_PX,
  GRID_SNAP_OPTIONS,
  KEYBOARD_WIDTH,
  LENGTH_PRESETS,
  RULER_HEIGHT,
  VELOCITY_LANE_HEIGHT,
  type EditorTool,
  type NoteHitEdge,
  type PixelRect,
  clampKeyHeight,
  clampPxPerStep,
  contentToPitchTick,
  duplicateNotes,
  durationFromDraw,
  gridContentHeight,
  gridContentWidth,
  hitTestNote,
  isBlackKey,
  lengthTicksFor,
  notesEqual,
  notesIntersectingRect,
  pasteNotes,
  patternTicks,
  pitchLabel,
  pitchToY,
  placeNote,
  playheadTickInPattern,
  pointerToContent,
  quantizeNotes,
  replaceSelectedNotes,
  resizeNotesAsGroup,
  seekStepFromPatternTick,
  snapTicksFor,
  snappedStartForDraw,
  tickToX,
  translateNotesAsGroup,
  velocityFromLaneY,
  xToTick,
} from './pianoRollModel';

interface PianoRollProps {
  project: Project;
  pattern: Pattern;
  selectedChannelId: string;
  onSelectChannel: (channelId: string) => void;
  transport: TransportState;
  collapsed: boolean;
  onToggle: () => void;
  onCommand: (command: ProjectCommand) => void;
  /** True only while the audio engine is genuinely playing. */
  playbackActive?: boolean;
  getPlayheadSteps?: () => number;
  onPreviewNote?: (pitch: number, velocity: number) => void;
  onSeek?: (step: number) => void;
}

type Gesture =
  | { kind: 'none' }
  | {
      kind: 'pending';
      pointerId: number;
      x: number;
      y: number;
      tick: number;
      pitch: number;
      button: number;
      shift: boolean;
      alt: boolean;
      target: 'empty' | 'note' | 'velocity' | 'ruler';
      noteId?: string;
      edge?: NoteHitEdge;
      scrollLeft: number;
      scrollTop: number;
    }
  | { kind: 'draw'; pointerId: number; startTick: number; pitch: number; velocity: number }
  | { kind: 'move'; pointerId: number; origin: Note[]; originTick: number; originPitch: number }
  | { kind: 'resize'; pointerId: number; origin: Note[]; edge: 'start' | 'end'; originTick: number }
  | { kind: 'marquee'; pointerId: number; x0: number; y0: number }
  | { kind: 'velocity'; pointerId: number; noteIds: string[] }
  | { kind: 'pan'; pointerId: number; startX: number; startY: number; scrollLeft: number; scrollTop: number }
  | { kind: 'cancelled' };

export function PianoRoll({
  project,
  pattern,
  selectedChannelId,
  onSelectChannel,
  transport,
  collapsed,
  onToggle,
  onCommand,
  playbackActive = false,
  getPlayheadSteps,
  onPreviewNote,
  onSeek,
}: PianoRollProps) {
  const notes = pattern.notes[selectedChannelId] ?? [];
  const channel = project.channels.find((item) => item.id === selectedChannelId);
  const timeSignature = project.settings.timeSignature;
  const lengthTicks = patternTicks(pattern.lengthSteps);

  const [tool, setTool] = useState<EditorTool>('draw');
  const [snapId, setSnapId] = useState(DEFAULT_SNAP_ID);
  const [lengthId, setLengthId] = useState(DEFAULT_LENGTH_ID);
  const [pxPerStep, setPxPerStep] = useState(DEFAULT_PX_PER_STEP);
  const [keyHeight, setKeyHeight] = useState(DEFAULT_KEY_HEIGHT);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [draftNotes, setDraftNotes] = useState<Note[] | null>(null);
  const [ghost, setGhost] = useState<{ startTick: number; durationTicks: number; pitch: number } | null>(null);
  const [marquee, setMarquee] = useState<PixelRect | null>(null);
  const [hover, setHover] = useState<{ pitch: number; tick: number } | null>(null);

  const gridScrollRef = useRef<HTMLDivElement | null>(null);
  const keysScrollRef = useRef<HTMLDivElement | null>(null);
  const rulerScrollRef = useRef<HTMLDivElement | null>(null);
  const velocityScrollRef = useRef<HTMLDivElement | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<Gesture>({ kind: 'none' });
  const clipboardRef = useRef<Note[]>([]);
  const lastPointerRef = useRef<{ tick: number; pitch: number }>({ tick: 0, pitch: 60 });
  const lastVelocityRef = useRef(DEFAULT_NOTE_VELOCITY);
  const lastPreviewRef = useRef<number | null>(null);
  const spaceDownRef = useRef(false);
  const didInitScroll = useRef(false);
  const syncingScroll = useRef(false);

  const selectedRef = useRef(selectedIds);
  selectedRef.current = selectedIds;
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const draftRef = useRef(draftNotes);
  draftRef.current = draftNotes;
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const snapIdRef = useRef(snapId);
  snapIdRef.current = snapId;
  const lengthIdRef = useRef(lengthId);
  lengthIdRef.current = lengthId;
  const pxPerStepRef = useRef(pxPerStep);
  pxPerStepRef.current = pxPerStep;
  const keyHeightRef = useRef(keyHeight);
  keyHeightRef.current = keyHeight;

  const snapTicks = snapTicksFor(snapId, timeSignature);
  const presetDuration = lengthTicksFor(lengthId, timeSignature);
  const displayedNotes = draftNotes ?? notes;
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const noteColor = channel?.color ?? '#c5ed7d';
  const contentWidth = gridContentWidth(lengthTicks, pxPerStep);
  const contentHeight = gridContentHeight(keyHeight);
  const barTicks = ticksPerBar(timeSignature);
  const beatTicks = ticksPerBeat(timeSignature);
  const canPreview = channel?.kind === 'instrument';

  const commitLane = useCallback(
    (next: Note[]) => {
      if (notesEqual(next, notesRef.current)) return;
      onCommand({
        type: 'pattern.notes.replace',
        patternId: pattern.id,
        channelId: selectedChannelId,
        notes: next,
      });
    },
    [onCommand, pattern.id, selectedChannelId],
  );

  const previewPitch = useCallback(
    (pitch: number, velocity: number, force = false) => {
      if (!onPreviewNote || !canPreview) return;
      if (!force && lastPreviewRef.current === pitch) return;
      lastPreviewRef.current = pitch;
      onPreviewNote(pitch, velocity);
    },
    [onPreviewNote, canPreview],
  );

  useLayoutEffect(() => {
    if (didInitScroll.current) return;
    const grid = gridScrollRef.current;
    if (!grid) return;
    didInitScroll.current = true;
    grid.scrollTop = Math.max(0, pitchToY(72, DEFAULT_KEY_HEIGHT) - 24);
  }, []);

  useEffect(() => {
    setSelectedIds((current) => current.filter((id) => notes.some((note) => note.id === id)));
    draftRef.current = null;
    setDraftNotes(null);
    setGhost(null);
    setMarquee(null);
    gestureRef.current = { kind: 'none' };
  }, [selectedChannelId, pattern.id]);

  const syncScrollFromGrid = useCallback(() => {
    const grid = gridScrollRef.current;
    if (!grid || syncingScroll.current) return;
    syncingScroll.current = true;
    if (keysScrollRef.current) keysScrollRef.current.scrollTop = grid.scrollTop;
    if (rulerScrollRef.current) rulerScrollRef.current.scrollLeft = grid.scrollLeft;
    if (velocityScrollRef.current) velocityScrollRef.current.scrollLeft = grid.scrollLeft;
    syncingScroll.current = false;
  }, []);

  function onKeysScroll() {
    const keys = keysScrollRef.current;
    const grid = gridScrollRef.current;
    if (!keys || !grid || syncingScroll.current) return;
    syncingScroll.current = true;
    grid.scrollTop = keys.scrollTop;
    syncingScroll.current = false;
  }

  function updatePlayhead(steps: number) {
    const tick = playheadTickInPattern(steps, pattern.lengthSteps);
    const x = tickToX(tick, pxPerStepRef.current);
    if (playheadRef.current) playheadRef.current.style.transform = `translateX(${x}px)`;
  }

  useEffect(() => {
    if (!playbackActive || !getPlayheadSteps) {
      updatePlayhead(transport.positionStep);
      return undefined;
    }
    let frame = 0;
    const draw = () => {
      updatePlayhead(getPlayheadSteps());
      frame = window.requestAnimationFrame(draw);
    };
    frame = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(frame);
  }, [playbackActive, getPlayheadSteps, transport.positionStep, pattern.lengthSteps, pxPerStep]);

  useEffect(() => {
    const node = gridScrollRef.current;
    if (!node) return undefined;
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      if (event.altKey) {
        setKeyHeight((current) => clampKeyHeight(current + (event.deltaY < 0 ? 1 : -1)));
      } else {
        const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
        setPxPerStep((current) => clampPxPerStep(current * factor));
      }
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, []);

  function gridPoint(event: { clientX: number; clientY: number }): { x: number; y: number; tick: number; pitch: number } {
    const scroll = gridScrollRef.current;
    if (!scroll) return { x: 0, y: 0, tick: 0, pitch: 60 };
    const rect = scroll.getBoundingClientRect();
    const { x, y } = pointerToContent(event.clientX, event.clientY, rect, scroll.scrollLeft, scroll.scrollTop);
    const { tick, pitch } = contentToPitchTick(x, y, { pxPerStep: pxPerStepRef.current, keyHeight: keyHeightRef.current });
    return { x, y, tick, pitch };
  }

  function endGesture() {
    gestureRef.current = { kind: 'none' };
    setGhost(null);
    setMarquee(null);
    setDraft(null);
    lastPreviewRef.current = null;
  }

  function onGridPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (event.button === 2) return;
    workspaceRef.current?.focus();
    const scroll = gridScrollRef.current;
    if (!scroll) return;
    const point = gridPoint(event);
    lastPointerRef.current = { tick: point.tick, pitch: point.pitch };
    const hit = hitTestNote(notesRef.current, point.x, point.y, {
      pxPerStep: pxPerStepRef.current,
      keyHeight: keyHeightRef.current,
    });

    if (event.button === 1 || spaceDownRef.current) {
      gestureRef.current = {
        kind: 'pan',
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        scrollLeft: scroll.scrollLeft,
        scrollTop: scroll.scrollTop,
      };
      event.preventDefault();
      try {
        scroll.setPointerCapture(event.pointerId);
      } catch {
        /* jsdom and some browsers throw if the pointer is not active */
      }
      return;
    }

    gestureRef.current = {
      kind: 'pending',
      pointerId: event.pointerId,
      x: point.x,
      y: point.y,
      tick: point.tick,
      pitch: point.pitch,
      button: event.button,
      shift: event.shiftKey,
      alt: event.altKey,
      target: hit ? 'note' : 'empty',
      noteId: hit?.note.id,
      edge: hit?.edge,
      scrollLeft: scroll.scrollLeft,
      scrollTop: scroll.scrollTop,
    };
    event.preventDefault();
    try {
      scroll.setPointerCapture(event.pointerId);
    } catch {
      /* jsdom and some browsers throw if the pointer is not active */
    }
  }

  function onVelocityPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    workspaceRef.current?.focus();
    const lane = velocityScrollRef.current;
    if (!lane) return;
    const rect = lane.getBoundingClientRect();
    const x = event.clientX - rect.left + lane.scrollLeft;
    const y = event.clientY - rect.top;
    const hit = hitVelocity(notesRef.current, x, pxPerStepRef.current, selectedRef.current);
    if (!hit) return;
    const ids = selectedRef.current.includes(hit.id) && selectedRef.current.length > 1 ? selectedRef.current : [hit.id];
    gestureRef.current = { kind: 'velocity', pointerId: event.pointerId, noteIds: ids };
    applyVelocity(ids, velocityFromLaneY(y, VELOCITY_LANE_HEIGHT), true);
    event.preventDefault();
    try {
      lane.setPointerCapture(event.pointerId);
    } catch {
      /* jsdom and some browsers throw if the pointer is not active */
    }
  }

  function hitVelocity(lane: readonly Note[], x: number, pxPerStepValue: number, selected: readonly string[]): Note | null {
    const ordered = [...lane].reverse();
    const preferred = ordered.find((note) => selected.includes(note.id) && xInNote(note, x, pxPerStepValue));
    if (preferred) return preferred;
    return ordered.find((note) => xInNote(note, x, pxPerStepValue)) ?? null;
  }

  function xInNote(note: Note, x: number, pxPerStepValue: number): boolean {
    const x0 = tickToX(note.startTick, pxPerStepValue);
    const x1 = tickToX(note.startTick + note.durationTicks, pxPerStepValue);
    return x >= x0 && x <= Math.max(x1, x0 + 4);
  }

  function setDraft(next: Note[] | null) {
    draftRef.current = next;
    setDraftNotes(next);
  }

  function applyVelocity(ids: readonly string[], velocity: number, live: boolean) {
    lastVelocityRef.current = velocity;
    const lane = draftRef.current ?? notesRef.current;
    const next = lane.map((note) => (ids.includes(note.id) ? { ...note, velocity } : note));
    if (live) setDraft(next);
    else commitLane(next);
  }

  function promotePending(event: PointerEvent, pending: Extract<Gesture, { kind: 'pending' }>) {
    const scroll = gridScrollRef.current;
    if (!scroll) return;
    const point = gridPoint(event);
    const dx = point.x - pending.x;
    const dy = point.y - pending.y;
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    if (scroll.scrollLeft !== pending.scrollLeft || scroll.scrollTop !== pending.scrollTop) {
      gestureRef.current = { kind: 'cancelled' };
      return;
    }

    const snap = snapTicksFor(snapIdRef.current, timeSignature);
    const lane = notesRef.current;

    if (pending.target === 'empty') {
      if (toolRef.current === 'select' || pending.shift) {
        gestureRef.current = { kind: 'marquee', pointerId: pending.pointerId, x0: pending.x, y0: pending.y };
        setMarquee({ x0: pending.x, y0: pending.y, x1: point.x, y1: point.y });
        return;
      }
      const startTick = snappedStartForDraw(pending.tick, snap, lengthTicks);
      gestureRef.current = {
        kind: 'draw',
        pointerId: pending.pointerId,
        startTick,
        pitch: pending.pitch,
        velocity: lastVelocityRef.current,
      };
      const duration = durationFromDraw(startTick, point.tick, snap, lengthTicks);
      setGhost({ startTick, durationTicks: duration, pitch: pending.pitch });
      previewPitch(pending.pitch, lastVelocityRef.current, true);
      return;
    }

    if (pending.target === 'note' && pending.noteId) {
      const hitNote = lane.find((item) => item.id === pending.noteId);
      if (!hitNote) return;
      let selected = selectedRef.current;
      if (!selected.includes(hitNote.id)) {
        selected = pending.shift ? [...selected, hitNote.id] : [hitNote.id];
        setSelectedIds(selected);
        selectedRef.current = selected;
      }
      let working = lane;
      let origin = working.filter((item) => selected.includes(item.id));
      if (pending.alt) {
        const copies = duplicateNotes(origin, 0, lengthTicks, () => createStableId('note'));
        working = [...lane, ...copies];
        origin = copies;
        selected = copies.map((item) => item.id);
        setSelectedIds(selected);
        selectedRef.current = selected;
        setDraftNotes(working);
      }
      if (pending.edge === 'start' || pending.edge === 'end') {
        gestureRef.current = {
          kind: 'resize',
          pointerId: pending.pointerId,
          origin,
          edge: pending.edge,
          originTick: pending.tick,
        };
        return;
      }
      gestureRef.current = {
        kind: 'move',
        pointerId: pending.pointerId,
        origin,
        originTick: pending.tick,
        originPitch: pending.pitch,
      };
      previewPitch(pending.pitch, origin[0]?.velocity ?? lastVelocityRef.current, true);
    }
  }

  function onWindowPointerMove(event: PointerEvent) {
    const gesture = gestureRef.current;
    if (gesture.kind === 'none' || gesture.kind === 'cancelled') return;
    if ('pointerId' in gesture && gesture.pointerId !== event.pointerId) return;

    if (gesture.kind === 'pending') {
      promotePending(event, gesture);
      return;
    }

    if (gesture.kind === 'pan') {
      const scroll = gridScrollRef.current;
      if (!scroll) return;
      scroll.scrollLeft = gesture.scrollLeft - (event.clientX - gesture.startX);
      scroll.scrollTop = gesture.scrollTop - (event.clientY - gesture.startY);
      syncScrollFromGrid();
      return;
    }

    if (gesture.kind === 'draw') {
      const point = gridPoint(event);
      const snap = snapTicksFor(snapIdRef.current, timeSignature);
      const duration = durationFromDraw(gesture.startTick, point.tick, snap, lengthTicks);
      setGhost({ startTick: gesture.startTick, durationTicks: duration, pitch: gesture.pitch });
      return;
    }

    if (gesture.kind === 'marquee') {
      const point = gridPoint(event);
      setMarquee({ x0: gesture.x0, y0: gesture.y0, x1: point.x, y1: point.y });
      return;
    }

    if (gesture.kind === 'move') {
      const point = gridPoint(event);
      const snap = snapTicksFor(snapIdRef.current, timeSignature);
      const rawDt = point.tick - gesture.originTick;
      const dt = Math.round(rawDt / snap) * snap;
      const dp = point.pitch - gesture.originPitch;
      const moved = translateNotesAsGroup(gesture.origin, dt, dp, lengthTicks);
      const next = replaceSelectedNotes(notesRef.current, new Set(gesture.origin.map((item) => item.id)), moved);
      setDraft(next);
      if (moved[0]) previewPitch(moved[0].pitch, moved[0].velocity);
      return;
    }

    if (gesture.kind === 'resize') {
      const point = gridPoint(event);
      const snap = snapTicksFor(snapIdRef.current, timeSignature);
      const rawDt = point.tick - gesture.originTick;
      const dt = Math.round(rawDt / snap) * snap;
      const resized = resizeNotesAsGroup(gesture.origin, gesture.edge, dt, lengthTicks, snap);
      const next = replaceSelectedNotes(notesRef.current, new Set(gesture.origin.map((item) => item.id)), resized);
      setDraft(next);
      return;
    }

    if (gesture.kind === 'velocity') {
      const lane = velocityScrollRef.current;
      if (!lane) return;
      const y = event.clientY - lane.getBoundingClientRect().top;
      applyVelocity(gesture.noteIds, velocityFromLaneY(y, VELOCITY_LANE_HEIGHT), true);
    }
  }

  function onWindowPointerUp(event: PointerEvent) {
    const gesture = gestureRef.current;
    if (gesture.kind === 'none') return;
    if (gesture.kind === 'cancelled') {
      endGesture();
      return;
    }
    if ('pointerId' in gesture && gesture.pointerId !== event.pointerId) return;

    if (gesture.kind === 'pending') {
      const scroll = gridScrollRef.current;
      const scrolled = Boolean(
        scroll && (scroll.scrollLeft !== gesture.scrollLeft || scroll.scrollTop !== gesture.scrollTop),
      );
      if (!scrolled) {
        if (gesture.target === 'note' && gesture.noteId) {
          setSelectedIds((current) => {
            if (gesture.shift) {
              return current.includes(gesture.noteId!)
                ? current.filter((id) => id !== gesture.noteId)
                : [...current, gesture.noteId!];
            }
            return [gesture.noteId!];
          });
        } else if (gesture.target === 'empty') {
          if (toolRef.current === 'draw' && !gesture.shift) {
            const snap = snapTicksFor(snapIdRef.current, timeSignature);
            const start = snappedStartForDraw(gesture.tick, snap, lengthTicks);
            const duration = lengthTicksFor(lengthIdRef.current, timeSignature);
            const created = placeNote(start, gesture.pitch, duration, lengthTicks, createStableId('note'), lastVelocityRef.current);
            if (created) {
              commitLane([...notesRef.current, created]);
              setSelectedIds([created.id]);
              previewPitch(created.pitch, created.velocity, true);
            }
          } else {
            setSelectedIds([]);
          }
        }
      }
      endGesture();
      return;
    }

    if (gesture.kind === 'draw') {
      const created = placeNote(
        gesture.startTick,
        gesture.pitch,
        ghost?.durationTicks ?? presetDuration,
        lengthTicks,
        createStableId('note'),
        gesture.velocity,
      );
      if (created) {
        commitLane([...notesRef.current, created]);
        setSelectedIds([created.id]);
      }
      endGesture();
      return;
    }

    if (gesture.kind === 'move' || gesture.kind === 'resize' || gesture.kind === 'velocity') {
      if (draftRef.current) commitLane(draftRef.current);
      endGesture();
      return;
    }

    if (gesture.kind === 'marquee') {
      const rect = marquee ?? { x0: gesture.x0, y0: gesture.y0, x1: gesture.x0, y1: gesture.y0 };
      const hits = notesIntersectingRect(notesRef.current, rect, {
        pxPerStep: pxPerStepRef.current,
        keyHeight: keyHeightRef.current,
      });
      setSelectedIds(hits.map((note) => note.id));
      endGesture();
      return;
    }

    endGesture();
  }

  useEffect(() => {
    const move = (event: PointerEvent) => onWindowPointerMove(event);
    const up = (event: PointerEvent) => onWindowPointerUp(event);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  });

  function onGridContextMenu(event: React.MouseEvent<HTMLElement>) {
    event.preventDefault();
    const point = gridPoint(event);
    const hit = hitTestNote(notesRef.current, point.x, point.y, {
      pxPerStep: pxPerStepRef.current,
      keyHeight: keyHeightRef.current,
    });
    if (!hit) return;
    const ids = selectedRef.current.includes(hit.note.id) && selectedRef.current.length > 0 ? selectedRef.current : [hit.note.id];
    commitLane(notesRef.current.filter((note) => !ids.includes(note.id)));
    setSelectedIds([]);
  }

  function onGridScroll() {
    const gesture = gestureRef.current;
    if (gesture.kind === 'pending') {
      const scroll = gridScrollRef.current;
      if (scroll && (scroll.scrollLeft !== gesture.scrollLeft || scroll.scrollTop !== gesture.scrollTop)) {
        gestureRef.current = { kind: 'cancelled' };
      }
    }
    syncScrollFromGrid();
  }

  function deleteSelected() {
    if (selectedRef.current.length === 0) return;
    const ids = new Set(selectedRef.current);
    commitLane(notesRef.current.filter((note) => !ids.has(note.id)));
    setSelectedIds([]);
  }

  function duplicateSelected() {
    if (selectedRef.current.length === 0) return;
    const snap = snapTicksFor(snapIdRef.current, timeSignature);
    const origin = notesRef.current.filter((note) => selectedRef.current.includes(note.id));
    const copies = duplicateNotes(origin, snap, lengthTicks, () => createStableId('note'));
    commitLane([...notesRef.current, ...copies]);
    setSelectedIds(copies.map((note) => note.id));
  }

  function quantizeSelected() {
    const ids = selectedRef.current;
    if (ids.length === 0) return;
    const snap = snapTicksFor(snapIdRef.current, timeSignature);
    const origin = notesRef.current.filter((note) => ids.includes(note.id));
    const quantized = quantizeNotes(origin, snap, lengthTicks);
    commitLane(replaceSelectedNotes(notesRef.current, new Set(ids), quantized));
  }

  function copySelected() {
    clipboardRef.current = notesRef.current
      .filter((note) => selectedRef.current.includes(note.id))
      .map((note) => ({ ...note }));
  }

  function pasteClipboard() {
    if (clipboardRef.current.length === 0) return;
    const at = lastPointerRef.current;
    const next = pasteNotes(
      notesRef.current,
      clipboardRef.current,
      at.tick,
      at.pitch,
      lengthTicks,
      () => createStableId('note'),
    );
    const newIds = next.slice(notesRef.current.length).map((note) => note.id);
    commitLane(next);
    setSelectedIds(newIds);
  }

  function nudge(deltaTicks: number, deltaPitch: number) {
    if (selectedRef.current.length === 0) return;
    const origin = notesRef.current.filter((note) => selectedRef.current.includes(note.id));
    const moved = translateNotesAsGroup(origin, deltaTicks, deltaPitch, lengthTicks);
    commitLane(replaceSelectedNotes(notesRef.current, new Set(selectedRef.current), moved));
  }

  function onWorkspaceKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.matches('input, textarea, select')) return;
    const commandKey = event.metaKey || event.ctrlKey;

    if (event.code === 'Space') {
      spaceDownRef.current = true;
      return;
    }
    if (commandKey && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      setSelectedIds(notesRef.current.map((note) => note.id));
      return;
    }
    if (commandKey && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      copySelected();
      return;
    }
    if (commandKey && event.key.toLowerCase() === 'x') {
      event.preventDefault();
      copySelected();
      deleteSelected();
      return;
    }
    if (commandKey && event.key.toLowerCase() === 'v') {
      event.preventDefault();
      pasteClipboard();
      return;
    }
    if (commandKey && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      duplicateSelected();
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      deleteSelected();
      return;
    }
    if (event.key === 'Escape') {
      setSelectedIds([]);
      endGesture();
      return;
    }
    const snap = snapTicksFor(snapIdRef.current, timeSignature);
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (event.shiftKey) {
        const origin = notesRef.current.filter((note) => selectedRef.current.includes(note.id));
        const resized = resizeNotesAsGroup(origin, 'end', -snap, lengthTicks, snap);
        commitLane(replaceSelectedNotes(notesRef.current, new Set(selectedRef.current), resized));
      } else {
        nudge(-snap, 0);
      }
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (event.shiftKey) {
        const origin = notesRef.current.filter((note) => selectedRef.current.includes(note.id));
        const resized = resizeNotesAsGroup(origin, 'end', snap, lengthTicks, snap);
        commitLane(replaceSelectedNotes(notesRef.current, new Set(selectedRef.current), resized));
      } else {
        nudge(snap, 0);
      }
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      nudge(0, event.altKey ? 12 : 1);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      nudge(0, event.altKey ? -12 : -1);
    }
  }

  function onWorkspaceKeyUp(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.code === 'Space') spaceDownRef.current = false;
  }

  function onGridMouseMove(event: React.MouseEvent<HTMLElement>) {
    const point = gridPoint(event);
    setHover({ pitch: point.pitch, tick: point.tick });
    lastPointerRef.current = { tick: point.tick, pitch: point.pitch };
  }

  function onRulerPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (!onSeek || event.button !== 0) return;
    const scroll = rulerScrollRef.current;
    if (!scroll) return;
    const rect = scroll.getBoundingClientRect();
    const x = event.clientX - rect.left + scroll.scrollLeft;
    const tickFromX = Math.max(0, Math.min(lengthTicks - 1, xToTick(x, pxPerStep)));
    const steps = getPlayheadSteps?.() ?? transport.positionStep;
    onSeek(seekStepFromPatternTick(tickFromX, steps, pattern.lengthSteps));
    event.preventDefault();
  }

  function onKeyPreview(pitch: number) {
    previewPitch(pitch, lastVelocityRef.current, true);
  }

  const parkedTick = playheadTickInPattern(transport.positionStep, pattern.lengthSteps);
  const parkedX = tickToX(parkedTick, pxPerStep);
  const hoverNote = displayedNotes.find((note) => selectedSet.has(note.id)) ?? displayedNotes[0];
  const readout = hover
    ? `${pitchLabel(hover.pitch)} · ${formatTickPosition(hover.tick, timeSignature)}`
    : hoverNote
      ? `${pitchLabel(hoverNote.pitch)} · ${formatTickPosition(hoverNote.startTick, timeSignature)} · vel ${Math.round(hoverNote.velocity * 100)}`
      : 'Empty lane';

  const rulerMarks = useMemo(() => {
    const marks: Array<{ tick: number; bar: boolean; label: string }> = [];
    for (let tick = 0; tick < lengthTicks; tick += beatTicks) {
      const isBar = tick % barTicks === 0;
      marks.push({
        tick,
        bar: isBar,
        label: isBar ? String(Math.floor(tick / barTicks) + 1) : String((Math.floor(tick / beatTicks) % (barTicks / beatTicks)) + 1),
      });
    }
    return marks;
  }, [lengthTicks, beatTicks, barTicks]);

  const toolbar = (
    <div className="piano-header-toolbar">
      <label className="inline-select-label">
        <span>LANE</span>
        <select aria-label="Piano roll channel" onChange={(event) => onSelectChannel(event.target.value)} value={selectedChannelId}>
          {project.channels.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
              {item.kind === 'instrument' ? '' : ' (drum)'}
            </option>
          ))}
        </select>
      </label>
    </div>
  );

  return (
    <PanelFrame
      badge={`${notes.length} NOTES`}
      className="piano-roll-panel"
      collapsed={collapsed}
      id="panel-piano-roll"
      onToggle={onToggle}
      title="Piano Roll"
      toolbar={toolbar}
    >
      <div className="piano-roll">
        <div className="piano-roll-toolbar">
          <div className="piano-tool-toggle" role="group" aria-label="Piano roll tool">
            <button
              aria-pressed={tool === 'draw'}
              className={`piano-tool-button ${tool === 'draw' ? 'piano-tool-button--on' : ''}`}
              onClick={() => setTool('draw')}
              type="button"
            >
              Draw
            </button>
            <button
              aria-pressed={tool === 'select'}
              className={`piano-tool-button ${tool === 'select' ? 'piano-tool-button--on' : ''}`}
              onClick={() => setTool('select')}
              type="button"
            >
              Select
            </button>
          </div>
          <label className="inline-select-label">
            <span>SNAP</span>
            <select aria-label="Grid snap" onChange={(event) => setSnapId(event.target.value)} value={snapId}>
              {GRID_SNAP_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="inline-select-label">
            <span>LENGTH</span>
            <select aria-label="Note length preset" onChange={(event) => setLengthId(event.target.value)} value={lengthId}>
              {LENGTH_PRESETS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button className="button piano-toolbar-button" disabled={selectedIds.length === 0} onClick={quantizeSelected} type="button">
            Quantize
          </button>
          <button className="button piano-toolbar-button" disabled={selectedIds.length === 0} onClick={duplicateSelected} type="button">
            Duplicate
          </button>
          <div className="piano-zoom-group" role="group" aria-label="Zoom">
            <button aria-label="Zoom out horizontally" className="button piano-zoom-button" onClick={() => setPxPerStep((current) => clampPxPerStep(current / 1.2))} type="button">
              H−
            </button>
            <button aria-label="Zoom in horizontally" className="button piano-zoom-button" onClick={() => setPxPerStep((current) => clampPxPerStep(current * 1.2))} type="button">
              H+
            </button>
            <button aria-label="Zoom out vertically" className="button piano-zoom-button" onClick={() => setKeyHeight((current) => clampKeyHeight(current - 2))} type="button">
              V−
            </button>
            <button aria-label="Zoom in vertically" className="button piano-zoom-button" onClick={() => setKeyHeight((current) => clampKeyHeight(current + 2))} type="button">
              V+
            </button>
          </div>
        </div>

        <div
          className="piano-roll-workspace"
          onKeyDown={onWorkspaceKeyDown}
          onKeyUp={onWorkspaceKeyUp}
          ref={workspaceRef}
          tabIndex={0}
        >
          <div className="piano-roll-corner" style={{ width: KEYBOARD_WIDTH, height: RULER_HEIGHT }}>
            KEY
          </div>
          <div
            className="piano-ruler-scroll"
            onPointerDown={onRulerPointerDown}
            ref={rulerScrollRef}
            style={{ height: RULER_HEIGHT }}
          >
            <div className="piano-ruler" style={{ width: contentWidth, height: RULER_HEIGHT }}>
              {rulerMarks.map((mark) => (
                <span
                  className={`piano-ruler-mark ${mark.bar ? 'piano-ruler-mark--bar' : ''}`}
                  key={mark.tick}
                  style={{ left: tickToX(mark.tick, pxPerStep), width: tickToX(mark.bar ? barTicks : beatTicks, pxPerStep) }}
                >
                  {mark.bar ? mark.label : ''}
                </span>
              ))}
            </div>
          </div>

          <div className="piano-keys-scroll" onScroll={onKeysScroll} ref={keysScrollRef}>
            <div className="piano-keys" style={{ width: KEYBOARD_WIDTH, height: contentHeight }}>
              {ALL_PITCHES.map((pitch) => (
                <button
                  aria-label={`Preview ${pitchLabel(pitch)}`}
                  className={`piano-key ${isBlackKey(pitch) ? 'piano-key--black' : ''} ${pitch % 12 === 0 ? 'piano-key--c' : ''}`}
                  key={pitch}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    onKeyPreview(pitch);
                  }}
                  style={{ height: keyHeight }}
                  type="button"
                >
                  {pitch % 12 === 0 ? pitchLabel(pitch) : ''}
                </button>
              ))}
            </div>
          </div>

          <div
            aria-label="Piano roll grid"
            className="piano-grid-scroll"
            data-testid="piano-grid"
            onContextMenu={onGridContextMenu}
            onMouseMove={onGridMouseMove}
            onPointerDown={onGridPointerDown}
            onScroll={onGridScroll}
            ref={gridScrollRef}
          >
            <div
              className="piano-grid-surface"
              style={{
                width: contentWidth,
                height: contentHeight,
                ['--px-per-step' as string]: `${pxPerStep}px`,
                ['--key-h' as string]: `${keyHeight}px`,
                ['--bar-px' as string]: `${tickToX(barTicks, pxPerStep)}px`,
                ['--beat-px' as string]: `${tickToX(beatTicks, pxPerStep)}px`,
                ['--snap-px' as string]: `${tickToX(snapTicks, pxPerStep)}px`,
              }}
            >
              <div className="piano-grid-rows" aria-hidden="true">
                {ALL_PITCHES.map((pitch) => (
                  <div
                    className={`piano-grid-row ${isBlackKey(pitch) ? 'piano-grid-row--black' : ''} ${pitch % 12 === 0 ? 'piano-grid-row--c' : ''}`}
                    key={pitch}
                    style={{ height: keyHeight }}
                  />
                ))}
              </div>
              {displayedNotes.map((note) => {
                const selected = selectedSet.has(note.id);
                return (
                  <div
                    aria-label={`Note ${pitchLabel(note.pitch)} at ${formatTickPosition(note.startTick, timeSignature)}, velocity ${Math.round(note.velocity * 100)} percent`}
                    aria-pressed={selected}
                    className={`piano-note ${selected ? 'piano-note--selected' : ''}`}
                    data-note-id={note.id}
                    key={note.id}
                    role="button"
                    style={{
                      left: tickToX(note.startTick, pxPerStep),
                      width: Math.max(4, tickToX(note.durationTicks, pxPerStep)),
                      top: pitchToY(note.pitch, keyHeight) + 1,
                      height: Math.max(4, keyHeight - 2),
                      opacity: 0.42 + note.velocity * 0.58,
                      ['--note-color' as string]: noteColor,
                    }}
                  >
                    <span className="piano-note-handle piano-note-handle--start" data-edge="start" />
                    <span className="piano-note-label">{pitchLabel(note.pitch)}</span>
                    <span className="piano-note-handle piano-note-handle--end" data-edge="end" />
                  </div>
                );
              })}
              {ghost && (
                <div
                  className="piano-note piano-note-ghost"
                  style={{
                    left: tickToX(ghost.startTick, pxPerStep),
                    width: Math.max(4, tickToX(ghost.durationTicks, pxPerStep)),
                    top: pitchToY(ghost.pitch, keyHeight) + 1,
                    height: Math.max(4, keyHeight - 2),
                    ['--note-color' as string]: noteColor,
                  }}
                />
              )}
              {marquee && (
                <div
                  className="piano-marquee"
                  style={{
                    left: Math.min(marquee.x0, marquee.x1),
                    top: Math.min(marquee.y0, marquee.y1),
                    width: Math.abs(marquee.x1 - marquee.x0),
                    height: Math.abs(marquee.y1 - marquee.y0),
                  }}
                />
              )}
              <div
                className={`piano-playhead ${playbackActive ? 'piano-playhead--live' : ''}`}
                ref={playheadRef}
                style={{ transform: `translateX(${parkedX}px)` }}
              />
            </div>
          </div>

          <div className="piano-velocity-label" style={{ width: KEYBOARD_WIDTH, height: VELOCITY_LANE_HEIGHT }}>
            VEL
          </div>
          <div
            aria-label="Note velocity lane"
            className="piano-velocity-scroll"
            onPointerDown={onVelocityPointerDown}
            ref={velocityScrollRef}
            style={{ height: VELOCITY_LANE_HEIGHT }}
          >
            <div className="piano-velocity-lane" style={{ width: contentWidth, height: VELOCITY_LANE_HEIGHT }}>
              {displayedNotes.map((note) => (
                <button
                  aria-label={`Velocity for ${pitchLabel(note.pitch)}, ${Math.round(note.velocity * 100)} percent`}
                  aria-pressed={selectedSet.has(note.id)}
                  className={`piano-velocity-bar ${selectedSet.has(note.id) ? 'piano-velocity-bar--selected' : ''}`}
                  data-note-id={note.id}
                  key={`vel-${note.id}`}
                  style={{
                    left: tickToX(note.startTick, pxPerStep),
                    width: Math.max(4, tickToX(note.durationTicks, pxPerStep) - 1),
                    height: `${Math.max(6, note.velocity * 100)}%`,
                    ['--note-color' as string]: noteColor,
                  }}
                  type="button"
                />
              ))}
            </div>
          </div>
        </div>

        <div className="panel-footnote piano-roll-footnote">
          <span className="footnote-dot" />
          <span>{readout}</span>
          <span className="piano-roll-hint">
            {tool === 'draw' ? 'Click-drag to draw' : 'Drag empty to select'}
            {' · '}Del delete · Ctrl+C/V copy/paste · Ctrl+D duplicate
            {canPreview ? ' · keys preview the instrument' : ''}
          </span>
        </div>
      </div>
    </PanelFrame>
  );
}
