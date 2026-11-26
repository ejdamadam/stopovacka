import test from 'node:test';
import assert from 'node:assert/strict';
import {
  srgbToLab,
  labChroma,
  deltaE,
  estimateWhite,
  whiteBalance,
  whiteBalanceLocal,
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

test('whiteBalanceLocal: vyrovná stín v dolní polovině archu', () => {
  const W = 160, H = 240;
  const data = new Uint8ClampedArray(W * H * 4);

  for (let y = 0; y < H; y++) {
    const isShadow = y >= 140;
    const pr = isShadow ? 145 : 245;
    const pg = isShadow ? 145 : 245;
    const pb = isShadow ? 155 : 245;
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;
      data[idx] = pr;
      data[idx + 1] = pg;
      data[idx + 2] = pb;
      data[idx + 3] = 255;
    }
  }

  const img = { width: W, height: H, data };
  const globalWhite = estimateWhite(img, { x: 0, y: 0, w: W, h: 120 });
  const balanced = whiteBalance(img, globalWhite, { local: true });

  // Papír v dolní zastíněné části (y = 225, x = 80) musí být vytažen k neutrální ~245
  const idxBottom = (225 * W + 80) * 4;
  assert.ok(balanced.data[idxBottom] > 215, `R ve stínu má být > 215, je ${balanced.data[idxBottom]}`);
  assert.ok(balanced.data[idxBottom + 1] > 215, `G ve stínu má být > 215, je ${balanced.data[idxBottom + 1]}`);
  assert.ok(balanced.data[idxBottom + 2] > 215, `B ve stínu má být > 215, je ${balanced.data[idxBottom + 2]}`);

  // Horní neosvětlený papír zůstává ~245
  const idxTop = (20 * W + 80) * 4;
  assert.ok(Math.abs(balanced.data[idxTop] - 245) <= 5);
});

test('sampleInk + classifyInks: sjednocení pro tmavou méně sytou fixu (chroma < 14)', () => {
  const W = 60, H = 40;
  const data = new Uint8ClampedArray(W * H * 4);

  // Pozadí: šedý podklad (180, 180, 180)
  for (let i = 0; i < W * H * 4; i += 4) {
    data[i] = 180; data[i + 1] = 180; data[i + 2] = 180; data[i + 3] = 255;
  }

  // Tmavě modrošedá fixa v kalibračním obdélníku (x=5..15, y=5..10) i v mapě (y=25, x=10..50)
  const inkRgb = [55, 65, 82]; // L ~ 27, chroma ~ 10
  for (let y = 5; y <= 9; y++) {
    for (let x = 5; x <= 14; x++) {
      const idx = (y * W + x) * 4;
      data[idx] = inkRgb[0]; data[idx + 1] = inkRgb[1]; data[idx + 2] = inkRgb[2];
    }
  }
  for (let x = 10; x < 50; x++) {
    const idx = (25 * W + x) * 4;
    data[idx] = inkRgb[0]; data[idx + 1] = inkRgb[1]; data[idx + 2] = inkRgb[2];
  }

  const img = { width: W, height: H, data };
  const sampled = sampleInk(img, { x: 0, y: 0, w: 20, h: 15 });
  assert.ok(sampled !== null, 'Tmavá méně sytá fixa byla úspěšně navzorkována');
  assert.ok(sampled.chroma >= 5 && sampled.chroma < 14, `Chroma fixy je ${sampled.chroma}`);

  const labels = classifyInks(img, { x: 0, y: 18, w: W, h: 20 }, [{ lab: sampled.lab }], { minChroma: 14, maxDist: 40 });
  assert.equal(labels[25 * W + 25], 1, 'Tmavá méně sytá fixa je rozpoznána i na mapě');
  assert.equal(labels[20 * W + 25], 0, 'Neutrální šedá mapa zůstává ignorována');
});

