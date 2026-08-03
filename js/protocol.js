// THR10-family SysEx protocol layer. All byte layouts come from PROTOCOL.md
// (reverse-engineered from condordev/THRAndroidEditor and michaelforney/thr10).
// This module is pure data + functions: no MIDI, no DOM.

export const MODEL_NAMES = {
  0x30: 'THR5', 0x31: 'THR10', 0x32: 'THR10X', 0x33: 'THR10C', 0x34: 'THR5A',
};

const HDR = [0xf0, 0x43, 0x7d];
// "DTA1AllP\0\0\x7F\x7F"
const MAGIC = [0x44, 0x54, 0x41, 0x31, 0x41, 0x6c, 0x6c, 0x50, 0x00, 0x00, 0x7f, 0x7f];

export const DUMP_SIZE = 276;
const NAME_OFF = 18;
const NAME_SIZE = 128;
const NAME_MAX = 48;
const PAYLOAD_OFF = 146;
const PAYLOAD_SIZE = 128;
const DATA_SIZE = 268; // magic + name + payload, covered by the checksum

export const EFFECT_ON = 0x00;
export const EFFECT_OFF = 0x7f;

// ---------------------------------------------------------------- messages out

export function msgAttach() {
  // "DTA1AllP" — editor attach; the amp answers with a full 276-byte dump
  return Uint8Array.from([...HDR, 0x20, 0x44, 0x54, 0x41, 0x31, 0x41, 0x6c, 0x6c, 0x50, 0xf7]);
}

export function msgParam(pp, value) {
  return Uint8Array.from([...HDR, 0x10, 0x41, 0x30, 0x01, pp, (value >> 7) & 0x7f, value & 0x7f, 0xf7]);
}

export const SYS_WIDE = 0x00;
export const SYS_LED = 0x01;

export function msgSystem(func, on) {
  // NB: system messages use 00=on / 01=off, unlike effect blocks (00=on / 7F=off)
  return Uint8Array.from([...HDR, 0x30, 0x41, 0x30, func, on ? 0x00 : 0x01, 0xf7]);
}

// ------------------------------------------------------------------- parsing

export function parse(bytes) {
  // Every THR message starts F0 43 7D (Yamaha, THR family). Anything else is
  // surfaced raw instead of misdecoded — the "THR" port-name filter alone
  // doesn't guarantee only THR traffic arrives here.
  if (bytes[0] !== 0xf0 || bytes[1] !== 0x43 || bytes[2] !== 0x7d) return { kind: 'other', bytes };
  if (bytes.length === 9 && bytes[3] === 0x60
      && bytes[4] === 0x44 && bytes[5] === 0x54 && bytes[6] === 0x41) { // "DTA"
    return { kind: 'announce', model: bytes[7], modelName: MODEL_NAMES[bytes[7]] ?? `unknown (${bytes[7].toString(16)})` };
  }
  if (bytes.length === 11) {
    // Byte 3 deliberately unchecked: what the amp puts there in knob-turn
    // notifications is unverified (PROTOCOL.md §10.3).
    return { kind: 'param', pp: bytes[7], value: ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f) };
  }
  if (bytes.length === 13) return { kind: 'unknown13', bytes };
  if (bytes.length === DUMP_SIZE) {
    try {
      return { kind: 'dump', patch: Patch.fromDump(bytes) };
    } catch (err) {
      return { kind: 'badDump', error: err.message, bytes };
    }
  }
  return { kind: 'other', bytes };
}

// ------------------------------------------------------------- parameter schema

// The official editor shows 0–100 knobs (and the 1–10/1–14 ratios) as 0.0–10.0.
// Each fmt has an `inv` inverse so value windows accept typed input in display
// units ("3.6", "500 ms", "Thru"); results are clamped by the caller.
const fmtTen = v => (v / 10).toFixed(1);
const invTen = s => parseFloat(s) * 10;
const pct = { bits: 7, min: 0, max: 100, fmt: fmtTen, inv: invTen };
const fmtDb = bias => v => `${((v - bias) / 10).toFixed(1)} dB`;
const invDb = bias => s => parseFloat(s) * 10 + bias;
const fmtMs10 = v => `${(v / 10).toFixed(1)} ms`;
const fmtS10 = v => `${(v / 10).toFixed(1)} s`;
const fmtHz = thru => v => (v === thru ? 'Thru' : `${v} Hz`);
const invHz = thru => s => (/^\s*t/i.test(s) ? thru : parseFloat(s));

