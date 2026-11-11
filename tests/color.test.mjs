import test from 'node:test';
import assert from 'node:assert/strict';
import {
  srgbToLab,
  labChroma,
  deltaE,
  estimateWhite,
  whiteBalance,
  sampleInk,
  classifyInks,
  cleanMask,
  maskFromLabels,
} from '../js/core/color.js';

test('srgbToLab: převod bílé, červené a černé', () => {
  const white = srgbToLab(255, 255, 255);
  assert.ok(Math.abs(white[0] - 100) < 0.01, `L bílé by mělo být ~100, je ${white[0]}`);
  assert.ok(Math.abs(white[1] - 0) < 0.01, `a bílé by mělo být ~0, je ${white[1]}`);
  assert.ok(Math.abs(white[2] - 0) < 0.01, `b bílé by mělo být ~0, je ${white[2]}`);

  const red = srgbToLab(255, 0, 0);
  assert.ok(Math.abs(red[0] - 53.2) < 0.2, `L červené by mělo být ~53.2, je ${red[0]}`);
  assert.ok(Math.abs(red[1] - 80.1) < 0.2, `a červené by mělo být ~80.1, je ${red[1]}`);
  assert.ok(Math.abs(red[2] - 67.2) < 0.2, `b červené by mělo být ~67.2, je ${red[2]}`);

  const black = srgbToLab(0, 0, 0);
  assert.ok(Math.abs(black[0] - 0) < 0.01, `L černé by mělo být ~0, je ${black[0]}`);
  assert.ok(Math.abs(black[1] - 0) < 0.01, `a černé by mělo být ~0, je ${black[1]}`);
  assert.ok(Math.abs(black[2] - 0) < 0.01, `b černé by mělo být ~0, je ${black[2]}`);
});

test('labChroma a deltaE', () => {
  const red = srgbToLab(255, 0, 0);
  const chroma = labChroma(red);
  assert.ok(Math.abs(chroma - Math.hypot(red[1], red[2])) < 1e-6);

  const white = srgbToLab(255, 255, 255);
  assert.equal(deltaE(white, white), 0);
  const dRedWhite = deltaE(red, white);
  assert.ok(dRedWhite > 100, `Vzdálenost červená-bílá by měla být velká, je ${dRedWhite}`);
});

test('estimateWhite a whiteBalance', () => {
  const W = 30, H = 30;
  const data = new Uint8ClampedArray(W * H * 4);
  // Většina obrázku tmavá/střední, ~15 % pixelů papír bílý (240, 238, 236)
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    if (i < 150) {
      data[o] = 240; data[o + 1] = 238; data[o + 2] = 236; data[o + 3] = 255;
    } else {
      data[o] = 100; data[o + 1] = 100; data[o + 2] = 100; data[o + 3] = 255;
    }
  }
  const img = { width: W, height: H, data };
  const white = estimateWhite(img);
  assert.equal(white.r, 240);
  assert.equal(white.g, 238);
  assert.equal(white.b, 236);

  const balanced = whiteBalance(img, white);
  // Pixely papíru by měly být přeškálované na (245, 245, 245)
  assert.equal(balanced.data[0], 245);
  assert.equal(balanced.data[1], 245);
  assert.equal(balanced.data[2], 245);
});

test('sampleInk: vzorkování kalibračního pole', () => {
  const W = 20, H = 20;
  const data = new Uint8ClampedArray(W * H * 4);
  // Vyplníme papírem (245, 245, 245)
  for (let i = 0; i < W * H * 4; i += 4) {
    data[i] = 245; data[i + 1] = 245; data[i + 2] = 245; data[i + 3] = 255;
  }
  const img = { width: W, height: H, data };

  // 1) Méně než 20 pixelů inkoustu → null
  for (let i = 0; i < 15; i++) {
    const o = i * 4;
    data[o] = 255; data[o + 1] = 0; data[o + 2] = 0;
  }
  const resNull = sampleInk(img, { x: 0, y: 0, w: 20, h: 20 });
  assert.equal(resNull, null);

  // 2) Přidáme dalších 15 pixelů (celkem 30 pixelů červené) → vrátí vzorek
  for (let i = 15; i < 30; i++) {
    const o = i * 4;
    data[o] = 255; data[o + 1] = 0; data[o + 2] = 0;
  }
  const res = sampleInk(img, { x: 0, y: 0, w: 20, h: 20 });
  assert.ok(res !== null);
  assert.equal(res.n, 30);
  assert.equal(res.rgb[0], 255);
  assert.equal(res.rgb[1], 0);
  assert.equal(res.rgb[2], 0);
  const expectedLab = srgbToLab(255, 0, 0);
  assert.ok(Math.abs(res.lab[0] - expectedLab[0]) < 1);
  assert.ok(Math.abs(res.lab[1] - expectedLab[1]) < 1);
  assert.ok(Math.abs(res.lab[2] - expectedLab[2]) < 1);
});

