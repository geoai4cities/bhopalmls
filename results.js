// Per-class result tables: main Table 4 and supplementary Tables 6, 8, 9, rendered from
// assets/results_tables.json, which results/build_results_tables.py reads from the camera-ready
// LaTeX (values and the paper's marks: best overall, best within category, lowest overall).
// Each [data-results-tables="sem12,sem21"] element becomes a tabbed table: paper order with the
// category rows by default, category chips to show a subset, and a click on a column header sorts
// by it (descending, ascending, back to paper order).

const DATA_URL = 'assets/results_tables.json';
const DATA_VERSION = 'v=1';    // bump when the JSON is rebuilt

const mounts = [...document.querySelectorAll('[data-results-tables]')];
if (mounts.length) {
  fetch(`${DATA_URL}?${DATA_VERSION}`)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((data) => {
      const byId = new Map(data.tables.map((t) => [t.id, t]));
      for (const el of mounts) {
        const tables = el.dataset.resultsTables.split(',').map((id) => byId.get(id.trim())).filter(Boolean);
        if (tables.length) mount(el, tables);
      }
    })
    .catch((err) => {
      console.error(err);
      for (const el of mounts) el.innerHTML = `<p class="muted">The result tables could not load (${escapeHtml(err.message)}).</p>`;
    });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// "Linear Probe (9ch: XYZ + Partial RGB + normals)" -> "Linear Probe · 9ch"
function shortGroup(name) {
  const ch = (name.match(/(\d+ch)/) || [])[1];
  const base = name.replace(/\s*[–-]\s*\d+ch.*$/, '').replace(/\s*\(.*$/, '').replace('Supervised Learning', 'Supervised');
  return ch ? `${base} · ${ch}` : base;
}

const LEGEND_SEMANTIC = 'LP = linear probe, DP = decoder probe, LoRA = low-rank adaptation, FT = fine-tuning; 3ch = XYZ, 4ch = XYZ + intensity, 9ch = XYZ + partial RGB + normals; (L) = large, general-purpose pretrained, (O) = outdoor-pretrained; † = trained jointly with the 6 moving subclasses, folded into their static parents at evaluation.';
const LEGEND_INSTANCE = 'PointGroup head, 9ch input (XYZ + partial RGB + normals); mAP averages IoU thresholds 50:5:95; the 4 stuff classes (Ground, Vegetation, Road, Wire) are not scored; (L) = large, general-purpose pretrained, (O) = outdoor-pretrained.';

function mount(root, tables) {
  const state = { table: tables[0], hidden: new Set(), sort: null };   // sort = { col, dir }
  root.classList.add('rt');
  root.innerHTML = `
    <div class="tax-tabs rt-tabs" role="tablist" aria-label="Result table">
      ${tables.map((t, i) => `<button type="button" role="tab" data-rt-tab="${t.id}" class="${i ? '' : 'active'}" aria-selected="${!i}">${escapeHtml(t.title.split(' · ')[1].replace(/ \(.*\)/, ''))} <span class="rt-src">${escapeHtml(t.source.replace('Supplementary', 'Supp.').replace('Main paper, ', ''))}</span></button>`).join('')}
    </div>
    <div class="rt-head">
      <div>
        <h3 class="rt-title"></h3>
        <p class="rt-sub muted"></p>
      </div>
      <div class="rt-chips" role="group" aria-label="Show training categories"></div>
    </div>
    <div class="rt-wrap" tabindex="0"><table class="rt-table"><colgroup></colgroup><thead></thead><tbody></tbody></table></div>
    <p class="rt-legend muted">
      <span class="rt-key rt-best">best overall</span>
      <span class="rt-key rt-under">best within the category</span>
      <span class="rt-key rt-low">lowest overall</span>
      <span class="rt-legend-text"></span>
    </p>`;
  const el = {
    tabs: [...root.querySelectorAll('[data-rt-tab]')],
    title: root.querySelector('.rt-title'),
    sub: root.querySelector('.rt-sub'),
    chips: root.querySelector('.rt-chips'),
    table: root.querySelector('.rt-table'),
    colgroup: root.querySelector('colgroup'),
    thead: root.querySelector('thead'),
    tbody: root.querySelector('tbody'),
    legend: root.querySelector('.rt-legend-text'),
  };

  function renderChips() {
    const t = state.table;
    el.chips.innerHTML = `<button type="button" class="rt-chip${state.hidden.size ? '' : ' active'}" data-rt-all>All</button>` +
      t.groups.map((g, i) => `<button type="button" class="rt-chip${state.hidden.has(i) ? '' : ' active'}" data-rt-group="${i}" title="${escapeHtml(g.name)}">${escapeHtml(shortGroup(g.name))}</button>`).join('');
  }

  function render() {
    const t = state.table;
    const cols = [...t.metrics, ...t.classes];
    el.title.textContent = t.title;
    el.sub.textContent = `${t.source} · ${t.metrics.join(', ')} and ${t.unit} · ${t.classes.length} classes`;
    el.legend.textContent = t.task === 'semantic' ? LEGEND_SEMANTIC : LEGEND_INSTANCE;
    el.colgroup.innerHTML = '<col class="rt-col-model">' + cols.map((_, j) => `<col data-col="${j}">`).join('');
    const arrow = (j) => (state.sort && state.sort.col === j ? (state.sort.dir < 0 ? ' ▼' : ' ▲') : '');
    el.thead.innerHTML = `<tr><th class="rt-model-h">Model</th>${cols.map((c, j) => `
      <th class="rt-h${j < t.metrics.length ? ' rt-metric' : ' rt-class'}${j === t.metrics.length - 1 ? ' rt-split' : ''}${state.sort && state.sort.col === j ? ' sorted' : ''}"
          data-col="${j}" title="Sort by ${escapeHtml(c)}" aria-sort="${state.sort && state.sort.col === j ? (state.sort.dir < 0 ? 'descending' : 'ascending') : 'none'}">
        <span>${escapeHtml(c.replace(' (%)', ''))}${arrow(j)}</span></th>`).join('')}</tr>`;
    const cell = (v, j) => `<td class="${[v.best && 'rt-best', v.under && 'rt-under', v.low && 'rt-low', j === t.metrics.length - 1 && 'rt-split', j < t.metrics.length && 'rt-metric'].filter(Boolean).join(' ')}">${v.s}</td>`;
    const row = (r, g, tag) => `<tr><th scope="row" class="rt-model">${escapeHtml(r.model)}${tag ? `<span class="rt-tag">${escapeHtml(shortGroup(g.name))}</span>` : ''}</th>${r.values.map(cell).join('')}</tr>`;
    const visible = t.groups.map((g, i) => ({ g, i })).filter(({ i }) => !state.hidden.has(i));
    if (!state.sort) {
      el.tbody.innerHTML = visible.map(({ g }) => `<tr class="rt-group"><th scope="rowgroup" colspan="${cols.length + 1}">${escapeHtml(g.name)}</th></tr>` + g.rows.map((r) => row(r, g, false)).join('')).join('');
    } else {
      const flat = visible.flatMap(({ g }) => g.rows.map((r) => ({ r, g })));
      const { col, dir } = state.sort;
      flat.sort((a, b) => dir * (a.r.values[col].v - b.r.values[col].v));
      el.tbody.innerHTML = flat.map(({ r, g }) => row(r, g, true)).join('');
    }
    if (!visible.length) el.tbody.innerHTML = `<tr><td class="rt-empty" colspan="${cols.length + 1}">No category selected</td></tr>`;
  }

  function selectTable(id) {
    state.table = tables.find((t) => t.id === id);
    state.hidden.clear();
    state.sort = null;
    for (const b of el.tabs) {
      const on = b.dataset.rtTab === id;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    }
    renderChips();
    render();
  }

  for (const b of el.tabs) b.addEventListener('click', () => selectTable(b.dataset.rtTab));
  el.chips.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-rt-all')) state.hidden.clear();
    else {
      const i = Number(b.dataset.rtGroup);
      // first click on a chip while all are shown isolates that category
      if (!state.hidden.size) state.table.groups.forEach((_, k) => { if (k !== i) state.hidden.add(k); });
      else if (state.hidden.has(i)) state.hidden.delete(i);
      else state.hidden.add(i);
      if (state.hidden.size === state.table.groups.length) state.hidden.clear();
    }
    renderChips();
    render();
  });
  el.thead.addEventListener('click', (e) => {
    const th = e.target.closest('th[data-col]');
    if (!th) return;
    const col = Number(th.dataset.col);
    if (!state.sort || state.sort.col !== col) state.sort = { col, dir: -1 };
    else if (state.sort.dir < 0) state.sort = { col, dir: 1 };
    else state.sort = null;
    render();
  });
  // column highlight follows the pointer (rows highlight in CSS)
  el.table.addEventListener('pointerover', (e) => {
    const c = e.target.closest('td, th');
    const j = c && c.cellIndex > 0 && !c.closest('.rt-group') ? c.cellIndex - 1 : -1;
    for (const col of el.colgroup.children) col.classList.toggle('rt-colhl', col.dataset.col === String(j));
  });
  el.table.addEventListener('pointerleave', () => {
    for (const col of el.colgroup.children) col.classList.remove('rt-colhl');
  });

  renderChips();
  render();
}
