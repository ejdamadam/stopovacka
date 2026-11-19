import test from 'node:test';
import assert from 'node:assert/strict';
import { softWeight, compareDrawing, prepareTrack, gameScore, renderOverlay } from '../js/core/evaluate.js';
import { edt } from '../js/core/edt.js';
import { fitTPS, warpSheet } from '../js/core/homography.js';

test('fitTPS: vyhlazení nelineární deformace / pomačkání papíru', () => {
  const pts = [
    { x: 10, y: 10 }, { x: 100, y: 10 }, { x: 200, y: 10 },
    { x: 200, y: 150 }, { x: 200, y: 290 }, { x: 100, y: 290 },
    { x: 10, y: 290 }, { x: 10, y: 150 }
  ];
  // Simulace prohnutí uprostřed o 8 px
  const diffs = pts.map(p => ({
    dx: p.x === 100 ? 8 : 0,
    dy: p.y === 150 ? -6 : 0
  }));

  const tps = fitTPS(pts, diffs);
  assert.equal(typeof tps, 'function');

  // V uzlech musí TPS přesně odpovídat zadaným posunům (s tolerancí regularizace < 0.1 px)
  const d1 = tps(100, 10);
  assert(Math.abs(d1.dx - 8) < 0.1, `Očekáváno dx ~ 8, bylo ${d1.dx}`);
  assert(Math.abs(d1.dy - 0) < 0.1, `Očekáváno dy ~ 0, bylo ${d1.dy}`);

  const d2 = tps(10, 150);
  assert(Math.abs(d2.dx - 0) < 0.1, `Očekáváno dx ~ 0, bylo ${d2.dx}`);
  assert(Math.abs(d2.dy - (-6)) < 0.1, `Očekáváno dy ~ -6, bylo ${d2.dy}`);

  // Uprostřed archu (100, 150) je plynulý přechod obou deformací
  const mid = tps(100, 150);
  assert(mid.dx > 2 && mid.dx < 7, `Středová deformace dx očekávána mezi 2 a 7, byla ${mid.dx}`);
  assert(mid.dy < -2 && mid.dy > -6, `Středová deformace dy očekávána mezi -6 a -2, byla ${mid.dy}`);
});

test('softWeight: základní hodnoty a hraniční stavy', () => {
  assert.equal(softWeight(0, 50), 1);
  assert.equal(softWeight(25, 50), 1);
  assert.equal(softWeight(50, 50), 1);
  assert.equal(softWeight(75, 50), 0.5);
  assert.equal(softWeight(100, 50), 0);
  assert.equal(softWeight(120, 50), 0);
  assert.equal(softWeight(Infinity, 50), 0);
  assert.equal(softWeight(NaN, 50), 0);
});

test('compareDrawing: přesná shoda čáry s trasou', () => {
  const w = 50;
  const h = 50;
  // Trasa po úhlopříčce od (5,5) do (45,45)
  const trackPx = [];
  for (let i = 5; i <= 45; i++) {
    trackPx.push({ x: i, y: i, gap: false });
  }

  // Nakreslená čára přesně podél trasy
  const drawn = new Uint8Array(w * h);
  for (let i = 5; i <= 45; i++) {
    drawn[i * w + i] = 1;
  }

  const res = compareDrawing(drawn, w, h, trackPx, 1, 5);
  assert(res.recall >= 0.95, `Recall očekáván >= 0.95, byl ${res.recall}`);
  assert(res.precision >= 0.95, `Precision očekávána >= 0.95, byla ${res.precision}`);
  assert.equal(res.score, 100);
  assert.equal(res.medianDrawnErrM, 0);
  assert.equal(res.medianTrackErrM, 0);
});

test('compareDrawing: čára úplně mimo trasu', () => {
  const w = 50;
  const h = 50;
  const trackPx = [{ x: 5, y: 5, gap: false }, { x: 5, y: 45, gap: false }];

  // Nakresleno na opačné straně (x = 45)
  const drawn = new Uint8Array(w * h);
  drawn[5 * w + 45] = 1;
  drawn[45 * w + 45] = 1;

  const res = compareDrawing(drawn, w, h, trackPx, 1, 5); // tol = 5 px, vzdálenost = 40 px
  assert.equal(res.recall, 0);
  assert.equal(res.precision, 0);
  assert.equal(res.score, 0);
  assert.equal(res.medianDrawnErrM, 40);
  assert.equal(res.medianTrackErrM, 40);
});

