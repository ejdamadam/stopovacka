// Testy existujících modulů js/core (geo.js, layout.js, homography.js, markers.js)
// Používá node:test a node:assert/strict.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import {
  parseLatLon,
  makeGeoref,
  mapExtentMeters,
  makeLocalProj,
  solveLinear,
  STANDARD_SCALES,
  snapToStandardScale,
} from '../js/core/geo.js';

import {
  LAYOUT_VERSION,
  MARKER_IDS,
  CORNERS,
  computeLayout,
  markerIdsForTeam,
  lookupMarkerId,
  calibSampleRect,
  markerCornersMm,
} from '../js/core/layout.js';

import {
  mul3,
  invert3,
  applyH,
  solveHomography,
  warpSheet,
  downscale,
} from '../js/core/homography.js';

import {
  markerBits,
  isRotationSafe,
  pickMarkerIds,
  markerSvg,
  detectMarkers,
} from '../js/core/markers.js';

describe('Modul js/core/geo.js', () => {
  describe('parseLatLon', () => {
    test('parsuje desetinné souřadnice oddělené čárkou', () => {
      const res = parseLatLon('48.9512, 19.0712');
      assert.ok(res !== null);
      assert.ok(Math.abs(res.lat - 48.9512) < 1e-6);
      assert.ok(Math.abs(res.lon - 19.0712) < 1e-6);
    });

    test('parsuje formát mapy.com s N/E', () => {
      const res = parseLatLon('48.9512N, 19.0712E');
      assert.ok(res !== null);
      assert.ok(Math.abs(res.lat - 48.9512) < 1e-6);
      assert.ok(Math.abs(res.lon - 19.0712) < 1e-6);
    });

    test('parsuje stupně a desetinné minuty (DMM)', () => {
      const res = parseLatLon("N 48°57.072', E 19°4.272'");
      assert.ok(res !== null);
      assert.ok(Math.abs(res.lat - 48.9512) < 1e-4);
      assert.ok(Math.abs(res.lon - 19.0712) < 1e-4);
    });

    test('parsuje stupně, minuty a vteřiny (DMS)', () => {
      const res = parseLatLon('48°57\'4.3"N 19°4\'16.3"E');
      assert.ok(res !== null);
      assert.ok(Math.abs(res.lat - 48.951194) < 1e-4);
      assert.ok(Math.abs(res.lon - 19.071194) < 1e-4);
    });

    test('parsuje záporné souřadnice S a W', () => {
      const res = parseLatLon('48.9512S, 19.0712W');
      assert.ok(res !== null);
      assert.ok(Math.abs(res.lat - (-48.9512)) < 1e-6);
      assert.ok(Math.abs(res.lon - (-19.0712)) < 1e-6);
    });

    test('vrátí null pro neplatné vstupy', () => {
      assert.equal(parseLatLon(null), null);
      assert.equal(parseLatLon(''), null);
      assert.equal(parseLatLon('neplatny text'), null);
      assert.equal(parseLatLon('95.0, 19.0'), null); // lat mimo +-90
      assert.equal(parseLatLon('48.0, 195.0'), null); // lon mimo +-180
    });
  });

  describe('makeGeoref – dlaždice (tiles)', () => {
    const tileDef = {
      type: 'tiles',
      z: 15,
      px0: 100000,
      py0: 80000,
      px1: 102000,
      py1: 82000,
    };
    const georef = makeGeoref(tileDef);

    test('toUV a toLatLon jsou vzájemně inverzní (round-trip)', () => {
      const testPoints = [
        { u: 0.0, v: 0.0 },
        { u: 0.5, v: 0.5 },
        { u: 1.0, v: 1.0 },
        { u: 0.25, v: 0.75 },
      ];

      for (const pt of testPoints) {
        const { lat, lon } = georef.toLatLon(pt.u, pt.v);
        const uv = georef.toUV(lat, lon);
        assert.ok(Math.abs(uv.u - pt.u) < 1e-8, `Chyba v u pro ${pt.u}: ${uv.u}`);
        assert.ok(Math.abs(uv.v - pt.v) < 1e-8, `Chyba v v pro ${pt.v}: ${uv.v}`);
      }
    });

    test('mapExtentMeters vrací rozumné metrické rozměry', () => {
      const ext = mapExtentMeters(georef);
      assert.ok(ext.widthM > 500 && ext.widthM < 2000, `Šířka ${ext.widthM}m mimo očekávání`);
      assert.ok(ext.heightM > 500 && ext.heightM < 2000, `Výška ${ext.heightM}m mimo očekávání`);
      // Vzhledem ke čtvercovému výřezu px (2000x2000) by šířka a výška měly být téměř shodné
      assert.ok(Math.abs(ext.widthM - ext.heightM) < 1.0);
    });
  });

  describe('makeGeoref – afinní (affine)', () => {
    test('3–4 konzistentní body: round-trip a rmsM ≈ 0', () => {
      const proj = makeLocalProj(50.0, 14.0);
      const aspect = 1.4;

      // Vytvoříme 4 body přesně odpovídající afinní transformaci: X = 1000*u*aspect + 50, Y = - (1000*v + 30)
      const uvs = [
        { u: 0.1, v: 0.1 },
        { u: 0.9, v: 0.15 },
        { u: 0.85, v: 0.85 },
        { u: 0.15, v: 0.8 },
      ];

      const points = uvs.map(p => {
        const x = p.u * aspect * 1000 + 50;
        const y = -(p.v * 1000 + 30);
        const ll = proj.toLatLon(x, -y);
        return { u: p.u, v: p.v, lat: ll.lat, lon: ll.lon };
      });

      const georef = makeGeoref({ type: 'affine', aspect, points });

      // Pro přesná data musí být rmsM zanedbatelná (< 1e-6 m)
      assert.ok(georef.rmsM < 1e-6, `rmsM je příliš velké: ${georef.rmsM}`);

      // Round-trip ověření
      for (const p of points) {
        const uv = georef.toUV(p.lat, p.lon);
        assert.ok(Math.abs(uv.u - p.u) < 1e-8);
        assert.ok(Math.abs(uv.v - p.v) < 1e-8);
      }

      // mapExtentMeters
      const ext = mapExtentMeters(georef);
      assert.ok(Math.abs(ext.widthM - 1000 * aspect) < 1.0);
      assert.ok(Math.abs(ext.heightM - 1000) < 1.0);
    });

    test('méně než 2 body vyhodí chybu', () => {
      assert.throws(() => makeGeoref({ type: 'affine', points: [{ u: 0, v: 0, lat: 50, lon: 14 }] }), /aspoň 2/);
    });
  });

  describe('snapToStandardScale a STANDARD_SCALES', () => {
    test('STANDARD_SCALES obsahuje běžná kartografická měřítka', () => {
      assert.ok(STANDARD_SCALES.includes(5000));
      assert.ok(STANDARD_SCALES.includes(10000));
      assert.ok(STANDARD_SCALES.includes(15000));
      assert.ok(STANDARD_SCALES.includes(25000));
      assert.ok(STANDARD_SCALES.includes(50000));
    });

    test('zarovná blízké hodnoty na standardní měřítka (např. 10 012 -> 10 000)', () => {
      assert.equal(snapToStandardScale(10012), 10000);
      assert.equal(snapToStandardScale(9980), 10000);
      assert.equal(snapToStandardScale(10450), 10000);
      assert.equal(snapToStandardScale(14950), 15000);
      assert.equal(snapToStandardScale(25010), 25000);
      assert.equal(snapToStandardScale(49800), 50000);
    });

    test('zaokrouhlí mimo standardní měřítka na čistá čísla', () => {
      assert.equal(snapToStandardScale(3610), 3500);
      assert.equal(snapToStandardScale(8310), 8500);
      assert.equal(snapToStandardScale(21120), 21000);
    });
  });
});

