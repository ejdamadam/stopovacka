// js/app.js
// Hlavní kontrolér webové aplikace Stopovačka (ES moduly, bez build kroku)

import { layoutForProject } from './core/layout.js';
import { makeGeoref, parseLatLon } from './core/geo.js';
import { renderSheetHtml } from './ui/sheet.js';
import { openMapPicker } from './ui/mapPicker.js';

const STORAGE_KEY = 'stopovacka.project.v1';

/**
 * Výchozí struktura projektu
 */
function createDefaultProject() {
  return {
    version: 1,
    name: 'Jarní stopovačka 2026',
    teams: [
      { name: 'Červení', color: '#e53935' },
      { name: 'Modří', color: '#1e88e5' },
      { name: 'Zelení', color: '#43a047' },
      { name: 'Žlutí', color: '#fbc02d' }
    ],
    paper: 'A4',
    orientation: 'portrait',
    map: null,
    game: {
      startMs: null,
      endMs: null
    },
    gpx: {}
  };
}

let project = loadProject();

export function getProject() {
  return project;
}

export function saveProject(p) {
  if (p) project = p;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
    return true;
  } catch (err) {
    if (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014) {
      alert('Chyba: Nedostatek místa v paměti prohlížeče (localStorage). Obrázek mapy nebo soubory GPX jsou příliš velké. Zkuste menší obrázek nebo použijte dlaždicovou mapu.');
    } else {
      alert('Chyba při ukládání: ' + err.message);
    }
    console.error('saveProject quota error:', err);
    return false;
  }
}

// Zpřístupnění pro konzoli i jiné skripty
globalThis.Stopovacka = { getProject, saveProject };

function loadProject() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data && data.version === 1) {
        return data;
      }
    }
  } catch (e) {
    console.warn('Nelze načíst projekt z localStorage:', e);
  }
  return createDefaultProject();
}

/**
 * Pomocné funkce pro datum a čas v lokálním formátu
 */
function msToDatetimeLocal(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function datetimeLocalToMs(str) {
  if (!str) return null;
  const t = new Date(str).getTime();
  return isNaN(t) ? null : t;
}

/**
 * Zmenšení obrázku mapy před uložením do paměti (max 2400 px, JPEG 0.85)
 */
function resizeImageFile(file, maxDim = 2400, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Chyba při čtení souboru'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Chyba při dekódování obrázku'));
      img.onload = () => {
        let w = img.naturalWidth || img.width;
        let h = img.naturalHeight || img.height;
        if (w > maxDim || h > maxDim) {
          if (w > h) {
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
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        resolve({ dataUrl, width: w, height: h, aspect: w / h });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// -------------------------------------------------------------
// Inicializace UI po načtení DOM
// -------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initStep1Project();
  initStep2Map();
  initStep3Print();
  initStep4Game();
  initStep5Evaluate();
});

// -------------------------------------------------------------
// Přepínání záložek
// -------------------------------------------------------------
let activeTabId = 'tab-project';

function initTabs() {
  const tabBtns = document.querySelectorAll('.nav-tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.getAttribute('data-tab');
      switchTab(tabId);
    });
  });
}

function switchTab(tabId) {
  activeTabId = tabId;
  document.querySelectorAll('.nav-tab-btn').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-tab') === tabId);
  });
  document.querySelectorAll('.tab-pane').forEach(p => {
    p.classList.toggle('active', p.id === tabId);
  });

  if (tabId === 'tab-map') {
    if (mapPickerInstance) {
      const layout = layoutForProject(project);
      const aspect = layout.avail.w / layout.avail.h;
      mapPickerInstance.updateAspect(aspect, layout.mapRect.w);
    }
  } else if (tabId === 'tab-print') {
    updatePrintPreview();
  }
}

// -------------------------------------------------------------
// 1. ZÁLOŽKA: PROJEKT
// -------------------------------------------------------------
function initStep1Project() {
  const nameInput = document.getElementById('project-name');
  const paperSelect = document.getElementById('paper-format');
  const orientSelect = document.getElementById('paper-orientation');
  const teamsContainer = document.getElementById('teams-container');

  nameInput.value = project.name || '';
  nameInput.addEventListener('input', () => {
    project.name = nameInput.value.trim() || 'Stopovačka';
    saveProject(project);
  });

  paperSelect.value = project.paper || 'A4';
  paperSelect.addEventListener('change', () => {
    project.paper = paperSelect.value;
    saveProject(project);
    syncLayoutChanges();
  });

  orientSelect.value = project.orientation || 'portrait';
  orientSelect.addEventListener('change', () => {
    project.orientation = orientSelect.value;
    saveProject(project);
    syncLayoutChanges();
  });

  renderTeamsList(teamsContainer);
}

