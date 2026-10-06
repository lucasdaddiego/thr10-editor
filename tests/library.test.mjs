// Library selection + Reload, run against a minimal fake DOM: library.js only
// needs createElement, append/replaceWith, listeners and localStorage.
import { Patch } from '../public/js/protocol.js';

class El {
  constructor(tag) {
    this.tag = tag;
    this.className = '';
    this.children = [];
    this.parent = null;
    this.listeners = {};
  }
  set textContent(text) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.text = text;
  }
  get textContent() { return this.text ?? this.children.map(c => c.textContent).join(''); }
  append(...nodes) {
    for (const n of nodes) { n.parent = this; this.children.push(n); }
  }
  replaceWith(node) {
    const siblings = this.parent.children;
    siblings[siblings.indexOf(this)] = node;
    node.parent = this.parent;
    this.parent = null;
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  fire(type, extra = {}) { for (const fn of this.listeners[type] ?? []) fn({ stopPropagation() {}, preventDefault() {}, ...extra }); }
  setAttribute() {}
  focus() {}
  select() {}
  has(cls) { return this.className.split(' ').includes(cls); }
  find(cls) {
    for (const c of this.children) {
      if (c.has(cls)) return c;
      const hit = c.find(cls);
      if (hit) return hit;
    }
    return null;
  }
}

const store = new Map();
const confirms = [];
let confirmAnswer = true;
for (const [name, value] of Object.entries({
  document: { createElement: tag => new El(tag) },
  localStorage: {
    getItem: k => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
  },
  confirm: text => { confirms.push(text); return confirmAnswer; },
})) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

const { Library } = await import('../public/js/library.js');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failures++; console.log(`FAIL ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`); }
  else console.log(`ok   ${label}`);
};

// Two stored patches in slots 001 and 002; the rest empty.
const stored = (name, firstByte) => {
  const p = new Patch();
  p.payload[0] = firstByte;
  return { name, payload: btoa(String.fromCharCode(...p.payload)) };
};
store.set('thr10.library.v1', JSON.stringify([stored('Clean', 1), stored('Lead', 2), null]));

let current = new Patch(); // the app's edit buffer
const loads = [];
const list = new El('ol');
const lib = new Library(list, {
  getPatch: () => current,
  onLoad: (patch, slot) => { loads.push(slot); current = patch; },
  notify: () => {},
});
const row = i => list.children[i];
const slotBtn = i => row(i).find('lib-slot');
const selectedRows = () => list.children.flatMap((li, i) => (slotBtn(i).has('selected') ? [i] : []));

// --- a fresh page selects nothing, so the first click on slot 001 loads it
check('fresh page selects no slot', selectedRows(), []);
check('fresh page shows no Reload', list.children.some(li => li.find('lib-reload')), false);
slotBtn(0).fire('click');
check('click on slot 001 loads it', loads, [0]);
check('slot 001 is selected', selectedRows(), [0]);
check('loaded patch is slot 001', current.payload[0], 1);

// --- a second click on the selected slot stays a no-op (double-click rename)
slotBtn(0).fire('click');
check('click on the selected slot does not reload', loads, [0]);

// --- Reload: no edits, no question
const reloadBtn = () => row(lib.selected).find('lib-reload');
check('selected stored slot shows Reload', Boolean(reloadBtn()), true);
reloadBtn()?.fire('click');
check('Reload without edits loads again', loads, [0, 0]);
check('Reload without edits asks nothing', confirms.length, 0);

// --- Reload: a renamed buffer is not an edit (the slot owns its name)
current.name = 'Other name';
reloadBtn()?.fire('click');
check('name-only difference asks nothing', confirms.length, 0);
check('name-only difference reloads', loads, [0, 0, 0]);

// --- Reload with edits: confirm first; Cancel keeps the edits
current.payload[0] = 99;
confirmAnswer = false;
reloadBtn()?.fire('click');
check('Reload with edits asks first', confirms.length, 1);
check('cancelled Reload keeps the edits', [loads.length, current.payload[0]], [3, 99]);
confirmAnswer = true;
reloadBtn()?.fire('click');
check('confirmed Reload discards the edits', [loads.length, current.payload[0]], [4, 1]);

// --- an empty slot: selected on click, nothing to load, no Reload
slotBtn(2).fire('click');
check('empty slot click loads nothing', loads.length, 4);
check('empty slot is selected', selectedRows(), [2]);
check('empty selected slot shows no Reload', Boolean(row(2).find('lib-reload')), false);
check('empty selected slot keeps Save', Boolean(row(2).find('lib-save')), true);

// --- keyboard rename: F2 on any slot opens the name field; Enter commits
slotBtn(1).fire('keydown', { key: 'F2' });
let field = row(1).find('lib-rename');
check('F2 opens the rename field with the current name', field?.value, 'Lead');
slotBtn(1).fire('keydown', { key: 'F2' });
check('a second F2 does not open a second field', row(1).find('lib-rename') === field, true);
field.value = 'Lead II';
field.fire('keydown', { key: 'Enter' });
check('Enter commits the new name', lib.slots[1].name, 'Lead II');
check('renamed slot is persisted', JSON.parse(store.get('thr10.library.v1'))[1].name, 'Lead II');
check('rename does not load the slot', loads.length, 4);

// --- Enter on the selected (empty) slot names it and saves the current patch
current.payload[0] = 7;
slotBtn(2).fire('keydown', { key: 'Enter' });
field = row(2).find('lib-rename');
check('Enter on the selected slot opens an empty name field', field?.value, '');
field.value = 'Mine';
field.fire('keydown', { key: 'Enter' });
check('naming an empty slot saves the current patch there', [lib.slots[2]?.name, lib.slots[2]?.payload[0]], ['Mine', 7]);

// --- Enter on a slot that is not selected is left to the click (load)
slotBtn(0).fire('keydown', { key: 'Enter' });
check('Enter on another slot opens no rename field', row(0).find('lib-rename'), null);

// --- Escape drops the edit
slotBtn(1).fire('keydown', { key: 'F2' });
field = row(1).find('lib-rename');
field.value = 'Dropped';
field.fire('keydown', { key: 'Escape' });
check('Escape keeps the old name', lib.slots[1].name, 'Lead II');

console.log(failures ? `\n${failures} FAILURES` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
