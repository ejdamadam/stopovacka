// js/ui/evaluate.js
// Vyhodnocovací modul orientační hry Stopovačka (ES moduly, iPhone Safari / GitHub Pages)
// Čisté UI komponenty pro vyhodnocení archů, detekci tras a výpočet skóre.

import { DEFAULT_OPTS, prepareTrack, evaluateSheet, renderOverlay, gameScore } from '../core/evaluate.js';
import { parseGpx } from '../core/gpx.js';
import { foreignTeams } from '../core/layout.js';

// Paměť pro fotky v plném rozlišení (neukládá se do localStorage kvůli limitům paměti)
const photosMap = new Map(); // teamIdx -> {width, height, data: Uint8ClampedArray}
const inMemoryResults = new Map(); // teamIdx -> SheetResult

// Stav karet
const cardStatus = {}; // teamIdx -> 'idle' | 'processing' | 'done' | 'error'
const cardErrors = {}; // teamIdx -> string chyby
const cardNotes = {}; // teamIdx -> string upozornění (např. přesměrování archu)
const cardFilter = {}; // teamIdx -> number | null (filtr zobrazení cizího týmu)

let isBatchProcessing = false;
let batchProgressText = '';
let activeModalBackdrop = null;

/**
 * Získání nastavení vyhodnocení s výchozími hodnotami z DEFAULT_OPTS
 */
