// Schema-driven control panel styled after Yamaha's official THR editor:
// cream amp face with LED-list selectors and rotary knobs, dark effect rows
// with a lit push button per block. Visual layer only — protocol bytes and
// patch state live elsewhere.
//
// Knobs are custom rotary controls: drag vertically (Shift = fine), scroll,
// or focus and use arrow keys / PageUp / PageDown / Home / End.

import {
  AMP_MODELS, CABINETS, AMP_MODEL_PP, CABINET_PP, KNOBS, BLOCKS, paramsForType,
  EFFECT_ON, EFFECT_OFF,
} from './protocol.js';

export class Panel {
  /**
   * @param roots { amp: element for the cream amp row, blocks: element for effect rows }
   * @param ctx {
   *   getPatch(): Patch          — live edit buffer
   *   send(pp, value)            — emit a real-time parameter change
   *   resync()                   — request a fresh dump (after type/model changes)
   * }
   */
  constructor(roots, ctx) {
    this.roots = roots;
    this.ctx = ctx;
    this.labels = { amps: AMP_MODELS, cabs: CABINETS };
    this.renderAll();
  }

  get patch() { return this.ctx.getPatch(); }

  // Swap display names when a non-THR10 family member announces itself.
  setLabels(labels) {
    if (labels === this.labels) return;
    this.labels = labels;
    this.renderAll();
  }

  renderAll() {
    this.roots.amp.textContent = '';
    const brand = el('div', 'brand', 'THR10 ');
    brand.append(el('span', null, 'Editor'));
    this.roots.amp.append(brand, this.#ampControls());
    this.roots.blocks.textContent = '';
    for (const block of BLOCKS) this.roots.blocks.append(this.#blockRow(block));
  }

  // Called for an incoming param notification already applied to the patch.
  // Type/on-off changes re-render the row; values update in place.
  refreshParam(resolution) {
    switch (resolution.kind) {
      case 'ampModel':
        this.#refreshLedList(this.modelList, this.patch.ampModel);
        break;
      case 'cabinet':
        this.#refreshLedList(this.cabList, this.patch.cabinet);
        break;
      case 'knob':
        this.#setKnob(resolution.param.pp, this.patch.getKnob(resolution.param));
        break;
      case 'type':
      case 'onoff':
        this.#rerenderBlock(resolution.block);
        break;
      case 'param':
        if (resolution.param.enum) this.#setEnumList(resolution.param.pp, this.patch.getParam(resolution.block, resolution.param));
        else this.#setKnob(resolution.param.pp, this.patch.getParam(resolution.block, resolution.param));
        break;
    }
  }

  #q(selector) {
    return this.roots.amp.querySelector(selector) ?? this.roots.blocks.querySelector(selector);
  }

  #rerenderBlock(block) {
    const row = this.roots.blocks.querySelector(`[data-block="${block.key}"]`);
    if (row) row.replaceWith(this.#blockRow(block));
  }

  #setEnumList(pp, value) {
    const list = this.#q(`.model-list[data-pp="${pp}"]`);
    if (list) this.#refreshLedList(list, value);
  }