function renderTeamsList(container) {
  if (!container) return;
  container.innerHTML = '';

  project.teams.forEach((team, idx) => {
    const row = document.createElement('div');
    row.className = 'team-row';

    const badge = document.createElement('div');
    badge.className = 'team-badge';
    badge.style.backgroundColor = team.color;
    badge.textContent = String(idx + 1);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'form-control team-name-input';
    nameInput.value = team.name;
    nameInput.placeholder = `Tým ${idx + 1}`;
    nameInput.addEventListener('input', () => {
      team.name = nameInput.value.trim() || `Tým ${idx + 1}`;
      saveProject(project);
    });

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'team-color-picker';
    colorInput.value = team.color;
    colorInput.title = 'Barva fixy týmu';
    colorInput.addEventListener('input', () => {
      team.color = colorInput.value;
      badge.style.backgroundColor = team.color;
      saveProject(project);
    });

    row.appendChild(badge);
    row.appendChild(nameInput);
    row.appendChild(colorInput);
    container.appendChild(row);
  });
}

function syncLayoutChanges() {
  updateDynamicPrintStyle();
  if (mapPickerInstance) {
    const layout = layoutForProject(project);
    const aspect = layout.avail.w / layout.avail.h;
    mapPickerInstance.updateAspect(aspect, layout.mapRect.w);
  }
}

// -------------------------------------------------------------
// 2. ZÁLOŽKA: MAPA
// -------------------------------------------------------------
let mapPickerInstance = null;
let pendingPoint = null;

function initStep2Map() {
  const btnTiles = document.getElementById('btn-map-mode-tiles');
  const btnImage = document.getElementById('btn-map-mode-image');
  const secTiles = document.getElementById('map-mode-tiles-section');
  const secImage = document.getElementById('map-mode-image-section');
  const pickerMount = document.getElementById('map-picker-mount');
  const btnSaveTile = document.getElementById('btn-save-tile-extent');
  const tileStatusMsg = document.getElementById('tile-status-msg');

  // Přepínání režimů mapy
  const currentKind = project.map ? project.map.kind : 'tiles';
  setMapMode(currentKind);

  btnTiles.addEventListener('click', () => {
    setMapMode('tiles');
  });

  btnImage.addEventListener('click', () => {
    setMapMode('image');
  });

  function setMapMode(mode) {
    btnTiles.classList.toggle('active', mode === 'tiles');
    btnImage.classList.toggle('active', mode === 'image');
    secTiles.style.display = mode === 'tiles' ? 'block' : 'none';
    secImage.style.display = mode === 'image' ? 'block' : 'none';

    if (mode === 'tiles') {
      ensureMapPicker();
    }
  }

  function ensureMapPicker() {
    if (mapPickerInstance) return;
    const layout = layoutForProject(project);
    const aspect = layout.avail.w / layout.avail.h;

    let initCenter = [49.8, 15.4];
    let initTileUrl = undefined;
    let initAttribution = undefined;

    if (project.map && project.map.kind === 'tiles') {
      initTileUrl = project.map.tileUrl;
      initAttribution = project.map.attribution;
      if (project.map.georef) {
        try {
          const g = makeGeoref(project.map.georef);
          initCenter = g.center;
        } catch (e) {
          // ignore
        }
      }
    }

    try {
      mapPickerInstance = openMapPicker(pickerMount, {
        aspect,
        printWidthMm: layout.mapRect.w,
        initialCenter: initCenter,
        tileUrl: initTileUrl,
        attribution: initAttribution,
        onChange: (info) => {
          tileStatusMsg.textContent = 'Výřez změněn (nezapomeňte kliknout na Uložit)';
        }
      });
    } catch (err) {
      console.error('Chyba při otevírání mapPickeru:', err);
    }
  }

  btnSaveTile.addEventListener('click', () => {
    if (!mapPickerInstance) return;
    const georef = mapPickerInstance.getGeoref();
    project.map = {
      kind: 'tiles',
      tileUrl: mapPickerInstance.getTileUrl(),
      attribution: mapPickerInstance.getAttribution(),
      georef
    };
    saveProject(project);
    tileStatusMsg.textContent = '✓ Výřez mapy byl uložen do projektu.';
    tileStatusMsg.style.color = 'var(--success)';
    setTimeout(() => {
      tileStatusMsg.style.color = 'var(--text-muted)';
    }, 3000);
  });

  initCustomImageGeoref();
}