// Byte values are identical on every family member; only display names vary
// (PROTOCOL.md §7). Tables keyed by the §2.1 announce model name.
export const AMP_MODELS = ['Clean', 'Crunch', 'Lead', 'Brit Hi', 'Modern', 'Bass', 'Aco', 'Flat'];
export const CABINETS = ['US 4x12', 'US 2x12', 'Brit 4x12', 'Brit 2x12', '1x12', '4x10', 'None'];

export const MODEL_LABELS = {
  THR10: { amps: AMP_MODELS, cabs: CABINETS },
  THR10C: {
    amps: ['Deluxe', 'Class A', 'US Blues', 'Brit Blues', 'Mini', 'Bass', 'Aco', 'Flat'],
    cabs: CABINETS, // THR10C cabinet names are inconsistent in the sources (§7.2)
  },
};

export function labelsForModel(modelName) {
  return MODEL_LABELS[modelName] ?? MODEL_LABELS.THR10;
}

export const AMP_MODEL_PP = 0x00;
export const CABINET_PP = 0x06;

export const KNOBS = [
  { key: 'gain', label: 'Gain', pp: 0x01, off: 1, ...pct },
  { key: 'master', label: 'Master', pp: 0x02, off: 2, ...pct },
  { key: 'bass', label: 'Bass', pp: 0x03, off: 3, ...pct },
  { key: 'middle', label: 'Middle', pp: 0x04, off: 4, ...pct },
  { key: 'treble', label: 'Treble', pp: 0x05, off: 5, ...pct },
];

