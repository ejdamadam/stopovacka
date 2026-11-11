// Práce s barvami, CIE Lab prostor, vyvážení bílé a klasifikace fix na mapě.

// Tabulka pro rychlou linearizaci sRGB (0..255) do lineárního RGB (0..1)
const SRGB_TO_LIN = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const v = i / 255;
  SRGB_TO_LIN[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

// Konstanty standardního pozorovatele D65
const XN = 0.95047;
const YN = 1.00000;
const ZN = 1.08883;

const EPS = 216 / 24389; // (6/29)^3 ≈ 0.00885645
const KAPPA = 24389 / 27; // (29/3)^3 ≈ 903.296

function srgbChannelToLinear(v) {
  if (v >= 0 && v <= 255 && Number.isInteger(v)) {
    return SRGB_TO_LIN[v];
  }
  const c = Math.max(0, Math.min(255, v)) / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Převod sRGB (0..255) do CIELAB (D65). L ∈ [0, 100].
 */
export function srgbToLab(r, g, b) {
  const rL = srgbChannelToLinear(r);
  const gL = srgbChannelToLinear(g);
  const bL = srgbChannelToLinear(b);

  const X = 0.4124564 * rL + 0.3575761 * gL + 0.1804375 * bL;
  const Y = 0.2126729 * rL + 0.7151522 * gL + 0.0721750 * bL;
  const Z = 0.0193339 * rL + 0.1191920 * gL + 0.9503041 * bL;

  const xr = X / XN, yr = Y / YN, zr = Z / ZN;

  const fx = xr > EPS ? Math.cbrt(xr) : (KAPPA * xr + 16) / 116;
  const fy = yr > EPS ? Math.cbrt(yr) : (KAPPA * yr + 16) / 116;
  const fz = zr > EPS ? Math.cbrt(zr) : (KAPPA * zr + 16) / 116;

  const L = 116 * fy - 16;
  const a = 500 * (fx - fy);
  const bVal = 200 * (fy - fz);

  return [L, a, bVal];
}

/**
 * Chroma (sytost) v prostoru Lab: sqrt(a² + b²).
 */
export function labChroma([L, a, b]) {
  return Math.hypot(a, b);
}

/**
 * Barevná odchylka CIE76 (euklidovská vzdálenost v Lab).
 */
export function deltaE([L1, a1, b1], [L2, a2, b2]) {
  return Math.hypot(L1 - L2, a1 - a2, b1 - b2);
}

/**
 * Odhad barvy papíru = medián nejjasnějších ~10 % pixelů v obdélníku rect.
 * img = { width, height, data: Uint8ClampedArray RGBA }
 * rect = { x, y, w, h } v pixelech (výchozí celý obrázek).
 */
export function estimateWhite(img, rect = null) {
  const { width: W, height: H, data } = img;
  const rx = rect ? Math.max(0, Math.floor(rect.x)) : 0;
  const ry = rect ? Math.max(0, Math.floor(rect.y)) : 0;
  const rw = rect ? Math.min(W - rx, Math.floor(rect.w)) : W;
  const rh = rect ? Math.min(H - ry, Math.floor(rect.h)) : H;

  if (rw <= 0 || rh <= 0) return { r: 255, g: 255, b: 255 };

  const total = rw * rh;
  const k = Math.max(1, Math.round(total * 0.1));

  // Histogram jasu (r + g + b ∈ [0, 765])
  const histB = new Int32Array(766);
  for (let y = ry; y < ry + rh; y++) {
    const rowOff = y * W;
    for (let x = rx; x < rx + rw; x++) {
      const idx = (rowOff + x) * 4;
      histB[data[idx] + data[idx + 1] + data[idx + 2]]++;
    }
  }

  // Nalezení prahu pro horních k pixelů
  let count = 0;
  let T = 765;
  for (; T >= 0; T--) {
    count += histB[T];
    if (count >= k) break;
  }

  const countStrict = count - histB[T];
  const needExact = k - countStrict;

  // Sběr histogramů kanálů R, G, B pro vybraných k pixelů
  const histR = new Int32Array(256);
  const histG = new Int32Array(256);
  const histBch = new Int32Array(256);
  let takenExact = 0;

  for (let y = ry; y < ry + rh; y++) {
    const rowOff = y * W;
    for (let x = rx; x < rx + rw; x++) {
      const idx = (rowOff + x) * 4;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];
      const br = r + g + b;
      if (br > T) {
        histR[r]++; histG[g]++; histBch[b]++;
      } else if (br === T && takenExact < needExact) {
        histR[r]++; histG[g]++; histBch[b]++;
        takenExact++;
      }
    }
  }

  function histMedian(h, n) {
    const mid1 = Math.floor((n - 1) / 2);
    const mid2 = Math.floor(n / 2);
    let acc = 0, v1 = -1, v2 = -1;
    for (let i = 0; i < 256; i++) {
      acc += h[i];
      if (v1 === -1 && acc > mid1) v1 = i;
      if (v2 === -1 && acc > mid2) { v2 = i; break; }
    }
    return Math.round((v1 + v2) / 2);
  }

  return {
    r: histMedian(histR, k),
    g: histMedian(histG, k),
    b: histMedian(histBch, k),
  };
}

/**
 * Vyvážení bílé: nový obrázek se škálovanými kanály tak, aby white → (245, 245, 245).
 */
export function whiteBalance(img, white) {
  const { width: W, height: H, data: src } = img;
  const out = new Uint8ClampedArray(src.length);
  const kr = (white && white.r > 0) ? 245 / white.r : 1;
  const kg = (white && white.g > 0) ? 245 / white.g : 1;
  const kb = (white && white.b > 0) ? 245 / white.b : 1;

  for (let i = 0; i < src.length; i += 4) {
    out[i] = src[i] * kr;
    out[i + 1] = src[i + 1] * kg;
    out[i + 2] = src[i + 2] * kb;
    out[i + 3] = src[i + 3];
  }
  return { width: W, height: H, data: out };
}

/**
 * Vzorkování barvy fixy z kalibračního pole.
 * Medián Lab pixelů v rect, které jsou „inkoust“: chroma ≥ 12 NEBO L < 70.
 * null když je takových pixelů < 20.
 */
export function sampleInk(img, rect) {
  const { width: W, height: H, data } = img;
  const rx = Math.max(0, Math.floor(rect.x));
  const ry = Math.max(0, Math.floor(rect.y));
  const rw = Math.min(W - rx, Math.floor(rect.w));
  const rh = Math.min(H - ry, Math.floor(rect.h));

  if (rw <= 0 || rh <= 0) return null;

  const Ls = [];
  const As = [];
  const Bs = [];
  const Rs = [];
  const Gs = [];
  const BsRgb = [];

  for (let y = ry; y < ry + rh; y++) {
    const rowOff = y * W;
    for (let x = rx; x < rx + rw; x++) {
      const idx = (rowOff + x) * 4;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];
      const [L, a, bVal] = srgbToLab(r, g, b);
      const chroma = Math.hypot(a, bVal);
      if (chroma >= 12 || L < 70) {
        Ls.push(L); As.push(a); Bs.push(bVal);
        Rs.push(r); Gs.push(g); BsRgb.push(b);
      }
    }
  }

  const n = Ls.length;
  if (n < 20) return null;

  function median(arr) {
    arr.sort((x, y) => x - y);
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 === 1 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
  }

  return {
    lab: [median(Ls), median(As), median(Bs)],
    rgb: [median(Rs), median(Gs), median(BsRgb)],
    n,
  };
}