function initCustomImageGeoref() {
  const fileInput = document.getElementById('map-image-file-input');
  const fileNameEl = document.getElementById('map-image-name');
  const containerEl = document.getElementById('image-georef-container');
  const imgWrap = document.getElementById('image-wrap');
  const annotateImg = document.getElementById('annotate-img');
  const markersLayer = document.getElementById('image-markers-layer');
  const pointsTbody = document.getElementById('points-tbody');
  const rmsDisplay = document.getElementById('rms-display');
  const btnClearPoints = document.getElementById('btn-clear-points');

  // Modální okno pro zadání souřadnic
  const modal = document.getElementById('point-modal');
  const modalInput = document.getElementById('modal-coord-input');
  const modalError = document.getElementById('modal-coord-error');
  const btnModalSave = document.getElementById('btn-modal-save');
  const btnModalCancel = document.getElementById('btn-modal-cancel');

  if (project.map && project.map.kind === 'image' && project.map.imageDataUrl) {
    containerEl.style.display = 'block';
    fileNameEl.textContent = 'Nahraný obrázek';
    annotateImg.src = project.map.imageDataUrl;
    renderPointsTableAndMarkers();
  }

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    fileNameEl.textContent = 'Zpracovávám obrázek...';
    try {
      const { dataUrl, width, height, aspect } = await resizeImageFile(file, 2400, 0.85);
      project.map = {
        kind: 'image',
        imageDataUrl: dataUrl,
        georef: {
          type: 'affine',
          aspect: aspect,
          points: []
        }
      };
      saveProject(project);

      fileNameEl.textContent = `${file.name} (${width} × ${height} px)`;
      containerEl.style.display = 'block';
      annotateImg.src = dataUrl;
      renderPointsTableAndMarkers();
    } catch (err) {
      alert('Chyba při nahrávání obrázku: ' + err.message);
      fileNameEl.textContent = 'Chyba nahrávání';
    }
  });

  // Klepnutí do obrázku
  imgWrap.addEventListener('click', (e) => {
    if (!project.map || project.map.kind !== 'image') return;
    const rect = annotateImg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const u = (e.clientX - rect.left) / rect.width;
    const v = (e.clientY - rect.top) / rect.height;

    if (u < 0 || u > 1 || v < 0 || v > 1) return;

    pendingPoint = {
      u: Number(u.toFixed(4)),
      v: Number(v.toFixed(4))
    };

    modalInput.value = '';
    modalError.style.display = 'none';
    modal.style.display = 'flex';
    modalInput.focus();
  });

  function closeModal() {
    modal.style.display = 'none';
    pendingPoint = null;
  }

  btnModalCancel.addEventListener('click', closeModal);

  btnModalSave.addEventListener('click', () => {
    if (!pendingPoint) return;
    const text = modalInput.value.trim();
    const parsed = parseLatLon(text);
    if (!parsed) {
      modalError.textContent = 'Neplatný formát souřadnic. Zadejte např. 49.1234N, 16.5678E nebo 48°57.072\'N 19°4.272\'E';
      modalError.style.display = 'block';
      return;
    }

    if (!project.map.georef.points) project.map.georef.points = [];
    project.map.georef.points.push({
      u: pendingPoint.u,
      v: pendingPoint.v,
      lat: parsed.lat,
      lon: parsed.lon
    });

    saveProject(project);
    closeModal();
    renderPointsTableAndMarkers();
  });

  modalInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      btnModalSave.click();
    } else if (e.key === 'Escape') {
      closeModal();
    }
  });

  btnClearPoints.addEventListener('click', () => {
    if (!confirm('Opravdu chcete smazat všechny vlícovací body?')) return;
    if (project.map && project.map.georef) {
      project.map.georef.points = [];
      saveProject(project);
      renderPointsTableAndMarkers();
    }
  });

  function renderPointsTableAndMarkers() {
    markersLayer.innerHTML = '';
    pointsTbody.innerHTML = '';
    rmsDisplay.textContent = '';

    if (!project.map || project.map.kind !== 'image' || !project.map.georef) return;
    const pts = project.map.georef.points || [];

    // Vykreslit značky na obrázku
    pts.forEach((p, idx) => {
      const marker = document.createElement('div');
      marker.className = 'map-point-marker';
      marker.style.left = `${(p.u * 100).toFixed(2)}%`;
      marker.style.top = `${(p.v * 100).toFixed(2)}%`;
      marker.textContent = String(idx + 1);
      markersLayer.appendChild(marker);
    });

    // Výpočet georeference pro zjištění RMS a reziduí
    let residuals = [];
    let rmsM = null;
    if (pts.length >= 2) {
      try {
        const geo = makeGeoref(project.map.georef);
        residuals = geo.residuals || [];
        rmsM = geo.rmsM;
        rmsDisplay.textContent = `Střední chyba (RMS): ${rmsM.toFixed(1)} m`;
        rmsDisplay.style.color = rmsM < 25 ? 'var(--success)' : 'var(--warning)';
      } catch (err) {
        rmsDisplay.textContent = `Chyba: ${err.message}`;
        rmsDisplay.style.color = 'var(--danger)';
      }
    } else {
      rmsDisplay.textContent = `Zadáno ${pts.length}/2 bodů (minimum 2, doporučeno 3–5)`;
      rmsDisplay.style.color = 'var(--text-muted)';
    }

    // Tabulka bodů
    pts.forEach((p, idx) => {
      const tr = document.createElement('tr');
      const resText = residuals[idx] != null ? `${residuals[idx].toFixed(1)} m` : '–';

      tr.innerHTML = `
        <td style="font-weight:bold;">${idx + 1}</td>
        <td>${p.u.toFixed(3)}, ${p.v.toFixed(3)}</td>
        <td>${p.lat.toFixed(5)}°, ${p.lon.toFixed(5)}°</td>
        <td>${resText}</td>
        <td>
          <button type="button" class="btn btn-danger btn-sm" style="padding:2px 8px; min-height:24px;" data-del="${idx}" title="Smazat bod">×</button>
        </td>
      `;

      tr.querySelector('[data-del]').addEventListener('click', () => {
        project.map.georef.points.splice(idx, 1);
        saveProject(project);
        renderPointsTableAndMarkers();
      });

      pointsTbody.appendChild(tr);
    });
  }
}