test('prepareTrack: časový filtr, výpadky a převzorkování', () => {
  const baseTime = Date.UTC(2026, 4, 1, 10, 0, 0);
  const gpx = {
    name: 'Test trasa',
    points: [
      { lat: 50.0, lon: 14.0, time: baseTime },
      { lat: 50.001, lon: 14.0, time: baseTime + 30000 },
      // Skok v čase (300 s > maxGapS 120 s)
      { lat: 50.002, lon: 14.0, time: baseTime + 330000 },
      // Bod mimo čas hry
      { lat: 50.003, lon: 14.0, time: baseTime + 7200000 },
    ]
  };

  const project = {
    game: {
      startMs: baseTime,
      endMs: baseTime + 600000, // 10 minut
    }
  };

  const prepared = prepareTrack(gpx, project, { stepM: 20 });
  assert.equal(prepared.points.length, 3, 'Bod mimo herní čas byl odfiltrován');
  assert.equal(prepared.gaps.length, 1, 'Byl nalezen 1 časový výpadek');
  assert.equal(prepared.gapS, 300);
  assert(prepared.resampled.length > 3, 'Trasa byla převzorkována');
  assert(prepared.resampled.some(p => p.gap === true), 'Část bodů spadá do výpadku');
});

test('gameScore: výpočet celkového skóre hry a penalizací', () => {
  const project = {
    teams: [
      { name: 'Červení', color: '#ff0000' },
      { name: 'Modří', color: '#0000ff' },
      { name: 'Zelení', color: '#00ff00' },
    ]
  };

  // 3 týmy: pro arch týmu i jsou cizí týmy foreignTeams
  // Arch 0 (Červení): stopoval Modré na 80, Zelené na 60 -> tracking = 70
  // Arch 1 (Modří): stopoval Červené na 90, Zelené na 50 -> tracking = 70
  // Arch 2 (Zelení): stopoval Červené na 70, Modré na 40 -> tracking = 55
  const sheetResults = {
    0: {
      perTeam: [
        { team: 1, score: 80 },
        { team: 2, score: 60 },
      ]
    },
    1: {
      perTeam: [
        { team: 0, score: 90 },
        { team: 2, score: 50 },
      ]
    },
    2: {
      perTeam: [
        { team: 0, score: 70 },
        { team: 1, score: 40 },
      ]
    }
  };

  // Trasy a výpadky
  // Tým 0 (Červení): gap 300 s (5 min) -> penalty = 0 (allowedGapMin=5)
  // Tým 1 (Modří): gap 600 s (10 min) -> penalty = (10 - 5) * 2 = 10 b
  // Tým 2 (Zelení): chybí trasa -> stealth = 0, penalty = 0
  const tracks = {
    0: { gapS: 300 },
    1: { gapS: 600 },
  };

  const scores = gameScore(project, sheetResults, tracks, { allowedGapMin: 5, penaltyPerMin: 2 });
  assert.equal(scores.length, 3);

  // Červení (tým 0):
  // tracking = (80 + 60)/2 = 70
  // ostatní stopovali Červené: Modří 90, Zelení 70 -> průměr = 80 -> stealth = 100 - 80 = 20
  // penalty = 0 -> total = 70 + 20 - 0 = 90
  const red = scores.find(s => s.team === 0);
  assert.equal(red.tracking, 70);
  assert.equal(red.stealth, 20);
  assert.equal(red.penalty, 0);
  assert.equal(red.total, 90);

  // Modří (tým 1):
  // tracking = (90 + 50)/2 = 70
  // ostatní stopovali Modré: Červení 80, Zelení 40 -> průměr = 60 -> stealth = 100 - 60 = 40
  // penalty = 10 -> total = 70 + 40 - 10 = 100
  const blue = scores.find(s => s.team === 1);
  assert.equal(blue.tracking, 70);
  assert.equal(blue.stealth, 40);
  assert.equal(blue.penalty, 10);
  assert.equal(blue.total, 100);

  // Pořadí: 1. Modří (100 b), 2. Červení (90 b), 3. Zelení
  assert.equal(scores[0].team, 1);
  assert.equal(scores[1].team, 0);
});

