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
- `src/core/transport` — tempo-independent transport state, sixteenth-note clock, and position formatting.
- `src/audio` — the `AudioEngine` lifecycle contract and browser Web Audio implementation. Audio context initialization is only attempted after the user presses **Enable audio**.
- `src/features` — focused UI modules for the transport, Channel Rack, Piano Roll, Playlist, Mixer, and asset browser.

Project content, transient panel/selection state, transport position, persistence, and browser audio objects are kept in separate layers. Pattern steps, piano-roll notes, tempo, time signature, and arrangement clips are editable and undoable. The starter project is currently held in memory only.

## Current limits

This phase establishes the editing and application foundation, not the complete audio engine. Play/stop drives a visual transport preview only. Enabling audio creates or resumes an `AudioContext`, but no instrument, sample, scheduler, or audio output is connected. Master metering, mixer faders/routing, the sample/instrument/preset browser, IndexedDB persistence, project import/export, effects, and plugin hosting are explicitly deferred and labeled in the UI. No external fonts, assets, or network services are required.
