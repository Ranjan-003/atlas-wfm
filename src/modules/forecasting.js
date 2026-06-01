/* =========================================================
 * Module: Forecasting Workbench
 * ========================================================= */
(function (WFM) {
  'use strict';
  const M = {};

  M.mount = function (root, state) {
    const queues = WFM.State.currentQueues();
    let activeQid = state.queueId && queues.find(q => q.id === state.queueId) ? state.queueId : queues[0]?.id;
    if (!activeQid) {
      root.innerHTML = `
        <div class="page">
          <div class="page-head">
            <div><h1>Forecasting</h1><div class="sub">Demand prediction with automatic model selection</div></div>
          </div>
          <div class="card" style="margin-top: var(--space-4)">
            <div class="card-body" style="padding: 60px; text-align: center">
              <div style="font-size: 32px; color: var(--fg-3); margin-bottom: var(--space-3)">${WFM.Icons.spark}</div>
              <h3 style="margin: 0 0 8px">No queues yet</h3>
              <p class="muted" style="max-width: 480px; margin: 0 auto var(--space-4)">
                Create queues in the Forecast Workbench, enter actual volumes, then forecasts will appear here.
              </p>
              <button class="btn primary" onclick="location.hash='#data-studio'">${WFM.Icons.arrow_right} Open Forecast Workbench</button>
            </div>
          </div>
        </div>
      `;
      return;
    }

    const F = WFM.Forecasting, Charts = WFM.Charts, UI = WFM.UI;
    let activeModel = null; // 'auto' or specific

    render();

    function render() {
      const q = queues.find(qq => qq.id === activeQid);
      const vols = q.history.map(h => h.volume);
      const dates = q.history.map(h => h.date);
      const fc = F.forecast(vols, { period: 7, horizon: 14, forceModel: activeModel || undefined });

      // Recent 30 days of actuals + 14 forecast
      const showActuals = 30;
      const actualWindow = vols.slice(-showActuals);
      const dateWindow = dates.slice(-showActuals);
      const forecastSeries = new Array(showActuals).fill(null).concat(fc.yhat);
      const actualSeries = actualWindow.concat(new Array(14).fill(null));
      const ciLo = new Array(showActuals).fill(null).concat(fc.lo);
      const ciHi = new Array(showActuals).fill(null).concat(fc.hi);
      const labels = [...dateWindow, ...Array.from({length:14}, (_,i)=>{
        const d = new Date(dateWindow[dateWindow.length-1]); d.setDate(d.getDate()+i+1); return d.toISOString().slice(5,10);
      })].map((d,i) => i % 4 === 0 ? d.slice(5) : '');

      // Anomalies — adjust index relative to the window
      const offset = vols.length - showActuals;
      const anomalies = fc.anomalies.filter(a => a.index >= offset).map(a => ({ index: a.index - offset, value: a.value, z: a.z }));

      const chartHTML = Charts.line({
        series: [
          { name: 'Actual',   data: actualSeries,   color: 'var(--c-cyan)',  showDots: false },
          { name: 'Forecast', data: forecastSeries, color: 'var(--accent)',  showDots: false, dashed: true }
        ],
        categories: labels,
        ciLo: ciLo.map(v => v == null ? null : Math.round(v)),
        ciHi: ciHi.map(v => v == null ? null : Math.round(v)),
        anomalies,
        height: 260,
        width: 900
      });

      // Models table
      const scoreEntries = Object.entries(fc.scores).sort((a,b)=>a[1]-b[1]);
      const modelsTable = `
        <table class="tbl">
          <thead><tr><th>Model</th><th class="num">WAPE</th><th class="num">Accuracy</th><th>Best for</th><th></th></tr></thead>
          <tbody>
            ${scoreEntries.map(([m, w], i) => `
              <tr class="${m === fc.model ? 'selected' : ''}">
                <td><b>${modelLabel(m)}</b></td>
                <td class="num">${(w*100).toFixed(2)}%</td>
                <td class="num">${((1-w)*100).toFixed(1)}%</td>
                <td class="muted">${modelBest(m)}</td>
                <td>${i === 0 ? UI.badge('Auto-selected', 'accent') : ''}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;

      // Queue selector
      const selector = `
        <select class="select" id="qsel">
          ${queues.map(qq => `<option value="${qq.id}" ${qq.id === activeQid ? 'selected' : ''}>${qq.name} [${qq.id}]</option>`).join('')}
        </select>`;

      // Model picker
      const modelPicker = ['auto','holt_winters','moving_average','naive_seasonal','croston','ensemble'].map(m =>
        `<button class="btn ${(activeModel === m || (!activeModel && m === 'auto')) ? 'active' : ''}" data-model="${m}">${m === 'auto' ? 'Auto' : modelLabel(m)}</button>`
      ).join('');

      // Insight — Phase 2: surface explanation array and confidence breakdown
      const explanationList = (fc.explanation || []).map(e => `<li>${e}</li>`).join('');
      const confLevel = fc.confidence?.level || 'Medium';
      const confColor = confLevel === 'High' ? 'ok' : confLevel === 'Medium' ? 'warn' : 'danger';
      const driversText = (fc.confidence?.drivers || []).join(' · ');

      const insightHTML = fc.warning
        ? UI.insight(
            `⚠ ${fc.warning}`,
            `This queue does not have enough history to produce a reliable forecast. The engine refuses to guess — please ingest more data and retry.`,
            ''
          )
        : UI.insight(
            `Auto-selected ${modelLabel(fc.model)} · ${confLevel} confidence`,
            `<ul style="margin:8px 0 0;padding-left:18px;line-height:1.7">${explanationList}</ul>`,
            `Confidence drivers: ${driversText}`
          );

      // KPIs
      const kpiBlock = `
        <div class="grid cols-4">
          ${UI.kpiHTML({ label: 'Forecast Accuracy', value: ((1-fc.scores[fc.model])*100).toFixed(1), unit: '%', delta: '1 - WAPE', deltaDir: 'flat', accent: true })}
          ${UI.kpiHTML({ label: 'Selected Model', value: modelLabel(fc.model), delta: 'walk-fwd validated', deltaDir: 'flat' })}
          ${UI.kpiHTML({ label: 'Anomalies (history)', value: fc.anomalies.length.toString(), delta: '> 3.5σ MAD', deltaDir: fc.anomalies.length > 5 ? 'down' : 'flat' })}
          ${UI.kpiHTML({ label: 'Avg Forecast Daily Vol', value: Math.round(fc.yhat.reduce((s,v)=>s+v,0)/fc.yhat.length).toLocaleString(), delta: 'next 14 days', deltaDir: 'flat' })}
        </div>
      `;

      UI.html(root, `
        <div class="page">
          <div class="page-head">
            <div>
              <h1>Forecasting</h1>
              <div class="sub">Demand prediction · viewing seeded demo data — to build your own queues use <a href="#data-studio" style="color:var(--accent);text-decoration:none">Forecast Workbench →</a></div>
            </div>
            <div class="actions">
              ${selector}
              <button class="btn primary" id="openWorkbench">${WFM.Icons.spark} Forecast Workbench</button>
              <button class="btn">${WFM.Icons.download} Export</button>
            </div>
          </div>

          ${kpiBlock}

          <div style="margin-top:var(--space-4)">${insightHTML}</div>

          <div style="margin-top:var(--space-4)">
            ${UI.card(
              `<div><h3>Actual vs Forecast — ${q.name}</h3><div class="sub">Last 30 days actuals + 14-day forecast with p5/p95 confidence band</div></div>
               <div class="actions">
                 <div class="btn-group" id="mdlpick">${modelPicker}</div>
               </div>`,
              `<div class="chart" style="height:280px">${chartHTML}</div>
               <div class="row" style="gap:16px;font-size:11px;color:var(--fg-2);justify-content:flex-end;margin-top:8px">
                 <span><span style="display:inline-block;width:10px;height:2px;background:var(--c-cyan);vertical-align:middle"></span> Actual</span>
                 <span><span style="display:inline-block;width:10px;height:2px;background:var(--accent);vertical-align:middle"></span> Forecast</span>
                 <span><span style="display:inline-block;width:10px;height:10px;background:var(--accent);opacity:0.15;vertical-align:middle"></span> 90% CI</span>
                 <span><span style="display:inline-block;width:8px;height:8px;background:var(--danger);border-radius:50%;vertical-align:middle"></span> Anomaly</span>
               </div>`
            )}
          </div>

          <div class="grid cols-2" style="margin-top:var(--space-4); grid-template-columns: 1fr 1fr;">
            ${UI.card(
              `<div><h3>Model Comparison</h3><div class="sub">WAPE on validation window — lower is better</div></div>`,
              modelsTable,
              { flush: true }
            )}
            ${UI.card(
              `<div><h3>Forecast Detail (next 14 days)</h3></div>`,
              `<table class="tbl">
                 <thead><tr><th>Day</th><th class="num">Forecast</th><th class="num">Low (p5)</th><th class="num">High (p95)</th></tr></thead>
                 <tbody>
                   ${fc.yhat.map((v,i) => {
                     const d = new Date(); d.setDate(d.getDate()+i+1);
                     return `<tr><td>${d.toISOString().slice(5,10)}</td><td class="num">${Math.round(v).toLocaleString()}</td><td class="num muted">${Math.round(fc.lo[i]).toLocaleString()}</td><td class="num muted">${Math.round(fc.hi[i]).toLocaleString()}</td></tr>`;
                   }).join('')}
                 </tbody>
               </table>`,
              { flush: true }
            )}
          </div>
        </div>
      `);

      // Wire interactions
      UI.$('#openWorkbench', root)?.addEventListener('click', () => { location.hash = '#data-studio'; });
      UI.$('#qsel', root).addEventListener('change', e => {
        activeQid = e.target.value;
        WFM.State.set({ queueId: activeQid });
        render();
      });
      UI.$$('#mdlpick .btn', root).forEach(b => {
        b.addEventListener('click', () => {
          const m = b.dataset.model;
          activeModel = m === 'auto' ? null : m;
          render();
        });
      });
    }

    function modelLabel(m) {
      return ({
        moving_average: 'Moving Avg',
        naive_seasonal: 'Naive Seasonal',
        holt_winters:   'Holt-Winters',
        croston:        'Croston',
        ensemble:       'Ensemble'
      })[m] || m;
    }
    function modelBest(m) {
      return ({
        moving_average: 'Stable demand, no trend',
        naive_seasonal: 'Strong weekly cycle',
        holt_winters:   'Trend + seasonality',
        croston:        'Intermittent / sparse',
        ensemble:       'Mixed signal, lower variance'
      })[m] || '—';
    }
  };

  WFM.Modules = WFM.Modules || {};
  WFM.Modules.forecasting = M;
})(window.WFM = window.WFM || {});
