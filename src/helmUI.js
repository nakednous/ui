/**
 * @file Helm profile panel — per-DOF profile editor + live activity meters.
 * @module ui/helmUI
 * @license AGPL-3.0-only
 *
 * Zero p5 dependencies.  Pure vanilla DOM.  Zero core import — a helm is
 * recognised structurally (it exposes feed / profile / activity), never by type.
 *
 * ---------------------------------------------------------------------------
 * What this edits
 * ---------------------------------------------------------------------------
 * A 6-DOF helm's behaviour is shaped by one flat `profile` object — six channels
 * (Tx Ty Tz Rp Ry Rr), each { sign, sens, lane } — plus a global `deadzone`.
 * This builder is the config surface for exactly that data: the helm sibling of
 * the track transport panel.  Where the transport panel drives a timeline
 * cursor, this edits shaping data.  It writes the live `helm.profile` /
 * `helm.deadzone` BY REFERENCE — immediate, no copy step, no tick latency on the
 * edit side.
 *
 * Per DOF, one row:
 *   - a SIGNED slider spanning [-max, +max] with 0 at centre.  Distance from
 *     centre is `sens`, the side is `sign`; dragging through 0 flips the sign —
 *     one control, no separate sign toggle.  At 0 the DOF is muted (sens 0).
 *   - a `lane` cycle-button (0 -> 1 -> 2): the input channel feeding this DOF,
 *     the manual counterpart to a device calibrate sweep.  DISABLED while the
 *     slider sits at 0 — a muted DOF routes no channel and shows no activity, so
 *     there is nothing to permute.
 *   - an ACTIVITY meter: a thin bipolar read-out (the one non-control element,
 *     since a meter has no native-slider equivalent) that tick() drives from
 *     `helm.activity(out6)`, showing push vs pull.
 *
 * Plus a global `deadzone` slider, and — only with { frame: true } — an
 * EYE | WORLD | SELF selector writing `helm.from` (the named frames a pose helm
 * accepts; a mat4 is a live matrix, not a panel choice, and stays code-set).
 *
 * When a helm carries an input `filter` (the 1€ `oneEuro`), two more sliders —
 * `minCutoff` (Hz) and `beta` (unitless) — appear beside the deadzone, built
 * once and revealed by tick() on the null->attached transition, then seeded from
 * the live filter and panel-owned thereafter.  Hidden (no filter) by default.
 *
 * ---------------------------------------------------------------------------
 * Push and pull (like the transport panel)
 * ---------------------------------------------------------------------------
 * Editing writes the profile immediately (push).  Each tick() reads
 * `helm.activity(out6)` back to drive the meters and re-syncs the lane buttons
 * from the live profile (pull), so a sketch-side calibrate that rewrites a lane
 * shows up here.  The same shape as the transport panel pushing rate / loop
 * while pulling the seek cursor.
 *
 * ---------------------------------------------------------------------------
 * Returned API (mirrors the track / param builders)
 * ---------------------------------------------------------------------------
 *   ui.el              HTMLElement container
 *   ui.visible  get/set boolean
 *   ui.parent(el)      re-mount container into a new parent HTMLElement
 *   ui.tick()          drive meters + lane sync — call once per frame
 *   ui.dispose()       remove container from DOM
 */

'use strict';

import {
  createContainer, createButton, createSlider, createSelect, createLabel,
  setVisible, mount
} from './dom.js';

// Channel order — matches the helm's activity(out6) layout.  Local, not
// imported: the panel knows the profile shape by contract, never by type.
const CHANNELS = ['Tx', 'Ty', 'Tz', 'Rp', 'Ry', 'Rr'];

// Per-channel signed-slider bounds.  Translation channels carry order-1 sens;
// rotation channels are ~two orders finer (radians-per-unit).  These bound the
// slider [-max, +max] and set its step; they are presentation bounds, not helm
// limits (the profile accepts any number).
const T_MAX = 1,    T_STEP = 0.01;
const R_MAX = 0.01, R_STEP = 0.0002;

// Conditioning-slider presentation bounds — the 1€ filter knobs, shown only
// when a filter is attached.  minCutoff in Hz (the rest cutoff); beta unitless
// (how fast the cutoff opens with speed).  Presentation bounds, not filter
// limits — the filter accepts any number, as the profile does.
const MINCUT_MIN = 0.1, MINCUT_MAX = 10, MINCUT_STEP = 0.1;
const BETA_MIN   = 0,   BETA_MAX   = 2,  BETA_STEP   = 0.01;

// The named frames a pose helm accepts (the helm.from contract; a mat4 is
// code-only).  String values match the helm's own constants.
const FRAMES = [
  { value: 'EYE',   label: 'EYE (screen)' },
  { value: 'WORLD', label: 'WORLD (fixed)' },
  { value: 'SELF',  label: 'SELF (body)' },
];