  #setKnob(pp, value) {
    const knob = this.#q(`.knob[data-pp="${pp}"]`);
    if (knob) knob._thrSet(value);
  }

  #refreshLedList(list, selected) {
    [...list.children].forEach((item, i) => {
      item.classList.toggle('on', i === selected);
      item.setAttribute('aria-pressed', String(i === selected));
    });
  }

  // ------------------------------------------------------------- rendering

  #ampControls() {
    const wrap = el('div', 'amp-controls');

    const left = el('div', 'amp-left');
    left.append(el('h2', 'amp-title', 'Amplifier'));
    this.modelList = this.#ledList(this.labels.amps, this.patch.ampModel, i => {
      this.patch.ampModel = i;
      this.#refreshLedList(this.modelList, i);
      this.ctx.send(AMP_MODEL_PP, i);
      this.ctx.resync(); // the amp re-applies the model's default cabinet
    });
    left.append(this.modelList);
    wrap.append(left);

    const cab = el('div', 'amp-cab');
    cab.append(el('h2', 'amp-title', 'Cabinet'));
    this.cabList = this.#ledList(this.labels.cabs, this.patch.cabinet, i => {
      this.patch.cabinet = i;
      this.#refreshLedList(this.cabList, i);
      this.ctx.send(CABINET_PP, i);
    });
    cab.append(this.cabList);
    wrap.append(cab);

    const knobGroup = el('div', 'amp-knobs');
    for (const knob of KNOBS) {
      knobGroup.append(this.#knobCell(knob, this.patch.getKnob(knob), v => {
        this.patch.setKnob(knob, v);
        this.ctx.send(knob.pp, v);
      }, snap => snap.getKnob(knob)));
    }
    wrap.append(knobGroup);

    return wrap;
  }

  #blockRow(block) {
    const row = el('section', 'block-row');
    row.dataset.block = block.key;

    row.append(el('h2', 'block-title', block.label)); // silk-screen label, top left

    const side = el('div', `block-side${block.types ? ' typed' : ''}`);
    const push = el('button', `push${this.patch.isOn(block) ? ' on' : ''}`);
    push.type = 'button';
    push.title = `${block.label} on/off`;
    push.setAttribute('aria-pressed', String(this.patch.isOn(block)));
    push.addEventListener('click', () => {
      const on = !this.patch.isOn(block);
      this.patch.setOn(block, on);
      this.ctx.send(block.onPP, on ? EFFECT_ON : EFFECT_OFF);
      push.classList.toggle('on', on);
      push.setAttribute('aria-pressed', String(on));
      row.classList.toggle('off', !on);
    });
    side.append(push);

    if (block.types) {
      side.append(this.#ledList(block.types, this.patch.getType(block), i => {
        this.patch.setType(block, i);
        this.ctx.send(block.typePP, i);
        this.#rerenderBlock(block); // re-list params for the new type
        this.ctx.resync(); // amp-side param defaults for the new type are unknown
      }));
    }
    row.append(side);

    const knobs = el('div', 'block-knobs');
    for (const param of paramsForType(block, this.patch)) {
      if (param.enum) {
        const cell = el('div', 'enum-list-cell');
        cell.append(el('span', 'knob-label', param.label));
        const list = this.#ledList(param.enum, this.patch.getParam(block, param), i => {
          this.patch.setParam(block, param, i);
          this.ctx.send(param.pp, i);
          this.#refreshLedList(list, i);
        });
        list.dataset.pp = param.pp;
        list.setAttribute('role', 'group');
        list.setAttribute('aria-label', `${block.label} ${param.label}`);
        cell.append(list);
        knobs.append(cell);
      } else {
        knobs.append(this.#knobCell(param, this.patch.getParam(block, param), v => {
          this.patch.setParam(block, param, v);
          this.ctx.send(param.pp, v);
        }, snap => snap.getParam(block, param)));
      }
    }
    row.append(knobs);
    row.classList.toggle('off', !this.patch.isOn(block));
    return row;
  }

  #ledList(options, selected, onSelect) {
    const list = el('div', 'model-list');
    options.forEach((name, i) => {
      const item = el('button', `model-item${i === selected ? ' on' : ''}`);
      item.type = 'button';
      item.setAttribute('aria-pressed', String(i === selected));
      item.append(el('span', 'mled'), el('span', 'mname', name));
      item.addEventListener('click', () => onSelect(i));
      list.append(item);
    });
    return list;
  }

  #knobCell(param, value, onInput, readSnap) {
    const cell = el('div', 'knob-cell');
    const out = el('span', 'knob-value');
    out.title = 'Click to type an exact value';
    const knob = el('div', 'knob');
    knob.dataset.pp = param.pp;
    knob.tabIndex = 0;
    knob.setAttribute('role', 'slider');
    knob.setAttribute('aria-label', param.label);
    knob.setAttribute('aria-valuemin', param.min);
    knob.setAttribute('aria-valuemax', param.max);

    const span = param.max - param.min;
    const clamp = v => Math.min(param.max, Math.max(param.min, Math.round(v)));
    let current = clamp(value);

    const paint = () => {
      knob.style.setProperty('--angle', `${-135 + (270 * (current - param.min)) / span}deg`);
      knob.setAttribute('aria-valuenow', current);
      knob.setAttribute('aria-valuetext', formatValue(param, current));
      out.textContent = formatValue(param, current);
    };
    const setFromUser = v => {
      v = clamp(v);
      if (v === current) return;
      current = v;
      paint();
      onInput(v);
    };
    knob._thrSet = v => { current = clamp(v); paint(); };
    paint();

    // Click the value window to type an exact value in display units.
    out.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'knob-value value-edit';
      input.setAttribute('aria-label', `${param.label} value`);
      input.value = formatValue(param, current);
      let done = false;
      const commit = apply => {
        if (done) return;
        done = true;
        if (apply) {
          const parsed = param.inv ? param.inv(input.value) : parseFloat(input.value);
          if (Number.isFinite(parsed)) setFromUser(parsed);
        }
        input.replaceWith(out);
      };
      input.addEventListener('keydown', ev => {
        ev.stopPropagation();
        if (ev.key === 'Enter') { ev.preventDefault(); commit(true); knob.focus(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); knob.focus(); }
      });
      input.addEventListener('blur', () => commit(true));
      out.replaceWith(input);
      input.focus();
      input.select();
    });

    // Double-click reverts this one parameter to its value in the last dump.
    knob.addEventListener('dblclick', () => {
      const snap = this.ctx.getSnapshot?.();
      if (snap) setFromUser(readSnap(snap));
    });

    knob.addEventListener('pointerdown', e => {
      e.preventDefault();
      knob.focus();
      knob.setPointerCapture(e.pointerId);
      const startY = e.clientY;
      const startV = current;
      const move = ev => {
        const pxFullRange = ev.shiftKey ? 900 : 150;
        setFromUser(startV + ((startY - ev.clientY) * span) / pxFullRange);
      };
      knob.addEventListener('pointermove', move);
      knob.addEventListener('lostpointercapture',
        () => knob.removeEventListener('pointermove', move), { once: true });
    });

    const step = Math.max(1, Math.round(span / 100));
    knob.addEventListener('wheel', e => {
      e.preventDefault();
      setFromUser(current + (e.deltaY < 0 ? step : -step));
    }, { passive: false });

    knob.addEventListener('keydown', e => {
      const deltas = {
        ArrowUp: step, ArrowRight: step, ArrowDown: -step, ArrowLeft: -step,
        PageUp: step * 10, PageDown: -step * 10,
      };
      if (Object.hasOwn(deltas, e.key)) { e.preventDefault(); setFromUser(current + deltas[e.key]); }
      else if (e.key === 'Home') { e.preventDefault(); setFromUser(param.min); }
      else if (e.key === 'End') { e.preventDefault(); setFromUser(param.max); }
    });

    cell.append(el('span', 'knob-label', param.label), out, knob);
    return cell;
  }

}

function formatValue(param, value) {
  return param.fmt ? param.fmt(value) : String(value);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