test('renderOverlay: vytvoří platný RGBA obrázek', () => {
  const w = 40;
  const h = 40;
  const rect = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(255) };
  const drawn = new Uint8Array(20 * 20);
  drawn[5 * 20 + 5] = 1;

  const result = {
    rect,
    mapPx: { x: 10, y: 10, w: 20, h: 20 },
    perTeam: [
      {
        team: 1,
        ink: { rgb: [255, 0, 0] },
        drawn,
        trackPx: [{ x: 5, y: 5, gap: false }, { x: 15, y: 15, gap: false }]
      }
    ]
  };

  const project = {
    teams: [
      { name: 'A', color: '#000000' },
      { name: 'B', color: '#0000ff' }
    ]
  };

  const overlay = renderOverlay(result, project);
  assert.equal(overlay.width, w);
  assert.equal(overlay.height, h);
  assert.equal(overlay.data.length, w * h * 4);
});

test('gameScore: přeskočí nevyhodnocovaný tým (prázdné kalibrační pole) a nepočítá ho do průměru', () => {
  // Projekt nachystaný na 4 týmy, ale 4. tým nakonec nehrál
  const project = {
    teams: [
      { name: 'T1', color: '#ff0000' },
      { name: 'T2', color: '#0000ff' },
      { name: 'T3', color: '#00ff00' },
      { name: 'T4', color: '#ffff00' }, // nehrál
    ]
  };

  // T1 stopoval T2 na 90, T3 na 70, a T4 neměl v chlívku fixu (skipped=true)
  const sheetResults = {
    0: {
      team: 0,
      perTeam: [
        { team: 1, score: 90 },
        { team: 2, score: 70 },
        { team: 3, skipped: true, error: 'Nevyhodnocováno (prázdné kalibrační pole)', score: null },
      ]
    },
    1: {
      team: 1,
      perTeam: [
        { team: 0, score: 80 },
        { team: 2, score: 60 },
        { team: 3, skipped: true, error: 'Nevyhodnocováno (prázdné kalibrační pole)', score: null },
      ]
    },
    2: {
      team: 2,
      perTeam: [
        { team: 0, score: 60 },
        { team: 1, score: 80 },
        { team: 3, skipped: true, error: 'Nevyhodnocováno (prázdné kalibrační pole)', score: null },
      ]
    }
  };

  const tracks = {
    0: { gapS: 0 },
    1: { gapS: 0 },
    2: { gapS: 0 },
  };

  const scores = gameScore(project, sheetResults, tracks);
  const t1 = scores.find(s => s.team === 0);

  // T1 tracking má být průměr jen z T2 a T3: (90 + 70) / 2 = 80 b (NIKOLIV děleno 3 na 53 b!)
  assert.equal(t1.tracking, 80, 'Tracking průměruje pouze vyhodnocované týmy');
  assert.equal(t1.evaluatedCount, 2);
  assert.equal(t1.detail[3], null, 'Nevyhodnocovaný tým má detail null');

  // Stealth pro T4: nikdo ho nestopoval, stealth je 0 (chybí trasa)
  const t4 = scores.find(s => s.team === 3);
  assert.equal(t4.stealth, 0);
});

test('compareDrawing: postupný pokles do maxTolM = 300 m (~2 cm při 1:15 000)', () => {
  const w = 120, h = 120;
  const mPerPx = 3.75; // 1:15 000 při 4 px/mm
  const trackPx = [];
  for (let x = 10; x <= 110; x += 2) trackPx.push({ x, y: 10, gap: false });

  // Čára ve vzdálenosti 47 px (~176 m -> mezi 50 m a 300 m)
  const drawnMid = new Uint8Array(w * h);
  for (let x = 10; x <= 110; x++) drawnMid[57 * w + x] = 1;
  const resMid = compareDrawing(drawnMid, w, h, trackPx, mPerPx, 50, { maxTolM: 300 });
  assert.ok(resMid.recall > 0.45 && resMid.recall < 0.55, `Recall v 176 m má být ~0.5, byl ${resMid.recall}`);
  assert.ok(resMid.score > 30 && resMid.score < 60, `Skóre v 176 m má být mezi 30 a 60, bylo ${resMid.score}`);

  // Čára ve vzdálenosti 85 px (~319 m > 300 m) -> 0 bodů
  const drawnFar = new Uint8Array(w * h);
  for (let x = 10; x <= 110; x++) drawnFar[95 * w + x] = 1;
  const resFar = compareDrawing(drawnFar, w, h, trackPx, mPerPx, 50, { maxTolM: 300 });
  assert.equal(resFar.recall, 0);
  assert.equal(resFar.precision, 0);
  assert.equal(resFar.score, 0);
});

