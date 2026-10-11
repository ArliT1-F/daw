# Sample licenses — 808 Starter Kit

This folder contains the bundled **808 Starter Kit** (`manifest.json` lists the pack in machine-readable form).
Every file here is licensed under **Creative Commons Zero v1.0 Universal (public domain dedication)** (`CC0-1.0`).

## License

- Full text: [`LICENSE-CC0-1.0.txt`](./LICENSE-CC0-1.0.txt) (SHA-256 `a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499`)
- Canonical deed: https://creativecommons.org/publicdomain/zero/1.0/
- Attribution required by the license: **no**. The license is a public-domain dedication, so attribution is not a legal requirement. It is given anyway, as a courtesy.

CC0 does not grant trademark rights. Roland and TR-808 are trademarks of Roland Corporation, which does not endorse this kit.

## Attribution (courtesy)

> Recorded by Michael Fischer (Technopolis), "Roland TR-808 Rhythm Composer Sound Sample Set 1.0.0" (1994), distributed via tidalcycles/sounds-tr808-fischer under CC0 1.0. Credit is not required; it is given here as a courtesy. Roland and TR-808 are trademarks of Roland Corporation, which does not endorse this kit.

## Source

- Project: [tidalcycles/sounds-tr808-fischer](https://github.com/tidalcycles/sounds-tr808-fischer)
- Commit: `85fbecf1bec32553395625ea659e2a56dfd7c0e1`
- Retrieved: 2026-10-10
- The license file in the upstream repository is CC0 1.0 Universal. Its copyright line credits Michael Fischer / Technopolis.

The files are copied byte-for-byte from the upstream commit. Nothing was resampled, re-encoded, or edited. Each checksum below was computed from the upstream file and matches the file shipped here.

## Files

| File | Sound | Upstream path | Bytes | SHA-256 |
|---|---|---|---:|---|
| `kick-short.wav` | 808 Kick (short) | `bd8/BD0000.WAV` | 22,096 | `7bdb70b44c216ffd…` |
| `kick-long.wav` | 808 Kick (long) | `bd8/BD0025.WAV` | 44,146 | `77b2648133000406…` |
| `snare.wav` | 808 Snare | `sd8/SD0000.WAV` | 22,094 | `06a671f38ccfa682…` |
| `hat-closed.wav` | 808 Closed Hat | `ch8/CH.WAV` | 22,094 | `c9f30ff2b4d73b03…` |
| `hat-open.wav` | 808 Open Hat | `oh8/OH00.WAV` | 22,096 | `d8ca0f2176aae521…` |
| `clap.wav` | 808 Clap | `cp8/CP.WAV` | 176,446 | `376429bb81cb48d1…` |
| `rim.wav` | 808 Rim Shot | `rs8/RS.WAV` | 22,096 | `20d5cd385c0f8c3a…` |

Total: 7 files, 331,068 bytes.

## Verification

The app checks every file against `manifest.json` (byte length and SHA-256) before decoding it. A mismatch stops the load and names the file. `src/audio/samplePack.test.ts` repeats the same check against these files in the repository.
