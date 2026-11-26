// js/ui/evaluate.js
// Vyhodnocovací modul orientační hry Stopovačka (ES moduly, iPhone Safari / GitHub Pages)
// Čisté UI komponenty pro vyhodnocení archů, detekci tras a výpočet skóre.

import { DEFAULT_OPTS, prepareTrack, evaluateSheet, renderOverlay, gameScore } from '../core/evaluate.js';
import { parseGpx } from '../core/gpx.js';
import { foreignTeams, layoutForProject } from '../core/layout.js';
import { renderMapToCanvas } from './sheet.js';

// Paměť pro fotky v plném rozlišení (neukládá se do localStorage kvůli limitům paměti)
const photosMap = new Map(); // teamIdx -> {width, height, data: Uint8ClampedArray}
const inMemoryResults = new Map(); // teamIdx -> SheetResult
let cachedRefMapKey = null;
let cachedRefMapData = null;

// Stav karet
const cardStatus = {}; // teamIdx -> 'idle' | 'processing' | 'done' | 'error'
const cardErrors = {}; // teamIdx -> string chyby
const cardNotes = {}; // teamIdx -> string upozornění (např. přesměrování archu)
const cardFilter = {}; // teamIdx -> number | null (filtr zobrazení cizího týmu)

let isBatchProcessing = false;
let batchProgressText = '';
let activeModalBackdrop = null;

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PRINT_MODE_LABELS = {
  grayscale: 'Šedotónová',
  colorFaded: 'Tlumená barevná',
  color: 'Plnobarevná',
};

const SHEET_OVERRIDE_PRESETS = [
  { value: 'A3|color', paper: 'A3', mapPrintMode: 'color', label: 'A3 · Plnobarevná' },
  { value: 'A3|colorFaded', paper: 'A3', mapPrintMode: 'colorFaded', label: 'A3 · Tlumená barevná' },
  { value: 'A3|grayscale', paper: 'A3', mapPrintMode: 'grayscale', label: 'A3 · Šedotónová' },
  { value: 'A4|grayscale', paper: 'A4', mapPrintMode: 'grayscale', label: 'A4 · Šedotónová (záložní)' },
  { value: 'A4|colorFaded', paper: 'A4', mapPrintMode: 'colorFaded', label: 'A4 · Tlumená barevná' },
  { value: 'A4|color', paper: 'A4', mapPrintMode: 'color', label: 'A4 · Plnobarevná' },
];

/**
 * Vrátí efektivní konfiguraci projektu pro vyhodnocení archu konkrétního týmu
 * (umožňuje kombinovat např. ostré barevné A3 a záložní černobílé A4 v jednom projektu).
 */
function getEffectiveProjectForTeam(project, teamIdx) {
  const ov = project?.sheetOverrides?.[teamIdx];
  if (!ov || (!ov.paper && !ov.mapPrintMode)) return project;
  return {
    ...project,
    paper: ov.paper || project.paper || 'A4',
    mapPrintMode: ov.mapPrintMode || project.mapPrintMode || 'grayscale',
  };
}

function getSheetOverrideValue(project, teamIdx) {
  const ov = project?.sheetOverrides?.[teamIdx];
  if (!ov || !ov.paper || !ov.mapPrintMode) return 'default';
  return `${ov.paper}|${ov.mapPrintMode}`;
}

function formatSheetSpec(paper, mapPrintMode) {
  const p = paper || 'A4';
  const m = PRINT_MODE_LABELS[mapPrintMode || 'grayscale'] || 'Šedotónová';
  return `${p} · ${m}`;
}

/**
 * Získání nastavení vyhodnocení s výchozími hodnotami z DEFAULT_OPTS
 */
function getEvalOpts(project) {
  const p = project.evalOpts || {};
  const isColorMap = project.mapPrintMode === 'color' || project.mapPrintMode === 'colorFaded';
  const defMinChroma = isColorMap ? 18 : DEFAULT_OPTS.minChroma;
  const defMaxDist = isColorMap ? 36 : DEFAULT_OPTS.maxDist;
  return {
    ...DEFAULT_OPTS,
    tolM: Number.isFinite(p.tolM) ? p.tolM : DEFAULT_OPTS.tolM,
    maxTolM: Number.isFinite(p.maxTolM) ? p.maxTolM : DEFAULT_OPTS.maxTolM,
    wrongPenalty: Number.isFinite(p.wrongPenalty) ? p.wrongPenalty : DEFAULT_OPTS.wrongPenalty,
    stealthRefTracking: Number.isFinite(p.stealthRefTracking) ? p.stealthRefTracking : DEFAULT_OPTS.stealthRefTracking,
    minChroma: Number.isFinite(p.minChroma) ? p.minChroma : defMinChroma,
    maxDist: Number.isFinite(p.maxDist) ? p.maxDist : defMaxDist,
    minArea: Number.isFinite(p.minArea) ? p.minArea : DEFAULT_OPTS.minArea,
    allowedGapMin: Number.isFinite(p.allowedGapMin) ? p.allowedGapMin : 5,
    penaltyPerMin: Number.isFinite(p.penaltyPerMin) ? p.penaltyPerMin : 0,
  };
}

/**
 * Načte data URL obrázku do RGBA ImageData o zadaných rozměrech.
 */
async function decodeDataUrlToRgba(dataUrl, targetW, targetH, applyFaded = false) {
  const img = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('Nepodařilo se dekódovat referenční mapu.'));
    el.src = dataUrl;
  });

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, targetW, targetH);
  ctx.drawImage(img, 0, 0, targetW, targetH);

  const imgData = ctx.getImageData(0, 0, targetW, targetH);
  if (applyFaded) {
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      d[i] = Math.round(gray + 0.6 * (d[i] - gray));
      d[i + 1] = Math.round(gray + 0.6 * (d[i + 1] - gray));
      d[i + 2] = Math.round(gray + 0.6 * (d[i + 2] - gray));
    }
  }
  return { width: targetW, height: targetH, data: imgData.data };
}

/**
 * Připraví referenční obrázek čisté barevné mapy pro odečítání podkladu.
 * Pro šedotónovou mapu vrací vždy null (stávající chování zůstává beze změny).
 */
async function buildRefMapImageData(effectiveProject, ppm = DEFAULT_OPTS.ppm, baseProject = null) {
  const printMode = effectiveProject?.mapPrintMode || 'grayscale';
  const isColorMap = printMode === 'color' || printMode === 'colorFaded';
  if (!isColorMap || !effectiveProject?.map) return null;

  const layout = layoutForProject(effectiveProject);
  const mapW = Math.max(1, Math.round(layout.mapRect.w * ppm));
  const mapH = Math.max(1, Math.round(layout.mapRect.h * ppm));

  const m = effectiveProject.map;
  const sameAsBaseMode = !baseProject || (baseProject.mapPrintMode || 'grayscale') === printMode;
  const cacheKey = `${printMode}|${m.kind}|${m.tileUrl || ''}|${JSON.stringify(m.georef || null)}|${sameAsBaseMode && m.renderedDataUrl ? m.renderedDataUrl.length : 0}|${m.imageDataUrl ? m.imageDataUrl.length : 0}|${mapW}x${mapH}`;
  if (cachedRefMapKey === cacheKey && cachedRefMapData) {
    return cachedRefMapData;
  }

  try {
    let refData = null;
    if (sameAsBaseMode && m.renderedDataUrl) {
      refData = await decodeDataUrlToRgba(m.renderedDataUrl, mapW, mapH, false);
    } else if (m.kind === 'tiles' && m.georef) {
      const dataUrl = await renderMapToCanvas(m, printMode);
      if (dataUrl) {
        if (sameAsBaseMode) m.renderedDataUrl = dataUrl;
        refData = await decodeDataUrlToRgba(dataUrl, mapW, mapH, false);
      }
    } else if (m.kind === 'image' && m.imageDataUrl) {
      refData = await decodeDataUrlToRgba(m.imageDataUrl, mapW, mapH, printMode === 'colorFaded');
    }

    if (refData) {
      cachedRefMapKey = cacheKey;
      cachedRefMapData = refData;
    }
    return refData;
  } catch (err) {
    console.warn('Nepodařilo se připravit referenční barevnou mapu:', err);
    return null;
  }
}

