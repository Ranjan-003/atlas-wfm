/* =========================================================
 * Module: Intraday / RTA
 * ========================================================= */
(function (WFM) {
  'use strict';
  const M = {};

  M.mount = function (root, state) {
    const queues = WFM.State.currentQueues();
    let qid = state.queueId && queues.find(q => q.id === state.queueId) ? state.queueId : queues[0]?.id;
    if (!qid) {
      root.innerHTML = `
        <div class="page">
          <div class="page-head"><div><h1>Intraday</h1></div></div>
          <div class="card" style="margin-top: var(--space-4)">
            <div class="card-body" style="padding: 60px; text-align: center">
              <div style="font-size: 32px; color: var(--fg-3); margin-bottom: var(--space-3)">${WFM.Icons.spark}</div>
              <h3 style="margin: 0 0 8px">No queues yet</h3>
              <p class="muted" style="max-width: 480px; margin: 0 auto var(--space-4)">Create queues with volume data in the Forecast Workbench. This page will activate once queues exist.</p>
              <button class="btn primary" onclick="location.hash='#data-studio'">${WFM.Icons.arrow_right} Open Forecast Workbench</button>
            </div>
          </div>
        </div>
      `;
      return;
    }

    const I = WFM.Intraday, C = WFM.Capacity, Charts = WFM.Charts, UI = WFM.UI;
    let nowInterval = state.intradayTick ?? 24; // 12:00 by default
    let tickHandle = null;
    let isLive = false;

    render();

    function render() {
      const q = queues.find(qq => qq.id === qid);
      const todayForecast = q.intervals[q.intervals.length - 1].volumes;
      const todayActuals = I.simulateActuals(todayForecast, nowInterval);

      // Compute requirement curve from forecast
      const reqCurve = todayForecast.map(vol =>
        vol > 0 ? C.requiredAgents(q.channel, vol * 2, q.ahtBase, { targetSL: q.slTarget, concurrency: q.concurrency }) : 0
      );

      // "Current staffing" = roughly required, varying slightly by interval
      const covCurve = reqCurve.map((r,i) => Math.max(0, Math.round(r * (i <= nowInterval ? 0.88 + (i*0.7%0.2) : 1))));

      // Current state for recommender
      const fSum = todayForecast.slice(0, nowInterval+1).reduce((s,v)=>s+v,0);
      const aSum = todayActuals.reduce((s,v)=>s+v,0);
      const variance = I.variance(todayForecast, todayActuals);
      const currentStaff = covCurve[nowInterval] || 0;
      const requiredStaff = reqCurve[nowInterval] || 0;
      // Simulate a plausible SL so far
      const slSoFar = Math.max(0.4, Math.min(0.99, q.slTarget + (currentStaff - requiredStaff) * 0.02 - 0.05));
      const adherence = 0.85 + (Math.sin(nowInterval) * 0.05);

      const intradayState = {
        queueName: q.name,
        actualSL: slSoFar,
        targetSL: q.slTarget,
        completedIntervals: nowInterval + 1,
        totalIntervals: 48,
        forecastVol: fSum,
        actualVol: aSum,
        currentStaff,
        requiredStaff,
        adherence,
        callbackEnabled: q.channel === 'voice'
      };

      const pacing = I.slPacing(intradayState);
      const recommendations = I.recommend(intradayState);

      // Volume chart: actual vs forecast vs upper/lower bound
      const series = [
        { name: 'Forecast', data: todayForecast, color: 'var(--fg-3)', dashed: true, showDots: false },
        { name: 'Actual',   data: todayActuals.concat(new Array(48 - todayActuals.length).fill(null)), color: 'var(--accent)', showDots: false }
      ];
      const volChart = Charts.line({
        series,
        categories: todayForecast.map((_,i) => i % 6 === 0 ? `${String(Math.floor(i/2)).padStart(2,'0')}:${i%2===0?'00':'30'}` : ''),
        height: 220,
        width: 900
      });

      // Agent state donut (simulated)
      const totalAgents = currentStaff;
      const onPhone = Math.round(totalAgents * 0.72);
      const acw = Math.round(totalAgents * 0.10);
      const aux = Math.round(totalAgents * 0.12);
      const ready = totalAgents - onPhone - acw - aux;
      const donutHTML = Charts.donut([
        { label: 'On call',  value: onPhone, color: 'var(--c-cyan)' },
        { label: 'After-call work', value: acw, color: 'var(--c-violet)' },
        { label: 'AUX',     value: aux, color: 'var(--warn)' },
        { label: 'Ready',   value: ready, color: 'var(--fg-3)' }
      ], { width: 160, height: 160, centerText: totalAgents.toString(), centerSub: 'agents' });

      // Coverage strip
      const stripHTML = UI.coverageStrip(covCurve, reqCurve);

      // SL gauge (pacing projected)
      const gaugeHTML = Charts.gauge(pacing.projected || slSoFar, {
        max: 1,
        label: `${((pacing.projected || slSoFar)*100).toFixed(0)}%`,
        color: (pacing.projected || slSoFar) >= q.slTarget ? 'var(--ok)' : 'var(--danger)'
      });

      const recHTML = recommendations.length ? recommendations.map(r => `
        <div class="insight" style="background:${r.priority === 'high' ? 'var(--danger-bg)' : 'var(--accent-bg)'};border-color:${r.priority === 'high' ? 'rgba(248,113,113,0.25)' : 'rgba(243,184,91,0.18)'}">
          <div class="icon" style="background:${r.priority === 'high' ? 'var(--danger)' : 'var(--accent)'}">${WFM.Icons.lightning}</div>
          <div class="body">
            <b>${r.title}</b>
            <p>${r.detail}</p>
            <div class="meta">
              <span class="badge ${r.priority === 'high' ? 'danger' : 'accent'}"><span class="dot"></span>${r.priority.toUpperCase()}</span>
              <span style="margin-left:6px">Impact: ${r.impact.slGain > 0 ? '+' : ''}${(r.impact.slGain*100).toFixed(1)} SL pts${r.impact.costPerHour ? ` · $${Math.round(r.impact.costPerHour)}/hr` : ''}</span>
            </div>
          </div>
          <button class="btn ${r.priority === 'high' ? 'primary' : ''}" style="align-self:center">Apply</button>
        </div>
      `).join('') : `<div class="empty"><h4>No interventions needed</h4><p>Queue is pacing on or above target.</p></div>`;

      // KPI block
      const kpiBlock = `
        <div class="grid cols-4">
          ${UI.kpiHTML({ label: 'SL Now', value: (slSoFar*100).toFixed(1), unit: '%', delta: `vs ${(q.slTarget*100)|0}% target`, deltaDir: slSoFar >= q.slTarget ? 'up' : 'down', accent: true })}
          ${UI.kpiHTML({ label: 'EoD Projected', value: pacing.projected ? (pacing.projected*100).toFixed(1) : '—', unit: '%', delta: pacing.atRisk ? 'at risk' : 'on track', deltaDir: pacing.atRisk ? 'down' : 'up' })}
          ${UI.kpiHTML({ label: 'Volume Variance', value: variance.deltaPct >= 0 ? '+' + (variance.deltaPct*100).toFixed(1) : (variance.deltaPct*100).toFixed(1), unit: '%', delta: `${variance.aSum}/${variance.fSum} so far`, deltaDir: Math.abs(variance.deltaPct) > 0.05 ? 'down' : 'flat' })}
          ${UI.kpiHTML({ label: 'Adherence', value: (adherence*100).toFixed(1), unit: '%', delta: adherence < 0.85 ? 'below 85%' : 'within band', deltaDir: adherence < 0.85 ? 'down' : 'up' })}
        </div>
      `;

      const tickLabel = `${String(Math.floor(nowInterval/2)).padStart(2,'0')}:${nowInterval%2===0?'00':'30'}`;

      UI.html(root, `
        <div class="page">
          <div class="page-head">
            <div><h1>Intraday — ${q.name}</h1><div class="sub">Live monitoring · interval ${tickLabel} · interventions auto-recommended</div></div>
            <div class="actions">
              <select class="select" id="qsel">${queues.map(qq => `<option value="${qq.id}" ${qq.id === qid ? 'selected' : ''}>${qq.name}</option>`).join('')}</select>
              <button class="btn" id="rewind">${WFM.Icons.refresh} Rewind</button>
              <button class="btn primary" id="playpause">${isLive ? WFM.Icons.pause : WFM.Icons.play} ${isLive ? 'Pause' : 'Live'}</button>
            </div>
          </div>

          ${kpiBlock}

          <div class="grid cols-2" style="margin-top:var(--space-4); grid-template-columns: 1.5fr 1fr;">
            ${UI.card(
              `<div><h3>Volume — Actual vs Forecast</h3><div class="sub">Today · 48 × 30-min intervals</div></div>`,
              `<div class="chart" style="height:240px">${volChart}</div>
               <div style="margin-top:12px"><div class="t-micro" style="margin-bottom:6px">Coverage health by interval</div>${stripHTML}</div>`
            )}
            ${UI.card(
              `<div><h3>Right Now</h3><div class="sub">Agent state · interval ${tickLabel}</div></div>`,
              `<div style="display:grid;grid-template-columns:170px 1fr;gap:20px;align-items:center">
                 <div>${donutHTML}</div>
                 <div class="stack">
                   <div class="row between"><span class="t-micro">On call</span><span class="num">${onPhone}</span></div>
                   <div class="row between"><span class="t-micro">After-call work</span><span class="num">${acw}</span></div>
                   <div class="row between"><span class="t-micro">AUX (break, meeting, etc)</span><span class="num">${aux}</span></div>
                   <div class="row between"><span class="t-micro">Ready</span><span class="num">${ready}</span></div>
                 </div>
               </div>
               <div style="margin-top:20px;text-align:center">
                 <div class="t-micro" style="margin-bottom:4px">End-of-day SL Projection</div>
                 <div style="height:90px">${gaugeHTML}</div>
                 <div class="muted t-small">Target ${(q.slTarget*100)|0}% · current pace ${pacing.atRisk ? '<span class="s-danger">below</span>' : '<span class="s-ok">on track</span>'}</div>
               </div>`
            )}
          </div>

          <div style="margin-top:var(--space-4)">
            ${UI.card(
              `<div><h3>Recommended Interventions</h3><div class="sub">Tiered by urgency · cost & SL impact estimated</div></div>
               <div class="actions"><span class="badge ${recommendations.length === 0 ? 'ok' : recommendations.some(r=>r.priority==='high') ? 'danger' : 'warn'}"><span class="dot"></span>${recommendations.length} action${recommendations.length !== 1 ? 's' : ''}</span></div>`,
              `<div class="stack">${recHTML}</div>`
            )}
          </div>
        </div>
      `);

      UI.$('#qsel', root).addEventListener('change', e => { qid = e.target.value; WFM.State.set({ queueId: qid }); render(); });
      UI.$('#rewind', root).addEventListener('click', () => { nowInterval = 16; WFM.State.set({ intradayTick: nowInterval }); render(); });
      UI.$('#playpause', root).addEventListener('click', () => {
        isLive = !isLive;
        if (isLive) {
          tickHandle = setInterval(() => {
            nowInterval = Math.min(47, nowInterval + 1);
            WFM.State.set({ intradayTick: nowInterval });
            if (nowInterval >= 47) { clearInterval(tickHandle); isLive = false; }
            render();
          }, 1800);
        } else if (tickHandle) {
          clearInterval(tickHandle);
        }
      });
    }

    // Clean up timer on module switch
    return () => { if (tickHandle) clearInterval(tickHandle); };
  };

  WFM.Modules = WFM.Modules || {};
  WFM.Modules.intraday = M;
})(window.WFM = window.WFM || {});
