/* =====================================================
   SmartShield CyberAware — auth.js  (FIXED)
   Authentication & Session Management
   
   FIXES APPLIED:
   - BUG-024: Fixed redirectAfterLogin for GitHub Pages paths
   - Improved rootPath() to handle any repo name
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
  // Log employee logins as alerts for admin
  if (user.role !== 'admin') {
    const loginAlert = { id: genId('al'), type:'info', message: user.name + ' logged in', createdAt: new Date().toISOString(), read: false };
    dbSave(DB.ALERTS, loginAlert);
  }
  return { ok: true, user };
}

function logout() {
  clearSession();
  window.location.href = getBasePath() + 'index.html';
}

function requireAuth(role) {
  initSeedData();
  const user = getSession();
  if (!user) { window.location.href = getBasePath() + 'index.html'; return null; }
  if (role && user.role !== role) { window.location.href = getBasePath() + 'index.html'; return null; }
  return user;
}

/**
 * FIX BUG-024: Robust base path detection for GitHub Pages
 * Handles: /SMART-SHIELD---AWARENESS/admin/dashboard.html
 *          /SMART-SHIELD---AWARENESS/index.html
 *          /admin/dashboard.html (local dev)
 *          /index.html (local dev)
 */
function getBasePath() {
  const p = window.location.pathname;
  // Check if we're in a subfolder (admin/ or employee/)
  const inSubfolder = /\/(admin|employee)\//.test(p);
  if (inSubfolder) {
    // Go up one level from admin/ or employee/
    // e.g. /REPO/admin/dashboard.html → /REPO/
    return p.replace(/\/(admin|employee)\/.*$/, '/');
  }
  // We're at root level — return the directory
  // e.g. /REPO/index.html → /REPO/
  // e.g. /index.html → /
  return p.replace(/\/[^/]*$/, '/');
}

// Keep backward compatibility
function rootPath() {
  return getBasePath();
}

function redirectAfterLogin(role) {
  const base = getBasePath();
  if (role === 'admin') window.location.href = base + 'admin/dashboard.html';
  else                  window.location.href = base + 'employee/dashboard.html';
}

function getInitials(name) {
  return (name || '?').split(' ').slice(0, 2).map(p => p[0]).join('').toUpperCase();
}
