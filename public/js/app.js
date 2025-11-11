'use strict';
import {
  vec, add, sub, mul, len, norm, fromAngle,
  Sphere, DEFAULT_ELECTRON_COUNT, targetElectronCountForRadius
} from './core.js';
import { step as physicsStep } from './physics.js';

// Canvas setup with HiDPI support
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
function resizeCanvas() {
  const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const width = Math.floor(window.innerWidth);
  const height = Math.floor(window.innerHeight);
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

// UI controls
const pauseCheckbox = document.getElementById('pause');
// Mode radios
const modeDrag = document.getElementById('modeDrag');
const modePaintPos = document.getElementById('modePaintPos');
const modePaintNeg = document.getElementById('modePaintNeg');
const modeDelete = document.getElementById('modeDelete');
// Add buttons
const btnAddConductor = document.getElementById('btnAddConductor');
const btnAddInsulator = document.getElementById('btnAddInsulator');
const btnClearAll = document.getElementById('btnClearAll');
let mode = 'drag'; // 'drag' | 'paintPos' | 'paintNeg'
function updateMode() {
  mode = (modeDelete && modeDelete.checked) ? 'delete'
    : (modePaintPos.checked ? 'paintPos'
    : (modePaintNeg.checked ? 'paintNeg' : 'drag'));
}
modeDrag.addEventListener('change', updateMode);
modePaintPos.addEventListener('change', updateMode);
modePaintNeg.addEventListener('change', updateMode);
if (modeDelete) modeDelete.addEventListener('change', updateMode);
if (btnClearAll) {
  btnClearAll.addEventListener('click', () => {
    clearAllSpheres();
  });
}
// Add-mode ephemeral state
let pendingAdd = null; // 'conductor' | 'insulator' | null
let addDraft = null; // { type, id, center: {x,y}, radius }
const MIN_RADIUS_PX = 24;
btnAddConductor.addEventListener('click', () => { pendingAdd = 'conductor'; canvas.classList.add('adding'); });
btnAddInsulator.addEventListener('click', () => { pendingAdd = 'insulator'; canvas.classList.add('adding'); });
// On-canvas steppers (dynamic per-conductor)
const stepperContainer = document.getElementById('steppers');
const stepper0 = document.getElementById('stepper0'); // legacy (hide)
const stepper1 = document.getElementById('stepper1'); // legacy (hide)
if (stepper0) stepper0.style.display = 'none';
if (stepper1) stepper1.style.display = 'none';
const dynamicSteppers = new Map(); // index -> { el, valEl }
function removeAllSteppers() {
  for (const rec of dynamicSteppers.values()) {
    if (rec && rec.el && rec.el.parentNode) {
      rec.el.parentNode.removeChild(rec.el);
    }
  }
  dynamicSteppers.clear();
}
function clearAllSpheres() {
  world.spheres = [];
  world.contactPaused = false;
  world.prevTouchingPairs.clear();
  removeAllSteppers();
  updateStepperValues();
  positionSteppers();
}
function deleteSphereByIndex(index) {
  if (index < 0 || index >= world.spheres.length) return;
  world.spheres.splice(index, 1);
  removeAllSteppers();
  updateStepperValues();
  positionSteppers();
}

// Basic vector helpers imported from core.js

// View transform (world -> screen) computed per frame to keep simulation invariant on resize
let viewScale = 1;
let viewOffsetX = 0;
let viewOffsetY = 0;
const VIEW_PAD = 16;
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
// Keep surface density ~constant: helper imported from core.js
function computeView() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!world.spheres.length) {
    viewScale = 1; viewOffsetX = 0; viewOffsetY = 0; return;
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of world.spheres) {
    minX = Math.min(minX, s.center.x - s.radius);
    minY = Math.min(minY, s.center.y - s.radius);
    maxX = Math.max(maxX, s.center.x + s.radius);
    maxY = Math.max(maxY, s.center.y + s.radius);
  }
  const bbW = Math.max(1, maxX - minX);
  const bbH = Math.max(1, maxY - minY);
  // Only scale down when needed; never scale up or recenter unnecessarily
  const scaleX = (w - VIEW_PAD * 2) / bbW;
  const scaleY = (h - VIEW_PAD * 2) / bbH;
  const fitScale = Math.min(scaleX, scaleY);
  if (!isFinite(viewScale) || viewScale <= 0) viewScale = 1;
  if (fitScale < viewScale) {
    viewScale = Math.max(1e-6, Math.min(1, fitScale));
  }
  // Clamp offsets so the bounding box stays within padded screen, but don't recenter
  const minOffX = VIEW_PAD - minX * viewScale;
  const maxOffX = (w - VIEW_PAD) - maxX * viewScale;
  const minOffY = VIEW_PAD - minY * viewScale;
  const maxOffY = (h - VIEW_PAD) - maxY * viewScale;
  // Ensure minOff <= maxOff; if not, they cross due to rounding; swap or average
  const loX = Math.min(minOffX, maxOffX), hiX = Math.max(minOffX, maxOffX);
  const loY = Math.min(minOffY, maxOffY), hiY = Math.max(minOffY, maxOffY);
  if (!isFinite(viewOffsetX)) viewOffsetX = loX;
  if (!isFinite(viewOffsetY)) viewOffsetY = loY;
  viewOffsetX = clamp(viewOffsetX, loX, hiX);
  viewOffsetY = clamp(viewOffsetY, loY, hiY);
}
function worldToScreen(x, y) {
  return { x: viewOffsetX + x * viewScale, y: viewOffsetY + y * viewScale };
}