// Effect blocks: 16 bytes each in the dump payload, byte 0 = type,
// byte 15 = on/off. `params` is indexed by type (single entry when untyped).
// Offsets are relative to the block base; 14-bit values occupy off (HH), off+1 (LL).
export const BLOCKS = [
  {
    key: 'compressor', label: 'Compressor', base: 16, typePP: 0x10, onPP: 0x1f,
    types: ['Stomp', 'Rack'],
    params: [
      [
        { key: 'sustain', label: 'Sustain', pp: 0x11, off: 1, ...pct },
        { key: 'output', label: 'Output', pp: 0x12, off: 2, ...pct },
      ],
      [
        { key: 'threshold', label: 'Threshold', pp: 0x11, off: 1, bits: 14, min: 0, max: 600, fmt: fmtDb(600), inv: invDb(600) },
        { key: 'attack', label: 'Attack', pp: 0x13, off: 3, ...pct },
        { key: 'release', label: 'Release', pp: 0x14, off: 4, ...pct },
        { key: 'ratio', label: 'Ratio', pp: 0x15, off: 5, enum: ['1:1', '1:4', '1:8', '1:12', '1:20', '1:∞'] },
        { key: 'knee', label: 'Knee', pp: 0x16, off: 6, enum: ['Soft', 'Medium', 'Hard'] },
        { key: 'output', label: 'Output', pp: 0x17, off: 7, bits: 14, min: 0, max: 600, fmt: fmtDb(200), inv: invDb(200) },
      ],
    ],
  },
  {
    key: 'modulation', label: 'Effect', base: 32, typePP: 0x20, onPP: 0x2f,
    types: ['Chorus', 'Flanger', 'Tremolo', 'Phaser'],
    params: [
      [
        { key: 'speed', label: 'Speed', pp: 0x21, off: 1, ...pct },
        { key: 'depth', label: 'Depth', pp: 0x22, off: 2, ...pct },
        { key: 'mix', label: 'Mix', pp: 0x23, off: 3, ...pct },
      ],
      [
        { key: 'speed', label: 'Speed', pp: 0x21, off: 1, ...pct },
        { key: 'manual', label: 'Manual', pp: 0x22, off: 2, ...pct },
        { key: 'depth', label: 'Depth', pp: 0x23, off: 3, ...pct },
        { key: 'feedback', label: 'Feedback', pp: 0x24, off: 4, ...pct },
        { key: 'spread', label: 'Spread', pp: 0x25, off: 5, ...pct },
      ],
      [
        { key: 'freq', label: 'Freq', pp: 0x21, off: 1, ...pct },
        { key: 'depth', label: 'Depth', pp: 0x22, off: 2, ...pct },
      ],
      [
        { key: 'speed', label: 'Speed', pp: 0x21, off: 1, ...pct },
        { key: 'manual', label: 'Manual', pp: 0x22, off: 2, ...pct },
        { key: 'depth', label: 'Depth', pp: 0x23, off: 3, ...pct },
        { key: 'feedback', label: 'Feedback', pp: 0x24, off: 4, ...pct },
      ],
    ],
  },
  {
    key: 'delay', label: 'Delay', base: 48, typePP: null, onPP: 0x3f, types: null,
    params: [
      [
        { key: 'time', label: 'Time', pp: 0x31, off: 1, bits: 14, min: 1, max: 9999, fmt: fmtMs10, inv: invTen },
        { key: 'feedback', label: 'Feedback', pp: 0x33, off: 3, ...pct },
        { key: 'highcut', label: 'High Cut', pp: 0x34, off: 4, bits: 14, min: 1000, max: 16001, fmt: fmtHz(16001), inv: invHz(16001) },
        { key: 'lowcut', label: 'Low Cut', pp: 0x36, off: 6, bits: 14, min: 21, max: 8000, fmt: fmtHz(21), inv: invHz(21) },
        { key: 'level', label: 'Level', pp: 0x38, off: 8, ...pct },
      ],
    ],
  },
  {
    key: 'reverb', label: 'Reverb', base: 64, typePP: 0x40, onPP: 0x4f,
    types: ['Hall', 'Room', 'Plate', 'Spring'],
    params: (() => {
      const hallLike = [
        { key: 'time', label: 'Time', pp: 0x41, off: 1, bits: 14, min: 3, max: 200, fmt: fmtS10, inv: invTen },
        { key: 'pre', label: 'Pre Delay', pp: 0x43, off: 3, bits: 14, min: 1, max: 2000, fmt: fmtMs10, inv: invTen },
        { key: 'lowcut', label: 'Low Cut', pp: 0x45, off: 5, bits: 14, min: 21, max: 8000, fmt: fmtHz(21), inv: invHz(21) },
        { key: 'highcut', label: 'High Cut', pp: 0x47, off: 7, bits: 14, min: 1000, max: 16001, fmt: fmtHz(16001), inv: invHz(16001) },
        { key: 'highratio', label: 'High Ratio', pp: 0x49, off: 9, bits: 7, min: 1, max: 10, fmt: fmtTen, inv: invTen },
        { key: 'lowratio', label: 'Low Ratio', pp: 0x4a, off: 10, bits: 7, min: 1, max: 14, fmt: fmtTen, inv: invTen },
        { key: 'level', label: 'Level', pp: 0x4b, off: 11, ...pct },
      ];
      const spring = [
        { key: 'reverb', label: 'Reverb', pp: 0x41, off: 1, ...pct },
        { key: 'filter', label: 'Filter', pp: 0x42, off: 2, ...pct },
      ];
      return [hallLike, hallLike, hallLike, spring];
    })(),
  },
  {
    key: 'gate', label: 'Noise Gate', base: 80, typePP: null, onPP: 0x5f, types: null,
    params: [
      [
        { key: 'threshold', label: 'Threshold', pp: 0x51, off: 1, ...pct },
        { key: 'release', label: 'Release', pp: 0x52, off: 2, ...pct },
      ],
    ],
  },
];

