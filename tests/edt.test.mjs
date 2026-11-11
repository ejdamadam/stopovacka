import test from 'node:test';
import assert from 'node:assert/strict';
import { edt } from '../js/core/edt.js';

function bruteForceEdt(mask, w, h) {
  const out = new Float32Array(w * h);
  const pts = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x] !== 0) pts.push([x, y]);
    }
  }
  if (pts.length === 0) {
    out.fill(Infinity);
    return out;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let minD2 = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const dx = x - p[0];
        const dy = y - p[1];
        const d2 = dx * dx + dy * dy;
        if (d2 < minD2) minD2 = d2;
      }
      out[y * w + x] = Math.sqrt(minD2);
    }
  }
  return out;
}

test('edt: prázdná maska → všude Infinity', () => {
  const w = 15, h = 10;
  const mask = new Uint8Array(w * h);
  const dist = edt(mask, w, h);
  assert.equal(dist.length, w * h);
  for (let i = 0; i < w * h; i++) {
    assert.equal(dist[i], Infinity, `Index ${i} by měl být Infinity`);
  }
});

test('edt: jeden pixel na (0,0)', () => {
  const w = 10, h = 10;
  const mask = new Uint8Array(w * h);
  mask[0] = 1;
  const dist = edt(mask, w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const expected = Math.hypot(x, y);
      const actual = dist[y * w + x];
      assert.ok(
        Math.abs(actual - expected) < 1e-5,
        `Vzdálenost na (${x}, ${y}): očekáváno ${expected}, získáno ${actual}`
      );
    }
  }
});

test('edt: porovnání s brute-force na náhodné masce 40x30 (tolerance 1e-4)', () => {
  const w = 40, h = 30;
  const mask = new Uint8Array(w * h);
  // Pseudonáhodné naplnění (deterministický LCG pro reprodukovatelnost)
  let seed = 123456789;
  function rnd() {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  }

  for (let i = 0; i < w * h; i++) {
    if (rnd() < 0.08) mask[i] = 1;
  }

  const fast = edt(mask, w, h);
  const slow = bruteForceEdt(mask, w, h);

  let maxDiff = 0;
  for (let i = 0; i < w * h; i++) {
    const diff = Math.abs(fast[i] - slow[i]);
    if (diff > maxDiff) maxDiff = diff;
    assert.ok(
      diff < 1e-4,
      `Chyba na indexu ${i} překročila toleranci 1e-4: rychlá=${fast[i]}, brute-force=${slow[i]}, diff=${diff}`
    );
  }
  assert.ok(maxDiff < 1e-4, `Max rozdíl ${maxDiff} musí být menší než 1e-4`);
});

test('edt: porovnání s brute-force na různých náhodných maskách a rozměrech', () => {
  const cases = [
    { w: 25, h: 25, density: 0.03, seed: 111 },
    { w: 50, h: 20, density: 0.15, seed: 222 },
    { w: 15, h: 45, density: 0.25, seed: 333 },
  ];

  for (const c of cases) {
    const mask = new Uint8Array(c.w * c.h);
    let s = c.seed;
    const rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let i = 0; i < c.w * c.h; i++) {
      if (rnd() < c.density) mask[i] = 1;
    }

    const fast = edt(mask, c.w, c.h);
    const slow = bruteForceEdt(mask, c.w, c.h);

    for (let i = 0; i < c.w * c.h; i++) {
      const diff = Math.abs(fast[i] - slow[i]);
      assert.ok(
        diff < 1e-4,
        `Případ ${c.w}x${c.h}: chyba na indexu ${i} (${diff}) překročila 1e-4`
      );
    }
  }
});
