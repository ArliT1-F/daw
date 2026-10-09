# Gridline Audio

Gridline Audio is a free-to-use, browser-first DAW foundation built with React, TypeScript, and Vite. It has an original dark workspace and a modular, single-application architecture. There is no backend, account system, payment processing, cloud storage, or desktop wrapper.

## Requirements

- Node.js 20.19+ (or 22.12+)
- npm

## Install and run

```sh
npm install
npm run dev
```

Vite prints the development URL. The server binds to all interfaces for hosted previews.

## Checks

```sh
npm test          # one-shot Vitest unit tests
npm run typecheck # TypeScript check
npm run build     # typecheck and optimized production build
npm run preview   # serve the production build locally
```

## Foundation map

- `src/core/project` — versioned project types, validation, JSON serialization, and the `ProjectPersistence` interface. An IndexedDB adapter is intentionally deferred.
- `src/core/commands` — typed immutable edits and bounded undo/redo history.
- `src/core/time` — the musical time model: the sixteenth-note grid, bars/beats/subdivisions, and a tempo map that converts between step positions and seconds.
- `src/core/events` — musical event data (sample triggers, sustained notes) plus the pure translation from project data to a playable event list.
- `src/core/transport` — UI transport state and `TransportClock`, the single authority that maps audio-clock time to musical position.
- `src/audio` — `BrowserAudioEngine` (context lifecycle, audio graph, voices), the lookahead `Scheduler`, the lookahead timer, and the `SampleStore` (runtime registry for decoded user samples; buffers never enter the project document).
- `src/features` — focused UI modules for the transport, Channel Rack (step sequencer), Piano Roll, Playlist, Mixer, and asset browser.

Project content, transient panel/selection state, transport position, persistence, and browser audio objects are kept in separate layers. Pattern steps with per-step velocities, piano-roll notes, tempo, swing, time signature, channel mute/solo/sample assignments, and arrangement clips are all serializable project data edited through undoable commands. The starter project is currently held in memory only.

## Audio engine

### Ownership

`BrowserAudioEngine` is the only component that touches Web Audio. It owns, in this order:

1. the `AudioContext` (created on the first user gesture, never before);
2. the `AudioGraph` — channel buses → master gain → safety limiter → destination;
3. the `VoicePool` — every sounding node, so a stop can release all of them;
4. the `TransportClock` — musical position as a pure function of `context.currentTime`;
5. the `Scheduler` — which events to queue, and when.

Musical data never holds a node. The project model is translated once into plain `MusicalEvent`
objects (`{ kind: 'sample' | 'note', step, channelId, … }`), and those objects are what the
scheduler queues. A MIDI output or an offline renderer can implement the same `MusicalEventSink`
interface later without touching the transport or the UI.

### Scheduling design

Sound timing comes from the audio clock only:

- A timer wakes every **25 ms** (a `Worker` timer when available, `setInterval` as a fallback,
  because browsers throttle background-tab timers to ~1 s and that would starve the queue).
- Each tick queues every event that starts within the next **120 ms** (`lookaheadSeconds`),
  scheduling each voice at its exact `AudioContext` time.
- Rendering is never in the timing path. `requestAnimationFrame` only reads
  `getPlayheadSteps()` to draw the playhead, so a slow frame cannot delay or duplicate a note.

Consequences:

- Timer jitter only changes how early events are queued, not when they sound. Events are
  sample-accurate as long as a tick arrives before the lookahead window closes.
- The lookahead is the real latency/budget trade-off: 120 ms is far more than a 25 ms tick, and
  small enough that edits and tempo changes take effect almost immediately.
- Events more than 10 ms late are dropped rather than fired behind the clock (`lateGraceSeconds`).
  After a long stall the scheduler skips to the cycle containing the current time instead of
  firing a burst of stale notes.

### Musical time

The atomic unit is the sixteenth-note step (16 steps per whole note). `TransportClock` stores an
anchor `(anchorTime, anchorStep)` and a tempo map, and derives position as
`stepAtSeconds(secondsAtStep(anchorStep) + (now - anchorTime))`. Every reconfiguration re-anchors
at the current instant, which keeps floating-point error bounded to one loop and makes each
operation's semantics explicit:

| Operation | Semantics |
| --- | --- |
| `play` | Starts at the parked position with 60 ms of scheduling headroom, so the first event is never queued in the past. Initializes the `AudioContext` if needed — it is always called from a gesture. |
| `pause` | Freezes the musical position and releases every sounding voice. |
| `stop` | Releases every voice, parks at the region start, resets the loop iteration. |
| `restart` | `stop()` then `play()`. |
| `seek` | Moves the playhead, releases sounding voices, and re-cursors the scheduler. Playback continues from the new position; the current window is queued immediately so events at the target still sound. |
| tempo / signature change | The musical position is preserved and only the rate changes. Already-queued voices are cancelled and re-cursored, so nothing sounds twice at two tempos. |
| loop | The visible region wraps when looping is on; when it is off, playback stops at the region end. Notes are clamped at the boundary, so nothing hangs across a loop. |

### Failures

`AudioEngineError` carries a classified `reason` (`unsupported`, `autoplay-blocked`,
`device-unavailable`, `context-closed`, `scheduling-failed`, `unknown`) and a message written for
users, not developers. The engine also watches `AudioContext.state`: a closed context tears the
graph down, and an `interrupted` context (iOS/Safari) pauses transport and reports the failure.

### Timing limitations

