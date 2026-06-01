/* =========================================================
 * Module: User Management & Roles (Admin / Settings)
 *
 * Three sub-tabs:
 *   - Users  : table of users, add/edit/delete, assign role
 *   - Roles  : role catalogue with permission matrix
 *   - About  : explains the gating model and lists permissions
 *
 * All mutations go through WFM.RBAC, which enforces that only an
 * Admin (or whoever has admin.manage_users / admin.manage_roles)
 * can change things.
 * ========================================================= */
(function (WFM) {
  'use strict';
  const M = {};

  M.mount = function (root, state) {
    const UI = WFM.UI;
    let tab = 'users';

    render();
    const unsubscribe = WFM.RBAC.subscribe(() => render());

    function render() {
      UI.html(root, `
        <div class="page">
          <div class="page-head">
            <div>
              <h1>Settings — Users & Roles</h1>
              <div class="sub">Define who can do what. ${WFM.RBAC.currentUser()?.name ? `Acting as <b>${escapeHTML(WFM.RBAC.currentUser().name)}</b> (${WFM.RBAC.currentRole().label}).` : ''}</div>
            </div>
          </div>
          <div id="tabBar" style="margin-bottom: var(--space-4)"></div>
          <div id="tabBody"></div>
        </div>
      `);

      const tabBar = UI.tabs([
        { key: 'users', label: `Users (${WFM.RBAC.users().length})` },
        { key: 'roles', label: `Roles (${WFM.RBAC.roles().length})` },
        { key: 'vault', label: 'Data Vault' },
        { key: 'about', label: 'About RBAC' }
      ], tab, k => { tab = k; render(); });
      UI.$('#tabBar', root).appendChild(tabBar);

      const body = UI.$('#tabBody', root);
      if (tab === 'users')      renderUsersTab(body);
      else if (tab === 'roles') renderRolesTab(body);
      else if (tab === 'vault') renderVaultTab(body);
      else                      renderAboutTab(body);
    }

    /* ====================================================
     * DATA VAULT TAB — export, import, snapshots, quarantine
     * ==================================================== */
    function renderVaultTab(root) {
      const snapshots = WFM.Vault ? WFM.Vault.listSnapshots() : [];
      const quarantine = WFM.Vault ? WFM.Vault.listQuarantine() : [];
      const forecastRuns = WFM.Vault ? WFM.Vault.listForecastRuns() : [];

      root.innerHTML = `
        <div class="grid cols-2" style="grid-template-columns: 1fr; gap: var(--space-4)">
          <!-- Export / Import card -->
          <div class="card">
            <div class="card-head">
              <div>
                <h3>Backup & restore</h3>
                <div class="sub">Save your entire Atlas state to a portable JSON file, or restore from one.</div>
              </div>
            </div>
            <div class="card-body">
              <div style="display: flex; gap: 12px; flex-wrap: wrap">
                <button class="btn primary" id="exportBtn">${WFM.Icons.upload || '⬇'} Export all data</button>
                <label class="btn ghost" style="margin: 0; cursor: pointer">
                  ${WFM.Icons.upload || '⬆'} Import from file
                  <input type="file" id="importFile" accept=".json" style="display: none">
                </label>
              </div>
              <div class="muted t-small" style="margin-top: 12px; padding: 10px 12px; background: var(--bg-1); border-radius: var(--r-1)">
                <b>What's included:</b> products, queues with all channel data, regions and holiday calendars (including your per-queue overrides), RBAC users and roles, saved forecast runs, theme preference.
                <br><b>Import safety:</b> A snapshot of your current state is taken automatically before any import, so you can roll back instantly if needed.
              </div>
            </div>
          </div>

          <!-- Snapshots card -->
          <div class="card">
            <div class="card-head">
              <div>
                <h3>Auto-snapshots</h3>
                <div class="sub">${snapshots.length} snapshot${snapshots.length===1?'':'s'} (max 5, oldest discarded) · taken on every boot + before destructive operations</div>
              </div>
              <div class="actions">
                <button class="btn ghost" id="takeSnap">Take snapshot now</button>
              </div>
            </div>
            <div class="card-body" style="padding: 0">
              ${snapshots.length === 0 ? `
                <div class="empty" style="padding: 40px"><p>No snapshots yet — one will be taken on next app boot.</p></div>
              ` : `
                <table class="tbl">
                  <thead><tr><th>Taken</th><th>Reason</th><th>Contents</th><th class="num">Actions</th></tr></thead>
                  <tbody>
                    ${snapshots.map(s => {
                      const queueCount = s.data?.studio?.data?.queues?.length || 0;
                      const productCount = s.data?.products?.products?.length || 0;
                      return `
                        <tr data-sid="${s.id}">
                          <td style="font-family: var(--font-mono); font-size: 11px">${formatDate(s.takenAt)}</td>
                          <td><span class="badge ${s.reason === 'boot' ? 'info' : 'accent'}">${s.reason}</span></td>
                          <td class="muted t-small">${queueCount} queue${queueCount===1?'':'s'} · ${productCount} product${productCount===1?'':'s'}</td>
                          <td class="num">
                            <button class="btn ghost t-small snap-download" data-sid="${s.id}" style="padding: 2px 8px">Download</button>
                            <button class="btn ghost t-small snap-restore" data-sid="${s.id}" style="padding: 2px 8px; color: var(--accent)">Restore</button>
                            <button class="icon-btn snap-delete" data-sid="${s.id}" title="Delete">${WFM.Icons.close}</button>
                          </td>
                        </tr>
                      `;
                    }).join('')}
                  </tbody>
                </table>
              `}
            </div>
          </div>

          <!-- Forecast Runs card -->
          <div class="card">
            <div class="card-head">
              <div>
                <h3>Saved forecast runs</h3>
                <div class="sub">${forecastRuns.length} forecast${forecastRuns.length===1?'':'s'} saved · max 20 retained</div>
              </div>
            </div>
            <div class="card-body" style="padding: 0">
              ${forecastRuns.length === 0 ? `
                <div class="empty" style="padding: 40px"><p>No saved runs yet. Use the Forecasting Wizard to create one.</p></div>
              ` : `
                <table class="tbl">
                  <thead><tr><th>Name</th><th>Saved</th><th>Horizon</th><th>Channels</th><th class="num"></th></tr></thead>
                  <tbody>
                    ${forecastRuns.map(r => `
                      <tr data-rid="${r.id}">
                        <td><b>${escapeHTML(r.name)}</b></td>
                        <td style="font-family: var(--font-mono); font-size: 11px">${formatDate(r.savedAt)}</td>
                        <td class="muted">${r.horizon}w (locked ${r.lockedWeeks})</td>
                        <td class="muted">${(r.results?.forecasts || []).length}</td>
                        <td class="num">
                          <button class="icon-btn run-delete" data-rid="${r.id}" title="Delete">${WFM.Icons.close}</button>
                        </td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              `}
            </div>
          </div>

          ${quarantine.length > 0 ? `
            <!-- Quarantine card -->
            <div class="card" style="border-color: var(--warn-bg)">
              <div class="card-head">
                <div>
                  <h3>Quarantined data</h3>
                  <div class="sub">${quarantine.length} item${quarantine.length===1?'':'s'} preserved from migrations or restores. You can download to inspect, or delete to free space.</div>
                </div>
              </div>
              <div class="card-body" style="padding: 0">
                <table class="tbl">
                  <thead><tr><th>Quarantined</th><th>Kind</th><th>Reason</th><th class="num">Actions</th></tr></thead>
                  <tbody>
                    ${quarantine.map(q => `
                      <tr data-qid="${q.id}">
                        <td style="font-family: var(--font-mono); font-size: 11px">${formatDate(q.quarantinedAt)}</td>
                        <td><span class="badge warn">${q.kind}</span></td>
                        <td class="muted t-small">${escapeHTML(q.reason || '—')}</td>
                        <td class="num">
                          <button class="btn ghost t-small q-download" data-qid="${q.id}" style="padding: 2px 8px">Download</button>
                          <button class="icon-btn q-delete" data-qid="${q.id}" title="Delete">${WFM.Icons.close}</button>
                        </td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            </div>
          ` : ''}
        </div>
      `;

      // Wire export
      root.querySelector('#exportBtn').addEventListener('click', () => {
        const data = WFM.Vault.exportAll();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `atlas-backup-${new Date().toISOString().slice(0,10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        UI.toast('Backup downloaded', 'ok');
      });

      // Wire import
      root.querySelector('#importFile').addEventListener('change', e => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
          try {
            const payload = JSON.parse(ev.target.result);
            openImportDialog(payload);
          } catch (err) {
            UI.toast('Invalid JSON file', 'danger');
          }
          e.target.value = '';
        };
        reader.readAsText(file);
      });

      // Take manual snapshot
      root.querySelector('#takeSnap').addEventListener('click', () => {
        const s = WFM.Vault.takeSnapshot('manual');
        if (s) { UI.toast('Snapshot saved', 'ok'); render(); }
      });

      // Snapshot actions
      root.querySelectorAll('.snap-download').forEach(b => b.addEventListener('click', () => {
        const snap = WFM.Vault.listSnapshots().find(s => s.id === b.dataset.sid);
        if (!snap) return;
        const blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `atlas-snapshot-${snap.takenAt.replace(/[:.]/g, '-')}.json`;
        a.click();
        URL.revokeObjectURL(url);
      }));
      root.querySelectorAll('.snap-restore').forEach(b => b.addEventListener('click', () => {
        if (!confirm('Restore this snapshot? Your current data will be saved to quarantine and then replaced. You can always restore back from quarantine if needed.')) return;
        const result = WFM.Vault.restoreSnapshot(b.dataset.sid);
        if (result.ok) {
          UI.toast('Snapshot restored — reloading…', 'ok');
          setTimeout(() => location.reload(), 800);
        } else {
          UI.toast('Restore failed: ' + result.reason, 'danger');
        }
      }));
      root.querySelectorAll('.snap-delete').forEach(b => b.addEventListener('click', () => {
        if (!confirm('Delete this snapshot? This cannot be undone.')) return;
        WFM.Vault.deleteSnapshot(b.dataset.sid);
        render();
      }));

      // Forecast run delete
      root.querySelectorAll('.run-delete').forEach(b => b.addEventListener('click', () => {
        if (!confirm('Delete this saved forecast run?')) return;
        WFM.Vault.deleteForecastRun(b.dataset.rid);
        render();
      }));

      // Quarantine actions
      root.querySelectorAll('.q-download').forEach(b => b.addEventListener('click', () => {
        const q = WFM.Vault.listQuarantine().find(x => x.id === b.dataset.qid);
        if (!q) return;
        const blob = new Blob([JSON.stringify(q, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `atlas-quarantine-${q.quarantinedAt.replace(/[:.]/g, '-')}.json`;
        a.click();
        URL.revokeObjectURL(url);
      }));
      root.querySelectorAll('.q-delete').forEach(b => b.addEventListener('click', () => {
        if (!confirm('Permanently delete this quarantine entry?')) return;
        WFM.Vault.deleteQuarantine(b.dataset.qid);
        render();
      }));
    }

    function openImportDialog(payload) {
      const isValid = payload && payload.app === 'Atlas WFM' && payload.contents;
      if (!isValid) {
        WFM.UI.toast('Not a valid Atlas backup file', 'danger');
        return;
      }
      const c = payload.contents;
      const queues = c.studio?.data?.queues?.length || 0;
      const products = c.products?.products?.length || 0;
      const regions = c.regions?.regions?.length || 0;
      const users = c.rbac?.users?.length || 0;
      const runs = c.forecastRuns?.length || 0;

      const dialog = document.createElement('div');
      dialog.className = 'modal-scrim';
      dialog.innerHTML = `
        <div class="modal" style="max-width: 520px">
          <div class="modal-head">
            <h3>Import backup</h3>
            <button class="icon-btn" id="impClose">${WFM.Icons.close}</button>
          </div>
          <div class="modal-body stack">
            <div class="muted" style="font-size: 12.5px">
              <b>Exported:</b> ${formatDate(payload.exportedAt)}<br>
              <b>Contains:</b> ${queues} queue${queues===1?'':'s'}, ${products} product${products===1?'':'s'}, ${regions} region${regions===1?'':'s'}, ${users} user${users===1?'':'s'}, ${runs} forecast run${runs===1?'':'s'}
            </div>
            <div class="field">
              <label>Import mode</label>
              <label class="region-pick" style="margin-bottom: 6px">
                <input type="radio" name="impMode" value="replace" checked>
                <span>
                  <span style="font-size: 13px; color: var(--fg-0)"><b>Replace</b> (recommended)</span>
                  <span class="muted t-small">Wipes current state, restores from file. Most predictable.</span>
                </span>
              </label>
              <label class="region-pick">
                <input type="radio" name="impMode" value="merge">
                <span>
                  <span style="font-size: 13px; color: var(--fg-0)"><b>Merge</b></span>
                  <span class="muted t-small">Keep current data, add new entries from file (only Products merge; other stores fall back to Replace).</span>
                </span>
              </label>
            </div>
            <div class="muted t-small" style="padding: 8px 10px; background: var(--accent-bg); border-radius: var(--r-1)">
              ℹ A snapshot of your current state is taken before import. You can roll back any time.
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn ghost" id="impCancel">Cancel</button>
            <button class="btn primary" id="impGo">Import</button>
          </div>
        </div>
      `;
      document.body.appendChild(dialog);
      const close = () => dialog.remove();
      dialog.querySelector('#impClose').addEventListener('click', close);
      dialog.querySelector('#impCancel').addEventListener('click', close);
      dialog.addEventListener('click', e => { if (e.target === dialog) close(); });
      dialog.querySelector('#impGo').addEventListener('click', () => {
        const mode = dialog.querySelector('input[name="impMode"]:checked').value;
        const result = WFM.Vault.importAll(payload, mode);
        if (result.ok) {
          WFM.UI.toast('Imported — reloading…', 'ok');
          close();
          setTimeout(() => location.reload(), 800);
        } else {
          WFM.UI.toast('Import failed: ' + result.reason, 'danger');
        }
      });
    }

    function formatDate(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      return d.toLocaleString();
    }

    /* ====================================================
     * USERS TAB
     * ==================================================== */
    function renderUsersTab(root) {
      const users = WFM.RBAC.users();
      const roles = WFM.RBAC.roles();
      const me = WFM.RBAC.currentUser();
      const canManage = WFM.RBAC.can('admin.manage_users');

      root.innerHTML = `
        ${!canManage ? `<div style="padding: 10px 14px; margin-bottom: var(--space-3); background: var(--warn-bg); border-radius: var(--r-2); font-size: 13px; color: var(--warn)">🔒 Read-only — your role cannot manage users.</div>` : ''}

        <div class="card">
          <div class="card-head">
            <div><h3>Users</h3><div class="sub">${users.length} total · click a user to switch active account</div></div>
            <div class="actions">
              <button class="btn primary" id="addUser" data-perm="admin.manage_users">${WFM.Icons.plus} Add user</button>
            </div>
          </div>
          <div class="card-body" style="padding: 0">
            <table class="tbl">
              <thead><tr><th>User</th><th>Email</th><th>Role</th><th>Active</th><th></th></tr></thead>
              <tbody>
                ${users.map(u => {
                  const role = roles.find(r => r.id === u.roleId);
                  return `
                    <tr ${u.id === me.id ? 'class="selected"' : ''}>
                      <td>
                        <div style="display: flex; align-items: center; gap: 10px">
                          <div class="avatar">${initials(u.name)}</div>
                          <div style="flex:1; min-width:0">
                            <input class="inline-edit user-name-input" data-id="${u.id}" data-field="name"
                              value="${escapeHTML(u.name)}" ${canManage ? '' : 'readonly'}
                              title="${canManage ? 'Click to edit name' : 'You cannot edit users'}">
                            ${u.id === me.id ? '<span class="badge accent" style="margin-left:6px"><span class="dot"></span>you</span>' : ''}
                          </div>
                        </div>
                      </td>
                      <td>
                        <input class="inline-edit muted user-email-input" data-id="${u.id}" data-field="email"
                          value="${escapeHTML(u.email)}" ${canManage ? '' : 'readonly'}
                          title="${canManage ? 'Click to edit email' : 'You cannot edit users'}">
                      </td>
                      <td>
                        <select class="select role-select" data-id="${u.id}" ${canManage ? '' : 'disabled'}>
                          ${roles.map(r => `<option value="${r.id}" ${r.id === u.roleId ? 'selected' : ''}>${escapeHTML(r.label)}</option>`).join('')}
                        </select>
                      </td>
                      <td>
                        <input type="checkbox" class="user-active" data-id="${u.id}" ${u.active ? 'checked' : ''} ${canManage ? '' : 'disabled'}>
                      </td>
                      <td class="num">
                        <button class="btn ghost" data-act="switch" data-id="${u.id}" title="Act as this user">${WFM.Icons.user || ''} Act as</button>
                        <button class="icon-btn" data-act="del" data-id="${u.id}" ${u.id === me.id || !canManage ? 'disabled' : ''} title="Delete user">${WFM.Icons.close}</button>
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>

        <div class="muted t-small" style="margin-top: var(--space-3)">
          <b>Note:</b> This is a client-side guardrail, not a real authentication boundary. It prevents accidental destructive actions (e.g., a Scheduler deleting a queue), but does not protect against a determined user with developer tools.
        </div>
      `;

      root.querySelectorAll('.role-select').forEach(sel => {
        sel.addEventListener('change', e => {
          WFM.RBAC.updateUser(sel.dataset.id, { roleId: e.target.value });
          UI.toast('Role updated', 'ok');
          render();
        });
      });
      // Inline edits for name + email — save on blur or Enter
      root.querySelectorAll('.inline-edit').forEach(inp => {
        const original = inp.value;
        const commit = () => {
          const id = inp.dataset.id;
          const field = inp.dataset.field;
          const value = inp.value.trim();
          if (!value) {
            UI.toast(`${field === 'name' ? 'Name' : 'Email'} cannot be empty`, 'warn');
            inp.value = original;
            return;
          }
          if (field === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
            UI.toast('Invalid email format', 'warn');
            inp.value = original;
            return;
          }
          if (value === original) return;
          const ok = WFM.RBAC.updateUser(id, { [field]: value });
          if (ok === false) {
            UI.toast('Permission denied', 'warn');
            inp.value = original;
            return;
          }
          UI.toast(`${field === 'name' ? 'Name' : 'Email'} updated`, 'ok');
          render();
        };
        inp.addEventListener('blur', commit);
        inp.addEventListener('keydown', e => {
          if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
          if (e.key === 'Escape') { inp.value = original; inp.blur(); }
        });
      });
      root.querySelectorAll('.user-active').forEach(chk => {
        chk.addEventListener('change', e => {
          WFM.RBAC.updateUser(chk.dataset.id, { active: e.target.checked });
        });
      });
      root.querySelectorAll('[data-act="switch"]').forEach(b => {
        b.addEventListener('click', () => {
          WFM.RBAC.setCurrentUser(b.dataset.id);
          const u = WFM.RBAC.currentUser();
          UI.toast(`Now acting as ${u.name} (${WFM.RBAC.currentRole().label})`, 'ok');
          render();
        });
      });
      root.querySelectorAll('[data-act="del"]').forEach(b => {
        b.addEventListener('click', () => {
          const u = WFM.RBAC.users().find(x => x.id === b.dataset.id);
          if (!u) return;
          if (!confirm(`Delete ${u.name}?`)) return;
          if (WFM.RBAC.deleteUser(b.dataset.id)) {
            UI.toast(`Deleted ${u.name}`, 'ok');
            render();
          } else {
            UI.toast('Cannot delete — check permissions or self-delete', 'warn');
          }
        });
      });
      root.querySelector('#addUser')?.addEventListener('click', openAddUserDialog);
    }

    function openAddUserDialog() {
      if (!WFM.RBAC.requireOrToast('admin.manage_users')) return;
      const roles = WFM.RBAC.roles();
      const dialog = document.createElement('div');
      dialog.className = 'modal-scrim';
      dialog.innerHTML = `
        <div class="modal" style="max-width: 460px">
          <div class="modal-head">
            <h3>Add user</h3>
            <button class="icon-btn" id="auCancel">${WFM.Icons.close}</button>
          </div>
          <div class="modal-body stack">
            <div class="field">
              <label>Full name</label>
              <input class="input" id="auName" placeholder="e.g. Avery Patel" autocomplete="off">
            </div>
            <div class="field">
              <label>Email</label>
              <input class="input" id="auEmail" placeholder="avery.patel@example.com" autocomplete="off">
            </div>
            <div class="field">
              <label>Role</label>
              <select class="select" id="auRole">
                ${roles.map(r => `<option value="${r.id}">${escapeHTML(r.label)} — ${escapeHTML(r.description || '')}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn ghost" id="auCancel2">Cancel</button>
            <button class="btn primary" id="auCreate">Create user</button>
          </div>
        </div>
      `;
      document.body.appendChild(dialog);
      const close = () => dialog.remove();
      dialog.querySelector('#auCancel').addEventListener('click', close);
      dialog.querySelector('#auCancel2').addEventListener('click', close);
      dialog.addEventListener('click', e => { if (e.target === dialog) close(); });
      dialog.querySelector('#auCreate').addEventListener('click', () => {
        const name = dialog.querySelector('#auName').value.trim();
        const email = dialog.querySelector('#auEmail').value.trim();
        const roleId = dialog.querySelector('#auRole').value;
        if (!name || !email) { UI.toast('Name and email required', 'warn'); return; }
        WFM.RBAC.addUser({ name, email, roleId });
        UI.toast(`Added ${name}`, 'ok');
        close();
        render();
      });
      setTimeout(() => dialog.querySelector('#auName').focus(), 30);
    }

    /* ====================================================
     * ROLES TAB — permission grid
     * ==================================================== */
    function renderRolesTab(root) {
      const roles = WFM.RBAC.roles();
      const perms = Object.entries(WFM.RBAC.PERMISSIONS);
      const canManage = WFM.RBAC.can('admin.manage_roles');
      // Module-level state for the unlock toggle (reset each render is fine — survives within session via window flag)
      window.__editBuiltins = window.__editBuiltins || false;
      const editBuiltins = window.__editBuiltins;

      // Group permissions by domain prefix for readability
      const groups = {};
      perms.forEach(([id, label]) => {
        const grp = id.split('.')[0];
        if (!groups[grp]) groups[grp] = [];
        groups[grp].push({ id, label });
      });

      root.innerHTML = `
        ${!canManage ? `<div style="padding: 10px 14px; margin-bottom: var(--space-3); background: var(--warn-bg); border-radius: var(--r-2); font-size: 13px; color: var(--warn)">🔒 Read-only — your role cannot edit roles.</div>` : ''}

        ${canManage && editBuiltins ? `
          <div style="padding: 12px 14px; margin-bottom: var(--space-3); background: var(--danger-bg); border: 1px solid var(--danger); border-radius: var(--r-2); font-size: 13px; color: var(--danger); display: flex; align-items: center; gap: 10px">
            <span style="font-size: 16px">⚠</span>
            <div style="flex:1"><b>You are editing built-in roles.</b> Mistakes here can lock users out of platform functions. The Platform Admin role's <code>admin.*</code> permissions are hard-protected and cannot be removed.</div>
          </div>
        ` : ''}

        <div class="card">
          <div class="card-head">
            <div><h3>Roles</h3><div class="sub">${roles.length} roles · ${perms.length} permissions${editBuiltins ? ' · <span style="color:var(--danger)">built-ins unlocked</span>' : ''}</div></div>
            <div class="actions" style="gap: 8px">
              ${canManage ? `
                <label style="display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--fg-1); cursor: pointer">
                  <input type="checkbox" id="toggleBuiltins" ${editBuiltins ? 'checked' : ''}>
                  Edit built-in roles
                </label>
              ` : ''}
              <button class="btn primary" id="addRole" data-perm="admin.manage_roles">${WFM.Icons.plus} Add custom role</button>
            </div>
          </div>
          <div class="card-body" style="padding: 0; overflow-x: auto">
            <table class="tbl perm-matrix">
              <thead>
                <tr>
                  <th style="min-width: 240px; position: sticky; left: 0; background: var(--bg-2); z-index: 1">Permission</th>
                  ${roles.map(r => `
                    <th class="num" title="${escapeHTML(r.description || '')}">
                      <div>${escapeHTML(r.label)}</div>
                      <div class="muted t-small" style="font-weight: normal">${r.builtIn ? 'built-in' : 'custom'}</div>
                    </th>
                  `).join('')}
                </tr>
              </thead>
              <tbody>
                ${Object.entries(groups).map(([grp, items]) => `
                  <tr><td colspan="${roles.length + 1}" style="background: var(--bg-1); font-weight: 600; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--fg-2)">${grp}</td></tr>
                  ${items.map(p => `
                    <tr>
                      <td style="position: sticky; left: 0; background: var(--bg-2); z-index: 1">
                        <div>${escapeHTML(p.label)}</div>
                        <div class="muted t-small">${p.id}</div>
                      </td>
                      ${roles.map(r => {
                        const granted = r.perms.includes(p.id);
                        // Editable if you can manage AND (role is custom OR built-ins unlocked)
                        // Exception: admin role's admin.* perms are always locked
                        const adminProtected = r.id === 'admin' && p.id.startsWith('admin.');
                        const editable = canManage && (!r.builtIn || editBuiltins) && !adminProtected;
                        const tip = !canManage ? 'You cannot edit roles'
                                  : adminProtected ? 'Hard-protected: removing this would lock admin out'
                                  : r.builtIn && !editBuiltins ? 'Built-in role — toggle "Edit built-in roles" to unlock'
                                  : 'Click to toggle';
                        return `
                          <td class="num">
                            <input type="checkbox" class="perm-cell"
                              data-role="${r.id}" data-perm="${p.id}" data-builtin="${r.builtIn ? '1' : '0'}"
                              ${granted ? 'checked' : ''}
                              ${editable ? '' : 'disabled'}
                              title="${tip}">
                          </td>
                        `;
                      }).join('')}
                    </tr>
                  `).join('')}
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>

        ${roles.filter(r => !r.builtIn).length > 0 ? `
          <div class="card" style="margin-top: var(--space-3)">
            <div class="card-head"><div><h3>Custom roles</h3></div></div>
            <div class="card-body" style="padding: 0">
              <table class="tbl">
                <thead><tr><th>Role</th><th>Description</th><th class="num">Permissions</th><th></th></tr></thead>
                <tbody>
                  ${roles.filter(r => !r.builtIn).map(r => `
                    <tr>
                      <td><b>${escapeHTML(r.label)}</b></td>
                      <td class="muted">${escapeHTML(r.description || '—')}</td>
                      <td class="num">${r.perms.length}</td>
                      <td class="num"><button class="icon-btn" data-act="delRole" data-id="${r.id}" ${canManage ? '' : 'disabled'} title="Delete">${WFM.Icons.close}</button></td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        ` : ''}
      `;

      // Toggle
      root.querySelector('#toggleBuiltins')?.addEventListener('change', e => {
        window.__editBuiltins = e.target.checked;
        render();
      });

      root.querySelectorAll('.perm-cell').forEach(chk => {
        chk.addEventListener('change', e => {
          const role = chk.dataset.role;
          const perm = chk.dataset.perm;
          const isBuiltin = chk.dataset.builtin === '1';
          const result = WFM.RBAC.updateRolePerm(role, perm, e.target.checked, { force: isBuiltin && editBuiltins });
          if (!result.ok) {
            chk.checked = !chk.checked;
            const msg = ({
              builtin_protected: 'Toggle "Edit built-in roles" first to modify this role',
              admin_lockout_blocked: 'Cannot remove admin.* permissions from the admin role (lockout protection)',
              permission_denied: 'You do not have permission to edit roles'
            })[result.reason] || 'Cannot edit this permission';
            UI.toast(msg, 'warn');
          }
        });
      });
      root.querySelectorAll('[data-act="delRole"]').forEach(b => {
        b.addEventListener('click', () => {
          if (!confirm('Delete this custom role? Users with this role will be moved to Viewer.')) return;
          WFM.RBAC.deleteRole(b.dataset.id);
          render();
        });
      });
      root.querySelector('#addRole')?.addEventListener('click', openAddRoleDialog);
    }

    function openAddRoleDialog() {
      if (!WFM.RBAC.requireOrToast('admin.manage_roles')) return;
      const dialog = document.createElement('div');
      dialog.className = 'modal-scrim';
      dialog.innerHTML = `
        <div class="modal" style="max-width: 460px">
          <div class="modal-head">
            <h3>Add custom role</h3>
            <button class="icon-btn" id="arCancel">${WFM.Icons.close}</button>
          </div>
          <div class="modal-body stack">
            <div class="field">
              <label>Role label</label>
              <input class="input" id="arLabel" placeholder="e.g. Forecast Reviewer" autocomplete="off">
            </div>
            <div class="field">
              <label>Description (optional)</label>
              <input class="input" id="arDesc" placeholder="e.g. Reviews forecasts and adds annotations" autocomplete="off">
            </div>
            <div class="muted t-small">Set permissions in the matrix after creation.</div>
          </div>
          <div class="modal-foot">
            <button class="btn ghost" id="arCancel2">Cancel</button>
            <button class="btn primary" id="arCreate">Create role</button>
          </div>
        </div>
      `;
      document.body.appendChild(dialog);
      const close = () => dialog.remove();
      dialog.querySelector('#arCancel').addEventListener('click', close);
      dialog.querySelector('#arCancel2').addEventListener('click', close);
      dialog.addEventListener('click', e => { if (e.target === dialog) close(); });
      dialog.querySelector('#arCreate').addEventListener('click', () => {
        const label = dialog.querySelector('#arLabel').value.trim();
        if (!label) { UI.toast('Label required', 'warn'); return; }
        WFM.RBAC.addRole({ label, description: dialog.querySelector('#arDesc').value.trim() });
        UI.toast(`Created role "${label}"`, 'ok');
        close();
        render();
      });
      setTimeout(() => dialog.querySelector('#arLabel').focus(), 30);
    }

    /* ====================================================
     * ABOUT TAB — explain the gating model
     * ==================================================== */
    function renderAboutTab(root) {
      const perms = Object.entries(WFM.RBAC.PERMISSIONS);
      const groups = {};
      perms.forEach(([id, label]) => { const grp = id.split('.')[0]; (groups[grp] = groups[grp] || []).push({ id, label }); });

      root.innerHTML = `
        <div class="grid cols-2" style="grid-template-columns: 1.3fr 1fr; gap: var(--space-4)">
          <div class="card">
            <div class="card-head"><div><h3>How role-based access works</h3></div></div>
            <div class="card-body">
              <p style="color: var(--fg-1); line-height: 1.7">
                Each user has exactly one <b>role</b>. A role is a bundle of <b>permissions</b>.
                Throughout the app, destructive or sensitive actions check the current user's role
                before proceeding. If denied, the user sees a toast explaining what they can't do.
              </p>
              <p style="color: var(--fg-1); line-height: 1.7">
                The default roles match typical contact-center org structure:
              </p>
              <ul style="padding-left: 18px; line-height: 1.9; color: var(--fg-1)">
                <li><b>Platform Admin</b> — full access including user/role management.</li>
                <li><b>WFM Manager</b> — owns queues, data, forecasts, schedules. Cannot manage users.</li>
                <li><b>Forecaster / Analyst</b> — creates queues, edits actuals, runs forecasts. Read-only on schedules.</li>
                <li><b>Scheduler / RTA</b> — owns schedules and intraday. <b>Read-only on queues and forecasts</b> — cannot accidentally delete a queue.</li>
                <li><b>Viewer</b> — read-only across the platform.</li>
              </ul>
              <p style="color: var(--fg-1); line-height: 1.7; margin-top: var(--space-3)">
                Use the <b>Act as</b> button in the Users tab to switch active accounts and feel how the gating works.
              </p>
              <div style="margin-top: var(--space-3); padding: 10px 12px; background: var(--warn-bg); border-radius: var(--r-2); font-size: 12.5px; color: var(--warn)">
                <b>Honest limit:</b> these are client-side guardrails. A motivated user with browser dev tools can bypass them.
                Real auth requires a backend, which is on the Phase 6 roadmap (Okta / Azure AD SSO via OIDC).
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-head"><div><h3>Permission catalogue</h3><div class="sub">${perms.length} permissions across ${Object.keys(groups).length} domains</div></div></div>
            <div class="card-body" style="padding: 0; max-height: 540px; overflow-y: auto">
              ${Object.entries(groups).map(([grp, items]) => `
                <div style="padding: 8px 14px; background: var(--bg-1); font-weight: 600; font-size: 10px; letter-spacing: 0.10em; text-transform: uppercase; color: var(--fg-2); border-bottom: 1px solid var(--border-soft)">${grp}</div>
                ${items.map(p => `
                  <div style="padding: 10px 14px; border-bottom: 1px solid var(--border-soft)">
                    <div style="font-size: 13px"><b>${escapeHTML(p.label)}</b></div>
                    <div class="muted t-small">${p.id}</div>
                  </div>
                `).join('')}
              `).join('')}
            </div>
          </div>
        </div>

        <div class="card" style="margin-top: var(--space-4); border-color: var(--danger)">
          <div class="card-head">
            <div>
              <h3 style="color: var(--danger)">Reset users & roles to factory defaults</h3>
              <div class="sub">Restores the 5 built-in roles and 5 default users. Use this if your user list is out of sync after an app update.</div>
            </div>
            <div class="actions">
              <button class="btn" id="resetRbac" style="border-color: var(--danger); color: var(--danger)">${WFM.Icons.refresh} Reset to defaults</button>
            </div>
          </div>
          <div class="card-body">
            <p style="color: var(--fg-1); margin: 0; line-height: 1.6; font-size: 13px">
              This clears any saved users, custom roles, and permission overrides from your browser's local storage.
              All your own customizations will be lost. Queue data, forecasts, and schedules are not affected.
            </p>
          </div>
        </div>
      `;

      root.querySelector('#resetRbac')?.addEventListener('click', () => {
        if (!confirm('Reset all users and roles to defaults? Any custom users or roles will be lost.')) return;
        WFM.RBAC.resetToDefaults();
        UI.toast('Users and roles restored to defaults', 'ok');
        render();
      });
    }
  };

  function escapeHTML(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function initials(name) {
    return String(name || '?').split(/\s+/).slice(0, 2).map(s => s[0]).filter(Boolean).join('').toUpperCase();
  }

  WFM.Modules = WFM.Modules || {};
  WFM.Modules.admin = M;
})(window.WFM = window.WFM || {});
