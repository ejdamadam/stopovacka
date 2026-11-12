// tests/sheet.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSheetHtml, foreignTeams } from '../js/ui/sheet.js';
import { markerIdsForTeam } from '../js/core/layout.js';

test('foreignTeams: správné indexy cizích týmů', () => {
  assert.deepEqual(foreignTeams(4, 0), [1, 2, 3]);
  assert.deepEqual(foreignTeams(4, 1), [0, 2, 3]);
  assert.deepEqual(foreignTeams(4, 2), [0, 1, 3]);
  assert.deepEqual(foreignTeams(4, 3), [0, 1, 2]);
  assert.deepEqual(foreignTeams(3, 1), [0, 2]);
});

test('renderSheetHtml: vygeneruje platný HTML arch s požadovanými prvky', () => {
  const project = {
    version: 1,
    name: 'Letní závod 2026',
    teams: [
      { name: 'Lišky', color: '#e53935' },
      { name: 'Vlci', color: '#1e88e5' },
      { name: 'Medvědi', color: '#43a047' },
      { name: 'Sověti', color: '#fbc02d' }
    ],
    paper: 'A4',
    orientation: 'portrait',
    map: {
      kind: 'tiles',
      tileUrl: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
      attribution: '© OpenTopoMap',
      georef: {
        type: 'tiles',
        z: 15,
        px0: 4400000,
        py0: 2800000,
        px1: 4404000,
        py1: 2806000
      }
    }
  };

  const html = renderSheetHtml(project, 0);

  // 1. Značky ArUco
  const expectedMarkers = markerIdsForTeam(0);
  assert.equal(expectedMarkers.length, 4);
  assert.ok(html.includes('sheet-marker-tl'));
  assert.ok(html.includes('sheet-marker-tr'));
  assert.ok(html.includes('sheet-marker-br'));
  assert.ok(html.includes('sheet-marker-bl'));

  // 2. Hlavička
  assert.ok(html.includes('Arch týmu:'));
  assert.ok(html.includes('Lišky'));
  assert.ok(html.includes('Zakresluj trasy ostatních týmů. Každý tým jinou barevnou fixou (ne černou/šedou).'));

  // 3. Mapové pole se šedotónovým filtrem
  assert.ok(html.includes('sheet-map-box'));
  assert.ok(html.includes('filter:grayscale(1) contrast(.85) brightness(1.08)'));
  assert.ok(html.includes('sheet-scalebar'));
  assert.ok(html.includes('© OpenTopoMap'));

  // 4. Kalibrační pole pro cizí týmy (Vlci, Medvědi, Sověti)
  assert.ok(html.includes('Tým Vlci: sem tlustě čáru fixou'));
  assert.ok(html.includes('Tým Medvědi: sem tlustě čáru fixou'));
  assert.ok(html.includes('Tým Sověti: sem tlustě čáru fixou'));
  // Vlastní tým nesmí mít kalibrační pole
  assert.ok(!html.includes('Tým Lišky: sem tlustě čáru fixou'));
});

test('renderSheetHtml: podpora pro map.kind="image"', () => {
  const project = {
    version: 1,
    name: 'Skenovaná mapa',
    teams: [
      { name: 'T1', color: '#f00' },
      { name: 'T2', color: '#0f0' }
    ],
    paper: 'A3',
    orientation: 'landscape',
    map: {
      kind: 'image',
      imageDataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
      georef: {
        type: 'affine',
        aspect: 1.5,
        points: [
          { u: 0.1, v: 0.1, lat: 50.0, lon: 15.0 },
          { u: 0.9, v: 0.9, lat: 50.1, lon: 15.2 }
        ]
      }
    }
  };

  const html = renderSheetHtml(project, 1);
  assert.ok(html.includes('width:420mm'));
  assert.ok(html.includes('height:297mm'));
  assert.ok(html.includes('data:image/jpeg;base64,/9j/4AAQSkZJRg=='));
  assert.ok(html.includes('Tým T1: sem tlustě čáru fixou'));
});

test('layoutForProject: všechna kalibrační pole mají shodnou velikost (žádné pole není větší)', async () => {
  const { computeLayout } = await import('../js/core/layout.js');
  // 4 týmy -> 3 kalibrační pole, 8 značek po obvodu
  const layout = computeLayout('A4', 'portrait', null, 3, 8);
  assert.equal(layout.calib.length, 3);
  const w0 = layout.calib[0].w;
  const w1 = layout.calib[1].w;
  const w2 = layout.calib[2].w;
  assert.equal(w0, w1, 'Pole 0 a 1 mají stejnou šířku');
  assert.equal(w1, w2, 'Pole 1 a 2 mají stejnou šířku');
});

test('renderSheetHtml: podrobné měřítko obsahuje převod 1 cm = X m a dílky', () => {
  const project = {
    teams: [{ name: 'A' }, { name: 'B' }],
    paper: 'A4',
    orientation: 'portrait',
    map: {
      kind: 'tiles',
      georef: { type: 'tiles', z: 15, px0: 4400000, py0: 2800000, px1: 4404000, py1: 2806000 }
    }
  };
  const html = renderSheetHtml(project, 0);
  assert.ok(html.includes('1 cm ='), 'Měřítko obsahuje převodní poměr 1 cm = ...');
  assert.ok(html.includes('sheet-scalebar'), 'Obsahuje scalebar kontejner');
});