// Map an incoming 11-byte param change to its meaning. Ambiguous PPs
// (e.g. 0x11, 0x21–0x23, 0x41) depend on the block's currently selected type,
// so the live patch is required for resolution.
export function resolveParam(pp, patch) {
  const nibble = pp >> 4;
  if (nibble === 0) {
    if (pp === AMP_MODEL_PP) return { kind: 'ampModel' };
    if (pp === CABINET_PP) return { kind: 'cabinet' };
    const knob = KNOBS.find(k => k.pp === pp);
    return knob ? { kind: 'knob', param: knob } : { kind: 'unknown' };
  }
  const block = BLOCKS[nibble - 1];
  if (!block) return { kind: 'unknown' };
  if ((pp & 0x0f) === 0x0f) return { kind: 'onoff', block };
  if (block.typePP !== null && pp === block.typePP) return { kind: 'type', block };
  const param = paramsForType(block, patch).find(p => p.pp === pp);
  return param ? { kind: 'param', block, param } : { kind: 'unknown', block };
}

export function paramsForType(block, patch) {
  const type = block.types ? Math.min(patch.getType(block), block.params.length - 1) : 0;
  return block.params[type];
}

// --------------------------------------------------------------------- patch

export class Patch {
  constructor() {
    this.name = '';
    this.payload = new Uint8Array(PAYLOAD_SIZE);
  }

  clone() {
    const p = new Patch();
    p.name = this.name;
    p.payload.set(this.payload);
    return p;
  }

  equals(other) {
    if (this.name !== other.name) return false;
    for (let i = 0; i < PAYLOAD_SIZE; i++) {
      if (this.payload[i] !== other.payload[i]) return false;
    }
    return true;
  }

  static fromDump(bytes) {
    if (bytes.length !== DUMP_SIZE) throw new Error(`dump length ${bytes.length}, expected ${DUMP_SIZE}`);
    for (let i = 0; i < MAGIC.length; i++) {
      if (bytes[6 + i] !== MAGIC[i]) throw new Error('bad dump magic');
    }
    const p = new Patch();
    p.name = decodeName(bytes, NAME_OFF);
    p.payload.set(bytes.subarray(PAYLOAD_OFF, PAYLOAD_OFF + PAYLOAD_SIZE));
    let sum = 0;
    for (let i = 6; i < 6 + DATA_SIZE + 1; i++) sum += bytes[i]; // data + checksum byte
    p.checksumOk = (sum & 0x7f) === 0;
    return p;
  }

  toDump() {
    const d = new Uint8Array(DUMP_SIZE);
    d.set([...HDR, 0x00, 0x02, 0x0c]); // header + 14-bit data length (268)
    d.set(MAGIC, 6);
    encodeName(this.name, d, NAME_OFF);
    this.payload[PAYLOAD_SIZE - 1] = 0; // last payload byte must be 0 (PROTOCOL.md §4.2)
    d.set(this.payload, PAYLOAD_OFF);
    let sum = 0;
    for (let i = 6; i < 6 + DATA_SIZE; i++) sum += d[i];
    d[6 + DATA_SIZE] = (~sum + 1) & 0x7f;
    d[DUMP_SIZE - 1] = 0xf7;
    return d;
  }

  get ampModel() { return this.payload[0]; }
  set ampModel(v) { this.payload[0] = v & 0x7f; }
  get cabinet() { return this.payload[6]; }
  set cabinet(v) { this.payload[6] = v & 0x7f; }

  getKnob(knob) { return this.payload[knob.off]; }
  setKnob(knob, v) { this.payload[knob.off] = v & 0x7f; }

  getType(block) { return block.types ? this.payload[block.base] : 0; }
  setType(block, v) { this.payload[block.base] = v & 0x7f; }

  isOn(block) { return this.payload[block.base + 15] === EFFECT_ON; }
  setOn(block, on) { this.payload[block.base + 15] = on ? EFFECT_ON : EFFECT_OFF; }

  getParam(block, param) {
    const at = block.base + param.off;
    return param.bits === 14
      ? ((this.payload[at] & 0x7f) << 7) | (this.payload[at + 1] & 0x7f)
      : this.payload[at];
  }

  setParam(block, param, value) {
    const at = block.base + param.off;
    if (param.bits === 14) {
      this.payload[at] = (value >> 7) & 0x7f;
      this.payload[at + 1] = value & 0x7f;
    } else {
      this.payload[at] = value & 0x7f;
    }
  }
}