- **Output latency.** Events are sample-accurate on the audio clock, but they are *heard*
  `outputLatency` later (typically 10–40 ms, far more over Bluetooth). The playhead compensates by
  reading the position `outputLatency` in the past; the label in the transport bar reports the
  measured value.
- **Background tabs.** A `Worker` timer keeps the queue filled, but some browsers still throttle
  or suspend audio when a tab is hidden for a long time. Recovery is automatic: late events are
  dropped and the next cycle is picked up on time.
- **Device changes.** Web Audio does not expose device selection; if the output device disappears
  the context may go to `interrupted`/`closed`, which the engine surfaces as an error.
- **Quantisation of the Channel Rack playhead.** The step sequencer highlights sixteenth-note
  cells, so that playhead moves in steps (~8 times per second at 124 BPM) even though the audio
  position is continuous. The piano roll draws a tick-accurate playhead from the same clock.
- **No sample-accurate automation yet.** Tempo is constant per project (the tempo map supports
  future automation); mixer faders and effects are still deferred.

## Testing

```sh
npm test
```

221 tests cover the audio and editing layers:

- `src/core/time` — grid maths, integer-tick conversions (ticks ↔ steps ↔ bars/beats ↔ seconds),
  tempo-map integration and inversion, bar/beat/sixteenth round-trips, odd signatures (6/8, 7/8,
  12/8), snapping, loop-boundary duration, clamping, and formatting.
- `src/core/events` — project → event translation (clip placement, pattern repeat, clip
  truncation, tick-based piano-roll notes, notes truncated at clip/loop ends, sorting, unique ids,
  velocity clamping) and event-list helpers.
- `src/core/transport` — `TransportClock` start/pause/resume/stop/seek, tempo and signature
  changes, loop wrapping (including many wraps drift-free and stalled clocks), cycle timing
  across a loop boundary, and snapshots.
- `src/audio/scheduler` — lookahead windowing, loop continuity, one-event-per-iteration,
  out-of-range and late events, note clamping at the loop end, and re-cursoring after
  seek/tempo/sequence changes.
- `src/audio/AudioEngine` — lifecycle, autoplay and device failures, context interruption,
  scheduled voice times, loop synchronisation over repeated passes, stop/pause/seek/restart,
  sequence swaps, latency-compensated playhead, and diagnostics — plus two end-to-end tests that
  play the starter project through the engine. The engine is tested against an injectable
  `AudioContext` double (`src/audio/__fixtures__`), so no browser is required.
- `src/audio/voices` — voice construction, envelopes, pool cancellation and release.
- `src/audio/timer` — interval timer behaviour and the worker fallback.
- `src/App.audio.test.tsx` — the React wiring in a DOM: mounting never touches audio, play
  schedules voices, stop releases them, and the loop toggle and test tone work.
- `src/features/piano-roll` — note create/select/delete/copy/paste, velocity, snapping,
  serialization of integer ticks, and playhead/note alignment across tempo changes.
- `src/core/commands/pianoRoll.test.ts` — undoable add/update/remove/replace of tick-based notes.

## Channel Rack

The Channel Rack is a real step sequencer wired to the scheduler:

- 16/32-step patterns with per-step toggling and per-step velocity (click/wheel/arrow keys, plus a
  dedicated velocity painting mode for touch), pattern add/duplicate/rename/clear and selection.
- BPM (transport bar) and swing (rack) are project settings; every event is quantized to the
  sixteenth-note grid and scheduled on the audio clock, so tempo changes re-anchor playback
  without drift.
- Channel mute/solo are applied when project events are built, so activity lights and the step
  playhead always reflect the events the scheduler actually queues — indicators only move while
  the engine is genuinely playing.
- User samples load per channel through the file picker or drag-and-drop (WAV/MP3/OGG/FLAC/M4A
  and other `audio/*` types the browser can decode), with visible loading and per-row error states;
  a preview button auditions the channel. Decoded buffers live in the runtime `SampleStore`, keyed
  by a stable `sampleId` stored on the channel.

## Piano Roll

The Piano Roll is a tick-accurate MIDI editor wired to the same project model and scheduler:

- Keyboard on the vertical axis (MIDI 0–127) and a bar/beat grid on the horizontal axis, with
  horizontal/vertical scroll, H/V zoom, and a playhead driven by the audio clock.
- Draw and Select tools: create, select, move, resize, duplicate, multi-select (shift / marquee),
  and delete notes. Copy/paste, quantize, and note-length presets are in the toolbar.
- Grid snapping to straight and triplet subdivisions (including 1/64 and off / 1-tick). All note
  positions and durations are stored as integer ticks (96 PPQ) so repeated edits cannot accumulate
  floating-point error.
- Velocity per note, with a dedicated velocity lane.
- Notes that start inside a clip or loop and extend past its end are truncated at the boundary;
  they do not wrap into the next iteration. Pattern notes themselves always lie inside the pattern.
- Instrument channels preview pitches from the keyboard and while drawing/moving notes. The
  built-in synth voice is the only pitched instrument; no extra instrument collection is bundled.

## Current limits

The engine plays the starter kit plus user-loaded samples: the built-in drum kit and synth are
synthesised placeholders (no bundled sample assets), channels have no inserts, and the mixer has
no faders. Loaded samples are session-only (buffers are not persisted with the project file yet).
Master metering, IndexedDB persistence, project import/export, effects, and plugin hosting remain
deferred and labeled in the UI. Drum lanes and sample-loaded lanes trigger from the Channel Rack
step grid; instrument lanes play piano-roll notes. No external fonts, assets, or network services
are required.
