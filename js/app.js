import { ThrMidi, toHex, parseHex } from './midi.js';
import {
  Patch, parse, resolveParam, msgAttach, msgParam, msgSystem,
  SYS_LED, SYS_WIDE, EFFECT_ON, labelsForModel, patchFromYdp,
} from './protocol.js';
import { Panel } from './panel.js';
import { Library } from './library.js';

const midi = new ThrMidi();
let patch = new Patch();
let ampModelName = null;
let labels = labelsForModel('THR10');

// --------------------------------------------------------------- DOM handles

const connDot = document.getElementById('conn-dot');
const connLabel = document.getElementById('conn-label');
const btnConnect = document.getElementById('btn-connect');
const logEl = document.getElementById('log');
const sendForm = document.getElementById('send-form');
const hexInput = document.getElementById('hex-input');
const btnClearLog = document.getElementById('btn-clear-log');
const btnDump = document.getElementById('btn-dump');
const dirtyDot = document.getElementById('dirty-dot');
const chkLed = document.getElementById('chk-led');
const chkWide = document.getElementById('chk-wide');
const btnConsole = document.getElementById('btn-console');
const btnCloseConsole = document.getElementById('btn-close-console');
const consoleDialog = document.getElementById('console-dialog');
const toastEl = document.getElementById('toast');
const ampRoot = document.getElementById('amp-root');
const blocksRoot = document.getElementById('blocks-root');
const btnLibExport = document.getElementById('btn-lib-export');
const libImport = document.getElementById('lib-import');

// ------------------------------------------------------------------- logging

const LOG_MAX_LINES = 400;

// The console only logs while its modal is open — closed, logging is a no-op
// so amp traffic costs nothing.
let consoleEnabled = false;

// Log lines are queued and flushed once per frame: a fast knob sweep on the
// amp arrives at MIDI rate, and appending + measuring the log per message
// would force a layout each time.
const logQueue = [];
let logFlushScheduled = false;

function flushLog() {
  logFlushScheduled = false;
  // Don't yank the view down if the user scrolled up to read something.
  const nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
  logEl.append(...logQueue);
  logQueue.length = 0;
  while (logEl.childNodes.length > LOG_MAX_LINES) logEl.firstChild.remove();
  if (nearBottom) logEl.scrollTop = logEl.scrollHeight;
}

// Hot-path callers pass a function, so the line is only built while the
// console is open — param traffic arrives at MIDI rate during a knob sweep.
function logLine(text) {
  if (!consoleEnabled) return;
  if (typeof text === 'function') text = text();
  logQueue.push(`[${new Date().toLocaleTimeString()}] ${text}\n`);
  if (!logFlushScheduled) {
    logFlushScheduled = true;
    requestAnimationFrame(flushLog);
  }
}

// With the console hidden by default, user-facing feedback (errors, load
// confirmations) surfaces as a transient toast instead.
let toastTimer;
function toast(text) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3500);
}

function logError(text) {
  logLine(`ERROR: ${text}`);
  toast(text);
}

function fmtParam(param, value) {
  if (param.enum) return param.enum[value] ?? value;
  return param.fmt ? param.fmt(value) : value;
}

function describeResolved(r, pp, value) {
  switch (r.kind) {
    case 'ampModel': return `Amp model = ${labels.amps[value] ?? value}`;
    case 'cabinet': return `Cabinet = ${labels.cabs[value] ?? value}`;
    case 'knob': return `${r.param.label} = ${fmtParam(r.param, value)}`;
    case 'type': return `${r.block.label} type = ${r.block.types[value] ?? value}`;
    case 'onoff': return `${r.block.label} ${value === EFFECT_ON ? 'ON' : 'OFF'}`;
    case 'param': return `${r.block.label} ${r.param.label} = ${fmtParam(r.param, value)}`;
    default: return `unknown param ${pp.toString(16).padStart(2, '0').toUpperCase()} = ${value}`;
  }
}

function describeParam(pp, value) {
  return describeResolved(resolveParam(pp, patch), pp, value);
}

// ------------------------------------------------- dirty tracking & snapshots

// dumpSnapshot mirrors the amp's edit buffer: set on every received dump and
// after every full-patch send. "Dirty" = local edits not yet in the amp.
let dumpSnapshot = null;

function setDirty(dirty) {
  dirtyDot.hidden = !dirty;
}

