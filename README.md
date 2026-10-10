# Gridline Audio

Gridline Audio is a free-to-use, browser-first DAW built with React, TypeScript, and Vite. The Channel Rack, Piano Roll, and multitrack Playlist share one project and audio-clock transport. There is no backend, account system, payment processing, cloud storage, or desktop wrapper.

## Requirements

- Node.js 20.19+ (or 22.12+)
- npm

## Install and run

```sh
npm ci
npm run dev
```

Vite prints the development URL. Development and preview servers bind to all interfaces and accept hosted-preview origins.

## Checks

```sh
npm test           # Vitest unit, DOM, and engine integration tests
npm run typecheck  # includes application, test suites, and browser-test configuration
npm run build      # typecheck and optimized production build
npm run preview    # serve the production build locally
```

Browser acceptance tests require Chromium:

```sh
npx playwright install chromium
npm run test:browser
```

Playwright starts or reuses the Vite development server on port 5173. Set `CHROMIUM_PATH` to use an existing compatible browser, or `PLAYLIST_BASE_URL` to use another **Vite development** server. The multi-instrument fixture test imports real source modules through Vite; it is not a production-static-server test. Browser recordings, traces, and reports are ignored by Git.

## Foundation map

- `src/core/project` — versioned project types, validation, JSON serialization, v1→v2 migration, and the `ProjectPersistence` interface. An IndexedDB adapter is deferred.
- `src/core/commands` — typed immutable edits, atomic command batches, and bounded undo/redo history.
- `src/core/time` — integer ticks (96 PPQ), steps, bars/beats, snapping, and tempo-map integration/inversion.
- `src/core/arrangement` — song regions, track/channel audibility, tempo maps, audio-length conversion, and source-local editor positions.
- `src/core/events` — musical events and the indexed, window-queryable `ArrangementEventSource`. The flat builder remains an offline/test convenience, not the live playback path.
- `src/core/transport` — UI transport state and `TransportClock`, the single authority mapping audio-clock time to musical position.
- `src/audio` — `BrowserAudioEngine`, graph/voices, lookahead scheduler/timer, and the runtime `SampleStore`. Decoded buffers never enter the project document.
- `src/features` — transport, Channel Rack, Piano Roll, Playlist, Mixer, and asset browser.
- `tests/browser` — Playwright acceptance tests using real layout, pointer capture, file decoding, Worker timing, and Web Audio output.

Project content, transient panel/selection state, transport position, persistence, and browser audio objects remain separate. The app currently holds its project in memory; JSON serialization is a core API, not a completed save/load UI.

## Playlist — Phase 5

### Arrangement workflow

- Create tracks with **+ Track**. Rename the lane field, reorder with ↑/↓, and mute/solo with M/S. Lanes can contain both pattern and audio instances; they are independent of Channel Rack channels.
- Choose a shared pattern or imported audio asset in the source selector. **Draw** places a clip at the clicked, snapped timeline position, including on occupied bars and other lanes. New pattern instances have the source pattern's length; extending the right edge repeats that source.
- Click to select, drag the body to move across time/lanes, or drag an edge to resize/trim. The inspector also edits name, destination track, start beat, duration, and source trim; audio instances additionally expose source-start seconds and gain.
- Shift or Ctrl/Cmd-click toggles selection. **Select** supports marquee selection. Move, resize, duplicate, delete, nudge, and copy/paste groups without cloning their patterns or decoded audio.
- Alt-drag duplicates. Ctrl/Cmd+D duplicates the selected group, Ctrl/Cmd+C/V copies/pastes, Delete/Backspace removes, and arrow keys nudge in time/track order (Shift+horizontal arrow nudges a bar). Each committed gesture or group operation is one undo entry. Escape/pointer cancellation discards previews.
- Snap choices include bar, beat, sixteenth, triplet, and one tick. Zoom and horizontal/vertical scrolling do not change musical positions. **+ 8 bars** extends empty editing space. Visible ruler/cells/clips are filtered to the viewport rather than creating a DOM element for every bar in a long song.
- Pattern and audio clips have distinct colors, boundaries, names, and template/waveform previews. Overlapping instances occupy visible subrows rather than hiding each other.
- **+ Audio** imports into the selected lane at the parked playhead; dropping a file on a lane imports at the drop position. WAV/MP3/OGG/FLAC/M4A and other browser-decodable audio formats are accepted. Channel Rack sample imports also become reusable Playlist audio assets, without a second decode.
- Selecting a pattern instance chooses its shared source. Double-click opens the Piano Roll. Editing the Rack or Piano Roll updates every instance of that source, while their local playheads/seeks account for the selected instance's song start and trim.

### Ruler, loops, and tempo

Click the bar/beat ruler to seek. Drag loop handles, Shift-drag the ruler, or edit the loop's start/end fields to define a saved region. The end is exclusive; fractional bar positions are supported. Playlist and transport loop buttons control the same project setting.

