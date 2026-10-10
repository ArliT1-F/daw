import {
  useEffect, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent,
} from 'react';
import type { ProjectCommand } from '../../core/commands';
import { createStableId, type Pattern, type PlaylistClip, type PlaylistLoop, type Project } from '../../core/project/model';
import { audioDurationTicks, clipDisplayName, createPlaylistTrack, getProjectTempoMap, getSongEndTick, isTrackAudible } from '../../core/arrangement/arrangement';
import { floorSnapTicks, formatTickPosition, quantizeTicks, secondsAtTick, ticksPerBar, ticksPerBeat, TICKS_PER_STEP } from '../../core/time/ticks';
import { PanelFrame } from '../../components/PanelFrame';
import type { TransportState } from '../../core/transport';
import {
  CLIP_SLOT_HEIGHT, DEFAULT_PX_PER_BEAT, LOOP_LANE_HEIGHT, PLAYLIST_RULER_HEIGHT,
  PLAYLIST_SNAP_OPTIONS, TRACK_HEADER_WIDTH, clampPlaylistZoom, clipGroupSpan, duplicateClips,
  editLoop, layoutClipSlots, playlistSnapTicks, playlistXToTick, resizeClips, tickToPlaylistX, translateClips,
} from './playlistModel';

interface PlaylistProps {
  project: Project;
  pattern: Pattern;
  transport: TransportState;
  collapsed: boolean;
  onToggle: () => void;
  onCommand: (command: ProjectCommand) => void;
  onSeek?: (step: number) => void;
  onSelectPattern?: (patternId: string) => void;
  onSelectClip?: (clipId: string) => void;
  onEditPattern?: (patternId: string, clipId: string) => void;
  onLoadAudio?: (file: File, trackId: string, startTick: number) => Promise<string | null>;
  isAudioAssetLoaded?: (assetId: string) => boolean;
  playbackActive?: boolean;
  getPlayheadSteps?: () => number;
}

type Gesture =
  | { kind: 'clips'; pointerId: number; x: number; y: number; tick: number; trackIndex: number; clips: PlaylistClip[]; edge?: 'start' | 'end'; alt: boolean; moved: boolean; base: PlaylistClip[]; originalIds: string[] }
  | { kind: 'marquee'; pointerId: number; x: number; y: number; additive: string[]; originalIds: string[] }
  | { kind: 'loop'; pointerId: number; tick: number; loop: PlaylistLoop; edge: 'start' | 'end' | 'move' | 'draw' };

type Rect = { x0: number; y0: number; x1: number; y1: number };

/** Inputs keep invalid intermediate typing out of the project; each blur is one undoable edit. */
function NumberEdit({ label, value, min = 0, step = 1, onCommit }: { label: string; value: number; min?: number; step?: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(String(Number(value.toFixed(5))));
  useEffect(() => setDraft(String(Number(value.toFixed(5)))), [value]);
  function commit() {
    const next = Number(draft);
    if (draft.trim() && Number.isFinite(next) && next >= min && next !== value) onCommit(next);
    else setDraft(String(Number(value.toFixed(5))));
  }
  return <label className="playlist-number"><span>{label}</span><input aria-label={label} type="number" min={min} step={step} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => {
    if (event.key === 'Enter') event.currentTarget.blur();
    if (event.key === 'Escape') { event.stopPropagation(); setDraft(String(Number(value.toFixed(5)))); }
  }} /></label>;
}

