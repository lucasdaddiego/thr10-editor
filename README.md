# THR10 Editor

A patch editor for the original Yamaha THR10 guitar amplifier that runs in
any Chromium browser over Web MIDI — built because Yamaha's official THR
Editor is Intel-only and dies with Rosetta 2's removal in macOS 28.

**Use it: https://thr.daddiego.com.ar** — connect the amp over USB, grant
the MIDI permission once, and it auto-connects from then on. Installable as
an app (Chrome → Install) and works offline.

## Features

- Control surface styled after the official editor: amp/cabinet selectors,
  rotary knobs (drag — Shift for fine — scroll, or arrow keys; click a value
  window to type an exact value), every documented effect block and
  parameter.
- 100-slot preset library (stored in the browser) with `.YDL` import/export
  compatible with the official editor's files. Double-click a slot's name to
  rename it, or an empty one to save the current patch there.
- Two-way live sync: knob turns on the amp update the UI, edits stream to
  the amp in real time. Cmd/Ctrl+Z undo. Drag & drop `.YDP`/`.YDL` files.
  Double-click a knob to revert it to the amp's value.
- Model-aware names for the whole family (THR10, 10C, 10X, 5, 5A),
  byte-verified against the official editor's factory preset banks.
- SysEx console (Console button) with decoded + raw logging and a raw hex
  send box, for protocol work.

## Development

No build step — plain HTML/JS/CSS. Serve the directory
(`python3 -m http.server`) and open localhost; Web MIDI needs a secure
context, which localhost is. Tests: `node tests/protocol.test.mjs`.
Every push to `master` runs the tests and deploys via GitHub Actions to
Cloudflare Workers.

The SysEx protocol is community reverse-engineered and verified against
real hardware — layouts, checksums, file formats, and open questions live
in [PROTOCOL.md](PROTOCOL.md). Credits:
[condordev/THRAndroidEditor](https://github.com/condordev/THRAndroidEditor),
[michaelforney/thr10](https://github.com/michaelforney/thr10).

## License

[MIT](LICENSE)