/**
 * Načtení fotky ze souboru se zmenšením na maxDim (≤ 3000 px) pro iPhone Safari canvas limit.
 * Respektuje EXIF orientaci přes createImageBitmap({imageOrientation:'from-image'}).
 * @param {File} file
 * @param {number} maxDim
 * @returns {Promise<{width: number, height: number, data: Uint8ClampedArray}>}
 */
async function loadImageDataFromFile(file, maxDim = 3000) {
  let source;
  let shouldClose = false;

  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
    shouldClose = true;
  } catch {
    try {
      source = await createImageBitmap(file);
      shouldClose = true;
    } catch {
      source = await new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          URL.revokeObjectURL(url);
          resolve(img);
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error('Nepodařilo se načíst soubor obrázku.'));
        };
        img.src = url;
      });
    }
  }

  const srcW = source.naturalWidth || source.width;
  const srcH = source.naturalHeight || source.height;

  let w = srcW;
  let h = srcH;
  if (w > maxDim || h > maxDim) {
    if (w >= h) {
      h = Math.round((h * maxDim) / w);
      w = maxDim;
    } else {
      w = Math.round((w * maxDim) / h);
      h = maxDim;
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, w, h);

  if (shouldClose && typeof source.close === 'function') {
    source.close();
  }

  const imgData = ctx.getImageData(0, 0, w, h);
  return {
    width: w,
    height: h,
    data: imgData.data,
  };
}

/**
 * Příprava GPX tras všech týmů z projektu
 */
function buildTracks(project, evalOpts) {
  const tracks = {};
  const missing = [];
  const errors = [];
  const n = project.teams ? project.teams.length : 0;

  for (let t = 0; t < n; t++) {
    const teamName = project.teams[t].name || `Tým ${t + 1}`;
    const gpxInfo = project.gpx && project.gpx[t];
    if (!gpxInfo || !gpxInfo.text) {
      missing.push(teamName);
      continue;
    }

    try {
      const parsed = parseGpx(gpxInfo.text);
      if (!parsed.points || !parsed.points.length) {
        errors.push(`GPX týmu ${teamName} neobsahuje žádné platné body.`);
        continue;
      }
      tracks[t] = prepareTrack(parsed, project, evalOpts);
    } catch (err) {
      errors.push(`Chyba zpracování GPX týmu ${teamName}: ${err.message}`);
    }
  }

  return { tracks, missing, errors };
}

/**
 * Uložení čistých číselných výsledků do project.results přes saveProject (bez objemných ImageData)
 */
function persistResults(project, sheetResults, tracks, evalOpts, saveProject) {
  const scoreRows = gameScore(project, sheetResults, tracks, {
    allowedGapMin: evalOpts.allowedGapMin,
    penaltyPerMin: evalOpts.penaltyPerMin,
    stealthRefTracking: evalOpts.stealthRefTracking,
  });

  const sheetsData = {};
  for (let i = 0; i < project.teams.length; i++) {
    const res = sheetResults[i];
    if (res) {
      sheetsData[i] = {
        team: res.team,
        usedRefMap: Boolean(res.usedRefMap),
        sheetPaper: res.layout?.paper || res.sheetPaper || null,
        sheetPrintMode: res.sheetPrintMode || null,
        warnings: res.warnings || [],
        registration: res.registration ? {
          markersCount: res.registration.markers ? res.registration.markers.length : 0,
          rmsMm: res.registration.rmsMm,
          pxPerMm: res.registration.pxPerMm,
        } : null,
        perTeam: (res.perTeam || []).map(p => ({
          team: p.team,
          score: p.score,
          skipped: p.skipped || false,
          recall: p.recall,
          precision: p.precision,
          f1: p.f1,
          nDrawnPx: p.nDrawnPx,
          nTrackPts: p.nTrackPts,
          trackInMapFrac: p.trackInMapFrac,
          medianDrawnErrM: p.medianDrawnErrM,
          medianTrackErrM: p.medianTrackErrM,
          error: p.error,
          inkRgb: p.ink ? p.ink.rgb : (p.inkRgb || null),
        })),
      };
    } else if (project.results?.sheets?.[i]) {
      sheetsData[i] = project.results.sheets[i];
    }
  }

  project.results = {
    updatedAt: Date.now(),
    sheets: sheetsData,
    game: scoreRows,
  };

  saveProject(project);
}

/**
 * Escapování hodnoty pro CSV export
 */