export function Playlist({
  project, pattern, transport, collapsed, onToggle, onCommand, onSeek, onSelectPattern, onSelectClip, onEditPattern,
  onLoadAudio, isAudioAssetLoaded, playbackActive = false, getPlayheadSteps,
}: PlaylistProps) {
  const signature = project.settings.timeSignature;
  const barTicks = ticksPerBar(signature);
  const beatTicks = ticksPerBeat(signature);
  const [tool, setTool] = useState<'draw' | 'select'>('draw');
  const [snapId, setSnapId] = useState('beat');
  const [pxPerBeat, setPxPerBeat] = useState(DEFAULT_PX_PER_BEAT);
  const [viewBars, setViewBars] = useState(16);
  const [follow, setFollow] = useState(false);
  const [sourceId, setSourceId] = useState(`pattern:${pattern.id}`);
  const [selectedTrackId, setSelectedTrackId] = useState(project.tracks[0]?.id ?? '');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [draftClips, setDraftClips] = useState<PlaylistClip[] | null>(null);
  const [draftLoop, setDraftLoop] = useState<PlaylistLoop | null>(null);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({});
  const [loadingAudio, setLoadingAudio] = useState<string | null>(null);
  const [dropTrack, setDropTrack] = useState<string | null>(null);
  const [viewport, setViewport] = useState({ left: 0, width: 900 });
  const [importError, setImportError] = useState<string | null>(null);
  const [tempoDraft, setTempoDraft] = useState(String(project.settings.tempo));
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const draftRef = useRef<PlaylistClip[] | null>(null);
  const loopRef = useRef<PlaylistLoop | null>(null);
  const selectedRef = useRef(selectedIds);
  const clipboardRef = useRef<PlaylistClip[]>([]);
  const cursorTickRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const pointerSelectedRef = useRef(false);
  const canceledTrackNames = useRef(new Set<string>());
  selectedRef.current = selectedIds;

  const snap = playlistSnapTicks(snapId, signature);
  const clips = draftClips ?? project.playlist;
  const loop = draftLoop ?? project.settings.loop;
  const sourceName = sourceId.startsWith('audio:') ? project.audioAssets.find((asset) => asset.id === sourceId.slice(6))?.name ?? 'Audio' : pattern.name;
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedClips = project.playlist.filter((clip) => selected.has(clip.id));
  const single = selectedClips.length === 1 ? selectedClips[0] : null;
  const songBars = Math.ceil(getSongEndTick(project) / barTicks);
  const totalBars = Math.max(viewBars, songBars + 2, Math.ceil(loop.endTick / barTicks) + 2);
  const timelineWidth = tickToPlaylistX(totalBars * barTicks, pxPerBeat, signature);
  const headerHeight = PLAYLIST_RULER_HEIGHT + LOOP_LANE_HEIGHT;
  const barWidth = tickToPlaylistX(barTicks, pxPerBeat, signature);
  const firstVisibleBar = Math.max(0, Math.floor(viewport.left / barWidth) - 1);
  const visibleBarCount = Math.max(1, Math.min(totalBars - firstVisibleBar, Math.ceil(Math.max(300, viewport.width - TRACK_HEADER_WIDTH) / barWidth) + 4));
  const visibleBars = Array.from({ length: visibleBarCount }, (_, index) => firstVisibleBar + index);
  const visibleStartTick = firstVisibleBar * barTicks;
  const visibleEndTick = (firstVisibleBar + visibleBarCount) * barTicks;
  const layouts = useMemo(() => {
    let top = headerHeight;
    return project.tracks.map((track, index) => {
      const items = clips.filter((clip) => clip.trackId === track.id);
      const slots = layoutClipSlots(items);
      const height = Math.max(62, slots.count * CLIP_SLOT_HEIGHT + 10);
      const layout = { track, index, items, slots: slots.slots, top, height };
      top += height;
      return layout;
    });
  }, [project.tracks, clips, headerHeight]);
  const toX = (tick: number) => tickToPlaylistX(tick, pxPerBeat, signature);

  useEffect(() => {
    setSourceId((current) => current.startsWith('pattern:') ? `pattern:${pattern.id}` : current);
  }, [pattern.id]);
  useEffect(() => {
    setSelectedIds((current) => current.filter((id) => project.playlist.some((clip) => clip.id === id)));
    if (!project.tracks.some((track) => track.id === selectedTrackId)) setSelectedTrackId(project.tracks[0].id);
    setSourceId((current) => current.startsWith('audio:') && !project.audioAssets.some((asset) => asset.id === current.slice(6)) ? `pattern:${pattern.id}` : current);
    // A project edit/undo during a drag invalidates its snapshot, rather than overwriting that edit.
    gestureRef.current = null;
    draftRef.current = null;
    loopRef.current = null;
    setDraftClips(null);
    setDraftLoop(null);
    setMarquee(null);
  }, [project]);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const measure = () => setViewport({ left: scroll.scrollLeft, width: scroll.clientWidth || 900 });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, []);

  function drawPlayhead(step: number) {
    const x = toX(step * TICKS_PER_STEP);
    if (playheadRef.current) playheadRef.current.style.transform = `translateX(${x}px)`;
    const scroll = scrollRef.current;
    if (follow && playbackActive && scroll && (x < scroll.scrollLeft || x > scroll.scrollLeft + scroll.clientWidth - TRACK_HEADER_WIDTH - 24)) {
      scroll.scrollLeft = Math.max(0, x - 32);
    }
  }
  useEffect(() => {
    drawPlayhead(transport.positionStep);
    if (!playbackActive || !getPlayheadSteps || collapsed) return;
    let frame = 0;
    const draw = () => { drawPlayhead(getPlayheadSteps()); frame = window.requestAnimationFrame(draw); };
    frame = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(frame);
  }, [playbackActive, getPlayheadSteps, transport.positionStep, pxPerBeat, follow, collapsed, signature]);

  function point(event: { clientX: number; clientY: number }) {
    const rect = contentRef.current?.getBoundingClientRect();
    const x = event.clientX - (rect?.left ?? 0) - TRACK_HEADER_WIDTH;
    const y = event.clientY - (rect?.top ?? 0);
    const tick = Math.max(0, playlistXToTick(x, pxPerBeat, signature));
    const layout = layouts.find((row) => y >= row.top && y < row.top + row.height) ?? (y < headerHeight ? layouts[0] : layouts.at(-1)!);
    return { x, y, tick, trackIndex: layout?.index ?? 0 };
  }
  function capture(event: ReactPointerEvent<HTMLElement>) {
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* inactive pointer / test DOM */ }
  }
  function preview(next: PlaylistClip[]) {
    draftRef.current = next;
    setDraftClips(next);
  }
  function previewLoop(next: PlaylistLoop) {
    loopRef.current = next;
    setDraftLoop(next);
  }
  function endGesture() {
    gestureRef.current = null;
    draftRef.current = null;
    loopRef.current = null;
    setDraftClips(null);
    setDraftLoop(null);
    setMarquee(null);
  }
  function cancelGesture() {
    const gesture = gestureRef.current;
    if (gesture && gesture.kind !== 'loop') {
      selectedRef.current = gesture.originalIds;
      setSelectedIds(gesture.originalIds);
    }
    suppressClickRef.current = false;
    pointerSelectedRef.current = false;
    endGesture();
  }
  function commitClips(upserts: PlaylistClip[], removeIds?: string[]) {
    onCommand({ type: 'playlist.clips.edit', upserts, removeIds });
  }
  function selectClip(clip: PlaylistClip, additive: boolean) {
    const next = additive ? (selectedRef.current.includes(clip.id) ? selectedRef.current.filter((id) => id !== clip.id) : [...selectedRef.current, clip.id]) : [clip.id];
    selectedRef.current = next;
    setSelectedIds(next);
    setSelectedTrackId(clip.trackId);
    onSelectClip?.(clip.id);
    if (clip.kind === 'pattern') onSelectPattern?.(clip.patternId);
    else setSourceId(`audio:${clip.assetId}`);
  }
  function onClipPointerDown(event: ReactPointerEvent<HTMLElement>, clip: PlaylistClip, edge?: 'start' | 'end') {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    workspaceRef.current?.focus();
    const p = point(event);
    if (event.shiftKey && !edge) {
      selectClip(clip, true);
      pointerSelectedRef.current = true;
      return;
    }
    const ids = selectedRef.current.includes(clip.id) ? selectedRef.current : [clip.id];
    selectedRef.current = ids;
    setSelectedIds(ids);
    setSelectedTrackId(clip.trackId);
    onSelectClip?.(clip.id);
    if (clip.kind === 'pattern') onSelectPattern?.(clip.patternId);
    else setSourceId(`audio:${clip.assetId}`);
    pointerSelectedRef.current = true;
    gestureRef.current = {
      kind: 'clips', pointerId: event.pointerId, x: p.x, y: p.y, tick: p.tick, trackIndex: p.trackIndex,
      clips: project.playlist.filter((item) => ids.includes(item.id)), edge, alt: event.altKey && !edge,
      moved: false, base: project.playlist, originalIds: [...ids],
    };
    capture(event);
  }
  function beginMarquee(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0 || (tool !== 'select' && !event.shiftKey) || (event.target as HTMLElement).closest('[data-clip-id]')) return;
    const p = point(event);
    gestureRef.current = { kind: 'marquee', pointerId: event.pointerId, x: p.x, y: p.y, additive: event.shiftKey ? selectedRef.current : [], originalIds: [...selectedRef.current] };
    workspaceRef.current?.focus();
    setMarquee({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    capture(event);
    event.preventDefault();
  }
  function onLoopPointerDown(event: ReactPointerEvent<HTMLElement>, edge: 'start' | 'end' | 'move' | 'draw') {
    if (event.button !== 0) return;
    const p = point(event);
    gestureRef.current = { kind: 'loop', pointerId: event.pointerId, tick: p.tick, loop: project.settings.loop, edge };
    suppressClickRef.current = true;
    workspaceRef.current?.focus();
    capture(event);
    event.preventDefault();
    event.stopPropagation();
  }
  function onPointerMove(event: PointerEvent) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const p = point(event);
    if (gesture.kind === 'clips') {
      if (!gesture.moved && Math.hypot(p.x - gesture.x, p.y - gesture.y) < 4) return;
      if (!gesture.moved) {
        // The stable editor owns capture once dragging begins; moving between lane parents
        // must not lose the pointer when React moves/unmounts the original clip element.
        try { workspaceRef.current?.setPointerCapture(event.pointerId); } catch { /* test DOM */ }
        gesture.moved = true;
        suppressClickRef.current = true;
        if (gesture.alt) {
          gesture.clips = duplicateClips(gesture.clips, 0, () => createStableId('clip'));
          gesture.base = [...project.playlist, ...gesture.clips];
          selectedRef.current = gesture.clips.map((clip) => clip.id);
          setSelectedIds(selectedRef.current);
        }
      }
      const dt = quantizeTicks(p.tick - gesture.tick, snap);
      const next = gesture.edge ? resizeClips(project, gesture.clips, gesture.edge, dt) : translateClips(project, gesture.clips, dt, p.trackIndex - gesture.trackIndex);
      const edits = new Map(next.map((clip) => [clip.id, clip]));
      preview(gesture.base.map((clip) => edits.get(clip.id) ?? clip));
    } else if (gesture.kind === 'marquee') {
      const rect = { x0: gesture.x, y0: gesture.y, x1: p.x, y1: p.y };
      setMarquee(rect);
      suppressClickRef.current = true;
      const minX = Math.min(rect.x0, rect.x1), maxX = Math.max(rect.x0, rect.x1);
      const minY = Math.min(rect.y0, rect.y1), maxY = Math.max(rect.y0, rect.y1);
      const hits = layouts.flatMap((row) => row.items.filter((clip) => {
        const top = row.top + 5 + (row.slots.get(clip.id) ?? 0) * CLIP_SLOT_HEIGHT;
        return toX(clip.startTick) < maxX && toX(clip.startTick + clip.durationTicks) > minX && top < maxY && top + CLIP_SLOT_HEIGHT - 4 > minY;
      }).map((clip) => clip.id));
      selectedRef.current = [...new Set([...gesture.additive, ...hits])];
      setSelectedIds(selectedRef.current);
    } else {
      if (gesture.edge === 'draw') {
        const startTick = floorSnapTicks(Math.min(gesture.tick, p.tick), snap);
        const endTick = Math.max(startTick + snap, quantizeTicks(Math.max(gesture.tick, p.tick), snap));
        previewLoop({ enabled: true, startTick, endTick });
      } else previewLoop(editLoop(gesture.loop, gesture.edge, quantizeTicks(p.tick - gesture.tick, snap), snap));
    }
  }
  function onPointerUp(event: PointerEvent) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.kind === 'clips' && gesture.moved && draftRef.current) {
      const ids = new Set(gesture.clips.map((clip) => clip.id));
      commitClips(draftRef.current.filter((clip) => ids.has(clip.id)));
    }
    if (gesture.kind === 'marquee' && !marquee) setSelectedIds(gesture.additive);
    if (gesture.kind === 'loop' && loopRef.current) onCommand({ type: 'playlist.loop.set', changes: loopRef.current });
    endGesture();
  }
  const moveRef = useRef(onPointerMove), upRef = useRef(onPointerUp), cancelRef = useRef(cancelGesture);
  moveRef.current = onPointerMove; upRef.current = onPointerUp; cancelRef.current = cancelGesture;
  useEffect(() => {
    const move = (event: PointerEvent) => moveRef.current(event);
    const up = (event: PointerEvent) => upRef.current(event);
    const cancel = () => cancelRef.current();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); window.removeEventListener('blur', cancel); };
  }, []);

  function placeClip(trackId: string, tick: number) {
    const startTick = floorSnapTicks(tick, snap);
    const id = createStableId('clip');
    let clip: PlaylistClip;
    if (sourceId.startsWith('audio:')) {
      const asset = project.audioAssets.find((item) => item.id === sourceId.slice(6));
      if (!asset) return;
      clip = { id, kind: 'audio', trackId, assetId: asset.id, startTick, durationTicks: audioDurationTicks(project, startTick, asset.durationSeconds), sourceOffsetSeconds: 0, gain: 1 };
    } else {
      const source = project.patterns.find((item) => item.id === sourceId.slice(8)) ?? pattern;
      clip = { id, kind: 'pattern', trackId, patternId: source.id, startTick, durationTicks: source.lengthSteps * TICKS_PER_STEP, sourceOffsetTicks: 0 };
    }
    onCommand({ type: 'playlist.clip.add', clip });
    setSelectedIds([id]);
    setSelectedTrackId(trackId);
    onSelectClip?.(id);
    workspaceRef.current?.focus();
  }
  function deleteSelected() {
    if (selectedRef.current.length) commitClips([], selectedRef.current);
    setSelectedIds([]);
  }
  function duplicateSelected() {
    const items = project.playlist.filter((clip) => selectedRef.current.includes(clip.id));
    if (!items.length) return;
    const offset = Math.ceil(clipGroupSpan(items) / snap) * snap;
    const copies = duplicateClips(items, offset, () => createStableId('clip'));
    commitClips(copies);
    setSelectedIds(copies.map((clip) => clip.id));
  }
  function paste() {
    if (!clipboardRef.current.length) return;
    const origin = Math.min(...clipboardRef.current.map((clip) => clip.startTick));
    const target = floorSnapTicks(cursorTickRef.current ?? transport.positionStep * TICKS_PER_STEP, snap);
    const copies = duplicateClips(clipboardRef.current, target - origin, () => createStableId('clip'));
    commitClips(copies);
    setSelectedIds(copies.map((clip) => clip.id));
  }
  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).matches('input, select, textarea') || (event.target as HTMLElement).isContentEditable) return;
    const command = event.metaKey || event.ctrlKey;
    if (event.key === 'Escape' && gestureRef.current) { event.preventDefault(); event.stopPropagation(); cancelGesture(); return; }
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); deleteSelected(); }
    else if (command && event.key.toLowerCase() === 'a') { event.preventDefault(); setSelectedIds(project.playlist.map((clip) => clip.id)); }
    else if (command && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicateSelected(); }
    else if (command && event.key.toLowerCase() === 'c') { event.preventDefault(); clipboardRef.current = selectedClips.map((clip) => ({ ...clip })); }
    else if (command && event.key.toLowerCase() === 'v') { event.preventDefault(); paste(); }
    else if (event.key.startsWith('Arrow') && selectedClips.length) {
      event.preventDefault();
      const dt = event.key === 'ArrowRight' ? (event.shiftKey ? barTicks : snap) : event.key === 'ArrowLeft' ? -(event.shiftKey ? barTicks : snap) : 0;
      const dy = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
      commitClips(translateClips(project, selectedClips, dt, dy));
    }
  }
  async function loadAudio(file: File, trackId: string, startTick: number) {
    if (!onLoadAudio || loadingAudio) return;
    setLoadingAudio(file.name);
    setImportError(null);
    try {
      const id = await onLoadAudio(file, trackId, floorSnapTicks(startTick, snap));
      if (id) { setSelectedIds([id]); setSelectedTrackId(trackId); }
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'Could not import this audio file.');
    } finally { setLoadingAudio(null); }
  }
  function changeClip(changes: Partial<PlaylistClip>) {
    if (single) commitClips([{ ...single, ...changes } as PlaylistClip]);
  }
  function commitTrackName(trackId: string) {
    const name = nameDrafts[trackId];
    if (canceledTrackNames.current.has(trackId)) canceledTrackNames.current.delete(trackId);
    else if (name?.trim()) onCommand({ type: 'playlist.track.rename', trackId, name });
    setNameDrafts((current) => { const next = { ...current }; delete next[trackId]; return next; });
  }
  function addTempoMarker() {
    const tick = Math.max(0, quantizeTicks(transport.positionStep * TICKS_PER_STEP, snap));
    const bpm = Number(tempoDraft);
    if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300) { setTempoDraft(String(project.settings.tempo)); return; }
    if (tick === 0) onCommand({ type: 'project.tempo.set', tempo: bpm });
    else onCommand({ type: 'project.tempo-changes.set', changes: [...project.settings.tempoChanges.filter((change) => change.tick !== tick), { tick, bpm }].sort((a, b) => a.tick - b.tick) });
  }

  return <PanelFrame badge="SONG" className="playlist-panel" collapsed={collapsed} id="panel-playlist" onToggle={onToggle} title="Playlist" toolbar={<span className="toolbar-note">{project.tracks.length} TRACKS · {project.playlist.length} CLIPS</span>}>
    <div className="playlist-workspace" tabIndex={0} aria-label="Playlist editor" ref={workspaceRef} onKeyDown={onKeyDown} onPointerDownCapture={() => { if (!gestureRef.current) { suppressClickRef.current = false; pointerSelectedRef.current = false; } }}>
      <div className="playlist-toolbar">
        <div className="piano-tool-toggle" role="group" aria-label="Playlist tools">
          <button className={`piano-tool-button ${tool === 'draw' ? 'piano-tool-button--on' : ''}`} aria-pressed={tool === 'draw'} aria-label="Playlist draw tool" onClick={() => setTool('draw')} type="button">Draw</button>
          <button className={`piano-tool-button ${tool === 'select' ? 'piano-tool-button--on' : ''}`} aria-pressed={tool === 'select'} aria-label="Playlist select tool" onClick={() => setTool('select')} type="button">Select</button>
        </div>
        <select aria-label="Playlist clip source" value={sourceId} onChange={(event) => { const value = event.target.value; setSourceId(value); if (value.startsWith('pattern:')) onSelectPattern?.(value.slice(8)); }}>
          <optgroup label="Reusable patterns">{project.patterns.map((item) => <option key={item.id} value={`pattern:${item.id}`}>▦ {item.name}</option>)}</optgroup>
          {!!project.audioAssets.length && <optgroup label="Audio assets">{project.audioAssets.map((asset) => <option key={asset.id} value={`audio:${asset.id}`}>≈ {asset.name}</option>)}</optgroup>}
        </select>
        <label className="playlist-snap">Snap <select aria-label="Playlist snapping" value={snapId} onChange={(event) => setSnapId(event.target.value)}>{PLAYLIST_SNAP_OPTIONS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <button className="piano-toolbar-button" aria-label="Add Playlist track" type="button" onClick={() => { const track = createPlaylistTrack(`Track ${project.tracks.length + 1}`, project.tracks.length); onCommand({ type: 'playlist.track.add', track }); setSelectedTrackId(track.id); }}>+ Track</button>
        <button className="piano-toolbar-button" aria-label="Import audio clip" disabled={!onLoadAudio || Boolean(loadingAudio)} type="button" onClick={() => fileRef.current?.click()}>{loadingAudio ? 'Decoding…' : '+ Audio'}</button>
        <input ref={fileRef} className="sr-only-text" aria-label="Import an audio file into the Playlist" type="file" accept="audio/*,.wav,.mp3,.ogg,.flac,.m4a,.aif,.aiff" onChange={(event) => { const file = event.target.files?.[0]; if (file) void loadAudio(file, selectedTrackId, cursorTickRef.current ?? transport.positionStep * TICKS_PER_STEP); event.target.value = ''; }} />
        <button className="piano-toolbar-button" aria-label="Duplicate selected clips" disabled={!selectedClips.length} type="button" onClick={duplicateSelected}>Duplicate</button>
        <button className="piano-toolbar-button" aria-label="Delete selected clips" disabled={!selectedClips.length} type="button" onClick={deleteSelected}>Delete</button>
        <button className="piano-zoom-button" aria-label="Zoom Playlist out" type="button" onClick={() => setPxPerBeat((current) => clampPlaylistZoom(current / 1.25))}>−</button>
        <button className="piano-zoom-button" aria-label="Zoom Playlist in" type="button" onClick={() => setPxPerBeat((current) => clampPlaylistZoom(current * 1.25))}>+</button>
        <button className={`piano-toolbar-button ${follow ? 'is-active' : ''}`} aria-label="Follow Playlist playhead" aria-pressed={follow} type="button" onClick={() => setFollow((current) => !current)}>Follow</button>
        <button className="piano-toolbar-button" aria-label="Extend Playlist view" type="button" onClick={() => setViewBars((current) => current + 8)}>+8 bars</button>
      </div>
      {importError && <div className="playlist-import-error" role="alert">{importError}<button aria-label="Dismiss Playlist import error" type="button" onClick={() => setImportError(null)}>×</button></div>}
      <div className="playlist-loop-controls">
        <button className={`piano-toolbar-button ${loop.enabled ? 'is-active' : ''}`} aria-label="Toggle Playlist loop" aria-pressed={loop.enabled} onClick={() => onCommand({ type: 'playlist.loop.set', changes: { enabled: !loop.enabled } })} type="button">Loop</button>
        <NumberEdit label="Loop start bar" min={1} step={0.25} value={loop.startTick / barTicks + 1} onCommit={(value) => onCommand({ type: 'playlist.loop.set', changes: { startTick: Math.min(loop.endTick - 1, Math.round((value - 1) * barTicks)) } })} />
        <NumberEdit label="Loop end bar" min={1} step={0.25} value={loop.endTick / barTicks + 1} onCommit={(value) => onCommand({ type: 'playlist.loop.set', changes: { endTick: Math.max(loop.startTick + 1, Math.round((value - 1) * barTicks)) } })} />
        <span className="playlist-loop-hint">end exclusive · Shift-drag ruler to set</span>
        <label className="playlist-number"><span>Marker BPM</span><input aria-label="Tempo marker BPM" type="number" min={20} max={300} value={tempoDraft} onChange={(event) => setTempoDraft(event.target.value)} /></label>
        <button className="piano-toolbar-button" aria-label="Set tempo marker at playhead" type="button" onClick={addTempoMarker}>+ Tempo</button>
      </div>
      <div className="playlist-scroll" ref={scrollRef} aria-label="Scrollable arrangement timeline" onScroll={(event) => setViewport({ left: event.currentTarget.scrollLeft, width: event.currentTarget.clientWidth || 900 })} onWheel={(event) => {
        if (event.ctrlKey || event.metaKey) { event.preventDefault(); setPxPerBeat((current) => clampPlaylistZoom(current * (event.deltaY < 0 ? 1.12 : 1 / 1.12))); }
        else if (event.shiftKey && scrollRef.current) { event.preventDefault(); scrollRef.current.scrollLeft += event.deltaY || event.deltaX; }
      }}>
        <div className="playlist-content" ref={contentRef} style={{ width: TRACK_HEADER_WIDTH + timelineWidth, '--playlist-bar-width': `${toX(barTicks)}px`, '--playlist-beat-width': `${pxPerBeat}px`, '--playlist-step-width': `${toX(snap)}px` } as CSSProperties}>
          <div className="timeline-ruler" style={{ gridTemplateColumns: `${TRACK_HEADER_WIDTH}px 1fr`, height: PLAYLIST_RULER_HEIGHT }}>
            <div className="timeline-track-label timeline-track-label--heading">TRACK / SOURCE</div>
            <div className="timeline-bars" role="group" aria-label="Bar and beat ruler" onPointerDown={(event) => { if (event.shiftKey) onLoopPointerDown(event, 'draw'); }} onClick={(event) => {
              if (suppressClickRef.current) { suppressClickRef.current = false; return; }
              const target = (event.target as HTMLElement).closest<HTMLElement>('[data-tick]');
              const tick = event.detail === 0 && target ? Number(target.dataset.tick) : floorSnapTicks(point(event).tick, snap);
              onSeek?.(tick / TICKS_PER_STEP);
            }}>
              {Array.from({ length: visibleBarCount * signature.numerator }, (_, offset) => {
                const index = firstVisibleBar * signature.numerator + offset;
                const tick = index * beatTicks, isBar = index % signature.numerator === 0;
                return <button key={index} data-tick={tick} className={`timeline-ruler-mark ${isBar ? 'timeline-ruler-mark--bar' : ''}`} style={{ left: toX(tick), width: pxPerBeat }} aria-label={isBar ? `Seek to bar ${index / signature.numerator + 1}` : `Seek to bar ${Math.floor(index / signature.numerator) + 1} beat ${index % signature.numerator + 1}`} type="button">{isBar ? String(index / signature.numerator + 1).padStart(2, '0') : (pxPerBeat >= 24 ? index % signature.numerator + 1 : '·')}</button>;
              })}
              {project.settings.tempoChanges.filter((change) => change.tick >= visibleStartTick && change.tick < visibleEndTick).map((change) => <button key={change.tick} className="playlist-tempo-marker" style={{ left: toX(change.tick) }} aria-label={`Tempo ${change.bpm} BPM at ${formatTickPosition(change.tick, signature)}; remove marker`} title="Click to remove tempo marker" type="button" onClick={(event) => { event.stopPropagation(); onCommand({ type: 'project.tempo-changes.set', changes: project.settings.tempoChanges.filter((item) => item.tick !== change.tick) }); }}>{change.bpm}</button>)}
            </div>
          </div>
          <div className="playlist-loop-row" style={{ gridTemplateColumns: `${TRACK_HEADER_WIDTH}px 1fr`, height: LOOP_LANE_HEIGHT }}>
            <div className="timeline-track-label timeline-track-label--heading">{loop.enabled ? 'LOOP REGION' : 'LOOP OFF / SONG'}</div>
            <div className="playlist-loop-lane" onClick={() => { suppressClickRef.current = false; }} onPointerDown={(event) => { if (event.target === event.currentTarget) onLoopPointerDown(event, 'draw'); }}>
              <div className={`playlist-loop-region ${loop.enabled ? '' : 'playlist-loop-region--off'}`} style={{ left: toX(loop.startTick), width: toX(loop.endTick - loop.startTick) }} onPointerDown={(event) => onLoopPointerDown(event, 'move')}>
                <button className="playlist-loop-handle playlist-loop-handle--start" aria-label="Drag loop start marker" type="button" onPointerDown={(event) => onLoopPointerDown(event, 'start')}>▸</button>
                <span>LOOP</span>
                <button className="playlist-loop-handle playlist-loop-handle--end" aria-label="Drag loop end marker" type="button" onPointerDown={(event) => onLoopPointerDown(event, 'end')}>◂</button>
              </div>
            </div>
          </div>
          {layouts.map(({ track, index, items, slots, height }) => <div className={`timeline-track-row ${isTrackAudible(project, track.id) ? '' : 'timeline-track-row--muted'} ${dropTrack === track.id ? 'timeline-track-row--drop' : ''}`} key={track.id} style={{ gridTemplateColumns: `${TRACK_HEADER_WIDTH}px 1fr`, height }}>
            <div className={`timeline-track-label ${selectedTrackId === track.id ? 'timeline-track-label--selected' : ''}`} onClick={() => setSelectedTrackId(track.id)}>
              <span className="timeline-track-color" style={{ background: track.color }} />
              <div className="timeline-track-info">
                <input className="timeline-track-name" aria-label={`Track name ${track.name}`} value={nameDrafts[track.id] ?? track.name} maxLength={80} onChange={(event) => setNameDrafts((current) => ({ ...current, [track.id]: event.target.value }))} onBlur={() => commitTrackName(track.id)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { event.stopPropagation(); canceledTrackNames.current.add(track.id); event.currentTarget.blur(); } }} />
                <div className="playlist-track-buttons">
                  <button type="button" aria-label={`Mute track ${track.name}`} aria-pressed={track.muted} className={track.muted ? 'is-active' : ''} onClick={() => onCommand({ type: 'playlist.track.mute.set', trackId: track.id, muted: !track.muted })}>M</button>
                  <button type="button" aria-label={`Solo track ${track.name}`} aria-pressed={track.solo} className={track.solo ? 'is-active' : ''} onClick={() => onCommand({ type: 'playlist.track.solo.set', trackId: track.id, solo: !track.solo })}>S</button>
                  <button type="button" aria-label={`Move track ${track.name} up`} disabled={index === 0} onClick={() => onCommand({ type: 'playlist.track.reorder', trackId: track.id, toIndex: index - 1 })}>↑</button>
                  <button type="button" aria-label={`Move track ${track.name} down`} disabled={index === project.tracks.length - 1} onClick={() => onCommand({ type: 'playlist.track.reorder', trackId: track.id, toIndex: index + 1 })}>↓</button>
                </div>
              </div>
            </div>
            <div className="timeline-lane" aria-label={`${track.name} arrangement lane`} onPointerDown={beginMarquee} onPointerMove={(event) => { if (!gestureRef.current) cursorTickRef.current = point(event).tick; }} onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDropTrack(track.id); } }} onDragLeave={() => setDropTrack(null)} onDrop={(event) => { event.preventDefault(); setDropTrack(null); const file = event.dataTransfer.files[0]; if (file) void loadAudio(file, track.id, point(event).tick); }}>
              {visibleBars.map((bar) => <button className={`timeline-cell ${bar % 2 === 0 ? 'timeline-cell--accent' : ''}`} key={bar} style={{ left: toX(bar * barTicks), width: toX(barTicks) }} aria-label={index === 0 ? `Place ${sourceName} clip at bar ${bar + 1}` : `Place clip on ${track.name} at bar ${bar + 1}`} type="button" onClick={(event) => {
                if (suppressClickRef.current) { suppressClickRef.current = false; return; }
                if (tool === 'select' || event.shiftKey) { if (!event.shiftKey) setSelectedIds([]); return; }
                placeClip(track.id, event.detail === 0 ? bar * barTicks : point(event).tick);
              }} />)}
              {items.filter((clip) => clip.startTick < visibleEndTick && clip.startTick + clip.durationTicks > visibleStartTick).map((clip) => {
                const name = clipDisplayName(project, clip);
                const missing = clip.kind === 'audio' && isAudioAssetLoaded && !isAudioAssetLoaded(clip.assetId);
                return <div role="button" tabIndex={0} aria-label={`${clip.kind === 'pattern' ? 'Pattern' : 'Audio'} clip ${name} at ${formatTickPosition(clip.startTick, signature)}`} aria-pressed={selected.has(clip.id)} data-clip-id={clip.id} key={clip.id} className={`playlist-clip playlist-clip--${clip.kind} ${selected.has(clip.id) ? 'playlist-clip--selected' : ''} ${missing ? 'playlist-clip--missing' : ''}`} style={{ left: toX(clip.startTick) + 1, width: Math.max(6, toX(clip.durationTicks) - 2), top: 5 + (slots.get(clip.id) ?? 0) * CLIP_SLOT_HEIGHT, height: CLIP_SLOT_HEIGHT - 4, '--track-color': track.color } as CSSProperties} title={`${name} · ${clip.kind === 'pattern' ? 'shared pattern · double-click to edit' : 'native-speed audio'}${missing ? ' · source must be reloaded' : ''}`} onPointerDown={(event) => onClipPointerDown(event, clip)} onClick={(event) => {
                  if (suppressClickRef.current) { suppressClickRef.current = false; pointerSelectedRef.current = false; return; }
                  if (pointerSelectedRef.current) { pointerSelectedRef.current = false; return; }
                  selectClip(clip, event.shiftKey);
                }} onDoubleClick={() => { if (clip.kind === 'pattern') onEditPattern?.(clip.patternId, clip.id); }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); selectClip(clip, event.shiftKey); } }}>
                  <span className="playlist-clip-handle playlist-clip-handle--start" aria-label={`Resize start of ${name}`} onPointerDown={(event) => onClipPointerDown(event, clip, 'start')} />
                  <ClipPreview project={project} clip={clip} />
                  <span className="clip-name">{clip.kind === 'pattern' ? '▦' : '≈'} {name}{missing ? ' · missing audio' : ''}</span>
                  <span className="playlist-clip-handle playlist-clip-handle--end" aria-label={`Resize end of ${name}`} onPointerDown={(event) => onClipPointerDown(event, clip, 'end')} />
                </div>;
              })}
            </div>
          </div>)}
          <div aria-hidden="true" className={`timeline-playhead ${playbackActive ? 'timeline-playhead--playing' : ''}`} ref={playheadRef} style={{ left: TRACK_HEADER_WIDTH, transform: `translateX(${toX(transport.positionStep * TICKS_PER_STEP)}px)` }} />
          {marquee && <div aria-hidden="true" className="playlist-marquee" style={{ left: TRACK_HEADER_WIDTH + Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }} />}
        </div>
      </div>
      <div className="playlist-inspector" aria-label="Clip properties">
        {single ? <>
          <span className={`playlist-kind-label playlist-kind-label--${single.kind}`}>{single.kind}</span>
          <label className="playlist-clip-label"><span className="sr-only-text">Clip name</span><input aria-label="Clip name" key={JSON.stringify([single.id, clipDisplayName(project, single)])} defaultValue={clipDisplayName(project, single)} maxLength={80} onBlur={(event) => { const name = event.target.value.trim(); if (name && name !== clipDisplayName(project, single)) changeClip({ name }); else event.target.value = clipDisplayName(project, single); }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { event.stopPropagation(); event.currentTarget.value = clipDisplayName(project, single); event.currentTarget.blur(); } }} /></label>
          <select aria-label="Clip track" value={single.trackId} onChange={(event) => changeClip({ trackId: event.target.value })}>{project.tracks.map((track) => <option key={track.id} value={track.id}>{track.name}</option>)}</select>
          <NumberEdit label="Clip start beat" value={single.startTick / beatTicks + 1} min={1} step={0.25} onCommit={(value) => changeClip({ startTick: Math.round((value - 1) * beatTicks) })} />
          <NumberEdit label="Clip duration beats" value={single.durationTicks / beatTicks} min={1 / beatTicks} step={0.25} onCommit={(value) => changeClip({ durationTicks: Math.max(1, Math.round(value * beatTicks)) })} />
          {single.kind === 'audio' ? <>
            <NumberEdit label="Audio source start seconds" value={single.sourceOffsetSeconds} step={0.01} onCommit={(value) => changeClip({ sourceOffsetSeconds: value })} />
            <NumberEdit label="Audio clip gain" value={single.gain} step={0.05} onCommit={(value) => changeClip({ gain: value })} />
          </> : <NumberEdit label="Pattern source start ticks" value={single.sourceOffsetTicks} step={snap} onCommit={(value) => changeClip({ sourceOffsetTicks: Math.round(value) })} />}
        </> : <span>{selectedClips.length ? `${selectedClips.length} clips selected · move, resize, duplicate or delete as a group` : 'Draw on a lane to place the selected source · select a clip to edit its placement and trim'}</span>}
      </div>
      <div className="panel-footnote playlist-footnote"><span>Shift-select / marquee · drag edges to trim · Alt-drag copy · Ctrl/Cmd+D duplicate · Delete</span><span>{Math.round(pxPerBeat)} px/beat · {totalBars} bars</span></div>
    </div>
  </PanelFrame>;
}