test('classifyInks na syntetickém obrázku (šedý gradient + červená a modrá čára)', () => {
  const W = 60, H = 40;
  const data = new Uint8ClampedArray(W * H * 4);

  // Pozadí: šedý gradient zleva doprava (hodnoty 40 až 220)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;
      const gray = Math.round(40 + (x / W) * 180);
      data[idx] = gray;
      data[idx + 1] = gray;
      data[idx + 2] = gray;
      data[idx + 3] = 255;
    }
  }

  // Červená čára: řádek y = 10, x = 5..54
  for (let x = 5; x < 55; x++) {
    const idx = (10 * W + x) * 4;
    data[idx] = 220;
    data[idx + 1] = 20;
    data[idx + 2] = 20;
  }

  // Modrá čára: řádek y = 25, x = 5..54
  for (let x = 5; x < 55; x++) {
    const idx = (25 * W + x) * 4;
    data[idx] = 20;
    data[idx + 1] = 40;
    data[idx + 2] = 220;
  }

  const img = { width: W, height: H, data };
  const redLab = srgbToLab(220, 20, 20);
  const blueLab = srgbToLab(20, 40, 220);
  const inks = [{ lab: redLab }, { lab: blueLab }];

  const labels = classifyInks(img, { x: 0, y: 0, w: W, h: H }, inks);

  // Ověření červené čáry (štítek 1)
  for (let x = 5; x < 55; x++) {
    assert.equal(labels[10 * W + x], 1, `Pixel (${x}, 10) by měl mít štítek 1 (červená)`);
  }

  // Ověření modré čáry (štítek 2)
  for (let x = 5; x < 55; x++) {
    assert.equal(labels[25 * W + x], 2, `Pixel (${x}, 25) by měl mít štítek 2 (modrá)`);
  }

  // Ověření, že šedý gradient je ignorován (štítek 0)
  for (let y = 0; y < H; y++) {
    if (y === 10 || y === 25) continue;
    for (let x = 0; x < W; x++) {
      assert.equal(labels[y * W + x], 0, `Pixel (${x}, ${y}) v šedém gradientu by měl mít štítek 0`);
    }
  }

  // Test maskFromLabels
  const redMask = maskFromLabels(labels, 1);
  assert.equal(redMask[10 * W + 10], 1);
  assert.equal(redMask[25 * W + 10], 0);
  assert.equal(redMask[0], 0);
});

test('cleanMask: odstraní izolované tečky a spojí 1px mezeru', () => {
  const W = 30, H = 30;
  const mask = new Uint8Array(W * H);

  // Izolované tečky:
  mask[4 * W + 4] = 1; // 1px tečka
  mask[4 * W + 15] = 1; mask[4 * W + 16] = 1; mask[5 * W + 15] = 1; // 3px tečka

  // Čára délky 15 px s 1px mezerou uprostřed na řádku y = 15:
  // x = 5..11 (7 px), mezera na x = 12, x = 13..19 (7 px) -> celkem 14 px linie + 1 px mezera = 15 px
  for (let x = 5; x <= 11; x++) mask[15 * W + x] = 1;
  for (let x = 13; x <= 19; x++) mask[15 * W + x] = 1;

  const cleaned = cleanMask(mask, W, H, { minArea: 12, close: 1 });

  // Izolované tečky musí být odstraněny
  assert.equal(cleaned[4 * W + 4], 0, '1px tečka měla být odstraněna');
  assert.equal(cleaned[4 * W + 15], 0, '3px tečka měla být odstraněna');
  assert.equal(cleaned[4 * W + 16], 0, '3px tečka měla být odstraněna');
  assert.equal(cleaned[5 * W + 15], 0, '3px tečka měla být odstraněna');

  // Mezera 1px na x = 12 musí být spojena
  assert.equal(cleaned[15 * W + 12], 1, '1px mezera měla být spojena');

  // Původní pixely čáry zůstávají
  for (let x = 5; x <= 19; x++) {
    assert.equal(cleaned[15 * W + x], 1, `Pixel (${x}, 15) v čáře by měl být zachován`);
  }
});
