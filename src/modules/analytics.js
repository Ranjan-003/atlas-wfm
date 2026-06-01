/* =========================================================
 * Module: Analytics
 * ========================================================= */
(function (WFM) {
  'use strict';
  const M = {};

  M.mount = function (root, state) {
    const queues = WFM.State.currentQueues();
    const Charts = WFM.Charts, UI = WFM.UI;

    // Forecast accuracy distribution
    const accuracies = queues.map(q => ({ name: q.name, channel: q.channel, acc: q.forecastAccuracy || 0, anomalies: q.anomalyCount, vol: q.history[83].volume }));
    accuracies.sort((a,b)=>b.acc-a.acc);

    // Volatility = std dev / mean of recent 30 days
    const volatility = queues.map(q => {
      const recent = q.history.slice(-30).map(h=>h.volume);
      const mean = recent.reduce((s,v)=>s+v,0)/recent.length;
      const variance = recent.reduce((s,v)=>s+(v-mean)*(v-mean),0)/recent.length;
      const cov = Math.sqrt(variance) / mean;
      return { name: q.name, channel: q.channel, cov, mean, anomalies: q.anomalyCount };
    }).sort((a,b)=>b.cov-a.cov);

    // Channel rollup
    const channelStats = {};
    queues.forEach(q => {
      const ch = q.channel;
      if (!channelStats[ch]) channelStats[ch] = { volume: 0, queues: 0, accSum: 0, anomalies: 0 };
      channelStats[ch].volume += q.history[83].volume;
      channelStats[ch].queues += 1;
      channelStats[ch].accSum += q.forecastAccuracy || 0;
      channelStats[ch].anomalies += q.anomalyCount;
    });

    UI.html(root, `
      <div class="page">
        <div class="page-head">
          <div><h1>Advanced Analytics</h1><div class="sub">Forecast quality · volatility · anomaly profile</div></div>
        </div>

        <div class="grid cols-4">
          ${UI.kpiHTML({ label: 'Avg Forecast Accuracy', value: (accuracies.reduce((s,a)=>s+a.acc,0)/accuracies.length*100).toFixed(1), unit: '%', accent: true, delta: '1 - WAPE', deltaDir: 'flat' })}
          ${UI.kpiHTML({ label: 'Queues Above 90% Acc', value: accuracies.filter(a => a.acc >= 0.9).length.toString(), delta: `of ${accuracies.length}`, deltaDir: 'flat' })}
          ${UI.kpiHTML({ label: 'Total Anomalies', value: queues.reduce((s,q)=>s+q.anomalyCount,0).toString(), delta: 'past 84 days', deltaDir: 'flat' })}
          ${UI.kpiHTML({ label: 'Most Volatile Queue', value: volatility[0].name.length > 14 ? volatility[0].name.slice(0,14)+'…' : volatility[0].name, delta: `${(volatility[0].cov*100).toFixed(0)}% CoV`, deltaDir: 'down' })}
        </div>

        <div class="grid cols-2" style="margin-top:var(--space-5)">
          ${UI.card(
            `<div><h3>Forecast Accuracy by Queue</h3><div class="sub">Ranked best to worst</div></div>`,
            `<div class="chart" style="height:240px">${Charts.bar({
              data: accuracies.slice(0, 12).map(a => a.acc * 100),
              categories: accuracies.slice(0, 12).map(a => a.name.length > 12 ? a.name.slice(0,12)+'…' : a.name),
              height: 240,
              colorFn: v => v >= 90 ? 'var(--ok)' : v >= 80 ? 'var(--warn)' : 'var(--danger)'
            })}</div>`
          )}
          ${UI.card(
            `<div><h3>Volume Volatility (CoV)</h3><div class="sub">Queues ranked by 30-day coefficient of variation</div></div>`,
            `<div class="chart" style="height:240px">${Charts.bar({
              data: volatility.slice(0, 12).map(v => v.cov * 100),
              categories: volatility.slice(0, 12).map(v => v.name.length > 12 ? v.name.slice(0,12)+'…' : v.name),
              height: 240,
              colorFn: v => v >= 40 ? 'var(--danger)' : v >= 25 ? 'var(--warn)' : 'var(--c-cyan)'
            })}</div>`
          )}
        </div>

        <div style="margin-top:var(--space-4)">
          ${UI.card(
            `<div><h3>Channel Rollup</h3><div class="sub">Aggregated metrics by channel</div></div>`,
            `<table class="tbl">
              <thead><tr><th>Channel</th><th class="num">Queues</th><th class="num">Daily Volume</th><th class="num">Avg Accuracy</th><th class="num">Anomalies</th><th></th></tr></thead>
              <tbody>
                ${Object.entries(channelStats).map(([ch, s]) => `
                  <tr>
                    <td>${UI.badge(ch, ch === 'voice' ? 'info' : ch === 'chat' ? 'accent' : ch === 'email' ? 'ok' : 'warn')}</td>
                    <td class="num">${s.queues}</td>
                    <td class="num">${s.volume.toLocaleString()}</td>
                    <td class="num">${(s.accSum/s.queues*100).toFixed(1)}%</td>
                    <td class="num">${s.anomalies}</td>
                    <td style="width:200px">${UI.bar(s.accSum/s.queues, { thresholds: [0.8, 0.9] })}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>`,
            { flush: true }
          )}
        </div>

        <div style="margin-top:var(--space-4)">
          ${UI.card(
            `<div><h3>Queue Detail</h3><div class="sub">All queues sorted by accuracy</div></div>`,
            `<table class="tbl">
              <thead><tr><th>Queue</th><th>Channel</th><th class="num">Forecast Acc</th><th class="num">Volatility</th><th class="num">Anomalies</th><th class="num">Daily Vol</th></tr></thead>
              <tbody>
                ${accuracies.map(a => {
                  const v = volatility.find(x => x.name === a.name);
                  return `
                  <tr>
                    <td><b>${a.name}</b></td>
                    <td>${UI.badge(a.channel, a.channel === 'voice' ? 'info' : '')}</td>
                    <td class="num">${(a.acc*100).toFixed(1)}%</td>
                    <td class="num">${v ? (v.cov*100).toFixed(0)+'%' : '—'}</td>
                    <td class="num">${a.anomalies}</td>
                    <td class="num">${a.vol.toLocaleString()}</td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>`,
            { flush: true }
          )}
        </div>
      </div>
    `);
  };

  WFM.Modules = WFM.Modules || {};
  WFM.Modules.analytics = M;
})(window.WFM = window.WFM || {});
