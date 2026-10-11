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
- `src/audio` — `BrowserAudioEngine`, graph/voices, mixer buses and metering, lookahead scheduler/timer, and the runtime `SampleStore`. Decoded buffers never enter the project document.
- `src/core/mixer` — pure mixer model: dB/pan/meter maths, source routing, cycle detection, mute/solo resolution, and the audio-facing `MixerState`.
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
2. the `AudioGraph`: source strips → mixer buses → master bus → safety limiter → destination;
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

Tempo markers are supported. Mixer faders, pan, mute/solo, routing, and metering are live; per-parameter effect automation remains deferred.

## Verification

The implementation was actually checked with:

- **`npm test`: 43 files, 541 tests passed** (up from 36 files / 444 tests before Phase 7). Phase 7 adds sample import and identity (`sampleStore`, `sampleReuse`, decode errors, relink), sample-pack manifest rejection, checksum and size mismatch, `loadSamplePack` with a fake fetch and import, a check of the shipped kit against its files on disk, voice caps (96 total, 16 per channel, oldest stolen, sweep after end time), pool cleanup, synth note on/off, polyphony, pitch and detune, ADSR breakpoints, synth edits not releasing held notes, preset parse and reject cases, arrangement-signature exclusions, audition through channel region and gain, the library/inspector/synth UI, and an App-level integration test (`src/App.phase7.test.tsx`). Earlier phases: includes the existing Channel Rack, Piano Roll, Playlist, and engine suites, plus the Phase 6 additions: mixer model maths/routing/cycle detection and signatures, mixer commands and history coalescing, mixer serialization and v2→v3 migration, mixer-graph topology/diff/dispose, meter ballistics and bank, mixer playback routing and lifecycle, the Mixer panel UI, and App mixer wiring.
- **`npm run typecheck`: passed**, including the browser test code/configuration.
- **`npm run build`: passed**, producing the production bundle.
- **`npm run test:browser`: 9 Chromium specs** (5 Playlist + 4 Mixer), **not run in the Phase 7 sandbox**: Playwright could not download Chromium there (`Failed to download Chrome for Testing`). No new browser specs were added for Phase 7; the same flows are covered by the jsdom integration test above. The browser specs still need a run on a machine with Chromium. The mixer specs measure the real master-output signal and assert the master fader gates it, insert mute/solo gate it before the master bus, rerouting keeps it audible, and the meters go live while playing. Requires `npx playwright install chromium`.
- Browser audio checks use the real Web Audio graph and measure a nonzero master-output signal during playback and silence after stop. Fixture assertions check distinct instruments/instances, tempo-aware onsets, audio offsets/durations, and no repeated `(event ID, iteration)` pairs. **This is automated signal verification, not a human listening test.**

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

## Mixer — Phase 6

### Signal flow

```
voices → source strip → mixer bus (effect slots → fader → pan → meter) → … → master bus → limiter → output
```

- Every Channel Rack channel and every Playlist track is a **source strip** with exactly one send target, so no source can reach the master twice or through two paths. Playlist audio clips route by track (`audio:<trackId>`); pattern/sample voices route by their rack channel.
- Each **mixer bus** carries a stable effect-slot chain (a unity bypass until Phase 7), a dB **fader** (-60…+12 dB), a **pan** control (StereoPannerNode, with an equal-power fallback), and an in-line **analyser** for metering. Mute/solo are implemented as a smooth gain gate on the bus, never as a disconnect, so gating can't bypass the master.
- The **master bus** has a fader and an output meter, is pinned last, cannot be rerouted, and always feeds the safety limiter and the hardware output. `syncMixer` never touches that connection.

### Routing rules

- A bus routes to the master bus or to another insert; the destination graph must stay **acyclic** and every insert must reach the master. Self-routes, cycles, missing destinations, and rerouting the master are rejected by the model, the commands, and the graph (which falls back to the master and reports a warning rather than dangling or feeding back).
- Channel ordering is stable (master first), and inserts can be reordered. Removing a bus splices its feeders onto its own destination instead of dropping them.
- Track-to-mixer assignment is editable per source from each strip; sources default to the master bus.

### Correctness and performance

- All fader/pan/mute/route changes are `setTargetAtTime` ramps (fast constant for gates), so there are no clicks. A single-setting change touches exactly one `AudioParam` or one connection — the graph is never rebuilt and sounding voices are never restarted. Mixer edits are diffed against the live graph; an identical state is a no-op.
- Mixer edits use a separate `mixerStateSignature` than the arrangement, so moving a fader never rebuilds the event source or releases held notes. Conversely, `arrangementSignature` excludes mixer state, so the two sync paths never interfere.
- Meters poll the analysers at a bounded ~20 Hz via `requestAnimationFrame` (paused in a hidden tab) and write straight into bound DOM nodes with peak-hold/clip-latch ballistics — no React re-render per tick.

### Persistence

Mixer channels (name, role, fader, pan, mute/solo, destination, and prepared effect slots) and track/channel assignments are part of the versioned project document (**v3**, migrated from v2/v1). Every mixer edit is an undoable command and round-trips through JSON.