/** Actual source data, not a decorative fake waveform. Shared patterns update every instance. */
function ClipPreview({ project, clip }: { project: Project; clip: PlaylistClip }) {
  if (clip.kind === 'audio') {
    const asset = project.audioAssets.find((item) => item.id === clip.assetId);
    const peaks = asset?.peaks ?? [];
    const duration = secondsAtTick(getProjectTempoMap(project), project.settings.timeSignature, clip.startTick + clip.durationTicks) - secondsAtTick(getProjectTempoMap(project), project.settings.timeSignature, clip.startTick);
    const first = asset ? Math.floor(clip.sourceOffsetSeconds / asset.durationSeconds * peaks.length) : 0;
    const end = asset ? Math.ceil(Math.min(asset.durationSeconds, clip.sourceOffsetSeconds + duration) / asset.durationSeconds * peaks.length) : 0;
    const audibleFraction = asset ? Math.min(1, (asset.durationSeconds - clip.sourceOffsetSeconds) / Math.max(duration, 0.0001)) : 1;
    return <svg className="playlist-clip-preview" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">{peaks.slice(first, end).map((peak, index, visible) => <line key={index} x1={index / visible.length * audibleFraction * 100} x2={index / visible.length * audibleFraction * 100} y1={12 - peak * 11} y2={12 + peak * 11} />)}</svg>;
  }
  const pattern = project.patterns.find((item) => item.id === clip.patternId);
  if (!pattern) return null;
  const lengthTicks = pattern.lengthSteps * TICKS_PER_STEP;
  const notes = Object.values(pattern.notes).flat();
  const minPitch = Math.min(48, ...notes.map((note) => note.pitch)), maxPitch = Math.max(72, ...notes.map((note) => note.pitch));
  return <svg className="playlist-clip-preview" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
    {notes.map((note, index) => <rect key={`n${index}`} x={note.startTick / lengthTicks * 100} y={2 + (maxPitch - note.pitch) / (maxPitch - minPitch + 1) * 16} width={Math.max(1, note.durationTicks / lengthTicks * 100)} height={2} />)}
    {Object.entries(pattern.steps).map(([channelId, row], index) => project.channels.find((channel) => channel.id === channelId)?.kind === 'drum' && row.map((active, step) => active && <rect key={`${channelId}:${step}`} x={step / pattern.lengthSteps * 100} y={18 + index % 3 * 2} width={1.4} height={2} />))}
  </svg>;
}
