/* =========================================================
 * Module: Regions & Holidays
 *
 * Two-tab page:
 *   - Regions list — CRUD for regions
 *   - Holiday calendar — for the selected region, view/edit/add holidays
 *
 * Holidays drive forecast adjustment: when a queue is assigned to one or
 * more regions, the forecast engine looks up holidays in the forecast
 * window and applies their impactMult / impactDelta to those weeks.
 *
 * Data lives in WFM.Regions (src/data/regions.js), persisted to localStorage.
 * ========================================================= */
(function (WFM) {
  'use strict';
  const M = {};

  M.mount = function (root, state) {
    const UI = WFM.UI;

    // Page state lives on a module property — survives tab switches within a session
    M._state = M._state || { tab: 'regions', selectedRegionId: null };
    const s = M._state;
    // Initialize selectedRegionId if needed
    if (!s.selectedRegionId) {
      const all = WFM.Regions ? WFM.Regions.list() : [];
      s.selectedRegionId = all[0]?.id || null;
    }

    render();

    function render() {
      const canManage = WFM.RBAC ? WFM.RBAC.can('admin.manage_regions') || WFM.RBAC.can('queue.edit') : true;
      UI.html(root, `
        <div class="page">
          <div class="page-head">
            <div>
              <h1>Regions & Holidays</h1>
              <div class="sub">Manage regional holiday calendars used for holiday-aware forecasting. Each holiday has an impact factor that the engine applies when forecasting future weeks.</div>
            </div>
            <div class="actions">
              ${canManage ? `<button class="btn ghost" id="resetRegions">${WFM.Icons.refresh || ''} Reset to defaults</button>` : ''}
              ${canManage ? `<button class="btn primary" id="addRegion">${WFM.Icons.plus || '+'} Add region</button>` : ''}
            </div>
          </div>

          <div class="grid cols-2" style="grid-template-columns: 280px 1fr; gap: var(--space-4); align-items: flex-start; margin-top: var(--space-3)">
            <div id="regionList"></div>
            <div id="holidayPanel"></div>
          </div>
        </div>
      `);

      UI.$('#addRegion', root)?.addEventListener('click', openAddRegionDialog);
      UI.$('#resetRegions', root)?.addEventListener('click', () => {
        if (!confirm('Reset all regions and holidays to factory defaults? Any custom changes will be lost.')) return;
        WFM.Regions.resetToDefaults();
        s.selectedRegionId = WFM.Regions.list()[0]?.id || null;
        UI.toast('Regions reset to defaults', 'ok');
        render();
      });

      renderRegionList(UI.$('#regionList', root));
      renderHolidayPanel(UI.$('#holidayPanel', root));
    }

    function renderRegionList(host) {
      const regions = WFM.Regions ? WFM.Regions.list() : [];
      const canManage = WFM.RBAC ? WFM.RBAC.can('admin.manage_regions') || WFM.RBAC.can('queue.edit') : true;

      host.innerHTML = `
        <div class="card">
          <div class="card-head">
            <div><h3>Regions</h3><div class="sub">${regions.length} total</div></div>
          </div>
          <div class="card-body" style="padding: 0; max-height: 600px; overflow-y: auto">
            ${regions.length === 0 ? `<div class="empty" style="padding: 24px"><p>No regions yet.</p></div>` : regions.map(r => `
              <div class="qrow ${r.id === s.selectedRegionId ? 'active' : ''}" data-rid="${r.id}">
                <div style="flex: 1; min-width: 0">
                  <div class="qname">${escapeHTML(r.label)}</div>
                  <div class="muted t-small">${r.id} · ${r.holidays.length} holidays</div>
                </div>
                ${canManage ? `<button class="icon-btn" data-del-region="${r.id}" title="Delete region">${WFM.Icons.close}</button>` : ''}
              </div>
            `).join('')}
          </div>
        </div>
      `;

      UI.$$('.qrow', host).forEach(el => {
        el.addEventListener('click', e => {
          if (e.target.closest('[data-del-region]')) return;
          s.selectedRegionId = el.dataset.rid;
          render();
        });
      });
      UI.$$('[data-del-region]', host).forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const r = WFM.Regions.get(btn.dataset.delRegion);
          if (!r) return;
          if (!confirm(`Delete region "${r.label}" and its ${r.holidays.length} holidays? This cannot be undone.`)) return;
          WFM.Regions.deleteRegion(r.id);
          if (s.selectedRegionId === r.id) {
            s.selectedRegionId = WFM.Regions.list()[0]?.id || null;
          }
          UI.toast(`Deleted region "${r.label}"`, 'ok');
          render();
        });
      });
    }

    function renderHolidayPanel(host) {
      const region = s.selectedRegionId ? WFM.Regions.get(s.selectedRegionId) : null;
      const canManage = WFM.RBAC ? WFM.RBAC.can('admin.manage_regions') || WFM.RBAC.can('queue.edit') : true;

      if (!region) {
        host.innerHTML = `
          <div class="card">
            <div class="card-body" style="padding: 60px; text-align: center">
              <h3>No region selected</h3>
              <p class="muted">Pick a region from the list or click "+ Add region" to create one.</p>
            </div>
          </div>
        `;
        return;
      }

      // Group by year for readability
      const byYear = {};
      region.holidays.forEach(h => {
        const yr = (h.date || '').slice(0, 4) || 'undated';
        (byYear[yr] = byYear[yr] || []).push(h);
      });
      const years = Object.keys(byYear).sort();

      host.innerHTML = `
        <div class="card">
          <div class="card-head">
            <div>
              <h3>${escapeHTML(region.label)}</h3>
              <div class="sub">${region.holidays.length} holidays · used for holiday-aware forecasting</div>
            </div>
            <div class="actions" style="gap: 8px">
              ${canManage ? `
                <label class="btn ghost" style="cursor: pointer; margin: 0">
                  ${WFM.Icons.upload || ''} Upload CSV
                  <input type="file" id="uploadCsv" accept=".csv,.tsv,.txt" style="display: none">
                </label>
                <button class="btn primary" id="addHoliday">${WFM.Icons.plus || '+'} Add holiday</button>
              ` : ''}
            </div>
          </div>
          <div class="card-body" style="padding: 0">
            ${region.holidays.length === 0 ? `
              <div class="empty" style="padding: 40px"><p>No holidays defined for ${escapeHTML(region.label)}.</p>${canManage ? `<p class="muted t-small">Click "+ Add holiday" above or upload a CSV with columns: name, date, impactMult.</p>` : ''}</div>
            ` : `
              <table class="tbl">
                <thead>
                  <tr><th>Date</th><th>Holiday</th><th class="num">Impact ×</th><th class="num">Delta</th><th>Note</th><th class="num"></th></tr>
                </thead>
                <tbody>
                  ${years.flatMap(yr => [
                    `<tr><td colspan="6" style="background: var(--bg-1); font-weight: 600; font-size: 11px; letter-spacing: 0.08em; color: var(--fg-2); padding: 6px 12px">${yr}</td></tr>`,
                    ...byYear[yr].map(h => `
                      <tr data-hid="${h.id}">
                        <td><input class="inline-edit hd-field" data-field="date" value="${h.date}" ${canManage ? '' : 'readonly'} style="font-family: var(--font-mono); font-size: 12px; width: 110px"></td>
                        <td><input class="inline-edit hd-field" data-field="name" value="${escapeHTML(h.name)}" ${canManage ? '' : 'readonly'}></td>
                        <td class="num"><input class="inline-edit hd-field" data-field="impactMult" value="${h.impactMult != null ? h.impactMult : ''}" ${canManage ? '' : 'readonly'} style="text-align: right; width: 70px; font-family: var(--font-mono)" placeholder="1.00"></td>
                        <td class="num"><input class="inline-edit hd-field" data-field="impactDelta" value="${h.impactDelta != null ? h.impactDelta : ''}" ${canManage ? '' : 'readonly'} style="text-align: right; width: 70px; font-family: var(--font-mono)" placeholder="0"></td>
                        <td><input class="inline-edit hd-field muted" data-field="note" value="${escapeHTML(h.note || '')}" ${canManage ? '' : 'readonly'} placeholder="—"></td>
                        <td class="num">${canManage ? `<button class="icon-btn" data-del-hol="${h.id}" title="Delete">${WFM.Icons.close}</button>` : ''}</td>
                      </tr>
                    `)
                  ]).join('')}
                </tbody>
              </table>
            `}
          </div>
          <div class="card-body" style="padding: 10px 14px; border-top: 1px solid var(--border-soft); background: var(--bg-1)">
            <div class="muted t-small">
              <b>Impact ×</b> is multiplicative: 0.3 means volume drops to 30%, 1.65 means +65%.
              <b>Delta</b> is an absolute number added on top (use sparingly). Empty = no impact.
            </div>
          </div>
        </div>
      `;

      // Wire add-holiday
      UI.$('#addHoliday', host)?.addEventListener('click', () => openAddHolidayDialog(region));

      // Wire CSV upload
      UI.$('#uploadCsv', host)?.addEventListener('change', e => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
          const rows = parseHolidayCsv(ev.target.result);
          if (!rows.length) { UI.toast('No holiday rows found in CSV', 'warn'); return; }
          const result = WFM.Regions.bulkImport(region.id, rows);
          if (result.ok) {
            UI.toast(`Imported ${result.added} holidays${result.skipped ? ` · skipped ${result.skipped}` : ''}`, 'ok');
            render();
          }
        };
        reader.readAsText(file);
        e.target.value = '';   // allow re-upload of same file
      });

      // Wire inline edits (save on blur)
      UI.$$('.hd-field', host).forEach(inp => {
        const original = inp.value;
        const commit = () => {
          if (!canManage) return;
          const tr = inp.closest('tr');
          const hid = tr.dataset.hid;
          const field = inp.dataset.field;
          let value = inp.value.trim();
          if (field === 'name' && !value) {
            UI.toast('Name cannot be empty', 'warn');
            inp.value = original; return;
          }
          if (field === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
            UI.toast('Date must be YYYY-MM-DD', 'warn');
            inp.value = original; return;
          }
          if ((field === 'impactMult' || field === 'impactDelta') && value !== '' && !isFinite(+value)) {
            UI.toast('Must be a number', 'warn');
            inp.value = original; return;
          }
          if (value === original) return;
          WFM.Regions.updateHoliday(region.id, hid, { [field]: value === '' ? null : (field === 'name' || field === 'date' || field === 'note' ? value : +value) });
          render();
        };
        inp.addEventListener('blur', commit);
        inp.addEventListener('keydown', e => {
          if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
          if (e.key === 'Escape') { inp.value = original; inp.blur(); }
        });
      });

      // Wire delete-holiday
      UI.$$('[data-del-hol]', host).forEach(btn => btn.addEventListener('click', () => {
        const hid = btn.dataset.delHol;
        const h = region.holidays.find(x => x.id === hid);
        if (!h) return;
        if (!confirm(`Delete "${h.name}" on ${h.date}?`)) return;
        WFM.Regions.deleteHoliday(region.id, hid);
        UI.toast('Holiday deleted', 'ok');
        render();
      }));
    }

    /* ====================================================
     * Add Region dialog
     * ==================================================== */
    function openAddRegionDialog() {
      const dialog = document.createElement('div');
      dialog.className = 'modal-scrim';
      dialog.innerHTML = `
        <div class="modal" style="max-width: 440px">
          <div class="modal-head">
            <h3>Add region</h3>
            <button class="icon-btn" id="arClose">${WFM.Icons.close}</button>
          </div>
          <div class="modal-body stack">
            <div class="field">
              <label>Region code <span class="muted t-small">— short ID like AMER, EMEA, APJ</span></label>
              <input class="input" id="arId" placeholder="e.g. AFRICA" maxlength="20" autocomplete="off">
            </div>
            <div class="field">
              <label>Display label</label>
              <input class="input" id="arLabel" placeholder="e.g. Africa (Sub-Saharan)" autocomplete="off">
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn ghost" id="arCancel">Cancel</button>
            <button class="btn primary" id="arCreate">Create region</button>
          </div>
        </div>
      `;
      document.body.appendChild(dialog);
      const close = () => dialog.remove();
      dialog.querySelector('#arClose').addEventListener('click', close);
      dialog.querySelector('#arCancel').addEventListener('click', close);
      dialog.addEventListener('click', e => { if (e.target === dialog) close(); });
      dialog.querySelector('#arCreate').addEventListener('click', () => {
        const id = dialog.querySelector('#arId').value.trim().toUpperCase();
        const label = dialog.querySelector('#arLabel').value.trim();
        if (!id || !label) { UI.toast('Both fields are required', 'warn'); return; }
        if (!/^[A-Z0-9_-]+$/.test(id)) { UI.toast('Region code: letters, digits, underscore, dash only', 'warn'); return; }
        const ok = WFM.Regions.addRegion({ id, label });
        if (!ok) { UI.toast('Region code already exists', 'warn'); return; }
        s.selectedRegionId = id;
        UI.toast(`Region "${label}" created`, 'ok');
        close();
        render();
      });
      setTimeout(() => dialog.querySelector('#arId').focus(), 30);
    }

    /* ====================================================
     * Add Holiday dialog
     * ==================================================== */
    function openAddHolidayDialog(region) {
      const dialog = document.createElement('div');
      dialog.className = 'modal-scrim';
      const today = new Date().toISOString().slice(0, 10);
      dialog.innerHTML = `
        <div class="modal" style="max-width: 480px">
          <div class="modal-head">
            <h3>Add holiday — ${escapeHTML(region.label)}</h3>
            <button class="icon-btn" id="ahClose">${WFM.Icons.close}</button>
          </div>
          <div class="modal-body stack">
            <div class="field">
              <label>Holiday name</label>
              <input class="input" id="ahName" placeholder="e.g. Diwali, Memorial Day" autocomplete="off">
            </div>
            <div class="field">
              <label>Date</label>
              <input class="input" type="date" id="ahDate" value="${today}">
            </div>
            <div class="grid cols-2" style="gap: 12px">
              <div class="field">
                <label>Impact × <span class="muted t-small">— multiplier</span></label>
                <input class="input" id="ahMult" type="number" step="0.05" min="0" max="5" value="0.5" placeholder="0.5">
                <div class="muted t-small" style="margin-top: 4px">e.g. 0.3 = volume drops 70%; 1.65 = volume rises 65%</div>
              </div>
              <div class="field">
                <label>Delta <span class="muted t-small">— absolute</span></label>
                <input class="input" id="ahDelta" type="number" step="10" placeholder="(optional)">
                <div class="muted t-small" style="margin-top: 4px">Adds an absolute amount on top of the multiplier</div>
              </div>
            </div>
            <div class="field">
              <label>Note <span class="muted t-small">— optional</span></label>
              <input class="input" id="ahNote" placeholder="e.g. Retail spike — adjust per industry" autocomplete="off">
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn ghost" id="ahCancel">Cancel</button>
            <button class="btn primary" id="ahCreate">Add holiday</button>
          </div>
        </div>
      `;
      document.body.appendChild(dialog);
      const close = () => dialog.remove();
      dialog.querySelector('#ahClose').addEventListener('click', close);
      dialog.querySelector('#ahCancel').addEventListener('click', close);
      dialog.addEventListener('click', e => { if (e.target === dialog) close(); });
      dialog.querySelector('#ahCreate').addEventListener('click', () => {
        const name = dialog.querySelector('#ahName').value.trim();
        const date = dialog.querySelector('#ahDate').value;
        const mult = dialog.querySelector('#ahMult').value;
        const delta = dialog.querySelector('#ahDelta').value;
        const note = dialog.querySelector('#ahNote').value.trim();
        if (!name) { UI.toast('Holiday name is required', 'warn'); return; }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { UI.toast('Date must be YYYY-MM-DD', 'warn'); return; }
        WFM.Regions.addHoliday(region.id, {
          name, date,
          impactMult: mult !== '' ? +mult : null,
          impactDelta: delta !== '' ? +delta : null,
          note
        });
        UI.toast(`Added "${name}" on ${date}`, 'ok');
        close();
        render();
      });
      setTimeout(() => dialog.querySelector('#ahName').focus(), 30);
    }
  };

  /* ====================================================
   * CSV parser — expects header row with name, date, and optional
   * impactMult / impactDelta / note columns
   * ==================================================== */
  function parseHolidayCsv(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return [];
    const split = (line) => {
      const out = [];
      let cur = '', inQ = false;
      for (const ch of line) {
        if (ch === '"') { inQ = !inQ; continue; }
        if (ch === ',' && !inQ) { out.push(cur); cur = ''; continue; }
        cur += ch;
      }
      out.push(cur);
      return out.map(s => s.trim());
    };
    const headers = split(lines[0]).map(h => h.toLowerCase());
    const findCol = (name) => headers.indexOf(name);
    const iName  = findCol('name');
    const iDate  = findCol('date');
    const iMult  = findCol('impactmult') >= 0 ? findCol('impactmult') : findCol('multiplier');
    const iDelta = findCol('impactdelta') >= 0 ? findCol('impactdelta') : findCol('delta');
    const iNote  = findCol('note') >= 0 ? findCol('note') : findCol('description');
    if (iName < 0 || iDate < 0) return [];
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const c = split(lines[i]);
      const date = c[iDate];
      const name = c[iName];
      if (!name || !date) continue;
      // Accept YYYY-MM-DD or YYYY/MM/DD or DD/MM/YYYY
      let normDate = date;
      if (/^\d{4}\/\d{2}\/\d{2}$/.test(date)) normDate = date.replace(/\//g, '-');
      else if (/^\d{2}\/\d{2}\/\d{4}$/.test(date)) {
        const [d, m, y] = date.split('/');
        normDate = `${y}-${m}-${d}`;
      }
      rows.push({
        name, date: normDate,
        impactMult:  iMult  >= 0 ? c[iMult]  : null,
        impactDelta: iDelta >= 0 ? c[iDelta] : null,
        note:        iNote  >= 0 ? c[iNote]  : ''
      });
    }
    return rows;
  }

  function escapeHTML(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  WFM.Modules = WFM.Modules || {};
  WFM.Modules.regions = M;
})(window.WFM = window.WFM || {});