test('compareDrawing: ~1mm čára je optimum, tlustá 4mm čára má nižší Precision a nerozšíří Recall', () => {
  const w = 80, h = 80;
  const mPerPx = 3.75;
  const trackOnLine = [];
  for (let x = 10; x <= 70; x += 2) trackOnLine.push({ x, y: 40, gap: false });

  // Optimální ~1mm čára (4 px při ppm = 4)
  const thin = new Uint8Array(w * h);
  for (let y = 38; y <= 41; y++) for (let x = 10; x <= 70; x++) thin[y * w + x] = 1;
  const resThin = compareDrawing(thin, w, h, trackOnLine, mPerPx, 50, { ppm: 4, maxTolM: 300 });
  assert.equal(resThin.thicknessFactor, 1);
  assert.equal(resThin.score, 100);

  // Tlustá ~4mm čára (17 px při ppm = 4)
  const thick = new Uint8Array(w * h);
  for (let y = 32; y <= 48; y++) for (let x = 10; x <= 70; x++) thick[y * w + x] = 1;
  const resThick = compareDrawing(thick, w, h, trackOnLine, mPerPx, 50, { ppm: 4, maxTolM: 300 });
  assert.ok(resThick.thicknessFactor < 0.4, `Faktor tloušťky u 4mm čáry má být < 0.4, byl ${resThick.thicknessFactor}`);
  assert.ok(resThick.precision < 0.45, `Precision u 4mm čáry má být < 0.45, byla ${resThick.precision}`);
  assert.ok(resThick.score < resThin.score - 30);

  // Tlustá čára nerozšíří dosah jádra pro Recall (trasa v y = 21 je 11 px od vnějšího okraje y = 32,
  // ale > 16 px od ~1mm jádra uprostřed, takže Recall zůstává 0 stejně jako u tenké čáry)
  const trackOutside = [];
  for (let x = 10; x <= 70; x += 2) trackOutside.push({ x, y: 21, gap: false });
  const resThinReach = compareDrawing(thin, w, h, trackOutside, mPerPx, 30, { ppm: 4, maxTolM: 60 });
  const resThickReach = compareDrawing(thick, w, h, trackOutside, mPerPx, 30, { ppm: 4, maxTolM: 60 });
  assert.equal(resThinReach.recall, 0);
  assert.equal(resThickReach.recall, 0, 'Vnější okraj tlusté čáry nerozšíří dosah Recallu');
});

test('compareDrawing: souběžné čáry vedle sebe rozšíří toleranční pásmo', () => {
  const w = 80, h = 80;
  const mPerPx = 3.75;
  const trackPx = [];
  for (let x = 10; x <= 70; x += 2) trackPx.push({ x, y: 30, gap: false });

  // Tým 1 na trase (y = 30), tým 2 souběžně o 9 px (~2.25 mm) vedle (y = 39)
  const drawn1 = new Uint8Array(w * h);
  for (let x = 10; x <= 70; x++) drawn1[30 * w + x] = 1;
  const dd1 = edt(drawn1, w, h);

  const drawn2 = new Uint8Array(w * h);
  for (let x = 10; x <= 70; x++) drawn2[39 * w + x] = 1;

  // Bez souběhu je 9 px mimo safe pás tolPx = 5.33 px (tolM = 20 m)
  const withoutParallel = compareDrawing(drawn2, w, h, trackPx, mPerPx, 20, { ppm: 4, maxTolM: 40 });
  assert.ok(withoutParallel.score < 85, `Bez rozšíření souběhem má být skóre < 85, bylo ${withoutParallel.score}`);

  // Se souběhem (otherDrawnEdts) se safe pás rozšíří a tým 2 dostane plných 100
  const withParallel = compareDrawing(drawn2, w, h, trackPx, mPerPx, 20, {
    ppm: 4,
    maxTolM: 40,
    parallelShiftMm: 2.2,
    otherDrawnEdts: [dd1],
  });
  assert.equal(withParallel.recall, 1);
  assert.equal(withParallel.precision, 1);
  assert.equal(withParallel.score, 100);
});

