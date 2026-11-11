// Zpracování GPX tras (parser, výpočty vzdáleností, filtrování, detekce výpadků, resamplování).
// Čisté ES moduly bez závislostí a bez DOM (funguje v prohlížeči i v Node.js).

export const EARTH_R = 6371008.8;
const D2R = Math.PI / 180;

/**
 * Výpočet ortodromické vzdálenosti (haversine) mezi dvěma body [metry].
 * @param {{lat: number, lon: number}} a
 * @param {{lat: number, lon: number}} b
 * @returns {number} Vzdálenost v metrech.
 */
export function haversine(a, b) {
  const lat1 = a.lat * D2R;
  const lat2 = b.lat * D2R;
  const dLat = lat2 - lat1;
  const dLon = (b.lon - a.lon) * D2R;
  const sinDlat = Math.sin(dLat / 2);
  const sinDlon = Math.sin(dLon / 2);
  const h = sinDlat * sinDlat + Math.cos(lat1) * Math.cos(lat2) * sinDlon * sinDlon;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Parsování GPX textu pomocí regulárních výrazů (bez DOM).
 * Zvládne formáty z Mapy.cz / mapy.com, Garminu i Stravy.
 * Přeskakuje neplatné body (nečíselné souřadnice nebo souřadnice mimo rozsah).
 *
 * @param {string} text Obsah GPX souboru
 * @returns {{
 *   name: string|null,
 *   points: Array<{lat: number, lon: number, ele: number|null, time: number|null}>,
 *   segments: Array<[number, number]>
 * }}
 */
export function parseGpx(text) {
  if (typeof text !== 'string') {
    throw new TypeError('GPX text musí být řetězec');
  }

  // Název trasy: hledáme v <metadata><name>, <trk><name>, <rte><name>, případně první <name>
  let name = null;
  const nameM = text.match(/<metadata\b[\s\S]*?<name>([\s\S]*?)<\/name>/i)
    || text.match(/<trk\b[\s\S]*?<name>([\s\S]*?)<\/name>/i)
    || text.match(/<rte\b[\s\S]*?<name>([\s\S]*?)<\/name>/i)
    || text.match(/<name>([\s\S]*?)<\/name>/i);
  if (nameM) {
    let n = nameM[1].trim();
    if (n.startsWith('<![CDATA[') && n.endsWith(']]>')) {
      n = n.slice(9, -3).trim();
    }
    name = n;
  }

  const points = [];
  const segments = [];

  // Pomocná funkce pro parsování bodů z jednoho textového bloku
  const parsePointsFromBlock = (blockStr) => {
    const ptRegex = /<([a-zA-Z0-9_-]+:)?(trkpt|rtept)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1?\2>)/gi;
    let m;
    while ((m = ptRegex.exec(blockStr)) !== null) {
      const attrs = m[3];
      const body = m[4] || '';

      const latM = attrs.match(/\blat\s*=\s*(?:["']([^"']+)["']|([^\s>]+))/i);
      const lonM = attrs.match(/\blon\s*=\s*(?:["']([^"']+)["']|([^\s>]+))/i);
      if (!latM || !lonM) continue;

      const lat = parseFloat(latM[1] !== undefined ? latM[1] : latM[2]);
      const lon = parseFloat(lonM[1] !== undefined ? lonM[1] : lonM[2]);
      if (isNaN(lat) || isNaN(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;

      let ele = null;
      const eleM = body.match(/<([a-zA-Z0-9_-]+:)?ele>([^<]+)<\/\1?ele>/i);
      if (eleM) {
        const parsedEle = parseFloat(eleM[2].trim());
        if (!isNaN(parsedEle)) ele = parsedEle;
      }

      let time = null;
      const timeM = body.match(/<([a-zA-Z0-9_-]+:)?time>([^<]+)<\/\1?time>/i);
      if (timeM) {
        const parsedTime = Date.parse(timeM[2].trim());
        if (!isNaN(parsedTime)) time = parsedTime;
      }

      points.push({ lat, lon, ele, time });
    }
  };

  // 1) Hledáme značky segmentů (<trkseg> nebo <rte>)
  const segRegex = /<([a-zA-Z0-9_-]+:)?(trkseg|rte)\b[^>]*>([\s\S]*?)<\/\1?\2>/gi;
  let segM;
  let hasSegments = false;
  while ((segM = segRegex.exec(text)) !== null) {
    hasSegments = true;
    const startIdx = points.length;
    parsePointsFromBlock(segM[3]);
    const endIdx = points.length;
    segments.push([startIdx, endIdx]);
  }

  // 2) Pokud nebyly žádné <trkseg> ani <rte>, zkusíme najít <trk>
  if (!hasSegments) {
    const trkRegex = /<([a-zA-Z0-9_-]+:)?trk\b[^>]*>([\s\S]*?)<\/\1?trk>/gi;
    let trkM;
    while ((trkM = trkRegex.exec(text)) !== null) {
      hasSegments = true;
      const startIdx = points.length;
      parsePointsFromBlock(trkM[2]);
      const endIdx = points.length;
      segments.push([startIdx, endIdx]);
    }
  }

  // 3) Pokud nebyly nalezeny žádné obalové značky, zpracujeme celý text jako jeden segment
  if (!hasSegments) {
    const startIdx = 0;
    parsePointsFromBlock(text);
    const endIdx = points.length;
    if (endIdx > 0) {
      segments.push([startIdx, endIdx]);
    }
  }

  return { name, points, segments };
}

/**
 * Celková délka trasy v metrech podél posloupnosti bodů.
 * @param {Array<{lat: number, lon: number}>} points
 * @returns {number} Délka v metrech.
 */
export function trackLength(points) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < points.length; i++) {
    sum += haversine(points[i - 1], points[i]);
  }
  return sum;
}