// Translation channels start with 'T'.
const _isT = (ch) => ch.charCodeAt(0) === 84;

/**
 * Build a helm profile panel.
 *
 * @param {Object} helm  A PoseHelm (recognised by feed / profile / activity).
 * @param {Object} [opt]
 * @param {boolean} [opt.frame=false]  Show the EYE|WORLD|SELF frame selector.
 * @param {number}  [opt.x=0]          Container left (px).
 * @param {number}  [opt.y=0]          Container top (px).
 * @param {number}  [opt.width=130]    Signed-slider width (px).
 * @param {string}  [opt.color]        Container text colour (meters inherit it).
 * @param {boolean} [opt.inline=false] Flow inline instead of the absolute float.
 * @param {Function}[opt.onChange]     Called after any user edit of the profile.
 * @param {boolean} [opt.hidden=false] Start hidden.
 * @param {string}  [opt.title]        Optional bold title row.
 * @param {HTMLElement} [opt.parent]   Mount target (defaults to document.body).
 * @returns {Object} Panel handle — see "Returned API" above.
 */
export function createHelmUI(helm, opt) {
  opt = opt || {};
  const profile = helm.profile;
  const sliderW = opt.width ?? 130;

  const container = createContainer('helm-ui', opt.inline);
  if (!opt.inline) {
    container.style.left = `${opt.x ?? 0}px`;
    container.style.top  = `${opt.y ?? 0}px`;
  }
  if (opt.color) container.style.color = opt.color;

  let _vis = true;

  // Fire the edit callback (if any) after a user change. Calibration writes the
  // profile directly, not through here, so a sketch calls onChange itself there.
  const _changed = () => { if (opt.onChange) opt.onChange(); };

  // ── Optional title ──────────────────────────────────────────────────────────

  if (opt.title) {
    const t = createLabel(opt.title);
    t.style.fontWeight = 'bold';
    t.style.marginBottom = '6px';
    container.appendChild(t);
  }

  // ── Per-DOF rows ────────────────────────────────────────────────────────────
  // Each controller is read every tick: { ch, laneBtn, fill }.  The slider is
  // write-only (user → profile); the profile is the source of truth elsewhere.

  const rows = [];
  const _act = [0, 0, 0, 0, 0, 0];   // helm.activity(out6) scratch — reused each tick

  for (const ch of CHANNELS) {
    const c    = profile[ch];
    const max  = _isT(ch) ? T_MAX  : R_MAX;
    const step = _isT(ch) ? T_STEP : R_STEP;

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:3px;';

    const name = createLabel(ch);
    name.style.minWidth = '24px';

    // lane cycle-button — disabled while the DOF is muted (sens 0).
    const laneBtn = createButton(`${c.lane}`, () => {
      c.lane = (c.lane + 1) % 3;
      laneBtn.textContent = `${c.lane}`;
      _changed();
    });
    laneBtn.title = 'input lane (click to cycle)';
    laneBtn.style.cssText = 'min-width:24px;padding:2px 6px;';
    laneBtn.disabled = c.sens === 0;

    // signed slider — value is sign*sens; drag through 0 flips sign / mutes.
    const slider = createSlider(-max, max, c.sign * c.sens, step, (v) => {
      c.sens = Math.abs(v);
      if (v > 0) c.sign = 1;
      else if (v < 0) c.sign = -1;     // at exactly 0 keep the last sign — the DOF is muted anyway
      laneBtn.disabled = c.sens === 0;
      _changed();
    });
    slider.style.width = `${sliderW}px`;

    // activity meter — bipolar fill from centre, driven each tick.  currentColor
    // ties the fill to opt.color (or the inherited text colour).
    const meter = document.createElement('div');
    meter.className = 'p5t-helm-meter';
    meter.style.cssText =
      'position:relative;flex:1;min-width:34px;height:6px;border-radius:3px;' +
      'background:rgba(127,127,127,0.18);overflow:hidden;';
    const fill = document.createElement('i');
    fill.style.cssText =
      'position:absolute;top:0;bottom:0;left:50%;width:0;background:currentColor;opacity:0.35;';
    meter.appendChild(fill);

    row.appendChild(name);
    row.appendChild(laneBtn);
    row.appendChild(slider);
    row.appendChild(meter);
    container.appendChild(row);

    rows.push({ ch, laneBtn, fill });
  }

  // ── Global deadzone ─────────────────────────────────────────────────────────

  const dzRow = document.createElement('div');
  dzRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin:6px 0 3px;';
  const dzLabel = createLabel('deadzone');
  dzLabel.style.minWidth = '54px';
  const dzSlider = createSlider(0, 60, helm.deadzone, 1, (v) => { helm.deadzone = v; _changed(); });
  dzSlider.style.flex = '1';
  dzRow.appendChild(dzLabel);
  dzRow.appendChild(dzSlider);
  container.appendChild(dzRow);

  // ── Value-layer conditioning sliders (shown only with an attached filter) ──
  // Built once as deadzone siblings; hidden until helm.filter is non-null.  On
  // the null->attached edge tick() reveals them and seeds from the live filter;
  // panel-owned thereafter.  Writes are guarded on the filter still existing.

  const mcRow = document.createElement('div');
  mcRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin:3px 0;';
  const mcLabel = createLabel('minCutoff');
  mcLabel.style.minWidth = '54px';
  const mcSlider = createSlider(MINCUT_MIN, MINCUT_MAX, 1, MINCUT_STEP, (v) => {
    if (helm.filter) { helm.filter.minCutoff = v; _changed(); }
  });
  mcSlider.style.flex = '1';
  mcRow.appendChild(mcLabel);
  mcRow.appendChild(mcSlider);
  container.appendChild(mcRow);

  const betaRow = document.createElement('div');
  betaRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin:3px 0;';
  const betaLabel = createLabel('beta');
  betaLabel.style.minWidth = '54px';
  const betaSlider = createSlider(BETA_MIN, BETA_MAX, 0, BETA_STEP, (v) => {
    if (helm.filter) { helm.filter.beta = v; _changed(); }
  });
  betaSlider.style.flex = '1';
  betaRow.appendChild(betaLabel);
  betaRow.appendChild(betaSlider);
  container.appendChild(betaRow);

  // Hidden until a filter attaches; tick() reconciles against helm.filter.
  setVisible(mcRow, false);
  setVisible(betaRow, false);
  let _filterShown = false;

  // ── Optional frame selector (pose-helm frame; named values only) ────────────

  if (opt.frame) {
    const frRow = document.createElement('div');
    frRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin:3px 0;';
    const frLabel = createLabel('frame');
    frLabel.style.minWidth = '54px';
    const init  = (typeof helm.from === 'string') ? helm.from : 'EYE';
    const frSel = createSelect(FRAMES, init, (v) => { helm.from = v; _changed(); });
    frSel.style.flex = '1';
    frRow.appendChild(frLabel);
    frRow.appendChild(frSel);
    container.appendChild(frRow);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  const ui = { el: container };

  Object.defineProperty(ui, 'visible', {
    get() { return _vis; },
    set(v) {
      _vis = v !== false;
      container.style.display = _vis ? 'flex' : 'none';
    },
  });

  ui.parent = (el) => mount(container, el);

  /**
   * Reconcile the conditioning sliders against helm.filter, then drive the
   * activity meters and re-sync the lane buttons from the live profile.  Call
   * once per frame.  The fill fraction is normalised per channel by
   * sens*helm.fullScale so translation and rotation read on one scale.
   */
  ui.tick = () => {
    // Reveal / hide the conditioning sliders against the live filter, seeding
    // them from it on the null->attached edge (panel-owned thereafter).
    const hasFilter = helm.filter != null;
    if (hasFilter !== _filterShown) {
      setVisible(mcRow, hasFilter);
      setVisible(betaRow, hasFilter);
      if (hasFilter) {
        mcSlider.value   = helm.filter.minCutoff;
        betaSlider.value = helm.filter.beta;
      }
      _filterShown = hasFilter;
    }

    helm.activity(_act);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], c = profile[r.ch];
      // lane button reflects the live profile (covers a sketch-side calibrate).
      const laneStr = `${c.lane}`;
      if (r.laneBtn.textContent !== laneStr) r.laneBtn.textContent = laneStr;
      r.laneBtn.disabled = c.sens === 0;
      // meter — bipolar fill normalised by helm.fullScale: activity() is post
      // sign*sens, so |activity| / (sens*fullScale) = |rawRate| / fullScale,
      // putting translation and rotation on one 0..1 scale despite differing
      // sens.  Reads the live helm field, exactly as deadzone reads helm.deadzone.
      const a   = _act[i];
      const f   = c.sens > 0 ? Math.min(Math.abs(a) / (c.sens * helm.fullScale), 1) : 0;
      const pct = f * 50;
      r.fill.style.left    = a >= 0 ? '50%' : `${50 - pct}%`;
      r.fill.style.width   = `${pct}%`;
      r.fill.style.opacity = f > 0.001 ? '1' : '0.35';
    }
  };

  ui.dispose = () => {
    container.parentNode && container.parentNode.removeChild(container);
  };

  mount(container, opt.parent);
  ui.visible = !opt.hidden;

  return ui;
}
