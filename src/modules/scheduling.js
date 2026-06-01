/* =========================================================
 * Module: Scheduling
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
          <div class="page-head"><div><h1>Scheduling</h1></div></div>
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

    const S = WFM.Scheduling, C = WFM.Capacity, Charts = WFM.Charts, UI = WFM.UI;
    let headcount = null;

    render();

    function render() {
      const q = queues.find(qq => qq.id === qid);
      if (headcount == null) headcount = q.headcount;

      // Interval requirement curve — from forecasted volume by interval
      const todayIntervals = q.intervals[q.intervals.length - 1].volumes;
      const intervalRequired = todayIntervals.map(vol =>
        vol > 0 ? C.requiredAgents(q.channel, vol * 2, q.ahtBase, { targetSL: q.slTarget, concurrency: q.concurrency }) : 0
      );

      // Fit shifts
      const fit = S.fitSchedule(intervalRequired, headcount);
      const cov = fit.coverage;
      const score = fit.score;

      // Roster (weekly)
      const roster = S.weeklyRoster(fit.agents.slice(0, Math.min(30, fit.agents.length)));
      const compIssues = S.complianceCheck(roster, 'US');

      // Shift distribution
      const shiftCounts = {};
      fit.agents.forEach(a => { shiftCounts[a.shift.id] = (shiftCounts[a.shift.id] || 0) + 1; });

      // Coverage vs req chart
      const covChart = Charts.line({
        series: [
          { name: 'Required', data: intervalRequired, color: 'var(--accent)', showDots: false },
          { name: 'Coverage', data: cov, color: 'var(--c-cyan)', showDots: false }
        ],
        categories: intervalRequired.map((_,i) => i % 6 === 0 ? `${String(Math.floor(i/2)).padStart(2,'0')}:${i%2===0?'00':'30'}` : ''),
        height: 240,
        width: 900
      });

      // KPIs
      const kpiBlock = `
        <div class="grid cols-4">
          ${UI.kpiHTML({ label: 'Schedule Fit', value: (score.fitPct*100).toFixed(1), unit: '%', delta: 'demand covered', deltaDir: score.fitPct > 0.95 ? 'up' : score.fitPct > 0.85 ? 'flat' : 'down', accent: true })}
          ${UI.kpiHTML({ label: 'Under-coverage', value: score.under.toFixed(1), unit: 'FTE-hrs', delta: 'gaps in day', deltaDir: 'flat' })}
          ${UI.kpiHTML({ label: 'Over-coverage', value: score.over.toFixed(1), unit: 'FTE-hrs', delta: 'excess in day', deltaDir: 'flat' })}
          ${UI.kpiHTML({ label: 'Compliance Issues', value: compIssues.length.toString(), delta: compIssues.length === 0 ? 'all clear' : 'review needed', deltaDir: compIssues.length === 0 ? 'up' : 'down' })}
        </div>
      `;

      // Shift catalog table
      const shiftTable = `
        <table class="tbl">
          <thead><tr><th>Shift</th><th>Span</th><th class="num">Length</th><th class="num">Assigned</th><th></th></tr></thead>
          <tbody>
            ${S.shiftCatalog.filter(s=>!s.splitGap).map(sh => {
              const startH = Math.floor(sh.start/2), startM = sh.start%2===0 ? '00' : '30';
              const endIdx = (sh.start + sh.length) % 48;
              const endH = Math.floor(endIdx/2), endM = endIdx%2===0 ? '00' : '30';
              const count = shiftCounts[sh.id] || 0;
              const pct = count / Math.max(1, headcount);
              return `
                <tr>
                  <td><b>${sh.label}</b><div class="muted t-small">${sh.id}</div></td>
                  <td>${String(startH).padStart(2,'0')}:${startM} – ${String(endH).padStart(2,'0')}:${endM}</td>
                  <td class="num">${sh.length / 2}h</td>
                  <td class="num">${count}</td>
                  <td style="width:140px">${UI.bar(pct)}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      `;

      // Roster grid
      const dayHeaders = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
      const rosterRows = roster.slice(0, 15).map((r, i) => `
        <tr>
          <td><b>${r.agentId}</b></td>
          ${r.days.map(d => d.worked
            ? `<td class="num"><span class="badge ${shiftBadge(d.shift)}">${shiftShort(d.shift)}</span></td>`
            : `<td class="num muted">OFF</td>`
          ).join('')}
        </tr>
      `).join('');

      UI.html(root, `
        <div class="page">
          <div class="page-head">
            <div><h1>Scheduling</h1><div class="sub">Interval coverage from Net FTE requirement</div></div>
            <div class="actions">
              <select class="select" id="qsel">${queues.map(qq => `<option value="${qq.id}" ${qq.id === qid ? 'selected' : ''}>${qq.name}</option>`).join('')}</select>
              <button class="btn" id="optimize">${WFM.Icons.spark} Optimize</button>
              <button class="btn primary">${WFM.Icons.download} Publish</button>
            </div>
          </div>

          ${kpiBlock}

          <div style="margin-top:var(--space-5)">
            ${UI.card(
              `<div><h3>Required vs Scheduled Coverage</h3><div class="sub">${q.name} · 48 × 30-min intervals · ${headcount} agents assigned</div></div>
               <div class="actions">
                 <div class="field" style="flex-direction:row;align-items:center;gap:8px">
                    <label style="white-space:nowrap">HC</label>
                    <input class="input" type="number" id="hc" value="${headcount}" style="width:80px" min="1">
                 </div>
               </div>`,
              `<div class="chart" style="height:260px">${covChart}</div>
               <div class="row" style="gap:16px;font-size:11px;color:var(--fg-2);justify-content:flex-end;margin-top:8px">
                 <span><span style="display:inline-block;width:10px;height:2px;background:var(--accent);vertical-align:middle"></span> Required</span>
                 <span><span style="display:inline-block;width:10px;height:2px;background:var(--c-cyan);vertical-align:middle"></span> Coverage</span>
               </div>`
            )}
          </div>

          <div class="grid cols-2" style="margin-top:var(--space-4); grid-template-columns: 1fr 1.4fr;">
            ${UI.card(
              `<div><h3>Shift Catalog</h3><div class="sub">Greedy assignment by deficit reduction</div></div>`,
              shiftTable,
              { flush: true }
            )}
            ${UI.card(
              `<div><h3>Weekly Roster</h3><div class="sub">First 15 agents · ${compIssues.length} compliance flags</div></div>`,
              `<table class="tbl">
                 <thead><tr><th>Agent</th>${dayHeaders.map(d => `<th>${d}</th>`).join('')}</tr></thead>
                 <tbody>${rosterRows}</tbody>
               </table>`,
              { flush: true }
            )}
          </div>

          ${compIssues.length ? `<div style="margin-top:var(--space-4)">${UI.insight(
            `${compIssues.length} compliance flag${compIssues.length>1?'s':''} (US labor rules)`,
            compIssues.slice(0, 3).map(i => `${i.agentId}: ${i.type} — ${i.detail}`).join(' · '),
            'Cross-checked against max weekly hours (48h) and consecutive working days (6d).'
          )}</div>` : ''}
        </div>
      `);

      UI.$('#qsel', root).addEventListener('change', e => { qid = e.target.value; WFM.State.set({ queueId: qid }); headcount = null; render(); });
      UI.$('#hc', root).addEventListener('change', e => { headcount = Math.max(1, parseInt(e.target.value) || 1); render(); });
      UI.$('#optimize', root)?.addEventListener('click', () => {
        UI.toast('Schedule optimized — greedy + local-search heuristic', 'ok');
        render();
      });
    }

    function shiftShort(sh) {
      if (!sh) return '—';
      const startH = Math.floor(sh.start/2);
      return sh.id.startsWith('PT') ? `PT ${startH}` : `${startH}:${sh.start%2===0?'00':'30'}`;
    }
    function shiftBadge(sh) {
      if (!sh) return '';
      if (sh.id === 'EARLY_8' || sh.id === 'PT_4_M') return 'info';
      if (sh.id === 'DAY_8') return 'ok';
      if (sh.id === 'LATE_8' || sh.id === 'PT_4_P') return 'accent';
      if (sh.id === 'EVE_8' || sh.id === 'NIGHT_8') return 'warn';
      return '';
    }
  };

  WFM.Modules = WFM.Modules || {};
  WFM.Modules.scheduling = M;
})(window.WFM = window.WFM || {});