/**
 * Klasifikace pixelů podle barev fix.
 * inks = [{lab:[L,a,b]}]
 * Výsledek: Uint8Array(width * height): 0 = nic, k+1 = inkoust k. Mimo rect 0.
 * opts = { minChroma: 14, maxDist: 40 }
 */
export function classifyInks(img, rect, inks, opts = {}) {
  const { width: W, height: H, data } = img;
  const out = new Uint8Array(W * H);
  if (!inks || inks.length === 0) return out;

  const minChroma = opts.minChroma ?? 14;
  const maxDist = opts.maxDist ?? 40;
  const minChroma2 = minChroma * minChroma;
  const maxDist2 = maxDist * maxDist;

  const numInks = inks.length;
  const inkL = new Float64Array(numInks);
  const inkA = new Float64Array(numInks);
  const inkB = new Float64Array(numInks);
  for (let k = 0; k < numInks; k++) {
    const lab = inks[k].lab || inks[k];
    inkL[k] = lab[0];
    inkA[k] = lab[1];
    inkB[k] = lab[2];
  }

  const rx = rect ? Math.max(0, Math.floor(rect.x)) : 0;
  const ry = rect ? Math.max(0, Math.floor(rect.y)) : 0;
  const rw = rect ? Math.min(W - rx, Math.floor(rect.w)) : W;
  const rh = rect ? Math.min(H - ry, Math.floor(rect.h)) : H;

  for (let y = ry; y < ry + rh; y++) {
    const rowOff = y * W;
    for (let x = rx; x < rx + rw; x++) {
      const pIdx = rowOff + x;
      const idx = pIdx * 4;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];

      // Rychlý převod na Lab přes LUT bez alokací
      const rL = SRGB_TO_LIN[r];
      const gL = SRGB_TO_LIN[g];
      const bL = SRGB_TO_LIN[b];

      const X = 0.4124564 * rL + 0.3575761 * gL + 0.1804375 * bL;
      const Y = 0.2126729 * rL + 0.7151522 * gL + 0.0721750 * bL;
      const Z = 0.0193339 * rL + 0.1191920 * gL + 0.9503041 * bL;

      const xr = X / XN, yr = Y / YN, zr = Z / ZN;
      const fx = xr > EPS ? Math.cbrt(xr) : (KAPPA * xr + 16) / 116;
      const fy = yr > EPS ? Math.cbrt(yr) : (KAPPA * yr + 16) / 116;
      const fz = zr > EPS ? Math.cbrt(zr) : (KAPPA * zr + 16) / 116;

      const L = 116 * fy - 16;
      const a = 500 * (fx - fy);
      const bVal = 200 * (fy - fz);

      const chroma2 = a * a + bVal * bVal;
      if (chroma2 < minChroma2) continue;

      let bestDist2 = Infinity;
      let bestK = -1;

      for (let k = 0; k < numInks; k++) {
        const dL = (L - inkL[k]) * 0.5;
        const da = a - inkA[k];
        const db = bVal - inkB[k];
        const d2 = dL * dL + da * da + db * db;
        if (d2 < bestDist2) {
          bestDist2 = d2;
          bestK = k;
        }
      }

      if (bestDist2 <= maxDist2) {
        out[pIdx] = bestK + 1;
      }
    }
  }

  return out;
}

