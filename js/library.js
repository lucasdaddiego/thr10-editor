// 100-slot preset library, persisted in localStorage, interoperable with the
// official editor's .YDL files (PROTOCOL.md §8.2). UI is the sidebar list:
// click a slot to select + load it; Save writes the edit buffer to the
// selected slot.

import { Patch, YDL_SLOTS, libraryFromYdl, libraryToYdl } from './protocol.js';

const STORE_KEY = 'thr10.library.v1';

export class Library {
  /**
   * @param listEl <ol> the slot list renders into
   * @param ctx {
   *   onLoad(patch, slotIndex) — user clicked a non-empty slot; patch is a clone
   *   notify(text)             — toast
   * }
   */
  constructor(listEl, ctx) {
    this.listEl = listEl;
    this.ctx = ctx;
    this.slots = new Array(YDL_SLOTS).fill(null);
    this.selected = 0;
    this.#restore();
    this.#renderAll();
  }

  saveSlot(patch) {
    this.slots[this.selected] = patch.clone();
    this.#persist();
    this.#renderSlot(this.selected);
    this.ctx.notify(`Saved "${patch.name || '(unnamed)'}" to slot ${this.selected + 1}`);
  }

  hasAny() {
    return this.slots.some(Boolean);
  }

  importYdl(bytes) {
    this.slots = libraryFromYdl(bytes);
    this.#persist();
    this.#renderAll();
  }

  exportYdl() {
    return libraryToYdl(this.slots);
  }

  #restore() {
    let stored;
    try {
      stored = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null');
    } catch {
      return; // corrupted store — start fresh rather than dying on load
    }
    if (!Array.isArray(stored)) return;
    stored.forEach((s, i) => {
      if (!s || i >= YDL_SLOTS) return;
      try {
        const p = new Patch();
        p.name = String(s.name ?? '');
        p.payload.set(Uint8Array.from(atob(s.payload), c => c.charCodeAt(0)));
        this.slots[i] = p;
      } catch {
        // One corrupt slot must not drop the ones after it: the next
        // #persist would make that loss permanent.
      }
    });
  }

  #persist() {
    const arr = this.slots.map(p =>
      p && { name: p.name, payload: btoa(String.fromCharCode(...p.payload)) });
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(arr));
    } catch {
      this.ctx.notify('Could not persist the library (storage full?)');
    }
  }

  #renderAll() {
    this.listEl.textContent = '';
    for (let i = 0; i < YDL_SLOTS; i++) this.listEl.append(this.#slotRow(i));
  }

  #renderSlot(i) {
    this.listEl.children[i].replaceWith(this.#slotRow(i));
  }

  #slotRow(i) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    const patch = this.slots[i];
    btn.className = `lib-slot${patch ? '' : ' empty'}${i === this.selected ? ' selected' : ''}`;

    const num = document.createElement('span');
    num.className = 'lib-num';
    num.textContent = String(i + 1).padStart(3, '0');
    const name = document.createElement('span');
    name.className = 'lib-name';
    name.textContent = patch ? (patch.name || '(unnamed)') : 'Empty';

    btn.append(num, name);
    btn.addEventListener('click', () => {
      const prev = this.selected;
      this.selected = i;
      this.#renderSlot(prev);
      this.#renderSlot(i);
      if (this.slots[i]) this.ctx.onLoad(this.slots[i].clone(), i);
    });
    li.append(btn);
    return li;
  }
}