// Color helpers come from core.js (used inside Sphere.draw)

// Physical constants and Sphere are imported from core.js

// Sphere is imported from core.js

// World setup
const world = {
  spheres: [],
  contactPaused: false,
  prevTouchingPairs: new Set() // keys like "i|j"
};
function initWorld() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  // Start empty; user creates spheres via Add buttons
  world.spheres = [];
  updateStepperValues();
  positionSteppers();
}
initWorld();

// (Removed electron count slider)

// Pointer interactions (drag spheres)
let dragging = null; // { sphere, id }
let painting = null; // { id, lastMs }
const PAINT_INTERVAL_MS = 60;
function paintDeltaSign() { return mode === 'paintPos' ? +1 : (mode === 'paintNeg' ? -1 : 0); }
function applyPaintAtPoint(p, delta) {
  if (!delta) return;
  const s = pickSphere(p);
  if (!s) return;
  const idx = world.spheres.indexOf(s);
  if (idx < 0) return;
  if (s.kind === 'insulator') {
    let rel = sub(p, s.center);
    const L = len(rel);
    if (L > s.radius - 1) rel = mul(norm(rel), s.radius - 1);
    if (delta > 0) s.staticPosRel.push(rel); else s.staticNegRel.push(rel);
    // Reinitialize to keep rendering/fields consistent (does not move painted charges)
    s.setElectronCount(0);
    updateStepperValues();
  } else {
    if (s.grounded) return; // ignore painting when grounded
    reinitSphereWithOffset(idx, (s.chargeOffsetElectrons | 0) + delta);
  }
}
function getEventPos(e) {
  const rect = canvas.getBoundingClientRect();
  const cssX = (e.clientX - rect.left);
  const cssY = (e.clientY - rect.top);
  // invert view transform (ignore device ratio; events are in CSS px)
  const wx = (cssX - viewOffsetX) / Math.max(1e-9, viewScale);
  const wy = (cssY - viewOffsetY) / Math.max(1e-9, viewScale);
  return vec(wx, wy);
}
function pickSphere(p) {
  for (let i = world.spheres.length - 1; i >= 0; i--) {
    const s = world.spheres[i];
    if (len(sub(p, s.center)) <= s.radius) return s;
  }
  return null;
}
canvas.addEventListener('pointerdown', (e) => {
  const p = getEventPos(e);
  if (pendingAdd) {
    // begin creation
    addDraft = { type: pendingAdd, id: e.pointerId, center: p, radius: MIN_RADIUS_PX };
    canvas.setPointerCapture(e.pointerId);
  } else if (mode === 'delete') {
    const s = pickSphere(p);
    if (s) {
      const idx = world.spheres.indexOf(s);
      deleteSphereByIndex(idx);
    }
  } else if (mode === 'drag') {
    const s = pickSphere(p);
    if (s) {
      dragging = { sphere: s, id: e.pointerId };
      s.dragOffset = sub(s.center, p);
      canvas.setPointerCapture(e.pointerId);
      canvas.classList.add('dragging');
    }
  } else {
    // painting
    painting = { id: e.pointerId, lastMs: 0 };
    canvas.setPointerCapture(e.pointerId);
    applyPaintAtPoint(p, paintDeltaSign());
  }
});
canvas.addEventListener('pointermove', (e) => {
  const p = getEventPos(e);
  if (addDraft && addDraft.id === e.pointerId) {
    const r = Math.max(MIN_RADIUS_PX, len(sub(p, addDraft.center)));
    addDraft.radius = r;
    return;
  }
  if (dragging && dragging.id === e.pointerId) {
    dragging.sphere.center = add(p, dragging.sphere.dragOffset);
    return;
  }
  if (painting && painting.id === e.pointerId) {
    const now = performance.now();
    if (now - painting.lastMs >= PAINT_INTERVAL_MS) {
      painting.lastMs = now;
      applyPaintAtPoint(p, paintDeltaSign());
    }
  }
});
function endDrag(e) {
  if (addDraft && (!e || addDraft.id === e.pointerId)) {
    // finalize creation
    const d = addDraft;
    const kind = d.type;
    const r = Math.max(MIN_RADIUS_PX, d.radius);
    if (kind === 'conductor') {
      const n = targetElectronCountForRadius(r);
      const s = new Sphere(d.center.x, d.center.y, r, n, 0, 'conductor');
      s.grounded = false;
      world.spheres.push(s);
    } else {
      const s = new Sphere(d.center.x, d.center.y, r, 0, 0, 'insulator');
      s.grounded = false;
      world.spheres.push(s);
    }
    pendingAdd = null;
    addDraft = null;
    canvas.classList.remove('adding');
    updateStepperValues();
    positionSteppers();
    if (e) canvas.releasePointerCapture(e.pointerId);
  }
  if (dragging && (!e || dragging.id === e.pointerId)) {
    canvas.releasePointerCapture(dragging.id);
    dragging = null;
    canvas.classList.remove('dragging');
  }
  if (painting && (!e || painting.id === e.pointerId)) {
    canvas.releasePointerCapture(painting.id);
    painting = null;
  }
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);