test('compareDrawing: wrongPenalty = 2.0 přísněji trestá špatně zakreslené čáry / hádání', () => {
  const w = 100, h = 100;
  const trackPx = [];
  for (let x = 10; x <= 50; x++) trackPx.push({ x, y: 10, gap: false });

  // Polovina čáry správně na trase (y = 10), polovina úplně mimo (y = 80)
  const drawn = new Uint8Array(w * h);
  for (let x = 10; x <= 50; x++) {
    drawn[10 * w + x] = 1;
    drawn[80 * w + x] = 1;
  }

  const resDefault = compareDrawing(drawn, w, h, trackPx, 1, 5, { maxTolM: 10, wrongPenalty: 2.0 });
  const resMild = compareDrawing(drawn, w, h, trackPx, 1, 5, { maxTolM: 10, wrongPenalty: 1.0 });
  assert.ok(Math.abs(resMild.precision - 0.5) < 0.02);
  assert.ok(Math.abs(resDefault.precision - 1 / 3) < 0.02, `Precision při wrongPenalty=2 má být ~0.333, byla ${resDefault.precision}`);
});

test('compareDrawing: neutrální zóna při výpadku GPX soupeře (gap: true)', () => {
  const w = 100, h = 40;
  const trackPx = [
    { x: 10, y: 20, gap: false },
    { x: 30, y: 20, gap: false },
    { x: 35, y: 20, gap: true },
    { x: 50, y: 20, gap: true },
    { x: 65, y: 20, gap: true },
    { x: 70, y: 20, gap: false },
    { x: 90, y: 20, gap: false },
  ];

  // Stopující tým správně zakreslí celou trasu včetně úseku, kde soupeři vypadla GPS
  const drawn = new Uint8Array(w * h);
  for (let x = 10; x <= 90; x++) drawn[20 * w + x] = 1;

  const res = compareDrawing(drawn, w, h, trackPx, 1, 5, { maxTolM: 10 });
  assert.equal(res.recall, 1);
  assert.equal(res.precision, 1);
  assert.equal(res.score, 100);
});

test('gameScore: ochrana proti kempování odemkne utajení až podle stopování', () => {
  const project = {
    teams: [
      { name: 'Kemper', color: '#f00' },
      { name: 'Poloviční', color: '#0f0' },
      { name: 'Aktivní', color: '#00f' },
    ]
  };
  const sheetResults = {
    0: { perTeam: [{ team: 1, score: 0 }, { team: 2, score: 0 }] },     // tracking = 0
    1: { perTeam: [{ team: 0, score: 0 }, { team: 2, score: 40 }] },    // tracking = 20
    2: { perTeam: [{ team: 0, score: 0 }, { team: 1, score: 100 }] },   // tracking = 50
  };
  const tracks = { 0: { gapS: 0 }, 1: { gapS: 0 }, 2: { gapS: 0 } };

  const scores = gameScore(project, sheetResults, tracks, { stealthRefTracking: 40 });
  const kemper = scores.find(s => s.team === 0);
  const half = scores.find(s => s.team === 1);
  const active = scores.find(s => s.team === 2);

  assert.equal(kemper.rawStealth, 100);
  assert.equal(kemper.stealth, 0, 'Kdo vůbec nestopoval, nedostane body za utajení');
  assert.equal(kemper.total, 0);

  assert.equal(half.tracking, 20);
  assert.equal(half.rawStealth, 50);
  assert.equal(half.stealth, 25, 'Poloviční stopování (20/40) odemkne 50 % utajení');
  assert.equal(half.total, 45);

  assert.equal(active.tracking, 50);
  assert.equal(active.rawStealth, 80);
  assert.equal(active.stealth, 80, 'Aktivní stopování (>= 40) odemkne 100 % utajení');
  assert.equal(active.total, 130);
});
