/* =========================================================
 * Module: Data Studio / Forecast Testing Workbench
 *
 * Goal: Give a non-technical user a controlled environment to
 *   (a) build test queues with arbitrary historical data,
 *   (b) run the Phase-2 forecasting engine against them, and
 *   (c) inspect results, accuracy, and backtest performance.
 *
 * Three data-entry modes share a single normalized model:
 *   - Manual Entry  : editable spreadsheet (Queue × Week1..N)
 *   - Pattern Gen   : synthetic series from parameterized templates
 *   - File Upload   : reuses Phase-1 WFM.CSV.ingest() pipeline
 *
 * Forecast Lab runs forecasts and (optionally) backtests by holding
 * out the last 20% of each queue's history, retraining on the rest,
 * and reporting validation accuracy.
 *
 * State is kept on WFM.State.studio so switching modules doesn't lose work.
 * ========================================================= */
(function (WFM) {
  'use strict';
  const M = {};

  /* ====================================================
   * Module-scoped state (persisted across module switches via WFM.State)
   * ==================================================== */
  function initialState() {
    return {
      tab: 'workbench',                 // 'workbench' | 'lab'
      entryMode: 'manual',              // 'manual' | 'pattern' | 'upload'
      queues: [],                       // [{ id, name, productId, channels[], channelData{}, regions[], holidayOverrides{} }]
      activeQueueId: null,
      periods: 26,                      // weeks of history in the grid (bumped from 13 → 26 to match long-range needs)
      lockedWeeks: 13,                  // global setting: weeks of "locked" forecast (intended for scheduling)
      lab: {
        horizon: 26,                    // 4 | 8 | 13 | 26 | 52 | 104
        backtest: false,
        forceModel: null,
        results: null
      }
    };
  }

  /* ====================================================
   * Public mount
   * ==================================================== */
  M.mount = function (root, state) {
    const UI = WFM.UI;
    // Lazy-init studio state on first visit — hydrate from Vault if available
    if (!state.studio) {
      const persisted = WFM.Vault ? WFM.Vault.loadStudio() : null;
      WFM.State.set({ studio: persisted || initialState() });
    } else {
      // Migrate any pre-existing queues from old single-channel shape
      const s = state.studio;
      let changed = false;
      s.queues = s.queues.map(q => {
        if (Array.isArray(q.channels) && q.channelData) return q;
        changed = true;
        return migrateQueue(q);
      });
      if (changed) WFM.State.set({ studio: s });
    }

    render();

    function render() {
      const s = WFM.State.get().studio;
      UI.html(root, `
        <div class="page">
          <div class="page-head">
            <div>
              <h1>Data Studio — Forecast Testing Workbench</h1>
              <div class="sub">Create queues · generate or input data · run controlled forecasts</div>
            </div>
            <div class="actions" id="topActions"></div>
          </div>

          <div id="tabBar" style="margin-bottom: var(--space-4)"></div>
          <div id="tabBody"></div>
        </div>
      `);

      // Tab bar
      const tabBar = UI.tabs(
        [
          { key: 'workbench', label: 'Workbench' },
          { key: 'lab',       label: `Forecast Creator${s.lab.results ? ` · ${s.lab.results.forecasts.length}` : ''}` }
        ],
        s.tab,
        (key) => { s.tab = key; WFM.State.set({ studio: s }); render(); }
      );
      UI.$('#tabBar', root).appendChild(tabBar);

      // Top actions per tab
      const topActions = UI.$('#topActions', root);
      if (s.tab === 'workbench') {
        topActions.innerHTML = `
          <button class="btn ghost" id="reset">${WFM.Icons.refresh} Reset</button>
          <button class="btn" id="addQueue">${WFM.Icons.plus || '+'} Add queue</button>
          <button class="btn primary" id="goLab">${WFM.Icons.arrow_right} Forecast Creator</button>
        `;
        UI.$('#reset', root).addEventListener('click', resetAll);
        UI.$('#addQueue', root).addEventListener('click', () => addQueue());
        UI.$('#goLab', root).addEventListener('click', () => { s.tab = 'lab'; WFM.State.set({ studio: s }); render(); });
      } else {
        topActions.innerHTML = `
          <button class="btn ghost" id="back">${WFM.Icons.arrow_left || WFM.Icons.arrow_right} Back to workbench</button>
          <button class="btn primary" id="runForecast">${WFM.Icons.spark} Run Forecast</button>
        `;
        UI.$('#back', root).addEventListener('click', () => { s.tab = 'workbench'; WFM.State.set({ studio: s }); render(); });
        UI.$('#runForecast', root).addEventListener('click', runForecast);
      }

      if (s.tab === 'workbench') renderWorkbench(UI.$('#tabBody', root), s);
      else                       renderLab(UI.$('#tabBody', root), s);
    }

    /* ====================================================
     * WORKBENCH TAB — queue list + editor + preview
     * ==================================================== */
    function renderWorkbench(root, s) {
      const active = s.queues.find(q => q.id === s.activeQueueId) || s.queues[0];
      if (!active) {
        root.innerHTML = `<div class="empty"><h4>No queues yet</h4><p>Click "Add queue" above to begin.</p></div>`;
        return;
      }
      root.innerHTML = `
        <div class="grid cols-2" style="grid-template-columns: 280px 1fr; gap: var(--space-4); align-items: flex-start">
          <div id="queueList"></div>
          <div id="editor"></div>
        </div>
      `;
      renderQueueList(UI.$('#queueList', root), s);
      renderEditor(UI.$('#editor', root), s, active);
    }

    function renderQueueList(root, s) {
      root.innerHTML = `
        <div class="card">
          <div class="card-head">
            <div>
              <h3>Queues</h3>
              <div class="sub">${s.queues.length} total · ${s.queues.filter(q => Object.values(q.channelData || {}).some(arr => arr.some(v => v > 0))).length} with data</div>
            </div>
          </div>
          <div class="card-body" style="padding: 0; max-height: 540px; overflow-y: auto">
            ${s.queues.map(q => {
              const allWeeks = Object.values(q.channelData || {});
              const totalPts = allWeeks.reduce((s, arr) => s + arr.filter(v => v > 0).length, 0);
              const totalSlots = allWeeks.reduce((s, arr) => s + arr.length, 0);
              return `
              <div class="qrow ${q.id === s.activeQueueId ? 'active' : ''}" data-qid="${q.id}">
                <div style="flex: 1; min-width: 0">
                  <div class="qname" title="${escapeHTML(q.name)}">${escapeHTML(q.name)}</div>
                  <div class="row" style="gap: 4px; margin-top: 4px; flex-wrap: wrap">
                    ${q.channels.map(ch => UI.badge(channelLabel(ch), channelBadge(ch))).join('')}
                    <span class="muted t-small">${totalPts}/${totalSlots} pts</span>
                  </div>
                </div>
                <button class="icon-btn" data-del="${q.id}" title="Delete">${WFM.Icons.close}</button>
              </div>
            `;}).join('')}
            ${s.queues.length === 0 ? `<div class="empty" style="padding: 24px"><p>No queues yet.</p></div>` : ''}
          </div>
          <div class="card-body" style="padding: var(--space-3); border-top: 1px solid var(--border-soft)">
            <button class="btn primary" id="addQueue2" style="width: 100%">+ Add queue</button>
          </div>
        </div>

        <div class="card" style="margin-top: var(--space-3)">
          <div class="card-head"><div><h3>Quick start</h3><div class="sub">Get going fast</div></div></div>
          <div class="card-body stack" style="gap: 8px">
            <button class="btn" id="sampleSet" style="width: 100%; justify-content: flex-start" data-perm="queue.bulk_seed">${WFM.Icons.spark} Load sample dataset (5 queues)</button>
            <button class="btn" id="openSources" style="width: 100%; justify-content: flex-start" data-perm="data.connect_source">${WFM.Icons.upload} Get data from source…</button>
            <button class="btn ghost" id="clearAll" style="width: 100%; justify-content: flex-start; color: var(--danger)" data-perm="queue.delete">Clear all queues</button>
          </div>
        </div>
      `;

      UI.$$('.qrow', root).forEach(el => {
        el.addEventListener('click', e => {
          if (e.target.closest('[data-del]')) return;
          s.activeQueueId = el.dataset.qid;
          WFM.State.set({ studio: s });
          render();
        });
      });
      UI.$$('[data-del]', root).forEach(b => {
        b.addEventListener('click', e => {
          e.stopPropagation();
          const id = b.dataset.del;
          if (confirm(`Delete this queue?`)) deleteQueue(id);
        });
      });
      UI.$('#addQueue2', root)?.addEventListener('click', () => addQueue());
      UI.$('#sampleSet', root)?.addEventListener('click', () => { if (WFM.RBAC.requireOrToast('queue.bulk_seed')) bulkSeed(5); });
      UI.$('#openSources', root)?.addEventListener('click', () => {
        if (!WFM.RBAC.requireOrToast('data.connect_source')) return;
        openSourcesDialog();
      });
      UI.$('#clearAll', root)?.addEventListener('click', () => {
        if (!WFM.RBAC.requireOrToast('queue.delete')) return;
        if (confirm('Clear ALL queues? This cannot be undone.')) {
          s.queues = []; s.activeQueueId = null; s.lab.results = null;
          WFM.State.set({ studio: s }); render();
        }
      });
      // Apply permission-gated visual state
      applyPermGates(root);
    }

    function renderEditor(root, s, q) {
      const allRegions = WFM.Regions ? WFM.Regions.list() : [];
      // Per-channel collapsed state tracking
      s.collapsedChannels = s.collapsedChannels || {};

      root.innerHTML = `
        <div class="card">
          <div class="card-head">
            <div style="flex:1; min-width: 0">
              ${q.productId && WFM.Products?.get(q.productId) ? `
                <div style="margin-bottom: 4px">
                  <span class="badge" style="background: ${WFM.Products.get(q.productId).color}20; color: ${WFM.Products.get(q.productId).color}; font-size: 10px; font-weight: 600; letter-spacing: 0.04em">PRODUCT · ${escapeHTML(WFM.Products.get(q.productId).name).toUpperCase()}</span>
                </div>
              ` : ''}
              <input class="input editor-name" id="qname" value="${escapeHTML(q.name)}" placeholder="Queue name">
              <div class="muted t-small" style="margin-top: 4px">
                ${q.channels.map(ch => `<span class="badge ${channelBadge(ch)}" style="margin-right:4px"><span class="dot"></span>${channelLabel(ch)}</span>`).join('')}
                ${q.regions && q.regions.length ? `· Regions: ${q.regions.map(rid => {
                  const r = allRegions.find(rr => rr.id === rid);
                  return r ? escapeHTML(r.label) : rid;
                }).join(', ')}` : '<span class="muted">· No regions assigned</span>'}
              </div>
            </div>
            <div class="actions">
              ${q.regions && q.regions.length ? `<button class="btn ghost" id="editHolidayImpacts" title="Override holiday impact factors for this queue">${WFM.Icons.globe || ''} Holiday impacts</button>` : ''}
              <button class="btn ghost" id="editQueueMeta" title="Edit product, channels, and regions">${WFM.Icons.settings || ''} Product · Channels · Regions</button>
              <button class="btn ghost" id="advancedTest" title="Generate synthetic test data">🧪 Generate test data</button>
            </div>
          </div>
        </div>

        <div id="channelSections" style="margin-top: var(--space-3)"></div>
      `;

      UI.$('#qname', root).addEventListener('input', e => {
        q.name = e.target.value || 'Untitled';
        WFM.State.set({ studio: s });
        const lbl = document.querySelector(`.qrow[data-qid="${q.id}"] .qname`);
        if (lbl) lbl.textContent = q.name;
      });
      UI.$('#editQueueMeta', root).addEventListener('click', () => openEditMetaDialog(q));
      UI.$('#editHolidayImpacts', root)?.addEventListener('click', () => openHolidayImpactsDialog(q));
      UI.$('#advancedTest', root).addEventListener('click', () => openTestDataDialog(q));

      // Render one section per enabled channel
      const sections = UI.$('#channelSections', root);
      for (const ch of q.channels) {
        const section = document.createElement('div');
        section.className = 'channel-section';
        section.dataset.ch = ch;
        sections.appendChild(section);
        renderChannelSection(section, s, q, ch);
      }
    }

    /* ====================================================
     * Channel section — one per enabled channel
     * Houses: header, sub-tabs (Manual Entry, Upload CSV), preview chart
     * ==================================================== */
    function renderChannelSection(root, s, q, channel) {
      // Per-section entry mode tracked per (queueId, channel)
      const modeKey = q.id + '::' + channel;
      s.channelModes = s.channelModes || {};
      const mode = s.channelModes[modeKey] || 'manual';

      const collapsed = s.collapsedChannels[modeKey] || false;
      ensureLength(q, s.periods);
      const weeks = q.channelData[channel] || [];
      const nonZero = weeks.filter(v => v > 0).length;

      root.innerHTML = `
        <div class="card">
          <div class="card-head" style="cursor: pointer" id="chHead">
            <div style="flex:1; display:flex; align-items:center; gap: 12px">
              <span style="font-family:var(--font-mono); color:var(--fg-3); transform: ${collapsed ? 'rotate(-90deg)' : 'rotate(0)'}; transition: transform var(--t-fast)">▾</span>
              <span class="badge ${channelBadge(channel)}" style="font-size:11px"><span class="dot"></span>${channelLabel(channel)}</span>
              <h3 style="margin:0; font-size:14px">${escapeHTML(q.name)} — ${channelLabel(channel)} actuals</h3>
              <span class="muted t-small">· ${nonZero}/${weeks.length} weeks with data</span>
            </div>
            ${q.channels.length > 1 ? `<button class="icon-btn" id="removeCh" title="Remove this channel from the queue" data-ch="${channel}">${WFM.Icons.close}</button>` : ''}
          </div>
          ${!collapsed ? `
            <div class="card-body" style="padding-top: 0">
              <div id="chTabs"></div>
              <div id="chBody" style="margin-top: var(--space-3)"></div>
              <div id="chPreview" style="margin-top: var(--space-4)"></div>
            </div>
          ` : ''}
        </div>
      `;

      UI.$('#chHead', root).addEventListener('click', e => {
        if (e.target.closest('#removeCh')) return;
        s.collapsedChannels[modeKey] = !collapsed;
        WFM.State.set({ studio: s });
        renderChannelSection(root, s, q, channel);
      });

      const removeBtn = UI.$('#removeCh', root);
      if (removeBtn) {
        removeBtn.addEventListener('click', e => {
          e.stopPropagation();
          if (!WFM.RBAC.requireOrToast('queue.edit')) return;
          if (!confirm(`Remove the ${channelLabel(channel)} channel from "${q.name}"? Its data will be lost.`)) return;
          q.channels = q.channels.filter(c => c !== channel);
          delete q.channelData[channel];
          WFM.State.set({ studio: s });
          render();
        });
      }

      if (collapsed) return;

      const tabBar = UI.tabs(
        [
          { key: 'manual',  label: 'Manual Entry' },
          { key: 'upload',  label: 'Upload CSV' }
        ],
        mode,
        (key) => { s.channelModes[modeKey] = key; WFM.State.set({ studio: s }); renderChannelSection(root, s, q, channel); }
      );
      UI.$('#chTabs', root).appendChild(tabBar);

      const body = UI.$('#chBody', root);
      if (mode === 'manual')      renderManualEntry(body, s, q, channel);
      else if (mode === 'upload') renderUploadEntry(body, s, q, channel);

      renderPreview(UI.$('#chPreview', root), s, q, channel);
    }

    /* ====================================================
     * Channel & Regions edit dialog (post-creation)
     * ==================================================== */
    function openEditMetaDialog(q) {
      if (!WFM.RBAC.requireOrToast('queue.edit')) return;
      const s = WFM.State.get().studio;
      const allRegions = WFM.Regions ? WFM.Regions.list() : [];
      const allProducts = WFM.Products ? WFM.Products.list() : [];

      const dialog = document.createElement('div');
      dialog.className = 'modal-scrim';
      dialog.innerHTML = `
        <div class="modal" style="max-width: 560px">
          <div class="modal-head">
            <h3>Product, Channels & Regions — ${escapeHTML(q.name)}</h3>
            <button class="icon-btn" id="emClose">${WFM.Icons.close}</button>
          </div>
          <div class="modal-body stack">
            ${allProducts.length > 0 ? `
              <div class="field">
                <label>Product</label>
                <select class="select" id="emProduct">
                  <option value="">— Unassigned —</option>
                  ${allProducts.map(p => `<option value="${p.id}" ${(q.productId || '') === p.id ? 'selected' : ''}>${escapeHTML(p.name)}</option>`).join('')}
                </select>
              </div>
            ` : ''}
            <div class="field">
              <label>Enabled channels <span class="muted t-small">— each channel maintains its own actuals + forecast</span></label>
              <div class="grid cols-2" style="gap: 8px">
                ${CHANNELS.map(c => `
                  <label class="channel-pick ${q.channels.includes(c.id) ? 'selected' : ''}">
                    <input type="checkbox" class="em-ch-cb" data-ch="${c.id}" ${q.channels.includes(c.id) ? 'checked' : ''}>
                    <span class="badge ${channelBadge(c.id)}"><span class="dot"></span>${c.label}</span>
                    <span class="muted t-small" style="margin-top:4px">${channelHelp(c.id)}</span>
                  </label>
                `).join('')}
              </div>
              <div class="muted t-small" style="margin-top:6px">Removing a channel deletes its historical data.</div>
            </div>
            ${allRegions.length ? `
              <div class="field">
                <label>Regions</label>
                <div class="grid cols-2" style="gap: 6px">
                  ${allRegions.map(r => `
                    <label class="region-pick ${q.regions && q.regions.includes(r.id) ? 'selected' : ''}">
                      <input type="checkbox" class="em-rg-cb" data-rg="${r.id}" ${q.regions && q.regions.includes(r.id) ? 'checked' : ''}>
                      <span>
                        <span style="font-size:13px;color:var(--fg-0)">${escapeHTML(r.label)}</span>
                        <span class="muted t-small">${r.holidays.length} holidays</span>
                      </span>
                    </label>
                  `).join('')}
                </div>
              </div>
            ` : ''}
          </div>
          <div class="modal-foot">
            <button class="btn ghost" id="emCancel">Cancel</button>
            <button class="btn primary" id="emSave">Save changes</button>
          </div>
        </div>
      `;
      document.body.appendChild(dialog);
      const close = () => dialog.remove();

      dialog.querySelectorAll('.channel-pick, .region-pick').forEach(lbl => {
        lbl.addEventListener('click', e => {
          if (e.target.tagName === 'INPUT') return;
          const cb = lbl.querySelector('input[type=checkbox]');
          cb.checked = !cb.checked;
          lbl.classList.toggle('selected', cb.checked);
        });
        const cb = lbl.querySelector('input[type=checkbox]');
        cb.addEventListener('change', () => lbl.classList.toggle('selected', cb.checked));
      });

      dialog.querySelector('#emClose').addEventListener('click', close);
      dialog.querySelector('#emCancel').addEventListener('click', close);
      dialog.addEventListener('click', e => { if (e.target === dialog) close(); });
      dialog.querySelector('#emSave').addEventListener('click', () => {
        const newChannels = Array.from(dialog.querySelectorAll('.em-ch-cb:checked')).map(cb => cb.dataset.ch);
        const newRegions  = Array.from(dialog.querySelectorAll('.em-rg-cb:checked')).map(cb => cb.dataset.rg);
        const newProductId = dialog.querySelector('#emProduct')?.value || null;
        if (!newChannels.length) {
          UI.toast('A queue must have at least one channel', 'warn');
          return;
        }
        // Drop data for removed channels; init empty arrays for added ones
        const newChannelData = {};
        for (const ch of newChannels) {
          newChannelData[ch] = q.channelData[ch] || new Array(s.periods).fill(0);
        }
        q.channels = newChannels;
        q.channelData = newChannelData;
        q.regions = newRegions;
        q.productId = newProductId || null;
        WFM.State.set({ studio: s });
        UI.toast('Queue updated', 'ok');
        close();
        render();
      });
    }

    /* ====================================================
     * MANUAL ENTRY — editable spreadsheet (per channel)
     * ==================================================== */
    function renderManualEntry(root, s, q, channel) {
      const periods = s.periods;
      ensureLength(q, periods);
      const weeks = q.channelData[channel];

      const canEditActuals = WFM.RBAC.can('data.edit_actuals');
      root.innerHTML = `
        ${!canEditActuals ? `<div style="padding: 8px 12px; margin-bottom: var(--space-3); background: var(--warn-bg); border-radius: var(--r-2); font-size: 12.5px; color: var(--warn)">🔒 Read-only — your role (${WFM.RBAC.currentRole()?.label}) cannot edit historical actuals.</div>` : ''}
        <div class="row between" style="align-items: center; margin-bottom: var(--space-3)">
          <div>
            <div class="t-micro">Spreadsheet · ${periods} weeks of history · ${channelLabel(channel)}</div>
            <div class="muted t-small">Tab/Enter to move between cells · paste a row of numbers to fill at once</div>
          </div>
          <div class="row" style="gap: 8px; align-items: center">
            <button class="btn ghost" id="remW" data-perm="data.edit_actuals">−1 week</button>
            <span class="num">${periods}</span>
            <button class="btn ghost" id="addW" data-perm="data.edit_actuals">+1 week</button>
            <span style="width: 12px"></span>
            <button class="btn ghost" id="clear" data-perm="data.edit_actuals">Clear all</button>
            <button class="btn ghost" id="setAll" data-perm="data.edit_actuals">Set all to…</button>
          </div>
        </div>

        <div style="overflow-x: auto">
          <table class="tbl manual-grid">
            <thead>
              <tr>
                <th style="position: sticky; left: 0; background: var(--bg-2); z-index: 1; min-width: 100px">Week start</th>
                ${Array.from({length: periods}, (_,i) => {
                  const d = weekStartDate(periods, i);
                  return `<th class="num" title="${d}">W${i+1}<div class="muted t-micro" style="font-weight:400">${d.slice(5)}</div></th>`;
                }).join('')}
                <th class="num">Total</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style="position: sticky; left: 0; background: var(--bg-2); z-index: 1"><b>${channelLabel(channel)}</b></td>
                ${weeks.map((v, i) => `<td class="num"><input class="cell-input" data-i="${i}" value="${v != null && !isNaN(v) ? v : ''}" inputmode="numeric" ${canEditActuals ? '' : 'readonly'}></td>`).join('')}
                <td class="num"><b>${sum(weeks).toLocaleString()}</b></td>
              </tr>
            </tbody>
          </table>
        </div>
      `;

      UI.$$('.cell-input', root).forEach(inp => {
        inp.addEventListener('input', e => {
          const i = +e.target.dataset.i;
          const v = e.target.value.replace(/[,\s]/g, '');
          weeks[i] = v === '' ? 0 : (isFinite(+v) ? +v : 0);
          const total = sum(weeks);
          const tcell = root.querySelector('tbody tr td:last-child b');
          if (tcell) tcell.textContent = total.toLocaleString();
          WFM.State.set({ studio: s });
          debouncedPreview(s, q, channel);
        });
        inp.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === 'Tab') {
            const next = root.querySelector(`.cell-input[data-i="${+inp.dataset.i + 1}"]`);
            if (next) { e.preventDefault(); next.focus(); next.select(); }
          }
        });
        inp.addEventListener('paste', e => {
          const txt = (e.clipboardData || window.clipboardData).getData('text');
          if (!txt) return;
          const parts = txt.split(/[\s,\t]+/).map(s => s.trim()).filter(Boolean).map(s => +s).filter(n => isFinite(n));
          if (parts.length <= 1) return;
          e.preventDefault();
          const startI = +inp.dataset.i;
          parts.forEach((val, k) => {
            const idx = startI + k;
            if (idx < weeks.length) weeks[idx] = val;
          });
          WFM.State.set({ studio: s });
          render();
        });
      });

      UI.$('#addW', root).addEventListener('click', () => { if (!WFM.RBAC.requireOrToast('data.edit_actuals')) return; s.periods = Math.min(104, s.periods + 1); WFM.State.set({ studio: s }); render(); });
      UI.$('#remW', root).addEventListener('click', () => { if (!WFM.RBAC.requireOrToast('data.edit_actuals')) return; s.periods = Math.max(4, s.periods - 1); WFM.State.set({ studio: s }); render(); });
      UI.$('#clear', root).addEventListener('click', () => { if (!WFM.RBAC.requireOrToast('data.edit_actuals')) return; q.channelData[channel] = new Array(periods).fill(0); WFM.State.set({ studio: s }); render(); });
      UI.$('#setAll', root).addEventListener('click', () => {
        if (!WFM.RBAC.requireOrToast('data.edit_actuals')) return;
        const v = prompt(`Set every week to which value?`, '500');
        if (v == null) return;
        const n = +v;
        if (!isFinite(n)) return;
        q.channelData[channel] = new Array(periods).fill(n);
        WFM.State.set({ studio: s }); render();
      });
      applyPermGates(root);
    }

    let previewDebounce = null;
    function debouncedPreview(s, q, channel) {
      clearTimeout(previewDebounce);
      previewDebounce = setTimeout(() => {
        // Find the preview node for this specific channel section
        const section = document.querySelector(`.channel-section[data-ch="${channel}"]`);
        if (section) {
          const prev = section.querySelector('#chPreview');
          if (prev) renderPreview(prev, s, q, channel);
        }
      }, 300);
    }

    /* ====================================================
     * UPLOAD ENTRY
     * ==================================================== */
    function renderUploadEntry(root, s, q, channel) {
      root.innerHTML = `
        <div class="upload-strip" id="dropzone" title="Drop CSV here or click Choose file. Wide format (Queue × Week 1…N) or long format (Date / Volume) — both work. Data goes into ${channelLabel(channel)} for this queue.">
          <span class="upload-strip-icon">${WFM.Icons.upload}</span>
          <div class="upload-strip-text">
            <b>Drop CSV for ${channelLabel(channel)}</b>
            <span class="muted t-small">or click Choose file · auto-detects wide/long format</span>
          </div>
          <button class="btn primary" id="pick">Choose file</button>
          <input type="file" id="file" accept=".csv,.tsv,.txt" style="display: none">
        </div>
      `;

      const dz = UI.$('#dropzone', root);
      const fi = UI.$('#file', root);
      UI.$('#pick', root).addEventListener('click', () => fi.click());
      fi.addEventListener('change', e => e.target.files[0] && processFile(e.target.files[0]));
      dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('over'));
      dz.addEventListener('drop', e => {
        e.preventDefault(); dz.classList.remove('over');
        const f = e.dataTransfer.files[0];
        if (f) processFile(f);
      });

      function processFile(file) {
        const reader = new FileReader();
        reader.onload = ev => {
          const ingest = WFM.CSV.ingest(ev.target.result);
          if (!ingest.cleanedData.length) {
            UI.toast('No usable rows in file', 'danger');
            return;
          }
          // Use the first queue's rows; the queue field in the CSV is ignored —
          // we're populating this specific channel of the active queue.
          const grouped = {};
          for (const r of ingest.cleanedData) {
            const key = r.queue;
            if (!grouped[key]) grouped[key] = [];
            grouped[key].push(r);
          }
          const firstKey = Object.keys(grouped)[0];
          const rows = grouped[firstKey];
          rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
          const newWeeks = rows.map(r => +r.volume);
          // Extend periods if file has more weeks than current grid
          if (newWeeks.length > s.periods) s.periods = Math.min(104, newWeeks.length);
          q.channelData[channel] = newWeeks;
          ensureLength(q, s.periods);
          WFM.State.set({ studio: s });
          UI.toast(`Imported ${newWeeks.length} weeks of ${channelLabel(channel)} data`, 'ok');
          render();
        };
        reader.readAsText(file);
      }
    }

    /* ====================================================
     * PREVIEW — chart + summary stats per active queue
     * ==================================================== */
    function renderPreview(root, s, q, channel) {
      const cleaned = (q.channelData[channel] || []).map(v => isFinite(v) ? v : 0);
      const st = stats(cleaned);

      const guidance = [];
      const nonZero = cleaned.filter(v => v > 0).length;
      if (nonZero < 8) guidance.push({ kind: 'warn', text: `Only ${nonZero} non-zero data points — forecast accuracy will be limited.` });
      if (st.cv > 0.50) guidance.push({ kind: 'warn', text: `High volatility detected (CoV ${st.cv.toFixed(2)}) — forecast confidence will be low.` });

      // Stats-based insights
      if (nonZero >= 4 && WFM.Forecasting?.Stats) {
        const trend = WFM.Forecasting.Stats.detectTrend(cleaned);
        if (Math.abs(trend.pctPerStep) < 0.005 && st.cv < 0.20) guidance.push({ kind: 'ok', text: `Series looks stable with no significant trend — Moving Average is likely best.` });
        if (trend.direction === 'up')   guidance.push({ kind: 'info', text: `Increasing trend detected: +${(trend.pctPerStep*100).toFixed(2)}% per week.` });
        if (trend.direction === 'down') guidance.push({ kind: 'info', text: `Decreasing trend detected: ${(trend.pctPerStep*100).toFixed(2)}% per week.` });
        const seas = WFM.Forecasting.Stats.detectSeasonality(cleaned, 4);
        if (seas.detected) guidance.push({ kind: 'info', text: `Cyclic pattern detected at period ${seas.period} (autocorrelation ${seas.strength.toFixed(2)}).` });
      }

      // Detect anomalies (volume spikes/drops) using the forecasting Stats helpers
      let anomalies = [];
      if (nonZero >= 7 && WFM.Forecasting?.Stats) {
        try {
          anomalies = WFM.Forecasting.Stats.anomalies(cleaned, 2.5) || [];
        } catch (_) {}
      }

      // Cross-reference each week against the queue's regional holiday calendars
      const periods = cleaned.length;
      const weekStartDates = Array.from({length: periods}, (_, i) => weekStartDate(periods, i));
      let weeklyHolidays = [];
      if (WFM.Regions && q.regions && q.regions.length) {
        weeklyHolidays = WFM.Regions.holidaysForWeeks(weekStartDates, q.regions);
      }

      // Build annotated flags: each week may be (anomaly, holiday, both, neither)
      const weekFlags = cleaned.map((v, i) => {
        const isAnomaly = anomalies.some(a => a.index === i);
        const anomalyInfo = anomalies.find(a => a.index === i);
        const holiday = weeklyHolidays[i] && weeklyHolidays[i][0];
        return { i, value: v, date: weekStartDates[i], isAnomaly, anomalyInfo, holiday };
      });

      // Chart with anomaly dots (red for spikes, blue for drops)
      const anomalyMarkers = weekFlags.filter(w => w.isAnomaly).map(w => ({
        index: w.i,
        value: w.value,
        z: w.anomalyInfo?.z || 0,
        type: w.anomalyInfo?.type || 'spike'
      }));

      const chart = WFM.Charts.line({
        series: [{ name: channelLabel(channel), data: cleaned, color: 'var(--accent)', showDots: cleaned.length <= 20 }],
        categories: cleaned.map((_, i) => i % 2 === 0 ? `W${i+1}` : ''),
        height: 220,
        anomalies: anomalyMarkers
      });

      // Flagged-weeks panel: anomalies that match a holiday vs unexplained
      const matchedFlags = weekFlags.filter(w => w.isAnomaly && w.holiday);
      const unexplainedFlags = weekFlags.filter(w => w.isAnomaly && !w.holiday);
      const upcomingHolidays = weeklyHolidays.filter(Boolean).flat()
        .filter(h => h.holiday.date >= new Date().toISOString().slice(0, 10))
        .slice(0, 5);

      root.innerHTML = `
        <div class="card">
          <div class="card-head">
            <div>
              <h3>Preview · ${channelLabel(channel)}</h3>
              <div class="sub">${cleaned.length} weeks · ${nonZero} non-zero${anomalies.length ? ` · ${anomalies.length} anomal${anomalies.length===1?'y':'ies'} flagged` : ''}</div>
            </div>
          </div>
          <div class="card-body">
            <div class="grid cols-4" style="margin-bottom: var(--space-3)">
              ${UI.kpiHTML({ label: 'Mean / wk', value: Math.round(st.mean).toLocaleString(), accent: true })}
              ${UI.kpiHTML({ label: 'Min', value: Math.round(st.min).toLocaleString() })}
              ${UI.kpiHTML({ label: 'Max', value: Math.round(st.max).toLocaleString() })}
              ${UI.kpiHTML({ label: 'Volatility (CoV)', value: st.cv.toFixed(2), delta: st.cv > 0.5 ? 'high' : st.cv > 0.25 ? 'medium' : 'low', deltaDir: st.cv > 0.5 ? 'down' : 'flat' })}
            </div>

            <div class="chart" style="height: 240px">${chart}</div>

            ${anomalies.length > 0 ? `
              <div style="margin-top: var(--space-4)">
                <div class="t-micro" style="margin-bottom: 8px">Flagged weeks</div>
                <div class="stack" style="gap: 6px">
                  ${matchedFlags.map(w => `
                    <div style="display: flex; gap: 10px; padding: 8px 12px; background: var(--accent-bg); border-radius: var(--r-2); font-size: 12.5px">
                      <span class="badge accent" style="font-size:10px"><span class="dot"></span>HOLIDAY MATCH</span>
                      <span style="color: var(--fg-0)"><b>W${w.i+1}</b> (${w.date}) — ${w.value.toLocaleString()} contacts · ${w.anomalyInfo.type === 'drop' ? 'lower' : 'higher'} than expected</span>
                      <span class="muted t-small">↳ ${escapeHTML(w.holiday.holiday.name)} (${w.holiday.region})</span>
                    </div>
                  `).join('')}
                  ${unexplainedFlags.map(w => `
                    <div style="display: flex; gap: 10px; padding: 8px 12px; background: var(--warn-bg); border-radius: var(--r-2); font-size: 12.5px">
                      <span class="badge warn" style="font-size:10px"><span class="dot"></span>UNEXPLAINED</span>
                      <span style="color: var(--fg-0)"><b>W${w.i+1}</b> (${w.date}) — ${w.value.toLocaleString()} contacts · ${w.anomalyInfo.type === 'drop' ? 'lower' : 'higher'} than expected</span>
                      <span class="muted t-small">No regional holiday found · possible event, outage, or campaign</span>
                    </div>
                  `).join('')}
                </div>
              </div>
            ` : ''}

            ${upcomingHolidays.length > 0 ? `
              <div style="margin-top: var(--space-4); padding: 10px 12px; background: var(--bg-1); border-radius: var(--r-2); border: 1px solid var(--border-soft)">
                <div class="t-micro" style="margin-bottom: 6px">Upcoming holidays in selected regions — will be applied to forecasts</div>
                <div class="stack" style="gap: 4px">
                  ${upcomingHolidays.map(h => `
                    <div style="display: flex; justify-content: space-between; font-size: 12px">
                      <span><b>${escapeHTML(h.holiday.name)}</b> · ${h.holiday.date} <span class="muted t-small">(${h.region})</span></span>
                      <span class="muted">${h.holiday.impactMult != null ? `× ${h.holiday.impactMult.toFixed(2)}` : ''}${h.holiday.impactDelta ? ` ${h.holiday.impactDelta > 0 ? '+' : ''}${h.holiday.impactDelta}` : ''}</span>
                    </div>
                  `).join('')}
                </div>
              </div>
            ` : ''}

            ${guidance.length > 0 ? `
              <div class="stack" style="margin-top: var(--space-3)">
                ${guidance.map(g => `
                  <div style="display: flex; gap: 10px; padding: 8px 12px; background: ${g.kind === 'warn' ? 'var(--warn-bg)' : g.kind === 'ok' ? 'var(--ok-bg)' : 'var(--accent-bg)'}; border-radius: var(--r-2); font-size: 12.5px">
                    <span style="color: ${g.kind === 'warn' ? 'var(--warn)' : g.kind === 'ok' ? 'var(--ok)' : 'var(--accent)'}; font-weight: 600">${g.kind.toUpperCase()}</span>
                    <span style="color: var(--fg-1)">${g.text}</span>
                  </div>
                `).join('')}
              </div>
            ` : ''}
          </div>
        </div>
      `;
    }

    /* ====================================================
     * FORECAST LAB TAB
     * ==================================================== */
    function renderLab(root, s) {
      // Enumerate every (queue, channel) pair with enough data
      const allPairs = [];
      for (const q of s.queues) {
        for (const ch of q.channels) {
          const weeks = q.channelData[ch] || [];
          const nonZero = weeks.filter(v => v > 0).length;
          allPairs.push({ q, ch, weeks, nonZero, eligible: nonZero >= 4 });
        }
      }
      const ready = allPairs.filter(p => p.eligible);
      const insufficient = allPairs.filter(p => !p.eligible);
      // Horizon options: 4w, 8w, 13w (1 quarter), 26w (2Q), 52w (1 year), 104w (2 years)
      const horizonOpts = [
        { weeks: 4,   label: '4w' },
        { weeks: 8,   label: '8w' },
        { weeks: 13,  label: '1Q' },
        { weeks: 26,  label: '2Q' },
        { weeks: 52,  label: '1Y' },
        { weeks: 104, label: '2Y' }
      ];
      // Migrate older studio state that defaulted to 12 → 13 (one quarter)
      if (s.lab.horizon === 12) s.lab.horizon = 13;
      // Default locked window
      if (s.lockedWeeks == null) s.lockedWeeks = 13;

      // Maintain selection set in lab state — key format "queueId::channel"
      s.lab.selected = s.lab.selected || {};
      // Default: all eligible pairs selected on first visit
      if (Object.keys(s.lab.selected).length === 0 && ready.length) {
        ready.forEach(p => { s.lab.selected[p.q.id + '::' + p.ch] = true; });
      }

      root.innerHTML = `
        <div class="grid cols-2" style="grid-template-columns: 340px 1fr; gap: var(--space-4); align-items: flex-start">
          <div class="stack">
            <div class="card">
              <div class="card-head"><div><h3>Forecast Settings</h3></div></div>
              <div class="card-body stack">
                <div class="field">
                  <label>Forecast horizon</label>
                  <div class="btn-group" id="horizonGroup">
                    ${horizonOpts.map(o => `<button class="btn ${s.lab.horizon === o.weeks ? 'active' : ''}" data-h="${o.weeks}" title="${o.weeks} weeks">${o.label}</button>`).join('')}
                  </div>
                  <div class="muted t-small" style="margin-top: 4px">Longer horizons widen the confidence band. Use 1Y–2Y for hiring plans, 1Q for scheduling.</div>
                </div>

                <div class="field">
                  <label>Locked window: <b>${s.lockedWeeks}</b> weeks</label>
                  <input class="slider" type="range" id="lockedWeeks" min="2" max="26" step="1" value="${s.lockedWeeks}">
                  <div class="muted t-small" style="margin-top: 4px">Forecasts inside this window are intended for scheduling. Beyond it, weeks are indicative — refresh as new actuals come in.</div>
                </div>

                <div class="field">
                  <label style="display: flex; align-items: center; justify-content: space-between; cursor: pointer">
                    <span>Enable backtesting</span>
                    <input type="checkbox" id="bt" ${s.lab.backtest ? 'checked' : ''}>
                  </label>
                  <div class="muted t-small" style="margin-top: 4px">Holds out last 20% of each series' history, trains on the rest, reports MAPE/WAPE/MAE.</div>
                </div>

                <div class="field">
                  <label>Force model (optional)</label>
                  <select class="select" id="forceModel">
                    <option value="">Auto-select (recommended)</option>
                    <option value="movingAverageModel"         ${s.lab.forceModel === 'movingAverageModel'         ? 'selected' : ''}>Moving Average</option>
                    <option value="weightedMovingAverageModel" ${s.lab.forceModel === 'weightedMovingAverageModel' ? 'selected' : ''}>Weighted MA</option>
                    <option value="regressionModel"            ${s.lab.forceModel === 'regressionModel'            ? 'selected' : ''}>Linear Regression</option>
                    <option value="seasonalityModel"           ${s.lab.forceModel === 'seasonalityModel'           ? 'selected' : ''}>Seasonal Decomposition</option>
                    <option value="holtWintersModel"           ${s.lab.forceModel === 'holtWintersModel'           ? 'selected' : ''}>Holt-Winters</option>
                    <option value="ensembleModel"              ${s.lab.forceModel === 'ensembleModel'              ? 'selected' : ''}>Ensemble</option>
                  </select>
                </div>
              </div>
            </div>

            <div class="card">
              <div class="card-head">
                <div><h3>Queues & channels to forecast</h3><div class="sub">${ready.length} eligible · ${insufficient.length} excluded</div></div>
                <div class="actions" style="gap: 4px">
                  <button class="btn ghost t-small" id="selAll" style="padding: 4px 8px">Select all</button>
                  <button class="btn ghost t-small" id="selNone" style="padding: 4px 8px">Clear</button>
                </div>
              </div>
              <div class="card-body" style="padding: 0; max-height: 420px; overflow-y: auto">
                ${ready.length === 0 ? `
                  <div class="empty" style="padding: 24px"><p>No queue/channel combinations have ≥ 4 non-zero weeks yet.</p></div>
                ` : ready.map(p => {
                  const key = p.q.id + '::' + p.ch;
                  return `
                    <label class="pair-pick" style="display:flex; align-items:center; gap:10px; padding: 10px 12px; border-bottom: 1px solid var(--border-soft); cursor: pointer">
                      <input type="checkbox" class="pair-cb" data-key="${key}" ${s.lab.selected[key] ? 'checked' : ''}>
                      <div style="flex:1; min-width:0">
                        <div style="font-size: 13px; color: var(--fg-0)">${escapeHTML(p.q.name)}</div>
                        <div class="muted t-small" style="margin-top:2px">
                          <span class="badge ${channelBadge(p.ch)}" style="font-size:10px"><span class="dot"></span>${channelLabel(p.ch)}</span>
                          · ${p.nonZero} weeks of data
                          ${p.q.regions && p.q.regions.length ? ` · ${p.q.regions.join(', ')}` : ''}
                        </div>
                      </div>
                    </label>
                  `;
                }).join('')}
                ${insufficient.length > 0 ? `
                  <div style="padding: 8px 12px; border-top: 1px solid var(--border-soft); background: var(--warn-bg); font-size: 11px; color: var(--warn)">
                    ⚠ ${insufficient.length} channel${insufficient.length > 1 ? 's' : ''} excluded (need ≥ 4 non-zero weeks): ${insufficient.map(p => `${p.q.name} · ${channelLabel(p.ch)}`).join('; ')}
                  </div>
                ` : ''}
              </div>
            </div>
          </div>

          <div id="labBody"></div>
        </div>
      `;

      UI.$$('#horizonGroup .btn', root).forEach(b => b.addEventListener('click', () => {
        s.lab.horizon = +b.dataset.h;
        WFM.State.set({ studio: s });
        UI.$$('#horizonGroup .btn', root).forEach(x => x.classList.toggle('active', +x.dataset.h === s.lab.horizon));
      }));
      UI.$('#lockedWeeks', root)?.addEventListener('input', e => {
        s.lockedWeeks = +e.target.value;
        // Update the label live
        const lbl = e.target.previousElementSibling;
        if (lbl) lbl.innerHTML = `Locked window: <b>${s.lockedWeeks}</b> weeks`;
        WFM.State.set({ studio: s });
      });
      UI.$('#bt', root).addEventListener('change', e => { s.lab.backtest = e.target.checked; WFM.State.set({ studio: s }); });
      UI.$('#forceModel', root).addEventListener('change', e => { s.lab.forceModel = e.target.value || null; WFM.State.set({ studio: s }); });

      UI.$$('.pair-cb', root).forEach(cb => cb.addEventListener('change', e => {
        s.lab.selected[cb.dataset.key] = e.target.checked;
        WFM.State.set({ studio: s });
      }));
      UI.$('#selAll', root)?.addEventListener('click', () => {
        ready.forEach(p => { s.lab.selected[p.q.id + '::' + p.ch] = true; });
        WFM.State.set({ studio: s });
        renderLab(root, s);
      });
      UI.$('#selNone', root)?.addEventListener('click', () => {
        s.lab.selected = {};
        WFM.State.set({ studio: s });
        renderLab(root, s);
      });

      renderLabBody(UI.$('#labBody', root), s);
    }

    function renderLabBody(root, s) {
      const results = s.lab.results;
      if (!results) {
        root.innerHTML = `
          <div class="card">
            <div class="card-body" style="padding: 60px; text-align: center">
              <div style="font-size: 36px; color: var(--fg-3); margin-bottom: var(--space-3)">${WFM.Icons.spark}</div>
              <h3 style="margin: 0 0 6px">Ready to run forecasts</h3>
              <p class="muted" style="max-width: 480px; margin: 0 auto">
                Click <b>Run Forecast</b> in the top-right to test the forecasting engine on every eligible queue.
                Results will appear here with per-queue charts, model picked, accuracy, confidence, and explanation.
              </p>
            </div>
          </div>
        `;
        return;
      }

      const sum = results.summary;
      const avgAccTxt = sum.avg_accuracy != null ? `${(sum.avg_accuracy*100).toFixed(1)}%` : 'N/A';
      root.innerHTML = `
        <div class="grid cols-4" style="margin-bottom: var(--space-4)">
          ${UI.kpiHTML({ label: 'Forecasts run', value: sum.total_queues.toString(), accent: true })}
          ${UI.kpiHTML({ label: results.backtest ? 'Avg validation accuracy' : 'Avg in-sample accuracy', value: avgAccTxt })}
          ${UI.kpiHTML({ label: 'Low-confidence queues', value: sum.counts.lowConfidence.toString(), deltaDir: sum.counts.lowConfidence > 0 ? 'down' : 'flat' })}
          ${UI.kpiHTML({ label: 'Insufficient data', value: sum.counts.insufficient.toString(), deltaDir: sum.counts.insufficient > 0 ? 'down' : 'flat' })}
        </div>

        ${results.backtest ? UI.insight(
          'Backtesting mode',
          `Each queue's history was split 80/20. The first 80% was used to train + select a model; the last 20% was held out as a validation window. The MAPE and WAPE shown below compare the held-out predictions against actuals. Compare with the in-sample accuracy to see how well the model generalizes.`,
          ''
        ) : ''}

        <div class="stack">
          ${results.forecasts.map(r => renderResultCard(r, results.backtest)).join('')}
        </div>
      `;
    }

    function renderResultCard(r, backtest) {
      const UI = WFM.UI;
      const actual = r.history_volumes.slice();
      const yhat   = r.forecast.slice();
      const lo     = r.confidence_interval?.map(c => c[0]) || [];
      const hi     = r.confidence_interval?.map(c => c[1]) || [];

      const totalLen = actual.length + yhat.length;
      const actualSeries = actual.concat(new Array(yhat.length).fill(null));

      // Split the forecast into Locked vs Indicative.
      // r.locked.weeks tells us how many of the forecast weeks are inside the
      // locked window. If r.locked isn't present (legacy), treat everything
      // as locked.
      const lockedWks = r.locked?.weeks != null ? r.locked.weeks : yhat.length;
      const lockedYhat     = yhat.slice(0, lockedWks);
      const indicativeYhat = yhat.slice(lockedWks);

      // Locked series: covers weeks [actual.length .. actual.length + lockedWks]
      const lockedSeries = new Array(actual.length).fill(null)
        .concat(lockedYhat)
        .concat(new Array(indicativeYhat.length).fill(null));
      // Indicative series: starts AT the last locked point (so the line connects)
      // then continues to end. Padding with nulls before.
      const indicativeSeries = new Array(actual.length + Math.max(0, lockedWks - 1)).fill(null);
      if (lockedWks > 0 && indicativeYhat.length > 0) indicativeSeries.push(lockedYhat[lockedWks - 1]);
      indicativeSeries.push(...indicativeYhat);
      // Pad indicative to totalLen
      while (indicativeSeries.length < totalLen) indicativeSeries.push(null);

      const ciLo = new Array(actual.length).fill(null).concat(lo);
      const ciHi = new Array(actual.length).fill(null).concat(hi);

      let validationSeries = null;
      if (backtest && r.backtest) {
        validationSeries = new Array(actual.length).fill(null).concat(r.backtest.actual);
      }

      const series = [
        { name: 'Actual',   data: actualSeries,   color: 'var(--c-cyan)', showDots: false }
      ];
      if (lockedYhat.length > 0) {
        series.push({ name: 'Forecast (locked)', data: lockedSeries, color: 'var(--accent)', dashed: false, showDots: false });
      }
      if (indicativeYhat.length > 0) {
        series.push({ name: 'Forecast (indicative)', data: indicativeSeries, color: 'var(--accent)', dashed: true, showDots: false });
      }
      if (validationSeries) {
        series.push({ name: 'Held-out actual', data: validationSeries, color: 'var(--c-pink)', showDots: true });
      }

      const chart = WFM.Charts.line({
        series,
        ciLo, ciHi,
        categories: Array.from({length: totalLen}, (_, i) => i % 4 === 0 ? (i < actual.length ? `W${i+1}` : `F${i - actual.length + 1}`) : ''),
        height: 260
      });

      const confColor = r.confidence?.level === 'High' ? 'ok' : r.confidence?.level === 'Medium' ? 'warn' : 'danger';
      const accTxt = r.accuracy_score != null ? `${(r.accuracy_score*100).toFixed(1)}%` : 'N/A';
      const btMape = backtest && r.backtest && r.backtest.errors && isFinite(r.backtest.errors.mape) ? `${(r.backtest.errors.mape*100).toFixed(1)}%` : null;
      const btMae  = backtest && r.backtest && r.backtest.errors && isFinite(r.backtest.errors.mae)  ? r.backtest.errors.mae.toFixed(1) : null;

      // Locked / indicative averages for KPI strip
      const lockedAvg = lockedYhat.length ? lockedYhat.reduce((s,v)=>s+v,0) / lockedYhat.length : null;
      const indicativeAvg = indicativeYhat.length ? indicativeYhat.reduce((s,v)=>s+v,0) / indicativeYhat.length : null;

      const kpis = `
        <div class="grid cols-${backtest && r.backtest ? 5 : 4}">
          ${UI.kpiHTML({ label: 'Model used', value: r.model_label || '—', accent: true })}
          ${UI.kpiHTML({ label: 'Accuracy', value: accTxt, delta: backtest ? 'on held-out' : 'walk-fwd validation', deltaDir: 'flat' })}
          ${UI.kpiHTML({ label: 'Confidence', value: r.confidence?.level || 'N/A' })}
          ${UI.kpiHTML({ label: 'Anomalies', value: (r.anomalies?.length || 0).toString() })}
          ${backtest && r.backtest ? UI.kpiHTML({ label: 'Validation MAPE', value: btMape || 'N/A', delta: btMae ? `MAE ${btMae}` : '', deltaDir: btMape && parseFloat(btMape) < 10 ? 'up' : 'down' }) : ''}
        </div>
        ${lockedYhat.length > 0 || indicativeYhat.length > 0 ? `
          <div class="grid cols-2" style="margin-top: var(--space-3)">
            ${lockedYhat.length > 0 ? UI.kpiHTML({
              label: `Locked window (${lockedYhat.length}w · avg)`,
              value: lockedAvg != null ? Math.round(lockedAvg).toLocaleString() : '—',
              delta: 'use for scheduling',
              deltaDir: 'flat',
              accent: true
            }) : ''}
            ${indicativeYhat.length > 0 ? UI.kpiHTML({
              label: `Indicative window (${indicativeYhat.length}w · avg)`,
              value: indicativeAvg != null ? Math.round(indicativeAvg).toLocaleString() : '—',
              delta: 'directional · re-run as actuals come in',
              deltaDir: 'flat'
            }) : ''}
          </div>
        ` : ''}
      `;

      const fcTable = `
        <div style="margin-top: var(--space-3); max-height: 200px; overflow-y: auto">
          <table class="tbl">
            <thead><tr><th>Week</th><th class="num">Forecast</th><th class="num">Low (p5)</th><th class="num">High (p95)</th>${backtest && r.backtest ? '<th class="num">Actual</th><th class="num">Error %</th>' : ''}</tr></thead>
            <tbody>
              ${r.forecast.map((v, i) => {
                const actVal = backtest && r.backtest && r.backtest.actual ? r.backtest.actual[i] : null;
                const errPct = (actVal != null && actVal !== 0) ? Math.abs((v - actVal) / actVal) * 100 : null;
                return `
                  <tr>
                    <td>F${i+1}</td>
                    <td class="num">${Math.round(v).toLocaleString()}</td>
                    <td class="num muted">${r.confidence_interval && r.confidence_interval[i] ? Math.round(r.confidence_interval[i][0]).toLocaleString() : '—'}</td>
                    <td class="num muted">${r.confidence_interval && r.confidence_interval[i] ? Math.round(r.confidence_interval[i][1]).toLocaleString() : '—'}</td>
                    ${backtest && r.backtest ? `
                      <td class="num">${actVal != null ? Math.round(actVal).toLocaleString() : '—'}</td>
                      <td class="num ${errPct != null && errPct > 20 ? 's-danger' : errPct != null && errPct > 10 ? 's-warn' : 's-ok'}">${errPct != null ? errPct.toFixed(1)+'%' : '—'}</td>
                    ` : ''}
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      `;

      const explanationHTML = r.explanation && r.explanation.length
        ? `<ul style="padding-left: 18px; margin: 8px 0 0; line-height: 1.7">${r.explanation.map(e => `<li>${escapeHTML(e)}</li>`).join('')}</ul>`
        : '';
      const driversHTML = r.confidence?.drivers
        ? `<div class="muted t-small" style="margin-top: 8px">Drivers: ${r.confidence.drivers.join(' · ')}</div>`
        : '';

      return `
        <div class="card">
          <div class="card-head">
            <div>
              <h3>${escapeHTML(r.queue)} · ${UI.badge(r.channel, channelBadge(r.channel))}</h3>
              <div class="sub">${r.history_volumes.length} weeks of history · ${r.forecast.length} weeks forecast</div>
            </div>
            <div class="actions">
              <span class="badge ${confColor}"><span class="dot"></span>${r.confidence?.level || 'N/A'}</span>
            </div>
          </div>
          <div class="card-body">
            ${r.warning ? `
              <div style="padding: 12px; background: var(--danger-bg); border: 1px solid var(--danger); border-radius: var(--r-2); margin-bottom: var(--space-3); color: var(--danger); font-size: 13px">
                <b>⚠ ${escapeHTML(r.warning)}</b>
              </div>
            ` : ''}

            ${kpis}

            ${r.forecast.length > 0 ? `
              <div class="chart" style="height: 280px; margin-top: var(--space-3)">${chart}</div>
              <div class="row" style="gap: 16px; font-size: 11px; color: var(--fg-2); justify-content: flex-end; margin-top: 6px; flex-wrap: wrap">
                <span><span style="display:inline-block;width:10px;height:2px;background:var(--c-cyan);vertical-align:middle"></span> Actual</span>
                ${lockedYhat.length > 0 ? `<span><span style="display:inline-block;width:10px;height:2px;background:var(--accent);vertical-align:middle"></span> Forecast (locked)</span>` : ''}
                ${indicativeYhat.length > 0 ? `<span><span style="display:inline-block;width:10px;height:0;border-top:2px dashed var(--accent);vertical-align:middle"></span> Forecast (indicative)</span>` : ''}
                ${validationSeries ? `<span><span style="display:inline-block;width:8px;height:8px;background:var(--c-pink);border-radius:50%;vertical-align:middle"></span> Held-out actual</span>` : ''}
                <span><span style="display:inline-block;width:10px;height:10px;background:var(--accent);opacity:0.15;vertical-align:middle"></span> 90% CI (widens with horizon)</span>
              </div>
            ` : ''}

            ${explanationHTML ? `
              <div style="margin-top: var(--space-4); padding: 12px; background: var(--bg-1); border-radius: var(--r-2); border: 1px solid var(--border-soft)">
                <div class="t-micro" style="margin-bottom: 4px">Explanation</div>
                ${explanationHTML}
                ${driversHTML}
              </div>
            ` : ''}

            ${r.forecast.length > 0 ? fcTable : ''}
          </div>
        </div>
      `;
    }

    /* ====================================================
     * RUN FORECAST
     * ==================================================== */
    function runForecast() {
      const s = WFM.State.get().studio;

      // Build list of selected (queue, channel) pairs
      const selectedPairs = [];
      for (const q of s.queues) {
        for (const ch of q.channels) {
          const key = q.id + '::' + ch;
          if (s.lab.selected && s.lab.selected[key]) {
            selectedPairs.push({ q, ch, weeks: q.channelData[ch] || [] });
          }
        }
      }

      if (selectedPairs.length === 0) {
        UI.toast('Select at least one queue/channel to forecast', 'warn');
        return;
      }
      const eligiblePairs = selectedPairs.filter(p => p.weeks.filter(v => v > 0).length >= 4);
      if (eligiblePairs.length === 0) {
        UI.toast('Selected queues have less than 4 weeks of non-zero data', 'warn');
        return;
      }

      const horizon = s.lab.horizon;
      const backtest = s.lab.backtest;
      const forceModel = s.lab.forceModel || undefined;

      const results = { backtest, forecasts: [], summary: { total_queues: 0, avg_accuracy: null, counts: { total: 0, insufficient: 0, lowConfidence: 0, highRisk: 0 } } };

      for (const { q, ch, weeks } of selectedPairs) {
        const nonZero = weeks.filter(v => v > 0);
        const displayName = q.channels.length > 1 ? `${q.name} · ${channelLabel(ch)}` : q.name;

        if (nonZero.length < 4) {
          results.forecasts.push({
            queue: displayName, channel: ch,
            history_volumes: weeks.slice(),
            forecast: [], confidence_interval: [],
            warning: 'Insufficient data for reliable forecast',
            confidence: { level: 'Low', drivers: ['Need at least 4 non-zero observations'] },
            explanation: [`Only ${nonZero.length} non-zero data points found.`]
          });
          continue;
        }

        // Compute holiday alignment for history + forecast windows
        const N = weeks.length;
        const histDates = Array.from({length: N}, (_, i) => weekStartDate(N, i));
        const futureDates = [];
        for (let i = 1; i <= horizon; i++) {
          const d = new Date(histDates[N - 1] + 'T00:00:00Z');
          d.setUTCDate(d.getUTCDate() + i * 7);
          futureDates.push(d.toISOString().slice(0, 10));
        }
        const histHolidaysRaw = WFM.Regions && q.regions?.length
          ? WFM.Regions.holidaysForWeeks(histDates, q.regions)
          : [];
        const futHolidaysRaw  = WFM.Regions && q.regions?.length
          ? WFM.Regions.holidaysForWeeks(futureDates, q.regions)
          : [];
        // Flatten + apply per-queue overrides. Each holiday's effective impact
        // comes from: queue override > region default. The engine sees only the
        // resolved values.
        const overrides = q.holidayOverrides || {};
        const resolveImpact = (entry) => {
          if (!entry || !entry[0]) return null;
          const h = entry[0].holiday;
          const eff = WFM.Regions.effectiveImpact(h, overrides);
          return {
            name: h.name,
            impactMult: eff.impactMult,
            impactDelta: eff.impactDelta
          };
        };
        const historyHolidays = histHolidaysRaw.map(resolveImpact);
        const forecastHolidays = futHolidaysRaw.map(resolveImpact);

        let fc;
        if (backtest) {
          const valLen = Math.max(1, Math.min(12, Math.floor(N * 0.20)));
          const train = weeks.slice(0, N - valLen);
          const heldOut = weeks.slice(N - valLen);
          const trainHolidays = historyHolidays.slice(0, N - valLen);
          const forecastWindowHolidays = historyHolidays.slice(N - valLen).concat(forecastHolidays);
          const fcAll = WFM.Forecasting.forecastSeries(train, valLen + horizon, {
            forceModel,
            historyHolidays: trainHolidays,
            forecastHolidays: forecastWindowHolidays,
            lockedWeeks: s.lockedWeeks
          });
          const errs = WFM.Forecasting.Stats.errors(heldOut, fcAll.yhat.slice(0, valLen));
          fc = {
            queue: displayName, channel: ch,
            history_volumes: train,
            forecast: fcAll.yhat.slice(valLen),
            confidence_interval: fcAll.confidence_interval?.slice(valLen) || [],
            model_used: fcAll.model, model_label: fcAll.modelLabel,
            accuracy_score: isFinite(errs.wape) ? Math.max(0, 1 - errs.wape) : null,
            confidence: { ...fcAll.confidence, level: isFinite(errs.wape) && errs.wape < 0.15 ? 'High' : isFinite(errs.wape) && errs.wape < 0.30 ? 'Medium' : 'Low' },
            explanation: fcAll.explanation,
            anomalies: fcAll.anomalies,
            holidayLog: fcAll.holidayLog,
            forecastAdjustments: fcAll.forecastAdjustments,
            warning: fcAll.warning,
            // Locked/indicative split for the future portion only (after valLen)
            locked: {
              yhat: fcAll.yhat.slice(valLen, valLen + s.lockedWeeks),
              weeks: Math.min(s.lockedWeeks, horizon)
            },
            indicative: {
              yhat: fcAll.yhat.slice(valLen + s.lockedWeeks),
              weeks: Math.max(0, horizon - s.lockedWeeks)
            },
            queueId: q.id, channelKey: ch, regions: q.regions || [], productId: q.productId || null,
            backtest: { actual: heldOut, predicted: fcAll.yhat.slice(0, valLen), errors: errs }
          };
        } else {
          const fcOut = WFM.Forecasting.forecastSeries(weeks, horizon, {
            forceModel,
            historyHolidays,
            forecastHolidays,
            lockedWeeks: s.lockedWeeks
          });
          fc = {
            queue: displayName, channel: ch,
            history_volumes: weeks.slice(),
            forecast: fcOut.yhat,
            confidence_interval: fcOut.confidence_interval,
            model_used: fcOut.model, model_label: fcOut.modelLabel,
            accuracy_score: fcOut.accuracy,
            confidence: fcOut.confidence,
            explanation: fcOut.explanation,
            anomalies: fcOut.anomalies,
            holidayLog: fcOut.holidayLog,
            forecastAdjustments: fcOut.forecastAdjustments,
            warning: fcOut.warning,
            locked: fcOut.locked,
            indicative: fcOut.indicative,
            queueId: q.id, channelKey: ch, regions: q.regions || [], productId: q.productId || null
          };
        }

        results.forecasts.push(fc);
      }

      const accs = results.forecasts.map(f => f.accuracy_score).filter(v => v != null && isFinite(v));
      results.summary.total_queues = results.forecasts.length;
      results.summary.avg_accuracy = accs.length ? accs.reduce((s,v)=>s+v, 0) / accs.length : null;
      results.summary.counts.total = results.forecasts.length;
      results.summary.counts.insufficient = results.forecasts.filter(f => f.warning).length;
      results.summary.counts.lowConfidence = results.forecasts.filter(f => f.confidence?.level === 'Low').length;
      results.summary.counts.highRisk = results.summary.counts.insufficient + results.summary.counts.lowConfidence;

      s.lab.results = results;
      WFM.State.set({ studio: s });
      UI.toast(`Forecast completed for ${results.forecasts.length} channel${results.forecasts.length !== 1 ? 's' : ''}`, 'ok');
      render();
    }

    /* ====================================================
     * Queue ops
     * ==================================================== */
    function addQueue() {
      if (!WFM.RBAC.requireOrToast('queue.create')) return;
      openCreateQueueDialog();
    }

    /* ====================================================
     * TEST DATA DIALOG — opens via 🧪 button in queue editor
     * NOT the production forecast flow. Generates synthetic historical
     * actuals to stress-test the engine against known patterns.
     * Replaces the chosen channel's existing data.
     * ==================================================== */
    /* ====================================================
     * HOLIDAY IMPACTS DIALOG
     * Per-queue override of the regional default impact factor for each
     * holiday. The engine takes overrides > region defaults.
     * Also surfaces an "implied impact" computed from this queue's actuals
     * when ≥2 occurrences exist in history — the AI-suggestion layer.
     * ==================================================== */
    function openHolidayImpactsDialog(q) {
      if (!WFM.RBAC.requireOrToast('queue.edit')) return;
      if (!q.regions || !q.regions.length) {
        UI.toast('Assign regions to this queue first to see applicable holidays', 'warn');
        return;
      }
      const s = WFM.State.get().studio;
      q.holidayOverrides = q.holidayOverrides || {};

      // Collect every holiday that falls inside the queue's history+forecast window
      const N = s.periods;
      const horizon = s.lab.horizon || 26;
      const histDates = Array.from({length: N}, (_, i) => weekStartDate(N, i));
      const futDates = [];
      for (let i = 1; i <= horizon; i++) {
        const d = new Date(histDates[N - 1] + 'T00:00:00Z');
        d.setUTCDate(d.getUTCDate() + i * 7);
        futDates.push(d.toISOString().slice(0, 10));
      }
      const histHits = WFM.Regions.holidaysForWeeks(histDates, q.regions);
      const futHits = WFM.Regions.holidaysForWeeks(futDates, q.regions);
      const seen = new Map();
      [...histHits, ...futHits].forEach(matches => {
        if (!matches) return;
        for (const m of matches) {
          if (!seen.has(m.holiday.id)) seen.set(m.holiday.id, { holiday: m.holiday, region: m.region, regionLabel: m.regionLabel });
        }
      });
      const applicable = Array.from(seen.values()).sort((a, b) => a.holiday.date.localeCompare(b.holiday.date));

      // For each applicable holiday, try to compute an implied impact from this
      // queue's combined actuals (sum across channels, by week)
      const summedWeeks = histDates.map((_, i) => {
        let total = 0;
        for (const ch of q.channels) total += (q.channelData[ch]?.[i] || 0);
        return total;
      });
      const suggestions = {};
      for (const entry of applicable) {
        const suggestion = WFM.Regions.suggestImpactFromHistory(summedWeeks, histDates, entry.holiday.name, q.regions);
        if (suggestion) suggestions[entry.holiday.id] = suggestion;
      }

      const dialog = document.createElement('div');
      dialog.className = 'modal-scrim';
      dialog.innerHTML = `
        <div class="modal" style="max-width: 900px">
          <div class="modal-head">
            <div>
              <h3>Holiday impacts for "${escapeHTML(q.name)}"</h3>
              <div class="muted t-small">Override how each holiday affects this specific queue. Empty = use regional default.</div>
            </div>
            <button class="icon-btn" id="hiClose">${WFM.Icons.close}</button>
          </div>
          <div class="modal-body" style="padding: 0">
            ${applicable.length === 0 ? `
              <div class="empty" style="padding: 40px"><p>No holidays in the current window for this queue's regions (${q.regions.join(', ')}).</p></div>
            ` : `
              <div style="overflow-x: auto">
                <table class="tbl" style="width: 100%">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Holiday</th>
                      <th>Region</th>
                      <th class="num">Regional default ×</th>
                      <th class="num" style="min-width: 110px">This queue ×</th>
                      <th class="num">Delta override</th>
                      <th>AI suggestion</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    ${applicable.map(entry => {
                      const h = entry.holiday;
                      const ov = q.holidayOverrides[h.id] || {};
                      const sug = suggestions[h.id];
                      return `
                        <tr data-hid="${h.id}">
                          <td style="font-family: var(--font-mono); font-size: 12px">${h.date}</td>
                          <td><b>${escapeHTML(h.name)}</b></td>
                          <td class="muted t-small">${entry.region}</td>
                          <td class="num muted" style="font-family: var(--font-mono); font-size: 12px">${h.impactMult != null ? h.impactMult.toFixed(2) : '—'}</td>
                          <td class="num">
                            <input class="hi-mult inline-edit" data-hid="${h.id}" value="${ov.impactMult != null ? ov.impactMult : ''}" placeholder="default" style="text-align: right; width: 80px; font-family: var(--font-mono)">
                          </td>
                          <td class="num">
                            <input class="hi-delta inline-edit muted" data-hid="${h.id}" value="${ov.impactDelta != null ? ov.impactDelta : ''}" placeholder="0" style="text-align: right; width: 70px; font-family: var(--font-mono)">
                          </td>
                          <td>
                            ${sug ? `
                              <div style="display: flex; align-items: center; gap: 6px">
                                <span style="font-family: var(--font-mono); font-size: 12px; color: var(--accent)"><b>× ${sug.impliedMult.toFixed(2)}</b></span>
                                <span class="muted t-small">(${sug.occurrences} occurr${sug.occurrences===1?'ence':'ences'})</span>
                                <button class="btn ghost t-small hi-apply" data-hid="${h.id}" data-val="${sug.impliedMult.toFixed(2)}" style="padding: 2px 8px; font-size: 11px">Apply</button>
                              </div>
                            ` : `<span class="muted t-small">No history</span>`}
                          </td>
                          <td class="num">
                            ${(ov.impactMult != null || ov.impactDelta != null) ? `<button class="btn ghost t-small hi-reset" data-hid="${h.id}" title="Reset to regional default" style="padding: 2px 8px; font-size: 11px">Reset</button>` : ''}
                          </td>
                        </tr>
                      `;
                    }).join('')}
                  </tbody>
                </table>
              </div>
            `}
          </div>
          <div class="modal-foot">
            <div style="flex: 1; font-size: 12px; color: var(--fg-2)">
              <b>Tip:</b> The engine uses your override × first; otherwise the regional default. The AI suggestion is computed from this queue's own actuals.
            </div>
            <button class="btn primary" id="hiDone">Done</button>
          </div>
        </div>
      `;
      document.body.appendChild(dialog);
      const close = () => dialog.remove();
      dialog.querySelector('#hiClose').addEventListener('click', close);
      dialog.querySelector('#hiDone').addEventListener('click', () => { close(); render(); });
      dialog.addEventListener('click', e => { if (e.target === dialog) close(); });

      // Inline edit handlers
      const commitField = (input, field) => {
        const hid = input.dataset.hid;
        const raw = input.value.trim();
        q.holidayOverrides[hid] = q.holidayOverrides[hid] || {};
        if (raw === '') {
          delete q.holidayOverrides[hid][field];
        } else if (isFinite(+raw)) {
          q.holidayOverrides[hid][field] = +raw;
        } else {
          UI.toast('Must be a number', 'warn');
          return;
        }
        // Clean up empty override objects
        if (Object.keys(q.holidayOverrides[hid]).length === 0) delete q.holidayOverrides[hid];
        WFM.State.set({ studio: s });
      };
      dialog.querySelectorAll('.hi-mult').forEach(inp => {
        inp.addEventListener('blur', () => commitField(inp, 'impactMult'));
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); });
      });
      dialog.querySelectorAll('.hi-delta').forEach(inp => {
        inp.addEventListener('blur', () => commitField(inp, 'impactDelta'));
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); });
      });

      // Apply AI suggestion
      dialog.querySelectorAll('.hi-apply').forEach(btn => {
        btn.addEventListener('click', () => {
          const hid = btn.dataset.hid;
          const val = +btn.dataset.val;
          const row = dialog.querySelector(`tr[data-hid="${hid}"]`);
          const inp = row.querySelector('.hi-mult');
          inp.value = val;
          commitField(inp, 'impactMult');
          UI.toast(`Applied × ${val.toFixed(2)} (from this queue's history)`, 'ok');
          openHolidayImpactsDialog(q);
          close();
        });
      });

      // Reset to default
      dialog.querySelectorAll('.hi-reset').forEach(btn => {
        btn.addEventListener('click', () => {
          delete q.holidayOverrides[btn.dataset.hid];
          WFM.State.set({ studio: s });
          openHolidayImpactsDialog(q);
          close();
        });
      });
    }

    function openTestDataDialog(q) {
      if (!WFM.RBAC.requireOrToast('data.edit_actuals')) return;
      const s = WFM.State.get().studio;
      q._gen = q._gen || { kind: 'stable', base: 500, growthPct: 5, seasonAmp: 30, seasonPeriod: 4, spikePeriod: 4, spikeMag: 80, noise: 'low' };
      const g = q._gen;
      let targetChannel = q.channels[0];

      const dialog = document.createElement('div');
      dialog.className = 'modal-scrim';
      document.body.appendChild(dialog);
      renderDialog();

      function renderDialog() {
        g.periods = s.periods;
        dialog.innerHTML = `
          <div class="modal" style="max-width: 760px">
            <div class="modal-head">
              <div>
                <h3>🧪 Generate test data</h3>
                <div class="muted t-small" style="margin-top: 2px">Synthetic historical actuals for testing — not the production forecast</div>
              </div>
              <button class="icon-btn" id="tdClose">${WFM.Icons.close}</button>
            </div>

            <div style="padding: 12px 18px; background: var(--warn-bg); border-bottom: 1px solid var(--border-soft); font-size: 12.5px; color: var(--fg-1)">
              <b>⚠ This is NOT how you create real forecasts.</b> It replaces ${channelLabel(targetChannel)} historical actuals with synthetic data so you can verify the forecasting engine behaves correctly on known patterns. To create a real forecast, use the <b>Forecast Creator</b> tab once you have actual data loaded.
            </div>

            <div class="modal-body">
              <div class="grid cols-2" style="grid-template-columns: 1fr 1fr; gap: var(--space-4)">
                <div class="stack">
                  ${q.channels.length > 1 ? `
                    <div class="field">
                      <label>Apply to which channel</label>
                      <select class="select" id="tdChannel">
                        ${q.channels.map(ch => `<option value="${ch}" ${ch === targetChannel ? 'selected' : ''}>${channelLabel(ch)}</option>`).join('')}
                      </select>
                      <div class="muted t-small" style="margin-top:4px">Only this channel's data will be overwritten.</div>
                    </div>
                  ` : ''}

                  <div class="field">
                    <label>Pattern type — what shape should the data have?</label>
                    <select class="select" id="tdKind">
                      <option value="stable"      ${g.kind === 'stable'      ? 'selected' : ''}>Stable volume</option>
                      <option value="up"          ${g.kind === 'up'          ? 'selected' : ''}>Increasing trend</option>
                      <option value="down"        ${g.kind === 'down'        ? 'selected' : ''}>Decreasing trend</option>
                      <option value="seasonal"    ${g.kind === 'seasonal'    ? 'selected' : ''}>Seasonal cycle</option>
                      <option value="trendSeason" ${g.kind === 'trendSeason' ? 'selected' : ''}>Trend + seasonal</option>
                      <option value="spiky"       ${g.kind === 'spiky'       ? 'selected' : ''}>Periodic spikes</option>
                      <option value="intermittent"${g.kind === 'intermittent'? 'selected' : ''}>Intermittent / sparse</option>
                    </select>
                    <div class="muted t-small" style="margin-top:4px">${patternHelp(g.kind)}</div>
                  </div>

                  <div class="field">
                    <label>Base volume: <b>${g.base}</b> contacts per week</label>
                    <input class="slider" type="range" id="tdBase" min="50" max="5000" step="50" value="${g.base}">
                    <div class="muted t-small" style="margin-top:4px">The average level the pattern fluctuates around.</div>
                  </div>

                  ${(g.kind === 'up' || g.kind === 'down' || g.kind === 'trendSeason') ? `
                    <div class="field">
                      <label>Weekly growth: <b>${g.kind === 'down' ? '−' : '+'}${g.growthPct.toFixed(1)}%</b></label>
                      <input class="slider" type="range" id="tdGrow" min="1" max="20" step="0.5" value="${g.growthPct}">
                      <div class="muted t-small" style="margin-top:4px">How fast volume grows or shrinks each week.</div>
                    </div>
                  ` : ''}

                  ${(g.kind === 'seasonal' || g.kind === 'trendSeason') ? `
                    <div class="field">
                      <label>Season size: <b>±${g.seasonAmp}%</b></label>
                      <input class="slider" type="range" id="tdAmp" min="10" max="80" step="5" value="${g.seasonAmp}">
                      <div class="muted t-small" style="margin-top:4px">How big the up/down swings are within each cycle.</div>
                    </div>
                    <div class="field">
                      <label>Season length: every <b>${g.seasonPeriod}</b> weeks</label>
                      <input class="slider" type="range" id="tdPer" min="2" max="13" step="1" value="${g.seasonPeriod}">
                      <div class="muted t-small" style="margin-top:4px">How long one full up-and-down cycle takes.</div>
                    </div>
                  ` : ''}

                  ${g.kind === 'spiky' ? `
                    <div class="field">
                      <label>Spike interval: every <b>${g.spikePeriod}</b> weeks</label>
                      <input class="slider" type="range" id="tdSpikeP" min="2" max="13" step="1" value="${g.spikePeriod}">
                    </div>
                    <div class="field">
                      <label>Spike size: <b>+${g.spikeMag}%</b></label>
                      <input class="slider" type="range" id="tdSpikeM" min="20" max="300" step="10" value="${g.spikeMag}">
                    </div>
                  ` : ''}

                  <div class="field">
                    <label>How noisy should the data be?</label>
                    <div class="btn-group" id="tdNoise">
                      ${['none','low','medium','high'].map(n => `<button class="btn ${g.noise === n ? 'active' : ''}" data-n="${n}">${n}</button>`).join('')}
                    </div>
                    <div class="muted t-small" style="margin-top:6px">${noiseHelp(g.noise)}</div>
                  </div>
                </div>

                <div class="card" style="background: var(--bg-1); position: sticky; top: 0; align-self: flex-start">
                  <div class="card-head"><div><h3>Preview</h3><div class="sub">${s.periods} weeks · what your data will look like</div></div></div>
                  <div class="card-body">
                    <div id="tdPreview" class="chart" style="height: 200px"></div>
                    <div class="row" id="tdStats" style="gap: 16px; margin-top: 12px; font-size: 12px; color: var(--fg-2); flex-wrap: wrap"></div>
                  </div>
                </div>
              </div>
            </div>

            <div class="modal-foot">
              <button class="btn ghost" id="tdReroll" title="Same pattern, different noise">${WFM.Icons.refresh} Re-roll noise</button>
              <span style="flex:1"></span>
              <button class="btn ghost" id="tdCancel">Cancel</button>
              <button class="btn primary" id="tdApply">Generate & apply to ${channelLabel(targetChannel)}</button>
            </div>
          </div>
        `;

        // Wire inputs
        const wireSlider = (id, fn) => dialog.querySelector('#' + id)?.addEventListener('input', e => { fn(+e.target.value); refreshPreview(true); });
        wireSlider('tdBase',   v => g.base = v);
        wireSlider('tdGrow',   v => g.growthPct = v);
        wireSlider('tdAmp',    v => g.seasonAmp = v);
        wireSlider('tdPer',    v => g.seasonPeriod = v);
        wireSlider('tdSpikeP', v => g.spikePeriod = v);
        wireSlider('tdSpikeM', v => g.spikeMag = v);

        dialog.querySelector('#tdKind').addEventListener('change', e => { g.kind = e.target.value; renderDialog(); });
        dialog.querySelector('#tdChannel')?.addEventListener('change', e => { targetChannel = e.target.value; renderDialog(); });
        dialog.querySelectorAll('#tdNoise .btn').forEach(b => b.addEventListener('click', () => {
          g.noise = b.dataset.n;
          renderDialog();
        }));
        dialog.querySelector('#tdReroll').addEventListener('click', () => refreshPreview(true));
        dialog.querySelector('#tdClose').addEventListener('click', close);
        dialog.querySelector('#tdCancel').addEventListener('click', close);
        dialog.addEventListener('click', e => { if (e.target === dialog) close(); });
        dialog.querySelector('#tdApply').addEventListener('click', () => {
          const generated = generatePattern(g);
          q.channelData[targetChannel] = generated;
          ensureLength(q, s.periods);
          WFM.State.set({ studio: s });
          UI.toast(`Generated ${g.kind} test data for ${channelLabel(targetChannel)}`, 'ok');
          close();
          render();
        });

        refreshPreview(false);
      }

      function refreshPreview(updateLabels) {
        if (updateLabels) {
          // Re-render slider labels without rebuilding the whole dialog
          const labels = {
            tdBase:   `Base volume: <b>${g.base}</b> contacts per week`,
            tdGrow:   `Weekly growth: <b>${g.kind === 'down' ? '−' : '+'}${g.growthPct.toFixed(1)}%</b>`,
            tdAmp:    `Season size: <b>±${g.seasonAmp}%</b>`,
            tdPer:    `Season length: every <b>${g.seasonPeriod}</b> weeks`,
            tdSpikeP: `Spike interval: every <b>${g.spikePeriod}</b> weeks`,
            tdSpikeM: `Spike size: <b>+${g.spikeMag}%</b>`
          };
          Object.entries(labels).forEach(([id, html]) => {
            const lab = dialog.querySelector('#' + id)?.previousElementSibling;
            if (lab) lab.innerHTML = html;
          });
        }
        const data = generatePattern(g);
        const chart = WFM.Charts.line({
          series: [{ name: 'Preview', data, color: 'var(--accent)', showDots: false }],
          categories: data.map((_, i) => i % 4 === 0 ? `W${i+1}` : ''),
          height: 200
        });
        UI.html(dialog.querySelector('#tdPreview'), chart);
        const st = stats(data);
        UI.html(dialog.querySelector('#tdStats'),
          `<span>Mean: <b>${Math.round(st.mean)}</b></span>` +
          `<span>Min: <b>${Math.round(st.min)}</b></span>` +
          `<span>Max: <b>${Math.round(st.max)}</b></span>` +
          `<span>Noise: <b>${st.cv.toFixed(2)}</b></span>`
        );
      }

      function close() { dialog.remove(); }
    }

    function openCreateQueueDialog() {
      const s = WFM.State.get().studio;
      const allRegions = WFM.Regions ? WFM.Regions.list() : [];
      const allProducts = WFM.Products ? WFM.Products.list() : [];
      const dialog = document.createElement('div');
      dialog.className = 'modal-scrim';
      dialog.innerHTML = `
        <div class="modal" style="max-width: 560px">
          <div class="modal-head">
            <h3>Create a new queue</h3>
            <button class="icon-btn" id="cqCancel">${WFM.Icons.close}</button>
          </div>
          <div class="modal-body stack">
            <div class="field">
              <label>Queue name</label>
              <input class="input" id="cqName" placeholder="e.g. Billing Inquiries, Premium Support, Order Status" autocomplete="off">
            </div>
            ${allProducts.length > 0 ? `
              <div class="field">
                <label>Product <span class="muted t-small">— optional, used to group related queues for rollup forecasts</span></label>
                <select class="select" id="cqProduct">
                  <option value="">— Unassigned —</option>
                  ${allProducts.map(p => `<option value="${p.id}">${escapeHTML(p.name)}</option>`).join('')}
                </select>
              </div>
            ` : `
              <div class="field">
                <div class="muted t-small" style="padding: 8px 12px; background: var(--bg-1); border-radius: var(--r-2)">
                  <b>Tip:</b> Create <b>Products</b> in the sidebar to group related queues (e.g. "Server Hardware" with Dell/HP/IBM sub-queues). You can assign queues to products later.
                </div>
              </div>
            `}
            <div class="field">
              <label>Channels <span class="muted t-small">— select one or more · each gets its own forecast</span></label>
              <div class="grid cols-2" style="gap: 8px" id="cqChannels">
                ${CHANNELS.map(c => `
                  <label class="channel-pick" data-ch="${c.id}">
                    <input type="checkbox" class="cq-ch-cb" data-ch="${c.id}" ${c.id === 'voice' ? 'checked' : ''}>
                    <span class="badge ${channelBadge(c.id)}"><span class="dot"></span>${c.label}</span>
                    <span class="muted t-small" style="margin-top:4px">${channelHelp(c.id)}</span>
                  </label>
                `).join('')}
              </div>
            </div>
            ${allRegions.length ? `
              <div class="field">
                <label>Regions <span class="muted t-small">— used for holiday-aware forecasting</span></label>
                <div class="grid cols-2" style="gap: 6px" id="cqRegions">
                  ${allRegions.map(r => `
                    <label class="region-pick">
                      <input type="checkbox" class="cq-rg-cb" data-rg="${r.id}">
                      <span style="font-size:13px;color:var(--fg-0)">${escapeHTML(r.label)}</span>
                      <span class="muted t-small">${r.holidays.length} holidays</span>
                    </label>
                  `).join('')}
                </div>
                <div class="muted t-small" style="margin-top:6px">Holidays in selected regions will be auto-detected in historical data and applied to forecasts.</div>
              </div>
            ` : ''}
          </div>
          <div class="modal-foot">
            <button class="btn ghost" id="cqCancel2">Cancel</button>
            <button class="btn primary" id="cqCreate" disabled>Create queue</button>
          </div>
        </div>
      `;
      document.body.appendChild(dialog);

      let name = '';
      const refresh = () => {
        const channels = Array.from(dialog.querySelectorAll('.cq-ch-cb:checked')).map(cb => cb.dataset.ch);
        dialog.querySelector('#cqCreate').disabled = !name.trim() || channels.length === 0;
        // Visual state on parent labels
        dialog.querySelectorAll('.channel-pick').forEach(lbl => {
          const cb = lbl.querySelector('.cq-ch-cb');
          lbl.classList.toggle('selected', cb.checked);
        });
        dialog.querySelectorAll('.region-pick').forEach(lbl => {
          const cb = lbl.querySelector('.cq-rg-cb');
          lbl.classList.toggle('selected', cb.checked);
        });
      };
      refresh();

      dialog.querySelector('#cqName').addEventListener('input', e => { name = e.target.value; refresh(); });
      dialog.querySelectorAll('.cq-ch-cb').forEach(cb => cb.addEventListener('change', refresh));
      dialog.querySelectorAll('.cq-rg-cb').forEach(cb => cb.addEventListener('change', refresh));

      // Click label area (not the checkbox) toggles the checkbox
      dialog.querySelectorAll('.channel-pick, .region-pick').forEach(lbl => {
        lbl.addEventListener('click', e => {
          if (e.target.tagName === 'INPUT') return;
          const cb = lbl.querySelector('input[type=checkbox]');
          cb.checked = !cb.checked;
          refresh();
        });
      });

      dialog.querySelector('#cqCancel').addEventListener('click', close);
      dialog.querySelector('#cqCancel2').addEventListener('click', close);
      dialog.addEventListener('click', e => { if (e.target === dialog) close(); });
      dialog.querySelector('#cqCreate').addEventListener('click', () => {
        const channels = Array.from(dialog.querySelectorAll('.cq-ch-cb:checked')).map(cb => cb.dataset.ch);
        const regions  = Array.from(dialog.querySelectorAll('.cq-rg-cb:checked')).map(cb => cb.dataset.rg);
        const productId = dialog.querySelector('#cqProduct')?.value || null;
        if (!channels.length) return;
        const newQ = makeQueue('Q' + (s.queues.length + 1), name.trim(), channels, regions, null);
        newQ.productId = productId || null;
        ensureLength(newQ, s.periods);
        s.queues.push(newQ);
        s.activeQueueId = newQ.id;
        WFM.State.set({ studio: s });
        UI.toast(`Created "${newQ.name}" with ${channels.length} channel${channels.length>1?'s':''}`, 'ok');
        close();
        render();
      });
      setTimeout(() => dialog.querySelector('#cqName').focus(), 30);
      function close() { dialog.remove(); }
    }

    function deleteQueue(id) {
      if (!WFM.RBAC.requireOrToast('queue.delete')) return;
      const s = WFM.State.get().studio;
      s.queues = s.queues.filter(q => q.id !== id);
      if (s.activeQueueId === id) s.activeQueueId = s.queues[0]?.id || null;
      WFM.State.set({ studio: s });
      render();
    }

    function bulkSeed(n) {
      const s = WFM.State.get().studio;
      const startIdx = s.queues.length + 1;
      const patterns = ['stable', 'up', 'down', 'seasonal', 'trendSeason', 'spiky'];
      const channelIds = CHANNELS.map(c => c.id);
      for (let i = 0; i < n; i++) {
        const kind = patterns[i % patterns.length];
        const channel = channelIds[i % channelIds.length];
        const gen = {
          kind, base: 200 + Math.floor(Math.random() * 800),
          growthPct: 2 + Math.random() * 8,
          seasonAmp: 20 + Math.random() * 40, seasonPeriod: 4,
          spikePeriod: 4, spikeMag: 50 + Math.random() * 150,
          noise: ['low','medium','high'][i % 3],
          periods: s.periods
        };
        const q = makeQueue(`Q${startIdx + i}`, `Test Queue ${startIdx + i} · ${kind}`, [channel], [], { [channel]: generatePattern(gen) });
        q._gen = gen;
        s.queues.push(q);
      }
      if (!s.activeQueueId) s.activeQueueId = s.queues[0].id;
      WFM.State.set({ studio: s });
      UI.toast(`Added ${n} test queues`, 'ok');
      render();
    }

    function resetAll() {
      if (!WFM.RBAC.requireOrToast('queue.delete')) return;
      if (!confirm('Reset Data Studio? This clears all queues and forecast results.')) return;
      WFM.State.set({ studio: initialState() });
      render();
    }

    /* ====================================================
     * Permission visual gating
     * Buttons with data-perm get .disabled style + cancel-click handler
     * when current user lacks the permission.
     * ==================================================== */
    function applyPermGates(scope) {
      const root = scope || document;
      root.querySelectorAll('[data-perm]').forEach(el => {
        const perm = el.dataset.perm;
        const allowed = WFM.RBAC.can(perm);
        el.classList.toggle('rbac-disabled', !allowed);
        if (!allowed) {
          el.title = `Your role cannot do this (${WFM.RBAC.PERMISSIONS[perm] || perm})`;
        }
      });
    }

    /* ====================================================
     * Data Sources dialog
     * ==================================================== */
    function openSourcesDialog() {
      const dialog = document.createElement('div');
      dialog.className = 'modal-scrim';
      dialog.innerHTML = `
        <div class="modal" style="max-width: 760px">
          <div class="modal-head">
            <h3>Get Data</h3>
            <button class="icon-btn" id="dsCancel">${WFM.Icons.close}</button>
          </div>
          <div class="modal-body" id="dsBody"></div>
        </div>
      `;
      document.body.appendChild(dialog);
      dialog.querySelector('#dsCancel').addEventListener('click', close);
      dialog.addEventListener('click', e => { if (e.target === dialog) close(); });

      let step = 'pick';                        // pick → configure → map → review
      let activeKind = null;
      let activeSource = null;
      let fetched = null;
      let mapping = { date: null, queue: null, volume: null, channel: null };

      renderStep();

      function renderStep() {
        const body = dialog.querySelector('#dsBody');
        if (step === 'pick')      body.innerHTML = pickHTML();
        else if (step === 'configure') body.innerHTML = configureHTML();
        else if (step === 'map')  body.innerHTML = mapHTML();
        else if (step === 'review') body.innerHTML = reviewHTML();
        wireStep(body);
      }

      function pickHTML() {
        const saved = WFM.DataSources.list();
        return `
          <p class="muted" style="margin: 0 0 var(--space-3)">Choose where your data comes from. After connecting, you map columns to canonical fields (date / queue / volume / channel).</p>
          <div class="grid cols-2" style="gap: 12px">
            ${Object.entries(WFM.DataSources.KINDS).map(([k, m]) => `
              <button class="source-pick" data-kind="${k}">
                <b>${m.label}</b>
                <span class="muted t-small" style="margin-top:4px">${m.description}</span>
              </button>
            `).join('')}
          </div>
          ${saved.length ? `
            <div style="margin-top: var(--space-4)">
              <div class="t-micro" style="margin-bottom: 8px">Saved sources</div>
              <div class="stack" style="gap: 6px">
                ${saved.map(s => `
                  <div class="saved-source" data-id="${s.id}">
                    <div style="flex:1">
                      <b>${escapeHTML(s.name)}</b>
                      <div class="muted t-small">${WFM.DataSources.KINDS[s.kind]?.label || s.kind} · last used ${s.updatedAt ? s.updatedAt.slice(0,10) : 'never'}</div>
                    </div>
                    <button class="btn ghost" data-action="run" data-id="${s.id}">${WFM.Icons.refresh} Re-run</button>
                    <button class="icon-btn" data-action="del" data-id="${s.id}" title="Delete">${WFM.Icons.close}</button>
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}
        `;
      }

      function configureHTML() {
        const k = activeKind;
        const meta = WFM.DataSources.KINDS[k];
        if (k === 'csv_upload') {
          return `
            <h4 style="margin: 0 0 8px">${meta.label}</h4>
            <p class="muted t-small">${meta.description}</p>
            <div class="field" style="margin-top: var(--space-3)">
              <label>Source name</label>
              <input class="input" id="srcName" placeholder="e.g. Weekly Volumes — Q3" value="${activeSource?.name || ''}">
            </div>
            <div class="card" id="dropzone" style="background: var(--bg-1); margin-top: var(--space-3)">
              <div class="card-body" style="padding: 36px; text-align: center">
                <div style="font-size: 28px; color: var(--fg-3); margin-bottom: 12px">${WFM.Icons.upload}</div>
                <button class="btn primary" id="dsPick">${WFM.Icons.upload} Choose file</button>
                <input type="file" id="dsFile" accept=".csv,.tsv,.txt" style="display:none">
                <div class="muted t-small" style="margin-top: 8px">or drop CSV / TSV here</div>
              </div>
            </div>
            <div class="modal-foot">
              <button class="btn ghost" id="dsBack">${WFM.Icons.arrow_left} Back</button>
            </div>
          `;
        }
        if (k === 'excel_paste') {
          return `
            <h4 style="margin: 0 0 8px">${meta.label}</h4>
            <p class="muted t-small">${meta.description}</p>
            <div class="field" style="margin-top: var(--space-3)">
              <label>Source name</label>
              <input class="input" id="srcName" placeholder="e.g. Weekly Voice Volumes — pasted">
            </div>
            <div class="field">
              <label>Paste your range here</label>
              <textarea class="input" id="srcPayload" rows="10" placeholder="Date\\tQueue\\tVolume&#10;2026-01-01\\tBilling\\t450&#10;..." style="font-family: var(--font-mono); font-size: 12px"></textarea>
              <div class="muted t-small" style="margin-top: 4px">Select cells in Excel / Sheets including the header row, copy (Ctrl+C), and paste here.</div>
            </div>
            <div class="modal-foot">
              <button class="btn ghost" id="dsBack">${WFM.Icons.arrow_left} Back</button>
              <button class="btn primary" id="dsParse">Parse data ${WFM.Icons.arrow_right}</button>
            </div>
          `;
        }
        if (k === 'sql_paste') {
          return `
            <h4 style="margin: 0 0 8px">${meta.label}</h4>
            <p class="muted t-small">${meta.description}</p>
            <div class="field" style="margin-top: var(--space-3)">
              <label>Source name</label>
              <input class="input" id="srcName" placeholder="e.g. Snowflake — calls by skill last 13 weeks">
            </div>
            <div class="field">
              <label>Reference SQL (optional — for your records)</label>
              <textarea class="input" id="srcSQL" rows="4" placeholder="SELECT call_date, skill, COUNT(*) AS n_calls FROM calls WHERE call_date >= CURRENT_DATE - 91 GROUP BY 1, 2 ORDER BY 1, 2;" style="font-family: var(--font-mono); font-size: 12px"></textarea>
            </div>
            <div class="field">
              <label>Paste query results (tab or comma separated, include header row)</label>
              <textarea class="input" id="srcPayload" rows="8" style="font-family: var(--font-mono); font-size: 12px"></textarea>
              <div class="muted t-small" style="margin-top: 4px">Most DB tools (SSMS, pgAdmin, DBeaver, Snowsight) export to clipboard with the "Copy with Headers" option. Paste here.</div>
            </div>
            <div class="modal-foot">
              <button class="btn ghost" id="dsBack">${WFM.Icons.arrow_left} Back</button>
              <button class="btn primary" id="dsParse">Parse data ${WFM.Icons.arrow_right}</button>
            </div>
          `;
        }
        if (k === 'json_api') {
          return `
            <h4 style="margin: 0 0 8px">${meta.label}</h4>
            <p class="muted t-small">${meta.description}</p>
            <div class="field" style="margin-top: var(--space-3)">
              <label>Source name</label>
              <input class="input" id="srcName" placeholder="e.g. Reporting API — daily volumes">
            </div>
            <div class="field">
              <label>URL</label>
              <input class="input" id="srcURL" placeholder="https://api.example.com/v1/volumes?from=2026-01-01">
            </div>
            <div class="field">
              <label>JSON path to row array (optional)</label>
              <input class="input" id="srcJSONPath" placeholder="e.g. data.rows  (leave blank if root is already an array)">
            </div>
            <div class="modal-foot">
              <button class="btn ghost" id="dsBack">${WFM.Icons.arrow_left} Back</button>
              <button class="btn primary" id="dsParse">Fetch ${WFM.Icons.arrow_right}</button>
            </div>
          `;
        }
        return '';
      }

      function mapHTML() {
        const headers = fetched.rawHeaders || [];
        const sample = fetched.rawSample || [];
        // Auto-suggest mapping from detected schema if present
        const auto = autoSuggestMapping(fetched);
        Object.keys(auto).forEach(k => { if (mapping[k] == null) mapping[k] = auto[k]; });

        return `
          <h4 style="margin: 0 0 8px">Map columns to canonical fields</h4>
          <p class="muted t-small">Tell us which column holds the date, queue, volume, and (optionally) channel. We've pre-filled what we could detect.</p>

          ${fetched.confidence ? `<div style="margin: var(--space-3) 0; padding: 10px 12px; background: var(--accent-bg); border-radius: var(--r-2); font-size: 12.5px"><b>Ingestion confidence:</b> ${fetched.confidence} · ${fetched.rows.length} rows parsed</div>` : ''}

          <div class="grid cols-2" style="gap: 16px">
            ${WFM.DataSources.CANONICAL_FIELDS.map(f => `
              <div class="field">
                <label>${f.label}${f.required ? ' <span style="color: var(--danger)">*</span>' : ''}</label>
                <select class="select" data-field="${f.key}">
                  <option value="">${f.required ? '(required)' : '— use default —'}</option>
                  ${headers.map(h => `<option value="${escapeHTML(h)}" ${mapping[f.key] === h ? 'selected' : ''}>${escapeHTML(h)}</option>`).join('')}
                </select>
                <div class="muted t-small" style="margin-top: 4px">${f.description}</div>
              </div>
            `).join('')}
          </div>

          ${headers.length ? `
            <div style="margin-top: var(--space-4)">
              <div class="t-micro" style="margin-bottom: 6px">Source preview (first 5 rows)</div>
              <div style="overflow-x: auto; border: 1px solid var(--border-soft); border-radius: var(--r-2)">
                <table class="tbl" style="margin: 0">
                  <thead><tr>${headers.map(h => `<th>${escapeHTML(h)}</th>`).join('')}</tr></thead>
                  <tbody>${sample.map(r => `<tr>${headers.map(h => `<td>${escapeHTML(r[h] || '')}</td>`).join('')}</tr>`).join('')}</tbody>
                </table>
              </div>
            </div>
          ` : ''}

          <div class="modal-foot">
            <button class="btn ghost" id="dsBack">${WFM.Icons.arrow_left} Back</button>
            <button class="btn primary" id="dsApply" disabled>Import to queues ${WFM.Icons.arrow_right}</button>
          </div>
        `;
      }

      function autoSuggestMapping(f) {
        const headers = f.rawHeaders || [];
        const lower = headers.map(h => String(h).toLowerCase());
        const out = {};
        // Heuristic: look for likely names
        const find = (rx) => { const i = lower.findIndex(h => rx.test(h)); return i >= 0 ? headers[i] : null; };
        out.date    = find(/^date|^day|^business/);
        out.queue   = find(/^queue|^skill|^line|^service|^lob|^team/);
        out.volume  = find(/^volume$|^vol$|^calls?$|^contacts?$|^count$|^offered/);
        out.channel = find(/^channel|^media/);
        // If incoming rows are already canonical (post-ingest), preselect direct
        if (f.schema && f.schema.format === 'wide') {
          // Wide format gets pre-normalized inside ingest; rows already have date/queue/volume/channel.
          out.date = 'date'; out.queue = 'queue'; out.volume = 'volume'; out.channel = 'channel';
        }
        return out;
      }

      function reviewHTML() {
        const sample = fetched.canonicalRows.slice(0, 5);
        const queues = new Set(fetched.canonicalRows.map(r => r.queue));
        return `
          <h4 style="margin: 0 0 8px">Review and import</h4>
          <div class="grid cols-3" style="gap: 12px; margin: var(--space-3) 0">
            ${WFM.UI.kpiHTML({ label: 'Rows', value: fetched.canonicalRows.length.toLocaleString(), accent: true })}
            ${WFM.UI.kpiHTML({ label: 'Queues', value: queues.size.toString() })}
            ${WFM.UI.kpiHTML({ label: 'Channels', value: new Set(fetched.canonicalRows.map(r => r.channel)).size.toString() })}
          </div>
          <div style="overflow-x: auto; border: 1px solid var(--border-soft); border-radius: var(--r-2)">
            <table class="tbl" style="margin: 0">
              <thead><tr><th>date</th><th>queue</th><th class="num">volume</th><th>channel</th></tr></thead>
              <tbody>${sample.map(r => `<tr><td>${r.date}</td><td>${escapeHTML(r.queue)}</td><td class="num">${r.volume}</td><td>${r.channel}</td></tr>`).join('')}</tbody>
            </table>
          </div>
          <div class="muted t-small" style="margin-top: 8px">Showing first 5 of ${fetched.canonicalRows.length}.</div>
          <div class="modal-foot">
            <button class="btn ghost" id="dsBack">${WFM.Icons.arrow_left} Back</button>
            <button class="btn" id="dsSave">${WFM.Icons.download} Save source</button>
            <button class="btn primary" id="dsImport">Import as queues ${WFM.Icons.arrow_right}</button>
          </div>
        `;
      }

      function wireStep(body) {
        // ==== pick step ====
        body.querySelectorAll('.source-pick').forEach(b => {
          b.addEventListener('click', () => {
            activeKind = b.dataset.kind;
            activeSource = { kind: activeKind, name: '' };
            step = 'configure';
            renderStep();
          });
        });
        body.querySelectorAll('.saved-source [data-action="run"]').forEach(b => {
          b.addEventListener('click', () => {
            const src = WFM.DataSources.get(b.dataset.id);
            activeSource = src;
            activeKind = src.kind;
            runFetch(src);
          });
        });
        body.querySelectorAll('.saved-source [data-action="del"]').forEach(b => {
          b.addEventListener('click', () => {
            if (confirm('Delete this saved source?')) { WFM.DataSources.delete(b.dataset.id); renderStep(); }
          });
        });

        // ==== configure step ====
        const backBtn = body.querySelector('#dsBack');
        if (backBtn) backBtn.addEventListener('click', () => { step = step === 'review' ? 'map' : step === 'map' ? 'configure' : 'pick'; renderStep(); });

        const csvPick = body.querySelector('#dsPick');
        if (csvPick) {
          csvPick.addEventListener('click', () => body.querySelector('#dsFile').click());
          body.querySelector('#dsFile').addEventListener('change', e => {
            const f = e.target.files[0]; if (!f) return;
            const reader = new FileReader();
            reader.onload = ev => {
              activeSource.name = (body.querySelector('#srcName').value || f.name).trim();
              activeSource.payload = ev.target.result;
              runFetch(activeSource);
            };
            reader.readAsText(f);
          });
        }
        const parseBtn = body.querySelector('#dsParse');
        if (parseBtn) {
          parseBtn.addEventListener('click', () => {
            activeSource.name = (body.querySelector('#srcName')?.value || activeKind).trim();
            if (activeKind === 'sql_paste') activeSource.sql = body.querySelector('#srcSQL')?.value || '';
            if (activeKind === 'json_api') {
              activeSource.url = body.querySelector('#srcURL').value.trim();
              activeSource.jsonPath = body.querySelector('#srcJSONPath').value.trim();
            }
            if (activeKind === 'excel_paste' || activeKind === 'sql_paste') {
              activeSource.payload = body.querySelector('#srcPayload').value;
            }
            runFetch(activeSource);
          });
        }

        // ==== map step ====
        body.querySelectorAll('select[data-field]').forEach(sel => {
          sel.addEventListener('change', () => {
            mapping[sel.dataset.field] = sel.value || null;
            // Enable Apply only when required fields filled (date OR mapping is identity)
            const ok = mapping.queue && mapping.volume;
            body.querySelector('#dsApply').disabled = !ok;
          });
        });
        const applyBtn = body.querySelector('#dsApply');
        if (applyBtn) {
          // Initial check
          applyBtn.disabled = !(mapping.queue && mapping.volume);
          applyBtn.addEventListener('click', () => {
            fetched.canonicalRows = WFM.DataSources.normalize(fetched.rows, mapping, { channel: 'voice', queue: 'Unnamed' });
            step = 'review';
            renderStep();
          });
        }

        // ==== review step ====
        const importBtn = body.querySelector('#dsImport');
        if (importBtn) {
          importBtn.addEventListener('click', () => {
            importCanonicalRows(fetched.canonicalRows);
            close();
            UI.toast(`Imported ${fetched.canonicalRows.length} rows`, 'ok');
            render();
          });
        }
        const saveBtn = body.querySelector('#dsSave');
        if (saveBtn) {
          saveBtn.addEventListener('click', () => {
            WFM.DataSources.save(activeSource);
            UI.toast(`Saved source "${activeSource.name}"`, 'ok');
          });
        }
      }

      function runFetch(src) {
        const body = dialog.querySelector('#dsBody');
        body.innerHTML = `<div style="padding: 60px; text-align: center; color: var(--fg-2)">Loading data from source…</div>`;
        WFM.DataSources.fetch(src).then(result => {
          fetched = result;
          step = 'map';
          renderStep();
        }).catch(err => {
          body.innerHTML = `
            <div style="padding: 20px"><div class="empty"><h4 style="color: var(--danger)">Could not load data</h4><p>${escapeHTML(err.message || String(err))}</p></div>
            <div style="text-align:center; margin-top: 16px"><button class="btn" id="dsRetry">${WFM.Icons.arrow_left} Back</button></div></div>
          `;
          body.querySelector('#dsRetry').addEventListener('click', () => { step = 'configure'; renderStep(); });
        });
      }

      function importCanonicalRows(rows) {
        const s = WFM.State.get().studio;
        // Group by (queue, channel)
        const groups = new Map();
        for (const r of rows) {
          const key = `${r.queue}||${r.channel || 'voice'}`;
          if (!groups.has(key)) groups.set(key, { queue: r.queue, channel: r.channel || 'voice', rows: [] });
          groups.get(key).rows.push(r);
        }
        let added = 0;
        for (const [, g] of groups) {
          g.rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
          const weeks = g.rows.map(r => +r.volume);
          // Merge: find queue by name. If exists, add channel data (or replace).
          let existing = s.queues.find(q => q.name === g.queue);
          if (existing) {
            if (!existing.channels.includes(g.channel)) existing.channels.push(g.channel);
            existing.channelData[g.channel] = weeks;
          } else {
            const q = makeQueue('Q' + (s.queues.length + added + 1), g.queue, [g.channel], [], { [g.channel]: weeks });
            s.queues.push(q);
            added++;
          }
        }
        if (s.queues.length && !s.activeQueueId) s.activeQueueId = s.queues[0].id;
        const maxLen = Math.max(0, ...s.queues.flatMap(q => Object.values(q.channelData).map(a => a.length)));
        s.periods = Math.max(s.periods, maxLen);
        // Ensure every queue's every channel array reaches s.periods length
        for (const q of s.queues) ensureLength(q, s.periods);
        WFM.State.set({ studio: s });
      }

      function close() { dialog.remove(); }
    }

    function materializeFromIngest(ingest) {
      const s = WFM.State.get().studio;
      const groups = new Map();
      for (const r of ingest.cleanedData) {
        const key = `${r.queue}||${r.channel}`;
        if (!groups.has(key)) groups.set(key, { queue: r.queue, channel: r.channel, rows: [] });
        groups.get(key).rows.push(r);
      }
      s.queues = [];
      let i = 1;
      for (const [, g] of groups) {
        g.rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
        const weeks = g.rows.map(r => +r.volume);
        s.periods = Math.max(s.periods, weeks.length);
        const q = makeQueue(`Q${i++}`, g.queue, [g.channel], [], { [g.channel]: weeks });
        ensureLength(q, s.periods);
        s.queues.push(q);
      }
      s.activeQueueId = s.queues[0]?.id || null;
      WFM.State.set({ studio: s });
    }
  };

  /* ====================================================
   * Helpers
   * ==================================================== */
  function makeQueue(id, name, channels, regions, channelData) {
    // channels: array of channel IDs (e.g. ['voice', 'chat'])
    // regions:  array of region IDs (e.g. ['AMER', 'EMEA'])
    // channelData: optional {channelId: weeks[]} map; defaults to empty arrays per channel
    channels = (channels && channels.length) ? channels : ['voice'];
    regions  = regions || [];
    const data = {};
    for (const ch of channels) {
      data[ch] = (channelData && channelData[ch]) || new Array(13).fill(0);
    }
    return {
      id: id + '_' + Math.random().toString(36).slice(2, 7),
      name,
      channels: channels.slice(),
      channelData: data,
      regions: regions.slice()
    };
  }

  // Migrate any old-shape queue (channel + weeks) into new shape (channels + channelData)
  function migrateQueue(q) {
    if (!q) return q;
    if (Array.isArray(q.channels) && q.channelData) return q;          // already new shape
    const ch = q.channel || 'voice';
    return {
      id: q.id,
      name: q.name,
      channels: [ch],
      channelData: { [ch]: q.weeks || new Array(13).fill(0) },
      regions: q.regions || []
    };
  }

  function ensureLength(q, n) {
    for (const ch of q.channels) {
      const arr = q.channelData[ch] || [];
      if (arr.length < n) q.channelData[ch] = arr.concat(new Array(n - arr.length).fill(0));
      else if (arr.length > n) q.channelData[ch] = arr.slice(0, n);
    }
  }
  function sum(arr) { return arr.reduce((s,v) => s + (isFinite(v) ? v : 0), 0); }
  function stats(arr) {
    const a = arr.filter(v => isFinite(v));
    if (!a.length) return { mean: 0, min: 0, max: 0, std: 0, cv: 0 };
    const mean = a.reduce((s,v)=>s+v, 0) / a.length;
    const variance = a.reduce((s,v)=>s+(v-mean)*(v-mean), 0) / a.length;
    const std = Math.sqrt(variance);
    return { mean, min: Math.min(...a), max: Math.max(...a), std, cv: mean !== 0 ? std/Math.abs(mean) : 0 };
  }
  function escapeHTML(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function channelBadge(ch) {
    return ({ voice: 'info', chat: 'accent', email: 'ok', web: 'warn' })[ch] || '';
  }
  function channelLabel(ch) {
    return ({ voice: 'Voice', chat: 'Chat', email: 'Email', web: 'Web Case' })[ch] || ch;
  }
  function channelHelp(ch) {
    return ({
      voice: 'Inbound or outbound calls',
      chat:  'Live web chat / messenger',
      email: 'Email or ticket queue',
      web:   'Async web case / form submission'
    })[ch] || '';
  }
  // Channel catalogue — single source of truth for picker labels
  const CHANNELS = [
    { id: 'voice', label: 'Voice (calls)' },
    { id: 'chat',  label: 'Chat' },
    { id: 'email', label: 'Email' },
    { id: 'web',   label: 'Web Case' }
  ];

  // Compute the start-of-week ISO date for week index `i` in a series of `n` weeks.
  // The newest week (i = n-1) is the most recent Monday strictly before today.
  function weekStartDate(n, i) {
    const today = new Date();
    const day = today.getUTCDay() || 7;                            // Sunday→7
    const lastMonday = new Date(today);
    lastMonday.setUTCDate(today.getUTCDate() - (day - 1) - (day === 1 ? 7 : 0));   // strictly before today
    const target = new Date(lastMonday);
    target.setUTCDate(lastMonday.getUTCDate() - (n - 1 - i) * 7);
    return target.toISOString().slice(0, 10);
  }

  function patternHelp(kind) {
    return ({
      stable:       'Same number every week, give or take a little. Like a queue that has been running steady for years.',
      up:           'Volume grows a bit every week. Like a queue that is gaining traction.',
      down:         'Volume shrinks a bit every week. Like a product being phased out.',
      seasonal:     'Cyclic pattern — up some weeks, down others, on a regular rhythm. Like calls peaking every Monday.',
      trendSeason:  'A growing baseline combined with a regular cycle. Common for healthy growing queues.',
      spiky:        'Mostly flat with occasional sharp jumps. Like end-of-month billing peaks.',
      intermittent: 'Some weeks have volume, many weeks are zero. Like a low-volume niche queue.'
    })[kind] || '';
  }

  function noiseHelp(level) {
    return ({
      none:   'Perfectly clean — exactly matches the pattern, no random variation.',
      low:    '±5% week-to-week randomness — looks tidy, easy to forecast.',
      medium: '±15% randomness — realistic for most contact-center data.',
      high:   '±35% randomness — messy, noisy series. Tests how the engine handles real-world chaos.'
    })[level] || '';
  }

  /* ====================================================
   * PATTERN GENERATOR
   * ==================================================== */
  function generatePattern(g) {
    const n = g.periods;
    const out = new Array(n);
    const noiseAmp = ({ none: 0, low: 0.05, medium: 0.15, high: 0.35 })[g.noise] || 0;

    for (let i = 0; i < n; i++) {
      let v = g.base;
      if (g.kind === 'up')   v = g.base * Math.pow(1 + g.growthPct / 100, i);
      else if (g.kind === 'down') v = g.base * Math.pow(1 - g.growthPct / 100, i);
      else if (g.kind === 'seasonal') {
        const phase = (i % g.seasonPeriod) / g.seasonPeriod * Math.PI * 2;
        v = g.base * (1 + (g.seasonAmp / 100) * Math.sin(phase));
      }
      else if (g.kind === 'trendSeason') {
        const trended = g.base * Math.pow(1 + g.growthPct / 100, i);
        const phase = (i % g.seasonPeriod) / g.seasonPeriod * Math.PI * 2;
        v = trended * (1 + (g.seasonAmp / 100) * Math.sin(phase));
      }
      else if (g.kind === 'spiky') {
        v = g.base * (i % g.spikePeriod === g.spikePeriod - 1 ? 1 + g.spikeMag / 100 : 1);
      }
      else if (g.kind === 'intermittent') {
        v = Math.random() < 0.4 ? g.base * (0.5 + Math.random()) : 0;
      }
      if (noiseAmp > 0 && g.kind !== 'intermittent') {
        v = v * (1 + (Math.random() - 0.5) * 2 * noiseAmp);
      }
      out[i] = Math.max(0, Math.round(v));
    }
    return out;
  }

  WFM.Modules = WFM.Modules || {};
  WFM.Modules['data-studio'] = M;
})(window.WFM = window.WFM || {});
