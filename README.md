# THR10 Editor

A patch editor for the original Yamaha THR10 guitar amplifier that runs in any
Chromium browser via Web MIDI — built because Yamaha's official THR Editor is
Intel-only and dies with Rosetta 2's removal in macOS 28.

- **No build step.** Plain HTML/JS/CSS static files; host anywhere (GitHub
  Pages, Cloudflare Pages) or open locally.
- **Installable.** Use Chrome's "Install as app" to get a Dock icon and
  standalone window on macOS.
- **Protocol** reverse-engineered by the community; see [PROTOCOL.md](PROTOCOL.md).
  Credits: [condordev/THRAndroidEditor](https://github.com/condordev/THRAndroidEditor),
  [michaelforney/thr10](https://github.com/michaelforney/thr10).

## Running

Hosted at **https://thr.daddiego.com.ar/** (Cloudflare Workers static
assets; deploy with `wrangler deploy`). A mirror also serves from GitHub
Pages at https://lucasdaddiego.github.io/thr10-editor/ on every push.

Open in Chrome, connect the amp over USB, grant the MIDI/SysEx permission
once. Installable via Chrome's "Install app" and works offline afterwards
(service worker). Note the preset library lives in the browser's
localStorage, so it is per-origin (and per-profile).

## Running locally

Web MIDI requires a secure context, so serve the directory instead of opening
`index.html` directly:

```sh
python3 -m http.server 8000
# then open http://localhost:8000 in Chrome
```

Connect the THR10 over USB and grant the MIDI/SysEx permission. The editor
auto-connects on page load (silently once the permission has been granted);
the **Connect** button remains as a manual retry.

## Status

Functional editor, **verified against a real THR10** (2026-08-02): handshake,
276-byte dump and checksum confirmed over CoreMIDI; a live capture is a test
fixture (`tests/fixtures/thr10-real-dump.syx`). Notable hardware finding: the
amp re-announces itself after every dump it sends, so announce-triggered dump
requests are suppressed right after a dump arrives (PROTOCOL.md §10.2).

- Full protocol layer ([js/protocol.js](js/protocol.js)) implementing
  [PROTOCOL.md](PROTOCOL.md): handshake, real-time parameter changes, 276-byte
  patch dumps with checksum, `.YDP` patch file import/export. Validated against
  real captured dumps (`tests/protocol.test.mjs` — run with
  `node tests/protocol.test.mjs`).
- Control panel for every documented parameter: amp model/cabinet, the five
  knobs, compressor, effect (modulation), delay, reverb, noise gate — with
  on/off LEDs, type-dependent parameter sets, and human-readable units
  (ms/Hz/dB/s).
- UI modeled on Yamaha's official THR editor: cream amp face with a lit model
  selector, rotary knobs (drag vertically — hold Shift for fine control —
  scroll, or use arrow keys), black value windows with amber digits, and LED
  push buttons per effect row.
- Auto-connect on page load, plus auto-handshake: when the amp announces
  itself (or the port appears), the editor requests a dump and populates the
  panel; knob turns on the amp update the UI live.
- 100-slot preset library in the sidebar (persisted in localStorage), with
  `.YDL` import/export interoperable with the official editor's library files.
- Editing niceties: click a value window to type an exact value, double-click
  a knob to revert it to the amp's last-known value, Cmd/Ctrl+Z undo, drag &
  drop `.YDP`/`.YDL` files onto the window, and a dirty dot on the patch name
  when local edits haven't reached the amp.
- Model-aware labels: a THR10C announce swaps in its amp-model names
  (Deluxe, Class A, …); byte values are identical family-wide.
- SysEx console (Console button, opens as a modal) with decoded + raw logging
  and a raw hex send box for investigating PROTOCOL.md's open questions.
  Logging runs only while the console is open, so it costs nothing in normal
  use; errors and confirmations surface as toasts instead.

Next: exercise parameter writes against the amp (reads are verified; see
PROTOCOL.md §10 for what's still open).
