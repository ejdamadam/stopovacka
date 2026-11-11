// Testy modulu js/core/gpx.js (node:test + node:assert/strict)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseGpx,
  haversine,
  trackLength,
  filterByTime,
  findGaps,
  resample,
  EARTH_R,
} from '../js/core/gpx.js';

describe('GPX parser – parseGpx', () => {
  test('parsuje standardní GPX z Mapy.cz s časovým offsetem a nadmořskou výškou', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1" creator="Mapy.cz">
  <trk>
    <name>Stopovačka tým 1</name>
    <trkseg>
      <trkpt lat="49.8175" lon="18.2611">
        <ele>245.5</ele>
        <time>2026-05-10T10:00:00.000+02:00</time>
      </trkpt>
      <trkpt lat="49.8180" lon="18.2620">
        <ele>248.0</ele>
        <time>2026-05-10T10:00:15.000+02:00</time>
      </trkpt>
      <trkpt lat="49.8185" lon="18.2630">
        <ele>250.2</ele>
        <time>2026-05-10T10:00:30.000+02:00</time>
      </trkpt>
    </trkseg>
  </trk>
</gpx>`;

    const parsed = parseGpx(xml);
    assert.equal(parsed.name, 'Stopovačka tým 1');
    assert.equal(parsed.points.length, 3);
    assert.deepEqual(parsed.segments, [[0, 3]]);

    assert.equal(parsed.points[0].lat, 49.8175);
    assert.equal(parsed.points[0].lon, 18.2611);
    assert.equal(parsed.points[0].ele, 245.5);
    assert.equal(parsed.points[0].time, Date.parse('2026-05-10T10:00:00.000+02:00'));

    assert.equal(parsed.points[2].ele, 250.2);
  });

  test('parsuje Strava GPX s metadata názevem a UTC časem (Z)', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx creator="StravaGPX" version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name><![CDATA[Ranní běh týmu]]></name>
    <time>2026-05-10T08:00:00Z</time>
  </metadata>
  <trk>
    <trkseg>
      <trkpt lat="50.08781" lon="14.42046">
        <ele>192.4</ele>
        <time>2026-05-10T08:00:01Z</time>
      </trkpt>
      <trkpt lat="50.08800" lon="14.42100">
        <ele>193.1</ele>
        <time>2026-05-10T08:00:05Z</time>
      </trkpt>
    </trkseg>
  </trk>
</gpx>`;

    const parsed = parseGpx(xml);
    assert.equal(parsed.name, 'Ranní běh týmu');
    assert.equal(parsed.points.length, 2);
    assert.equal(parsed.points[0].time, Date.parse('2026-05-10T08:00:01Z'));
  });

  test('parsuje Garmin GPX s XML jmennými prostory a rozšířeními <extensions>', () => {
    const xml = `<gpx xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <trk>
    <name>Garmin Track</name>
    <trkseg>
      <trkpt lat="50.000" lon="14.000">
        <ele>310</ele>
        <time>2026-05-10T12:00:00Z</time>
        <extensions>
          <gpxtpx:TrackPointExtension>
            <gpxtpx:hr>155</gpxtpx:hr>
          </gpxtpx:TrackPointExtension>
        </extensions>
      </trkpt>
    </trkseg>
  </trk>
</gpx>`;

    const parsed = parseGpx(xml);
    assert.equal(parsed.name, 'Garmin Track');
    assert.equal(parsed.points.length, 1);
    assert.equal(parsed.points[0].lat, 50.0);
    assert.equal(parsed.points[0].ele, 310);
  });

  test('parsuje self-closing body <trkpt .../> a atributy v jednoduchých uvozovkách', () => {
    const xml = `<gpx>
  <trk>
    <trkseg>
      <trkpt lat='50.123' lon='14.456'/>
      <trkpt lon="14.457" lat="50.124" />
    </trkseg>
  </trk>
</gpx>`;

    const parsed = parseGpx(xml);
    assert.equal(parsed.points.length, 2);
    assert.equal(parsed.points[0].lat, 50.123);
    assert.equal(parsed.points[0].lon, 14.456);
    assert.equal(parsed.points[0].ele, null);
    assert.equal(parsed.points[0].time, null);

    assert.equal(parsed.points[1].lat, 50.124);
    assert.equal(parsed.points[1].lon, 14.457);
  });

  test('parsuje <rte> a <rtept>', () => {
    const xml = `<gpx>
  <rte>
    <name>Plánovaná trasa</name>
    <rtept lat="50.0" lon="14.0"><ele>200</ele></rtept>
    <rtept lat="50.1" lon="14.1"><ele>210</ele></rtept>
  </rte>
</gpx>`;

    const parsed = parseGpx(xml);
    assert.equal(parsed.name, 'Plánovaná trasa');
    assert.equal(parsed.points.length, 2);
    assert.deepEqual(parsed.segments, [[0, 2]]);
  });

  test('rozdělí více <trkseg> na odpovídající indexy segmentů', () => {
    const xml = `<gpx>
  <trk>
    <name>Více segmentů</name>
    <trkseg>
      <trkpt lat="50.0" lon="14.0"/>
      <trkpt lat="50.1" lon="14.0"/>
    </trkseg>
    <trkseg>
      <trkpt lat="50.2" lon="14.0"/>
      <trkpt lat="50.3" lon="14.0"/>
      <trkpt lat="50.4" lon="14.0"/>
    </trkseg>
  </trk>
</gpx>`;

    const parsed = parseGpx(xml);
    assert.equal(parsed.points.length, 5);
    assert.deepEqual(parsed.segments, [[0, 2], [2, 5]]);
    assert.equal(parsed.points.slice(...parsed.segments[0]).length, 2);
    assert.equal(parsed.points.slice(...parsed.segments[1]).length, 3);
  });

  test('přeskočí neplatné body (chybějící souřadnice, nečíselné hodnoty, lat mimo +-90, lon mimo +-180)', () => {
    const xml = `<gpx>
  <trk>
    <trkseg>
      <trkpt lat="50.0" lon="14.0"/>
      <trkpt lat="95.0" lon="14.0"/>
      <trkpt lat="50.1" lon="200.0"/>
      <trkpt lat="invalid" lon="14.0"/>
      <trkpt lat="50.2"/>
      <trkpt lon="14.0"/>
      <trkpt lat="50.3" lon="14.1"/>
    </trkseg>
  </trk>
</gpx>`;

    const parsed = parseGpx(xml);
    assert.equal(parsed.points.length, 2);
    assert.equal(parsed.points[0].lat, 50.0);
    assert.equal(parsed.points[1].lat, 50.3);
  });

  test('vyhodí TypeError pokud vstup není řetězec', () => {
    assert.throws(() => parseGpx(null), TypeError);
    assert.throws(() => parseGpx(undefined), TypeError);
    assert.throws(() => parseGpx(123), TypeError);
  });
});