function decodeName(bytes, off) {
  let name = '';
  for (let i = 0; i < NAME_MAX; i++) {
    const c = bytes[off + i];
    if (c < 32 || c > 126) break;
    name += String.fromCharCode(c);
  }
  return name;
}

function encodeName(name, bytes, off) {
  bytes.fill(0, off, off + NAME_SIZE);
  for (let i = 0; i < Math.min(name.length, NAME_MAX); i++) {
    const c = name.charCodeAt(i);
    // Printable ASCII only: anything else would either break the 7-bit SysEx
    // framing or make decodeName truncate the name on read-back.
    bytes[off + i] = c >= 32 && c <= 126 ? c : 0x5f; // '_'
  }
}

// ----------------------------------------------------------- .YDP patch files

const YDP_SIZE = 265;
const YDP_HEADER = [0x44, 0x54, 0x41, 0x50, 0x00, 0x02, 0x00, 0x00, 0x00]; // "DTAP" + header as written by THRAndroidEditor

export function patchToYdp(patch) {
  const f = new Uint8Array(YDP_SIZE);
  f.set(YDP_HEADER);
  encodeName(patch.name, f, 9);
  patch.payload[PAYLOAD_SIZE - 1] = 0;
  f.set(patch.payload, 9 + NAME_SIZE);
  return f;
}

export function patchFromYdp(bytes) {
  if (bytes.length !== YDP_SIZE) throw new Error(`YDP length ${bytes.length}, expected ${YDP_SIZE}`);
  if (bytes[0] !== 0x44 || bytes[1] !== 0x54 || bytes[2] !== 0x41 || bytes[3] !== 0x50) {
    throw new Error('not a DTAP file');
  }
  const p = new Patch();
  p.name = decodeName(bytes, 9);
  p.payload.set(bytes.subarray(9 + NAME_SIZE, 9 + NAME_SIZE + PAYLOAD_SIZE));
  return p;
}

// ----------------------------------------------------------- .YDL libraries
// PROTOCOL.md §8.2: 13-byte header + 100 records of 261 bytes (256-byte
// name+payload record + 5 pad bytes), final record's padding truncated.

export const YDL_SLOTS = 100;
export const YDL_SIZE = 0x65fc; // 26108
const YDL_HEADER = [0x44, 0x54, 0x41, 0x42, 0x30, 0x31, 0x64]; // "DTAB01d"
const YDL_REC_OFF = 0x0d;
const YDL_REC_SIZE = 261;

// Returns an array of YDL_SLOTS entries: Patch, or null for all-zero slots.
export function libraryFromYdl(bytes) {
  if (bytes.length !== YDL_SIZE) throw new Error(`YDL length ${bytes.length}, expected ${YDL_SIZE}`);
  for (let i = 0; i < YDL_HEADER.length; i++) {
    if (bytes[i] !== YDL_HEADER[i]) throw new Error('not a DTAB01d library file');
  }
  const slots = [];
  for (let i = 0; i < YDL_SLOTS; i++) {
    const off = YDL_REC_OFF + i * YDL_REC_SIZE;
    const p = new Patch();
    p.name = decodeName(bytes, off);
    p.payload.set(bytes.subarray(off + NAME_SIZE, off + NAME_SIZE + PAYLOAD_SIZE));
    slots.push(p.name || p.payload.some(b => b !== 0) ? p : null);
  }
  return slots;
}

export function libraryToYdl(slots) {
  const f = new Uint8Array(YDL_SIZE);
  f.set(YDL_HEADER); // header bytes 7–12 stay 0, matching the THR5/10 files
  for (let i = 0; i < YDL_SLOTS; i++) {
    const p = slots[i];
    if (!p) continue; // empty slot stays all-zero
    const off = YDL_REC_OFF + i * YDL_REC_SIZE;
    encodeName(p.name, f, off);
    p.payload[PAYLOAD_SIZE - 1] = 0;
    f.set(p.payload, off + NAME_SIZE);
  }
  return f;
}
