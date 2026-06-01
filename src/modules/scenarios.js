/* =========================================================
 * Module: What-If Scenarios
 * ========================================================= */
(function (WFM) {
  'use strict';
  const M = {};

  M.mount = function (root, state) {
    const queues = WFM.State.currentQueues();
    let qid = state.queueId && queues.find(q => q.id === state.queueId) ? state.queueId : queues[0]?.id;
    if (!qid) { root.innerHTML = '<div class="empty">No queues.</div>'; return; }

    const D = WFM.AIDeflection, C = WFM.Capacity, Charts = WFM.Charts, UI = WFM.UI;

    const scenario = { ...WFM.State.get().scenario };

    render();

    function render() {
      const q = queues.find(qq => qq.id === qid);
      const last7Vol = q.history.slice(-7).reduce((s,h)=>s+h.volume,0)/7;
      const baseline = {
        channel: q.channel,
        volume: last7Vol / 8,           // hourly
        aht: q.ahtBase,
        shrinkage: q.shrinkage,
        attrition: q.attrition,
        currentHC: q.headcount,
        targetSL: q.slTarget,
        occupancyTarget: q.occupancyTarget,
        mix: D.defaultMix
      };
      const baseReq = C.requiredAgents(baseline.channel, baseline.volume, baseline.aht, { targetSL: baseline.targetSL });
      const baseFTE = C.fromAgentsToFTE([baseReq], { shrinkage: baseline.shrinkage, occupancy: baseline.occupancyTarget });
      const baseCost = C.cost(baseFTE.grossFTE);

      const result = D.runScenario(baseline, scenario);
      const resCost = C.cost(result.grossFTE);

      // Comparison chart — bars side by side
      const compChart = Charts.bar({
        data: [baseReq, result.requiredAgents],
        categories: ['Baseline', 'Scenario'],
        height: 180,
        colorFn: (v,i) => i === 0 ? 'var(--c-blue)' : 'var(--accent)'
      });

      const fteChart = Charts.bar({
        data: [baseFTE.grossFTE, result.grossFTE],
        categories: ['Baseline', 'Scenario'],
        height: 180,
        colorFn: (v,i) => i === 0 ? 'var(--c-blue)' : 'var(--accent)'
      });

      // KPI deltas
      const dReq = result.requiredAgents - baseReq;
      const dFTE = result.grossFTE - baseFTE.grossFTE;
      const dCost = resCost - baseCost;

      WFM.State.set({ scenario });

      UI.html(root, `
        <div class="page">
          <div class="page-head">
            <div><h1>What-If Scenarios</h1><div class="sub">Adjust assumptions · see staffing & cost impact propagate</div></div>
            <div class="actions">
              <select class="select" id="qsel">${queues.map(qq => `<option value="${qq.id}" ${qq.id === qid ? 'selected' : ''}>${qq.name}</option>`).join('')}</select>
              <button class="btn" id="reset">${WFM.Icons.refresh} Reset</button>
              <button class="btn primary">${WFM.Icons.download} Save Scenario</button>
            </div>
          </div>

          <div class="grid cols-2" style="grid-template-columns: 360px 1fr">
            ${UI.card(
              `<div><h3>Scenario Levers</h3><div class="sub">Baseline: ${q.name}</div></div>`,
              `
                <div class="stack">
                  <div class="field">
                    <label>Volume change: <b>${scenario.volPct >= 0 ? '+' : ''}${(scenario.volPct*100).toFixed(0)}%</b></label>
                    <input class="slider" type="range" id="vol" min="-50" max="100" step="5" value="${scenario.volPct*100}">
                  </div>
                  <div class="field">
                    <label>AHT change: <b>${scenario.ahtPct >= 0 ? '+' : ''}${(scenario.ahtPct*100).toFixed(0)}%</b></label>
                    <input class="slider" type="range" id="aht" min="-30" max="50" step="5" value="${scenario.ahtPct*100}">
                  </div>
                  <div class="field">
                    <label>Shrinkage delta: <b>${scenario.shrinkageDelta >= 0 ? '+' : ''}${(scenario.shrinkageDelta*100).toFixed(0)} pts</b></label>
                    <input class="slider" type="range" id="shrink" min="-15" max="20" step="1" value="${scenario.shrinkageDelta*100}">
                  </div>
                  <div class="field">
                    <label>Attrition multiplier: <b>${scenario.attritionMult.toFixed(1)}×</b></label>
                    <input class="slider" type="range" id="att" min="50" max="200" step="10" value="${scenario.attritionMult*100}">
                  </div>
                  <div style="border-top:1px solid var(--border);padding-top:var(--space-3);margin-top:var(--space-2)">
                    <div class="t-micro" style="margin-bottom:8px">AI Deflection (per tier)</div>
                    <div class="field">
                      <label>Simple (40%): <b>${(scenario.deflection.simple*100).toFixed(0)}%</b> deflected</label>
                      <input class="slider" type="range" id="ds" min="0" max="80" step="5" value="${scenario.deflection.simple*100}">
                    </div>
                    <div class="field">
                      <label>Medium (35%): <b>${(scenario.deflection.medium*100).toFixed(0)}%</b> deflected</label>
                      <input class="slider" type="range" id="dm" min="0" max="50" step="5" value="${scenario.deflection.medium*100}">
                    </div>
                    <div class="field">
                      <label>Complex (25%): <b>${(scenario.deflection.complex*100).toFixed(0)}%</b> deflected</label>
                      <input class="slider" type="range" id="dc" min="0" max="20" step="2" value="${scenario.deflection.complex*100}">
                    </div>
                  </div>
                </div>
              `
            )}

            <div class="stack">
              <div class="grid cols-3">
                ${UI.kpiHTML({ label: 'Required Agents', value: result.requiredAgents.toString(), delta: `${dReq>=0?'+':''}${dReq}`, deltaDir: dReq>0?'up':dReq<0?'down':'flat', accent: true })}
                ${UI.kpiHTML({ label: 'Gross FTE', value: result.grossFTE.toFixed(1), delta: `${dFTE>=0?'+':''}${dFTE.toFixed(1)}`, deltaDir: dFTE>0?'up':dFTE<0?'down':'flat' })}
                ${UI.kpiHTML({ label: 'Cost Delta', value: '$' + (Math.abs(dCost)/1000).toFixed(0), unit: 'k/yr', delta: dCost>=0?'increase':'savings', deltaDir: dCost>0?'down':'up' })}
              </div>
              <div class="grid cols-2" style="grid-template-columns:1fr 1fr">
                ${UI.card(`<div><h3>Required Agents</h3></div>`, `<div class="chart" style="height:200px">${compChart}</div>`)}
                ${UI.card(`<div><h3>Gross FTE</h3></div>`, `<div class="chart" style="height:200px">${fteChart}</div>`)}
              </div>
              ${UI.insight(
                'Scenario Summary',
                `At <b>${result.volume.toFixed(0)}</b> contacts/hr and <b>${result.aht.toFixed(0)}s</b> AHT, ${q.name} would require <b>${result.requiredAgents} agents/8h</b> on the phone, scaling to <b>${result.grossFTE.toFixed(1)} Gross FTE</b> at ${(result.shrinkage*100).toFixed(0)}% shrinkage. Net effect on annualized payroll: <b>${dCost>=0?'+':''}$${(dCost/1000).toFixed(0)}k</b>.`,
                scenario.deflection.simple > 0 || scenario.deflection.medium > 0 ? 'AI deflection applied — note that remaining contact mix has higher blended AHT as easier calls are filtered out.' : ''
              )}
            </div>
          </div>
        </div>
      `);

      const sliderHandlers = {
        vol:    v => scenario.volPct = v/100,
        aht:    v => scenario.ahtPct = v/100,
        shrink: v => scenario.shrinkageDelta = v/100,
        att:    v => scenario.attritionMult = v/100,
        ds:     v => scenario.deflection.simple = v/100,
        dm:     v => scenario.deflection.medium = v/100,
        dc:     v => scenario.deflection.complex = v/100
      };
      Object.entries(sliderHandlers).forEach(([id, fn]) => {
        UI.$('#'+id, root).addEventListener('input', e => { fn(parseFloat(e.target.value)); render(); });
      });
      UI.$('#qsel', root).addEventListener('change', e => { qid = e.target.value; WFM.State.set({ queueId: qid }); render(); });
      UI.$('#reset', root).addEventListener('click', () => {
        Object.assign(scenario, { volPct: 0, ahtPct: 0, shrinkageDelta: 0, attritionMult: 1, deflection: { simple: 0, medium: 0, complex: 0 } });
        render();
      });
    }
  };

  WFM.Modules = WFM.Modules || {};
  WFM.Modules.scenarios = M;
})(window.WFM = window.WFM || {});
