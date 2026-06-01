/* =========================================================
 * Module: Capacity Planning
 *
 * Queue-level capacity rollup with channel bifurcation. For each queue
 * that has a recent forecast (run from Forecast Workbench → Forecast
 * Creator), this page shows:
 *   - Required FTE per channel per week
 *   - Aggregated queue-level FTE per week
 *   - Locked vs Indicative split (matches the forecast tier)
 *   - Editable inputs: AHT, shrinkage, occupancy, SLA target
 *
 * Data flow: forecast results live on WFM.State.studio.lab.results.forecasts
 * (array of {queueId, channelKey, locked.yhat, indicative.yhat, ...}).
 * We group those by queueId and compute Erlang-C requirements per channel
 * via WFM.Capacity.requiredAgents.
 * ========================================================= */
(function (WFM) {
  'use strict';
  const M = {};

  // Channel defaults — used when the user hasn't customized inputs for a queue
  const CHANNEL_DEFAULTS = {
    voice: { aht: 295, slTarget: 0.80, slSec: 20,    concurrency: 1   },
    chat:  { aht: 420, slTarget: 0.85, slSec: 30,    concurrency: 2.5 },
    email: { aht: 240, slTarget: 0.90, slSec: 14400, concurrency: 1   },
    web:   { aht: 600, slTarget: 0.90, slSec: 14400, concurrency: 1   }
  };

  // Persistent per-queue overrides for staffing assumptions
  function getInputs(queueId, channel) {
    const s = WFM.State.get().studio || {};
    s.capacityInputs = s.capacityInputs || {};
    const key = `${queueId}::${channel}`;
    if (!s.capacityInputs[key]) {
      s.capacityInputs[key] = {
        ...CHANNEL_DEFAULTS[channel] || CHANNEL_DEFAULTS.voice,
        shrinkage: 0.30,
        occupancyTarget: 0.85
      };
    }
    return s.capacityInputs[key];
  }

  M.mount = function (root, state) {
    const UI = WFM.UI;
    const studio = WFM.State.get().studio || {};
    const results = studio.lab?.results;

    if (!results || !results.forecasts || results.forecasts.length === 0) {
      root.innerHTML = `
        <div class="page">
          <div class="page-head"><div><h1>Capacity Planning</h1><div class="sub">Translates the forecast into required FTE per queue, bifurcated by channel</div></div></div>
          <div class="card" style="margin-top: var(--space-4)">
            <div class="card-body" style="padding: 60px; text-align: center">
              <div style="font-size: 32px; color: var(--fg-3); margin-bottom: var(--space-3)">${WFM.Icons.spark}</div>
              <h3 style="margin: 0 0 8px">No forecast yet</h3>
              <p class="muted" style="max-width: 520px; margin: 0 auto var(--space-4)">
                Capacity needs are computed from the most recent forecast. Open the Forecast Workbench,
                pick queues and channels, and click Run Forecast. Then come back here.
              </p>
              <button class="btn primary" onclick="location.hash='#data-studio'">${WFM.Icons.arrow_right} Open Forecast Workbench</button>
            </div>
          </div>
        </div>
      `;
      return;
    }

    render();

    function render() {
      // Group forecast rows by queueId so we can roll up at queue level
      const studioNow = WFM.State.get().studio;
      const queues = studioNow.queues || [];
      const queueLookup = new Map(queues.map(q => [q.id, q]));
      const grouped = new Map();
      for (const r of results.forecasts) {
        if (!r.queueId || r.warning || !r.locked || !r.indicative) continue;
        if (!grouped.has(r.queueId)) grouped.set(r.queueId, []);
        grouped.get(r.queueId).push(r);
      }

      // Compute summary KPIs across all queues
      let totalLockedFTE = 0;
      let totalIndicativeFTE = 0;
      let totalQueues = grouped.size;
      let totalChannels = 0;
      for (const [, rows] of grouped) {
        for (const r of rows) {
          totalChannels++;
          const inputs = getInputs(r.queueId, r.channelKey);
          if (r.locked.yhat.length > 0) {
            // Average FTE across the locked window
            const avgVol = r.locked.yhat.reduce((s, v) => s + v, 0) / r.locked.yhat.length;
            totalLockedFTE += computeFTE(r.channelKey, avgVol, inputs);
          }
          if (r.indicative.yhat.length > 0) {
            const avgVol = r.indicative.yhat.reduce((s, v) => s + v, 0) / r.indicative.yhat.length;
            totalIndicativeFTE += computeFTE(r.channelKey, avgVol, inputs);
          }
        }
      }

      UI.html(root, `
        <div class="page">
          <div class="page-head">
            <div>
              <h1>Capacity Planning</h1>
              <div class="sub">Translated from the latest forecast · ${grouped.size} queue${grouped.size!==1?'s':''} · ${totalChannels} channel series · locked window ${studioNow.lockedWeeks || 13} weeks</div>
            </div>
            <div class="actions">
              <button class="btn ghost" onclick="location.hash='#data-studio'">${WFM.Icons.refresh} Re-run forecast</button>
            </div>
          </div>

          <div class="grid cols-4" style="margin-top: var(--space-4)">
            ${UI.kpiHTML({ label: 'Queues in plan', value: totalQueues.toString(), accent: true })}
            ${UI.kpiHTML({ label: 'Channel series', value: totalChannels.toString() })}
            ${UI.kpiHTML({ label: 'Locked FTE (avg)', value: Math.round(totalLockedFTE).toString(), delta: 'intended for scheduling', deltaDir: 'flat' })}
            ${UI.kpiHTML({ label: 'Indicative FTE (avg)', value: Math.round(totalIndicativeFTE).toString(), delta: 'directional · hiring plan', deltaDir: 'flat' })}
          </div>

          ${WFM.UI.insight ? WFM.UI.insight(
            'How this works',
            'Each forecast row becomes an FTE requirement via Erlang-C (voice) or concurrent-handle math (chat / email / web). Inputs default to industry norms per channel; click any queue card to override AHT, shrinkage, occupancy, or SLA for that specific queue. Locked-window FTE is what you should schedule against. Indicative FTE is for hiring plans — re-run the forecast monthly and the numbers will sharpen.',
            ''
          ) : ''}

          <div id="queueCards" style="margin-top: var(--space-4)"></div>
        </div>
      `);

      const cards = UI.$('#queueCards', root);
      cards.innerHTML = '';
      for (const [queueId, rows] of grouped) {
        const q = queueLookup.get(queueId);
        if (!q) continue;
        const card = document.createElement('div');
        card.style.marginBottom = 'var(--space-3)';
        cards.appendChild(card);
        renderQueueCard(card, q, rows);
      }
    }

    function renderQueueCard(host, queue, channelRows) {
      // Build week-by-week tables: rows = channels, columns = weeks
      const lockedWeeks = channelRows[0]?.locked?.yhat?.length || 0;
      const indicativeWeeks = channelRows[0]?.indicative?.yhat?.length || 0;
      const totalWeeks = lockedWeeks + indicativeWeeks;

      // Per-channel FTE arrays
      const perChannel = channelRows.map(r => {
        const inputs = getInputs(r.queueId, r.channelKey);
        const lockedFTE = r.locked.yhat.map(v => computeFTE(r.channelKey, v, inputs));
        const indicativeFTE = r.indicative.yhat.map(v => computeFTE(r.channelKey, v, inputs));
        return { row: r, inputs, lockedFTE, indicativeFTE };
      });

      // Queue-level rollup: sum across channels per week
      const queueLocked = new Array(lockedWeeks).fill(0);
      const queueIndicative = new Array(indicativeWeeks).fill(0);
      for (const pc of perChannel) {
        for (let i = 0; i < lockedWeeks; i++)        queueLocked[i]     += pc.lockedFTE[i] || 0;
        for (let i = 0; i < indicativeWeeks; i++)    queueIndicative[i] += pc.indicativeFTE[i] || 0;
      }

      // Peak / average for KPI strip
      const allLocked = queueLocked.concat(queueIndicative);
      const peakFTE = Math.max(...allLocked, 0);
      const avgLockedFTE = queueLocked.length ? queueLocked.reduce((s,v)=>s+v,0) / queueLocked.length : 0;
      const avgIndicativeFTE = queueIndicative.length ? queueIndicative.reduce((s,v)=>s+v,0) / queueIndicative.length : 0;

      // Channel mix at peak (which channels drive the load)
      const channelMixAtPeak = perChannel.map(pc => {
        const peakIdx = queueLocked.indexOf(peakFTE);
        const peakChannelFTE = peakIdx >= 0 ? pc.lockedFTE[peakIdx] : 0;
        return { channel: pc.row.channelKey, fte: peakChannelFTE };
      });

      // Product badge (if queue is in a product)
      const product = queue.productId && WFM.Products ? WFM.Products.get(queue.productId) : null;

      host.innerHTML = `
        <div class="card" data-qid="${queue.id}">
          <div class="card-head" style="cursor: pointer" data-toggle="${queue.id}">
            <div style="flex: 1">
              ${product ? `
                <div style="margin-bottom: 4px">
                  <span class="badge" style="background: ${product.color}20; color: ${product.color}; font-size: 10px; font-weight: 600">${escapeHTML(product.name).toUpperCase()}</span>
                </div>
              ` : ''}
              <h3 style="margin: 0">${escapeHTML(queue.name)}</h3>
              <div class="sub" style="margin-top: 2px">
                ${queue.channels.map(ch => `<span class="badge ${channelBadge(ch)}" style="font-size: 10px; margin-right: 4px"><span class="dot"></span>${channelLabel(ch)}</span>`).join('')}
                ${queue.regions && queue.regions.length ? `· ${queue.regions.join(', ')}` : ''}
              </div>
            </div>
            <div class="actions" style="gap: 12px; font-size: 12px">
              <span><span class="muted">Locked avg:</span> <b>${Math.round(avgLockedFTE)} FTE</b></span>
              <span><span class="muted">Indicative avg:</span> <b>${Math.round(avgIndicativeFTE)} FTE</b></span>
              <span><span class="muted">Peak:</span> <b>${Math.round(peakFTE)} FTE</b></span>
              <span style="color: var(--fg-3); margin-left: 8px" id="chev-${queue.id}">▾</span>
            </div>
          </div>
          <div class="card-body" id="body-${queue.id}" style="padding-top: 0">
            ${renderQueueBody(queue, perChannel, queueLocked, queueIndicative, lockedWeeks, indicativeWeeks)}
          </div>
        </div>
      `;

      // Wire collapse + inline edits + week-table
      host.querySelector(`[data-toggle="${queue.id}"]`).addEventListener('click', () => {
        const body = host.querySelector(`#body-${queue.id}`);
        const chev = host.querySelector(`#chev-${queue.id}`);
        if (body.style.display === 'none') {
          body.style.display = '';
          chev.style.transform = 'rotate(0)';
        } else {
          body.style.display = 'none';
          chev.style.transform = 'rotate(-90deg)';
        }
      });

      // Inline-edit handlers (AHT, shrinkage, etc.)
      host.querySelectorAll('.cap-input').forEach(inp => {
        inp.addEventListener('blur', () => {
          const queueId = inp.dataset.qid;
          const ch = inp.dataset.ch;
          const field = inp.dataset.field;
          let val = inp.value.trim();
          if (val === '' || !isFinite(+val)) {
            inp.value = getInputs(queueId, ch)[field];
            return;
          }
          const numVal = +val;
          const inputs = getInputs(queueId, ch);
          // Sanity bounds
          if (field === 'shrinkage' || field === 'occupancyTarget' || field === 'slTarget') {
            if (numVal < 0 || numVal > 1) { inp.value = inputs[field]; return; }
          }
          inputs[field] = numVal;
          const s2 = WFM.State.get().studio;
          WFM.State.set({ studio: s2 });
          render();   // Re-render to recompute FTE
        });
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); });
      });
    }

    function renderQueueBody(queue, perChannel, queueLocked, queueIndicative, lockedWeeks, indicativeWeeks) {
      const totalWeeks = lockedWeeks + indicativeWeeks;
      const cellWidth = totalWeeks > 26 ? 50 : 60;

      return `
        <!-- Per-channel inputs strip -->
        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; margin-bottom: var(--space-4)">
          ${perChannel.map(pc => {
            const isVoice = pc.row.channelKey === 'voice';
            return `
              <div style="padding: 12px; background: var(--bg-1); border-radius: var(--r-2); border-left: 3px solid var(--accent)">
                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px">
                  <span class="badge ${channelBadge(pc.row.channelKey)}" style="font-size: 10px"><span class="dot"></span>${channelLabel(pc.row.channelKey)}</span>
                  <span class="muted t-small">staffing inputs</span>
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; font-size: 12px">
                  <div>
                    <div class="muted t-micro">AHT (sec)</div>
                    <input class="inline-edit cap-input" data-qid="${queue.id}" data-ch="${pc.row.channelKey}" data-field="aht" value="${pc.inputs.aht}" style="font-family: var(--font-mono); width: 100%">
                  </div>
                  ${isVoice ? `
                    <div>
                      <div class="muted t-micro">SLA target</div>
                      <input class="inline-edit cap-input" data-qid="${queue.id}" data-ch="${pc.row.channelKey}" data-field="slTarget" value="${pc.inputs.slTarget}" style="font-family: var(--font-mono); width: 100%">
                    </div>
                  ` : `
                    <div>
                      <div class="muted t-micro">Concurrency</div>
                      <input class="inline-edit cap-input" data-qid="${queue.id}" data-ch="${pc.row.channelKey}" data-field="concurrency" value="${pc.inputs.concurrency}" style="font-family: var(--font-mono); width: 100%">
                    </div>
                  `}
                  <div>
                    <div class="muted t-micro">Shrinkage</div>
                    <input class="inline-edit cap-input" data-qid="${queue.id}" data-ch="${pc.row.channelKey}" data-field="shrinkage" value="${pc.inputs.shrinkage}" style="font-family: var(--font-mono); width: 100%">
                  </div>
                  <div>
                    <div class="muted t-micro">Occupancy</div>
                    <input class="inline-edit cap-input" data-qid="${queue.id}" data-ch="${pc.row.channelKey}" data-field="occupancyTarget" value="${pc.inputs.occupancyTarget}" style="font-family: var(--font-mono); width: 100%">
                  </div>
                </div>
              </div>
            `;
          }).join('')}
        </div>

        <!-- Week-by-week table with channel bifurcation -->
        <div style="overflow-x: auto">
          <table class="tbl" style="font-size: 11px; min-width: 100%">
            <thead>
              <tr style="background: var(--bg-1)">
                <th style="text-align: left; position: sticky; left: 0; background: var(--bg-1); min-width: 160px; z-index: 2">Channel / Total</th>
                ${Array.from({length: lockedWeeks}, (_, i) => `<th class="num" style="min-width: ${cellWidth}px; background: var(--ok-bg); color: var(--ok)"  title="Locked — schedule against this">L${i+1}</th>`).join('')}
                ${indicativeWeeks > 0 ? `<th style="background: var(--warn-bg); padding: 0; min-width: 2px"></th>` : ''}
                ${Array.from({length: indicativeWeeks}, (_, i) => `<th class="num" style="min-width: ${cellWidth}px; background: var(--warn-bg); color: var(--warn)" title="Indicative — directional only">I${i+1}</th>`).join('')}
              </tr>
              <tr style="background: var(--bg-1); border-bottom: 2px solid var(--border)">
                <th style="text-align: left; position: sticky; left: 0; background: var(--bg-1); font-weight: 400; font-size: 10px; color: var(--fg-2); z-index: 2">Required FTE</th>
                ${Array.from({length: lockedWeeks + (indicativeWeeks > 0 ? 1 : 0) + indicativeWeeks}, (_, i) => '<th></th>').join('')}
              </tr>
            </thead>
            <tbody>
              <!-- Per-channel FTE rows -->
              ${perChannel.map(pc => `
                <tr>
                  <td style="position: sticky; left: 0; background: var(--bg-2); z-index: 1">
                    <span class="badge ${channelBadge(pc.row.channelKey)}" style="font-size: 10px"><span class="dot"></span>${channelLabel(pc.row.channelKey)}</span>
                  </td>
                  ${pc.lockedFTE.map(f => `<td class="num" style="font-family: var(--font-mono)">${Math.round(f)}</td>`).join('')}
                  ${indicativeWeeks > 0 ? `<td style="background: var(--warn-bg); padding: 0"></td>` : ''}
                  ${pc.indicativeFTE.map(f => `<td class="num muted" style="font-family: var(--font-mono)">${Math.round(f)}</td>`).join('')}
                </tr>
              `).join('')}

              <!-- Queue-level total -->
              <tr style="background: var(--bg-1); border-top: 2px solid var(--border)">
                <td style="position: sticky; left: 0; background: var(--bg-1); font-weight: 600; z-index: 1">Queue total</td>
                ${queueLocked.map(f => `<td class="num" style="font-family: var(--font-mono); font-weight: 600">${Math.round(f)}</td>`).join('')}
                ${indicativeWeeks > 0 ? `<td style="background: var(--warn-bg); padding: 0"></td>` : ''}
                ${queueIndicative.map(f => `<td class="num" style="font-family: var(--font-mono); font-weight: 600; color: var(--warn)">${Math.round(f)}</td>`).join('')}
              </tr>

              <!-- Forecast volume row (for context) -->
              <tr style="background: var(--bg-1)">
                <td style="position: sticky; left: 0; background: var(--bg-1); font-size: 10px; color: var(--fg-2); z-index: 1">Forecast volume (sum)</td>
                ${Array.from({length: lockedWeeks}, (_, i) => {
                  const totalVol = perChannel.reduce((s, pc) => s + (pc.row.locked.yhat[i] || 0), 0);
                  return `<td class="num muted" style="font-family: var(--font-mono); font-size: 10px">${Math.round(totalVol).toLocaleString()}</td>`;
                }).join('')}
                ${indicativeWeeks > 0 ? `<td style="background: var(--warn-bg); padding: 0"></td>` : ''}
                ${Array.from({length: indicativeWeeks}, (_, i) => {
                  const totalVol = perChannel.reduce((s, pc) => s + (pc.row.indicative.yhat[i] || 0), 0);
                  return `<td class="num muted" style="font-family: var(--font-mono); font-size: 10px">${Math.round(totalVol).toLocaleString()}</td>`;
                }).join('')}
              </tr>
            </tbody>
          </table>
        </div>

        <div class="muted t-small" style="margin-top: var(--space-3); display: flex; gap: 24px; flex-wrap: wrap">
          <span><span style="display: inline-block; width: 12px; height: 12px; background: var(--ok-bg); border-radius: 2px; vertical-align: middle"></span> <b>Locked</b> · ${lockedWeeks} weeks · schedule against this</span>
          <span><span style="display: inline-block; width: 12px; height: 12px; background: var(--warn-bg); border-radius: 2px; vertical-align: middle"></span> <b>Indicative</b> · ${indicativeWeeks} weeks · directional, re-run as actuals come in</span>
        </div>
      `;
    }
  };

  /* ====================================================
   * FTE computation — channel-aware
   *
   * Voice: Erlang-C with SLA target. Volume is weekly → convert to per-second
   *        arrival rate.
   * Chat / Email / Web: concurrent-handle math with occupancy guard.
   *
   * The result is the queue-level "Net FTE" — i.e., bodies needed on the floor
   * before shrinkage. We then divide by (1 − shrinkage) for the Gross FTE,
   * which is what hiring plans key off.
   * ==================================================== */
  function computeFTE(channel, weeklyVolume, inputs) {
    if (weeklyVolume <= 0) return 0;
    const ahtSec = inputs.aht || 300;
    const shrinkage = Math.min(0.6, Math.max(0, inputs.shrinkage || 0.30));
    const occupancy = Math.min(0.95, Math.max(0.5, inputs.occupancyTarget || 0.85));

    if (channel === 'voice' && WFM.Capacity?.requiredAgents) {
      // Convert weekly volume to per-hour arrival rate. Assume 5 working days × 8 hours = 40 hr/week.
      const hourlyArrival = weeklyVolume / 40;
      try {
        const req = WFM.Capacity.requiredAgents(channel, hourlyArrival, ahtSec, {
          targetSL: inputs.slTarget || 0.80,
          targetSec: inputs.slSec || 20,
          concurrency: 1
        });
        return req / (1 - shrinkage);
      } catch (_) {
        // Fall through to generic math
      }
    }
    // Generic concurrent-handle math (chat / email / web / voice fallback)
    const concurrency = inputs.concurrency || 1;
    // Workload in agent-seconds per week
    const workSec = weeklyVolume * (ahtSec / concurrency);
    // Capacity per agent per week = 40h × 3600s × occupancy
    const capacityPerAgent = 40 * 3600 * occupancy;
    const netFTE = workSec / capacityPerAgent;
    return netFTE / (1 - shrinkage);
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

  WFM.Modules = WFM.Modules || {};
  WFM.Modules.capacity = M;
})(window.WFM = window.WFM || {});