function getEvalOpts(project) {
  const p = project.evalOpts || {};
  return {
    ...DEFAULT_OPTS,
    tolM: Number.isFinite(p.tolM) ? p.tolM : DEFAULT_OPTS.tolM,
    minChroma: Number.isFinite(p.minChroma) ? p.minChroma : DEFAULT_OPTS.minChroma,
    maxDist: Number.isFinite(p.maxDist) ? p.maxDist : DEFAULT_OPTS.maxDist,
    minArea: Number.isFinite(p.minArea) ? p.minArea : DEFAULT_OPTS.minArea,
    allowedGapMin: Number.isFinite(p.allowedGapMin) ? p.allowedGapMin : 5,
    penaltyPerMin: Number.isFinite(p.penaltyPerMin) ? p.penaltyPerMin : 2,
  };
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
  });

  const sheetsData = {};
  for (let i = 0; i < project.teams.length; i++) {
    const res = sheetResults[i];
    if (res) {
      sheetsData[i] = {
        team: res.team,
        warnings: res.warnings || [],
        registration: res.registration ? {
          markersCount: res.registration.markers ? res.registration.markers.length : 0,
          rmsMm: res.registration.rmsMm,
          pxPerMm: res.registration.pxPerMm,
        } : null,
        perTeam: (res.perTeam || []).map(p => ({
          team: p.team,
          score: p.score,
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
        <span class="eval-stat-item">Archy: <strong>${evaluatedCount} z ${nTeams}</strong></span>
        <span class="eval-stat-item">GPX trasy: <strong>${tracksCount} z ${nTeams}</strong></span>
        <span class="eval-stat-item">Mapa: <strong>${mapReady ? '✓ Připravena' : '⚠️ Chybí georeference'}</strong></span>
      </div>
      <div class="eval-toolbar-actions">
        <label class="btn btn-primary btn-sm" style="cursor:pointer;" title="Vyberte více fotek archů najednou">
          📷 Nahrát fotky archů (hromadně)
          <input type="file" multiple accept="image/*" class="file-input-hidden" id="eval-global-upload-input" />
        </label>
        ${photosMap.size > 0 ? `<button type="button" class="btn btn-secondary btn-sm" id="eval-btn-recalc-all" title="Přepočítat všechny načtené fotky s aktuálním nastavením">🔄 Přepočítat (${photosMap.size})</button>` : ''}
        ${hasAnyResults ? `<button type="button" class="btn btn-secondary btn-sm" id="eval-btn-export-csv" title="Stáhnout kompletní tabulku výsledků v CSV">📥 Export CSV</button>` : ''}
      </div>
    `;
    sectionEl.appendChild(toolbar);

    // Globální indikátor hromadného zpracování
    if (isBatchProcessing) {
      const batchBox = document.createElement('div');
      batchBox.className = 'alert alert-info';
      batchBox.innerHTML = `⏳ <strong>Zpracovávám fotky:</strong> ${batchProgressText || 'Analyzuji značky a čáry…'}`;
      sectionEl.appendChild(batchBox);
    }

    // Upozornění na mapu a GPX
    if (!mapReady) {
      const alertMap = document.createElement('div');
      alertMap.className = 'alert alert-warning';
      alertMap.innerHTML = `⚠️ <strong>Chybí mapa:</strong> V záložce „2. Mapa“ nastavte a georeferencujte mapu. Bez mapy nelze porovnat nakreslené čáry s GPX.`;
      sectionEl.appendChild(alertMap);
    }

    if (missingGpx.length > 0) {
      const alertGpx = document.createElement('div');
      alertGpx.className = 'alert alert-warning';
      alertGpx.innerHTML = `⚠️ <strong>Chybí GPX trasy pro týmy:</strong> ${missingGpx.join(', ')}. Bez GPX nelze spočítat přesnost jejich stopování. Nahrajte je v záložce „4. Hra & GPX“.`;
      sectionEl.appendChild(alertGpx);
    }

    if (gpxErrors.length > 0) {
      const alertGpxErr = document.createElement('div');
      alertGpxErr.className = 'alert alert-danger';
      alertGpxErr.innerHTML = `❌ <strong>Chyby v GPX trasách:</strong><br>${gpxErrors.join('<br>')}`;
      sectionEl.appendChild(alertGpxErr);
    }

    // 2. Celkové pořadí hry (pokud jsou k dispozici výsledky)
    if (gameScoreRows && gameScoreRows.length > 0) {
      const scoreCard = document.createElement('div');
      scoreCard.className = 'card';
      scoreCard.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:12px;">
          <div>
            <h3 class="card-title" style="margin-bottom:2px;">🏆 Celkové pořadí hry</h3>
            <p class="card-desc" style="margin-bottom:0;">Celkové skóre = stopování ostatních + utajení před ostatními − penalizace za výpadky GPX.</p>
          </div>
        </div>

        <div class="eval-table-wrap">
          <table class="eval-table">
            <thead>
              <tr>
                <th style="width:48px;">Pořadí</th>
                <th>Tým</th>
                <th class="th-num" title="Průměrné skóre z zakreslení cizích týmů (0–100)">Stopování</th>
                <th class="th-num" title="100 − průměr skóre, se kterým tento tým zakreslili ostatní">Utajení</th>
                <th class="th-num" title="Součet výpadků GPX záznamu">Výpadky GPX</th>
                <th class="th-num" title="Penalizace za výpadky GPX nad ${evalOpts.allowedGapMin} min (${evalOpts.penaltyPerMin} b/min)">Penalizace</th>
                <th class="th-num" title="Celkové body týmu" style="font-weight:700;">Celkem</th>
              </tr>
            </thead>
            <tbody>
              ${gameScoreRows.map((r, rank) => {
                const teamObj = project.teams[r.team];
                const medal = rank === 0 ? '🥇 ' : rank === 1 ? '🥈 ' : rank === 2 ? '🥉 ' : `${rank + 1}.`;
                return `
                  <tr style="${rank === 0 ? 'background-color: #f0fdf4; font-weight:600;' : ''}">
                    <td>${medal}</td>
                    <td>
                      <div style="display:flex; align-items:center; gap:8px;">
                        <span class="team-dot" style="background-color:${teamObj ? teamObj.color : '#888'};"></span>
                        <span>${r.name}</span>
                      </div>
                    </td>
                    <td class="num-cell">${renderScoreBadge(r.tracking)}</td>
                    <td class="num-cell">${r.stealth != null ? renderScoreBadge(r.stealth) : '<span style="color:var(--text-muted);">–</span>'}</td>
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
        <h4 style="font-size:14px; font-weight:700; margin-top:20px; margin-bottom:8px; color:var(--text-main);">
          Matice stopování (řádek = kdo stopoval, sloupec = koho)
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
                      return `<td class="num-cell">${score != null ? renderScoreBadge(score) : '<span style="color:var(--text-muted);">?</span>'}</td>`;
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
        statusBadgeHtml = `<span class="sheet-status-badge sheet-status-busy">⏳ Zpracovávám…</span>`;
      } else if (st === 'error' || cardErrors[teamIdx]) {
        statusBadgeHtml = `<span class="sheet-status-badge sheet-status-error">✕ Chyba</span>`;
      } else if (isDone) {
        statusBadgeHtml = `<span class="sheet-status-badge sheet-status-done">✓ Vyhodnoceno</span>`;
      }

      card.innerHTML = `
        <div class="sheet-card-header">
          <div class="sheet-card-title">
            <div class="team-badge" style="background-color:${team.color};">${teamIdx + 1}</div>
            <div>
              <div>Arch týmu: <strong>${team.name}</strong></div>
              <div style="font-size:12px; font-weight:normal; color:var(--text-muted);">
                Zde tým zakresloval trasy ostatních týmů
              </div>
            </div>
          </div>
          <div>${statusBadgeHtml}</div>
        </div>

        <div class="sheet-upload-area">
          <label class="btn btn-secondary btn-sm" style="cursor:pointer;">
            📷 ${isDone ? 'Změnit / přefotit arch' : 'Vyfotit / vybrat arch'}
            <input type="file" accept="image/*" class="file-input-hidden single-team-upload-input" data-team="${teamIdx}" />
          </label>
          ${hasPhoto ? `<span style="font-size:12px; color:var(--success); font-weight:600;">✓ Fotka načtena v paměti</span>` : ''}
          ${isDone && !hasPhoto ? `<span style="font-size:12px; color:var(--text-muted);">(Výsledky načteny z minula, pro náhled mapy nahrajte fotku znovu)</span>` : ''}
        </div>

        ${cardNotes[teamIdx] ? `<div class="alert alert-info" style="font-size:13px; margin-bottom:12px;">ℹ️ ${cardNotes[teamIdx]}</div>` : ''}
        ${cardErrors[teamIdx] ? `<div class="alert alert-danger" style="font-size:13px; margin-bottom:12px;">❌ <strong>Chyba:</strong> ${cardErrors[teamIdx]}</div>` : ''}
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
            li.innerHTML = `⚠️ ${w}`;
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
          regInfo.innerHTML = `
            <span>Značky: <strong>${markersCnt} ze 4</strong></span>
            <span>Chyba registrace: <strong>${rmsMm} mm</strong></span>
            ${pxPerMm ? `<span>Měřítko fotky: <strong>${pxPerMm}</strong></span>` : ''}
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
          hint.innerHTML = '🔍 Klepnutím na obrázek otevřete zvětšený náhled pro detailní kontrolu';
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
                        ${p.error
                          ? `<span class="score-badge score-low" style="font-size:11px;">${p.error}</span>`
                          : `<span class="score-badge score-high" style="font-size:11px;">OK</span>`}
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
      <summary class="eval-settings-summary">⚙️ Pokročilé parametry vyhodnocení a penalizací</summary>
      <div class="eval-settings-grid">
        <div class="form-group">
          <label class="form-label" for="eval-opt-tolm">Tolerance v terénu (tolM) [m]</label>
          <input type="number" id="eval-opt-tolm" class="form-control" value="${evalOpts.tolM}" min="5" max="300" step="5" />
          <span style="font-size:11px; color:var(--text-muted);">Do této vzdálenosti plný bod, do 2×tolM lineárně klesá.</span>
        </div>
        <div class="form-group">
          <label class="form-label" for="eval-opt-minchroma">Minimální sytost barvy (minChroma)</label>
          <input type="number" id="eval-opt-minchroma" class="form-control" value="${evalOpts.minChroma}" min="1" max="60" step="1" />
          <span style="font-size:11px; color:var(--text-muted);">Práh sytosti v Lab: mapa je šedotónová, menší hodnoty berou i šedé.</span>
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
        <button type="button" class="btn btn-primary btn-sm" id="eval-btn-save-opts">💾 Uložit parametry</button>
        <button type="button" class="btn btn-secondary btn-sm" id="eval-btn-reset-opts">Obnovit výchozí hodnoty</button>
      </div>
    `;
    sectionEl.appendChild(details);

    // Připojení událostí
    attachEventHandlers(project, evalOpts);
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
      const result = evaluateSheet({ photo, project, tracks, opts: evalOpts });
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
        const result = evaluateSheet({ photo, project, tracks, opts: evalOpts });
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
        const result = evaluateSheet({ photo, project, tracks, sheetTeam: teamIdx, opts: evalOpts });
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

    // Uložení nastavení
    const saveOptsBtn = sectionEl.querySelector('#eval-btn-save-opts');
    if (saveOptsBtn) {
      saveOptsBtn.addEventListener('click', () => {
        const tolM = Number(sectionEl.querySelector('#eval-opt-tolm')?.value);
        const minChroma = Number(sectionEl.querySelector('#eval-opt-minchroma')?.value);
        const maxDist = Number(sectionEl.querySelector('#eval-opt-maxdist')?.value);
        const minArea = Number(sectionEl.querySelector('#eval-opt-minarea')?.value);
        const allowedGapMin = Number(sectionEl.querySelector('#eval-opt-allowedgap')?.value);
        const penaltyPerMin = Number(sectionEl.querySelector('#eval-opt-penaltypermin')?.value);

        project.evalOpts = {
          tolM: isNaN(tolM) ? DEFAULT_OPTS.tolM : tolM,
          minChroma: isNaN(minChroma) ? DEFAULT_OPTS.minChroma : minChroma,
          maxDist: isNaN(maxDist) ? DEFAULT_OPTS.maxDist : maxDist,
          minArea: isNaN(minArea) ? DEFAULT_OPTS.minArea : minArea,
          allowedGapMin: isNaN(allowedGapMin) ? 5 : allowedGapMin,
          penaltyPerMin: isNaN(penaltyPerMin) ? 2 : penaltyPerMin,
        };

        saveProject(project);

        // Pokud jsou změněny jen penalizace (allowedGapMin, penaltyPerMin), přepočítáme skóre rovnou
        const { tracks } = buildTracks(project, project.evalOpts);
        const sheetResultsMap = {};
        for (let i = 0; i < project.teams.length; i++) {
          if (inMemoryResults.has(i)) sheetResultsMap[i] = inMemoryResults.get(i);
        }
        persistResults(project, sheetResultsMap, tracks, project.evalOpts, saveProject);
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