describe('Výpočet vzdálenosti – haversine a trackLength', () => {
  test('haversine vrátí 0 pro totožné body', () => {
    const p = { lat: 50.087, lon: 14.421 };
    assert.equal(haversine(p, p), 0);
  });

  test('haversine je symetrický a odpovídá známým vzdálenostem', () => {
    const praha = { lat: 50.087, lon: 14.421 };
    const brno = { lat: 49.195, lon: 16.608 };

    const d1 = haversine(praha, brno);
    const d2 = haversine(brno, praha);
    assert.ok(Math.abs(d1 - d2) < 1e-6);

    // Vzdálenost Praha - Brno vzdušnou čarou je cca 185–187 km
    assert.ok(d1 > 184000 && d1 < 188000, `Vzdálenost ${d1}m neodpovídá ~186 km`);

    // 1 stupeň zeměpisné šířky podél poledníku je cca 111.19 km
    const dDeg = haversine({ lat: 50.0, lon: 14.0 }, { lat: 51.0, lon: 14.0 });
    const expected = (Math.PI / 180) * EARTH_R;
    assert.ok(Math.abs(dDeg - expected) < 1.0);
  });

  test('trackLength spočítá celkovou délku trasy', () => {
    assert.equal(trackLength([]), 0);
    assert.equal(trackLength([{ lat: 50, lon: 14 }]), 0);

    const pts = [
      { lat: 50.0, lon: 14.0 },
      { lat: 50.001, lon: 14.0 },
      { lat: 50.002, lon: 14.0 },
    ];
    const d01 = haversine(pts[0], pts[1]);
    const d12 = haversine(pts[1], pts[2]);
    const total = trackLength(pts);
    assert.ok(Math.abs(total - (d01 + d12)) < 1e-9);
  });
});

