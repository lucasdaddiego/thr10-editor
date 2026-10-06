// Connection session: when to ask the amp for a dump, when to write a pending
// patch instead, and the announce-loop suppression — the rules that were only
// ever verified on hardware. Pure logic over an injected clock, timer and
// sender, so tests/session.test.mjs can drive it; the MIDI port and the DOM
// stay in app.js.

// The connection event and the amp's own announce can both ask for a dump
// within a few ms of each other — one request is enough.
export const DUMP_DEBOUNCE_MS = 250;
// No dump by then: the USB link is probably dead.
export const DUMP_TIMEOUT_MS = 2500;
// Verified on real hardware: the amp emits its announce again right after
// every dump it sends. An announce this soon after a dump we received (or a
// patch we just wrote on connect) merely trails it; asking again would loop.
export const ANNOUNCE_QUIET_MS = 2000;

export class Session {
  /**
   * @param io {
   *   now(): number           — monotonic clock in ms (performance.now)
   *   schedule(fn, ms)        — setTimeout
   *   sendAttach(): boolean   — send the dump request; false when the send failed
   *   sendPatch(why): boolean — write the edit buffer to the amp; false on failure
   *   onError(text)           — user-facing error
   * }
   */
  constructor(io) {
    this.io = io;
    this.online = false;
    // A patch loaded while no amp was connected (library slot or .YDP import):
    // the next connect writes it to the amp instead of fetching the amp's
    // sound over it. Holds the load's description for the log.
    this.pendingSend = null;
    this.lastDumpRequest = -Infinity;
    this.lastDumpReceived = -Infinity;
    this.lastConnectSend = -Infinity;
  }

  deferSend(why) {
    this.pendingSend = why;
  }

  // Returns true when a request went out.
  requestDump() {
    if (!this.online) return false;
    const now = this.io.now();
    if (now - this.lastDumpRequest < DUMP_DEBOUNCE_MS) return false;
    this.lastDumpRequest = now;
    if (!this.io.sendAttach()) return false;
    this.io.schedule(() => {
      if (this.online && this.lastDumpReceived < now) {
        this.io.onError('Amp did not answer the dump request — check the USB connection.');
      }
    }, DUMP_TIMEOUT_MS);
    return true;
  }

  // The THR port appeared or vanished. Returns the description of the patch
  // written on connect, or null when nothing was written.
  connection(online) {
    this.online = online;
    if (!online) return null;
    if (this.pendingSend) {
      // On a failed send the patch stays pending for the next connect.
      const why = `${this.pendingSend}, sent on connect`;
      if (this.io.sendPatch(why)) {
        this.pendingSend = null;
        this.lastConnectSend = this.io.now();
        return why;
      }
      return null;
    }
    this.requestDump(); // in case we missed the amp's announce
    return null;
  }

  announce() {
    const since = this.io.now() - Math.max(this.lastDumpReceived, this.lastConnectSend);
    if (since > ANNOUNCE_QUIET_MS) this.requestDump();
  }

  dumpReceived() {
    this.lastDumpReceived = this.io.now();
  }
}