// Rendering
function draw() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);

  // Background vignette (screen space)
  const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const g = ctx.createRadialGradient(w * 0.5, h * 0.5, Math.min(w, h) * 0.1, w * 0.5, h * 0.5, Math.max(w, h) * 0.8);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(1, '#f8fafc');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // Compute view to fit world into screen without altering simulation state
  computeView();
  // Apply view transform for world rendering
  ctx.setTransform(ratio * viewScale, 0, 0, ratio * viewScale, ratio * viewOffsetX, ratio * viewOffsetY);

  // (Removed center-connecting line)

  // Determine if ALL spheres are neutral ⇒ suppress dipole coloration (render ring white)
  let allNeutral = world.spheres.length > 0;
  for (const s of world.spheres) {
    if (s.kind === 'conductor') {
      if ((s.chargeOffsetElectrons | 0) !== 0) { allNeutral = false; break; }
    } else {
      const nPos = (s.staticPosRel && s.staticPosRel.length) ? s.staticPosRel.length : 0;
      const nNeg = (s.staticNegRel && s.staticNegRel.length) ? s.staticNegRel.length : 0;
      if ((nPos - nNeg) !== 0) { allNeutral = false; break; }
    }
  }
  for (const s of world.spheres) s.draw(ctx, allNeutral);
  // Creation preview
  if (addDraft) {
    const c = addDraft.center;
    const r = Math.max(MIN_RADIUS_PX, addDraft.radius);
    ctx.save();
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = addDraft.type === 'conductor' ? 'rgba(220,240,255,0.85)' : 'rgba(255,220,140,0.85)';
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  positionSteppers();
  updateStepperValues();
}