describe('Modul js/core/layout.js', () => {
  test('pickMarkerIds(16, 7) z markers.js přesně odpovídá MARKER_IDS z layout.js', () => {
    const picked = pickMarkerIds(16, 7);
    assert.deepEqual(picked, MARKER_IDS);
  });

  test('všechna MARKER_IDS jsou rotačně bezpečná a mají vzájemnou Hammingovu vzdálenost >= 7', () => {
    assert.equal(MARKER_IDS.length, 16);
    for (const id of MARKER_IDS) {
      assert.ok(isRotationSafe(id), `ID ${id} není rotačně bezpečné`);
    }

    const rot90 = (m) => m.map((row, i) => row.map((_, j) => m[m.length - j - 1][i]));
    const bitsToKey = (m) => m.map(r => r.join('')).join('');
    const hamming = (a, b) => { let d = 0; for (let i = 0; i < 25; i++) if (a[i] !== b[i]) d++; return d; };

    const markerRotKeys = MARKER_IDS.map(id => {
      let m = markerBits(id);
      const keys = [];
      for (let r = 0; r < 4; r++) {
        keys.push(bitsToKey(m));
        m = rot90(m);
      }
      return keys;
    });

    for (let i = 0; i < MARKER_IDS.length; i++) {
      for (let j = i + 1; j < MARKER_IDS.length; j++) {
        for (const k1 of markerRotKeys[i]) {
          for (const k2 of markerRotKeys[j]) {
            const dist = hamming(k1, k2);
            assert.ok(dist >= 7, `Hammingova vzdálenost mezi ID ${MARKER_IDS[i]} a ${MARKER_IDS[j]} je jen ${dist} < 7`);
          }
        }
      }
    }
  });

  test('computeLayout pro A4/A3 portrait/landscape: značky uvnitř, mapRect uvnitř avail bez kolize', () => {
    const configs = [
      { paper: 'A4', orientation: 'portrait' },
      { paper: 'A4', orientation: 'landscape' },
      { paper: 'A3', orientation: 'portrait' },
      { paper: 'A3', orientation: 'landscape' },
      { paper: 'A4', orientation: 'portrait', mapAspect: 1.5 },
      { paper: 'A4', orientation: 'portrait', mapAspect: 0.7 },
    ];

    for (const cfg of configs) {
      const layout = computeLayout(cfg);

      // Značky jsou uvnitř rozměrů papíru
      for (const m of layout.markers) {
        assert.ok(m.x >= layout.margin);
        assert.ok(m.y >= layout.margin);
        assert.ok(m.x + m.size <= layout.w - layout.margin + 1e-6);
        assert.ok(m.y + m.size <= layout.h - layout.margin + 1e-6);
      }

      // mapRect je uvnitř avail
      assert.ok(layout.mapRect.x >= layout.avail.x - 1e-6);
      assert.ok(layout.mapRect.y >= layout.avail.y - 1e-6);
      assert.ok(layout.mapRect.x + layout.mapRect.w <= layout.avail.x + layout.avail.w + 1e-6);
      assert.ok(layout.mapRect.y + layout.mapRect.h <= layout.avail.y + layout.avail.h + 1e-6);

      // mapRect se nepřekrývá se značkami
      for (const m of layout.markers) {
        const xOverlap = Math.max(0, Math.min(layout.mapRect.x + layout.mapRect.w, m.x + m.size) - Math.max(layout.mapRect.x, m.x));
        const yOverlap = Math.max(0, Math.min(layout.mapRect.y + layout.mapRect.h, m.y + m.size) - Math.max(layout.mapRect.y, m.y));
        assert.equal(xOverlap * yOverlap, 0, `mapRect koliduje se značkou ${m.corner}`);
      }
    }
  });

  test('lookupMarkerId správně identifikuje tým a roh', () => {
    for (let t = 0; t < 4; t++) {
      const ids = markerIdsForTeam(t);
      assert.equal(ids.length, 4);
      for (let c = 0; c < 4; c++) {
        const info = lookupMarkerId(ids[c]);
        assert.ok(info !== null);
        assert.equal(info.team, t);
        assert.equal(info.corner, c);
      }
    }

    assert.equal(lookupMarkerId(999), null);
    assert.equal(lookupMarkerId(-1), null);
  });
});