function csvEscape(val) {
  if (val == null) return '';
  const s = String(val);
  if (s.includes(';') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * Export celkových výsledků do formátu CSV (s UTF-8 BOM pro Excel)
 */
function exportResultsCsv(project, sheetResults, tracks, evalOpts) {
  const scoreRows = gameScore(project, sheetResults, tracks, {
    allowedGapMin: evalOpts.allowedGapMin,
    penaltyPerMin: evalOpts.penaltyPerMin,
    stealthRefTracking: evalOpts.stealthRefTracking,
  });

  const lines = [];
  lines.push(`VÝSLEDKY ORIENTAČNÍ HRY STOPOVAČKA`);
  lines.push(`Projekt;${csvEscape(project.name || 'Stopovačka')}`);
  lines.push(`Datum exportu;${csvEscape(new Date().toLocaleString('cs-CZ'))}`);
  lines.push(``);

  // 1. Celkové pořadí
  lines.push(`CELKOVÉ POŘADÍ HRY`);
  lines.push(`Pořadí;Tým;Stopování (body);Utajení (body);Výpadky GPX (min);Penalizace (body);Celkem (body)`);
  scoreRows.forEach((row, i) => {
    lines.push([
      `${i + 1}.`,
      csvEscape(row.name),
      row.tracking ?? 0,
      row.stealth != null ? row.stealth : '—',
      row.gapMin != null ? row.gapMin : '—',
      row.penalty ?? 0,
      row.total ?? 0,
    ].join(';'));
  });
  lines.push(``);

  // 2. Matice stopování
  lines.push(`MATICE STOPOVÁNÍ (KDO STOPOVAL KOHO)`);
  const teamHeaders = project.teams.map(t => csvEscape(t.name));
  lines.push([`Stopující tým`, ...teamHeaders, `Průměr (stopování)`].join(';'));

  project.teams.forEach((team, i) => {
    const row = scoreRows.find(r => r.team === i);
    const cells = [csvEscape(team.name)];
    project.teams.forEach((_, j) => {
      if (i === j) {
        cells.push('—');
      } else {
        const score = row?.detail?.[j];
        cells.push(score != null ? score : '—');
      }
    });
    cells.push(row?.tracking ?? '—');
    lines.push(cells.join(';'));
  });
  lines.push(``);

  // 3. Detailní metriky
  lines.push(`DETAILNÍ METRIKY JEDNOTLIVÝCH ARCHŮ`);
  lines.push(`Arch týmu;Cílový tým;Skóre (0-100);Pokrytí trasy Recall (%);Přesnost čar Precision (%);Odchylka čar (medián m);Odchylka trasy (medián m);Trasa v mapě (%);Stav`);

  project.teams.forEach((sheetTeam, i) => {
    const res = sheetResults[i] || project.results?.sheets?.[i];
    if (!res || !res.perTeam) {
      lines.push(`${csvEscape(sheetTeam.name)};—;—;—;—;—;—;—;Arch dosud nevyhodnocen`);
      return;
    }
    res.perTeam.forEach(p => {
      const targetTeam = project.teams[p.team];
      lines.push([
        csvEscape(sheetTeam.name),
        csvEscape(targetTeam ? targetTeam.name : `Tým ${p.team + 1}`),
        p.score != null ? p.score : '—',
        p.recall != null ? `${Math.round(p.recall * 100)} %` : '—',
        p.precision != null ? `${Math.round(p.precision * 100)} %` : '—',
        p.medianDrawnErrM != null ? p.medianDrawnErrM.toFixed(1) : '—',
        p.medianTrackErrM != null ? p.medianTrackErrM.toFixed(1) : '—',
        p.trackInMapFrac != null ? `${Math.round(p.trackInMapFrac * 100)} %` : '—',
        csvEscape(p.error || 'OK'),
      ].join(';'));
    });
  });

  if (Array.isArray(project.checkpoints) && project.checkpoints.length > 0) {
    lines.push(``);
    lines.push(`KONTROLA BODŮ POVINNÉHO PRŮCHODU (MIMO BODOVÁNÍ)`);
    const cpHeaders = project.checkpoints.map(cp => csvEscape(`${cp.name} (${cp.radiusM || 50} m)`));
    lines.push([`Tým`, ...cpHeaders].join(';'));
    project.teams.forEach((team, tIdx) => {
      const tr = tracks[tIdx];
      const cells = [csvEscape(team.name)];
      project.checkpoints.forEach((_, cpIdx) => {
        if (!tr) {
          cells.push('Chybí GPX');
          return;
        }
        const cpRes = tr.checkpoints?.[cpIdx];
        if (!cpRes || cpRes.minDistM == null) {
          cells.push('—');
        } else if (cpRes.passed) {
          cells.push(`Prošli (${Math.round(cpRes.minDistM)} m)`);
        } else {
          cells.push(`Neprošli (${Math.round(cpRes.minDistM)} m)`);
        }
      });
      lines.push(cells.join(';'));
    });
  }

  const csvContent = lines.join('\r\n');
  const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const safeName = (project.name || 'stopovacka').toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  a.download = `vysledky_${safeName}_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Pomocná funkce pro vygenerování barevného odznaku skóre
 */
function renderScoreBadge(score) {
  if (score == null || !Number.isFinite(score)) {
    return `<span class="score-badge" style="background:#f3f4f6; color:#9ca3af;">–</span>`;
  }
  let cls = 'score-low';
  if (score >= 70) cls = 'score-high';
  else if (score >= 40) cls = 'score-mid';
  return `<span class="score-badge ${cls}">${score} b</span>`;
}

/**
 * Zobrazení zvětšeného náhledu v modálním okně
 */
function openModal(title, sourceCanvas) {
  if (!activeModalBackdrop) {
    const backdrop = document.createElement('div');
    backdrop.className = 'eval-modal-backdrop';
    backdrop.innerHTML = `
      <div class="eval-modal-box">
        <div class="eval-modal-header">
          <div class="eval-modal-title" id="eval-modal-title-text"></div>
          <button type="button" class="btn btn-secondary btn-sm" id="eval-modal-btn-close">✕ Zavřít</button>
        </div>
        <div class="eval-modal-body">
          <canvas id="eval-modal-active-canvas"></canvas>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    activeModalBackdrop = backdrop;

    const close = () => {
      backdrop.style.display = 'none';
    };

    backdrop.querySelector('#eval-modal-btn-close').addEventListener('click', close);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && backdrop.style.display !== 'none') close();
    });
  }

  const titleEl = activeModalBackdrop.querySelector('#eval-modal-title-text');
  const modalCanvas = activeModalBackdrop.querySelector('#eval-modal-active-canvas');
  titleEl.textContent = title;

  modalCanvas.width = sourceCanvas.width;
  modalCanvas.height = sourceCanvas.height;
  const ctx = modalCanvas.getContext('2d');
  ctx.drawImage(sourceCanvas, 0, 0);

  activeModalBackdrop.style.display = 'flex';
}

/**
 * Hlavní montovací funkce rozhraní pro 5. záložku
 * @param {HTMLElement} sectionEl
 * @param {{getProject: function(): object, saveProject: function(object): boolean}} context
 */
