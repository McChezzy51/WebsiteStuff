// core.js - constants, math, Sphere model
'use strict';

// Math
export function vec(x, y) { return { x, y }; }
export function add(a, b) { return { x: a.x + b.x, y: a.y + b.y }; }
export function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y }; }
export function mul(a, s) { return { x: a.x * s, y: a.y * s }; }
export function dot(a, b) { return a.x * b.x + a.y * b.y; }
export function len2(a) { return a.x * a.x + a.y * a.y; }
export function len(a) { return Math.hypot(a.x, a.y); }
export function norm(a) { const l = len(a) || 1; return { x: a.x / l, y: a.y / l }; }
export function fromAngle(theta) { return { x: Math.cos(theta), y: Math.sin(theta) }; }
export function wrapPi(a) { if (a > Math.PI) return a - Math.PI * 2; if (a < -Math.PI) return a + Math.PI * 2; return a; }
export function angDiffAbs(a, b) { return Math.abs(wrapPi(a - b)); }
export function atan2p(y, x) { let a = Math.atan2(y, x); if (a > Math.PI) a -= Math.PI * 2; if (a < -Math.PI) a += Math.PI * 2; return a; }
export function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function smoothstep(a, b, x) { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); }

// Color helper
export function mixColorRGB(a, b, t) {
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bch = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r},${g},${bch})`;
}

// Constants
export const METERS_PER_PIXEL = 1e-9;
export const COULOMB_K = 8.9875517923e9;
export const ELEMENTARY_CHARGE = -1.602176634e-19;
export const SAME_SPHERE_SOFTENING_M = 1e-9;
export const MIN_R2_M2 = SAME_SPHERE_SOFTENING_M * SAME_SPHERE_SOFTENING_M;
export const DEFAULT_ELECTRON_COUNT = 64;

export const MOBILITY = 3e11;
export const MAX_DTH = 0.25;
export const ANGLE_JITTER = 0.0;
export const COLOR_GAMMA = 0.6;
export const PROTON_CHARGE_C = -ELEMENTARY_CHARGE;
export const PROTON_RADIUS_RATIO = 1.00;
export const CROSS_SOFTENING_M = 2e-9; // ~2 px in meters with 1e-9 m/px
export const CONTACT_RESUME_EPS_PX = 3;
export const CONTACT_SLACK_PX = 0.5;
export const PLACE_OFFSET_RAD = 0.06;
export const PLACE_JITTER_RAD = 0.04;

export function targetElectronCountForRadius(Rpx) {
  const sTarget = 8; // px between electrons
  const n = Math.round((2 * Math.PI * Rpx) / sTarget);
  return Math.max(12, Math.min(120, n));
}

// Sphere model
export class Sphere {
  constructor(cx, cy, radius, numElectrons, chargeOffsetElectrons = 0, kind = 'conductor') {
    this.center = vec(cx, cy);
    this.radius = radius;
    this.phase = Math.random() * Math.PI * 2;
    this.latticePhase = Math.random() * Math.PI * 2;
    this.kind = kind; // 'conductor' | 'insulator'
    this.chargeOffsetElectrons = (chargeOffsetElectrons | 0);
    this.staticNegRel = [];
    this.staticPosRel = [];
    this.setElectronCount(numElectrons);
    this.dragOffset = vec(0, 0);
  }
  setElectronCount(n) {
    if (this.kind === 'insulator') {
      this.angles = [];
      this.protonAngles = [];
      this.positiveChargeC = 0;
      return;
    }
    const prev = this.angles || [];
    this.angles = new Array(n);
    for (let i = 0; i < n; i++) {
      this.angles[i] = (i < prev.length
        ? prev[i]
        : (i / n) * Math.PI * 2 + this.phase + (Math.random() - 0.5) * ANGLE_JITTER);
    }
    const m = Math.max(0, (n + (this.chargeOffsetElectrons | 0)) | 0);
    this.protonAngles = new Array(m);
    for (let j = 0; j < m; j++) {
      this.protonAngles[j] = (j / Math.max(1, m)) * Math.PI * 2 + this.latticePhase;
    }
    this.positiveChargeC = PROTON_CHARGE_C * m;
  }
  electronPos(i) {
    const d = fromAngle(this.angles[i]);
    return add(this.center, mul(d, this.radius));
  }
  protonPos(j) {
    const d = fromAngle(this.protonAngles[j]);
    return add(this.center, mul(d, this.radius * PROTON_RADIUS_RATIO));
  }
  draw(ctx, suppressDipoles = false) {
    const { x, y } = this.center;
    if (this.kind === 'insulator') {
      const grad = ctx.createRadialGradient(x - this.radius * 0.35, y - this.radius * 0.35, this.radius * 0.2, x, y, this.radius);
      grad.addColorStop(0, '#24314f');
      grad.addColorStop(1, '#0c182f');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, this.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,220,120,0.25)';
      ctx.beginPath();
      ctx.arc(x, y, Math.max(6, this.radius * 0.35), 0, Math.PI * 2);
      ctx.fill();
      const negCol = 'rgba(89,166,255,0.95)';
      const posCol = 'rgba(255,106,106,0.95)';
      const eSize = Math.max(1.5, Math.min(3.0, this.radius * 0.02));
      if (this.staticPosRel.length) {
        ctx.fillStyle = posCol;
        for (const v of this.staticPosRel) {
          ctx.beginPath();
          ctx.arc(x + v.x, y + v.y, eSize, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      if (this.staticNegRel.length) {
        ctx.fillStyle = negCol;
        for (const v of this.staticNegRel) {
          ctx.beginPath();
          ctx.arc(x + v.x, y + v.y, eSize, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.strokeStyle = 'rgba(210,230,255,0.40)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, this.radius, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }
    const grad = ctx.createRadialGradient(x - this.radius * 0.35, y - this.radius * 0.35, this.radius * 0.2, x, y, this.radius);
    grad.addColorStop(0, '#1d2544');
    grad.addColorStop(1, '#0c132a');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, this.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(180,200,240,0.25)';
    ctx.lineWidth = 2;
    ctx.stroke();

    const M = Math.max(8, Math.min(32, Math.floor(this.angles.length / 4) || 8));
    const twoPi = Math.PI * 2;
    const binsNeg = new Array(M).fill(0);
    const binsPos = new Array(M).fill(0);
    for (let i = 0; i < this.angles.length; i++) {
      let th = this.angles[i];
      if (th < -Math.PI) th += twoPi; else if (th > Math.PI) th -= twoPi;
      const u = (th + Math.PI) / twoPi;
      const pos = u * M;
      let j0 = Math.floor(pos);
      const frac = pos - j0;
      j0 = ((j0 % M) + M) % M;
      const j1 = (j0 + 1) % M;
      binsNeg[j0] += 1 - frac;
      binsNeg[j1] += frac;
    }
    const m = (this.protonAngles && this.protonAngles.length) | 0;
    for (let i = 0; i < m; i++) {
      let th = this.protonAngles[i];
      if (th < -Math.PI) th += twoPi; else if (th > Math.PI) th -= twoPi;
      const u = (th + Math.PI) / twoPi;
      const pos = u * M;
      let j0 = Math.floor(pos);
      const frac = pos - j0;
      j0 = ((j0 % M) + M) % M;
      const j1 = (j0 + 1) % M;
      binsPos[j0] += 1 - frac;
      binsPos[j1] += frac;
    }
    const radius = 1;
    for (let pass = 0; pass < 1; pass++) {
      const tmpNeg = new Array(M).fill(0);
      const tmpPos = new Array(M).fill(0);
      for (let j = 0; j < M; j++) {
        let sumN = 0, wN = 0;
        let sumP = 0, wP = 0;
        for (let k = -radius; k <= radius; k++) {
          const idx = (j + k + M) % M;
          sumN += binsNeg[idx]; wN++;
          sumP += binsPos[idx]; wP++;
        }
        tmpNeg[j] = sumN / wN;
        tmpPos[j] = sumP / wP;
      }
      for (let j = 0; j < M; j++) { binsNeg[j] = tmpNeg[j]; binsPos[j] = tmpPos[j]; }
    }
    const sigma = new Array(M);
    let maxAbs = 0;
    let minAbs = Infinity;
    for (let j = 0; j < M; j++) {
      const qNeg = binsNeg[j] * ELEMENTARY_CHARGE;
      const qPos = binsPos[j] * PROTON_CHARGE_C;
      const s = qPos + qNeg;
      sigma[j] = s;
      const a = Math.abs(s);
      if (a > maxAbs) maxAbs = a;
      if (a < minAbs) minAbs = a;
    }
    if (maxAbs <= 0) maxAbs = 1;
    if (!isFinite(minAbs)) minAbs = 0;
    const rangeAbs = Math.max(1e-30, maxAbs - minAbs);
    const white = [255, 255, 255];
    const red = [255, 106, 106];
    const blue = [89, 166, 255];
    function colorForSigma(s) {
      const base = s >= 0 ? red : blue;
      const a = Math.abs(s);
      let t = (a - minAbs) / rangeAbs;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      t = Math.pow(t, COLOR_GAMMA);
      return mixColorRGB(white, base, t);
    }
    const ringThickness = Math.max(4, this.radius * 0.18);
    const rInner = Math.max(1, this.radius - ringThickness);
    if (typeof ctx.createConicGradient === 'function') {
      const cg = ctx.createConicGradient(-Math.PI, x, y);
      for (let j = 0; j <= M; j++) {
        const col = suppressDipoles ? 'rgb(255,255,255)' : colorForSigma(sigma[j % M]);
        cg.addColorStop(j / M, col);
      }
      ctx.beginPath();
      ctx.arc(x, y, this.radius, 0, Math.PI * 2);
      ctx.arc(x, y, rInner, Math.PI * 2, 0, true);
      ctx.closePath();
      ctx.fillStyle = cg;
      ctx.fill();
    } else {
      const slices = Math.max(180, M * 16);
      for (let k = 0; k < slices; k++) {
        const a0 = -Math.PI + (Math.PI * 2 * k) / slices;
        const a1 = -Math.PI + (Math.PI * 2 * (k + 1)) / slices;
        const am = (a0 + a1) * 0.5;
        const u = (am + Math.PI) / (Math.PI * 2);
        const pos = u * M;
        let j0 = Math.floor(pos);
        const frac = pos - j0;
        j0 = ((j0 % M) + M) % M;
        const j1 = (j0 + 1) % M;
        const sVal = sigma[j0] * (1 - frac) + sigma[j1] * frac;
        const color = suppressDipoles ? 'rgb(255,255,255)' : colorForSigma(sVal);
        ctx.beginPath();
        ctx.arc(x, y, this.radius, a0, a1);
        ctx.arc(x, y, rInner, a1, a0, true);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      }
    }
    ctx.strokeStyle = 'rgba(200,220,255,0.40)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, this.radius, 0, Math.PI * 2);
    ctx.stroke();
  }
}