describe('Modul js/core/homography.js', () => {
  const H_true = [1.2, 0.05, 20.0, -0.03, 1.15, 30.0, 0.0001, 0.0002, 1.0];

  test('solveHomography se 4 body přesně zrekonstruuje známou H', () => {
    const src = [
      { x: 10, y: 10 },
      { x: 200, y: 15 },
      { x: 195, y: 280 },
      { x: 15, y: 275 },
    ];
    const dst = src.map(p => applyH(H_true, p.x, p.y));

    const { H, rms } = solveHomography(src, dst);
    assert.ok(rms < 1e-9, `Reprojekční chyba je příliš velká: ${rms}`);

    for (const p of src) {
      const q = applyH(H, p.x, p.y);
      const expected = applyH(H_true, p.x, p.y);
      assert.ok(Math.hypot(q.x - expected.x, q.y - expected.y) < 1e-6);
    }
  });

  test('solveHomography s 10 body se šumem vrátí malou reprojekční chybu', () => {
    const src = [];
    for (let i = 0; i < 10; i++) {
      src.push({ x: 15 + i * 18, y: 20 + (i % 3) * 80 });
    }
    // Deterministický šum
    const dst = src.map((p, idx) => {
      const q = applyH(H_true, p.x, p.y);
      const noiseX = (Math.sin(idx) * 0.05);
      const noiseY = (Math.cos(idx) * 0.05);
      return { x: q.x + noiseX, y: q.y + noiseY };
    });

    const { rms } = solveHomography(src, dst);
    assert.ok(rms < 0.1, `rms se šumem je příliš velké: ${rms}`);
  });

  test('invert3 správně invertuje matici 3x3', () => {
    const H_inv = invert3(H_true);
    const I = mul3(H_true, H_inv);
    const expectedI = [1, 0, 0, 0, 1, 0, 0, 0, 1];

    for (let i = 0; i < 9; i++) {
      assert.ok(Math.abs(I[i] - expectedI[i]) < 1e-9, `Rozdíl na pozici ${i}: ${I[i]}`);
    }
  });

  test('warpSheet narovná malý obrázek na správný rozměr', () => {
    const img = {
      width: 20,
      height: 20,
      data: new Uint8ClampedArray(20 * 20 * 4).fill(100),
    };
    const H_ident = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const warped = warpSheet(img, H_ident, 5, 5, 2);

    assert.equal(warped.width, 10);
    assert.equal(warped.height, 10);
    assert.equal(warped.data.length, 10 * 10 * 4);
    // Všechny pixely uvnitř by měly mít barvu 100
    assert.equal(warped.data[0], 100);
    assert.equal(warped.data[3], 255);
  });
});

