import test from 'node:test';
import assert from 'node:assert/strict';
import { softWeight, compareDrawing, prepareTrack, gameScore, renderOverlay } from '../js/core/evaluate.js';
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