describe('Filtrování času – filterByTime', () => {
  const t0 = 1700000000000;
  const pts = [
    { lat: 50.0, lon: 14.0, time: t0 },
    { lat: 50.1, lon: 14.0, time: t0 + 10000 },
    { lat: 50.2, lon: 14.0, time: null }, // bez času
    { lat: 50.3, lon: 14.0, time: t0 + 20000 },
    { lat: 50.4, lon: 14.0, time: t0 + 30000 },
  ];

  test('ponechá body bez času a filtruje časové okno', () => {
    const res = filterByTime(pts, t0 + 5000, t0 + 25000);
    // Měly by zůstat body: index 1 (t0+10s), index 2 (bez času), index 3 (t0+20s)
    assert.equal(res.length, 3);
    assert.equal(res[0].lat, 50.1);
    assert.equal(res[1].lat, 50.2);
    assert.equal(res[2].lat, 50.3);
  });

  test('při startMs=null filtruje jen horní mez', () => {
    const res = filterByTime(pts, null, t0 + 15000);
    // Index 0, 1 a 2 (bez času)
    assert.equal(res.length, 3);
    assert.equal(res[0].lat, 50.0);
    assert.equal(res[1].lat, 50.1);
    assert.equal(res[2].lat, 50.2);
  });

  test('při endMs=null filtruje jen dolní mez', () => {
    const res = filterByTime(pts, t0 + 15000, null);
    // Index 2 (bez času), 3, 4
    assert.equal(res.length, 3);
    assert.equal(res[0].lat, 50.2);
    assert.equal(res[1].lat, 50.3);
    assert.equal(res[2].lat, 50.4);
  });

  test('při obou null vrátí všechny body', () => {
    const res = filterByTime(pts, null, null);
    assert.equal(res.length, pts.length);
  });
});

describe('Detekce výpadků záznamu – findGaps', () => {
  const t0 = 1700000000000;

  test('pro trasu bez výpadků vrátí prázdné pole', () => {
    // 5 bodů, po 10 sekundách a cca 11 metrech
    const pts = [];
    for (let i = 0; i < 5; i++) {
      pts.push({ lat: 50.0 + i * 0.0001, lon: 14.0, time: t0 + i * 10000 });
    }
    const gaps = findGaps(pts);
    assert.deepEqual(gaps, []);
  });

  test('detekuje časový výpadek (> maxGapS)', () => {
    const pts = [
      { lat: 50.000, lon: 14.0, time: t0 },
      { lat: 50.001, lon: 14.0, time: t0 + 300000 }, // skok 300 s > 120 s (vzdálenost ~111 m < 150 m)
      { lat: 50.002, lon: 14.0, time: t0 + 310000 },
    ];
    const gaps = findGaps(pts, { maxGapS: 120, maxJumpM: 150 });
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].index, 1);
    assert.equal(gaps[0].fromTime, t0);
    assert.equal(gaps[0].toTime, t0 + 300000);
    assert.equal(gaps[0].gapS, 300);
    assert.ok(gaps[0].jumpM < 150);
  });

  test('detekuje prostorový skok (> maxJumpM)', () => {
    const pts = [
      { lat: 50.000, lon: 14.0, time: t0 },
      { lat: 50.005, lon: 14.0, time: t0 + 30000 }, // skok 30 s (< 120 s), ale vzdálenost ~555 m > 150 m
      { lat: 50.006, lon: 14.0, time: t0 + 60000 },
    ];
    const gaps = findGaps(pts, { maxGapS: 120, maxJumpM: 150 });
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].index, 1);
    assert.ok(gaps[0].jumpM > 500);
    assert.equal(gaps[0].gapS, 30);
  });

  test('detekuje výpadek u bodů bez času na základě skoku', () => {
    const pts = [
      { lat: 50.000, lon: 14.0, time: null },
      { lat: 50.005, lon: 14.0, time: null },
    ];
    const gaps = findGaps(pts, { maxJumpM: 150 });
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].gapS, null);
    assert.ok(gaps[0].jumpM > 500);
  });
});

