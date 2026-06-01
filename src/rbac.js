/* =========================================================
 * RBAC — Users, Roles, Permissions
 *
 * Client-side guardrails for accidental destructive actions.
 * NOT a security boundary — anyone with devtools can flip flags.
 * The goal: prevent a scheduler from accidentally deleting a queue
 * that a forecaster owns. That goal is achievable here.
 *
 * Public API:
 *   WFM.RBAC.can(permission)              → boolean
 *   WFM.RBAC.requireOrToast(permission)   → boolean (toasts a denial if false)
 *   WFM.RBAC.currentUser()                → user object
 *   WFM.RBAC.setCurrentUser(id)           → switch active user
 *   WFM.RBAC.subscribe(fn)                → notify on user change
 *
 * Persisted via localStorage so it survives page reloads.
 * ========================================================= */
(function (WFM) {
  'use strict';
  const STORAGE_KEY = 'atlas-rbac';

  // Schema version — bumped when defaults change. Older saved state with a
  // mismatched (or missing) schema is discarded so users get the up-to-date
  // default roster automatically.
  const SCHEMA_VERSION = 3;

  /* ====================================================
   * Permission catalogue — flat list, easy to grep for
   * ==================================================== */
  const PERMISSIONS = {
    // Queue management
    'queue.view':              'View queues',
    'queue.create':            'Create new queues',
    'queue.edit':              'Edit queue name, channel, settings',
    'queue.delete':            'Delete queues',
    'queue.bulk_seed':         'Bulk-create demo queues',

    // Data
    'data.edit_actuals':       'Edit historical volume numbers',
    'data.import':             'Import data from CSV / Excel / SQL',
    'data.connect_source':     'Configure external data sources',

    // Forecasting
    'forecast.run':            'Run forecasts and backtests',
    'forecast.override_model': 'Force a specific model instead of auto-select',

    // Scheduling / Intraday (read by default for everyone)
    'schedule.view':           'View published schedules',
    'schedule.edit':           'Edit schedules in draft',
    'schedule.publish':        'Publish schedules to agents',
    'intraday.intervene':      'Approve real-time interventions (OT, VTO, callbacks)',

    // Admin
    'admin.manage_users':      'Add / remove users, change roles',
    'admin.manage_roles':      'Define and edit roles',
    'admin.manage_regions':    'Edit regions and holiday calendars',
    'admin.audit':             'View audit log',
    'admin.connectors':        'Connect / disconnect external systems'
  };

  /* ====================================================
   * Default role library — sensible WFM org defaults
   * Built so a "Scheduler" cannot delete queues by mistake.
   * ==================================================== */
  const DEFAULT_ROLES = [
    {
      id: 'admin',
      label: 'Platform Admin',
      description: 'Full access, can manage users and roles',
      builtIn: true,
      perms: Object.keys(PERMISSIONS)
    },
    {
      id: 'wfm_manager',
      label: 'WFM Manager',
      description: 'Owns queues, data, forecasts, and schedules. Cannot manage users.',
      builtIn: true,
      perms: [
        'queue.view','queue.create','queue.edit','queue.delete','queue.bulk_seed',
        'data.edit_actuals','data.import','data.connect_source',
        'forecast.run','forecast.override_model',
        'schedule.view','schedule.edit','schedule.publish','intraday.intervene',
        'admin.manage_regions','admin.audit'
      ]
    },
    {
      id: 'forecaster',
      label: 'Forecaster / Analyst',
      description: 'Owns forecasting workflows. Can create queues and edit data, cannot publish schedules.',
      builtIn: true,
      perms: [
        'queue.view','queue.create','queue.edit',
        'data.edit_actuals','data.import',
        'forecast.run','forecast.override_model',
        'schedule.view',
        'admin.audit'
      ]
    },
    {
      id: 'scheduler',
      label: 'Scheduler / RTA',
      description: 'Owns schedules and intraday. Read-only on queues and forecasts.',
      builtIn: true,
      perms: [
        'queue.view',
        'forecast.run',
        'schedule.view','schedule.edit','schedule.publish','intraday.intervene'
      ]
    },
    {
      id: 'viewer',
      label: 'Viewer',
      description: 'Read-only access across the platform.',
      builtIn: true,
      perms: ['queue.view','schedule.view']
    }
  ];

  /* ====================================================
   * Default user roster — let the user see RBAC in action
   * without having to set anything up first
   * ==================================================== */
  const DEFAULT_USERS = [
    { id: 'u1', name: 'Alex Rivera',   email: 'alex.rivera@example.com',   roleId: 'admin',       active: true },
    { id: 'u2', name: 'Priya Iyer',    email: 'priya.iyer@example.com',    roleId: 'wfm_manager', active: true },
    { id: 'u3', name: 'Daniel Chen',   email: 'daniel.chen@example.com',   roleId: 'forecaster',  active: true },
    { id: 'u4', name: 'Marcus Wood',   email: 'marcus.wood@example.com',   roleId: 'scheduler',   active: true },
    { id: 'u5', name: 'Sofia Almeida', email: 'sofia.almeida@example.com', roleId: 'viewer',      active: true }
  ];

  /* ====================================================
   * State + persistence
   * ==================================================== */
  let state = load();
  const listeners = new Set();

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.schema === SCHEMA_VERSION && Array.isArray(parsed.users) && Array.isArray(parsed.roles) && parsed.currentUserId) {
          return parsed;
        }
      }
    } catch (_) {}
    return freshDefaults();
  }

  // Deep clone so subsequent mutations to state.roles/users don't leak back
  // into the DEFAULT_* constants and corrupt future resets.
  function freshDefaults() {
    const clone = (x) => JSON.parse(JSON.stringify(x));
    return { schema: SCHEMA_VERSION, users: clone(DEFAULT_USERS), roles: clone(DEFAULT_ROLES), currentUserId: 'u1' };
  }

  function save() {
    state.schema = SCHEMA_VERSION;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
    for (const fn of listeners) fn(state);
  }

  /* ====================================================
   * Public API
   * ==================================================== */
  const RBAC = {};

  RBAC.PERMISSIONS = PERMISSIONS;

  RBAC.users  = () => state.users.slice();
  RBAC.roles  = () => state.roles.slice();

  RBAC.currentUser = function () {
    return state.users.find(u => u.id === state.currentUserId) || state.users[0];
  };

  RBAC.currentRole = function () {
    const u = RBAC.currentUser();
    return state.roles.find(r => r.id === u.roleId);
  };

  RBAC.setCurrentUser = function (id) {
    if (state.users.find(u => u.id === id)) {
      state.currentUserId = id;
      save();
    }
  };

  RBAC.can = function (permission) {
    const role = RBAC.currentRole();
    if (!role) return false;
    return role.perms.includes(permission);
  };

  RBAC.requireOrToast = function (permission, customMsg) {
    if (RBAC.can(permission)) return true;
    const role = RBAC.currentRole();
    const label = PERMISSIONS[permission] || permission;
    const msg = customMsg || `${role?.label || 'Your role'} cannot ${label.toLowerCase()}.`;
    if (WFM.UI && WFM.UI.toast) WFM.UI.toast(msg, 'warn');
    return false;
  };

  RBAC.subscribe = function (fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };

  /* ---------- Mutations (only callable from admin UI) ---------- */
  RBAC.addUser = function (user) {
    if (!RBAC.can('admin.manage_users')) return false;
    const id = 'u' + (Date.now().toString(36));
    state.users.push({ id, active: true, ...user });
    save();
    return id;
  };

  RBAC.updateUser = function (id, patch) {
    if (!RBAC.can('admin.manage_users')) return false;
    const u = state.users.find(x => x.id === id);
    if (!u) return false;
    Object.assign(u, patch);
    save();
    return true;
  };

  RBAC.deleteUser = function (id) {
    if (!RBAC.can('admin.manage_users')) return false;
    if (id === state.currentUserId) return false;     // can't delete self
    state.users = state.users.filter(u => u.id !== id);
    save();
    return true;
  };

  RBAC.addRole = function (role) {
    if (!RBAC.can('admin.manage_roles')) return false;
    const id = 'role_' + (Date.now().toString(36));
    state.roles.push({ id, builtIn: false, perms: [], ...role });
    save();
    return id;
  };

  // Update a permission on a role.
  // Built-in roles are protected by default; pass { force: true } to override.
  // The admin role is hard-protected — its admin.* permissions can never be
  // removed (prevents accidental self-lockout from user/role management).
  RBAC.updateRolePerm = function (roleId, permission, granted, opts) {
    if (!RBAC.can('admin.manage_roles')) return { ok: false, reason: 'permission_denied' };
    const role = state.roles.find(r => r.id === roleId);
    if (!role) return { ok: false, reason: 'not_found' };
    if (role.builtIn && !(opts && opts.force)) return { ok: false, reason: 'builtin_protected' };
    // Hard lockout protection: admin must keep all admin.* permissions
    if (role.id === 'admin' && !granted && permission.startsWith('admin.')) {
      return { ok: false, reason: 'admin_lockout_blocked' };
    }
    const has = role.perms.includes(permission);
    if (granted && !has) role.perms.push(permission);
    else if (!granted && has) role.perms = role.perms.filter(p => p !== permission);
    save();
    return { ok: true };
  };

  RBAC.deleteRole = function (roleId) {
    if (!RBAC.can('admin.manage_roles')) return false;
    const role = state.roles.find(r => r.id === roleId);
    if (!role || role.builtIn) return false;
    // Move users on this role to viewer
    state.users.forEach(u => { if (u.roleId === roleId) u.roleId = 'viewer'; });
    state.roles = state.roles.filter(r => r.id !== roleId);
    save();
    return true;
  };

  // Reset users + roles back to factory defaults. Clears localStorage.
  // Useful when older app versions saved an incomplete user roster, or when
  // a user wants to start fresh.
  RBAC.resetToDefaults = function () {
    state = freshDefaults();
    save();
    return true;
  };

  WFM.RBAC = RBAC;
})(window.WFM = window.WFM || {});
