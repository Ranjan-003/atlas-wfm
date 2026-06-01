/* =========================================================
 * Application Shell — boot, router, copilot drawer
 * ========================================================= */
(function (WFM) {
  'use strict';

  const NAV = [
    {
      label: 'COMMAND',
      items: [
        { key: 'dashboard', label: 'Dashboard',  icon: 'dashboard' }
      ]
    },
    {
      label: 'WORKFORCE',
      items: [
        { key: 'forecasting', label: 'Forecasting', icon: 'forecast' },
        { key: 'capacity',    label: 'Capacity',    icon: 'capacity' }
      ]
    },
    {
      label: 'INTELLIGENCE',
      items: [
        { key: 'wizard',      label: 'New Forecast',       icon: 'spark' },
        { key: 'products',    label: 'Products',           icon: 'product' },
        { key: 'data-studio', label: 'Forecast Workbench', icon: 'forecast' },
        { key: 'regions',     label: 'Regions & Holidays', icon: 'globe' },
        { key: 'scenarios',   label: 'Scenarios',   icon: 'scenarios' },
        { key: 'deflection',  label: 'AI Deflection', icon: 'deflection' },
        { key: 'analytics',   label: 'Analytics',   icon: 'analytics' }
      ]
    },
    {
      label: 'ADMINISTRATION',
      items: [
        { key: 'admin',       label: 'Settings',    icon: 'admin' }
      ]
    }
  ];

  const UI = WFM.UI;
  let cleanup = null;

  function boot() {
    // 1. Build dataset + hydrate persisted state from Vault
    const data = WFM.Data.build();
    const bootMeta = WFM.Vault ? WFM.Vault.recordBoot() : { previousBoot: null };
    const persistedStudio = WFM.Vault ? WFM.Vault.loadStudio() : null;
    // Take a boot snapshot so users can roll back if needed
    if (WFM.Vault && persistedStudio) WFM.Vault.takeSnapshot('boot');
    WFM.State.set({
      data,
      studio: persistedStudio || undefined,
      bootMeta
    });

    // 2. Render shell
    document.body.innerHTML = `
      <div class="app">
        <aside class="sidebar">
          <div class="brand">
            <div class="brand-mark">A</div>
            <div class="brand-name">ATLAS <span>WFM</span></div>
          </div>
          <div id="nav"></div>
          <div class="sidebar-foot">
            <div class="tenant-pill" id="tenantPill">
              <span class="dot"></span>
              <span id="tenantName">All tenants</span>
            </div>
          </div>
        </aside>

        <header class="topbar">
          <div class="crumbs" id="crumbs">
            <span>Atlas</span><span class="sep">/</span><span class="here">Dashboard</span>
          </div>
          <div class="search">
            ${WFM.Icons.search}
            <input id="globalSearch" placeholder="Search queues, agents, schedules…">
            <span class="kbd">⌘K</span>
          </div>
          <div class="top-actions">
            <button class="icon-btn" id="themeToggle" title="Toggle theme"></button>
            <button class="icon-btn" title="Notifications">${WFM.Icons.bell}<span class="pulse-dot"></span></button>
            <button class="icon-btn" title="Help">${WFM.Icons.help}</button>
            <button class="copilot-btn" id="copilotBtn">
              <span class="spark"></span>
              ${WFM.Icons.copilot}
              <span>Ask Copilot</span>
            </button>
            <div class="user-chip" id="userChip" title="Switch user">
              <div class="user-chip-avatar" id="userAvatar"></div>
              <div class="user-chip-meta">
                <div class="user-chip-name" id="userName"></div>
                <div class="user-chip-role" id="userRole"></div>
              </div>
              ${WFM.Icons.chevron_down || ''}
            </div>
          </div>
        </header>

        <main class="main" id="main"></main>
      </div>

      <div class="copilot-scrim" id="copilotScrim"></div>
      <aside class="copilot-drawer" id="copilotDrawer">
        <div class="copilot-head">
          <div style="width:28px;height:28px;background:var(--accent);color:var(--accent-fg);display:grid;place-items:center;border-radius:6px;font-family:var(--font-mono);font-weight:700">A</div>
          <div class="title">Atlas Copilot <small>grounded · read-only</small></div>
          <button class="icon-btn" id="closeCopilot">${WFM.Icons.close}</button>
        </div>
        <div class="copilot-body" id="copilotBody"></div>
        <div class="copilot-foot">
          <div class="copilot-input">
            <textarea id="copilotInput" placeholder="Ask about forecasts, capacity, queues…" rows="1"></textarea>
            <button class="copilot-send" id="copilotSend">${WFM.Icons.send}</button>
          </div>
          <div class="copilot-suggest" id="copilotSuggest"></div>
        </div>
      </aside>
    `;

    // 3. Build sidebar nav
    const navRoot = UI.$('#nav');
    NAV.forEach(group => {
      const g = UI.el('div', { class: 'nav-group' });
      g.appendChild(UI.el('div', { class: 'nav-label' }, group.label));
      group.items.forEach(item => {
        const btn = UI.el('button', {
          class: 'nav-item',
          'data-mod': item.key,
          onclick: () => navigate(item.key)
        });
        btn.innerHTML = `${WFM.Icons[item.icon] || ''}<span>${item.label}</span>`;
        g.appendChild(btn);
      });
      navRoot.appendChild(g);
    });

    // 4. Copilot wiring
    const drawer = UI.$('#copilotDrawer');
    const scrim = UI.$('#copilotScrim');
    const closeC = () => { drawer.classList.remove('open'); scrim.classList.remove('open'); };
    UI.$('#copilotBtn').addEventListener('click', () => { drawer.classList.add('open'); scrim.classList.add('open'); seedCopilot(); });
    UI.$('#closeCopilot').addEventListener('click', closeC);
    scrim.addEventListener('click', closeC);
    UI.$('#copilotSend').addEventListener('click', sendCopilot);
    UI.$('#copilotInput').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCopilot(); }
    });
    seedCopilot();

    // 5. Theme toggle (icon reflects current → click toggles)
    const themeBtn = UI.$('#themeToggle');
    function applyThemeIcon() {
      const t = document.documentElement.getAttribute('data-theme') || 'dark';
      themeBtn.innerHTML = t === 'dark' ? WFM.Icons.sun : WFM.Icons.moon;
      themeBtn.title = t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    }
    applyThemeIcon();
    themeBtn.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') || 'dark';
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('atlas-theme', next); } catch (_) {}
      applyThemeIcon();
      renderModule(); // re-render so any JS-resolved colors pick up new vars
    });

    // 5b. User switcher chip — reflects current RBAC user, opens picker on click
    function renderUserChip() {
      if (!WFM.RBAC) return;
      const u = WFM.RBAC.currentUser();
      const r = WFM.RBAC.currentRole();
      const initials = (u?.name || '?').split(' ').map(w => w[0]).slice(0,2).join('').toUpperCase();
      const av = UI.$('#userAvatar'); if (av) av.textContent = initials;
      const nm = UI.$('#userName');   if (nm) nm.textContent = u?.name || '—';
      const rl = UI.$('#userRole');   if (rl) rl.textContent = r?.label || '—';
    }
    renderUserChip();
    WFM.RBAC?.subscribe(() => { renderUserChip(); renderModule(); });

    UI.$('#userChip')?.addEventListener('click', () => {
      // Build a small picker over all users
      const users = WFM.RBAC.users();
      const current = WFM.RBAC.currentUser();
      let menu = document.getElementById('userMenu');
      if (menu) { menu.remove(); return; }
      menu = document.createElement('div');
      menu.id = 'userMenu';
      menu.className = 'user-menu';
      menu.innerHTML = `
        <div class="user-menu-head">
          <div class="t-micro">Switch user</div>
          <div class="muted t-small" style="margin-top:2px">Role-based permissions apply immediately</div>
        </div>
        ${users.map(u => {
          const r = WFM.RBAC.roles().find(rr => rr.id === u.roleId);
          const ini = u.name.split(' ').map(w => w[0]).slice(0,2).join('').toUpperCase();
          return `
            <div class="user-menu-item ${u.id === current.id ? 'active' : ''}" data-uid="${u.id}">
              <div class="user-chip-avatar" style="width:28px;height:28px;font-size:11px">${ini}</div>
              <div style="flex:1;min-width:0">
                <div style="font-size:12.5px;color:var(--fg-0)">${u.name}</div>
                <div class="muted t-small">${r?.label || u.roleId}</div>
              </div>
              ${u.id === current.id ? '<span class="badge ok"><span class="dot"></span>active</span>' : ''}
            </div>
          `;
        }).join('')}
        <div class="user-menu-foot">
          <button class="btn ghost" id="goSettings" style="width:100%">${WFM.Icons.settings || ''} Manage users & roles</button>
        </div>
      `;
      document.body.appendChild(menu);
      // Position under the chip
      const chip = UI.$('#userChip');
      const r = chip.getBoundingClientRect();
      menu.style.top = (r.bottom + 4) + 'px';
      menu.style.right = (window.innerWidth - r.right) + 'px';

      menu.querySelectorAll('.user-menu-item').forEach(item => {
        item.addEventListener('click', () => {
          WFM.RBAC.setCurrentUser(item.dataset.uid);
          menu.remove();
        });
      });
      UI.$('#goSettings', menu)?.addEventListener('click', () => { menu.remove(); location.hash = '#admin'; });
      // Click outside to dismiss
      setTimeout(() => {
        const off = e => { if (!menu.contains(e.target) && e.target.id !== 'userChip') { menu.remove(); document.removeEventListener('click', off); } };
        document.addEventListener('click', off);
      }, 0);
    });

    // 6. Global search hotkey
    document.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        UI.$('#globalSearch').focus();
      }
    });

    // 7. Hash router
    window.addEventListener('hashchange', applyHash);
    applyHash();

    // 8. Welcome-back toast — only when data was hydrated AND this isn't a fresh install
    const state = WFM.State.get();
    if (state.bootMeta?.previousBoot && state.studio?.queues?.length > 0) {
      setTimeout(() => {
        const last = new Date(state.bootMeta.previousBoot);
        const now = new Date();
        const hoursAgo = Math.round((now - last) / 36e5);
        const timeAgo = hoursAgo < 1 ? 'a few minutes ago' : hoursAgo < 24 ? `${hoursAgo}h ago` : `${Math.round(hoursAgo/24)}d ago`;
        UI.toast(`Welcome back. Your data was restored (last session ${timeAgo}).`, 'ok');
      }, 500);
    }
  }

  function navigate(modKey) {
    const queueId = WFM.State.get().queueId;
    if (queueId && ['forecasting','capacity','scenarios','deflection'].includes(modKey)) {
      location.hash = `#${modKey}/${queueId}`;
    } else {
      location.hash = `#${modKey}`;
    }
  }

  function applyHash() {
    const hash = location.hash.replace(/^#/, '') || 'dashboard';
    const [modKey, qid] = hash.split('/');
    const valid = NAV.flatMap(g => g.items).map(i => i.key);
    const mod = valid.includes(modKey) ? modKey : 'dashboard';
    WFM.State.set({ module: mod, queueId: qid || WFM.State.get().queueId });
    renderModule();
    updateNavActive(mod);
  }

  function updateNavActive(mod) {
    UI.$$('.nav-item').forEach(b => {
      b.classList.toggle('active', b.dataset.mod === mod);
    });
    const labelMap = NAV.flatMap(g => g.items).find(i => i.key === mod);
    UI.html(UI.$('#crumbs'), `<span>Atlas</span><span class="sep">/</span><span class="here">${labelMap?.label || mod}</span>`);
  }

  function renderModule() {
    if (cleanup) { try { cleanup(); } catch (_) {} cleanup = null; }
    const main = UI.$('#main');
    UI.empty(main);
    const state = WFM.State.get();
    const mod = WFM.Modules[state.module];
    if (!mod) {
      main.innerHTML = `<div class="empty"><h4>Module not found</h4><p>${state.module}</p></div>`;
      return;
    }
    try {
      cleanup = mod.mount(main, state) || null;
    } catch (e) {
      console.error(e);
      main.innerHTML = `<div class="empty"><h4>Error rendering module</h4><p>${e.message}</p></div>`;
    }
    main.scrollTop = 0;
  }

  // ---------- Copilot ----------
  function seedCopilot() {
    const body = UI.$('#copilotBody');
    if (body.dataset.seeded) return;
    body.dataset.seeded = '1';
    addMsg('bot', `Hi — I'm Atlas Copilot. I'm grounded in your platform data and won't make things up. Try one of these or ask anything.`);
    const sugWrap = UI.$('#copilotSuggest');
    WFM.Copilot.suggestions.forEach(s => {
      const chip = UI.el('button', { class: 'copilot-chip', onclick: () => { UI.$('#copilotInput').value = s; sendCopilot(); } }, s);
      sugWrap.appendChild(chip);
    });
  }

  function sendCopilot() {
    const inp = UI.$('#copilotInput');
    const text = inp.value.trim();
    if (!text) return;
    inp.value = '';
    addMsg('user', escapeHTML(text));
    setTimeout(() => {
      const r = WFM.Copilot.answer(text, WFM.State.get().data);
      let html = r.text;
      if (r.sources && r.sources.length) {
        html += `<div class="src">${r.sources.map(s => `<div><b>${s.label}</b>${s.detail ? ' · ' + s.detail : ''}</div>`).join('')}</div>`;
      }
      if (r.action) {
        html += `<div style="margin-top:8px"><button class="btn primary jumplink" data-mod="${r.action.module}" ${r.action.queueId ? `data-qid="${r.action.queueId}"` : ''}>${r.action.label}</button></div>`;
      }
      addMsg('bot', html);
      // Wire jump-link buttons
      const body = UI.$('#copilotBody');
      UI.$$('.jumplink', body).forEach(b => {
        if (b.dataset.wired) return;
        b.dataset.wired = '1';
        b.addEventListener('click', () => {
          const m = b.dataset.mod, q = b.dataset.qid;
          if (q) WFM.State.set({ queueId: q });
          if (q) location.hash = `#${m}/${q}`;
          else location.hash = `#${m}`;
          UI.$('#copilotDrawer').classList.remove('open');
          UI.$('#copilotScrim').classList.remove('open');
        });
      });
    }, 240);
  }

  function addMsg(kind, html) {
    const body = UI.$('#copilotBody');
    const m = UI.el('div', { class: `msg ${kind}` });
    m.innerHTML = `<div class="msg-avatar">${kind === 'user' ? 'U' : 'A'}</div><div class="msg-body">${html}</div>`;
    body.appendChild(m);
    body.scrollTop = body.scrollHeight;
  }

  function escapeHTML(s) {
    return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ---------- Init ----------
  document.addEventListener('DOMContentLoaded', boot);

})(window.WFM = window.WFM || {});
