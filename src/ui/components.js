/* =========================================================
 * DOM helpers + reusable UI primitives
 * ========================================================= */
(function (WFM) {
  'use strict';
  const UI = {};

  // ---------- DOM helpers ----------
  UI.$  = (sel, root) => (root || document).querySelector(sel);
  UI.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  UI.el = (tag, attrs, children) => {
    const e = document.createElement(tag);
    if (attrs) for (const [k,v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else e.setAttribute(k, v);
    }
    if (children) {
      const arr = Array.isArray(children) ? children : [children];
      for (const c of arr) {
        if (c == null) continue;
        if (typeof c === 'string') e.appendChild(document.createTextNode(c));
        else e.appendChild(c);
      }
    }
    return e;
  };
  UI.html = (root, html) => { root.innerHTML = html; return root; };
  UI.empty = (root) => { while (root.firstChild) root.removeChild(root.firstChild); };

  // ---------- KPI tile ----------
  UI.kpiHTML = function (opts) {
    const { label, value, unit, delta, deltaDir, accent, sparkline } = opts;
    const dirClass = deltaDir === 'up' ? 'up' : deltaDir === 'down' ? 'down' : 'flat';
    const arrow = deltaDir === 'up' ? '▲' : deltaDir === 'down' ? '▼' : '◆';
    return `<div class="kpi${accent ? ' accent' : ''}">
      <div class="kpi-label">${label}</div>
      <div class="kpi-value">${value}${unit ? `<span class="unit">${unit}</span>` : ''}</div>
      <div class="kpi-foot">
        ${delta != null ? `<span class="kpi-delta ${dirClass}">${arrow} ${delta}</span>` : '<span class="kpi-delta flat">—</span>'}
        ${sparkline ? `<div class="kpi-spark" style="color:${opts.sparkColor || 'var(--accent)'}">${sparkline}</div>` : ''}
      </div>
    </div>`;
  };

  // ---------- Card wrapper ----------
  UI.card = function (titleHTML, bodyHTML, opts) {
    opts = opts || {};
    const head = titleHTML
      ? `<div class="card-head">${titleHTML}</div>`
      : '';
    return `<div class="card">${head}<div class="card-body ${opts.tight ? 'tight' : ''} ${opts.flush ? 'flush' : ''}">${bodyHTML}</div></div>`;
  };

  // ---------- Insight card ----------
  UI.insight = function (title, body, meta) {
    return `<div class="insight">
      <div class="icon">${WFM.Icons.lightning}</div>
      <div class="body">
        <b>${title}</b>
        <p>${body}</p>
        ${meta ? `<div class="meta">${meta}</div>` : ''}
      </div>
    </div>`;
  };

  // ---------- Status badge ----------
  UI.badge = function (text, kind) {
    return `<span class="badge ${kind || ''}"><span class="dot"></span>${text}</span>`;
  };

  // ---------- Coverage strip (intraday) ----------
  UI.coverageStrip = function (cov, req, opts) {
    opts = opts || {};
    const cells = cov.map((c, i) => {
      const r = req[i] || 0;
      const ratio = r === 0 ? 1 : c / r;
      const color = ratio >= 1 ? 'var(--ok)' :
                    ratio >= 0.9 ? 'var(--warn)' : 'var(--danger)';
      const op = Math.min(1, 0.35 + ratio * 0.45);
      return `<div class="cov-cell" title="Int ${i}: cov ${c.toFixed(1)} / req ${r.toFixed(1)}" style="background:${color};opacity:${op}"></div>`;
    }).join('');
    return `<div class="coverage-strip">${cells}</div>`;
  };

  // ---------- Modal ----------
  UI.openModal = function (titleHTML, bodyHTML, opts) {
    opts = opts || {};
    const scrim = UI.el('div', { class: 'modal-scrim' });
    scrim.innerHTML = `
      <div class="modal" role="dialog">
        <div class="modal-head"><h3>${titleHTML}</h3><button class="icon-btn close-modal">${WFM.Icons.close}</button></div>
        <div class="modal-body">${bodyHTML}</div>
        ${opts.footHTML ? `<div class="modal-foot">${opts.footHTML}</div>` : ''}
      </div>`;
    document.body.appendChild(scrim);
    requestAnimationFrame(() => scrim.classList.add('open'));
    const close = () => {
      scrim.classList.remove('open');
      setTimeout(() => scrim.remove(), 250);
      opts.onClose && opts.onClose();
    };
    scrim.addEventListener('click', e => { if (e.target === scrim) close(); });
    UI.$('.close-modal', scrim).addEventListener('click', close);
    return { close, root: scrim };
  };

  // ---------- Toast ----------
  let toastWrap;
  UI.toast = function (msg, kind) {
    if (!toastWrap) {
      toastWrap = UI.el('div', { class: 'toasts' });
      document.body.appendChild(toastWrap);
    }
    const t = UI.el('div', { class: `toast ${kind || ''}`, html: msg });
    toastWrap.appendChild(t);
    setTimeout(() => {
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 200);
    }, 3200);
  };

  // ---------- Tabs ----------
  // Renders tabs; returns container + setActive function
  UI.tabs = function (tabs, activeKey, onChange) {
    const wrap = UI.el('div', { class: 'tabs' });
    tabs.forEach(t => {
      const el = UI.el('div', {
        class: 'tab' + (t.key === activeKey ? ' active' : ''),
        onclick: () => onChange(t.key)
      }, t.label);
      wrap.appendChild(el);
    });
    return wrap;
  };

  // ---------- Bar (progress) ----------
  UI.bar = function (pct, opts) {
    opts = opts || {};
    const w = Math.max(0, Math.min(100, pct * 100));
    let cls = '';
    if (opts.thresholds) {
      if (pct < opts.thresholds[0]) cls = 'danger';
      else if (pct < opts.thresholds[1]) cls = 'warn';
      else cls = 'ok';
    }
    return `<div class="bar"><div class="bar-fill ${cls}" style="width:${w}%"></div></div>`;
  };

  WFM.UI = UI;
})(window.WFM = window.WFM || {});
