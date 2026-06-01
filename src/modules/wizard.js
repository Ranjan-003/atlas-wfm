/* =========================================================
 * Guided Forecasting Wizard
 *
 * The "Jarvis" experience — talks to you, asks questions, validates as
 * you go, and explains its reasoning at every step. Each step has a
 * clear "what we're doing here" header and an "Atlas commentary" sidebar
 * that produces real insights from the user's data (not LLM
 * hallucinations).
 *
 * Architecture:
 *   - Each step is a self-contained render function
 *   - Wizard state is its own object, persisted to localStorage so you
 *     can resume mid-flow if you bail
 *   - Final commit writes to the studio (queues, runs) only at the end
 *
 * Flow (existing queue):
 *   1. Welcome — pick path
 *   2. Pick queue (or create new)
 *   3. Capture actuals — manual / upload / connect (skipped if existing queue has data)
 *   4. Regions & holidays
 *   5. Forecast horizon + locked window
 *   6. Model preview
 *   7. Run forecast
 *   8. Capacity
 *   9. Save & schedule
 * ========================================================= */
(function (WFM) {
  'use strict';
  const M = {};

  const STORAGE_KEY = 'atlas-wizard';

  function loadWizardState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }
  function saveWizardState(s) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch (_) {}
  }
  function clearWizardState() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
  }

  function initialWizardState() {
    return {
      step: 1,
      path: null,                  // 'new' | 'existing'
      queueId: null,               // selected queue (existing path) or to-be-created (new path)
      newQueue: {                  // staging for the new-queue path
        name: '',
        productId: null,
        channels: ['voice'],
        regions: []
      },
      dataEntryMode: null,         // 'manual' | 'upload' | 'connect'
      manualEntered: false,        // user did some data entry this session
      horizon: 26,
      lockedWeeks: 13,
      forceModel: null,            // null = auto
      lastRunResults: null,        // populated by step 7
      runName: '',                 // for step 9
      startedAt: new Date().toISOString()
    };
  }

  M.mount = function (root, state) {
    const UI = WFM.UI;

    // Hydrate wizard state — resume if there was one in progress
    if (!M._state) {
      const persisted = loadWizardState();
      M._state = persisted || initialWizardState();
    }

    render();

    function render() {
      const w = M._state;
      UI.html(root, `
        <div class="page wizard-page">
          <div class="wizard-shell">
            <div class="wizard-main" id="wizardMain"></div>
            <aside class="wizard-aside" id="wizardAside"></aside>
          </div>
        </div>
      `);
      renderMain();
      renderAside();
    }

    function renderMain() {
      const main = UI.$('#wizardMain', root);
      const w = M._state;
      // Build the header (progress dots + skip)
      main.innerHTML = `
        <div class="wizard-head">
          <div class="wizard-progress">
            ${stepsList().map((s, i) => `
              <div class="wizard-dot ${w.step === i+1 ? 'active' : ''} ${w.step > i+1 ? 'done' : ''}" data-step="${i+1}">
                <span class="wizard-dot-num">${w.step > i+1 ? '✓' : (i+1)}</span>
                <span class="wizard-dot-label">${s.label}</span>
              </div>
            `).join('')}
          </div>
          <div class="wizard-head-actions">
            <button class="btn ghost t-small" id="wizardSkip">Skip wizard — I know what I'm doing</button>
          </div>
        </div>
        <div class="wizard-body" id="wizardBody"></div>
      `;
      // Wire skip
      UI.$('#wizardSkip', main).addEventListener('click', () => {
        if (!confirm('Skip the wizard and go straight to the advanced Forecast Workbench? Your wizard progress will be cleared.')) return;
        clearWizardState();
        M._state = null;
        location.hash = '#data-studio';
      });
      // Allow clicking earlier steps to navigate back
      main.querySelectorAll('.wizard-dot').forEach(dot => {
        const targetStep = +dot.dataset.step;
        if (targetStep < w.step) {
          dot.style.cursor = 'pointer';
          dot.addEventListener('click', () => { w.step = targetStep; persist(); render(); });
        }
      });

      const body = UI.$('#wizardBody', main);
      switch (w.step) {
        case 1: step1(body, w); break;
        case 2: step2(body, w); break;
        case 3: step3(body, w); break;
        case 4: step4(body, w); break;
        case 5: step5(body, w); break;
        case 6: step6(body, w); break;
        case 7: step7(body, w); break;
        case 8: step8(body, w); break;
        case 9: step9(body, w); break;
        default: body.innerHTML = `<div class="empty"><h4>Done!</h4></div>`;
      }
    }

    function renderAside() {
      const aside = UI.$('#wizardAside', root);
      const w = M._state;
      // Atlas commentary — context-aware insights for the current step
      const commentary = getCommentary(w);
      aside.innerHTML = `
        <div class="wizard-copilot-head">
          <div class="wizard-copilot-mark">A</div>
          <div>
            <div class="wizard-copilot-name">Atlas</div>
            <div class="wizard-copilot-state">Guiding step ${w.step} of ${stepsList().length}</div>
          </div>
        </div>
        <div class="wizard-copilot-body">
          ${commentary.map(c => `
            <div class="wizard-insight wizard-insight-${c.kind}">
              <div class="wizard-insight-icon">${c.icon || ''}</div>
              <div class="wizard-insight-body">
                ${c.title ? `<div class="wizard-insight-title">${c.title}</div>` : ''}
                <div class="wizard-insight-text">${c.text}</div>
              </div>
            </div>
          `).join('')}
        </div>
      `;
    }

    function persist() {
      saveWizardState(M._state);
    }

    function gotoStep(n) {
      M._state.step = n;
      persist();
      render();
    }

    /* ====================================================
     * Steps list (for the progress indicator)
     * ==================================================== */
    function stepsList() {
      return [
        { id: 1, label: 'Start' },
        { id: 2, label: 'Queue' },
        { id: 3, label: 'Data' },
        { id: 4, label: 'Holidays' },
        { id: 5, label: 'Horizon' },
        { id: 6, label: 'Model' },
        { id: 7, label: 'Run' },
        { id: 8, label: 'Capacity' },
        { id: 9, label: 'Save' }
      ];
    }

    /* ====================================================
     * STEP 1 — Welcome / pick path
     * ==================================================== */
    function step1(body, w) {
      body.innerHTML = `
        <div class="wizard-step-head">
          <h2>Let's build a forecast together.</h2>
          <p class="wizard-step-sub">I'll walk you through it end-to-end. We'll capture your historical data, apply any holiday effects, pick a forecast horizon, and run the right model for your shape of data. At the end, you'll get a capacity plan too.</p>
        </div>
        <div class="wizard-cards">
          <button class="wizard-card" data-path="existing">
            <div class="wizard-card-icon">📊</div>
            <div class="wizard-card-title">Forecast an existing queue</div>
            <div class="wizard-card-text">You've already created a queue and entered some historical actuals. We'll review the data and forecast from there.</div>
          </button>
          <button class="wizard-card" data-path="new">
            <div class="wizard-card-icon">✨</div>
            <div class="wizard-card-title">Start from a new queue</div>
            <div class="wizard-card-text">Create a queue, capture its history (manual entry, CSV, or live source), then forecast.</div>
          </button>
        </div>
      `;
      body.querySelectorAll('.wizard-card').forEach(b => {
        b.addEventListener('click', () => {
          w.path = b.dataset.path;
          gotoStep(2);
        });
      });
    }

    /* ====================================================
     * STEP 2 — Pick queue or create new
     * ==================================================== */
    function step2(body, w) {
      if (w.path === 'existing') return step2Existing(body, w);
      return step2New(body, w);
    }

    function step2Existing(body, w) {
      const studio = WFM.State.get().studio || { queues: [] };
      const queues = studio.queues || [];

      if (queues.length === 0) {
        body.innerHTML = `
          <div class="wizard-step-head">
            <h2>No queues yet</h2>
            <p class="wizard-step-sub">You don't have any queues set up yet. Let's start from a new one instead.</p>
          </div>
          <div class="wizard-nav">
            <button class="btn ghost" id="back">← Back</button>
            <button class="btn primary" id="goNew">Start a new queue →</button>
          </div>
        `;
        UI.$('#back', body).addEventListener('click', () => gotoStep(1));
        UI.$('#goNew', body).addEventListener('click', () => { w.path = 'new'; gotoStep(2); });
        return;
      }

      body.innerHTML = `
        <div class="wizard-step-head">
          <h2>Which queue are we forecasting?</h2>
          <p class="wizard-step-sub">Pick one from your existing queues. I'll show you what data we have and where the gaps are.</p>
        </div>
        <div class="wizard-queue-list">
          ${queues.map(q => {
            const totalWeeks = Object.values(q.channelData || {}).reduce((s, arr) => s + arr.filter(v => v > 0).length, 0);
            const totalSlots = Object.values(q.channelData || {}).reduce((s, arr) => s + arr.length, 0);
            const product = q.productId && WFM.Products ? WFM.Products.get(q.productId) : null;
            return `
              <button class="wizard-queue-row ${w.queueId === q.id ? 'selected' : ''}" data-qid="${q.id}">
                <div style="flex: 1; min-width: 0">
                  ${product ? `<div style="margin-bottom: 4px"><span class="badge" style="background: ${product.color}20; color: ${product.color}; font-size: 10px">${escapeHTML(product.name).toUpperCase()}</span></div>` : ''}
                  <div class="wizard-queue-name">${escapeHTML(q.name)}</div>
                  <div class="muted t-small" style="margin-top: 4px">
                    ${q.channels.map(ch => `<span class="badge ${channelBadge(ch)}" style="font-size: 10px"><span class="dot"></span>${channelLabel(ch)}</span>`).join(' ')}
                    · ${totalWeeks}/${totalSlots} data points
                    ${q.regions && q.regions.length ? `· ${q.regions.join(', ')}` : ''}
                  </div>
                </div>
                <div class="wizard-queue-check">${w.queueId === q.id ? '✓' : ''}</div>
              </button>
            `;
          }).join('')}
        </div>
        <div class="wizard-nav">
          <button class="btn ghost" id="back">← Back</button>
          <button class="btn primary" id="next" ${w.queueId ? '' : 'disabled'}>Continue →</button>
        </div>
      `;

      body.querySelectorAll('.wizard-queue-row').forEach(b => b.addEventListener('click', () => {
        w.queueId = b.dataset.qid;
        persist();
        renderMain();
        renderAside();
      }));
      UI.$('#back', body).addEventListener('click', () => gotoStep(1));
      UI.$('#next', body).addEventListener('click', () => {
        // If the queue has data, we can skip the data-entry step. Otherwise go through it.
        const q = (WFM.State.get().studio.queues || []).find(x => x.id === w.queueId);
        const hasData = q && q.channels.some(ch => (q.channelData[ch] || []).some(v => v > 0));
        gotoStep(hasData ? 4 : 3);
      });
    }

    function step2New(body, w) {
      const allProducts = WFM.Products ? WFM.Products.list() : [];
      const allRegions = WFM.Regions ? WFM.Regions.list() : [];

      body.innerHTML = `
        <div class="wizard-step-head">
          <h2>Tell me about this new queue.</h2>
          <p class="wizard-step-sub">A queue is one work stream — like "Premium Support" or "Order Status". You can pick multiple channels (voice + chat + email); I'll forecast each separately.</p>
        </div>
        <div class="wizard-form">
          <div class="field">
            <label>Queue name</label>
            <input class="input" id="qName" placeholder="e.g. Premium Support, Billing Inquiries, Order Status" value="${escapeHTML(w.newQueue.name)}" autocomplete="off">
          </div>
          ${allProducts.length > 0 ? `
            <div class="field">
              <label>Product <span class="muted t-small">— optional grouping</span></label>
              <select class="select" id="qProduct">
                <option value="">— Unassigned —</option>
                ${allProducts.map(p => `<option value="${p.id}" ${w.newQueue.productId === p.id ? 'selected' : ''}>${escapeHTML(p.name)}</option>`).join('')}
              </select>
            </div>
          ` : `
            <div class="muted t-small" style="padding: 10px 12px; background: var(--bg-1); border-radius: var(--r-2)">
              💡 You haven't created any Products yet. That's fine — you can group queues later from the Products page.
            </div>
          `}
          <div class="field">
            <label>Channels <span class="muted t-small">— each gets its own forecast</span></label>
            <div class="grid cols-2" style="gap: 8px" id="qChannels">
              ${CHANNELS.map(c => `
                <label class="channel-pick ${w.newQueue.channels.includes(c.id) ? 'selected' : ''}" data-ch="${c.id}">
                  <input type="checkbox" class="ch-cb" data-ch="${c.id}" ${w.newQueue.channels.includes(c.id) ? 'checked' : ''}>
                  <span class="badge ${channelBadge(c.id)}"><span class="dot"></span>${c.label}</span>
                  <span class="muted t-small" style="margin-top: 4px">${channelHelp(c.id)}</span>
                </label>
              `).join('')}
            </div>
          </div>
          ${allRegions.length > 0 ? `
            <div class="field">
              <label>Regions <span class="muted t-small">— for holiday-aware forecasting</span></label>
              <div class="grid cols-2" style="gap: 6px" id="qRegions">
                ${allRegions.map(r => `
                  <label class="region-pick ${w.newQueue.regions.includes(r.id) ? 'selected' : ''}">
                    <input type="checkbox" class="rg-cb" data-rg="${r.id}" ${w.newQueue.regions.includes(r.id) ? 'checked' : ''}>
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
        <div class="wizard-nav">
          <button class="btn ghost" id="back">← Back</button>
          <button class="btn primary" id="next">Continue →</button>
        </div>
      `;

      UI.$('#qName', body).addEventListener('input', e => {
        w.newQueue.name = e.target.value;
        persist();
      });
      UI.$('#qProduct', body)?.addEventListener('change', e => {
        w.newQueue.productId = e.target.value || null;
        persist();
      });
      body.querySelectorAll('.ch-cb').forEach(cb => cb.addEventListener('change', e => {
        const ch = cb.dataset.ch;
        if (cb.checked) {
          if (!w.newQueue.channels.includes(ch)) w.newQueue.channels.push(ch);
        } else {
          w.newQueue.channels = w.newQueue.channels.filter(c => c !== ch);
        }
        cb.closest('.channel-pick').classList.toggle('selected', cb.checked);
        persist();
        renderAside();
      }));
      body.querySelectorAll('.channel-pick').forEach(lbl => lbl.addEventListener('click', e => {
        if (e.target.tagName === 'INPUT') return;
        const cb = lbl.querySelector('.ch-cb');
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
      }));
      body.querySelectorAll('.rg-cb').forEach(cb => cb.addEventListener('change', e => {
        const rg = cb.dataset.rg;
        if (cb.checked) {
          if (!w.newQueue.regions.includes(rg)) w.newQueue.regions.push(rg);
        } else {
          w.newQueue.regions = w.newQueue.regions.filter(r => r !== rg);
        }
        cb.closest('.region-pick').classList.toggle('selected', cb.checked);
        persist();
        renderAside();
      }));
      body.querySelectorAll('.region-pick').forEach(lbl => lbl.addEventListener('click', e => {
        if (e.target.tagName === 'INPUT') return;
        const cb = lbl.querySelector('.rg-cb');
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event('change'));
      }));

      UI.$('#back', body).addEventListener('click', () => gotoStep(1));
      UI.$('#next', body).addEventListener('click', () => {
        if (!w.newQueue.name.trim()) { UI.toast('Queue needs a name', 'warn'); return; }
        if (w.newQueue.channels.length === 0) { UI.toast('Pick at least one channel', 'warn'); return; }
        // Actually create the queue now so we have somewhere to put the data
        const studio = WFM.State.get().studio || {};
        studio.queues = studio.queues || [];
        const newQ = {
          id: 'Q' + (studio.queues.length + 1) + '_' + Math.random().toString(36).slice(2, 7),
          name: w.newQueue.name.trim(),
          productId: w.newQueue.productId,
          channels: w.newQueue.channels.slice(),
          channelData: {},
          regions: w.newQueue.regions.slice(),
          holidayOverrides: {}
        };
        const periods = studio.periods || 26;
        for (const ch of newQ.channels) newQ.channelData[ch] = new Array(periods).fill(0);
        studio.queues.push(newQ);
        studio.activeQueueId = newQ.id;
        w.queueId = newQ.id;
        WFM.State.set({ studio });
        UI.toast(`Created "${newQ.name}"`, 'ok');
        gotoStep(3);
      });
    }

    /* ====================================================
     * STEP 3 — Capture actuals
     * ==================================================== */
    function step3(body, w) {
      const studio = WFM.State.get().studio || {};
      const queue = (studio.queues || []).find(q => q.id === w.queueId);
      if (!queue) {
        body.innerHTML = `<div class="empty"><p>Queue not found. Go back.</p></div>`;
        return;
      }

      if (!w.dataEntryMode) {
        // Mode picker
        body.innerHTML = `
          <div class="wizard-step-head">
            <h2>How do you want to give me your historical data?</h2>
            <p class="wizard-step-sub">I need at least 4 weeks of historical volume to forecast — more is much better. 12+ weeks lets me detect seasonality. 26+ weeks lets me handle yearly patterns. Pick whichever route is easiest:</p>
          </div>
          <div class="wizard-cards">
            <button class="wizard-card" data-mode="manual">
              <div class="wizard-card-icon">⌨️</div>
              <div class="wizard-card-title">Type it in</div>
              <div class="wizard-card-text">Spreadsheet-style grid, one number per week per channel. Best when you have the numbers in front of you.</div>
            </button>
            <button class="wizard-card" data-mode="upload">
              <div class="wizard-card-icon">📁</div>
              <div class="wizard-card-title">Upload a CSV</div>
              <div class="wizard-card-text">Drop a CSV file. I'll figure out the format (wide with Week 1…N columns, or long with date/volume rows).</div>
            </button>
            <button class="wizard-card" data-mode="connect">
              <div class="wizard-card-icon">🔌</div>
              <div class="wizard-card-title">Connect a data source</div>
              <div class="wizard-card-text">Paste from Genesys Cloud reports, Excel, or another system. I'll parse what you paste.</div>
            </button>
          </div>
          <div class="wizard-nav">
            <button class="btn ghost" id="back">← Back</button>
          </div>
        `;
        body.querySelectorAll('.wizard-card').forEach(b => b.addEventListener('click', () => {
          w.dataEntryMode = b.dataset.mode;
          persist();
          renderMain();
        }));
        UI.$('#back', body).addEventListener('click', () => gotoStep(w.path === 'new' ? 2 : 2));
        return;
      }

      // Selected mode → render the right entry surface
      body.innerHTML = `
        <div class="wizard-step-head">
          <h2>Enter ${channelLabel(queue.channels[0]).toLowerCase()} actuals for "${escapeHTML(queue.name)}"</h2>
          <p class="wizard-step-sub">${dataModeIntro(w.dataEntryMode)}</p>
        </div>
        <div class="wizard-data-entry" id="dataEntry"></div>
        <div class="wizard-nav">
          <button class="btn ghost" id="back">← Pick a different method</button>
          <button class="btn primary" id="next">Continue →</button>
        </div>
      `;
      UI.$('#back', body).addEventListener('click', () => {
        w.dataEntryMode = null;
        persist();
        renderMain();
      });
      UI.$('#next', body).addEventListener('click', () => {
        const hasAny = queue.channels.some(ch => (queue.channelData[ch] || []).some(v => v > 0));
        if (!hasAny) {
          UI.toast('Please enter some data first, or pick a different method.', 'warn');
          return;
        }
        // If we have regions, go to Holidays (step 4). Otherwise jump to Horizon (step 5).
        if (queue.regions && queue.regions.length) gotoStep(4);
        else gotoStep(5);
      });

      const entry = UI.$('#dataEntry', body);
      if (w.dataEntryMode === 'manual')  renderManualEntryUI(entry, queue);
      else if (w.dataEntryMode === 'upload') renderUploadEntryUI(entry, queue);
      else renderConnectEntryUI(entry, queue);
    }

    function dataModeIntro(mode) {
      return ({
        manual: "Just type a number per week per channel. Tab to move across, paste a row of numbers to fill at once. I'll show you a live chart as you type.",
        upload: "Drop a CSV file below. Wide format (Queue × Week 1…N columns) and long format (Date / Volume rows) both work. I'll auto-detect.",
        connect: "Copy your data from any source — Genesys reports, Excel, Google Sheets — and paste it below. I'll parse tabs, commas, or spaces."
      })[mode] || '';
    }

    function renderManualEntryUI(host, queue) {
      const studio = WFM.State.get().studio;
      const periods = studio.periods || 26;
      // Ensure arrays exist at correct length
      for (const ch of queue.channels) {
        const arr = queue.channelData[ch] || [];
        if (arr.length < periods) queue.channelData[ch] = arr.concat(new Array(periods - arr.length).fill(0));
        else if (arr.length > periods) queue.channelData[ch] = arr.slice(0, periods);
      }

      host.innerHTML = `
        <div class="wizard-channel-tabs" id="chTabs"></div>
        <div class="wizard-grid-area" id="gridArea"></div>
      `;
      const chTabs = UI.$('#chTabs', host);
      let activeCh = queue.channels[0];

      function drawTabs() {
        chTabs.innerHTML = queue.channels.map(ch => `
          <button class="wizard-channel-tab ${ch === activeCh ? 'active' : ''}" data-ch="${ch}">
            <span class="badge ${channelBadge(ch)}" style="font-size: 10px"><span class="dot"></span>${channelLabel(ch)}</span>
            <span class="muted t-small">${(queue.channelData[ch] || []).filter(v => v > 0).length}/${periods} weeks</span>
          </button>
        `).join('');
        chTabs.querySelectorAll('.wizard-channel-tab').forEach(b => b.addEventListener('click', () => {
          activeCh = b.dataset.ch;
          drawTabs();
          drawGrid();
        }));
      }

      function drawGrid() {
        const arr = queue.channelData[activeCh];
        const gridArea = UI.$('#gridArea', host);
        gridArea.innerHTML = `
          <div class="wizard-grid-toolbar">
            <div class="t-micro">${periods} weeks of history for <b>${channelLabel(activeCh)}</b></div>
            <div class="row" style="gap: 6px">
              <button class="btn ghost t-small" id="addW">+1 week</button>
              <button class="btn ghost t-small" id="remW">−1 week</button>
              <button class="btn ghost t-small" id="clear">Clear</button>
            </div>
          </div>
          <div class="wizard-grid-wrap">
            <table class="tbl manual-grid">
              <thead><tr>
                <th style="position: sticky; left: 0; background: var(--bg-2); z-index: 1; min-width: 90px">Week</th>
                ${Array.from({length: periods}, (_,i) => `<th class="num">W${i+1}</th>`).join('')}
                <th class="num">Total</th>
              </tr></thead>
              <tbody>
                <tr>
                  <td style="position: sticky; left: 0; background: var(--bg-2); z-index: 1"><b>${channelLabel(activeCh)}</b></td>
                  ${arr.map((v, i) => `<td class="num"><input class="cell-input" data-i="${i}" value="${v != null && !isNaN(v) ? v : ''}" inputmode="numeric"></td>`).join('')}
                  <td class="num"><b id="grandTotal">${arr.reduce((s,v)=>s+(isFinite(v)?v:0),0).toLocaleString()}</b></td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="wizard-mini-chart" id="miniChart"></div>
        `;
        // Wire cell inputs
        gridArea.querySelectorAll('.cell-input').forEach(inp => {
          inp.addEventListener('input', e => {
            const i = +e.target.dataset.i;
            const v = e.target.value.replace(/[,\s]/g, '');
            arr[i] = v === '' ? 0 : (isFinite(+v) ? +v : 0);
            UI.$('#grandTotal', gridArea).textContent = arr.reduce((s,v)=>s+(isFinite(v)?v:0),0).toLocaleString();
            WFM.State.set({ studio });
            // Update chart + insights live
            updateMiniChart();
            renderAside();
            // Update the tabs' count without rebuilding entire tabs
            drawTabs();
          });
          inp.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === 'Tab') {
              const next = gridArea.querySelector(`.cell-input[data-i="${+inp.dataset.i + 1}"]`);
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
              if (idx < arr.length) arr[idx] = val;
            });
            WFM.State.set({ studio });
            drawGrid();
            renderAside();
          });
        });

        UI.$('#addW', gridArea).addEventListener('click', () => {
          studio.periods = Math.min(104, studio.periods + 1);
          for (const ch of queue.channels) {
            if (queue.channelData[ch].length < studio.periods) {
              queue.channelData[ch].push(0);
            }
          }
          WFM.State.set({ studio });
          drawGrid();
        });
        UI.$('#remW', gridArea).addEventListener('click', () => {
          studio.periods = Math.max(4, studio.periods - 1);
          for (const ch of queue.channels) {
            queue.channelData[ch] = queue.channelData[ch].slice(0, studio.periods);
          }
          WFM.State.set({ studio });
          drawGrid();
        });
        UI.$('#clear', gridArea).addEventListener('click', () => {
          queue.channelData[activeCh] = new Array(periods).fill(0);
          WFM.State.set({ studio });
          drawGrid();
          renderAside();
        });
        updateMiniChart();
      }

      function updateMiniChart() {
        const arr = queue.channelData[activeCh] || [];
        const hasData = arr.some(v => v > 0);
        const chartHost = UI.$('#miniChart', host);
        if (!chartHost) return;
        if (!hasData) {
          chartHost.innerHTML = `<div class="muted t-small" style="text-align: center; padding: 20px">Live chart will appear here as you type…</div>`;
          return;
        }
        chartHost.innerHTML = `
          <div class="t-micro" style="margin-bottom: 6px">Live preview</div>
          <div class="chart" style="height: 140px">${WFM.Charts.line({
            series: [{ name: 'Volume', data: arr, color: 'var(--accent)', showDots: arr.length <= 20 }],
            categories: arr.map((_,i) => i % 4 === 0 ? `W${i+1}` : ''),
            height: 140
          })}</div>
        `;
      }

      drawTabs();
      drawGrid();
    }

    function renderUploadEntryUI(host, queue) {
      const studio = WFM.State.get().studio;
      const targetChannel = queue.channels[0];
      host.innerHTML = `
        <div class="wizard-upload-area" id="dropzone">
          <div class="wizard-upload-icon">${WFM.Icons.upload}</div>
          <div class="wizard-upload-title">Drop CSV for ${channelLabel(targetChannel)} actuals</div>
          <div class="wizard-upload-sub">or click below to choose a file</div>
          <button class="btn primary" id="pick">Choose file</button>
          <input type="file" id="file" accept=".csv,.tsv,.txt" style="display: none">
        </div>
        ${queue.channels.length > 1 ? `
          <div class="field" style="margin-top: 12px">
            <label>Which channel should this go into?</label>
            <select class="select" id="targetCh">
              ${queue.channels.map(ch => `<option value="${ch}" ${ch === targetChannel ? 'selected' : ''}>${channelLabel(ch)}</option>`).join('')}
            </select>
          </div>
        ` : ''}
        <div id="uploadResult" style="margin-top: 12px"></div>
      `;
      let pickedChannel = targetChannel;
      UI.$('#targetCh', host)?.addEventListener('change', e => { pickedChannel = e.target.value; });

      const dz = UI.$('#dropzone', host);
      const fi = UI.$('#file', host);
      UI.$('#pick', host).addEventListener('click', () => fi.click());
      fi.addEventListener('change', e => e.target.files[0] && processFile(e.target.files[0]));
      dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('over'));
      dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) processFile(f); });

      function processFile(file) {
        const reader = new FileReader();
        reader.onload = ev => {
          const ingest = WFM.CSV.ingest(ev.target.result);
          const resultEl = UI.$('#uploadResult', host);
          if (!ingest.cleanedData.length) {
            resultEl.innerHTML = `<div class="wizard-insight wizard-insight-warn"><div class="wizard-insight-icon">⚠</div><div class="wizard-insight-body"><div class="wizard-insight-title">Couldn't parse this file</div><div class="wizard-insight-text">No usable rows found. Make sure the file has either a "date" + "volume" column, or one row of weekly columns (W1, W2, …).</div></div></div>`;
            return;
          }
          const grouped = {};
          for (const r of ingest.cleanedData) {
            const key = r.queue || '__default__';
            (grouped[key] = grouped[key] || []).push(r);
          }
          const firstKey = Object.keys(grouped)[0];
          const rows = grouped[firstKey];
          rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
          const newWeeks = rows.map(r => +r.volume);
          if (newWeeks.length > studio.periods) studio.periods = Math.min(104, newWeeks.length);
          queue.channelData[pickedChannel] = newWeeks;
          for (const ch of queue.channels) {
            const arr = queue.channelData[ch] || [];
            if (arr.length < studio.periods) queue.channelData[ch] = arr.concat(new Array(studio.periods - arr.length).fill(0));
          }
          WFM.State.set({ studio });
          resultEl.innerHTML = `<div class="wizard-insight wizard-insight-ok"><div class="wizard-insight-icon">✓</div><div class="wizard-insight-body"><div class="wizard-insight-title">Imported ${newWeeks.length} weeks</div><div class="wizard-insight-text">Data loaded into <b>${channelLabel(pickedChannel)}</b>. Click Continue → when ready.</div></div></div>`;
          renderAside();
        };
        reader.readAsText(file);
      }
    }

    function renderConnectEntryUI(host, queue) {
      const studio = WFM.State.get().studio;
      const targetChannel = queue.channels[0];
      host.innerHTML = `
        <div class="muted t-small" style="margin-bottom: 8px">Paste your data below. I accept comma-separated, tab-separated, or one number per line.</div>
        <textarea id="pasteArea" class="input" style="width: 100%; height: 200px; font-family: var(--font-mono); font-size: 12px" placeholder="W1\tW2\tW3\tW4\n520\t540\t510\t555\n\n— OR —\n\n2025-01-06,520\n2025-01-13,540\n2025-01-20,510\n"></textarea>
        ${queue.channels.length > 1 ? `
          <div class="field" style="margin-top: 12px">
            <label>Which channel should this go into?</label>
            <select class="select" id="targetCh">
              ${queue.channels.map(ch => `<option value="${ch}" ${ch === targetChannel ? 'selected' : ''}>${channelLabel(ch)}</option>`).join('')}
            </select>
          </div>
        ` : ''}
        <div style="margin-top: 12px">
          <button class="btn primary" id="parseBtn">Parse pasted data</button>
        </div>
        <div id="connectResult" style="margin-top: 12px"></div>
      `;
      let pickedChannel = targetChannel;
      UI.$('#targetCh', host)?.addEventListener('change', e => { pickedChannel = e.target.value; });

      UI.$('#parseBtn', host).addEventListener('click', () => {
        const text = UI.$('#pasteArea', host).value.trim();
        const result = UI.$('#connectResult', host);
        if (!text) { result.innerHTML = `<div class="muted t-small">Paste some data first.</div>`; return; }
        // Use the same CSV ingest pipeline, but fall back to a naive whitespace parse
        let numbers = [];
        try {
          const ingest = WFM.CSV.ingest(text);
          if (ingest.cleanedData.length) {
            numbers = ingest.cleanedData.map(r => +r.volume).filter(n => isFinite(n));
          }
        } catch (_) {}
        if (numbers.length === 0) {
          // Fallback: extract all numbers
          numbers = text.split(/[\s,\t\n]+/).map(s => +s).filter(n => isFinite(n) && n > 0);
        }
        if (numbers.length === 0) {
          result.innerHTML = `<div class="wizard-insight wizard-insight-warn"><div class="wizard-insight-icon">⚠</div><div class="wizard-insight-body"><div class="wizard-insight-text">Couldn't find any numbers. Try pasting again with one number per cell.</div></div></div>`;
          return;
        }
        if (numbers.length > studio.periods) studio.periods = Math.min(104, numbers.length);
        queue.channelData[pickedChannel] = numbers;
        for (const ch of queue.channels) {
          const arr = queue.channelData[ch] || [];
          if (arr.length < studio.periods) queue.channelData[ch] = arr.concat(new Array(studio.periods - arr.length).fill(0));
        }
        WFM.State.set({ studio });
        result.innerHTML = `<div class="wizard-insight wizard-insight-ok"><div class="wizard-insight-icon">✓</div><div class="wizard-insight-body"><div class="wizard-insight-title">Parsed ${numbers.length} values</div><div class="wizard-insight-text">Loaded into <b>${channelLabel(pickedChannel)}</b>. Click Continue → when ready.</div></div></div>`;
        renderAside();
      });
    }

    /* ====================================================
     * STEP 4 — Holidays review
     * ==================================================== */
    function step4(body, w) {
      const queue = (WFM.State.get().studio.queues || []).find(q => q.id === w.queueId);
      if (!queue || !queue.regions || queue.regions.length === 0) {
        body.innerHTML = `
          <div class="wizard-step-head"><h2>No regions selected — skipping holidays.</h2>
          <p class="wizard-step-sub">You can assign regions later from the queue editor. We'll move on to picking a forecast horizon.</p></div>
          <div class="wizard-nav">
            <button class="btn ghost" id="back">← Back</button>
            <button class="btn primary" id="next">Continue →</button>
          </div>
        `;
        UI.$('#back', body).addEventListener('click', () => gotoStep(3));
        UI.$('#next', body).addEventListener('click', () => gotoStep(5));
        return;
      }

      // Find upcoming holidays in the forecast window
      const studio = WFM.State.get().studio;
      const N = studio.periods || 26;
      const horizon = w.horizon || 26;
      const histDates = Array.from({length: N}, (_, i) => weekStartDate(N, i));
      const futDates = [];
      for (let i = 1; i <= horizon; i++) {
        const d = new Date(histDates[N-1] + 'T00:00:00Z');
        d.setUTCDate(d.getUTCDate() + i * 7);
        futDates.push(d.toISOString().slice(0, 10));
      }
      const futHits = WFM.Regions.holidaysForWeeks(futDates, queue.regions);
      const allUpcoming = [];
      futHits.forEach((m, i) => { if (m) m.forEach(x => allUpcoming.push({ ...x, weekIdx: i, weekDate: futDates[i] })); });

      // For each unique upcoming holiday, compute the AI suggestion
      const seen = new Map();
      for (const u of allUpcoming) if (!seen.has(u.holiday.id)) seen.set(u.holiday.id, u);
      const unique = Array.from(seen.values()).sort((a, b) => a.weekDate.localeCompare(b.weekDate));

      // Compute summed actuals (across channels) for AI suggestion
      const summedWeeks = histDates.map((_, i) => {
        let total = 0;
        for (const ch of queue.channels) total += (queue.channelData[ch]?.[i] || 0);
        return total;
      });

      queue.holidayOverrides = queue.holidayOverrides || {};

      body.innerHTML = `
        <div class="wizard-step-head">
          <h2>Let me know how holidays affect "${escapeHTML(queue.name)}".</h2>
          <p class="wizard-step-sub">Here are the holidays in your selected regions for the next ${horizon} weeks. The regional default impact is shown — adjust if this specific queue behaves differently. Where I have enough history, I'll suggest an impact based on your own data.</p>
        </div>
        ${unique.length === 0 ? `
          <div class="wizard-insight wizard-insight-info">
            <div class="wizard-insight-icon">ℹ</div>
            <div class="wizard-insight-body">
              <div class="wizard-insight-title">No holidays in the forecast window</div>
              <div class="wizard-insight-text">Your selected regions don't have any holidays during the next ${horizon} weeks. Moving on.</div>
            </div>
          </div>
        ` : `
          <table class="tbl wizard-holiday-table">
            <thead>
              <tr><th>Date</th><th>Holiday</th><th>Region</th><th class="num">Default ×</th><th class="num">This queue ×</th><th>AI suggestion</th></tr>
            </thead>
            <tbody>
              ${unique.map(u => {
                const ov = queue.holidayOverrides[u.holiday.id] || {};
                const sug = WFM.Regions.suggestImpactFromHistory(summedWeeks, histDates, u.holiday.name, queue.regions);
                return `
                  <tr data-hid="${u.holiday.id}">
                    <td style="font-family: var(--font-mono); font-size: 12px">${u.weekDate}</td>
                    <td><b>${escapeHTML(u.holiday.name)}</b></td>
                    <td class="muted t-small">${u.region}</td>
                    <td class="num muted" style="font-family: var(--font-mono)">${u.holiday.impactMult != null ? u.holiday.impactMult.toFixed(2) : '—'}</td>
                    <td class="num">
                      <input class="inline-edit hi-mult" data-hid="${u.holiday.id}" value="${ov.impactMult != null ? ov.impactMult : ''}" placeholder="default" style="text-align: right; width: 80px; font-family: var(--font-mono)">
                    </td>
                    <td>
                      ${sug ? `
                        <span style="font-family: var(--font-mono); font-size: 12px; color: var(--accent)"><b>× ${sug.impliedMult.toFixed(2)}</b></span>
                        <span class="muted t-small">(${sug.occurrences} in history)</span>
                        <button class="btn ghost t-small hi-apply" data-hid="${u.holiday.id}" data-val="${sug.impliedMult.toFixed(2)}" style="padding: 2px 8px; margin-left: 8px">Apply</button>
                      ` : `<span class="muted t-small">Not enough history</span>`}
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        `}
        <div class="wizard-nav">
          <button class="btn ghost" id="back">← Back</button>
          <button class="btn primary" id="next">Continue →</button>
        </div>
      `;

      body.querySelectorAll('.hi-mult').forEach(inp => {
        inp.addEventListener('blur', () => {
          const hid = inp.dataset.hid;
          const raw = inp.value.trim();
          queue.holidayOverrides[hid] = queue.holidayOverrides[hid] || {};
          if (raw === '') delete queue.holidayOverrides[hid].impactMult;
          else if (isFinite(+raw)) queue.holidayOverrides[hid].impactMult = +raw;
          if (Object.keys(queue.holidayOverrides[hid]).length === 0) delete queue.holidayOverrides[hid];
          WFM.State.set({ studio });
        });
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); });
      });
      body.querySelectorAll('.hi-apply').forEach(btn => btn.addEventListener('click', () => {
        const hid = btn.dataset.hid;
        const val = +btn.dataset.val;
        const row = body.querySelector(`tr[data-hid="${hid}"]`);
        const inp = row.querySelector('.hi-mult');
        inp.value = val;
        queue.holidayOverrides[hid] = queue.holidayOverrides[hid] || {};
        queue.holidayOverrides[hid].impactMult = val;
        WFM.State.set({ studio });
        UI.toast(`Applied × ${val.toFixed(2)}`, 'ok');
      }));

      UI.$('#back', body).addEventListener('click', () => gotoStep(3));
      UI.$('#next', body).addEventListener('click', () => gotoStep(5));
    }

    /* ====================================================
     * STEP 5 — Horizon + locked window
     * ==================================================== */
    function step5(body, w) {
      const horizonOpts = [
        { weeks: 4,   label: '4 weeks', sub: 'Next month — short-term staffing' },
        { weeks: 8,   label: '8 weeks', sub: 'Two months — operational planning' },
        { weeks: 13,  label: '1 quarter', sub: '13 weeks — schedule horizon' },
        { weeks: 26,  label: '2 quarters', sub: 'Half a year — hiring decisions' },
        { weeks: 52,  label: '1 year', sub: 'Full year — annual hiring + budget' },
        { weeks: 104, label: '2 years', sub: 'Strategic — high uncertainty beyond Y1' }
      ];
      body.innerHTML = `
        <div class="wizard-step-head">
          <h2>How far ahead are we forecasting?</h2>
          <p class="wizard-step-sub">Longer horizons widen the confidence band. The first 13 weeks (by default) will be your "locked" window — firm enough for scheduling. Anything beyond is indicative, to be refreshed as new actuals come in.</p>
        </div>
        <div class="wizard-horizon-grid">
          ${horizonOpts.map(o => `
            <button class="wizard-horizon-card ${w.horizon === o.weeks ? 'selected' : ''}" data-w="${o.weeks}">
              <div class="wizard-horizon-label">${o.label}</div>
              <div class="wizard-horizon-sub">${o.sub}</div>
            </button>
          `).join('')}
        </div>
        <div class="field" style="margin-top: 20px">
          <label>Locked window — how many weeks should be firm for scheduling? <b>${w.lockedWeeks} weeks</b></label>
          <input class="slider" type="range" id="lockedWeeks" min="2" max="${Math.min(26, w.horizon)}" step="1" value="${w.lockedWeeks}">
          <div class="muted t-small" style="margin-top: 4px">Forecasts inside this window are intended for scheduling. Beyond is indicative — re-run after a few weeks pass and new actuals come in.</div>
        </div>
        <div class="wizard-nav">
          <button class="btn ghost" id="back">← Back</button>
          <button class="btn primary" id="next">Continue →</button>
        </div>
      `;
      body.querySelectorAll('.wizard-horizon-card').forEach(b => b.addEventListener('click', () => {
        w.horizon = +b.dataset.w;
        if (w.lockedWeeks > w.horizon) w.lockedWeeks = Math.min(13, w.horizon);
        persist();
        renderMain();
        renderAside();
      }));
      UI.$('#lockedWeeks', body).addEventListener('input', e => {
        w.lockedWeeks = +e.target.value;
        const lbl = e.target.previousElementSibling;
        if (lbl) lbl.innerHTML = `Locked window — how many weeks should be firm for scheduling? <b>${w.lockedWeeks} weeks</b>`;
        persist();
      });
      UI.$('#back', body).addEventListener('click', () => gotoStep(4));
      UI.$('#next', body).addEventListener('click', () => gotoStep(6));
    }

    /* ====================================================
     * STEP 6 — Model selection
     * ==================================================== */
    function step6(body, w) {
      body.innerHTML = `
        <div class="wizard-step-head">
          <h2>Want me to pick the model, or do you have a preference?</h2>
          <p class="wizard-step-sub">By default I'll run six different models on your data, evaluate each via walk-forward backtest, and pick the one with the lowest error. That's almost always the right call unless you have a specific reason to override.</p>
        </div>
        <div class="wizard-cards">
          <button class="wizard-card ${!w.forceModel ? 'selected' : ''}" data-model="">
            <div class="wizard-card-icon">⚡</div>
            <div class="wizard-card-title">Auto-select (recommended)</div>
            <div class="wizard-card-text">I'll run Moving Average, Weighted MA, Linear Regression, Seasonal Decomposition, Holt-Winters, and Ensemble — and tell you which one won.</div>
          </button>
          <button class="wizard-card ${w.forceModel ? 'selected' : ''}" data-model="manual">
            <div class="wizard-card-icon">🎯</div>
            <div class="wizard-card-title">Force a specific model</div>
            <div class="wizard-card-text">For testing or comparison. You'll pick from the six available models.</div>
          </button>
        </div>
        ${w.forceModel ? `
          <div class="field" style="margin-top: 16px">
            <label>Which model?</label>
            <select class="select" id="modelPick">
              <option value="movingAverageModel"         ${w.forceModel === 'movingAverageModel'         ? 'selected' : ''}>Moving Average</option>
              <option value="weightedMovingAverageModel" ${w.forceModel === 'weightedMovingAverageModel' ? 'selected' : ''}>Weighted MA</option>
              <option value="regressionModel"            ${w.forceModel === 'regressionModel'            ? 'selected' : ''}>Linear Regression</option>
              <option value="seasonalityModel"           ${w.forceModel === 'seasonalityModel'           ? 'selected' : ''}>Seasonal Decomposition</option>
              <option value="holtWintersModel"           ${w.forceModel === 'holtWintersModel'           ? 'selected' : ''}>Holt-Winters</option>
              <option value="ensembleModel"              ${w.forceModel === 'ensembleModel'              ? 'selected' : ''}>Ensemble</option>
            </select>
          </div>
        ` : ''}
        <div class="wizard-nav">
          <button class="btn ghost" id="back">← Back</button>
          <button class="btn primary" id="next">Continue →</button>
        </div>
      `;
      body.querySelectorAll('.wizard-card').forEach(b => b.addEventListener('click', () => {
        const v = b.dataset.model;
        w.forceModel = v === '' ? null : (w.forceModel || 'holtWintersModel');
        persist();
        renderMain();
      }));
      UI.$('#modelPick', body)?.addEventListener('change', e => { w.forceModel = e.target.value; persist(); });
      UI.$('#back', body).addEventListener('click', () => gotoStep(5));
      UI.$('#next', body).addEventListener('click', () => gotoStep(7));
    }

    /* ====================================================
     * STEP 7 — Run forecast
     * ==================================================== */
    function step7(body, w) {
      const studio = WFM.State.get().studio;
      const queue = (studio.queues || []).find(q => q.id === w.queueId);

      if (!w.lastRunResults) {
        body.innerHTML = `
          <div class="wizard-step-head">
            <h2>Ready to generate the forecast.</h2>
            <p class="wizard-step-sub">I'll forecast each channel of "${escapeHTML(queue.name)}" separately, applying any holiday adjustments you set up. Click below when ready.</p>
          </div>
          <div style="text-align: center; padding: 40px 0">
            <button class="btn primary" id="runBtn" style="padding: 12px 32px; font-size: 14px">
              ${WFM.Icons.spark} Generate forecast
            </button>
          </div>
          <div class="wizard-nav">
            <button class="btn ghost" id="back">← Back</button>
          </div>
        `;
        UI.$('#back', body).addEventListener('click', () => gotoStep(6));
        UI.$('#runBtn', body).addEventListener('click', () => runForecast(w, body));
        return;
      }

      // We have results — show them
      const results = w.lastRunResults;
      body.innerHTML = `
        <div class="wizard-step-head">
          <h2>Here's your forecast.</h2>
          <p class="wizard-step-sub">${results.forecasts.length} channel${results.forecasts.length===1?'':'s'} forecasted · ${w.horizon} weeks ahead · locked through week ${w.lockedWeeks}</p>
        </div>
        <div id="resultCards"></div>
        <div class="wizard-nav">
          <button class="btn ghost" id="back">← Back</button>
          <button class="btn ghost" id="rerun">Re-run</button>
          <button class="btn primary" id="next">Continue to capacity →</button>
        </div>
      `;
      const host = UI.$('#resultCards', body);
      results.forecasts.forEach(r => {
        const card = document.createElement('div');
        card.style.marginBottom = 'var(--space-3)';
        card.innerHTML = renderResultCard(r);
        host.appendChild(card);
      });
      UI.$('#back', body).addEventListener('click', () => gotoStep(6));
      UI.$('#rerun', body).addEventListener('click', () => { w.lastRunResults = null; persist(); renderMain(); });
      UI.$('#next', body).addEventListener('click', () => gotoStep(8));
    }

    function runForecast(w, body) {
      const studio = WFM.State.get().studio;
      const queue = (studio.queues || []).find(q => q.id === w.queueId);
      if (!queue) return;

      // Loading state
      body.querySelector('.wizard-nav').insertAdjacentHTML('beforebegin', `
        <div id="runStatus" style="text-align: center; padding: 40px 0; color: var(--fg-2)">
          <div style="font-size: 32px; margin-bottom: 12px">⚡</div>
          <div>Generating forecast…</div>
        </div>
      `);
      UI.$('#runBtn', body)?.setAttribute('disabled', 'true');

      setTimeout(() => {
        const results = { forecasts: [] };
        const N = studio.periods || 26;
        const horizon = w.horizon;
        const histDates = Array.from({length: N}, (_, i) => weekStartDate(N, i));
        const futDates = [];
        for (let i = 1; i <= horizon; i++) {
          const d = new Date(histDates[N-1] + 'T00:00:00Z');
          d.setUTCDate(d.getUTCDate() + i * 7);
          futDates.push(d.toISOString().slice(0, 10));
        }

        for (const ch of queue.channels) {
          const weeks = queue.channelData[ch] || [];
          const nonZero = weeks.filter(v => v > 0);
          if (nonZero.length < 4) {
            results.forecasts.push({
              queue: queue.name, channel: ch, channelKey: ch, queueId: queue.id,
              history_volumes: weeks.slice(),
              forecast: [], confidence_interval: [],
              warning: 'Insufficient data',
              confidence: { level: 'Low' },
              explanation: [`Only ${nonZero.length} non-zero weeks — need at least 4.`]
            });
            continue;
          }
          // Build holiday arrays with per-queue overrides
          const overrides = queue.holidayOverrides || {};
          const histHits = queue.regions?.length ? WFM.Regions.holidaysForWeeks(histDates, queue.regions) : [];
          const futHits = queue.regions?.length ? WFM.Regions.holidaysForWeeks(futDates, queue.regions) : [];
          const resolve = (entry) => {
            if (!entry || !entry[0]) return null;
            const h = entry[0].holiday;
            const eff = WFM.Regions.effectiveImpact(h, overrides);
            return { name: h.name, impactMult: eff.impactMult, impactDelta: eff.impactDelta };
          };
          const historyHolidays = histHits.map(resolve);
          const forecastHolidays = futHits.map(resolve);

          const fcOut = WFM.Forecasting.forecastSeries(weeks, horizon, {
            forceModel: w.forceModel,
            historyHolidays,
            forecastHolidays,
            lockedWeeks: w.lockedWeeks
          });
          results.forecasts.push({
            queue: queue.name, channel: ch, channelKey: ch, queueId: queue.id, productId: queue.productId, regions: queue.regions || [],
            history_volumes: weeks.slice(),
            forecast: fcOut.yhat,
            confidence_interval: fcOut.confidence_interval,
            model_used: fcOut.model,
            model_label: fcOut.modelLabel,
            accuracy_score: fcOut.accuracy,
            confidence: fcOut.confidence,
            explanation: fcOut.explanation,
            anomalies: fcOut.anomalies,
            holidayLog: fcOut.holidayLog,
            forecastAdjustments: fcOut.forecastAdjustments,
            warning: fcOut.warning,
            locked: fcOut.locked,
            indicative: fcOut.indicative
          });
        }

        w.lastRunResults = results;
        // Also write into studio.lab.results so the Capacity page picks it up
        studio.lab = studio.lab || {};
        studio.lab.results = results;
        studio.lockedWeeks = w.lockedWeeks;
        WFM.State.set({ studio });
        persist();
        renderMain();
      }, 600);
    }

    function renderResultCard(r) {
      const lockedYhat = r.locked?.yhat || [];
      const indicativeYhat = r.indicative?.yhat || [];
      const lockedAvg = lockedYhat.length ? Math.round(lockedYhat.reduce((s,v)=>s+v,0) / lockedYhat.length) : null;
      const indicativeAvg = indicativeYhat.length ? Math.round(indicativeYhat.reduce((s,v)=>s+v,0) / indicativeYhat.length) : null;
      const actual = r.history_volumes || [];

      // Build chart series
      const totalLen = actual.length + r.forecast.length;
      const actualSeries = actual.concat(new Array(r.forecast.length).fill(null));
      const lockedSeries = new Array(actual.length).fill(null).concat(lockedYhat).concat(new Array(indicativeYhat.length).fill(null));
      const indSeries = new Array(actual.length + Math.max(0, lockedYhat.length - 1)).fill(null);
      if (lockedYhat.length > 0 && indicativeYhat.length > 0) indSeries.push(lockedYhat[lockedYhat.length - 1]);
      indSeries.push(...indicativeYhat);
      while (indSeries.length < totalLen) indSeries.push(null);

      const series = [{ name: 'Actual', data: actualSeries, color: 'var(--c-cyan)', showDots: false }];
      if (lockedYhat.length) series.push({ name: 'Locked', data: lockedSeries, color: 'var(--accent)', showDots: false });
      if (indicativeYhat.length) series.push({ name: 'Indicative', data: indSeries, color: 'var(--accent)', dashed: true, showDots: false });

      const lo = r.confidence_interval?.map(c => c[0]) || [];
      const hi = r.confidence_interval?.map(c => c[1]) || [];
      const ciLo = new Array(actual.length).fill(null).concat(lo);
      const ciHi = new Array(actual.length).fill(null).concat(hi);

      const chart = WFM.Charts.line({
        series, ciLo, ciHi,
        categories: Array.from({length: totalLen}, (_, i) => i % 4 === 0 ? (i < actual.length ? `W${i+1}` : `F${i - actual.length + 1}`) : ''),
        height: 220
      });

      const accTxt = r.accuracy_score != null ? `${(r.accuracy_score*100).toFixed(1)}%` : 'N/A';

      return `
        <div class="card">
          <div class="card-head">
            <div>
              <h3>${escapeHTML(r.queue)} · <span class="badge ${channelBadge(r.channelKey)}" style="font-size: 10px"><span class="dot"></span>${channelLabel(r.channelKey)}</span></h3>
              <div class="sub">${actual.length} weeks of history · ${r.forecast.length} weeks forecast</div>
            </div>
          </div>
          <div class="card-body">
            ${r.warning ? `
              <div class="wizard-insight wizard-insight-warn">
                <div class="wizard-insight-icon">⚠</div>
                <div class="wizard-insight-body">
                  <div class="wizard-insight-title">${escapeHTML(r.warning)}</div>
                  <div class="wizard-insight-text">${(r.explanation || []).join(' ')}</div>
                </div>
              </div>
            ` : `
              <div class="grid cols-4">
                ${WFM.UI.kpiHTML({ label: 'Model used', value: r.model_label || '—', accent: true })}
                ${WFM.UI.kpiHTML({ label: 'Accuracy', value: accTxt })}
                ${WFM.UI.kpiHTML({ label: 'Confidence', value: r.confidence?.level || 'N/A' })}
                ${WFM.UI.kpiHTML({ label: 'Anomalies', value: (r.anomalies?.length || 0).toString() })}
              </div>
              <div class="grid cols-2" style="margin-top: 12px">
                ${lockedAvg != null ? WFM.UI.kpiHTML({ label: `Locked window (${lockedYhat.length}w avg)`, value: lockedAvg.toLocaleString(), delta: 'schedule against this', deltaDir: 'flat', accent: true }) : ''}
                ${indicativeAvg != null ? WFM.UI.kpiHTML({ label: `Indicative window (${indicativeYhat.length}w avg)`, value: indicativeAvg.toLocaleString(), delta: 'directional', deltaDir: 'flat' }) : ''}
              </div>
              <div class="chart" style="height: 240px; margin-top: 12px">${chart}</div>
              ${r.explanation?.length ? `
                <div class="t-micro" style="margin-top: 12px; margin-bottom: 6px">Atlas's notes</div>
                <ul style="margin: 0; padding-left: 18px; font-size: 12px; color: var(--fg-1)">
                  ${r.explanation.map(e => `<li>${escapeHTML(e)}</li>`).join('')}
                </ul>
              ` : ''}
            `}
          </div>
        </div>
      `;
    }

    /* ====================================================
     * STEP 8 — Capacity preview
     * ==================================================== */
    function step8(body, w) {
      // We've already written results to studio.lab.results in step 7. The
      // Capacity module reads from there. Show a summary preview inline +
      // a button to go to the full Capacity page.
      const studio = WFM.State.get().studio;
      const results = w.lastRunResults || studio.lab?.results;
      const queue = (studio.queues || []).find(q => q.id === w.queueId);

      if (!results || !queue) {
        body.innerHTML = `<div class="empty"><p>No forecast results found.</p></div>`;
        return;
      }

      // Quick FTE estimate per channel using defaults
      const ftePreview = results.forecasts.filter(r => !r.warning).map(r => {
        const aht = r.channelKey === 'voice' ? 295 : r.channelKey === 'chat' ? 420 : r.channelKey === 'email' ? 240 : 600;
        const concurrency = r.channelKey === 'chat' ? 2.5 : 1;
        const shrinkage = 0.30;
        const occupancy = 0.85;
        const lockedAvg = (r.locked?.yhat || []).reduce((s,v)=>s+v,0) / Math.max(1, (r.locked?.yhat || []).length);
        const workSec = lockedAvg * (aht / concurrency);
        const capacityPerAgent = 40 * 3600 * occupancy;
        const netFTE = workSec / capacityPerAgent;
        const grossFTE = netFTE / (1 - shrinkage);
        return { channel: r.channelKey, weeklyVol: Math.round(lockedAvg), fte: Math.round(grossFTE) };
      });
      const totalFTE = ftePreview.reduce((s, p) => s + p.fte, 0);

      body.innerHTML = `
        <div class="wizard-step-head">
          <h2>Here's what staffing this forecast requires.</h2>
          <p class="wizard-step-sub">Quick estimate using default channel assumptions (AHT, shrinkage, occupancy). For the full plan with editable inputs and the indicative window, head to the Capacity page after we save.</p>
        </div>
        <div class="card">
          <div class="card-head">
            <div>
              <h3>"${escapeHTML(queue.name)}" — locked window staffing</h3>
              <div class="sub">Based on the average forecast volume in your locked window</div>
            </div>
          </div>
          <div class="card-body">
            <div class="grid cols-4">
              ${WFM.UI.kpiHTML({ label: 'Total FTE', value: totalFTE.toString(), accent: true })}
              ${ftePreview.map(p => WFM.UI.kpiHTML({ label: `${channelLabel(p.channel)} FTE`, value: p.fte.toString(), delta: `${p.weeklyVol.toLocaleString()}/wk`, deltaDir: 'flat' })).join('')}
            </div>
            <div class="muted t-small" style="margin-top: 12px; padding: 10px 12px; background: var(--bg-1); border-radius: var(--r-2)">
              <b>Note:</b> these are rough estimates using default assumptions. The full Capacity page lets you adjust AHT, shrinkage, occupancy, and SLA target per channel — and gives you a week-by-week breakdown across the locked + indicative window.
            </div>
          </div>
        </div>
        <div class="wizard-nav">
          <button class="btn ghost" id="back">← Back</button>
          <button class="btn primary" id="next">Save this forecast →</button>
        </div>
      `;
      UI.$('#back', body).addEventListener('click', () => gotoStep(7));
      UI.$('#next', body).addEventListener('click', () => gotoStep(9));
    }

    /* ====================================================
     * STEP 9 — Save & finish
     * ==================================================== */
    function step9(body, w) {
      const queue = (WFM.State.get().studio.queues || []).find(q => q.id === w.queueId);
      const defaultName = w.runName || `${queue?.name || 'Forecast'} — ${new Date().toLocaleDateString()} (${w.horizon}w)`;

      body.innerHTML = `
        <div class="wizard-step-head">
          <h2>Save this forecast and you're done.</h2>
          <p class="wizard-step-sub">Saved forecasts live in your Forecast Runs library — you can come back, compare versions side-by-side, or re-run with newer actuals.</p>
        </div>
        <div class="wizard-form">
          <div class="field">
            <label>Forecast name</label>
            <input class="input" id="runName" placeholder="${escapeHTML(defaultName)}" value="${escapeHTML(w.runName || '')}" autocomplete="off">
            <div class="muted t-small" style="margin-top: 4px">A descriptive name helps when you have multiple versions ("Q3 hiring plan v2", "Diwali stress test", etc).</div>
          </div>
        </div>
        <div class="wizard-nav">
          <button class="btn ghost" id="back">← Back</button>
          <button class="btn primary" id="finish">Save & finish →</button>
        </div>
      `;
      UI.$('#runName', body).addEventListener('input', e => { w.runName = e.target.value; persist(); });
      UI.$('#back', body).addEventListener('click', () => gotoStep(8));
      UI.$('#finish', body).addEventListener('click', () => {
        const name = (w.runName || '').trim() || defaultName;
        if (WFM.Vault) {
          WFM.Vault.saveForecastRun({
            name,
            horizon: w.horizon,
            lockedWeeks: w.lockedWeeks,
            results: w.lastRunResults
          });
        }
        UI.toast(`Saved "${name}"`, 'ok');
        clearWizardState();
        M._state = null;
        // Go to Capacity page so the user immediately sees the staffing translation
        location.hash = '#capacity';
      });
    }

    /* ====================================================
     * Atlas commentary — context-aware insights per step
     * Returns array of {kind, icon, title, text}
     * ==================================================== */
    function getCommentary(w) {
      const studio = WFM.State.get().studio || { queues: [] };
      const queue = (studio.queues || []).find(q => q.id === w.queueId);

      switch (w.step) {
        case 1:
          return [
            { kind: 'info', icon: '👋', title: "Hi, I'm Atlas.", text: "I'll guide you through every step. I'll point out things that look unusual in your data, suggest reasonable defaults, and explain my reasoning so you know why I'm recommending something." },
            { kind: 'info', icon: '💡', title: 'What you\'ll get', text: "By the end: a forecast for each channel of your queue, with a clear locked window for scheduling and an indicative window for hiring plans. Plus a capacity estimate showing required FTE." }
          ];
        case 2:
          if (w.path === 'existing') {
            if (!w.queueId) return [
              { kind: 'info', icon: '📊', title: 'Pick any queue', text: 'Each queue is forecasted independently. If you have several to forecast, run through the wizard once per queue — your earlier choices are remembered.' }
            ];
            if (queue) {
              const totalWeeks = Object.values(queue.channelData || {}).reduce((s, arr) => s + arr.filter(v => v > 0).length, 0);
              const out = [];
              out.push({ kind: 'ok', icon: '✓', title: `${queue.name}`, text: `${queue.channels.length} channel${queue.channels.length===1?'':'s'} · ${totalWeeks} weeks of data total.` });
              if (totalWeeks < 12) out.push({ kind: 'warn', icon: '⚠', title: 'Limited data', text: 'You have fewer than 12 weeks. Forecasts will work but accuracy will be limited and seasonality detection won\'t fire. More data → better forecasts.' });
              if (queue.regions?.length) out.push({ kind: 'info', icon: '🌍', title: 'Regions configured', text: `Holiday-aware forecasting is active for: ${queue.regions.join(', ')}.` });
              else out.push({ kind: 'info', icon: '🌍', title: 'No regions', text: 'No regions assigned — holiday adjustments won\'t apply. You can add them later from the queue editor.' });
              return out;
            }
            return [{ kind: 'info', icon: '👈', text: 'Pick a queue from the list to continue.' }];
          } else {
            const out = [];
            out.push({ kind: 'info', icon: '✨', title: 'A few naming tips', text: 'Use a name that describes the work, not the team — e.g. "Premium Support" rather than "John\'s queue".' });
            if (w.newQueue.channels.length > 1) {
              out.push({ kind: 'info', icon: '📡', title: `${w.newQueue.channels.length} channels selected`, text: 'Each channel maintains its own actuals and forecast. Voice and chat have very different patterns — keeping them separate gives you much better forecasts than blending.' });
            }
            if (w.newQueue.regions.length > 0) {
              out.push({ kind: 'ok', icon: '🌍', title: `${w.newQueue.regions.length} regions`, text: 'Good — region selection enables holiday-aware forecasting. I\'ll look up holidays in these regions automatically.' });
            }
            return out;
          }
        case 3:
          if (!w.dataEntryMode) return [
            { kind: 'info', icon: '🤔', title: 'Which to pick?', text: "If you have a Genesys/Verint export → upload it as CSV. If you have a few numbers in your head → type manually. If you're copying from Excel → paste it." },
            { kind: 'info', icon: '📈', title: 'How much data do I need?', text: "4 weeks is the minimum I'll forecast on. 12+ weeks lets me detect seasonality. 26+ weeks is much better. 52+ weeks is ideal — I can learn yearly patterns." }
          ];
          if (queue) {
            const total = Object.values(queue.channelData || {}).reduce((s, arr) => s + arr.filter(v => v > 0).length, 0);
            const out = [];
            if (total === 0) {
              out.push({ kind: 'info', icon: '🎯', title: 'Just start typing', text: w.dataEntryMode === 'manual' ? "Click any cell and enter a number. The chart appears as soon as you have a few values." : "Drop your file above or paste your data. I'll show you a confirmation as soon as it parses." });
            } else {
              out.push({ kind: 'ok', icon: '✓', title: `${total} data points entered`, text: 'Looking good. Click Continue → when you\'re ready to move on.' });
              if (total < 12) out.push({ kind: 'warn', icon: '⚠', title: 'Want better forecasts?', text: `Adding more weeks of history will unlock seasonality detection (need 12+) and yearly patterns (need 52+).` });
            }
            return out;
          }
          return [];
        case 4:
          return [
            { kind: 'info', icon: '🎉', title: 'About holiday impact factors', text: 'A factor of 0.30 means volume drops to 30% of normal. 1.65 means it spikes to 165%. Empty means use the regional default.' },
            { kind: 'info', icon: '🧠', title: 'Where AI suggestions come from', text: "If you have 2+ historical occurrences of a holiday in your data, I compute the implied impact by comparing those weeks to surrounding weeks. The more occurrences I see, the more I trust it." }
          ];
        case 5:
          const horizonGuidance = {
            4:   'Best for next-month staffing decisions. High confidence, low noise.',
            8:   'Good for operational planning. Still high confidence on most queues.',
            13:  'A full quarter — the standard scheduling horizon. Confidence is still strong.',
            26:  'Half a year — getting into hiring-decision territory. Confidence widens noticeably.',
            52:  'Annual — appropriate for budget cycles. Beyond month 6, treat as directional.',
            104: 'Strategic planning only. The confidence band gets wide; use the locked window for actions, treat the rest as broad guidance.'
          };
          return [
            { kind: 'info', icon: '⏱', title: `${w.horizon}-week horizon`, text: horizonGuidance[w.horizon] || 'Adjust if needed.' },
            { kind: 'info', icon: '🔒', title: 'Why the locked window matters', text: 'Within the locked window, the forecast is firm enough to drive schedules. Beyond it, things change too much — better to re-forecast every few weeks as new actuals arrive.' }
          ];
        case 6:
          return [
            { kind: 'info', icon: '🎯', title: 'When to force a model', text: 'For most cases, auto is the right call. Force a model only if you specifically want to compare two models, or you know your data has a quirk that the auto-selector misses.' },
            { kind: 'info', icon: '📚', title: 'A quick model guide', text: 'Moving Average: stable demand. Holt-Winters: trend + seasonality. Seasonal Decomposition: pure cycles. Regression: linear trends. Ensemble: best-of-many.' }
          ];
        case 7:
          if (!w.lastRunResults) return [
            { kind: 'info', icon: '⚡', title: 'About to forecast', text: `${queue?.channels.length || 0} channel${queue?.channels.length===1?'':'s'} · ${w.horizon} weeks ahead · ${w.lockedWeeks} weeks locked. I'll evaluate 6 models on each channel and pick the best.` }
          ];
          const results = w.lastRunResults;
          const out = [];
          const goodCount = results.forecasts.filter(r => !r.warning && r.confidence?.level !== 'Low').length;
          const lowCount = results.forecasts.filter(r => r.confidence?.level === 'Low').length;
          const warnCount = results.forecasts.filter(r => r.warning).length;
          if (goodCount) out.push({ kind: 'ok', icon: '✓', title: `${goodCount} solid forecast${goodCount===1?'':'s'}`, text: 'Confidence is medium or high. Safe to use these.' });
          if (lowCount) out.push({ kind: 'warn', icon: '⚠', title: `${lowCount} low-confidence`, text: 'Treat these as directional only. Adding more historical data will improve them.' });
          if (warnCount) out.push({ kind: 'warn', icon: '⚠', title: `${warnCount} insufficient data`, text: 'These channels need at least 4 non-zero weeks before they can be forecasted.' });
          return out;
        case 8:
          return [
            { kind: 'info', icon: '👥', title: 'About these FTE numbers', text: 'These are quick estimates using default channel assumptions. The full Capacity page lets you fine-tune AHT, shrinkage, and occupancy per channel — those affect FTE significantly.' },
            { kind: 'info', icon: '📋', title: 'What comes next', text: 'After saving, you\'ll land on the Capacity page where you can see the week-by-week staffing breakdown across both the locked and indicative windows.' }
          ];
        case 9:
          return [
            { kind: 'info', icon: '💾', title: 'About saved forecasts', text: 'Saved runs are kept in your Forecast Runs library. You can compare versions side-by-side later — useful for tracking "what did I think the forecast was 4 weeks ago vs. now?".' }
          ];
        default:
          return [];
      }
    }
  };

  /* ====================================================
   * Helpers
   * ==================================================== */
  function weekStartDate(n, i) {
    const today = new Date();
    const day = today.getUTCDay() || 7;
    const lastMonday = new Date(today);
    lastMonday.setUTCDate(today.getUTCDate() - (day - 1) - (day === 1 ? 7 : 0));
    const target = new Date(lastMonday);
    target.setUTCDate(lastMonday.getUTCDate() - (n - 1 - i) * 7);
    return target.toISOString().slice(0, 10);
  }
  function escapeHTML(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function channelLabel(ch) {
    return ({ voice: 'Voice', chat: 'Chat', email: 'Email', web: 'Web Case' })[ch] || ch;
  }
  function channelBadge(ch) {
    return ({ voice: 'info', chat: 'accent', email: 'ok', web: 'warn' })[ch] || '';
  }
  function channelHelp(ch) {
    return ({
      voice: 'Inbound or outbound calls',
      chat:  'Live web chat / messenger',
      email: 'Email or ticket queue',
      web:   'Async web case / form submission'
    })[ch] || '';
  }
  const CHANNELS = [
    { id: 'voice', label: 'Voice (calls)' },
    { id: 'chat',  label: 'Chat' },
    { id: 'email', label: 'Email' },
    { id: 'web',   label: 'Web Case' }
  ];

  WFM.Modules = WFM.Modules || {};
  WFM.Modules.wizard = M;
})(window.WFM = window.WFM || {});