// Animation loop
let last = performance.now();
function frame(now) {
  const dtMs = Math.min(32, now - last);
  last = now;
  if (!pauseCheckbox.checked) physicsStep(world, dtMs / 1000);
  draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Re-center spheres on resize to keep them visible
window.addEventListener('resize', () => {
  // Do not alter simulation state on resize; only UI overlays need repositioning
  positionSteppers();
});

// Prevent context menu during dragging
window.addEventListener('contextmenu', (e) => {
  if (dragging) e.preventDefault();
});

// Stepper logic
function clampOffset(offset) {
  const n = DEFAULT_ELECTRON_COUNT;
  if (offset < -n) return -n;
  if (offset > n) return n;
  return offset | 0;
}
function reinitSphereWithOffset(index, newOffset) {
  const s = world.spheres[index];
  const clamped = clampOffset(newOffset);
  s.chargeOffsetElectrons = clamped;
  s.angles = [];
  s.phase = Math.random() * Math.PI * 2;
  s.latticePhase = Math.random() * Math.PI * 2;
  s.setElectronCount(targetElectronCountForRadius(s.radius));
  updateStepperValues();
}
function ensureStepperFor(index) {
  if (dynamicSteppers.has(index)) return dynamicSteppers.get(index);
  const s = world.spheres[index];
  if (!s || s.kind !== 'conductor') return null;
  const el = document.createElement('div');
  el.className = 'stepper';
  const btnNeg = document.createElement('button');
  btnNeg.className = 'btn neg';
  btnNeg.textContent = '−';
  const valEl = document.createElement('div');
  valEl.className = 'val';
  valEl.textContent = String((s.chargeOffsetElectrons | 0));
  const btnPos = document.createElement('button');
  btnPos.className = 'btn pos';
  btnPos.textContent = '+';
  const btnGnd = document.createElement('button');
  btnGnd.className = 'btn gnd';
  btnGnd.textContent = 'Ground';
  el.appendChild(btnNeg);
  el.appendChild(valEl);
  el.appendChild(btnPos);
  el.appendChild(btnGnd);
  el.style.position = 'absolute';
  el.style.pointerEvents = 'auto';
  stepperContainer.appendChild(el);
  btnNeg.addEventListener('click', (ev) => {
    ev.stopPropagation();
    reinitSphereWithOffset(index, (world.spheres[index].chargeOffsetElectrons | 0) - 1);
  });
  btnPos.addEventListener('click', (ev) => {
    ev.stopPropagation();
    reinitSphereWithOffset(index, (world.spheres[index].chargeOffsetElectrons | 0) + 1);
  });
  btnGnd.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const sph = world.spheres[index];
    sph.grounded = !sph.grounded;
  });
  const rec = { el, valEl, btnNeg, btnPos, btnGnd };
  dynamicSteppers.set(index, rec);
  return rec;
}
function updateStepperValues() {
  // Ensure steppers exist for all conductors; update their values
  for (let i = 0; i < world.spheres.length; i++) {
    const s = world.spheres[i];
    const rec = dynamicSteppers.get(i);
    if (s && s.kind === 'conductor') {
      const step = ensureStepperFor(i);
      if (step) {
        step.valEl.textContent = String((s.chargeOffsetElectrons | 0));
        step.el.style.display = '';
        const grounded = !!s.grounded;
        step.btnNeg.disabled = grounded;
        step.btnPos.disabled = grounded;
        step.btnGnd.classList.toggle('active', grounded);
      }
    } else if (rec) {
      rec.el.style.display = 'none';
    }
  }
}
function positionSteppers() {
  for (let i = 0; i < world.spheres.length; i++) {
    const s = world.spheres[i];
    const rec = dynamicSteppers.get(i);
    if (!rec || !s || s.kind !== 'conductor') continue;
    const stepper = rec.el;
    const rect = stepper.getBoundingClientRect();
    const w = rect.width || 80, h = rect.height || 28;
    const scr = worldToScreen(s.center.x, s.center.y);
    let x = scr.x - w / 2;
    let y = scr.y - s.radius * viewScale - h - 8; // above sphere in screen space
    if (y < 8) y = scr.y + s.radius * viewScale + 8; // place below if too high
    if (x < 8) x = 8; else if (x + w > window.innerWidth - 8) x = window.innerWidth - 8 - w;
    stepper.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }
}


