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
   *   getPatch(): Patch        — current edit buffer (for the save icon)
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
    const saved = patch.clone();
    const existing = this.slots[this.selected];
    // The slot owns its name: saving updates the sound, renaming is the
    // explicit double-click gesture. Only an empty slot takes the patch's name.
    if (existing?.name) saved.name = existing.name;
    this.slots[this.selected] = saved;
    this.#persist();
    this.#renderSlot(this.selected);
    this.ctx.notify(saved.name
      ? `Saved "${saved.name}" to slot ${this.selected + 1}`
      : `Saved to slot ${this.selected + 1} — double-click its name to rename`);
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
    li.className = 'lib-row';
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

    // Double-click a slot's name: rename it — or, on an empty slot, name it
    // and save the current patch into it in one gesture.
    btn.title = patch
      ? 'Click to load — double-click the name to rename'
      : 'Double-click the name to save the current patch here';
    name.addEventListener('dblclick', e => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 48;
      input.className = 'lib-rename';
      input.value = patch ? patch.name : '';
      input.placeholder = 'Name…';
      let done = false;
      const commit = apply => {
        if (done) return;
        done = true;
        const text = input.value.trim();
        if (apply && patch) {
          patch.name = text;
          this.#persist();
        } else if (apply && !patch && text) {
          const saved = this.ctx.getPatch().clone();
          saved.name = text;
          this.slots[i] = saved;
          this.#persist();
          this.ctx.notify(`Saved "${text}" to slot ${i + 1}`);
        }
        this.#renderSlot(i);
      };
      input.addEventListener('keydown', ev => {
        ev.stopPropagation();
        if (ev.key === 'Enter') commit(true);
        else if (ev.key === 'Escape') commit(false);
      });
      input.addEventListener('blur', () => commit(true));
      name.replaceWith(input);
      input.focus();
      input.select();
    });

    btn.append(num, name);
    btn.addEventListener('click', () => {
      // Clicking the already-selected slot is a no-op: re-rendering here would
      // swap the DOM node mid-double-click and swallow the rename gesture.
      if (i === this.selected) return;
      const prev = this.selected;
      this.selected = i;
      this.#renderSlot(prev);
      this.#renderSlot(i);
      if (this.slots[i]) this.ctx.onLoad(this.slots[i].clone(), i);
    });
    li.append(btn);

    if (i === this.selected) {
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'lib-save';
      save.title = 'Save the current patch into this slot';
      save.setAttribute('aria-label', `Save current patch to slot ${i + 1}`);
      save.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M2 2h9.2L14 4.8V14H2V2zm2.5 1.2v3.3h6V3.2h-6zm-.4 6.2V13h7.8V9.4H4.1z"/></svg>';
      save.addEventListener('click', e => {
        e.stopPropagation();
        this.saveSlot(this.ctx.getPatch());
      });
      li.append(save);
    }
    return li;
  }
}
