/* =========================================================
 * Charts — pure SVG, no dependencies
 * Functions return an SVG string. Width/height responsive.
 * ========================================================= */
(function (WFM) {
  'use strict';
  const Charts = {};

  const PALETTE = ['var(--c-cyan)','var(--c-blue)','var(--c-violet)','var(--c-pink)','var(--c-amber)','var(--c-lime)'];

  function niceMax(v) {
    if (v <= 0) return 1;
    const exp = Math.pow(10, Math.floor(Math.log10(v)));
    const f = v / exp;
    let nice = 10;
    if (f <= 1) nice = 1;
    else if (f <= 2) nice = 2;
    else if (f <= 5) nice = 5;
    return nice * exp;
  }
  function fmtNum(v, decimals) {
    if (v == null || isNaN(v)) return '–';
    decimals = decimals ?? (Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2);
    return Number(v).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }
  Charts.fmtNum = fmtNum;
  Charts.fmtPct = (v, d=1) => v == null ? '–' : `${(v*100).toFixed(d)}%`;
  Charts.fmtSec = (s) => {
    if (s == null) return '–';
    if (s < 60) return `${Math.round(s)}s`;
    if (s < 3600) return `${Math.floor(s/60)}m ${Math.round(s%60)}s`;
    return `${(s/3600).toFixed(1)}h`;
  };

  // ---------- Sparkline ----------
  Charts.sparkline = function (data, opts) {
    opts = opts || {};
    const w = opts.width || 80, h = opts.height || 22;
    if (!data.length) return `<svg width="${w}" height="${h}"></svg>`;
    const min = Math.min(...data), max = Math.max(...data);
    const range = max - min || 1;
    const pad = 1;
    const pts = data.map((v, i) => {
      const x = pad + (i / (data.length - 1)) * (w - 2*pad);
      const y = h - pad - ((v - min) / range) * (h - 2*pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const color = opts.color || 'currentColor';
    return `<svg class="sparkline" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  };

  // ---------- Line chart (with optional CI band, anomalies) ----------
  // opts: { series: [{name, data, color, dashed}], categories, ciLo, ciHi, anomalies }
  Charts.line = function (opts) {
    const w = opts.width || 720, h = opts.height || 240;
    const padL = 44, padR = 12, padT = 12, padB = 26;
    const innerW = w - padL - padR, innerH = h - padT - padB;
    const cats = opts.categories || (opts.series[0]?.data || []).map((_,i)=>i);
    const allVals = opts.series.flatMap(s => s.data).filter(v => v != null);
    if (opts.ciLo) allVals.push(...opts.ciLo);
    if (opts.ciHi) allVals.push(...opts.ciHi);
    const max = niceMax(Math.max(...allVals, 1));
    const min = opts.startAtZero === false ? Math.min(...allVals, 0) : 0;

    const xs = (i) => padL + (cats.length === 1 ? innerW/2 : (i / (cats.length - 1)) * innerW);
    const ys = (v) => padT + innerH - ((v - min) / (max - min)) * innerH;

    // Gridlines
    const gridY = [];
    const ticks = 4;
    for (let i=0; i<=ticks; i++) {
      const v = min + (max - min) * i / ticks;
      const y = ys(v);
      gridY.push(`<line class="gridline" x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}"/>`);
      gridY.push(`<text x="${padL - 6}" y="${y + 3}" text-anchor="end" fill="var(--fg-3)" font-size="10" font-family="ui-monospace,monospace">${fmtNum(v)}</text>`);
    }

    // X labels (sparse)
    const labelEvery = Math.max(1, Math.ceil(cats.length / 8));
    const xLabels = cats.map((c, i) => {
      if (i % labelEvery !== 0 && i !== cats.length - 1) return '';
      return `<text x="${xs(i)}" y="${h - padB + 14}" text-anchor="middle" fill="var(--fg-3)" font-size="10" font-family="ui-monospace,monospace">${c}</text>`;
    }).join('');

    // CI band
    let ciPath = '';
    if (opts.ciLo && opts.ciHi) {
      const top = opts.ciHi.map((v,i) => `${xs(i).toFixed(1)},${ys(v).toFixed(1)}`).join(' L');
      const bot = opts.ciLo.map((v,i) => `${xs(i).toFixed(1)},${ys(v).toFixed(1)}`).reverse().join(' L');
      ciPath = `<path class="ci-band" d="M${top} L${bot} Z"/>`;
    }

    // Series
    const seriesSVG = opts.series.map((s, idx) => {
      const color = s.color || PALETTE[idx % PALETTE.length];
      const pts = s.data.map((v, i) => v == null ? null : `${xs(i).toFixed(1)},${ys(v).toFixed(1)}`).filter(Boolean).join(' L');
      const dash = s.dashed ? 'stroke-dasharray="4 3"' : '';
      const line = pts ? `<path class="series-line" d="M${pts}" stroke="${color}" ${dash}/>` : '';
      const dots = (s.showDots !== false) ? s.data.map((v, i) => v == null ? '' :
        `<circle class="series-dot" cx="${xs(i)}" cy="${ys(v)}" r="2.5" fill="${color}"/>`).join('') : '';
      return line + dots;
    }).join('');

    // Anomalies (red dots)
    const anomSVG = (opts.anomalies || []).map(a =>
      `<circle class="anomaly" cx="${xs(a.index)}" cy="${ys(a.value)}" r="3.5"/>`
    ).join('');

    // Hover layer (invisible rect)
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <g class="axis">${gridY.join('')}${xLabels}</g>
      ${ciPath}
      ${seriesSVG}
      ${anomSVG}
    </svg>`;
  };

  // ---------- Bar chart ----------
  Charts.bar = function (opts) {
    const w = opts.width || 720, h = opts.height || 240;
    const padL = 44, padR = 12, padT = 12, padB = 26;
    const innerW = w - padL - padR, innerH = h - padT - padB;
    const cats = opts.categories || [];
    const data = opts.data || [];
    const max = niceMax(Math.max(...data, 1));
    const min = Math.min(0, ...data);
    const barW = innerW / cats.length * 0.7;
    const gap = innerW / cats.length * 0.3;

    const bars = data.map((v, i) => {
      const x = padL + i * (innerW / cats.length) + gap / 2;
      const yTop = padT + innerH - ((v - min) / (max - min)) * innerH;
      const y0 = padT + innerH - ((0 - min) / (max - min)) * innerH;
      const barH = Math.abs(y0 - yTop);
      const y = v >= 0 ? yTop : y0;
      const color = (opts.colorFn ? opts.colorFn(v, i) : null) || opts.color || 'var(--accent)';
      return `<rect x="${x}" y="${y}" width="${barW}" height="${barH}" rx="1" fill="${color}" opacity="0.85"/>`;
    }).join('');

    // Gridlines + Y labels
    const ticks = 4;
    const gridY = [];
    for (let i=0; i<=ticks; i++) {
      const v = min + (max - min) * i / ticks;
      const y = padT + innerH - ((v - min) / (max - min)) * innerH;
      gridY.push(`<line class="gridline" x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}"/>`);
      gridY.push(`<text x="${padL - 6}" y="${y + 3}" text-anchor="end" fill="var(--fg-3)" font-size="10" font-family="ui-monospace,monospace">${fmtNum(v)}</text>`);
    }
    const labelEvery = Math.max(1, Math.ceil(cats.length / 12));
    const xLabels = cats.map((c, i) => i % labelEvery !== 0 ? '' :
      `<text x="${padL + i * (innerW / cats.length) + (innerW / cats.length)/2}" y="${h - padB + 14}" text-anchor="middle" fill="var(--fg-3)" font-size="10" font-family="ui-monospace,monospace">${c}</text>`
    ).join('');

    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <g class="axis">${gridY.join('')}${xLabels}</g>
      ${bars}
    </svg>`;
  };

  // ---------- Heatmap ----------
  // matrix: rows x cols
  Charts.heatmap = function (matrix, opts) {
    opts = opts || {};
    const rows = matrix.length;
    const cols = matrix[0]?.length || 0;
    if (!rows || !cols) return '';
    const max = opts.max ?? Math.max(...matrix.flat());
    const min = opts.min ?? Math.min(...matrix.flat());
    const palette = opts.palette || ['var(--heat-0)', 'var(--heat-1)', 'var(--heat-2)', 'var(--heat-3)', 'var(--heat-4)', 'var(--heat-5)'];
    function color(v) {
      const t = (v - min) / Math.max(1e-9, max - min);
      const idx = Math.min(palette.length - 1, Math.max(0, Math.floor(t * (palette.length - 1))));
      const next = Math.min(palette.length - 1, idx + 1);
      // simple LERP between adjacent
      const lerpT = (t * (palette.length - 1)) - idx;
      return lerpHex(palette[idx], palette[next], lerpT);
    }
    function lerpHex(a, b, t) {
      const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
      const ar=(pa>>16)&255, ag=(pa>>8)&255, ab=pa&255;
      const br=(pb>>16)&255, bg=(pb>>8)&255, bb=pb&255;
      const r=Math.round(ar+(br-ar)*t), g=Math.round(ag+(bg-ag)*t), bl=Math.round(ab+(bb-ab)*t);
      return `rgb(${r},${g},${bl})`;
    }
    const cellW = opts.cellW || 16;
    const cellH = opts.cellH || 16;
    const gap = 2;
    const labels = opts.rowLabels || [];
    const labelW = labels.length ? 60 : 0;
    const colLabels = opts.colLabels || [];
    const colLabelH = colLabels.length ? 16 : 0;
    const w = labelW + cols * (cellW + gap);
    const h = colLabelH + rows * (cellH + gap);
    let svg = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">`;
    if (colLabels.length) {
      colLabels.forEach((c, i) => {
        if (i % Math.max(1, Math.floor(colLabels.length / 12)) === 0) {
          const x = labelW + i * (cellW + gap) + cellW/2;
          svg += `<text x="${x}" y="11" text-anchor="middle" fill="var(--fg-3)" font-size="9" font-family="ui-monospace,monospace">${c}</text>`;
        }
      });
    }
    for (let r=0; r<rows; r++) {
      if (labels.length) svg += `<text x="${labelW - 6}" y="${colLabelH + r * (cellH+gap) + cellH/2 + 3}" text-anchor="end" fill="var(--fg-2)" font-size="10" font-family="ui-monospace,monospace">${labels[r] || ''}</text>`;
      for (let c=0; c<cols; c++) {
        const v = matrix[r][c];
        const x = labelW + c * (cellW + gap);
        const y = colLabelH + r * (cellH + gap);
        svg += `<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="2" fill="${color(v)}"><title>${labels[r] || r}, ${colLabels[c] || c}: ${fmtNum(v)}</title></rect>`;
      }
    }
    svg += `</svg>`;
    return svg;
  };

  // ---------- Gauge ----------
  Charts.gauge = function (value, opts) {
    opts = opts || {};
    const max = opts.max || 1;
    const w = opts.width || 140, h = opts.height || 80;
    const cx = w/2, cy = h - 8, r = Math.min(cx, h) - 10;
    const startA = Math.PI, endA = 0; // 180deg arc
    function polar(angle, rr) { return [cx + Math.cos(angle) * rr, cy + Math.sin(-angle) * rr]; }
    const trackPath = `M${cx-r},${cy} A${r},${r} 0 0 1 ${cx+r},${cy}`;
    const t = Math.min(1, Math.max(0, value / max));
    const ang = startA + (endA - startA) * t;
    const [px, py] = polar(ang, r);
    const valPath = `M${cx-r},${cy} A${r},${r} 0 0 1 ${px.toFixed(1)},${py.toFixed(1)}`;
    const color = opts.color || (t >= 0.8 ? 'var(--ok)' : t >= 0.5 ? 'var(--warn)' : 'var(--danger)');
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMax meet">
      <path d="${trackPath}" stroke="var(--bg-3)" stroke-width="8" fill="none" stroke-linecap="round"/>
      <path d="${valPath}" stroke="${color}" stroke-width="8" fill="none" stroke-linecap="round"/>
      <text x="${cx}" y="${cy - r/2 + 4}" text-anchor="middle" font-size="18" font-family="ui-monospace,monospace" font-weight="600" fill="var(--fg-0)">${opts.label || (Math.round(t*100) + '%')}</text>
    </svg>`;
  };

  // ---------- Donut ----------
  Charts.donut = function (segments, opts) {
    opts = opts || {};
    const w = opts.width || 140, h = opts.height || 140;
    const cx = w/2, cy = h/2;
    const r = Math.min(cx, cy) - 4;
    const ir = r * 0.65;
    const total = segments.reduce((s, x) => s + x.value, 0);
    if (total === 0) return '';
    let a0 = -Math.PI/2;
    let svg = `<svg viewBox="0 0 ${w} ${h}">`;
    segments.forEach((s, i) => {
      const sweep = (s.value / total) * Math.PI * 2;
      const a1 = a0 + sweep;
      const x0 = cx + Math.cos(a0) * r, y0 = cy + Math.sin(a0) * r;
      const x1 = cx + Math.cos(a1) * r, y1 = cy + Math.sin(a1) * r;
      const ix0 = cx + Math.cos(a1) * ir, iy0 = cy + Math.sin(a1) * ir;
      const ix1 = cx + Math.cos(a0) * ir, iy1 = cy + Math.sin(a0) * ir;
      const large = sweep > Math.PI ? 1 : 0;
      const color = s.color || PALETTE[i % PALETTE.length];
      svg += `<path d="M${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1} L${ix0},${iy0} A${ir},${ir} 0 ${large} 0 ${ix1},${iy1} Z" fill="${color}" opacity="0.9"><title>${s.label}: ${fmtNum(s.value)}</title></path>`;
      a0 = a1;
    });
    if (opts.centerText) {
      svg += `<text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="14" font-family="ui-monospace,monospace" fill="var(--fg-0)" font-weight="600">${opts.centerText}</text>`;
      if (opts.centerSub) svg += `<text x="${cx}" y="${cy + 18}" text-anchor="middle" font-size="10" fill="var(--fg-2)">${opts.centerSub}</text>`;
    }
    svg += '</svg>';
    return svg;
  };

  WFM.Charts = Charts;
})(window.WFM = window.WFM || {});