// -------------------------------------------------------------
// 3. ZÁLOŽKA: TISK
// -------------------------------------------------------------
let selectedPreviewTeam = 'all';

function initStep3Print() {
  const btnPrint = document.getElementById('btn-print-sheets');
  const teamTabs = document.querySelectorAll('.preview-team-tab');

  btnPrint.addEventListener('click', () => {
    updateDynamicPrintStyle();
    renderAllSheetsToPrintContainer();
    window.print();
  });

  teamTabs.forEach(btn => {
    btn.addEventListener('click', () => {
      teamTabs.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedPreviewTeam = btn.getAttribute('data-team');
      updatePrintPreview();
    });
  });
}

function updateDynamicPrintStyle() {
  const styleEl = document.getElementById('print-page-style');
  const paper = project.paper || 'A4';
  const orientation = project.orientation || 'portrait';
  if (styleEl) {
    styleEl.textContent = `
      @media print {
        @page {
          size: ${paper} ${orientation};
          margin: 0;
        }
      }
    `;
  }
}

function renderAllSheetsToPrintContainer() {
  const printContainer = document.getElementById('print-container');
  if (!printContainer) return;

  const count = project.teams.length;
  let html = '';
  for (let i = 0; i < count; i++) {
    html += renderSheetHtml(project, i) + '\n';
  }
  printContainer.innerHTML = html;
}

function updatePrintPreview() {
  updateDynamicPrintStyle();
  renderAllSheetsToPrintContainer();

  const previewContainer = document.getElementById('preview-container');
  const alertEl = document.getElementById('print-alert');
  if (!previewContainer) return;

  if (!project.map || !project.map.georef) {
    alertEl.style.display = 'block';
    alertEl.innerHTML = '⚠️ <strong>Upozornění:</strong> Mapa zatím není nastavena nebo georeferencována. Vytisknuté archy budou mít prázdné mapové pole.';
  } else {
    alertEl.style.display = 'none';
  }

  previewContainer.innerHTML = '';

  const layout = layoutForProject(project);
  // Škálování náhledu na obrazovce tak, aby se vešel do kontejneru
  const targetWidthPx = Math.min(window.innerWidth - 64, 780);
  const scale = targetWidthPx / (layout.w * 3.7795); // 1mm ≈ 3.78px při 96 DPI

  const teamsToShow = selectedPreviewTeam === 'all'
    ? project.teams.map((_, i) => i)
    : [Number(selectedPreviewTeam)];

  teamsToShow.forEach(idx => {
    const wrap = document.createElement('div');
    wrap.className = 'sheet-preview-wrap';
    wrap.style.width = `${layout.w}mm`;
    wrap.style.height = `${layout.h}mm`;
    wrap.style.transform = `scale(${Math.min(1, scale.toFixed(3))})`;
    wrap.style.marginBottom = `${Math.round(layout.h * (scale - 1))}px`;

    wrap.innerHTML = renderSheetHtml(project, idx);
    previewContainer.appendChild(wrap);
  });
}

