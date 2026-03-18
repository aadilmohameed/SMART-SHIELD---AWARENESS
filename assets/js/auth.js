'use strict';
/* =====================================================
   SmartShield CyberAware — auth.js  (FIXED)
   Fixes:
   1. redirectAfterLogin() — works on GitHub Pages
      (/Awareness/), localhost, and custom domains
   2. rootPath() — robust path detection
   3. login() — logs employee logins as admin alerts
   4. requireAuth() — graceful redirect with role check
   ===================================================== */

/**
 * Authenticate a user against localStorage.
 * Returns { ok, user } or { ok:false, error }
 */
function login(email, password, role) {
  initSeedData();

  /* Input sanitization */
  const cleanEmail = (email || '').trim().toLowerCase();
  const cleanPass  = (password || '').trim();

  if (!cleanEmail || !cleanPass) {
    return { ok: false, error: 'Please enter your email and password.' };
  }

  const user = findUserByEmail(cleanEmail);

  if (!user) {
    return { ok: false, error: 'No account found with this email address.' };
  }
  if (user.password !== cleanPass) {
    return { ok: false, error: 'Incorrect password. Please try again.' };
  }
  if (user.role !== role) {
    return { ok: false, error: `This account does not have ${role} access.` };
  }
  if (user.status === 'inactive') {
    return { ok: false, error: 'Your account has been deactivated. Contact your administrator.' };
  }

  /* Update last login timestamp */
  user.lastLogin = new Date().toISOString();
  dbSave(DB.USERS, user);
  setSession(user);

  /* Log employee logins as admin alerts (not admin own login) */
  if (user.role === 'employee') {
    const alert = {
      id:        genId('al'),
      type:      'info',
      message:   user.name + ' logged in (' + user.department + ')',
      createdAt: new Date().toISOString(),
      read:      false,
    };
    dbSave(DB.ALERTS, alert);
  }

  return { ok: true, user };
}

/**
 * Log the current user out and redirect to login page.
 */
function logout() {
  clearSession();
  window.location.href = rootPath() + 'index.html';
}

/**
 * Enforce authentication on a page.
 * Call at top of every protected page:
 *   const user = requireAuth('admin');  // or 'employee'
 * Returns the user object or null (and redirects).
 */
function requireAuth(role) {
  initSeedData();
  const user = getSession();

  if (!user) {
    window.location.href = rootPath() + 'index.html';
    return null;
  }
  if (role && user.role !== role) {
    /* Wrong role — redirect to their correct dashboard */
    redirectAfterLogin(user.role);
    return null;
  }
  return user;
}

/**
 * Compute the root path prefix.
 *
 * Handles all deployment scenarios:
 *   - GitHub Pages:  /Awareness/admin/  → prefix = ../
 *   - GitHub Pages:  /Awareness/        → prefix = ''
 *   - localhost:     /admin/            → prefix = ../
 *   - Netlify/Vercel/custom domain: same logic applies
 */
function rootPath() {
  const path = window.location.pathname;

  /* If we are inside a subfolder (admin/ or employee/) */
  if (path.match(/\/(admin|employee)\//)) {
    return '../';
  }

  /* Already at root — GitHub Pages repo subpath or localhost */
  return '';
}

/**
 * Redirect after successful login based on role.
 * Works for GitHub Pages /Awareness/, localhost, and custom domains.
 */
function redirectAfterLogin(role) {
  const base = rootPath();
  if (role === 'admin') {
    window.location.href = base + 'admin/dashboard.html';
  } else {
    window.location.href = base + 'employee/dashboard.html';
  }
}

/**
 * Get the two-letter uppercase initials from a name.
 */
function getInitials(name) {
  if (!name || typeof name !== 'string') return '?';
  return name.trim().split(/\s+/).slice(0, 2).map(p => p[0].toUpperCase()).join('');
}
