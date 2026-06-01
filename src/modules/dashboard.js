/* =========================================================
 * Module: Executive Dashboard
 * ========================================================= */
(function (WFM) {
  'use strict';
  const M = {};

  M.mount = function (root, state) {
    const queues = WFM.State.currentQueues();
    if (queues.length === 0) {
      root.innerHTML = `
        <div class="page">
          <div class="page-head"><div><h1>Operations Command</h1><div class="sub">Real-time view across your queues</div></div></div>
          <div class="card" style="margin-top: var(--space-4)">
            <div class="card-body" style="padding: 60px; text-align: center">
              <div style="font-size: 32px; color: var(--fg-3); margin-bottom: var(--space-3)">${WFM.Icons.spark}</div>
              <h3 style="margin: 0 0 8px">No queues yet</h3>
              <p class="muted" style="max-width: 480px; margin: 0 auto var(--space-4)">Create your first queue in the Forecast Workbench and enter or import volume data. KPIs, queue health, and AI insights will appear here once you have data flowing.</p>
              <button class="btn primary" onclick="location.hash='#data-studio'">${WFM.Icons.arrow_right} Open Forecast Workbench</button>
            </div>
          </div>
        </div>
      `;
      return;
    }
    const Charts = WFM.Charts, UI = WFM.UI;

    // ---------- Aggregates ----------
    const totalHC = queues.reduce((s,q)=>s+q.headcount,0);
    const slLast7 = queues.map(q => q.history.slice(-7).reduce((s,h)=>s+h.sla,0)/7);
    const slPrev7 = queues.map(q => q.history.slice(-14,-7).reduce((s,h)=>s+h.sla,0)/7);
    const avgSL = slLast7.reduce((s,v)=>s+v,0)/slLast7.length;
    const avgSLPrev = slPrev7.reduce((s,v)=>s+v,0)/slPrev7.length;
    const slDelta = avgSL - avgSLPrev;

    const totalVol = queues.reduce((s,q)=> s + q.history.slice(-7).reduce((a,h)=>a+h.volume,0)/7, 0);
    const prevVol  = queues.reduce((s,q)=> s + q.history.slice(-14,-7).reduce((a,h)=>a+h.volume,0)/7, 0);
    const volDelta = (totalVol - prevVol) / prevVol;

    const accuracies = queues.map(q => q.forecastAccuracy || 0);
    const avgAcc = accuracies.reduce((s,v)=>s+v,0)/accuracies.length;

    const understaffed = queues.filter(q => q.history.slice(-7).reduce((s,h)=>s+h.sla,0)/7 < q.slTarget - 0.05).length;
    const overstaffed = queues.filter(q => q.history.slice(-7).reduce((s,h)=>s+h.sla,0)/7 > q.slTarget + 0.10).length;

    const totalCost = WFM.Capacity.cost(totalHC);

    // SL trend sparkline (avg daily SL over 30 days)
    const trend30 = Array.from({length:30}, (_, i) => {
      const dayIdx = 84 - 30 + i;
      const dayAvg = queues.reduce((s,q)=> s + (q.history[dayIdx]?.sla || 0), 0) / queues.length;
      return dayAvg;
    });

    // Volume sparkline
    const volTrend = Array.from({length:30}, (_, i) => {
      const dayIdx = 84 - 30 + i;
      return queues.reduce((s,q)=> s + (q.history[dayIdx]?.volume || 0), 0);
    });

    // ---------- KPI row ----------
    const kpiHTML = `
      <div class="grid cols-5">
        ${UI.kpiHTML({
          label: 'Service Level (7d)',
          value: (avgSL*100).toFixed(1),
          unit: '%',
          delta: `${(slDelta*100).toFixed(1)} pts`,
          deltaDir: slDelta > 0.005 ? 'up' : slDelta < -0.005 ? 'down' : 'flat',
          accent: true,
          sparkline: Charts.sparkline(trend30, { color: avgSL >= 0.80 ? 'var(--ok)' : 'var(--warn)' }),
          sparkColor: avgSL >= 0.80 ? 'var(--ok)' : 'var(--warn)'
        })}
        ${UI.kpiHTML({
          label: 'Forecast Accuracy',
          value: (avgAcc*100).toFixed(1),
          unit: '%',
          delta: '1 - WAPE',
          deltaDir: 'flat',
          sparkline: Charts.sparkline(accuracies.slice().sort(), { color: 'var(--c-cyan)' }),
          sparkColor: 'var(--c-cyan)'
        })}
        ${UI.kpiHTML({
          label: 'Active Headcount',
          value: totalHC.toLocaleString(),
          delta: `${queues.length} queues`,
          deltaDir: 'flat',
          sparkline: Charts.sparkline(queues.map(q=>q.headcount), { color: 'var(--c-blue)' }),
          sparkColor: 'var(--c-blue)'
        })}
        ${UI.kpiHTML({
          label: 'Contact Volume (7d/day)',
          value: Math.round(totalVol).toLocaleString(),
          delta: `${volDelta >= 0 ? '+' : ''}${(volDelta*100).toFixed(1)}% vs prev wk`,
          deltaDir: volDelta > 0.02 ? 'up' : volDelta < -0.02 ? 'down' : 'flat',
          sparkline: Charts.sparkline(volTrend, { color: 'var(--c-violet)' }),
          sparkColor: 'var(--c-violet)'
        })}
        ${UI.kpiHTML({
          label: 'Loaded Payroll',
          value: '$' + (totalCost/1e6).toFixed(1),
          unit: 'M/yr',
          delta: `$${Math.round(totalCost/totalHC/1000)}k / FTE`,
          deltaDir: 'flat'
        })}
      </div>
    `;

    // ---------- AI insights ----------
    const insights = [];
    if (understaffed > 0) {
      const top = queues.filter(q => q.history.slice(-7).reduce((s,h)=>s+h.sla,0)/7 < q.slTarget - 0.05)
        .sort((a,b)=> (a.history.slice(-7).reduce((s,h)=>s+h.sla,0)/7 - a.slTarget) - (b.history.slice(-7).reduce((s,h)=>s+h.sla,0)/7 - b.slTarget))[0];
      const gap = (top.slTarget - top.history.slice(-7).reduce((s,h)=>s+h.sla,0)/7) * 100;
      insights.push(UI.insight(
        `${understaffed} queue${understaffed>1?'s':''} understaffed — ${top.name} most at risk`,
        `${top.name} averaging ${gap.toFixed(1)} points below ${(top.slTarget*100)|0}% SL target over the last 7 days. Required staffing recalc suggests adding 3-5 FTE or invoking OT for the rest of the week.`,
        `Driver: 7-day SL trending down · Volume +${(volDelta*100).toFixed(1)}% vs prior week`
      ));
    }
    if (overstaffed > 1) {
      insights.push(UI.insight(
        `${overstaffed} queues running >10pts above SL target`,
        `These queues are candidates for VTO offers, agent reallocation to understaffed skills, or cross-training initiatives. Estimated efficiency unlock: 4-7% on weekly payroll.`,
        `Method: 7-day SL vs target threshold +10pts`
      ));
    }
    const anomalousQueues = queues.filter(q => q.anomalyCount > 2);
    if (anomalousQueues.length) {
      insights.push(UI.insight(
        `Anomalies detected in ${anomalousQueues.length} queues`,
        `Recent volume readings outside 3.5σ MAD window. Most volatile: ${anomalousQueues.slice(0,3).map(q=>q.name).join(', ')}. Worth investigating event drivers before next forecast run.`,
        `Method: Rolling 14d median ± 3.5×MAD`
      ));
    }

    // ---------- Queue health heatmap ----------
    // Last 14 days × top 12 queues by volume; cell = SL%
    const topQueues = [...queues].sort((a,b) => b.history[83].volume - a.history[83].volume).slice(0,12);
    const heatMatrix = topQueues.map(q => q.history.slice(-14).map(h => h.sla));
    const heatLabels = topQueues.map(q => q.name.length > 18 ? q.name.slice(0,17)+'…' : q.name);
    const dayLabels = topQueues[0].history.slice(-14).map(h => {
      const d = new Date(h.date);
      return `${d.getMonth()+1}/${d.getDate()}`;
    });
    const heatHTML = Charts.heatmap(heatMatrix, {
      rowLabels: heatLabels,
      colLabels: dayLabels,
      cellW: 28,
      cellH: 18,
      palette: ['var(--heat-0)', 'var(--heat-1)', 'var(--heat-2)', 'var(--heat-3)', 'var(--heat-4)', 'var(--heat-5)'],
      min: 0.40,
      max: 1.00
    });

    // ---------- SL trend chart ----------
    const slTrendChart = Charts.line({
      series: [{
        name: 'Avg SL',
        data: trend30.map(v => v*100),
        color: 'var(--accent)',
        showDots: false
      }, {
        name: 'Target',
        data: trend30.map(_ => 80),
        color: 'var(--fg-3)',
        dashed: true,
        showDots: false
      }],
      categories: trend30.map((_,i) => i % 5 === 0 ? `D-${30-i}` : ''),
      height: 200,
      startAtZero: false
    });

    // ---------- Top alerts (sorted by risk) ----------
    const alerts = queues.map(q => {
      const last7 = q.history.slice(-7);
      const sl = last7.reduce((s,h)=>s+h.sla,0)/7;
      const gap = q.slTarget - sl;
      return { q, gap, sl };
    }).filter(a => a.gap > 0).sort((a,b) => b.gap - a.gap).slice(0, 6);

    const alertsHTML = alerts.length ? `
      <table class="tbl">
        <thead><tr><th>Queue</th><th>Channel</th><th class="num">SL (7d)</th><th class="num">Target</th><th class="num">Gap</th><th></th></tr></thead>
        <tbody>
          ${alerts.map(({q, gap, sl}) => `
            <tr style="cursor:pointer" data-qid="${q.id}">
              <td><b>${q.name}</b><div class="muted t-small">${q.id} · ${q.tenant}</div></td>
              <td>${UI.badge(q.channel, q.channel === 'voice' ? 'info' : q.channel === 'chat' ? 'accent' : '')}</td>
              <td class="num">${(sl*100).toFixed(1)}%</td>
              <td class="num">${(q.slTarget*100).toFixed(0)}%</td>
              <td class="num"><span class="s-danger">-${(gap*100).toFixed(1)} pts</span></td>
              <td>${UI.bar(sl/q.slTarget, { thresholds: [0.85, 0.95] })}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    ` : `<div class="empty"><h4>All queues within SL targets</h4><p>No queues currently below target SL by more than 5 points.</p></div>`;

    // ---------- Render ----------
    UI.html(root, `
      <div class="page">
        <div class="page-head">
          <div>
            <h1>Operations Command</h1>
            <div class="sub">Real-time view across ${queues.length} queues · ${state.tenant || 'All tenants'}</div>
          </div>
          <div class="actions">
            <button class="btn ghost">${WFM.Icons.refresh} Refresh</button>
            <button class="btn">${WFM.Icons.download} Export</button>
            <button class="btn primary">${WFM.Icons.copilot} Ask Copilot</button>
          </div>
        </div>

        ${kpiHTML}

        ${insights.length ? `<div class="grid cols-${Math.min(insights.length, 3)}" style="margin-top:var(--space-5)">${insights.join('')}</div>` : ''}

        <div class="grid cols-2" style="margin-top:var(--space-5); grid-template-columns: 1.4fr 1fr;">
          ${UI.card(
            `<div><h3>Service Level Trend</h3><div class="sub">Daily avg SL across portfolio · last 30 days</div></div>
             <div class="actions"><span class="badge ${avgSL >= 0.80 ? 'ok' : 'warn'}"><span class="dot"></span>${avgSL >= 0.80 ? 'On target' : 'Below target'}</span></div>`,
            `<div class="chart">${slTrendChart}</div>`
          )}
          ${UI.card(
            `<div><h3>Queue Health Matrix</h3><div class="sub">SL% · top 12 queues · last 14 days</div></div>`,
            `<div style="overflow-x:auto">${heatHTML}</div>
             <div class="row" style="justify-content:flex-end;gap:8px;margin-top:12px;font-size:11px;color:var(--fg-2)">
                <span>Low</span>
                <div style="display:flex;gap:1px">
                  ${['var(--heat-0)','var(--heat-1)','var(--heat-2)','var(--heat-3)','var(--heat-4)','var(--heat-5)'].map(c=>`<div style="width:14px;height:10px;background:${c}"></div>`).join('')}
                </div>
                <span>High</span>
             </div>`
          )}
        </div>

        <div style="margin-top:var(--space-5)">
          ${UI.card(
            `<div><h3>Queues Needing Attention</h3><div class="sub">Sorted by SL gap to target</div></div>
             <div class="actions"><span class="muted t-small">${alerts.length} flagged</span></div>`,
            alertsHTML,
            { flush: true }
          )}
        </div>
      </div>
    `);

    // Wire up alert row clicks to switch to intraday module
    UI.$$('tr[data-qid]', root).forEach(tr => {
      tr.addEventListener('click', () => {
        WFM.State.set({ module: 'intraday', queueId: tr.dataset.qid });
        location.hash = `#intraday/${tr.dataset.qid}`;
      });
    });
  };

  WFM.Modules = WFM.Modules || {};
  WFM.Modules.dashboard = M;
})(window.WFM = window.WFM || {});
