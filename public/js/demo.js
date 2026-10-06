// Demo transport: a simulated THR10 behind the same interface as ThrMidi, so
// the editor can be tried with no amp (open the site with ?demo). It answers
// the dump request with its own patch, keeps that patch in step with what the
// editor sends, and announces itself again after every dump, like the
// hardware does (PROTOCOL.md §10). Nothing here touches Web MIDI.

import { Patch, parse, resolveParam, KNOBS, BLOCKS, EFFECT_ON } from './protocol.js';

export const DEMO_PORT_NAME = 'Demo THR10';

// F0 43 7D 60 "DTA" 31 F7 — the THR10 announce (PROTOCOL.md §2.1)
const ANNOUNCE = Uint8Array.from([0xf0, 0x43, 0x7d, 0x60, 0x44, 0x54, 0x41, 0x31, 0xf7]);

function demoPatch() {
  const p = new Patch();
  p.name = 'Demo Crunch';
  p.ampModel = 1; // Crunch
  p.cabinet = 2;  // Brit 4x12
  [62, 45, 55, 50, 60].forEach((v, i) => p.setKnob(KNOBS[i], v));
  for (const block of BLOCKS) p.setOn(block, false);
  const reverb = BLOCKS.find(b => b.key === 'reverb');
  p.setType(reverb, 3); // Spring
  p.setOn(reverb, true);
  const [amount, filter] = reverb.params[3];
  p.setParam(reverb, amount, 35);
  p.setParam(reverb, filter, 50);
  return p;
}

export class DemoMidi extends EventTarget {
  constructor() {
    super();
    this.patch = demoPatch();
    this.input = null;
    this.output = null;
  }

  get connected() {
    return !!(this.input && this.output);
  }

  async init() {
    if (this.connected) return;
    const port = { name: DEMO_PORT_NAME, state: 'connected' };
    this.input = port;
    this.output = port;
    this.dispatchEvent(new CustomEvent('connection', {
      detail: { connected: true, name: DEMO_PORT_NAME },
    }));
    this.#reply(ANNOUNCE, 60);
  }

  send(bytes) {
    if (!this.connected) throw new Error('No THR output port connected.');
    // F0 43 7D 20 "DTA1AllP" F7 — editor attach: answer with a full dump
    if (bytes.length === 13 && bytes[3] === 0x20) {
      this.#reply(this.patch.toDump(), 40);
      this.#reply(ANNOUNCE, 90);
      return;
    }
    const ev = parse(bytes);
    if (ev.kind === 'dump') {
      this.patch = ev.patch;
    } else if (ev.kind === 'param') {
      const r = resolveParam(ev.pp, this.patch);
      switch (r.kind) {
        case 'ampModel': this.patch.ampModel = ev.value; break;
        case 'cabinet': this.patch.cabinet = ev.value; break;
        case 'knob': this.patch.setKnob(r.param, ev.value); break;
        case 'type': this.patch.setType(r.block, ev.value); break;
        case 'onoff': this.patch.setOn(r.block, ev.value === EFFECT_ON); break;
        case 'param': this.patch.setParam(r.block, r.param, ev.value); break;
        default: break;
      }
    }
    // System messages (LED, wide) have no readable state: nothing to keep.
  }

  #reply(bytes, delayMs) {
    setTimeout(() => {
      if (!this.connected) return;
      this.dispatchEvent(new CustomEvent('sysex', { detail: { data: bytes } }));
    }, delayMs);
  }
}