export function mountEvaluate(sectionEl, { getProject, saveProject }) {
  if (!sectionEl) return;

  // Obnovení stavu z project.results při prvním načtení
  const initialProject = getProject();
  if (initialProject.results?.sheets) {
    for (const [tStr, sheetData] of Object.entries(initialProject.results.sheets)) {
      const t = Number(tStr);
      if (!inMemoryResults.has(t)) {
        inMemoryResults.set(t, sheetData);
      }
    }
  }

  function render() {
    const project = getProject();
    const evalOpts = getEvalOpts(project);
    const nTeams = project.teams ? project.teams.length : 0;
    const { tracks, missing: missingGpx, errors: gpxErrors } = buildTracks(project, evalOpts);

    // Vytvoření mapy výsledků pro gameScore
    const sheetResultsMap = {};
    for (let i = 0; i < nTeams; i++) {
      if (inMemoryResults.has(i)) {
        sheetResultsMap[i] = inMemoryResults.get(i);
      }
    }

    const hasAnyResults = Object.keys(sheetResultsMap).length > 0;
    const gameScoreRows = hasAnyResults
      ? gameScore(project, sheetResultsMap, tracks, {
          allowedGapMin: evalOpts.allowedGapMin,
          penaltyPerMin: evalOpts.penaltyPerMin,
          stealthRefTracking: evalOpts.stealthRefTracking,
        })
      : (project.results?.game || null);

    // Počítadla pro status bar
    const evaluatedCount = Object.keys(sheetResultsMap).length;
    const tracksCount = Object.keys(tracks).length;
    const mapReady = !!(project.map && project.map.georef);

    sectionEl.innerHTML = '';

    // 1. Horní lišta akcí a stavu
    const toolbar = document.createElement('div');
    toolbar.className = 'eval-toolbar';
    toolbar.innerHTML = `
      <div class="eval-stats-summary">
        <span class="eval-stat-item">Archy: <strong>${evaluatedCount} / ${nTeams}</strong></span>
        <span class="eval-stat-item">GPX trasy: <strong>${tracksCount} / ${nTeams}</strong></span>
        <span class="eval-stat-item">Mapa: <strong>${mapReady ? 'Připravena' : 'Chybí georeference'}</strong></span>
      </div>
      <div class="eval-toolbar-actions">
        <label class="btn btn-primary btn-sm" style="cursor:pointer;" title="Vyberte více fotek archů najednou">
          Nahrát fotky archů
          <input type="file" multiple accept="image/*" class="file-input-hidden" id="eval-global-upload-input" />
        </label>
        ${photosMap.size > 0 ? `<button type="button" class="btn btn-secondary btn-sm" id="eval-btn-recalc-all" title="Přepočítat všechny načtené fotky s aktuálním nastavením">Přepočítat (${photosMap.size})</button>` : ''}
        ${hasAnyResults ? `<button type="button" class="btn btn-secondary btn-sm" id="eval-btn-export-csv" title="Stáhnout tabulku výsledků v CSV">Exportovat CSV</button>` : ''}
      </div>
    `;
    sectionEl.appendChild(toolbar);

    // Globální indikátor hromadného zpracování
    if (isBatchProcessing) {
      const batchBox = document.createElement('div');
      batchBox.className = 'alert alert-info';
      batchBox.innerHTML = `Zpracovávám fotky: ${batchProgressText || 'Analyzuji značky a čáry…'}`;
      sectionEl.appendChild(batchBox);
    }

    // Upozornění na mapu a GPX
    if (!mapReady) {
      const alertMap = document.createElement('div');
      alertMap.className = 'alert alert-warning';
      alertMap.innerHTML = `V záložce „2. Mapa“ nastavte a georeferencujte mapu. Bez mapy nelze porovnat čáry s GPX.`;
      sectionEl.appendChild(alertMap);
    }

    if (missingGpx.length > 0) {
      const alertGpx = document.createElement('div');
      alertGpx.className = 'alert alert-warning';
      alertGpx.innerHTML = `Chybí GPX trasy pro týmy: ${missingGpx.join(', ')}.`;
      sectionEl.appendChild(alertGpx);
    }

    if (gpxErrors.length > 0) {
      const alertGpxErr = document.createElement('div');
      alertGpxErr.className = 'alert alert-danger';
      alertGpxErr.innerHTML = `Chyby v GPX trasách:<br>${gpxErrors.join('<br>')}`;
      sectionEl.appendChild(alertGpxErr);
    }

    const gapWarnings = [];
    for (let t = 0; t < nTeams; t++) {
      const tr = tracks[t];
      if (tr && tr.gaps && tr.gaps.length > 0) {
        const tName = escapeHtml(project.teams[t]?.name || `Tým ${t + 1}`);
        const gapMin = Math.max(1, Math.round(tr.gapS / 60));
        gapWarnings.push(`<strong>${tName}</strong> (${tr.gaps.length}×, cca ${gapMin} min)`);
      }
    }
    if (gapWarnings.length > 0) {
      const alertGap = document.createElement('div');
      alertGap.className = 'alert alert-warning';
      alertGap.innerHTML = `Zjištěn výpadek GPS v nahraných trasách: ${gapWarnings.join(', ')}. V případě potřeby můžete trasu ručně upravit v mapě a v záložce „4. GPX trasy“ nahrát opravené GPX.`;
      sectionEl.appendChild(alertGap);
    }

    // 2. Celkové pořadí hry (pokud jsou k dispozici výsledky)
    if (gameScoreRows && gameScoreRows.length > 0) {
      const scoreCard = document.createElement('div');
      scoreCard.className = 'card';
      scoreCard.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:12px;">
          <div>
            <h3 class="card-title" style="margin-bottom:0;">Celkové pořadí</h3>
          </div>
        </div>

        <div class="eval-table-wrap">
          <table class="eval-table">
            <thead>
              <tr>
                <th style="width:48px;">Pořadí</th>
                <th>Tým</th>
                <th class="th-num" title="Průměrné skóre z zakreslení cizích týmů (0–100)">Stopování</th>
                <th class="th-num" title="100 − průměr skóre, se kterým tým zakreslili ostatní; odemčeno stopováním (plné od ${evalOpts.stealthRefTracking} b)">Utajení</th>
                <th class="th-num" title="Součet výpadků GPX záznamu">Výpadky GPX</th>
                <th class="th-num" title="Penalizace za výpadky GPX nad ${evalOpts.allowedGapMin} min (${evalOpts.penaltyPerMin} b/min)">Penalizace</th>
                <th class="th-num" title="Celkové body týmu" style="font-weight:700;">Celkem</th>
              </tr>
            </thead>
            <tbody>
              ${gameScoreRows.map((r, rank) => {
                const teamObj = project.teams[r.team];
                const stealthHtml = r.stealth != null
                  ? (r.rawStealth != null && r.stealth < r.rawStealth
                      ? `<span title="Odemčeno podle stopování (${r.tracking}/${evalOpts.stealthRefTracking} b) – původně ${r.rawStealth} b">${renderScoreBadge(r.stealth)} <span style="font-size:11px; color:var(--text-muted);">(z ${r.rawStealth} b)</span></span>`
                      : renderScoreBadge(r.stealth))
                  : '<span style="color:var(--text-muted);">–</span>';
                return `
                  <tr style="${rank === 0 ? 'background-color: #f0fdf4; font-weight:600;' : ''}">
                    <td>${rank + 1}.</td>
                    <td>
                      <div style="display:flex; align-items:center; gap:8px;">
                        <span class="team-dot" style="background-color:${teamObj ? teamObj.color : '#888'};"></span>
                        <span>${escapeHtml(r.name)}</span>
                      </div>
                    </td>
                    <td class="num-cell">${renderScoreBadge(r.tracking)}</td>
                    <td class="num-cell">${stealthHtml}</td>
                    <td class="num-cell">${r.gapMin != null ? `${r.gapMin} min` : '<span style="color:var(--text-muted);">–</span>'}</td>
                    <td class="num-cell" style="${r.penalty > 0 ? 'color:var(--danger); font-weight:600;' : ''}">
                      ${r.penalty > 0 ? `-${r.penalty} b` : '0 b'}
                    </td>
                    <td class="num-cell" style="font-size:15px; font-weight:700; color:var(--primary);">
                      ${r.total} b
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>

        <!-- Matice detailu: kdo stopoval koho -->
        <h4 style="font-size:14px; font-weight:600; margin-top:20px; margin-bottom:8px; color:var(--text-main);">
          Matice stopování
        </h4>
        <div class="eval-table-wrap">
          <table class="eval-table" style="font-size:12px;">
            <thead>
              <tr>
                <th>Stopující tým</th>
                ${project.teams.map(t => `<th class="th-num" style="min-width:70px;">${t.name}</th>`).join('')}
                <th class="th-num" style="min-width:75px; font-weight:700;">Průměr</th>
              </tr>
            </thead>
            <tbody>
              ${project.teams.map((t, i) => {
                const r = gameScoreRows.find(x => x.team === i);
                return `
                  <tr>
                    <td style="font-weight:600;">
                      <span class="team-dot" style="background-color:${t.color};"></span> ${t.name}
                    </td>
                    ${project.teams.map((_, j) => {
                      if (i === j) {
                        return `<td class="num-cell" style="color:var(--text-muted); background:#f9fafb;">—</td>`;
                      }
                      const score = r?.detail?.[j];
                      return `<td class="num-cell">${score != null ? renderScoreBadge(score) : '<span style="color:var(--text-muted);" title="Tým nebyl na tomto archu stopován (prázdné kalibrační pole)">—</span>'}</td>`;
                    }).join('')}
                    <td class="num-cell" style="font-weight:700;">${r?.tracking != null ? `${r.tracking} b` : '—'}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      `;
      sectionEl.appendChild(scoreCard);
    }

    // 2b. Kontrola bodů povinného průchodu (mimo bodování)
    if (Array.isArray(project.checkpoints) && project.checkpoints.length > 0) {
      const cpCard = document.createElement('div');
      cpCard.className = 'card';
      cpCard.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:baseline; flex-wrap:wrap; gap:10px; margin-bottom:10px;">
          <h3 class="card-title" style="margin-bottom:0;">Kontrola bodů povinného průchodu (mimo bodování)</h3>
          <span style="font-size:12px; color:var(--text-muted);">Informační kontrola z GPX tras (nezapočítává se do skóre).</span>
        </div>
        <div class="eval-table-wrap" style="margin-top:0; margin-bottom:0;">
          <table class="eval-table" style="font-size:12px;">
            <thead>
              <tr>
                <th>Tým</th>
                ${project.checkpoints.map(cp => `<th class="th-num">${escapeHtml(cp.name)} <span style="font-weight:normal;">(${cp.radiusM || 50} m)</span></th>`).join('')}
              </tr>
            </thead>
            <tbody>
              ${project.teams.map((t, tIdx) => {
                const tr = tracks[tIdx];
                return `
                  <tr>
                    <td style="font-weight:600;">
                      <span class="team-dot" style="background-color:${t.color};"></span> ${escapeHtml(t.name)}
                    </td>
                    ${project.checkpoints.map((_, cpIdx) => {
                      if (!tr) {
                        return `<td class="num-cell" style="color:var(--text-muted);">— (chybí GPX)</td>`;
                      }
                      const cpRes = tr.checkpoints?.[cpIdx];
                      if (!cpRes || cpRes.minDistM == null) {
                        return `<td class="num-cell" style="color:var(--text-muted);">—</td>`;
                      }
                      const distStr = `${Math.round(cpRes.minDistM)} m`;
                      if (cpRes.passed) {
                        const timeTip = cpRes.reachedAt != null
                          ? `Čas průchodu: ${new Date(cpRes.reachedAt).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })}`
                          : '';
                        return `<td class="num-cell"><span class="score-badge score-high" style="font-size:11px;" title="${escapeHtml(timeTip)}">✓ Prošli (${distStr})</span></td>`;
                      }
                      return `<td class="num-cell"><span class="score-badge score-low" style="font-size:11px;">✕ Neprošli (${distStr})</span></td>`;
                    }).join('')}
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      `;
      sectionEl.appendChild(cpCard);
    }

    // 3. Karty archů jednotlivých týmů
    const sheetsContainer = document.createElement('div');
    sheetsContainer.className = 'sheets-eval-list';

    project.teams.forEach((team, teamIdx) => {
      const card = document.createElement('div');
      const st = cardStatus[teamIdx] || 'idle';
      card.className = `sheet-card ${st === 'processing' ? 'is-processing' : ''}`;
      card.id = `sheet-card-team-${teamIdx}`;

      const res = inMemoryResults.get(teamIdx) || project.results?.sheets?.[teamIdx];
      const hasPhoto = photosMap.has(teamIdx);
      const isDone = !!res;

      let statusBadgeHtml = `<span class="sheet-status-badge sheet-status-none">Nevyhodnoceno</span>`;
      if (st === 'processing') {
        statusBadgeHtml = `<span class="sheet-status-badge sheet-status-busy">Zpracovávám…</span>`;
      } else if (st === 'error' || cardErrors[teamIdx]) {
        statusBadgeHtml = `<span class="sheet-status-badge sheet-status-error">Chyba</span>`;
      } else if (isDone) {
        statusBadgeHtml = `<span class="sheet-status-badge sheet-status-done">Vyhodnoceno</span>`;
      }

      const currentOverrideVal = getSheetOverrideValue(project, teamIdx);
      const defaultSpecLabel = formatSheetSpec(project.paper, project.mapPrintMode);

      card.innerHTML = `
        <div class="sheet-card-header">
          <div class="sheet-card-title">
            <div class="team-badge" style="background-color:${team.color};">${teamIdx + 1}</div>
            <div>
              <strong>${team.name}</strong>
            </div>
          </div>
          <div>${statusBadgeHtml}</div>
        </div>

        <div class="sheet-upload-area" style="flex-wrap:wrap;">
          <label class="btn btn-secondary btn-sm" style="cursor:pointer;">
            ${isDone ? 'Změnit fotku' : 'Vybrat / vyfotit arch'}
            <input type="file" accept="image/*" class="file-input-hidden single-team-upload-input" data-team="${teamIdx}" />
          </label>
          <select class="form-control single-team-sheet-override" data-team="${teamIdx}" aria-label="Typ vytištěného archu" title="Zvolte jiný formát/barevnost, pokud tým odevzdal záložní arch (např. černobílou A4 místo barevné A3)" style="width:auto; min-width:170px; padding:4px 8px; font-size:12px; height:32px;">
            <option value="default" ${currentOverrideVal === 'default' ? 'selected' : ''}>Výchozí (${escapeHtml(defaultSpecLabel)})</option>
            ${SHEET_OVERRIDE_PRESETS.map(p => `<option value="${p.value}" ${currentOverrideVal === p.value ? 'selected' : ''}>${escapeHtml(p.label)}</option>`).join('')}
          </select>
          ${hasPhoto ? `<span style="font-size:12px; color:var(--success); font-weight:600;">Fotka načtena</span>` : ''}
          ${isDone && !hasPhoto ? `<span style="font-size:12px; color:var(--text-muted);">(Výsledky načteny z minula)</span>` : ''}
        </div>

        ${cardNotes[teamIdx] ? `<div class="alert alert-info" style="font-size:13px; margin-bottom:12px;">${cardNotes[teamIdx]}</div>` : ''}
        ${cardErrors[teamIdx] ? `<div class="alert alert-danger" style="font-size:13px; margin-bottom:12px;">${cardErrors[teamIdx]}</div>` : ''}
      `;

      // Pokud máme vyhodnocený výsledek archu, zobrazíme detaily
      if (res) {
        const detailsWrap = document.createElement('div');
        detailsWrap.className = 'sheet-eval-details';

        // Varování při vyhodnocení
        if (res.warnings && res.warnings.length > 0) {
          const warnList = document.createElement('ul');
          warnList.className = 'eval-warnings-list';
          res.warnings.forEach(w => {
            const li = document.createElement('li');
            li.textContent = w;
            warnList.appendChild(li);
          });
          detailsWrap.appendChild(warnList);
        }

        // Info o registraci značek
        if (res.registration) {
          const regInfo = document.createElement('div');
          regInfo.className = 'eval-reg-info';
          const markersCnt = res.registration.markers ? res.registration.markers.length : res.registration.markersCount || 0;
          const rmsMm = Number(res.registration.rmsMm || 0).toFixed(2);
          const pxPerMm = res.registration.pxPerMm ? `${Number(res.registration.pxPerMm).toFixed(1)} px/mm` : '';
          const usedPaper = res.layout?.paper || res.sheetPaper || project.paper || 'A4';
          const usedMode = res.sheetPrintMode || project.mapPrintMode || 'grayscale';
          regInfo.innerHTML = `
            <span>Arch: <strong>${escapeHtml(formatSheetSpec(usedPaper, usedMode))}</strong></span>
            <span>Značky: <strong>${markersCnt} z 8</strong></span>
            <span>Chyba registrace: <strong>${rmsMm} mm</strong></span>
            ${pxPerMm ? `<span>Měřítko fotky: <strong>${pxPerMm}</strong></span>` : ''}
            ${res.usedRefMap ? `<span>Korekce barevné mapy: <strong>aktivní</strong></span>` : ''}
          `;
          detailsWrap.appendChild(regInfo);
        }

        // Canvas s renderOverlay (pouze pokud máme fotku/rect v paměti)
        if (res.rect && res.mapPx) {
          const canvasContainer = document.createElement('div');
          canvasContainer.className = 'eval-canvas-container';

          const fTeams = foreignTeams(nTeams, teamIdx);
          const currentFilter = cardFilter[teamIdx] ?? null;

          // Filtry pro zobrazení
          const filtersBar = document.createElement('div');
          filtersBar.className = 'eval-canvas-filters';

          const allBtn = document.createElement('button');
          allBtn.type = 'button';
          allBtn.className = `eval-filter-chip ${currentFilter == null ? 'active' : ''}`;
          allBtn.textContent = 'Všechny trasy';
          allBtn.addEventListener('click', () => {
            cardFilter[teamIdx] = null;
            render();
          });
          filtersBar.appendChild(allBtn);

          fTeams.forEach(fIdx => {
            const fTeam = project.teams[fIdx];
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = `eval-filter-chip ${currentFilter === fIdx ? 'active' : ''}`;
            chip.innerHTML = `<span class="team-dot" style="background-color:${fTeam.color};"></span> ${fTeam.name}`;
            chip.addEventListener('click', () => {
              cardFilter[teamIdx] = fIdx;
              render();
            });
            filtersBar.appendChild(chip);
          });

          canvasContainer.appendChild(filtersBar);

          // Plátno
          const canvasWrap = document.createElement('div');
          canvasWrap.className = 'eval-canvas-wrapper';
          const canvas = document.createElement('canvas');

          try {
            const overlay = renderOverlay(res, project, { onlyTeam: currentFilter });
            canvas.width = overlay.width;
            canvas.height = overlay.height;
            const ctx = canvas.getContext('2d');
            const imgData = new ImageData(overlay.data, overlay.width, overlay.height);
            ctx.putImageData(imgData, 0, 0);

            canvas.title = 'Klepnutím otevřete ve velkém rozlišení';
            canvas.addEventListener('click', () => {
              const filterLabel = currentFilter != null ? ` (filtr: ${project.teams[currentFilter].name})` : ' (všechny trasy)';
              openModal(`Arch týmu ${team.name}${filterLabel}`, canvas);
            });
          } catch (e) {
            console.error('Chyba při renderOverlay:', e);
          }

          canvasWrap.appendChild(canvas);
          canvasContainer.appendChild(canvasWrap);

          const hint = document.createElement('div');
          hint.className = 'eval-canvas-hint';
          hint.innerHTML = 'Klepnutím na obrázek otevřete zvětšený náhled pro detailní kontrolu';
          canvasContainer.appendChild(hint);

          detailsWrap.appendChild(canvasContainer);
        } else if (!hasPhoto) {
          const noPhotoNotice = document.createElement('div');
          noPhotoNotice.style.fontSize = '12px';
          noPhotoNotice.style.color = 'var(--text-muted)';
          noPhotoNotice.style.margin = '10px 0';
          noPhotoNotice.textContent = 'Náhled narovnaného archu s trasami není v paměti. Pro grafickou kontrolu nahrajte fotku archu znovu.';
          detailsWrap.appendChild(noPhotoNotice);
        }

        // Tabulka výsledků per cizí tým
        if (res.perTeam && res.perTeam.length > 0) {
          const tableWrap = document.createElement('div');
          tableWrap.className = 'eval-table-wrap';
          tableWrap.innerHTML = `
            <table class="eval-table">
              <thead>
                <tr>
                  <th>Stopovaný tým</th>
                  <th style="width:70px;">Fixa</th>
                  <th class="th-num">Skóre</th>
                  <th class="th-num" title="Podíl skutečné GPX trasy, která byla nalezena v toleranci nakreslených čar">Pokrytí trasy (Recall)</th>
                  <th class="th-num" title="Podíl nakreslených čar, které leží v toleranci skutečné GPX trasy">Přesnost čar (Precision)</th>
                  <th class="th-num" title="Medián vzdálenosti nakreslených čar od skutečné trasy">Chyba čar</th>
                  <th class="th-num" title="Medián vzdálenosti trasy od nakreslených čar">Chyba trasy</th>
                  <th class="th-num" title="Podíl bodů trasy uvnitř mapového pole">V mapě</th>
                  <th>Stav</th>
                </tr>
              </thead>
              <tbody>
                ${res.perTeam.map(p => {
                  const targetTeam = project.teams[p.team];
                  const rgb = p.ink ? p.ink.rgb : p.inkRgb;
                  const swatchHtml = rgb
                    ? `<span class="ink-swatch" style="background-color:rgb(${rgb[0]},${rgb[1]},${rgb[2]});" title="Nasnímaná barva fixy: RGB(${rgb.join(',')})"></span>`
                    : `<span class="ink-swatch ink-swatch-empty" title="Fixa nenalezena">✕</span>`;

                  return `
                    <tr>
                      <td style="font-weight:600;">
                        <span class="team-dot" style="background-color:${targetTeam ? targetTeam.color : '#888'};"></span>
                        ${targetTeam ? targetTeam.name : `Tým ${p.team + 1}`}
                      </td>
                      <td>${swatchHtml}</td>
                      <td class="num-cell">${renderScoreBadge(p.score)}</td>
                      <td class="num-cell">${p.recall != null ? `${Math.round(p.recall * 100)} %` : '—'}</td>
                      <td class="num-cell">${p.precision != null ? `${Math.round(p.precision * 100)} %` : '—'}</td>
                      <td class="num-cell">${p.medianDrawnErrM != null ? `${p.medianDrawnErrM.toFixed(1)} m` : '—'}</td>
                      <td class="num-cell">${p.medianTrackErrM != null ? `${p.medianTrackErrM.toFixed(1)} m` : '—'}</td>
                      <td class="num-cell">${p.trackInMapFrac != null ? `${Math.round(p.trackInMapFrac * 100)} %` : '—'}</td>
                      <td>
                        ${p.skipped
                          ? `<span class="score-badge" style="font-size:11px; background:#f1f5f9; color:#64748b; font-weight:normal;" title="V kalibračním poli chybí čára – tým nebyl stopován">Nevyhodnocováno (prázdný chlívek)</span>`
                          : (p.error
                            ? `<span class="score-badge score-low" style="font-size:11px;">${p.error}</span>`
                            : `<span class="score-badge score-high" style="font-size:11px;">OK</span>`)}
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          `;
          detailsWrap.appendChild(tableWrap);
        }

        card.appendChild(detailsWrap);
      }

      sheetsContainer.appendChild(card);
    });

    sectionEl.appendChild(sheetsContainer);

    // 4. Pokročilé nastavení vyhodnocení (<details>)
    const details = document.createElement('details');
    details.className = 'eval-settings-details';
    details.innerHTML = `
      <summary class="eval-settings-summary">Pokročilé parametry vyhodnocení a penalizací</summary>
      <div class="eval-settings-grid">
        <div class="form-group">
          <label class="form-label" for="eval-opt-tolm">Tolerance safe pásu (tolM) [m]</label>
          <input type="number" id="eval-opt-tolm" class="form-control" value="${evalOpts.tolM}" min="5" max="300" step="5" />
          <span style="font-size:11px; color:var(--text-muted);">Do této vzdálenosti plných 100 % bodů (při 1:15 000 je 50 m ≈ 3,3 mm).</span>
        </div>
        <div class="form-group">
          <label class="form-label" for="eval-opt-maxtolm">Hranice nulových bodů (maxTolM) [m]</label>
          <input type="number" id="eval-opt-maxtolm" class="form-control" value="${evalOpts.maxTolM}" min="50" max="1000" step="25" />
          <span style="font-size:11px; color:var(--text-muted);">Nad touto vzdáleností 0 bodů (při 1:15 000 je 300 m ≈ 2 cm).</span>
        </div>
        <div class="form-group">
          <label class="form-label" for="eval-opt-wrongpenalty">Přísnost penalizace chyb (wrongPenalty)</label>
          <input type="number" id="eval-opt-wrongpenalty" class="form-control" value="${evalOpts.wrongPenalty}" min="0.5" max="10" step="0.5" />
          <span style="font-size:11px; color:var(--text-muted);">Vyšší hodnota přísněji trestá špatně zakreslené čáry a slepé hádání.</span>
        </div>
        <div class="form-group">
          <label class="form-label" for="eval-opt-stealthref">Práh stopování pro plné utajení [body]</label>
          <input type="number" id="eval-opt-stealthref" class="form-control" value="${evalOpts.stealthRefTracking}" min="0" max="100" step="5" />
          <span style="font-size:11px; color:var(--text-muted);">Minimální skóre stopování pro 100 % utajení (proti kempování; 0 = vypnuto).</span>
        </div>
        <div class="form-group">
          <label class="form-label" for="eval-opt-minchroma">Minimální sytost barvy (minChroma)</label>
          <input type="number" id="eval-opt-minchroma" class="form-control" value="${evalOpts.minChroma}" min="1" max="60" step="1" />
          <span style="font-size:11px; color:var(--text-muted);">Práh sytosti v Lab (výchozí 14 pro šedotónovou, 18 pro barevnou mapu).</span>
        </div>
        <div class="form-group">
          <label class="form-label" for="eval-opt-maxdist">Max. barevná vzdálenost (maxDist)</label>
          <input type="number" id="eval-opt-maxdist" class="form-control" value="${evalOpts.maxDist}" min="5" max="100" step="1" />
          <span style="font-size:11px; color:var(--text-muted);">Maximální odchylka barvy pixelu od kalibrované fixy.</span>
        </div>
        <div class="form-group">
          <label class="form-label" for="eval-opt-minarea">Min. velikost čáry (minArea) [px]</label>
          <input type="number" id="eval-opt-minarea" class="form-control" value="${evalOpts.minArea}" min="1" max="100" step="1" />
          <span style="font-size:11px; color:var(--text-muted);">Menší shluky pixelů jsou považovány za šum a smazány.</span>
        </div>
        <div class="form-group">
          <label class="form-label" for="eval-opt-allowedgap">Povolený výpadek GPX [min]</label>
          <input type="number" id="eval-opt-allowedgap" class="form-control" value="${evalOpts.allowedGapMin}" min="0" max="60" step="1" />
          <span style="font-size:11px; color:var(--text-muted);">Výpadky záznamu do tohoto limitu jsou bez penalizace.</span>
        </div>
        <div class="form-group">
          <label class="form-label" for="eval-opt-penaltypermin">Penalizace za minutu výpadku [body/min]</label>
          <input type="number" id="eval-opt-penaltypermin" class="form-control" value="${evalOpts.penaltyPerMin}" min="0" max="50" step="0.5" />
          <span style="font-size:11px; color:var(--text-muted);">Odečtené body z celkového skóre za každou další minutu výpadku.</span>
        </div>
      </div>
      <div style="display:flex; flex-wrap:wrap; gap:10px; margin-top:10px;">
        <button type="button" class="btn btn-primary btn-sm" id="eval-btn-save-opts">Uložit parametry</button>
        <button type="button" class="btn btn-secondary btn-sm" id="eval-btn-reset-opts">Obnovit výchozí hodnoty</button>
      </div>
    `;
    sectionEl.appendChild(details);

    // Připojení událostí
    attachEventHandlers(project, evalOpts);
  }

  /**
   * Vyhodnotí fotku archu s respektem k per-týmovému přepisu formátu/barevnosti (např. záložní A4 ČB v projektu s A3 barevnou).
   */
  async function evaluatePhotoWithOverride(photo, project, tracks, hintTeamIdx = null, forceSheetTeam = null) {
    const eff0 = hintTeamIdx != null ? getEffectiveProjectForTeam(project, hintTeamIdx) : project;
    const opts0 = getEvalOpts(eff0);
    const ref0 = await buildRefMapImageData(eff0, opts0.ppm, project);
    let result = evaluateSheet({ photo, project: eff0, tracks, sheetTeam: forceSheetTeam, refMap: ref0, opts: opts0 });
    result.sheetPrintMode = eff0.mapPrintMode || 'grayscale';

    if (forceSheetTeam == null) {
      const actualEff = getEffectiveProjectForTeam(project, result.team);
      const changedPaper = (actualEff.paper || 'A4') !== (eff0.paper || 'A4');
      const changedMode = (actualEff.mapPrintMode || 'grayscale') !== (eff0.mapPrintMode || 'grayscale');
      if (changedPaper || changedMode) {
        const actualOpts = getEvalOpts(actualEff);
        const actualRef = await buildRefMapImageData(actualEff, actualOpts.ppm, project);
        result = evaluateSheet({ photo, project: actualEff, tracks, sheetTeam: result.team, refMap: actualRef, opts: actualOpts });
        result.sheetPrintMode = actualEff.mapPrintMode || 'grayscale';
      }
    }
    return result;
  }

  /**
   * Zpracování souboru pro konkrétní kartu týmu
   */
  async function processFileForTeam(file, expectedTeamIdx) {
    const project = getProject();
    const evalOpts = getEvalOpts(project);
    const { tracks } = buildTracks(project, evalOpts);

    cardStatus[expectedTeamIdx] = 'processing';
    delete cardErrors[expectedTeamIdx];
    delete cardNotes[expectedTeamIdx];
    render();

    // Spuštění po vykreslení přes setTimeout, aby UI nezamrzlo bez zpětné vazby
    await new Promise(r => setTimeout(r, 60));

    try {
      const photo = await loadImageDataFromFile(file, 3000);
      const result = await evaluatePhotoWithOverride(photo, project, tracks, expectedTeamIdx, null);
      const actualTeam = result.team;

      // Uložení fotky a výsledku
      photosMap.set(actualTeam, photo);
      inMemoryResults.set(actualTeam, result);
      cardStatus[actualTeam] = 'done';
      delete cardErrors[actualTeam];

      if (actualTeam !== expectedTeamIdx) {
        cardStatus[expectedTeamIdx] = inMemoryResults.has(expectedTeamIdx) ? 'done' : 'idle';
        const expectedName = project.teams[expectedTeamIdx]?.name || `Tým ${expectedTeamIdx + 1}`;
        const actualName = project.teams[actualTeam]?.name || `Tým ${actualTeam + 1}`;
        cardNotes[actualTeam] = `Arch byl nahrán v kartě týmu ${expectedName}, ale podle rohových značek patří týmu ${actualName}. Výsledek byl přiřazen k týmu ${actualName}.`;
      }

      // Vytvoření mapy výsledků a uložení do project.results
      const sheetResultsMap = {};
      for (let i = 0; i < project.teams.length; i++) {
        if (inMemoryResults.has(i)) sheetResultsMap[i] = inMemoryResults.get(i);
      }
      persistResults(project, sheetResultsMap, tracks, evalOpts, saveProject);
    } catch (err) {
      cardStatus[expectedTeamIdx] = 'error';
      cardErrors[expectedTeamIdx] = err.message || 'Chyba při zpracování archu.';
      console.error('evaluateSheet error:', err);
    } finally {
      render();
    }
  }

  /**
   * Okamžité přepočítání jednoho týmu z paměti (např. po přepnutí formátu archu A3 barevná ↔ A4 ČB)
   */
  async function recalculateSingleTeam(teamIdx) {
    const photo = photosMap.get(teamIdx);
    if (!photo) return;
    const project = getProject();
    const evalOpts = getEvalOpts(project);
    const { tracks } = buildTracks(project, evalOpts);

    cardStatus[teamIdx] = 'processing';
    delete cardErrors[teamIdx];
    render();
    await new Promise(r => setTimeout(r, 40));

    try {
      const result = await evaluatePhotoWithOverride(photo, project, tracks, teamIdx, teamIdx);
      inMemoryResults.set(teamIdx, result);
      cardStatus[teamIdx] = 'done';
      delete cardErrors[teamIdx];

      const sheetResultsMap = {};
      for (let i = 0; i < project.teams.length; i++) {
        if (inMemoryResults.has(i)) sheetResultsMap[i] = inMemoryResults.get(i);
      }
      persistResults(project, sheetResultsMap, tracks, evalOpts, saveProject);
    } catch (err) {
      cardStatus[teamIdx] = 'error';
      cardErrors[teamIdx] = err.message || 'Chyba při přepočtu archu.';
      console.error('recalculateSingleTeam error:', err);
    } finally {
      render();
    }
  }

  /**
   * Hromadné zpracování více vybraných souborů
   */
  async function processBatchFiles(files) {
    if (!files || !files.length) return;
    const project = getProject();
    const evalOpts = getEvalOpts(project);
    const { tracks } = buildTracks(project, evalOpts);

    isBatchProcessing = true;
    render();

    const fileArray = Array.from(files);
    for (let i = 0; i < fileArray.length; i++) {
      const f = fileArray[i];
      batchProgressText = `Zpracovávám soubor ${i + 1} z ${fileArray.length} (${f.name})…`;
      render();
      await new Promise(r => setTimeout(r, 60));

      try {
        const photo = await loadImageDataFromFile(f, 3000);
        const result = await evaluatePhotoWithOverride(photo, project, tracks, null, null);
        const t = result.team;

        photosMap.set(t, photo);
        inMemoryResults.set(t, result);
        cardStatus[t] = 'done';
        delete cardErrors[t];
      } catch (err) {
        console.error(`Chyba při hromadném zpracování souboru ${f.name}:`, err);
      }
    }

    isBatchProcessing = false;
    batchProgressText = '';

    const sheetResultsMap = {};
    for (let i = 0; i < project.teams.length; i++) {
      if (inMemoryResults.has(i)) sheetResultsMap[i] = inMemoryResults.get(i);
    }
    persistResults(project, sheetResultsMap, tracks, evalOpts, saveProject);
    render();
  }

  /**
   * Přepočítání všech fotek uchovaných v paměti
   */
  async function recalculateAllFromMemory() {
    if (photosMap.size === 0) {
      alert('V paměti prohlížeče nejsou uloženy žádné fotky archů. Nahrajte prosím fotky archů znovu.');
      return;
    }

    const project = getProject();
    const evalOpts = getEvalOpts(project);
    const { tracks } = buildTracks(project, evalOpts);

    isBatchProcessing = true;
    batchProgressText = 'Přepočítávám fotky v paměti…';
    render();
    await new Promise(r => setTimeout(r, 60));

    for (const [teamIdx, photo] of photosMap.entries()) {
      cardStatus[teamIdx] = 'processing';
      batchProgressText = `Přepočítávám arch týmu ${project.teams[teamIdx]?.name || teamIdx + 1}…`;
      render();
      await new Promise(r => setTimeout(r, 40));

      try {
        const result = await evaluatePhotoWithOverride(photo, project, tracks, teamIdx, teamIdx);
        inMemoryResults.set(teamIdx, result);
        cardStatus[teamIdx] = 'done';
        delete cardErrors[teamIdx];
      } catch (err) {
        cardStatus[teamIdx] = 'error';
        cardErrors[teamIdx] = err.message;
      }
    }

    isBatchProcessing = false;
    batchProgressText = '';

    const sheetResultsMap = {};
    for (let i = 0; i < project.teams.length; i++) {
      if (inMemoryResults.has(i)) sheetResultsMap[i] = inMemoryResults.get(i);
    }
    persistResults(project, sheetResultsMap, tracks, evalOpts, saveProject);
    render();
  }

  /**
   * Připojení DOM událostí po vykreslení
   */
  function attachEventHandlers(project, evalOpts) {
    // Globální hromadný upload
    const globalInput = sectionEl.querySelector('#eval-global-upload-input');
    if (globalInput) {
      globalInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length) {
          processBatchFiles(e.target.files);
        }
      });
    }

    // Tlačítko přepočítat
    const recalcBtn = sectionEl.querySelector('#eval-btn-recalc-all');
    if (recalcBtn) {
      recalcBtn.addEventListener('click', recalculateAllFromMemory);
    }

    // Tlačítko exportovat CSV
    const exportBtn = sectionEl.querySelector('#eval-btn-export-csv');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => {
        const { tracks } = buildTracks(project, evalOpts);
        const sheetResultsMap = {};
        for (let i = 0; i < project.teams.length; i++) {
          if (inMemoryResults.has(i)) sheetResultsMap[i] = inMemoryResults.get(i);
        }
        exportResultsCsv(project, sheetResultsMap, tracks, evalOpts);
      });
    }

    // Uploady na jednotlivých kartách
    sectionEl.querySelectorAll('.single-team-upload-input').forEach(input => {
      input.addEventListener('change', (e) => {
        const teamIdx = Number(input.getAttribute('data-team'));
        const file = e.target.files && e.target.files[0];
        if (file) {
          processFileForTeam(file, teamIdx);
        }
      });
    });

    // Přepínač typu archu per tým (např. ostrá barevná A3 vs záložní černobílá A4)
    sectionEl.querySelectorAll('.single-team-sheet-override').forEach(select => {
      select.addEventListener('change', () => {
        const teamIdx = Number(select.getAttribute('data-team'));
        const val = select.value;
        if (!project.sheetOverrides) project.sheetOverrides = {};
        if (val === 'default') {
          delete project.sheetOverrides[teamIdx];
        } else {
          const [paper, mapPrintMode] = val.split('|');
          project.sheetOverrides[teamIdx] = { paper, mapPrintMode };
        }
        saveProject(project);
        if (photosMap.has(teamIdx)) {
          recalculateSingleTeam(teamIdx);
        } else {
          render();
        }
      });
    });

    // Uložení nastavení
    const saveOptsBtn = sectionEl.querySelector('#eval-btn-save-opts');
    if (saveOptsBtn) {
      saveOptsBtn.addEventListener('click', () => {
        const readNum = (sel) => {
          const el = sectionEl.querySelector(sel);
          if (!el || String(el.value).trim() === '') return NaN;
          return Number(el.value);
        };
        const tolM = readNum('#eval-opt-tolm');
        const maxTolM = readNum('#eval-opt-maxtolm');
        const wrongPenalty = readNum('#eval-opt-wrongpenalty');
        const stealthRefTracking = readNum('#eval-opt-stealthref');
        const minChroma = readNum('#eval-opt-minchroma');
        const maxDist = readNum('#eval-opt-maxdist');
        const minArea = readNum('#eval-opt-minarea');
        const allowedGapMin = readNum('#eval-opt-allowedgap');
        const penaltyPerMin = readNum('#eval-opt-penaltypermin');

        project.evalOpts = {
          tolM: Number.isFinite(tolM) ? tolM : DEFAULT_OPTS.tolM,
          maxTolM: Number.isFinite(maxTolM) ? maxTolM : DEFAULT_OPTS.maxTolM,
          wrongPenalty: Number.isFinite(wrongPenalty) ? wrongPenalty : DEFAULT_OPTS.wrongPenalty,
          stealthRefTracking: Number.isFinite(stealthRefTracking) ? stealthRefTracking : DEFAULT_OPTS.stealthRefTracking,
          minChroma: Number.isFinite(minChroma) ? minChroma : DEFAULT_OPTS.minChroma,
          maxDist: Number.isFinite(maxDist) ? maxDist : DEFAULT_OPTS.maxDist,
          minArea: Number.isFinite(minArea) ? minArea : DEFAULT_OPTS.minArea,
          allowedGapMin: Number.isFinite(allowedGapMin) ? allowedGapMin : 5,
          penaltyPerMin: Number.isFinite(penaltyPerMin) ? penaltyPerMin : 0,
        };

        saveProject(project);

        const savedOpts = getEvalOpts(project);
        const { tracks } = buildTracks(project, savedOpts);
        const sheetResultsMap = {};
        for (let i = 0; i < project.teams.length; i++) {
          if (inMemoryResults.has(i)) sheetResultsMap[i] = inMemoryResults.get(i);
        }
        persistResults(project, sheetResultsMap, tracks, savedOpts, saveProject);
        render();
      });
    }

    // Reset nastavení na výchozí
    const resetOptsBtn = sectionEl.querySelector('#eval-btn-reset-opts');
    if (resetOptsBtn) {
      resetOptsBtn.addEventListener('click', () => {
        delete project.evalOpts;
        saveProject(project);
        render();
      });
    }
  }

  // Naslouchání na přepnutí na tuto záložku pro automatickou synchronizaci se změnami v jiných záložkách
  document.querySelectorAll('.nav-tab-btn[data-tab="tab-evaluate"]').forEach(btn => {
    btn.addEventListener('click', () => {
      render();
    });
  });

  // První vykreslení
  render();
}