## Samples, synth, and starter kit — Phase 7

### Sample library

- **Import** WAV and any other format the browser can decode (MP3, OGG/Opus, FLAC, M4A/AAC, WebM audio, AIFF). Files are checked by extension and MIME type first; unsupported files, empty files, files over 64 MB, and decode failures get a specific message and leave the project unchanged.
- **Drag and drop** onto the library or onto a Channel Rack row. Dragging a library row onto a rack row assigns it.
- Each library entry shows duration, sample rate, channels, size, and format. Assign a sample to the selected channel, audition it, or clear it.
- **Identity and reuse.** A content hash (`sha256:<hex>` when SubtleCrypto is available, otherwise `fnv1a32:<hex>`) identifies the bytes. Importing identical bytes again, under any name, reuses the already-decoded buffer and creates no second asset. The buffer is decoded once.
- **Missing files.** Project assets are saved without audio. After a reload they show as *missing*: the rack chip is flagged, previews refuse to play a stand-in, and importing the same file relinks the existing asset (same ID, region and gain kept).
- **Region and gain.** Each channel can set a start and end (seconds, clamped to the file) and a gain from 0 to 200%. The region is applied as the buffer playback window, so trimming never copies or re-decodes audio. Assigning a new sample resets the region.

### Starter kit (CC0)

The **Add 808 starter kit** button loads seven one-shot drum sounds from `public/samples/808/`: kick (short and long), snare, closed and open hat, clap, and rim. The pack is self-contained: `manifest.json` lists every file with its byte length and SHA-256, and the loader verifies each one before decoding. A mismatch stops the load and names the file.

- **License:** CC0 1.0 Universal (public domain dedication). The full text is in `public/samples/808/LICENSE-CC0-1.0.txt`. Attribution is not legally required; it is given as a courtesy to Michael Fischer / Technopolis, in `public/samples/808/LICENSES.md`.
- **Source:** [tidalcycles/sounds-tr808-fischer](https://github.com/tidalcycles/sounds-tr808-fischer) at commit `85fbecf1bec32553395625ea659e2a56dfd7c0e1`. Each file is an unmodified copy of the upstream file at that commit, and its checksum was computed from the upstream file.
- Roland and TR-808 are trademarks of Roland Corporation, which does not endorse this kit.

### Built-in synthesizer

- One instrument model for every instrument channel. Native Web Audio only: two detuned oscillators (or one, with spread at 0), a lowpass `BiquadFilter`, and a linear ADSR gain envelope.
- Controls: waveform (sine, square, sawtooth, triangle), octave, semitone, fine tune in cents, tuning (A4 = 400–480 Hz), detune spread, ADSR, filter cutoff (logarithmic slider, 40 Hz–20 kHz) and resonance, and level. Every value is validated against the same bounds the UI, the commands, and the preset parser use.
- **Note-off** holds the note for its musical duration, then releases it over the release time. A release during attack or decay ramps from the level reached at that moment, so it never jumps.
- **Polyphony** is one voice per note, with the caps described below.
- Changing a synth parameter applies to the next note. It never releases a note that is already held, and never rebuilds the arrangement (`arrangementSignature` excludes synth and trim).
- **Presets:** Detuned Saw, Sub Bass, Saw Pluck, Square Lead, Soft Pad, and Sine Bell. A preset is a plain parameter set, not an audio graph. Export and import use the versioned file `{ "format": "gridline-synth-preset", "version": 1, "name", "params" }`. Unknown formats, unknown versions, unknown parameters, out-of-range values, and bad names are rejected with a message.

### Performance limits

- At most **96 voices** in total and **16 per channel**. When a limit is reached, the oldest voice by start time is stolen. An unstarted voice is cancelled; a sounding one gets the short cut fade.
- Voices are removed when their sources end and swept once their end time has passed, even if the `ended` event never fires. `clear()` disposes every voice.
- Sample voices share one decoded `AudioBuffer`, so many simultaneous hits do not copy audio.

### Channel Rack and inspector

- Click a channel to select it. The Piano Roll and the Browser inspector follow the selection.
- **Add synth** creates an instrument channel with the default patch. The Browser inspector shows the sample region and gain, and the synth editor for instrument channels.
- A channel with a missing sample is silent rather than playing a drum stand-in, and the chip says so.

## Current limits

Loaded audio is **session-only**. JSON keeps asset IDs, names, duration, and waveform metadata, but not decoded buffers or original file bytes. There is no persistent audio relink workflow yet. Refreshing the app also resets the in-memory project; save/load UI and IndexedDB persistence remain deferred.

Drum channels fall back to synthesized drum voices when no sample is assigned. The bundled audio is the CC0 808 starter kit only; there is no larger library and no sample-pack download service. The synth is a single lightweight model, not a plugin or sampler: no LFO, no per-note pitch envelope, and no multi-sample mapping. There is no time stretching, audio consolidation/export, plugin hosting, or effect automation. The mixer's effect slots are wired as unity bypasses: they validate, persist, and reserve a stable chain position, but no processor runs yet. Deferred features are labeled in the UI. No external fonts, bundled media downloads, or network services are needed for the app itself.