describe('Převzorkování trasy – resample', () => {
  const t0 = 1700000000000;

  test('prázdné nebo jednobodové pole', () => {
    assert.deepEqual(resample([], 10), []);
    const single = [{ lat: 50.0, lon: 14.0, time: t0 }];
    assert.deepEqual(resample(single, 10), [{ lat: 50.0, lon: 14.0, time: t0, gap: false }]);
  });

  test('vyhodí RangeError pro nekladný krok', () => {
    assert.throws(() => resample([{ lat: 50, lon: 14 }, { lat: 51, lon: 14 }], 0), RangeError);
    assert.throws(() => resample([{ lat: 50, lon: 14 }, { lat: 51, lon: 14 }], -5), RangeError);
  });

  test('počet bodů odpovídá cca délka / krok a body jsou rovnoměrně rozmístěné', () => {
    // Přímá trasa o délce cca 1000 metrů složená z bodů po 50 m a 30 s (žádný výpadek)
    const latM = 1 / EARTH_R / (Math.PI / 180); // 1 metr v lat
    const pts = [];
    for (let i = 0; i <= 20; i++) {
      pts.push({
        lat: 50.0 + i * 50 * latM,
        lon: 14.0,
        time: t0 + i * 30000,
      });
    }
    const totalDist = trackLength(pts);
    assert.ok(Math.abs(totalDist - 1000) < 1.0);

    const stepM = 25;
    const sampled = resample(pts, stepM);

    // Počet bodů: 1000 / 25 = 40 intervalů => 41 bodů (včetně počátečního a koncového)
    const expectedPoints = Math.floor(totalDist / stepM) + 1;
    assert.equal(sampled.length, expectedPoints);

    // Vzdálenost mezi sousedními vygenerovanými body by měla být přesně stepM
    for (let i = 1; i < sampled.length; i++) {
      const stepDist = haversine(sampled[i - 1], sampled[i]);
      assert.ok(Math.abs(stepDist - stepM) < 0.1, `Krok ${i} má délku ${stepDist}m, očekáváno ${stepM}m`);
    }

    // Žádný bod by neměl mít příznak výpadku (trasa byla bez výpadku)
    assert.ok(sampled.every(p => p.gap === false));

    // Čas by měl být lineárně interpolován
    assert.equal(sampled[0].time, t0);
    assert.equal(sampled[sampled.length - 1].time, t0 + 20 * 30000);
  });

  test('nastaví gap=true pro body ležící uvnitř výpadku', () => {
    // 3 segmenty:
    // 1. segment: normální (100 m, 60 s)
    // 2. segment: výpadek – prostorový skok 500 m (> 150 m)
    // 3. segment: normální (100 m, 60 s)
    const latM = 1 / EARTH_R / (Math.PI / 180); // 1 metr v lat
    const pts = [
      { lat: 50.0 + 0 * latM, lon: 14.0, time: t0 },
      { lat: 50.0 + 100 * latM, lon: 14.0, time: t0 + 60000 },
      { lat: 50.0 + 600 * latM, lon: 14.0, time: t0 + 120000 }, // skok 500 m
      { lat: 50.0 + 700 * latM, lon: 14.0, time: t0 + 180000 },
    ];

    const stepM = 50;
    const sampled = resample(pts, stepM, { maxJumpM: 150, maxGapS: 120 });

    // Vnitřní body v intervalu (100 m, 600 m), tj. 150, 200, 250, 300, 350, 400, 450, 500, 550 m
    // musí mít gap === true.
    const gapPoints = sampled.filter(p => p.gap === true);
    assert.ok(gapPoints.length > 0, 'Musí existovat body s gap: true uvnitř výpadku');

    // Body na začátku (0, 50, 100 m) a na konci (600, 650, 700 m) nesmí mít gap === true
    assert.equal(sampled[0].gap, false);
    assert.equal(sampled[1].gap, false); // 50m
    assert.equal(sampled[2].gap, false); // 100m (přesně bod p1)

    // Body uvnitř skoku (indexy 3 až 11 odpovídající 150m až 550m)
    for (let i = 3; i < sampled.length - 3; i++) {
      assert.equal(sampled[i].gap, true, `Bod na indexu ${i} by měl mít gap=true`);
    }

    // Koncové body po zotavení signálu
    assert.equal(sampled[sampled.length - 2].gap, false);
    assert.equal(sampled[sampled.length - 1].gap, false);
  });
});