/**
 * Filtrování bodů trasy podle časového okna. Body bez času jsou ponechány.
 * @param {Array<{lat: number, lon: number, time?: number|null}>} points
 * @param {number|null} startMs Počáteční čas v ms epoch (nebo null)
 * @param {number|null} endMs Koncový čas v ms epoch (nebo null)
 * @returns {Array<{lat: number, lon: number, time?: number|null}>} Nové pole filtrovaných bodů.
 */
export function filterByTime(points, startMs = null, endMs = null) {
  if (!Array.isArray(points)) return [];
  return points.filter(p => {
    if (p.time === null || p.time === undefined) return true;
    if (startMs !== null && startMs !== undefined && p.time < startMs) return false;
    if (endMs !== null && endMs !== undefined && p.time > endMs) return false;
    return true;
  });
}

/**
 * Detekce výpadků záznamu (časový skok > maxGapS NEBO prostorový skok > maxJumpM).
 * Index označuje bod, kde k výpadku došlo (mezi i-1 a i).
 *
 * @param {Array<{lat: number, lon: number, time?: number|null}>} points
 * @param {{maxGapS?: number, maxJumpM?: number}} [opts]
 * @returns {Array<{index: number, fromTime: number|null, toTime: number|null, gapS: number|null, jumpM: number}>}
 */
export function findGaps(points, { maxGapS = 120, maxJumpM = 150 } = {}) {
  if (!Array.isArray(points) || points.length < 2) return [];
  const gaps = [];
  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1];
    const p1 = points[i];
    const jumpM = haversine(p0, p1);
    const hasTime = p0.time !== null && p0.time !== undefined && p1.time !== null && p1.time !== undefined;
    const gapS = hasTime ? (p1.time - p0.time) / 1000 : null;
    const isTimeGap = hasTime && gapS > maxGapS;
    const isJumpGap = jumpM > maxJumpM;

    if (isTimeGap || isJumpGap) {
      gaps.push({
        index: i,
        fromTime: p0.time ?? null,
        toTime: p1.time ?? null,
        gapS,
        jumpM,
      });
    }
  }
  return gaps;
}

/**
 * Převzorkování (resample) trasy po stepM metrech podél trasy.
 * Pro body ležící uvnitř výpadku (podle findGaps) nastaví gap=true.
 *
 * @param {Array<{lat: number, lon: number, time?: number|null}>} points
 * @param {number} stepM Krok v metrech
 * @param {{maxGapS?: number, maxJumpM?: number}} [gapOpts]
 * @returns {Array<{lat: number, lon: number, time: number|null, gap: boolean}>}
 */
export function resample(points, stepM, gapOpts = {}) {
  if (!Array.isArray(points) || points.length === 0) return [];
  if (points.length === 1) {
    return [{ lat: points[0].lat, lon: points[0].lon, time: points[0].time ?? null, gap: false }];
  }
  if (typeof stepM !== 'number' || isNaN(stepM) || stepM <= 0) {
    throw new RangeError('stepM musí být kladné číslo');
  }

  // Identifikujeme výpadky záznamu
  const gaps = findGaps(points, gapOpts);
  const gapSegmentIndices = new Set(gaps.map(g => g.index));

  // Spočítáme kumulativní vzdálenosti podél trasy
  const n = points.length;
  const cumDist = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    cumDist[i] = cumDist[i - 1] + haversine(points[i - 1], points[i]);
  }
  const totalDist = cumDist[n - 1];

  if (totalDist <= 1e-9) {
    return [{ lat: points[0].lat, lon: points[0].lon, time: points[0].time ?? null, gap: false }];
  }

  const numSteps = Math.floor((totalDist + 1e-9) / stepM);
  const result = [];
  let segIdx = 1;

  for (let s = 0; s <= numSteps; s++) {
    const targetD = Math.min(totalDist, s * stepM);

    while (segIdx < n - 1 && cumDist[segIdx] < targetD) {
      segIdx++;
    }

    const d0 = cumDist[segIdx - 1];
    const d1 = cumDist[segIdx];
    const segLen = d1 - d0;

    let t = 0;
    if (segLen > 1e-9) {
      t = Math.max(0, Math.min(1, (targetD - d0) / segLen));
    }

    const p0 = points[segIdx - 1];
    const p1 = points[segIdx];

    const lat = p0.lat + t * (p1.lat - p0.lat);
    const lon = p0.lon + t * (p1.lon - p0.lon);

    let time = null;
    if (p0.time !== null && p0.time !== undefined && p1.time !== null && p1.time !== undefined) {
      time = Math.round(p0.time + t * (p1.time - p0.time));
    }

    // Určení příznaku gap:
    // Pokud bod leží uvnitř segmentu označeného jako výpadek (0 < t < 1), je gap: true.
    // Na přesných hranicích bodů je gap true pouze tehdy, navazuje-li výpadek z obou stran.
    let isGap = false;
    const isCurGap = gapSegmentIndices.has(segIdx);
    const isPrevGap = gapSegmentIndices.has(segIdx - 1);
    const isNextGap = gapSegmentIndices.has(segIdx + 1);

    if (t > 1e-6 && t < 1 - 1e-6) {
      isGap = isCurGap;
    } else if (t <= 1e-6) {
      isGap = isCurGap && isPrevGap;
    } else {
      isGap = isCurGap && isNextGap;
    }

    result.push({ lat, lon, time, gap: isGap });
  }

  return result;
}
