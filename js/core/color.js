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
 * Lokální (mřížkové) vyvážení bílé: rozdělí obrázek na dlaždice, odhadne lokální bílou
 * (eliminuje stín ruky/telefonu nebo nerovnoměrné světlo v lese) a bilineárně ji interpoluje.
 */
export function whiteBalanceLocal(img, globalWhite = null, { gridX = 4, gridY = 6 } = {}) {
  const { width: W, height: H, data: src } = img;
  const baseWhite = globalWhite || estimateWhite(img);
  const gxN = Math.max(1, Math.min(gridX, Math.floor(W / 20)));
  const gyN = Math.max(1, Math.min(gridY, Math.floor(H / 20)));

  if (gxN <= 1 && gyN <= 1) {
    return whiteBalance(img, baseWhite);
  }

  const baseR = baseWhite.r > 0 ? baseWhite.r : 245;
  const baseG = baseWhite.g > 0 ? baseWhite.g : 245;
  const baseB = baseWhite.b > 0 ? baseWhite.b : 245;

  const clampChannel = (val, base) => {
    const minV = Math.max(40, base * 0.55);
    const maxV = Math.min(255, Math.max(minV, base * 1.25));
    return Math.max(minV, Math.min(maxV, val));
  };

  const rawR = new Float64Array(gxN * gyN);
  const rawG = new Float64Array(gxN * gyN);
  const rawB = new Float64Array(gxN * gyN);

  for (let gy = 0; gy < gyN; gy++) {
    const y0 = Math.floor((gy * H) / gyN);
    const y1 = Math.floor(((gy + 1) * H) / gyN);
    for (let gx = 0; gx < gxN; gx++) {
      const x0 = Math.floor((gx * W) / gxN);
      const x1 = Math.floor(((gx + 1) * W) / gxN);
      const wt = estimateWhite(img, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
      const idx = gy * gxN + gx;
      rawR[idx] = clampChannel(wt.r, baseR);
      rawG[idx] = clampChannel(wt.g, baseG);
      rawB[idx] = clampChannel(wt.b, baseB);
    }
  }

  // Vyhlazení mřížky 3×3 průměrem sousedních buněk
  const smR = new Float64Array(gxN * gyN);
  const smG = new Float64Array(gxN * gyN);
  const smB = new Float64Array(gxN * gyN);

  for (let gy = 0; gy < gyN; gy++) {
    for (let gx = 0; gx < gxN; gx++) {
      let sR = 0, sG = 0, sB = 0, cnt = 0;
      for (let ny = Math.max(0, gy - 1); ny <= Math.min(gyN - 1, gy + 1); ny++) {
        for (let nx = Math.max(0, gx - 1); nx <= Math.min(gxN - 1, gx + 1); nx++) {
          const idx = ny * gxN + nx;
          sR += rawR[idx];
          sG += rawG[idx];
          sB += rawB[idx];
          cnt++;
        }
      }
      const idx = gy * gxN + gx;
      smR[idx] = sR / cnt;
      smG[idx] = sG / cnt;
      smB[idx] = sB / cnt;
    }
  }

  // Předvýpočet souřadnic pro rychlou bilineární interpolaci
  const x0Arr = new Int32Array(W);
  const x1Arr = new Int32Array(W);
  const txArr = new Float64Array(W);
  for (let x = 0; x < W; x++) {
    const fx = Math.max(0, Math.min(gxN - 1, ((x + 0.5) * gxN) / W - 0.5));
    const x0 = Math.floor(fx);
    const x1 = Math.min(gxN - 1, x0 + 1);
    x0Arr[x] = x0;
    x1Arr[x] = x1;
    txArr[x] = fx - x0;
  }

  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < H; y++) {
    const fy = Math.max(0, Math.min(gyN - 1, ((y + 0.5) * gyN) / H - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(gyN - 1, y0 + 1);
    const ty = fy - y0;
    const ity = 1 - ty;
    const rOff0 = y0 * gxN;
    const rOff1 = y1 * gxN;
    const rowPxOff = y * W;

    for (let x = 0; x < W; x++) {
      const x0 = x0Arr[x], x1 = x1Arr[x], tx = txArr[x], itx = 1 - tx;
      const i00 = rOff0 + x0, i10 = rOff0 + x1;
      const i01 = rOff1 + x0, i11 = rOff1 + x1;
      const w00 = itx * ity, w10 = tx * ity, w01 = itx * ty, w11 = tx * ty;

      const wr = w00 * smR[i00] + w10 * smR[i10] + w01 * smR[i01] + w11 * smR[i11];
      const wg = w00 * smG[i00] + w10 * smG[i10] + w01 * smG[i01] + w11 * smG[i11];
      const wb = w00 * smB[i00] + w10 * smB[i10] + w01 * smB[i01] + w11 * smB[i11];

      const pIdx = (rowPxOff + x) * 4;
      out[pIdx] = src[pIdx] * (245 / wr);
      out[pIdx + 1] = src[pIdx + 1] * (245 / wg);
      out[pIdx + 2] = src[pIdx + 2] * (245 / wb);
      out[pIdx + 3] = src[pIdx + 3];
    }
  }

  return { width: W, height: H, data: out };
}

/**
 * Vyvážení bílé: nový obrázek se škálovanými kanály tak, aby white → (245, 245, 245).
 * Při opts.local === true na dostatečně velkém obrázku použije lokální mřížkové vyvážení.
 */
export function whiteBalance(img, white, opts = {}) {
  if (opts && opts.local === true && img.width >= 120 && img.height >= 120) {
    return whiteBalanceLocal(img, white, opts);
  }

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
 * Preferuje syté pixely inkoustu (chroma ≥ 12), jinak vezme i tmavé méně syté (chroma ≥ 5, L < 65).
 * Vrací {lab, rgb, chroma, n} nebo null když je vhodných pixelů < 20.
 */
export function sampleInk(img, rect) {
  const { width: W, height: H, data } = img;
  const rx = Math.max(0, Math.floor(rect.x));
  const ry = Math.max(0, Math.floor(rect.y));
  const rw = Math.min(W - rx, Math.floor(rect.w));
  const rh = Math.min(H - ry, Math.floor(rect.h));

  if (rw <= 0 || rh <= 0) return null;

  const satLs = [], satAs = [], satBs = [], satRs = [], satGs = [], satBsRgb = [];
  const darkLs = [], darkAs = [], darkBs = [], darkRs = [], darkGs = [], darkBsRgb = [];

  for (let y = ry; y < ry + rh; y++) {
    const rowOff = y * W;
    for (let x = rx; x < rx + rw; x++) {
      const idx = (rowOff + x) * 4;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];
      const [L, a, bVal] = srgbToLab(r, g, b);
      const chroma = Math.hypot(a, bVal);
      if (chroma >= 12) {
        satLs.push(L); satAs.push(a); satBs.push(bVal);
        satRs.push(r); satGs.push(g); satBsRgb.push(b);
      } else if (chroma >= 5 && L < 65) {
        darkLs.push(L); darkAs.push(a); darkBs.push(bVal);
        darkRs.push(r); darkGs.push(g); darkBsRgb.push(b);
      }
    }
  }

  let Ls, As, Bs, Rs, Gs, BsRgb;
  if (satLs.length >= 20) {
    Ls = satLs; As = satAs; Bs = satBs; Rs = satRs; Gs = satGs; BsRgb = satBsRgb;
  } else if (satLs.length + darkLs.length >= 20) {
    Ls = satLs.concat(darkLs);
    As = satAs.concat(darkAs);
    Bs = satBs.concat(darkBs);
    Rs = satRs.concat(darkRs);
    Gs = satGs.concat(darkGs);
    BsRgb = satBsRgb.concat(darkBsRgb);
  } else {
    return null;
  }

  const n = Ls.length;

  function median(arr) {
    arr.sort((x, y) => x - y);
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 === 1 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
  }

  const lab = [median(Ls), median(As), median(Bs)];
  return {
    lab,
    rgb: [median(Rs), median(Gs), median(BsRgb)],
    chroma: Math.hypot(lab[1], lab[2]),
    n,
  };
}

/**
 * Převede referenční obrázek mapy do plochého pole CIE Lab (Float32Array délky w*h*3).
 * Bílou digitální mapy (255) přeškáluje na 245, aby odpovídala cílovému papíru po whiteBalance.
 */
function buildRefLab(refMap) {
  const { width: W, height: H, data } = refMap;
  const n = W * H;
  const out = new Float32Array(n * 3);
  const scale = 245 / 255;

  for (let i = 0; i < n; i++) {
    const idx = i * 4;
    const rL = SRGB_TO_LIN[Math.round(data[idx] * scale)];
    const gL = SRGB_TO_LIN[Math.round(data[idx + 1] * scale)];
    const bL = SRGB_TO_LIN[Math.round(data[idx + 2] * scale)];

    const X = 0.4124564 * rL + 0.3575761 * gL + 0.1804375 * bL;
    const Y = 0.2126729 * rL + 0.7151522 * gL + 0.0721750 * bL;
    const Z = 0.0193339 * rL + 0.1191920 * gL + 0.9503041 * bL;

    const xr = X / XN, yr = Y / YN, zr = Z / ZN;
    const fx = xr > EPS ? Math.cbrt(xr) : (KAPPA * xr + 16) / 116;
    const fy = yr > EPS ? Math.cbrt(yr) : (KAPPA * yr + 16) / 116;
    const fz = zr > EPS ? Math.cbrt(zr) : (KAPPA * zr + 16) / 116;

    const o = i * 3;
    out[o] = 116 * fy - 16;
    out[o + 1] = 500 * (fx - fy);
    out[o + 2] = 200 * (fy - fz);
  }
  return out;
}

/**
 * Zjistí, zda pixel (Lp, ap, bp) odpovídá barevnému podkladu čisté referenční mapy v okolí (cx, cy).
 * Zohledňuje jak přímou barevnou vzdálenost v Lab, tak gamutovou kompresi tiskárny (desaturaci odstínu).
 */
function matchesRefBackground(Lp, ap, bp, refLab, refW, refH, cx, cy, bgRadius, bgMinDiff2, perpLimit2) {
  const y0 = Math.max(0, cy - bgRadius);
  const y1 = Math.min(refH - 1, cy + bgRadius);
  const x0 = Math.max(0, cx - bgRadius);
  const x1 = Math.min(refW - 1, cx + bgRadius);

  const checkPixel = (o) => {
    const Lr = refLab[o];
    const ar = refLab[o + 1];
    const br = refLab[o + 2];

    // 1) Přímá vážená vzdálenost v Lab (světlost L má vyšší váhu 0.7, aby tmavší fixa nad světlým lesem prošla)
    const dL = (Lp - Lr) * 0.7;
    const da = ap - ar;
    const db = bp - br;
    if (dL * dL + da * da + db * db <= bgMinDiff2) {
      return true;
    }

    // 2) Model tiskové desaturace: barevný prvek mapy (Cr >= 8) vytištěný s nižší sytostí, ale stejným odstínem
    const Cr2 = ar * ar + br * br;
    if (Cr2 >= 64) {
      const dot = ap * ar + bp * br;
      if (dot > 0) {
        const t = dot / Cr2;
        if (t >= 0.30 && t <= 1.25 && Lp >= Lr - 18 && Lp <= Lr + 25) {
          const pa = ap - t * ar;
          const pb = bp - t * br;
          if (pa * pa + pb * pb <= perpLimit2) {
            return true;
          }
        }
      }
    }
    return false;
  };

  // Nejdříve zkontrolujeme přesný střed (rychlý early-exit)
  if (checkPixel((cy * refW + cx) * 3)) return true;

  for (let ny = y0; ny <= y1; ny++) {
    const rowOff = ny * refW;
    for (let nx = x0; nx <= x1; nx++) {
      if (nx === cx && ny === cy) continue;
      if (checkPixel((rowOff + nx) * 3)) return true;
    }
  }
  return false;
}

/**
 * Klasifikace pixelů podle barev fix.
 * inks = [{lab:[L,a,b]}]
 * Výsledek: Uint8Array(width * height): 0 = nic, k+1 = inkoust k. Mimo rect 0.
 * opts = { minChroma: 14, maxDist: 40, refMap: null, refRect: null, bgMinDiff: 18, bgRadius: 3 }
 */
export function classifyInks(img, rect, inks, opts = {}) {
  const { width: W, height: H, data } = img;
  const out = new Uint8Array(W * H);
  if (!inks || inks.length === 0) return out;

  const minChroma = opts.minChroma ?? 14;
  const maxDist = opts.maxDist ?? 40;
  const minChroma2 = minChroma * minChroma;
  const maxDist2 = maxDist * maxDist;
  const lowChromaMaxDist2 = (maxDist * 0.65) * (maxDist * 0.65);

  const numInks = inks.length;
  const inkL = new Float64Array(numInks);
  const inkA = new Float64Array(numInks);
  const inkB = new Float64Array(numInks);
  let minCalibChroma = Infinity;
  for (let k = 0; k < numInks; k++) {
    const lab = inks[k].lab || inks[k];
    inkL[k] = lab[0];
    inkA[k] = lab[1];
    inkB[k] = lab[2];
    const c = Math.hypot(lab[1], lab[2]);
    if (c < minCalibChroma) minCalibChroma = c;
  }

  // Sjednocení s kalibrací: pokud je některá kalibrovaná fixa tmavá/méně sytá, snížíme práh,
  // ale pod minChroma vyžadujeme těsnější shodu odstínu, abychom nezachytili šedotónový tisk.
  const effMinChroma = Math.min(minChroma, Math.max(6, minCalibChroma * 0.7));
  const effMinChroma2 = effMinChroma * effMinChroma;

  const rx = rect ? Math.max(0, Math.floor(rect.x)) : 0;
  const ry = rect ? Math.max(0, Math.floor(rect.y)) : 0;
  const rw = rect ? Math.min(W - rx, Math.floor(rect.w)) : W;
  const rh = rect ? Math.min(H - ry, Math.floor(rect.h)) : H;

  // Volitelná korekce barevné mapy (odečítání referenčního podkladu)
  const refMap = opts.refMap && opts.refMap.width > 0 && opts.refMap.height > 0 ? opts.refMap : null;
  let refLab = null;
  let refW = 0, refH = 0;
  let refX0 = rx, refY0 = ry, refRectW = rw, refRectH = rh;
  const bgMinDiff = opts.bgMinDiff ?? 18;
  const bgMinDiff2 = bgMinDiff * bgMinDiff;
  const perpLimit2 = (bgMinDiff * 0.65) * (bgMinDiff * 0.65);
  const bgRadius = Math.max(0, Math.round(opts.bgRadius ?? 3));

  if (refMap) {
    refW = refMap.width;
    refH = refMap.height;
    refLab = buildRefLab(refMap);
    if (opts.refRect) {
      refX0 = opts.refRect.x;
      refY0 = opts.refRect.y;
      refRectW = Math.max(1, opts.refRect.w);
      refRectH = Math.max(1, opts.refRect.h);
    }
  }

  for (let y = ry; y < ry + rh; y++) {
    const rowOff = y * W;
    const cy = refLab
      ? Math.max(0, Math.min(refH - 1, Math.round(((y - refY0 + 0.5) * refH) / refRectH - 0.5)))
      : 0;
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
      if (chroma2 < effMinChroma2) continue;

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

      const limit2 = chroma2 < minChroma2 ? lowChromaMaxDist2 : maxDist2;
      if (bestDist2 <= limit2) {
        if (refLab) {
          const cx = Math.max(0, Math.min(refW - 1, Math.round(((x - refX0 + 0.5) * refW) / refRectW - 0.5)));
          if (matchesRefBackground(L, a, bVal, refLab, refW, refH, cx, cy, bgRadius, bgMinDiff2, perpLimit2)) {
            continue;
          }
        }
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