// ---------------------------------------------------------------------- undo

const UNDO_MAX = 50;
const undoStack = [];
let lastUndoMark = -Infinity;

// Snapshot the pre-gesture state. Interactions come in bursts (drag = many
// events), so a time guard turns each burst into one undo step.
function pushUndo(force) {
  const now = performance.now();
  if (!force && now - lastUndoMark < 400) return;
  lastUndoMark = now;
  const top = undoStack[undoStack.length - 1];
  if (top && top.equals(patch)) return;
  undoStack.push(patch.clone());
  if (undoStack.length > UNDO_MAX) undoStack.shift();
}

function undo() {
  let prev;
  while ((prev = undoStack.pop()) && prev.equals(patch)) { /* skip no-ops */ }
  if (!prev) return toast('Nothing to undo');
  patch = prev;
  panel.renderAll();
  sendFullPatch('undo');
  toast('Undo');
}

// Any interaction with the control surface may start an edit gesture.
for (const root of [ampRoot, blocksRoot]) {
  root.addEventListener('pointerdown', () => pushUndo(), true);
  root.addEventListener('keydown', e => {
    if (!e.metaKey && !e.ctrlKey) pushUndo();
  }, true);
  root.addEventListener('wheel', () => pushUndo(), { capture: true, passive: true });
}

window.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') {
    if (e.target instanceof HTMLInputElement && e.target.type === 'text') return; // native text undo
    e.preventDefault();
    undo();
  }
});

// ------------------------------------------------------- sending, with pacing

// Knobs fire fast; whether the amp tolerates bursts is unverified
// (PROTOCOL.md §10.13), so coalesce per-parameter with a short trailing delay.
const pending = new Map();
function sendParam(pp, value) {
  setDirty(true); // every local edit funnels through here, connected or not
  if (!midi.connected) return;
  if (!pending.has(pp)) {
    setTimeout(() => {
      const v = pending.get(pp);
      pending.delete(pp);
      if (!midi.connected) return; // port vanished while coalescing
      try {
        midi.send(msgParam(pp, v));
        logLine(() => `OUT ${describeParam(pp, v)}`);
      } catch (err) {
        logError(err.message);
      }
    }, 30);
  }
  pending.set(pp, value);
}

let lastDumpRequest = 0;
function requestDump() {
  if (!midi.connected) return;
  // The connection event and the amp's own announce can both request a dump
  // within a few ms of each other — one is enough.
  if (performance.now() - lastDumpRequest < 250) return;
  lastDumpRequest = performance.now();
  try {
    midi.send(msgAttach());
    logLine('OUT DTA1AllP (dump request)');
    const at = performance.now();
    setTimeout(() => {
      if (lastDumpReceived < at && midi.connected) {
        logError('Amp did not answer the dump request — check the USB connection.');
      }
    }, 2500);
  } catch (err) {
    logError(err.message);
  }
}

function sendSystem(func, on, what) {
  if (!midi.connected) return; // synced to the amp on the next connect
  try {
    midi.send(msgSystem(func, on));
    logLine(`OUT ${what} ${on ? 'on' : 'off'}`);
  } catch (err) {
    logError(err.message);
  }
}

// Push the whole edit buffer to the amp; on success the amp mirrors us again.
function sendFullPatch(why) {
  if (!midi.connected) { setDirty(true); return false; }
  try {
    midi.send(patch.toDump());
    logLine(`OUT full patch "${patch.name || '(unnamed)'}" (${why}) → amp edit buffer`);
    dumpSnapshot = patch.clone();
    setDirty(false);
    return true;
  } catch (err) {
    logError(err.message);
    return false;
  }
}

// --------------------------------------------------------------------- panel

const panel = new Panel({ amp: ampRoot, blocks: blocksRoot }, {
  getPatch: () => patch,
  getSnapshot: () => dumpSnapshot,
  send: sendParam,
  resync: () => setTimeout(requestDump, 300),
});

// ------------------------------------------------------------------- library

const library = new Library(document.getElementById('lib-list'), {
  notify: toast,
  getPatch: () => patch,
  onLoad: (loaded, slot) => {
    pushUndo(true);
    patch = loaded;
    panel.renderAll();
    if (sendFullPatch(`library slot ${slot + 1}`)) {
      toast(`"${patch.name || '(unnamed)'}" sent to the amp`);
    } else {
      toast(`Loaded "${patch.name || '(unnamed)'}" — connect and press "Send Amp" to hear it`);
    }
  },
});

