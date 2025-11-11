'use strict';
import {
  METERS_PER_PIXEL, COULOMB_K, ELEMENTARY_CHARGE, MIN_R2_M2,
  DEFAULT_ELECTRON_COUNT, PROTON_CHARGE_C, CROSS_SOFTENING_M,
  CONTACT_RESUME_EPS_PX, CONTACT_SLACK_PX, MAX_DTH, MOBILITY,
  add, sub, len, fromAngle, mul, targetElectronCountForRadius
} from './core.js';

export function step(world, dt) {
  const spheres = world.spheres;

  // Global guard: if every sphere is net-neutral, freeze all charge motion
  if (spheres.length > 0) {
    let allNeutral = true;
    for (const s of spheres) {
      if (s.kind === 'conductor') {
        if ((s.chargeOffsetElectrons | 0) !== 0) { allNeutral = false; break; }
      } else {
        const nPos = (s.staticPosRel && s.staticPosRel.length) ? s.staticPosRel.length : 0;
        const nNeg = (s.staticNegRel && s.staticNegRel.length) ? s.staticNegRel.length : 0;
        if ((nPos - nNeg) !== 0) { allNeutral = false; break; }
      }
    }
    if (allNeutral) return;
  }

  // Conduction: for each connected cluster of touching conductors, redistribute net charge ∝ radius
  const touchingNow = new Set();
  let anyTouching = false;
  let anyNewContact = false;
  let minGapPx = Infinity;
  for (let i = 0; i < spheres.length; i++) {
    const si = spheres[i];
    if (si.kind !== 'conductor') continue;
    for (let j = i + 1; j < spheres.length; j++) {
      const sj = spheres[j];
      if (sj.kind !== 'conductor') continue;
      const d = len(sub(si.center, sj.center));
      const gapPx = d - (si.radius + sj.radius);
      if (gapPx < minGapPx) minGapPx = gapPx;
      if (gapPx <= CONTACT_SLACK_PX) {
        anyTouching = true;
        const key = i + '|' + j;
        touchingNow.add(key);
        if (!world.prevTouchingPairs.has(key)) anyNewContact = true;
      }
    }
  }
  if (anyNewContact) {
    const adj = new Map();
    function addEdge(a, b) {
      if (!adj.has(a)) adj.set(a, new Set());
      if (!adj.has(b)) adj.set(b, new Set());
      adj.get(a).add(b);
      adj.get(b).add(a);
    }
    for (const key of touchingNow) {
      const [as, bs] = key.split('|');
      const a = (as | 0), b = (bs | 0);
      addEdge(a, b);
    }
    const visited = new Set();
    for (const start of adj.keys()) {
      if (visited.has(start)) continue;
      const componentIndices = [];
      const stack = [start];
      visited.add(start);
      while (stack.length) {
        const u = stack.pop();
        componentIndices.push(u);
        for (const v of adj.get(u)) {
          if (!visited.has(v)) { visited.add(v); stack.push(v); }
        }
      }
      let sumOffset = 0;
      let sumRadius = 0;
      for (const idx of componentIndices) {
        const s = spheres[idx];
        sumOffset += (s.chargeOffsetElectrons | 0);
        sumRadius += Math.max(1e-9, s.radius);
      }
      if (sumRadius <= 0) continue;
      const allocation = componentIndices.map(idx => {
        const s = spheres[idx];
        const target = sumOffset * (s.radius / sumRadius);
        const base = Math.floor(target);
        return { idx, target, base, frac: target - base };
      });
      let remainder = sumOffset - allocation.reduce((acc, v) => acc + v.base, 0);
      if (remainder > 0) {
        allocation.sort((a, b) => b.frac - a.frac);
        for (let k = 0; k < remainder; k++) allocation[k % allocation.length].base++;
      } else if (remainder < 0) {
        allocation.sort((a, b) => a.frac - b.frac);
        for (let k = 0; k < -remainder; k++) allocation[k % allocation.length].base--;
      }
      for (const a of allocation) {
        const s = spheres[a.idx];
        s.angles = [];
        s.chargeOffsetElectrons = a.base;
        s.phase = Math.random() * Math.PI * 2;
        s.latticePhase = Math.random() * Math.PI * 2;
        s.setElectronCount(targetElectronCountForRadius(s.radius));
      }
    }
    world.contactPaused = true;
  }
  if (world.contactPaused) {
    if (!anyTouching && minGapPx !== Infinity && minGapPx >= CONTACT_RESUME_EPS_PX) {
      world.contactPaused = false;
    } else if (!anyTouching) {
      world.contactPaused = false;
    } else if (minGapPx >= CONTACT_RESUME_EPS_PX) {
      world.contactPaused = false;
    } else {
      world.prevTouchingPairs.clear();
      for (const k of touchingNow) world.prevTouchingPairs.add(k);
      return;
    }
  }
  world.prevTouchingPairs.clear();
  for (const k of touchingNow) world.prevTouchingPairs.add(k);

  const allElectrons = [];
  for (const s of spheres) {
    for (let i = 0; i < s.angles.length; i++) {
      allElectrons.push({ sphere: s, i, pos: s.electronPos(i) });
    }
  }
  const allProtons = [];
  for (const s of spheres) {
    if (s.kind !== 'conductor') continue;
    const m = (s.protonAngles && s.protonAngles.length) | 0;
    for (let j = 0; j < m; j++) {
      allProtons.push({ sphere: s, pos: s.protonPos(j) });
    }
  }
  const allStaticPos = [];
  const allStaticNeg = [];
  for (const s of spheres) {
    if (s.staticPosRel && s.staticPosRel.length) {
      for (const v of s.staticPosRel) allStaticPos.push({ sphere: s, pos: add(s.center, v) });
    }
    if (s.staticNegRel && s.staticNegRel.length) {
      for (const v of s.staticNegRel) allStaticNeg.push({ sphere: s, pos: add(s.center, v) });
    }
  }

  // Grounding clamp: set Vavg(surface) ≈ 0 by adjusting net offset for grounded conductors
  function potentialAtPoint(pt) {
    let V = 0;
    // electrons
    for (const e of allElectrons) {
      const rpx = sub(pt, e.pos);
      const Rm = METERS_PER_PIXEL * Math.hypot(rpx.x, rpx.y);
      V += COULOMB_K * ELEMENTARY_CHARGE / Math.max(Rm, Math.sqrt(MIN_R2_M2));
    }
    // protons (uniform positive lattice on conductors)
    for (const pr of allProtons) {
      const rpx = sub(pt, pr.pos);
      const Rm = METERS_PER_PIXEL * Math.hypot(rpx.x, rpx.y);
      V += COULOMB_K * PROTON_CHARGE_C / Math.max(Rm, Math.sqrt(MIN_R2_M2));
    }
    // static painted charges
    for (const sp of allStaticPos) {
      const rpx = sub(pt, sp.pos);
      const Rm = METERS_PER_PIXEL * Math.hypot(rpx.x, rpx.y);
      V += COULOMB_K * PROTON_CHARGE_C / Math.max(Rm, Math.sqrt(MIN_R2_M2));
    }
    for (const sn of allStaticNeg) {
      const rpx = sub(pt, sn.pos);
      const Rm = METERS_PER_PIXEL * Math.hypot(rpx.x, rpx.y);
      V += COULOMB_K * ELEMENTARY_CHARGE / Math.max(Rm, Math.sqrt(MIN_R2_M2));
    }
    return V;
  }
  for (const s of spheres) {
    if (s.kind !== 'conductor' || !s.grounded) continue;
    const Mpot = 48;
    let Vsum = 0;
    for (let k = 0; k < Mpot; k++) {
      const th = -Math.PI + (2 * Math.PI * k) / Mpot;
      const pt = add(s.center, mul(fromAngle(th), s.radius));
      Vsum += potentialAtPoint(pt);
    }
    const Vavg = Vsum / Mpot;
    const Rm = s.radius * METERS_PER_PIXEL;
    const alpha = COULOMB_K * PROTON_CHARGE_C / Math.max(Rm, 1e-30); // k*q/R
    const current = (s.chargeOffsetElectrons | 0);
    const deltaFloat = -(Vavg / alpha);
    let deltaInt = 0;
    if (deltaFloat > 0.6) deltaInt = 1;
    else if (deltaFloat < -0.6) deltaInt = -1;
    if (deltaInt !== 0) {
      const next = current + deltaInt;
      const clamped = Math.max(-DEFAULT_ELECTRON_COUNT, Math.min(DEFAULT_ELECTRON_COUNT, next));
      if (clamped !== current) {
        s.chargeOffsetElectrons = clamped;
        s.setElectronCount(targetElectronCountForRadius(s.radius));
      }
    }
  }

  for (const s of spheres) {
    const n = s.angles.length;
    for (let i = 0; i < n; i++) {
      const theta = s.angles[i];
      const p = s.electronPos(i);
      let Ex = 0, Ey = 0;
      function isNeutralConductorPair(a, b) {
        return a && b
          && a.kind === 'conductor' && b.kind === 'conductor'
          && ((a.chargeOffsetElectrons | 0) === 0)
          && ((b.chargeOffsetElectrons | 0) === 0);
      }
      const nOn = Math.max(3, n);
      const sPx = Math.max(1, 2 * s.radius * Math.sin(Math.PI / nOn));
      const epsSameM = Math.max(METERS_PER_PIXEL, 0.6 * sPx * METERS_PER_PIXEL);

      for (const pr of allProtons) {
        const rpx = sub(p, pr.pos);
        const rx = rpx.x * METERS_PER_PIXEL;
        const ry = rpx.y * METERS_PER_PIXEL;
        const cross = (pr.sphere !== s);
        if (!cross) continue;
        if (isNeutralConductorPair(s, pr.sphere)) continue;
        let r2m = rx * rx + ry * ry + (cross ? (CROSS_SOFTENING_M * CROSS_SOFTENING_M) : 0);
        if (!cross && r2m < MIN_R2_M2) r2m = MIN_R2_M2;
        const invr = 1 / Math.sqrt(r2m);
        const invr3 = invr / r2m;
        const scale = COULOMB_K * PROTON_CHARGE_C * invr3;
        Ex += scale * rx; Ey += scale * ry;
      }
      for (const sp of allStaticPos) {
        const rpx = sub(p, sp.pos);
        const rx = rpx.x * METERS_PER_PIXEL;
        const ry = rpx.y * METERS_PER_PIXEL;
        const cross = (sp.sphere !== s);
        if (cross && isNeutralConductorPair(s, sp.sphere)) continue;
        let r2m = rx * rx + ry * ry + (cross ? (CROSS_SOFTENING_M * CROSS_SOFTENING_M) : 0);
        if (!cross && r2m < MIN_R2_M2) r2m = MIN_R2_M2;
        const invr = 1 / Math.sqrt(r2m);
        const invr3 = invr / r2m;
        const scale = COULOMB_K * PROTON_CHARGE_C * invr3;
        Ex += scale * rx; Ey += scale * ry;
      }
      for (const sn of allStaticNeg) {
        const rpx = sub(p, sn.pos);
        const rx = rpx.x * METERS_PER_PIXEL;
        const ry = rpx.y * METERS_PER_PIXEL;
        const cross = (sn.sphere !== s);
        if (cross && isNeutralConductorPair(s, sn.sphere)) continue;
        let r2m = rx * rx + ry * ry + (cross ? (CROSS_SOFTENING_M * CROSS_SOFTENING_M) : 0);
        if (!cross && r2m < MIN_R2_M2) r2m = MIN_R2_M2;
        const invr = 1 / Math.sqrt(r2m);
        const invr3 = invr / r2m;
        const scale = COULOMB_K * ELEMENTARY_CHARGE * invr3;
        Ex += scale * rx; Ey += scale * ry;
      }
      for (const e of allElectrons) {
        if (e.sphere === s && e.i === i) continue;
        const rpx = sub(p, e.pos);
        const rx = rpx.x * METERS_PER_PIXEL;
        const ry = rpx.y * METERS_PER_PIXEL;
        const cross = (e.sphere !== s);
        if (cross && isNeutralConductorPair(s, e.sphere)) continue;
        let r2m = rx * rx + ry * ry + (cross ? (CROSS_SOFTENING_M * CROSS_SOFTENING_M) : (epsSameM * epsSameM));
        if (cross && r2m < MIN_R2_M2) r2m = MIN_R2_M2;
        const invr = 1 / Math.sqrt(r2m);
        const invr3 = invr / r2m;
        const scale = COULOMB_K * ELEMENTARY_CHARGE * invr3;
        Ex += scale * rx; Ey += scale * ry;
      }
      const tx = -Math.sin(theta), ty = Math.cos(theta);
      const Et = Ex * tx + Ey * ty;
      let dtheta = MOBILITY * (ELEMENTARY_CHARGE * Et) * dt;
      if (dtheta > MAX_DTH) dtheta = MAX_DTH; else if (dtheta < -MAX_DTH) dtheta = -MAX_DTH;
      let th = theta + dtheta;
      if (th > Math.PI) th -= Math.PI * 2; else if (th < -Math.PI) th += Math.PI * 2;
      s.angles[i] = th;
    }
  }
}
