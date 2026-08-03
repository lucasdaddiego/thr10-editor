// Web MIDI plumbing for the THR10: port discovery, SysEx send/receive, hex utils.
// Protocol-specific bytes live in protocol.js (generated from PROTOCOL.md), not here.

const PORT_NAME_HINT = 'THR';

export function toHex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

export function parseHex(text) {
  const cleaned = text.replace(/0x/gi, ' ').replace(/[,;]/g, ' ').trim();
  if (!cleaned) return new Uint8Array(0);
  const bytes = cleaned.split(/\s+/).flatMap(tok => {
    // Accept run-together captures like "F0437D…F7" by splitting into pairs.
    const parts = tok.length > 2 && tok.length % 2 === 0 && /^[0-9a-f]+$/i.test(tok)
      ? tok.match(/../g)
      : [tok];
    return parts.map(p => {
      const v = parseInt(p, 16);
      if (Number.isNaN(v) || v < 0 || v > 0xff) throw new Error(`Bad hex byte: "${p}"`);
      return v;
    });
  });
  return new Uint8Array(bytes);
}

export class ThrMidi extends EventTarget {
  #initPromise = null;
  #lastConnected = null;
  #lastName = null;

  constructor() {
    super();
    this.access = null;
    this.input = null;
    this.output = null;
  }

  get connected() {
    return !!(this.input && this.output);
  }

  // Safe to call repeatedly (auto-connect at load + the Connect button):
  // MIDI access is requested once, later calls just rescan the ports.
  async init() {
    if (!this.#initPromise) {
      this.#initPromise = this.#requestAccess().catch(err => {
        this.#initPromise = null; // allow retry after a denied prompt
        throw err;
      });
    }
    await this.#initPromise;
    this.#scanPorts();
  }

  async #requestAccess() {
    if (!navigator.requestMIDIAccess) {
      throw new Error('Web MIDI is not supported in this browser — use Chrome, Edge, or another Chromium browser.');
    }
    this.access = await navigator.requestMIDIAccess({ sysex: true });
    this.access.addEventListener('statechange', () => this.#scanPorts());
  }

  #scanPorts() {
    const findPort = ports =>
      [...ports.values()].find(p =>
        p.state === 'connected' && p.name && p.name.toUpperCase().includes(PORT_NAME_HINT));

    const input = findPort(this.access.inputs) ?? null;
    const output = findPort(this.access.outputs) ?? null;

    if (input !== this.input) {
      if (this.input) this.input.onmidimessage = null;
      this.input = input;
      if (this.input) {
        this.input.onmidimessage = e => this.#onMessage(e);
      }
    }
    this.output = output;

    // statechange also fires for implicit port open/close (e.g. our own first
    // send), so only notify when the effective connection actually changed.
    const name = this.input?.name ?? null;
    if (this.connected === this.#lastConnected && name === this.#lastName) return;
    this.#lastConnected = this.connected;
    this.#lastName = name;

    this.dispatchEvent(new CustomEvent('connection', {
      detail: { connected: this.connected, name },
    }));
  }

  #onMessage(e) {
    if (e.data[0] === 0xf0) {
      this.dispatchEvent(new CustomEvent('sysex', { detail: { data: e.data } }));
    }
  }

  send(bytes) {
    if (!this.output) throw new Error('No THR output port connected.');
    this.output.send(bytes);
  }
}