btnLibExport.addEventListener('click', () => {
  downloadFile(library.exportYdl(), 'THR10.YDL');
});

libImport.addEventListener('change', () => {
  const file = libImport.files[0];
  if (file) importYdlFile(file);
  libImport.value = '';
});

async function importYdlFile(file) {
  if (library.hasAny() && !confirm(`Replace your local library with "${file.name}"?`)) return;
  try {
    library.importYdl(new Uint8Array(await file.arrayBuffer()));
    toast(`Imported library "${file.name}"`);
  } catch (err) {
    logError(`importing ${file.name}: ${err.message}`);
  }
}

// ---------------------------------------------------------------- MIDI events

midi.addEventListener('connection', e => {
  const { connected, name } = e.detail;
  if (!connected) ampModelName = null; // a different amp may appear next
  // Disconnected: dim the control surface and disable it entirely (inert
  // blocks pointer and keyboard); the library stays usable offline.
  document.body.classList.toggle('offline', !connected);
  ampRoot.inert = !connected;
  blocksRoot.inert = !connected;
  btnDump.disabled = !connected;
  connDot.className = `dot ${connected ? 'online' : 'offline'}`;
  connLabel.textContent = connected ? (ampModelName ?? name) : 'Connect';
  logLine(connected ? `THR port found: ${name}` : 'THR port lost/not found');
  if (connected) {
    requestDump(); // in case we missed the amp's announce
    syncSystemToAmp(); // write-only settings: make the amp match the lenses
  }
});

// Verified on real hardware: the amp emits its announce again right after
// every dump it sends, so "announce → request dump" must be suppressed when
// the announce merely trails a dump we just received — else we loop forever.
let lastDumpReceived = -Infinity;

midi.addEventListener('sysex', e => {
  const data = e.detail.data;
  const ev = parse(data);
  switch (ev.kind) {
    case 'announce':
      ampModelName = ev.modelName;
      labels = labelsForModel(ev.modelName);
      panel.setLabels(labels);
      connLabel.textContent = ev.modelName;
      logLine(`IN  amp announce: ${ev.modelName}`);
      if (performance.now() - lastDumpReceived > 2000) requestDump();
      break;
    case 'param': {
      const r = resolveParam(ev.pp, patch); // resolve once for log + apply
      logLine(() => `IN  ${describeResolved(r, ev.pp, ev.value)}`);
      applyIncoming(r, ev.value);
      break;
    }
    case 'dump':
      lastDumpReceived = performance.now();
      pushUndo(true); // a dump overwrites local edits; keep them reachable
      patch = ev.patch;
      dumpSnapshot = patch.clone();
      setDirty(false);
      panel.renderAll();
      logLine(`IN  full dump: "${patch.name || '(unnamed)'}"${patch.checksumOk ? '' : ' — CHECKSUM MISMATCH'}`);
      logLine(() => `    raw: ${toHex(data.subarray(0, 40))} … (${data.length} bytes)`);
      break;
    case 'badDump':
      logLine(`IN  276-byte dump rejected: ${ev.error}`);
      break;
    case 'unknown13':
      logLine(() => `IN  13-byte message (unidentified, see PROTOCOL.md §10.1): ${toHex(ev.bytes)}`);
      break;
    default:
      logLine(() => `IN  ${toHex(ev.bytes)}`);
  }
});

function applyIncoming(r, value) {
  switch (r.kind) {
    case 'ampModel': patch.ampModel = value; break;
    case 'cabinet': patch.cabinet = value; break;
    case 'knob': patch.setKnob(r.param, value); break;
    case 'type': patch.setType(r.block, value); break;
    case 'onoff': patch.setOn(r.block, value === EFFECT_ON); break;
    case 'param': patch.setParam(r.block, r.param, value); break;
    default: return;
  }
  panel.refreshParam(r);
}

// ------------------------------------------------------------------- toolbar

async function connect(manual) {
  try {
    await midi.init();
    logLine('MIDI access granted, scanning for THR ports…');
  } catch (err) {
    logError(manual ? err.message : `Auto-connect failed: ${err.message} — press Connect to retry.`);
  }
}

