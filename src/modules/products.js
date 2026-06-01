/* =========================================================
 * Module: Products
 *
 * Top-level page for managing products (logical groupings of queues).
 * Two views:
 *   - List: all products with member-queue counts + KPI rollups
 *   - Detail: clicking a product shows its queues, aggregated forecast,
 *     and aggregated capacity needs
 *
 * Products are user-created. A queue's productId field associates it to
 * one product (or null = "Unassigned").
 * ========================================================= */
(function (WFM) {
  'use strict';
  const M = {};

  M.mount = function (root, state) {
    const UI = WFM.UI;
    M._state = M._state || { selectedProductId: null };
    const s = M._state;

    render();

    function render() {
      const canManage = WFM.RBAC ? WFM.RBAC.can('queue.edit') : true;
      const products = WFM.Products ? WFM.Products.list() : [];
      const studio = WFM.State.get().studio || { queues: [] };
      const allQueues = studio.queues || [];

      // Unassigned bucket — queues with no productId
      const unassignedQueues = allQueues.filter(q => !q.productId);

      UI.html(root, `
        <div class="page">
          <div class="page-head">
            <div>
              <h1>Products</h1>
              <div class="sub">Group related queues for rollup forecasts and executive-level capacity planning. A product is a logical bundle — e.g. "Server Hardware" containing the queues Dell / HP / IBM, each with their own channels.</div>
            </div>
            <div class="actions">
              ${canManage ? `<button class="btn primary" id="addProduct">${WFM.Icons.plus} Add product</button>` : ''}
            </div>
          </div>

          ${products.length === 0 && unassignedQueues.length === 0 ? `
            <div class="card" style="margin-top: var(--space-4)">
              <div class="card-body" style="padding: 60px; text-align: center">
                <div style="font-size: 32px; color: var(--fg-3); margin-bottom: var(--space-3)">${WFM.Icons.spark}</div>
                <h3 style="margin: 0 0 8px">No products yet</h3>
                <p class="muted" style="max-width: 480px; margin: 0 auto var(--space-4)">
                  Products group related queues for cross-channel forecasting and executive rollup views.
                  Start by creating a product (e.g. "Server Hardware"), then create queues that belong to it.
                </p>
                ${canManage ? `<button class="btn primary" id="addProduct2">${WFM.Icons.plus} Add your first product</button>` : ''}
              </div>
            </div>
          ` : `
            <div id="productList" style="margin-top: var(--space-4)"></div>
          `}
        </div>
      `);

      UI.$('#addProduct', root)?.addEventListener('click', openAddDialog);
      UI.$('#addProduct2', root)?.addEventListener('click', openAddDialog);

      const list = UI.$('#productList', root);
      if (list) renderList(list, products, allQueues, unassignedQueues, canManage);
    }

    function renderList(root, products, allQueues, unassignedQueues, canManage) {
      root.innerHTML = `
        <div class="grid cols-2" style="grid-template-columns: 1fr; gap: var(--space-3)">
          ${products.map(p => renderProductCard(p, allQueues, canManage)).join('')}
          ${unassignedQueues.length > 0 ? renderUnassignedCard(unassignedQueues) : ''}
        </div>
      `;

      root.querySelectorAll('[data-edit-product]').forEach(b => b.addEventListener('click', e => {
        e.stopPropagation();
        const p = WFM.Products.get(b.dataset.editProduct);
        if (p) openEditDialog(p);
      }));
      root.querySelectorAll('[data-del-product]').forEach(b => b.addEventListener('click', e => {
        e.stopPropagation();
        const p = WFM.Products.get(b.dataset.delProduct);
        if (!p) return;
        const memberCount = allQueues.filter(q => q.productId === p.id).length;
        const msg = memberCount > 0
          ? `Delete "${p.name}"? Its ${memberCount} member queue${memberCount>1?'s':''} will become unassigned (queues and their data are preserved).`
          : `Delete "${p.name}"?`;
        if (!confirm(msg)) return;
        // Unassign member queues first
        const s2 = WFM.State.get().studio;
        if (s2 && s2.queues) {
          s2.queues.forEach(q => { if (q.productId === p.id) q.productId = null; });
          WFM.State.set({ studio: s2 });
        }
        WFM.Products.delete(p.id);
        UI.toast(`Deleted product "${p.name}"`, 'ok');
        render();
      }));
      root.querySelectorAll('[data-open-product]').forEach(el => el.addEventListener('click', e => {
        // Click anywhere on the card except the icon-buttons drills in
        if (e.target.closest('[data-edit-product], [data-del-product]')) return;
        const p = WFM.Products.get(el.dataset.openProduct);
        if (p) openProductDetail(p);
      }));
    }

    function renderProductCard(product, allQueues, canManage) {
      const summary = WFM.Products.summary(product.id, allQueues);
      const members = allQueues.filter(q => q.productId === product.id);
      return `
        <div class="card product-card" data-open-product="${product.id}" style="cursor: pointer">
          <div class="card-head" style="border-left: 4px solid ${product.color || 'var(--accent)'}">
            <div style="flex: 1; min-width: 0">
              <h3 style="margin: 0">${escapeHTML(product.name)}</h3>
              <div class="sub" style="margin-top: 2px">${escapeHTML(product.description || 'No description')}</div>
            </div>
            <div class="actions">
              ${canManage ? `
                <button class="icon-btn" data-edit-product="${product.id}" title="Edit product">${WFM.Icons.settings || '⚙'}</button>
                <button class="icon-btn" data-del-product="${product.id}" title="Delete product">${WFM.Icons.close}</button>
              ` : ''}
            </div>
          </div>
          <div class="card-body">
            <div class="grid cols-4" style="margin-bottom: var(--space-3)">
              ${UI.kpiHTML({ label: 'Queues', value: summary.queueCount.toString(), accent: true })}
              ${UI.kpiHTML({ label: 'Channel series', value: summary.channelCount.toString() })}
              ${UI.kpiHTML({ label: 'Series with data', value: summary.seriesWithData.toString() })}
              ${UI.kpiHTML({ label: 'Avg weekly volume', value: Math.round(summary.avgWeeklyVolume).toLocaleString() })}
            </div>
            ${members.length > 0 ? `
              <div class="t-micro" style="margin-bottom: 6px">Member queues</div>
              <div style="display: flex; flex-wrap: wrap; gap: 6px">
                ${members.slice(0, 12).map(q => `
                  <span class="badge" style="background: var(--bg-3); color: var(--fg-1); font-size: 11px; padding: 4px 8px">
                    ${escapeHTML(q.name)}
                    <span class="muted" style="margin-left: 4px">${q.channels.length}ch</span>
                  </span>
                `).join('')}
                ${members.length > 12 ? `<span class="badge" style="background: var(--bg-3); font-size: 11px">+${members.length - 12} more</span>` : ''}
              </div>
            ` : `
              <div class="muted t-small" style="padding: 16px; background: var(--bg-1); border-radius: var(--r-2); text-align: center">
                No queues assigned yet. Go to <a href="#data-studio" style="color: var(--accent)">Forecast Workbench</a> and assign queues to this product.
              </div>
            `}
          </div>
        </div>
      `;
    }

    function renderUnassignedCard(queues) {
      return `
        <div class="card" style="border-style: dashed">
          <div class="card-head">
            <div>
              <h3 style="margin: 0">Unassigned queues</h3>
              <div class="sub">Queues not linked to any product · assign in the queue editor to enable rollups</div>
            </div>
          </div>
          <div class="card-body">
            <div style="display: flex; flex-wrap: wrap; gap: 6px">
              ${queues.slice(0, 20).map(q => `
                <span class="badge" style="background: var(--bg-3); color: var(--fg-1); font-size: 11px; padding: 4px 8px">
                  ${escapeHTML(q.name)}
                  <span class="muted" style="margin-left: 4px">${q.channels.length}ch</span>
                </span>
              `).join('')}
              ${queues.length > 20 ? `<span class="badge" style="background: var(--bg-3); font-size: 11px">+${queues.length - 20} more</span>` : ''}
            </div>
          </div>
        </div>
      `;
    }

    /* ====================================================
     * Product detail page — drill-in view
     * Shows member queues, aggregated weekly volume, suggests forecasting
     * the whole product as a rollup
     * ==================================================== */
    function openProductDetail(product) {
      const studio = WFM.State.get().studio || { queues: [] };
      const members = (studio.queues || []).filter(q => q.productId === product.id);

      // Aggregate weekly volume across all member queues and channels
      const periods = studio.periods || 26;
      const aggregated = new Array(periods).fill(0);
      let perChannelTotals = { voice: 0, chat: 0, email: 0, web: 0 };
      let totalChannelSeries = 0;
      for (const q of members) {
        for (const ch of q.channels) {
          const arr = q.channelData[ch] || [];
          totalChannelSeries++;
          for (let i = 0; i < Math.min(arr.length, periods); i++) {
            aggregated[i] += arr[i] || 0;
            perChannelTotals[ch] = (perChannelTotals[ch] || 0) + (arr[i] || 0);
          }
        }
      }
      const total = aggregated.reduce((s, v) => s + v, 0);
      const nonZero = aggregated.filter(v => v > 0).length;
      const mean = nonZero > 0 ? total / nonZero : 0;
      const max = Math.max(...aggregated, 0);

      UI.html(root, `
        <div class="page">
          <div class="page-head">
            <div>
              <button class="btn ghost" id="backToList" style="margin-bottom: 8px">${WFM.Icons.arrow_left || '←'} Back to all products</button>
              <h1 style="display: flex; align-items: center; gap: 10px">
                <span style="display: inline-block; width: 12px; height: 12px; border-radius: 3px; background: ${product.color}"></span>
                ${escapeHTML(product.name)}
              </h1>
              <div class="sub">${escapeHTML(product.description || 'No description')}</div>
            </div>
            <div class="actions">
              <button class="btn ghost" id="editFromDetail">${WFM.Icons.settings || '⚙'} Edit product</button>
              <button class="btn primary" id="goForecast">${WFM.Icons.spark} Forecast in Workbench →</button>
            </div>
          </div>

          <div class="grid cols-4" style="margin-top: var(--space-4)">
            ${UI.kpiHTML({ label: 'Member queues', value: members.length.toString(), accent: true })}
            ${UI.kpiHTML({ label: 'Channel series', value: totalChannelSeries.toString() })}
            ${UI.kpiHTML({ label: 'Avg weekly (rollup)', value: Math.round(mean).toLocaleString() })}
            ${UI.kpiHTML({ label: 'Peak week', value: Math.round(max).toLocaleString() })}
          </div>

          ${nonZero > 0 ? `
            <div class="card" style="margin-top: var(--space-4)">
              <div class="card-head">
                <div>
                  <h3>Aggregated weekly volume</h3>
                  <div class="sub">Sum across all member queues and channels · ${nonZero} non-zero weeks</div>
                </div>
              </div>
              <div class="card-body">
                <div class="chart" style="height: 240px">${WFM.Charts.line({
                  series: [{ name: 'Rollup', data: aggregated, color: product.color || 'var(--accent)', showDots: aggregated.length <= 26 }],
                  categories: aggregated.map((_, i) => i % 4 === 0 ? `W${i+1}` : ''),
                  height: 240
                })}</div>
              </div>
            </div>

            <div class="card" style="margin-top: var(--space-3)">
              <div class="card-head"><div><h3>Channel mix</h3><div class="sub">Total volume by channel across all member queues</div></div></div>
              <div class="card-body">
                <div class="grid cols-4">
                  ${Object.entries(perChannelTotals).filter(([_, v]) => v > 0).map(([ch, vol]) => {
                    const pct = total > 0 ? (vol / total * 100).toFixed(1) : '0.0';
                    return UI.kpiHTML({ label: channelLabel(ch), value: Math.round(vol).toLocaleString(), delta: `${pct}% of total`, deltaDir: 'flat' });
                  }).join('')}
                </div>
              </div>
            </div>
          ` : `
            <div class="card" style="margin-top: var(--space-4)">
              <div class="card-body" style="padding: 40px; text-align: center">
                <p class="muted">No volume data in member queues yet.</p>
                <p class="muted t-small" style="margin-top: 8px">Open the Forecast Workbench to enter or upload actuals.</p>
              </div>
            </div>
          `}

          <div class="card" style="margin-top: var(--space-3)">
            <div class="card-head"><div><h3>Member queues</h3><div class="sub">${members.length} queue${members.length!==1?'s':''}</div></div></div>
            <div class="card-body" style="padding: 0">
              ${members.length === 0 ? `
                <div class="empty" style="padding: 40px"><p>No queues in this product.</p><p class="muted t-small" style="margin-top: 8px">In the Forecast Workbench, edit a queue and assign it to "${escapeHTML(product.name)}".</p></div>
              ` : `
                <table class="tbl">
                  <thead><tr><th>Queue</th><th>Channels</th><th>Regions</th><th class="num">Weeks of data</th><th></th></tr></thead>
                  <tbody>
                    ${members.map(q => {
                      const nz = q.channels.reduce((s, ch) => s + (q.channelData[ch] || []).filter(v => v > 0).length, 0);
                      return `
                        <tr>
                          <td><b>${escapeHTML(q.name)}</b></td>
                          <td>${q.channels.map(ch => `<span class="badge ${channelBadge(ch)}" style="font-size:10px"><span class="dot"></span>${channelLabel(ch)}</span>`).join(' ')}</td>
                          <td class="muted t-small">${(q.regions || []).join(', ') || '—'}</td>
                          <td class="num">${nz}</td>
                          <td class="num"><button class="btn ghost t-small" data-open-queue="${q.id}" style="padding: 2px 8px">Open</button></td>
                        </tr>
                      `;
                    }).join('')}
                  </tbody>
                </table>
              `}
            </div>
          </div>
        </div>
      `);

      UI.$('#backToList', root).addEventListener('click', () => { s.selectedProductId = null; render(); });
      UI.$('#editFromDetail', root)?.addEventListener('click', () => openEditDialog(product));
      UI.$('#goForecast', root)?.addEventListener('click', () => { location.hash = '#data-studio'; });
      root.querySelectorAll('[data-open-queue]').forEach(b => b.addEventListener('click', () => {
        const s2 = WFM.State.get().studio;
        s2.activeQueueId = b.dataset.openQueue;
        WFM.State.set({ studio: s2 });
        location.hash = '#data-studio';
      }));
    }

    /* ====================================================
     * Add / Edit dialog
     * ==================================================== */
    function openAddDialog() { openProductDialog(null); }
    function openEditDialog(product) { openProductDialog(product); }

    function openProductDialog(existing) {
      const isEdit = !!existing;
      const allRegions = WFM.Regions ? WFM.Regions.list() : [];
      const initial = existing || { name: '', description: '', color: '#b45309', defaultRegions: [] };

      const dialog = document.createElement('div');
      dialog.className = 'modal-scrim';
      dialog.innerHTML = `
        <div class="modal" style="max-width: 540px">
          <div class="modal-head">
            <h3>${isEdit ? 'Edit product' : 'Add product'}</h3>
            <button class="icon-btn" id="pdClose">${WFM.Icons.close}</button>
          </div>
          <div class="modal-body stack">
            <div class="field">
              <label>Product name</label>
              <input class="input" id="pdName" placeholder="e.g. Server Hardware, Payments, Premium Plans" value="${escapeHTML(initial.name)}" autocomplete="off">
            </div>
            <div class="field">
              <label>Description <span class="muted t-small">— optional</span></label>
              <input class="input" id="pdDesc" placeholder="e.g. All server-related sales and support queues" value="${escapeHTML(initial.description || '')}" autocomplete="off">
            </div>
            <div class="field">
              <label>Color tag</label>
              <div style="display: flex; gap: 8px; flex-wrap: wrap" id="pdColor">
                ${['#b45309', '#0e7490', '#15803d', '#7c3aed', '#be123c', '#1e40af', '#9a3412', '#0f766e'].map(c => `
                  <button type="button" data-color="${c}" class="color-swatch ${c === initial.color ? 'selected' : ''}" style="width: 32px; height: 32px; border-radius: 6px; background: ${c}; border: 2px solid ${c === initial.color ? 'var(--fg-0)' : 'transparent'}; cursor: pointer"></button>
                `).join('')}
              </div>
            </div>
            ${allRegions.length > 0 ? `
              <div class="field">
                <label>Default regions <span class="muted t-small">— new queues in this product can inherit these</span></label>
                <div class="grid cols-2" style="gap: 6px">
                  ${allRegions.map(r => `
                    <label class="region-pick ${(initial.defaultRegions || []).includes(r.id) ? 'selected' : ''}">
                      <input type="checkbox" class="pd-rg-cb" data-rg="${r.id}" ${(initial.defaultRegions || []).includes(r.id) ? 'checked' : ''}>
                      <span>
                        <span style="font-size: 13px; color: var(--fg-0)">${escapeHTML(r.label)}</span>
                        <span class="muted t-small">${r.holidays.length} holidays</span>
                      </span>
                    </label>
                  `).join('')}
                </div>
              </div>
            ` : ''}
          </div>
          <div class="modal-foot">
            <button class="btn ghost" id="pdCancel">Cancel</button>
            <button class="btn primary" id="pdSave">${isEdit ? 'Save changes' : 'Create product'}</button>
          </div>
        </div>
      `;
      document.body.appendChild(dialog);
      const close = () => dialog.remove();

      let selectedColor = initial.color;
      dialog.querySelectorAll('.color-swatch').forEach(b => b.addEventListener('click', () => {
        selectedColor = b.dataset.color;
        dialog.querySelectorAll('.color-swatch').forEach(x => {
          x.style.border = '2px solid ' + (x.dataset.color === selectedColor ? 'var(--fg-0)' : 'transparent');
        });
      }));
      dialog.querySelectorAll('.region-pick').forEach(lbl => {
        lbl.addEventListener('click', e => {
          if (e.target.tagName === 'INPUT') return;
          const cb = lbl.querySelector('input');
          cb.checked = !cb.checked;
          lbl.classList.toggle('selected', cb.checked);
        });
        const cb = lbl.querySelector('input');
        cb.addEventListener('change', () => lbl.classList.toggle('selected', cb.checked));
      });

      dialog.querySelector('#pdClose').addEventListener('click', close);
      dialog.querySelector('#pdCancel').addEventListener('click', close);
      dialog.addEventListener('click', e => { if (e.target === dialog) close(); });
      dialog.querySelector('#pdSave').addEventListener('click', () => {
        const name = dialog.querySelector('#pdName').value.trim();
        const description = dialog.querySelector('#pdDesc').value.trim();
        const defaultRegions = Array.from(dialog.querySelectorAll('.pd-rg-cb:checked')).map(cb => cb.dataset.rg);
        if (!name) { UI.toast('Product name is required', 'warn'); return; }
        if (isEdit) {
          WFM.Products.update(existing.id, { name, description, color: selectedColor, defaultRegions });
          UI.toast(`Product "${name}" updated`, 'ok');
        } else {
          WFM.Products.add({ name, description, color: selectedColor, defaultRegions });
          UI.toast(`Product "${name}" created`, 'ok');
        }
        close();
        render();
      });
      setTimeout(() => dialog.querySelector('#pdName').focus(), 30);
    }
  };

  function escapeHTML(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function channelLabel(ch) {
    return ({ voice: 'Voice', chat: 'Chat', email: 'Email', web: 'Web Case' })[ch] || ch;
  }
  function channelBadge(ch) {
    return ({ voice: 'info', chat: 'accent', email: 'ok', web: 'warn' })[ch] || '';
  }

  WFM.Modules = WFM.Modules || {};
  WFM.Modules.products = M;
})(window.WFM = window.WFM || {});