Loop-enabled playback stays within that region, even when it begins partway through existing clips. Seeking before its start clamps to the start; seeking at/after its exclusive end enters the start. With looping off, the active region is zero through the last clip end, with a one-bar minimum; unused loop markers and empty viewport extensions do not lengthen the song. Stop parks at the active region's start.

The transport BPM field edits the **base** tempo. Enter a marker BPM and use **+ Tempo** to apply a saved tempo change at the snapped song playhead (at tick zero it edits the base). Markers are visible in the ruler; click a marker to remove it. Later markers override the base from their positions onward. Notes, loop lengths, and audio source-offset calculations integrate this piecewise-constant map.

### Data and editing contract

Project format **v2** stores:

- reusable `patterns` and `audioAssets` separately from `playlist` instances;
- independent tracks with stable IDs, names, colors, mute/solo, and array order;
- each clip's stable ID, track ID, absolute `startTick`, positive `durationTicks`, and optional instance name;
- pattern instances referencing `patternId` plus `sourceOffsetTicks`, or audio instances referencing `assetId` plus `sourceOffsetSeconds`/gain;
- the saved loop and unique, sorted, positive-tick tempo markers.

Validation checks references, safe integer positions/ranges, and asset/loop/tempo metadata. v1 JSON is migrated using its saved time signature, preserving pattern and clip IDs and creating a default lane/loop. Moving, resizing, or duplicating a clip does not duplicate its reusable source data. Audio asset metadata contains duration and bounded waveform peaks, **not PCM bytes**.

## Audio engine

### Ownership

`BrowserAudioEngine` owns:

1. the `AudioContext`, created on a user playback/preview/import action rather than mounting;
2. the `AudioGraph`: channel buses → master gain → safety limiter → destination;
3. the `VoicePool`, including sounding and future voices;
4. the `TransportClock`;
5. the lookahead `Scheduler`.

The model holds no browser audio objects. Plain musical sample/note/audio events cross the `MusicalEventSource`/`MusicalEventSink` boundary. MIDI or offline renderers can use these contracts later without coupling the editors to Web Audio nodes.

### Window scheduling

- A timer wakes every **25 ms** (Worker when available, otherwise an interval). Each tick queries only the next **120 ms**, divided at loop boundaries, and schedules voices against `AudioContext.currentTime`.
- The source compiles each used pattern once, indexes clip intervals, and expands only nearby repeats. Live playback never builds or schedules an entire song. A million-bar clip can be queried near its current playback position without expanding its earlier repeats.
- Stable event IDs distinguish instance, repeat, channel, and note/step. Time-pruned deduplication records prevent a window overlap from replaying the same event, while a different overlapping clip intentionally gets a separate voice.
- `setArrangement` applies source, tempo map, signature, and loop atomically: synchronize the old position, retire the previous queue/voices, apply settings, seek once, and refill once.
- Rendering is not in the sound timing path. `requestAnimationFrame` reads the central, output-latency-compensated clock for the Playlist and source-local editor playheads.
- Events more than **10 ms** late are dropped rather than bursting behind the clock. A long timer stall skips obsolete loops and chases only the current held notes/audio. Timing stays audio-clock accurate provided the main thread fills the lookahead before its deadline.

### Explicit playback semantics

| Situation | Behavior |
| --- | --- |
| Overlapping clips | Additive/polyphonic playback, even on the same lane or using the same source. Intentional overlaps are not deduplicated against each other. Track and channel mute/solo both apply; mute wins over solo. |
| Play / resume | Begin at the parked position with 60 ms startup headroom. Held notes are retriggered for their remaining musical duration; audio starts at its trimmed source offset plus integrated elapsed song time. Earlier one-shot samples are not chased. |
| Seek while playing | Cancel future voices before their onsets, release sounding voices, re-anchor, and immediately query the new position. Seeking inside a held note/audio clip works; an onset exactly at the target is eligible. |
| Mid-song loop entry | Chase notes/audio already overlapping the loop start. Each pass is a new scheduling iteration. Notes and audio are capped at clip/loop boundaries, with no previous-pass tails crossing the boundary. |
| Clip/track/source edits | Retire the stale queue and sounding sustained voices, then chase the updated current window. Only unchanged, already-sounded one-shot onsets in the current pass are suppressed; canceled future downbeats and newly inserted coincident clips remain eligible. |
| Live tempo/meter changes | Preserve musical position. Reschedule note remainders and future onsets against the new map. Native audio already in flight preserves its actual file phase instead of jumping to a retroactive offset; explicit seeks, trim/onset/asset changes, and loop-induced position jumps re-resolve the source from the new song mapping. |
| Native audio | Playback rate stays 1: no stretching or repitching. Duration is capped at the source EOF, musical clip end, and loop end. Extending beyond EOF creates silence, not a repeated file. A later seek/resume uses the current tempo map, which can differ from a stream continued through a live tempo edit. |
| Pause | Synchronize loop wraps, freeze position, release voices, and cancel pending onsets. Resume chases the remainder at that position. |
| Stop / song end | Stop scheduling, cancel future starts, release all voices, park at the active region start, and reset the iteration. |
| Missing audio buffer | The instance is silent, visibly marked as missing, and never falls back to a synthesized drum. |

