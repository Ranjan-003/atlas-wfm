/* =========================================================
 * Module: AI Deflection Studio
 * ========================================================= */
(function (WFM) {
  'use strict';
  const M = {};

  M.mount = function (root, state) {
    const queues = WFM.State.currentQueues();
    let qid = state.queueId && queues.find(q => q.id === state.queueId) ? state.queueId : queues[0]?.id;
    if (!qid) { root.innerHTML = '<div class="empty">No queues.</div>'; return; }

    const D = WFM.AIDeflection, C = WFM.Capacity, Charts = WFM.Charts, UI = WFM.UI;
    const deflection = { simple: 0.50, medium: 0.20, complex: 0.05 };

    render();

    function render() {
      const q = queues.find(qq => qq.id === qid);
      const last7Vol = q.history.slice(-7).reduce((s,h)=>s+h.volume,0)/7;
      const baseAHT = q.ahtBase;
      const baselineCost = C.cost(WFM.Capacity.fromAgentsToFTE([C.requiredAgents(q.channel, last7Vol/8, baseAHT, { targetSL: q.slTarget })], { shrinkage: q.shrinkage, occupancy: q.occupancyTarget }).grossFTE);

      const result = D.applyDeflection(last7Vol, D.defaultMix, deflection);
      const newReq = C.requiredAgents(q.channel, result.newVolume/8, result.newAHT, { targetSL: q.slTarget });
      const newFTE = WFM.Capacity.fromAgentsToFTE([newReq], { shrinkage: q.shrinkage, occupancy: q.occupancyTarget });
      const newCost = C.cost(newFTE.grossFTE);
      const savings = baselineCost - newCost;

      // Mix donut
      const mixDonut = Charts.donut(
        result.newMix.map(m => ({ label: m.tier, value: m.share, color: m.tier === 'simple' ? 'var(--c-cyan)' : m.tier === 'medium' ? 'var(--c-blue)' : 'var(--c-pink)' })),
        { width: 160, height: 160, centerText: `${((1-result.deflectionRate)*100).toFixed(0)}%`, centerSub: 'residual' }
      );

      // Volume chart before/after
      const compChart = Charts.bar({
        data: [last7Vol, result.newVolume],
        categories: ['Baseline', 'With AI Deflection'],
        height: 180,
        colorFn: (v,i) => i === 0 ? 'var(--c-blue)' : 'var(--accent)'
      });

      const ahtChart = Charts.bar({
        data: [baseAHT, result.newAHT],
        categories: ['Baseline', 'After Deflection'],
        height: 180,
        colorFn: (v,i) => i === 0 ? 'var(--c-blue)' : 'var(--c-pink)'
      });

      UI.html(root, `
        <div class="page">
          <div class="page-head">
            <div><h1>AI Deflection Studio</h1><div class="sub">Model self-service / AI deflection · understand residual AHT shift</div></div>
            <div class="actions">
              <select class="select" id="qsel">${queues.map(qq => `<option value="${qq.id}" ${qq.id === qid ? 'selected' : ''}>${qq.name}</option>`).join('')}</select>
            </div>
          </div>

          <div class="grid cols-4">
            ${UI.kpiHTML({ label: 'Deflection Rate', value: (result.deflectionRate*100).toFixed(1), unit: '%', delta: 'of total volume', deltaDir: 'up', accent: true })}
            ${UI.kpiHTML({ label: 'Volume Reduction', value: Math.round(last7Vol - result.newVolume).toLocaleString(), delta: 'contacts/day', deltaDir: 'up' })}
            ${UI.kpiHTML({ label: 'AHT Shift', value: `${result.ahtShift >= 0 ? '+' : ''}${result.ahtShift.toFixed(0)}`, unit: 's', delta: 'residual mix is harder', deltaDir: result.ahtShift > 0 ? 'down' : 'up' })}
            ${UI.kpiHTML({ label: 'Annual Savings', value: '$' + Math.round(savings/1000), unit: 'k', delta: `${Math.round((1 - newCost/baselineCost)*100)}% lower payroll`, deltaDir: 'up' })}
          </div>

          <div class="grid cols-2" style="margin-top:var(--space-5); grid-template-columns: 360px 1fr">
            ${UI.card(
              `<div><h3>Deflection by Tier</h3><div class="sub">% of each tier handled by AI</div></div>`,
              `<div class="stack">
                <div class="field">
                  <label>Simple (40% baseline): <b>${(deflection.simple*100).toFixed(0)}%</b></label>
                  <input class="slider" type="range" id="ds" min="0" max="80" step="5" value="${deflection.simple*100}">
                  <div class="muted t-small">Password resets, balance checks, status lookups</div>
                </div>
                <div class="field">
                  <label>Medium (35% baseline): <b>${(deflection.medium*100).toFixed(0)}%</b></label>
                  <input class="slider" type="range" id="dm" min="0" max="50" step="5" value="${deflection.medium*100}">
                  <div class="muted t-small">Order status, basic troubleshooting</div>
                </div>
                <div class="field">
                  <label>Complex (25% baseline): <b>${(deflection.complex*100).toFixed(0)}%</b></label>
                  <input class="slider" type="range" id="dc" min="0" max="20" step="2" value="${deflection.complex*100}">
                  <div class="muted t-small">Disputes, escalations — usually NOT deflectable</div>
                </div>
              </div>`
            )}

            <div class="stack">
              <div class="grid cols-2">
                ${UI.card(`<div><h3>Volume Impact</h3></div>`, `<div class="chart" style="height:200px">${compChart}</div>`)}
                ${UI.card(`<div><h3>Blended AHT</h3></div>`, `<div class="chart" style="height:200px">${ahtChart}</div>`)}
              </div>
              ${UI.card(`<div><h3>Residual Contact Mix</h3><div class="sub">What's left for human agents</div></div>`,
                `<div style="display:grid;grid-template-columns:170px 1fr;gap:24px;align-items:center">
                  <div>${mixDonut}</div>
                  <table class="tbl" style="background:transparent">
                    <thead><tr><th>Tier</th><th class="num">Share before</th><th class="num">Share after</th><th class="num">AHT (s)</th></tr></thead>
                    <tbody>
                      ${D.defaultMix.map((m,i) => `
                        <tr>
                          <td><b style="text-transform:capitalize">${m.tier}</b></td>
                          <td class="num">${(m.share*100).toFixed(0)}%</td>
                          <td class="num">${(result.newMix[i].normShare*100).toFixed(1)}%</td>
                          <td class="num">${m.aht}</td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                </div>`)}
              ${UI.insight(
                'Why blended AHT rises when AI deflects',
                'AI handles the easy tier first. As those volumes get filtered out, the remaining contacts skew toward medium and complex — which take longer to resolve. Models that ignore this shift overstate deflection savings.',
                'Atlas factors residual mix into capacity recalculations automatically.'
              )}
            </div>
          </div>
        </div>
      `);

      const wire = (id, fn) => UI.$('#'+id, root).addEventListener('input', e => { fn(parseFloat(e.target.value)/100); render(); });
      wire('ds', v => deflection.simple = v);
      wire('dm', v => deflection.medium = v);
      wire('dc', v => deflection.complex = v);
      UI.$('#qsel', root).addEventListener('change', e => { qid = e.target.value; WFM.State.set({ queueId: qid }); render(); });
    }
  };

  WFM.Modules = WFM.Modules || {};
  WFM.Modules.deflection = M;
})(window.WFM = window.WFM || {});