// -------------------------------------------------------------
// 4. ZÁLOŽKA: HRA & GPX
// -------------------------------------------------------------
function initStep4Game() {
  const startInput = document.getElementById('game-start-time');
  const endInput = document.getElementById('game-end-time');
  const gpxContainer = document.getElementById('gpx-teams-container');

  if (project.game) {
    startInput.value = msToDatetimeLocal(project.game.startMs);
    endInput.value = msToDatetimeLocal(project.game.endMs);
  }

  startInput.addEventListener('change', () => {
    project.game.startMs = datetimeLocalToMs(startInput.value);
    saveProject(project);
  });

  endInput.addEventListener('change', () => {
    project.game.endMs = datetimeLocalToMs(endInput.value);
    saveProject(project);
  });

  renderGpxTeamsList(gpxContainer);
}

function renderGpxTeamsList(container) {
  if (!container) return;
  container.innerHTML = '';

  project.teams.forEach((team, idx) => {
    const row = document.createElement('div');
    row.className = 'team-row';
    row.style.flexWrap = 'wrap';

    const badge = document.createElement('div');
    badge.className = 'team-badge';
    badge.style.backgroundColor = team.color;
    badge.textContent = String(idx + 1);

    const nameSpan = document.createElement('span');
    nameSpan.style.fontWeight = '600';
    nameSpan.style.minWidth = '120px';
    nameSpan.textContent = team.name;

    const gpxInfo = project.gpx && project.gpx[idx];
    const statusWrap = document.createElement('div');
    statusWrap.style.display = 'flex';
    statusWrap.style.alignItems = 'center';
    statusWrap.style.gap = '10px';
    statusWrap.style.flex = '1';

    if (gpxInfo && gpxInfo.text) {
      const trkptCount = (gpxInfo.text.match(/<trkpt/gi) || gpxInfo.text.match(/<rtept/gi) || []).length;
      statusWrap.innerHTML = `
        <span style="font-size:13px; color:var(--success); font-weight:600;">✓ ${gpxInfo.fileName || 'GPX soubor'}</span>
        <span style="font-size:12px; color:var(--text-muted);">(${trkptCount} bodů, ${Math.round(gpxInfo.text.length / 1024)} KB)</span>
        <button type="button" class="btn btn-danger btn-sm" style="margin-left:auto;">Odstranit</button>
      `;
      statusWrap.querySelector('button').addEventListener('click', () => {
        delete project.gpx[idx];
        saveProject(project);
        renderGpxTeamsList(container);
      });
    } else {
      const fileLabel = document.createElement('label');
      fileLabel.className = 'btn btn-secondary btn-sm';
      fileLabel.style.cursor = 'pointer';
      fileLabel.textContent = '📁 Nahrát GPX';

      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = '.gpx,application/gpx+xml,text/xml';
      fileInput.style.display = 'none';

      fileInput.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = () => {
          if (!project.gpx) project.gpx = {};
          project.gpx[idx] = {
            fileName: file.name,
            text: reader.result
          };
          saveProject(project);
          renderGpxTeamsList(container);
        };
        reader.readAsText(file);
      });

      fileLabel.appendChild(fileInput);
      statusWrap.appendChild(fileLabel);
    }

    row.appendChild(badge);
    row.appendChild(nameSpan);
    row.appendChild(statusWrap);
    container.appendChild(row);
  });
}

// -------------------------------------------------------------
// 5. ZÁLOŽKA: VYHODNOCENÍ (PŘIPOJENÍ MODULU)
// -------------------------------------------------------------
function initStep5Evaluate() {
  const mountEl = document.getElementById('evaluate-mount');
  if (!mountEl) return;

  // Dynamický import vyhodnocovacího modulu od jiného agenta
  import('./ui/evaluate.js')
    .then(module => {
      if (typeof module.mountEvaluate === 'function') {
        mountEl.innerHTML = '';
        module.mountEvaluate(mountEl, { getProject, saveProject });
      }
    })
    .catch(err => {
      console.error('Chyba při načítání js/ui/evaluate.js:', err);
    });
}
