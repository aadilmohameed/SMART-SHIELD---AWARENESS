/* =====================================================
   SmartShield CyberAware — auth.js
   Authentication & Session Management
   ===================================================== */

'use strict';

function login(email, password, role) {
  initSeedData();
  const user = findUserByEmail(email);
  if (!user) return { ok: false, error: 'No account found with this email address.' };
  if (user.password !== password) return { ok: false, error: 'Incorrect password. Please try again.' };
  if (user.role !== role) return { ok: false, error: `This account does not have ${role} access.` };
  if (user.status === 'inactive') return { ok: false, error: 'Your account has been deactivated. Contact your administrator.' };
  user.lastLogin = new Date().toISOString();
  dbSave(DB.USERS, user);
  setSession(user);
  // Log login event as alert for admin
  const loginAlert = { id: genId('al'), type:'info', message: user.name + ' logged in as ' + user.role, createdAt: new Date().toISOString(), read: false };
  if (user.role === 'admin') {
    // Don't log admin's own login - only employee logins are interesting
  } else {
    dbSave(DB.ALERTS, loginAlert);
  }
  return { ok: true, user };
}

function logout() {
  clearSession();
  window.location.href = rootPath() + 'index.html';
}

function requireAuth(role) {
  initSeedData();
  const user = getSession();
  if (!user) { window.location.href = rootPath() + 'index.html'; return null; }
  if (role && user.role !== role) { window.location.href = rootPath() + 'index.html'; return null; }
  return user;
}

function rootPath() {
  const p = window.location.pathname;
  // Handles: /Awareness/admin/..., /admin/..., /employee/...
  if (p.includes('/admin/') || p.includes('/employee/')) return '../';
  return '';
}

function redirectAfterLogin(role) {
  const base = rootPath();
  if (role === 'admin')    window.location.href = base + 'admin/dashboard.html';
  else                     window.location.href = base + 'employee/dashboard.html';
}

function getInitials(name) {
  return (name || '?').split(' ').slice(0, 2).map(p => p[0]).join('').toUpperCase();
}