btnConnect.addEventListener('click', () => connect(true));

btnDump.addEventListener('click', requestDump);

function downloadFile(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  // Revoking synchronously can abort the download; a lazy revoke costs nothing.
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

async function importYdpFile(file) {
  try {
    pushUndo(true);
    patch = patchFromYdp(new Uint8Array(await file.arrayBuffer()));
    panel.renderAll();
    logLine(`Loaded "${patch.name || file.name}"`);
    if (sendFullPatch('YDP import')) {
      toast(`"${patch.name || file.name}" sent to the amp`);
    } else {
      toast(`Loaded "${patch.name || file.name}" — connect to hear it`);
    }
  } catch (err) {
    logError(`importing ${file.name}: ${err.message}`);
  }
}

// Drop a .YDP (patch) or .YDL (library) anywhere on the window.
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  if (/\.ydp$/i.test(file.name)) importYdpFile(file);
  else if (/\.ydl$/i.test(file.name)) importYdlFile(file);
  else toast('Drop a .YDP patch or .YDL library file');
});

// LED/Wide are write-only in the protocol (not readable, not in the dump),
// so the UI is the source of truth: state persists locally and is pushed to
// the amp on every connect, keeping the lenses accurate.
const SYS_KEY = 'thr10.system.v1';
try {
  const sys = JSON.parse(localStorage.getItem(SYS_KEY) || '{}');
  if (typeof sys.led === 'boolean') chkLed.checked = sys.led;
  if (typeof sys.wide === 'boolean') chkWide.checked = sys.wide;
} catch { /* corrupt store — keep defaults */ }

function persistSystem() {
  try {
    localStorage.setItem(SYS_KEY, JSON.stringify({ led: chkLed.checked, wide: chkWide.checked }));
  } catch { /* storage full — settings just won't survive reload */ }
}

function syncSystemToAmp() {
  sendSystem(SYS_LED, chkLed.checked, 'amp LED');
  sendSystem(SYS_WIDE, chkWide.checked, 'wide stereo');
}

chkLed.addEventListener('change', () => { persistSystem(); sendSystem(SYS_LED, chkLed.checked, 'amp LED'); });
chkWide.addEventListener('change', () => { persistSystem(); sendSystem(SYS_WIDE, chkWide.checked, 'wide stereo'); });

// ------------------------------------------------------------- SysEx console

sendForm.addEventListener('submit', e => {
  e.preventDefault();
  try {
    const bytes = parseHex(hexInput.value);
    if (!bytes.length) return;
    midi.send(bytes);
    logLine(`OUT raw ${toHex(bytes)}`);
  } catch (err) {
    logError(err.message);
  }
});

btnClearLog.addEventListener('click', () => {
  logQueue.length = 0;
  logEl.textContent = '';
});

btnConsole.addEventListener('click', () => {
  consoleEnabled = true;
  consoleDialog.showModal();
  logLine('SysEx console enabled — traffic is logged while this dialog is open');
  logEl.scrollTop = logEl.scrollHeight;
});

btnCloseConsole.addEventListener('click', () => consoleDialog.close());

consoleDialog.addEventListener('close', () => {
  consoleEnabled = false; // back to zero-cost logging
  logQueue.length = 0;
});

// light-dismiss: a click on the backdrop (the dialog element itself) closes —
// but only if the press started there too, else selecting log text and
// releasing over the backdrop would close the console mid-copy.
let pressOnBackdrop = false;
consoleDialog.addEventListener('pointerdown', e => {
  pressOnBackdrop = e.target === consoleDialog;
});
consoleDialog.addEventListener('click', e => {
  if (pressOnBackdrop && e.target === consoleDialog) consoleDialog.close();
  pressOnBackdrop = false;
});

// ------------------------------------------------------------- auto-connect

// Connect on load: silently when the sysex permission is already granted,
// prompting once otherwise. The Connect button stays as a manual retry.
(async () => {
  try {
    const st = await navigator.permissions?.query({ name: 'midi', sysex: true });
    if (st?.state === 'denied') {
      logError('MIDI permission is blocked — allow it in the browser site settings, then press Connect.');
      return;
    }
  } catch { /* Permissions API can't describe MIDI here; just try below */ }
  await connect(false);
})();

// Offline support for the installed PWA (no-op during plain-http local dev).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