/**
 * Vyčištění binární masky:
 * 1) morfologické uzavření (dilatace + eroze) s poloměrem close px (spojí přerušené čáry)
 * 2) odstranění 8-souvislých komponent menších než minArea px.
 * Vrací Uint8Array(w * h) s hodnotami 0 nebo 1.
 */
export function cleanMask(mask, w, h, { minArea = 12, close = 1 } = {}) {
  let curr = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (mask[i] !== 0) curr[i] = 1;
  }

  if (close > 0) {
    const tmp = new Uint8Array(w * h);
    const dilated = new Uint8Array(w * h);

    // Separabilní dilatace (horizontální)
    for (let y = 0; y < h; y++) {
      const rowOff = y * w;
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - close);
        const x1 = Math.min(w - 1, x + close);
        let val = 0;
        for (let nx = x0; nx <= x1; nx++) {
          if (curr[rowOff + nx] === 1) { val = 1; break; }
        }
        tmp[rowOff + x] = val;
      }
    }
    // Separabilní dilatace (vertikální)
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        const y0 = Math.max(0, y - close);
        const y1 = Math.min(h - 1, y + close);
        let val = 0;
        for (let ny = y0; ny <= y1; ny++) {
          if (tmp[ny * w + x] === 1) { val = 1; break; }
        }
        dilated[y * w + x] = val;
      }
    }

    const eroded = new Uint8Array(w * h);
    // Separabilní eroze (horizontální)
    for (let y = 0; y < h; y++) {
      const rowOff = y * w;
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - close);
        const x1 = Math.min(w - 1, x + close);
        let val = 1;
        for (let nx = x0; nx <= x1; nx++) {
          if (dilated[rowOff + nx] === 0) { val = 0; break; }
        }
        tmp[rowOff + x] = val;
      }
    }
    // Separabilní eroze (vertikální)
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        const y0 = Math.max(0, y - close);
        const y1 = Math.min(h - 1, y + close);
        let val = 1;
        for (let ny = y0; ny <= y1; ny++) {
          if (tmp[ny * w + x] === 0) { val = 0; break; }
        }
        eroded[y * w + x] = val;
      }
    }

    curr = eroded;
  }

  // 2) Odstranění 8-souvislých komponent menších než minArea
  if (minArea > 1) {
    const visited = new Uint8Array(w * h);
    const queue = new Int32Array(w * h);
    const comp = new Int32Array(w * h);

    for (let i = 0; i < w * h; i++) {
      if (curr[i] === 1 && visited[i] === 0) {
        let qHead = 0, qTail = 0;
        let cCount = 0;
        visited[i] = 1;
        queue[qTail++] = i;
        comp[cCount++] = i;

        while (qHead < qTail) {
          const idx = queue[qHead++];
          const cy = Math.floor(idx / w);
          const cx = idx % w;

          const y0 = Math.max(0, cy - 1);
          const y1 = Math.min(h - 1, cy + 1);
          const x0 = Math.max(0, cx - 1);
          const x1 = Math.min(w - 1, cx + 1);

          for (let ny = y0; ny <= y1; ny++) {
            const rowOff = ny * w;
            for (let nx = x0; nx <= x1; nx++) {
              const nidx = rowOff + nx;
              if (curr[nidx] === 1 && visited[nidx] === 0) {
                visited[nidx] = 1;
                queue[qTail++] = nidx;
                comp[cCount++] = nidx;
              }
            }
          }
        }

        if (cCount < minArea) {
          for (let c = 0; c < cCount; c++) {
            curr[comp[c]] = 0;
          }
        }
      }
    }
  }

  return curr;
}

/**
 * Binární maska pro daný štítek (1 kde labels === k, jinak 0).
 */
export function maskFromLabels(labels, k) {
  const n = labels.length;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (labels[i] === k) out[i] = 1;
  }
  return out;
}