test('classifyInks s refMap: potlačí barevný podklad mapy (včetně posunu a desaturace tisku) a zachová fixy', () => {
  const W = 80, H = 60;
  const refData = new Uint8ClampedArray(W * H * 4);
  const photoData = new Uint8ClampedArray(W * H * 4);

  const setPx = (arr, x, y, r, g, b) => {
    const idx = (y * W + x) * 4;
    arr[idx] = r; arr[idx + 1] = g; arr[idx + 2] = b; arr[idx + 3] = 255;
  };

  // 1) Čistá digitální mapa: bílé pozadí + světle zelený les (x < 40) + modrá řeka (y = 15..16) + červená turistická značka (y = 30..31)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (x < 40) {
        setPx(refData, x, y, 185, 225, 175); // les
      } else {
        setPx(refData, x, y, 255, 255, 255); // bílá mapa
      }
    }
  }
  for (let x = 0; x < W; x++) {
    setPx(refData, x, 15, 70, 145, 235); setPx(refData, x, 16, 70, 145, 235); // modrá řeka
    setPx(refData, x, 30, 225, 45, 45);  setPx(refData, x, 31, 225, 45, 45);  // červená značka
  }

  // 2) Fotka vytištěné mapy: simulace tisku (desaturace na ~70 %, bílý papír 245) + posun registrace o +2 px v Y
  for (let y = 0; y < H; y++) {
    const srcY = Math.max(0, y - 2);
    for (let x = 0; x < W; x++) {
      const sIdx = (srcY * W + x) * 4;
      const r = refData[sIdx], g = refData[sIdx + 1], b = refData[sIdx + 2];
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;
      const pr = Math.round((gray + 0.72 * (r - gray)) * (245 / 255));
      const pg = Math.round((gray + 0.72 * (g - gray)) * (245 / 255));
      const pb = Math.round((gray + 0.72 * (b - gray)) * (245 / 255));
      setPx(photoData, x, y, pr, pg, pb);
    }
  }

  // 3) Nakreslené fixy na fotce:
  // - červená fixa přes bílý podklad i přes zelený les (y = 45, x = 10..70)
  for (let x = 10; x < 70; x++) {
    setPx(photoData, x, 45, 215, 25, 30);
  }
  // - tmavě zelená fixa nakreslená přes světle zelený les (y = 52, x = 5..35)
  for (let x = 5; x < 35; x++) {
    setPx(photoData, x, 52, 20, 130, 35);
  }

  const refMap = { width: W, height: H, data: refData };
  const photo = { width: W, height: H, data: photoData };
  const inks = [
    { lab: srgbToLab(215, 25, 30) },  // červená fixa (štítek 1)
    { lab: srgbToLab(35, 95, 210) },  // modrá fixa (štítek 2)
    { lab: srgbToLab(20, 130, 35) },  // zelená fixa (štítek 3)
  ];

  // Bez refMap by červená turistická značka (y = 32 na posunuté fotce) chytila falešný štítek 1
  const labelsNoRef = classifyInks(photo, { x: 0, y: 0, w: W, h: H }, inks, { minChroma: 18, maxDist: 36 });
  assert.equal(labelsNoRef[32 * W + 50], 1, 'Bez refMap vyvolá červená turistická značka falešný poplach');

  // S refMap jsou všechny tištěné barevné prvky (les, řeka, červená značka) potlačeny
  const labelsRef = classifyInks(photo, { x: 0, y: 0, w: W, h: H }, inks, {
    minChroma: 18,
    maxDist: 36,
    refMap,
    refRect: { x: 0, y: 0, w: W, h: H },
    bgMinDiff: 18,
    bgRadius: 3,
  });

  assert.equal(labelsRef[17 * W + 50], 0, 'Modrá řeka na mapě musí být potlačena');
  assert.equal(labelsRef[32 * W + 50], 0, 'Červená turistická značka (i posunutá o 2 px a desaturovaná) musí být potlačena');
  assert.equal(labelsRef[8 * W + 15], 0, 'Světle zelený les na mapě musí být potlačen');

  // Nakreslené fixy musí zůstat zachovány
  assert.equal(labelsRef[45 * W + 20], 1, 'Červená fixa přes zelený les musí zůstat zachována');
  assert.equal(labelsRef[45 * W + 55], 1, 'Červená fixa přes bílý podklad musí zůstat zachována');
  assert.equal(labelsRef[52 * W + 20], 3, 'Tmavě zelená fixa přes světle zelený les musí zůstat zachována');
});