Native audio boundaries use short fades; synths keep their normal release within the clip but are cut at clip/loop edges. Chased synth notes restart their envelopes rather than preserving an oscillator's old phase.

### Failures and timing limits

`AudioEngineError` classifies unsupported Web Audio, autoplay blocking, unavailable devices, closed contexts, and voice-creation failures. UI errors are visible; unavailable audio never animates a pretend playing transport. A scheduling failure stops/releases the engine.

Output latency (typically 10–40 ms, more over Bluetooth) is reported and compensated in the visible playhead. Worker timers reduce background-tab starvation but cannot prevent all browser throttling, context suspension, or main-thread stalls. Web Audio offers no output-device selection. The Rack highlights sixteenth cells; the Playlist/Piano Roll draw continuous/tick-accurate positions from the same clock.

Tempo markers are supported; mixer/effect parameter automation remains deferred.

## Verification

The implementation was actually checked with:

- **`npm test`: 26 files, 317 tests passed.** Includes the existing Channel Rack and Piano Roll suites, arrangement commands/history and serialization/migration, source-window boundaries and shared-instance IDs, Playlist gestures/group edits, and App integration.
- **`npm run typecheck`: passed**, including the browser test code/configuration.
- **`npm run build`: passed**, producing the production bundle.
- **`npm run test:browser`: 5 Chromium tests passed.** These cover real cross-lane pointer movement/resizing, selection/history/shared-source opening, later-bar scroll/zoom/seek, decoded/trimmed audio, mid-song looping with tempo automation, multi-instrument overlapping playback, and a narrow viewport.
- Browser audio checks used the real Web Audio graph and measured a nonzero master-output signal during playback and silence after stop. Fixture assertions checked distinct instruments/instances, tempo-aware onsets, audio offsets/durations, and no repeated `(event ID, iteration)` pairs. **This is automated signal verification, not a human listening test.**

The shared fixture in `src/core/arrangement/__fixtures__/testArrangement.ts` combines phase-shifted shared patterns, two pitched instruments, one audio asset, a step 24–56 loop, and 120→90→150 BPM markers. Additional engine regressions cover editing during startup headroom, exact lookahead edges, zero-velocity/retimed-onset suppression, separator-safe event identities, live native-audio phase continuity, exclusive-loop-end seeks, loop edits that implicitly seek, one-tick loops at 300 BPM, missing assets, stopping, and stalls.

The injectable Web Audio double makes exact timing and future-voice cancellation assertions deterministic. Playwright separately exercises real browser layout, decoding, timers, voices, and output; Vitest never discovers the browser suite.

## Channel Rack

- 16/32-step patterns with per-step toggling and velocity (click/wheel/arrow keys plus touch-friendly velocity painting), pattern add/duplicate/rename/clear, and selection.
- BPM and swing are project settings. Pattern playback is now instanced through the Playlist, not a second concurrent sequencer queue.
- Channel mute/solo filters the same arrangement event source.
- File picker or drag/drop sample loading with loading/error states and preview. Decoded buffers live once in `SampleStore`; the channel and Playlist assets reference that shared runtime ID.

## Piano Roll

- MIDI 0–127 keyboard and tick-accurate bar/beat grid, horizontal/vertical scrolling/zoom, and an audio-clock playhead.
- Draw/Select, move/resize/duplicate/multi-select/delete, copy/paste/quantize, note-length presets, and velocity lane.
- Straight/triplet snapping, 1/64 and one-tick editing. Notes remain integer ticks (96 PPQ), so repeated edits cannot accumulate position error.
- Instrument pitch preview and the built-in synth. Notes crossing clip/loop ends are truncated, not wrapped. Editing a shared pattern affects all its instances.

## Current limits

Loaded audio is **session-only**. JSON keeps asset IDs, names, duration, and waveform metadata, but not decoded buffers or original file bytes. There is no persistent audio relink workflow yet. Refreshing the app also resets the in-memory project; save/load UI and IndexedDB persistence remain deferred.

The drum kit and pitched synth are synthesized placeholders, with no bundled audio library. There is no time stretching, audio consolidation/export, mixer faders/inserts, master metering, plugin hosting, or effect automation. Deferred features are labeled in the UI. No external fonts, bundled media downloads, or network services are needed for the app itself.