describe('Modul js/core/markers.js (detekce v Node.js)', () => {
  before(() => {
    // Načteme js/vendor/cv.js a aruco.js do běhového prostředí Node.js
    const cvCode = fs.readFileSync(path.resolve('js/vendor/cv.js'), 'utf8');
    const arucoCode = fs.readFileSync(path.resolve('js/vendor/aruco.js'), 'utf8');

    vm.runInThisContext(cvCode);
    vm.runInThisContext(arucoCode);

    assert.ok(globalThis.CV, 'CV objekt musí být načten');
    assert.ok(globalThis.AR, 'AR objekt musí být načten');
  });

  test('detectMarkers najde všechna 4 ID na syntetickém archu a rohy sedí na +-3 px', () => {
    const ppm = 4;
    const layout = computeLayout({ paper: 'A4', orientation: 'portrait' });
    const W = Math.round(layout.w * ppm);
    const H = Math.round(layout.h * ppm);

    const img = {
      width: W,
      height: H,
      data: new Uint8ClampedArray(W * H * 4).fill(255), // bílý papír
    };

    const team = 1;
    const ids = markerIdsForTeam(team); // [42, 45, 51, 52]

    function drawRect(x, y, w, h, val) {
      for (let r = y; r < y + h; r++) {
        for (let c = x; c < x + w; c++) {
          if (r >= 0 && r < H && c >= 0 && c < W) {
            const idx = (r * W + c) * 4;
            img.data[idx] = val;
            img.data[idx + 1] = val;
            img.data[idx + 2] = val;
            img.data[idx + 3] = 255;
          }
        }
      }
    }

    // Vyrenderujeme 4 značky týmu 1
    for (let i = 0; i < 4; i++) {
      const m = layout.markers[i];
      const id = ids[i];
      const bits = markerBits(id);
      const x0 = Math.round(m.x * ppm);
      const y0 = Math.round(m.y * ppm);
      const sizePx = Math.round(m.size * ppm);
      const cellSize = sizePx / 7;

      // Černý okraj (1 buňka ze všech stran + vnitřek)
      drawRect(x0, y0, sizePx, sizePx, 0);

      // Vnitřní 5x5 buňky
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 5; c++) {
          if (bits[r][c] === 1) { // 1 = bílá buňka
            const bx = Math.round(x0 + (c + 1) * cellSize);
            const by = Math.round(y0 + (r + 1) * cellSize);
            const bw = Math.round(x0 + (c + 2) * cellSize) - bx;
            const bh = Math.round(y0 + (r + 2) * cellSize) - by;
            drawRect(bx, by, bw, bh, 255);
          }
        }
      }
    }

    const detected = detectMarkers(img);
    assert.equal(detected.length, 4, `Nalezeno ${detected.length} značek místo 4`);

    const detectedIds = detected.map(m => m.id).sort((a, b) => a - b);
    const expectedIds = [...ids].sort((a, b) => a - b);
    assert.deepEqual(detectedIds, expectedIds);

    // Ověříme pozice rohů na +-3 px
    for (let i = 0; i < 4; i++) {
      const m = layout.markers[i];
      const id = ids[i];
      const found = detected.find(d => d.id === id);
      assert.ok(found, `Značka ${id} nebyla nalezena`);

      const x0 = Math.round(m.x * ppm);
      const y0 = Math.round(m.y * ppm);
      const s = Math.round(m.size * ppm);

      // Očekávané rohy: TL (x0, y0), TR (x0+s, y0), BR (x0+s, y0+s), BL (x0, y0+s)
      const expectedCorners = [
        { x: x0, y: y0 },
        { x: x0 + s, y: y0 },
        { x: x0 + s, y: y0 + s },
        { x: x0, y: y0 + s },
      ];

      for (let k = 0; k < 4; k++) {
        const actual = found.corners[k];
        const exp = expectedCorners[k];
        const dx = Math.abs(actual.x - exp.x);
        const dy = Math.abs(actual.y - exp.y);
        assert.ok(
          dx <= 3 && dy <= 3,
          `Roh ${k} značky ${id} je [${actual.x}, ${actual.y}], očekáváno [${exp.x}, ${exp.y}], odchylka (${dx}, ${dy}) px`
        );
      }
    }
  });
});
