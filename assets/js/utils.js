/* =====================================================
   SmartShield CyberAware — utils.js
   UI Utilities, Sidebar, Charts, Badges
   ===================================================== */

'use strict';

/* ── Date Helpers ── */
function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-SA', { day:'2-digit', month:'short', year:'numeric' });
}
function formatDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-SA', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
}
function daysAgo(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const diff = Date.now() - d.getTime();
  const days = Math.floor(diff / 86400000);
  if (days < 0)  return 'In ' + Math.abs(days) + ' days';
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7)  return `${days} days ago`;
  return formatDate(iso);
}
function isOverdue(dateStr) {
  if (!dateStr) return false;
  return new Date(dateStr) < new Date();
}
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const diff = new Date(dateStr) - Date.now();
  return Math.ceil(diff / 86400000);
}

/* ── String Helpers ── */
function truncate(str, n = 60) { return str && str.length > n ? str.slice(0, n) + '…' : (str || ''); }
function capitalize(str)        { return str ? str.charAt(0).toUpperCase() + str.slice(1) : ''; }
function escHtml(str)           { const d = document.createElement('div'); d.textContent = str || ''; return d.innerHTML; }

/* ── Toast Notifications ── */
function showToast(msg, type = 'success', duration = 3500) {
  const icons = { success:'✅', error:'❌', warning:'⚠️', info:'ℹ️' };
  const tc = document.getElementById('toast-container');
  if (!tc) return;
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span class="toast-icon">${icons[type]||'💬'}</span><span>${escHtml(msg)}</span>`;
  tc.appendChild(t);
  setTimeout(() => { t.style.animation = 'toast-out .3s ease forwards'; setTimeout(() => t.remove(), 320); }, duration);
}

/* ── Confirm Dialog ── */
function showConfirm(msg, onConfirm, title = 'Confirm Action') {
  let cd = document.getElementById('confirm-dialog-global');
  if (!cd) {
    cd = document.createElement('div');
    cd.id = 'confirm-dialog-global';
    cd.className = 'confirm-backdrop';
    cd.innerHTML = `<div class="confirm-dialog"><h4 id="cd-title"></h4><p id="cd-msg"></p><div class="confirm-actions"><button class="btn btn-ghost" id="cd-cancel">Cancel</button><button class="btn btn-danger" id="cd-ok">Confirm</button></div></div>`;
    document.body.appendChild(cd);
  }
  document.getElementById('cd-title').textContent = title;
  document.getElementById('cd-msg').textContent   = msg;
  cd.classList.add('active');
  document.getElementById('cd-ok').onclick     = () => { cd.classList.remove('active'); onConfirm(); };
  document.getElementById('cd-cancel').onclick = () => cd.classList.remove('active');
}

/* ── Modals ── */
function openModal(id)    { const m = document.getElementById(id); if (m) m.classList.add('active'); }
function closeModal(id)   { const m = document.getElementById(id); if (m) m.classList.remove('active'); }
function closeAllModals() { document.querySelectorAll('.modal-backdrop').forEach(m => m.classList.remove('active')); }
document.addEventListener('click', e => { if (e.target.classList.contains('modal-backdrop')) closeAllModals(); });

/* ── Table Filter ── */
function filterTable(inputId, tableId, colIndices) {
  const input = document.getElementById(inputId);
  const table = document.getElementById(tableId);
  if (!input || !table) return;
  input.addEventListener('input', () => {
    const q = input.value.toLowerCase();
    table.querySelectorAll('tbody tr').forEach(row => {
      const text = (colIndices || [0,1,2,3]).map(i => (row.cells[i] ? row.cells[i].textContent : '')).join(' ').toLowerCase();
      row.style.display = text.includes(q) ? '' : 'none';
    });
  });
}

/* ── Active Nav ── */
function setActiveNav() {
  const path = window.location.pathname.split('/').pop();
  document.querySelectorAll('.nav-item').forEach(a => {
    const href = (a.getAttribute('href') || '').split('/').pop();
    a.classList.toggle('active', href === path);
  });
}

/* ── Sidebar ── */
function buildSidebar(user) {
  const isAdmin = user.role === 'admin';
  const avatarBg = user.color || '#0ea5e9';
  const initials = getInitials(user.name);
  const alerts = (typeof dbGet !== 'undefined' ? dbGet(DB.ALERTS) : []).filter(a => !a.read);
  const alertDot = alerts.length > 0 ? `<span class="nav-badge">${alerts.length}</span>` : '';
  const phCampaigns = (typeof dbGet !== 'undefined' ? dbGet(DB.PHISHING) : []).filter(p => p.status === 'active');
  const liveBadge = phCampaigns.length > 0 ? `<span class="nav-badge live">Live</span>` : '';

  const adminNav = `
    <div class="nav-section-title">Overview</div>
    <a href="dashboard.html"  class="nav-item"><span class="nav-icon">📊</span><span class="nav-label">Dashboard</span>${alertDot}</a>
    <div class="nav-section-title">Awareness</div>
    <a href="modules.html"    class="nav-item"><span class="nav-icon">📚</span><span class="nav-label">Training Modules</span></a>
    <a href="quizzes.html"    class="nav-item"><span class="nav-icon">❓</span><span class="nav-label">Quizzes & Assessments</span></a>
    <a href="phishing.html"   class="nav-item"><span class="nav-icon">🎣</span><span class="nav-label">Phishing Simulations</span>${liveBadge}</a>
    <div class="nav-section-title">Compliance</div>
    <a href="compliance.html" class="nav-item"><span class="nav-icon">🛡️</span><span class="nav-label">Compliance Matrix</span></a>
    <a href="reports.html"    class="nav-item"><span class="nav-icon">📈</span><span class="nav-label">Reports & Analytics</span></a>
    <div class="nav-section-title">Administration</div>
    <a href="users.html"      class="nav-item"><span class="nav-icon">👥</span><span class="nav-label">Users & Departments</span></a>
    <a href="settings.html"   class="nav-item"><span class="nav-icon">⚙️</span><span class="nav-label">Settings</span></a>
    <a href="azure.html"      class="nav-item"><span class="nav-icon">☁️</span><span class="nav-label">Microsoft 365</span></a>`;

  const empEnrolls = dbGet(DB.ENROLLMENTS).filter(e => e.userId === user.id);
  const overdue = empEnrolls.filter(e => e.status === 'overdue').length;
  const dueBadge = overdue > 0 ? `<span class="nav-badge">${overdue}</span>` : '';
  const employeeNav = `
    <div class="nav-section-title">My Portal</div>
    <a href="dashboard.html"    class="nav-item"><span class="nav-icon">🏠</span><span class="nav-label">My Dashboard</span></a>
    <a href="training.html"     class="nav-item"><span class="nav-icon">📚</span><span class="nav-label">Training Library</span>${dueBadge}</a>
    <div class="nav-section-title">My Learning</div>
    <a href="assessments.html"  class="nav-item"><span class="nav-icon">📋</span><span class="nav-label">My Assessments</span></a>
    <a href="phishing.html"     class="nav-item"><span class="nav-icon">🎣</span><span class="nav-label">Phishing Results</span></a>
    <a href="profile.html"      class="nav-item"><span class="nav-icon">🛡️</span><span class="nav-label">My Profile & Certs</span></a>`;

  return `
    <div class="sidebar-brand">
      <div class="brand-icon">🛡️</div>
      <div class="brand-text">
        <div class="brand-name">SmartShield</div>
        <div class="brand-sub">Cyber Awareness</div>
      </div>
    </div>
    <div class="sidebar-user">
      <div class="user-avatar" style="background:${avatarBg}">${initials}</div>
      <div class="user-info">
        <div class="user-name">${escHtml(user.name)}</div>
        <div class="user-role">${capitalize(user.role)}</div>
      </div>
    </div>
    <nav class="sidebar-nav">${isAdmin ? adminNav : employeeNav}</nav>
    <div class="sidebar-footer">
      <a href="#" onclick="logout();return false;" class="nav-item"><span class="nav-icon">🚪</span><span class="nav-label">Sign Out</span></a>
    </div>`;
}

function initPage(role) {
  const user = requireAuth(role);
  if (!user) return null;
  const sb = document.getElementById('sidebar');
  if (sb) sb.innerHTML = buildSidebar(user);
  setActiveNav();
  const nameEl = document.getElementById('user-name');
  if (nameEl) nameEl.textContent = user.name;
  const hName = document.querySelector('.h-name');
  if (hName) hName.textContent = user.name;
  const hRole = document.querySelector('.h-role');
  if (hRole) hRole.textContent = capitalize(user.role);
  const hAvatar = document.querySelector('.h-avatar');
  if (hAvatar) { hAvatar.textContent = getInitials(user.name); hAvatar.style.background = user.color || '#0ea5e9'; }
  return user;
}

/* ── Badge Helpers ── */
function riskBadge(score) {
  if (score >= 70) return `<span class="badge badge-critical">🔴 Critical</span>`;
  if (score >= 50) return `<span class="badge badge-high">🟠 High</span>`;
  if (score >= 30) return `<span class="badge badge-medium">🟡 Medium</span>`;
  return `<span class="badge badge-low">🟢 Low</span>`;
}
function riskBadgeFromLevel(level) {
  const map = { critical:'badge-critical', high:'badge-high', medium:'badge-medium', low:'badge-low' };
  return `<span class="badge ${map[level]||'badge-gray'}">${capitalize(level||'Unknown')}</span>`;
}
function complianceBadge(pct) {
  if (pct >= 80) return `<span class="badge badge-success">✅ Compliant (${pct}%)</span>`;
  if (pct >= 40) return `<span class="badge badge-warning">⚠️ Partial (${pct}%)</span>`;
  return `<span class="badge badge-danger">❌ Non-Compliant (${pct}%)</span>`;
}
function statusBadge(status) {
  const map = {
    completed:    '<span class="badge badge-success">✅ Completed</span>',
    'in-progress':'<span class="badge badge-info">🔄 In Progress</span>',
    'not-started':'<span class="badge badge-gray">⭕ Not Started</span>',
    overdue:      '<span class="badge badge-danger">⏰ Overdue</span>',
    active:       '<span class="badge badge-success">🟢 Active</span>',
    inactive:     '<span class="badge badge-gray">⚫ Inactive</span>',
    published:    '<span class="badge badge-success">✅ Published</span>',
    draft:        '<span class="badge badge-gray">📝 Draft</span>',
    compliant:    '<span class="badge badge-success">✅ Compliant</span>',
    partial:      '<span class="badge badge-warning">⚠️ Partial</span>',
    'non-compliant':'<span class="badge badge-danger">❌ Non-Compliant</span>',
  };
  return map[status] || `<span class="badge badge-gray">${capitalize(status||'Unknown')}</span>`;
}
function frameworkBadge(code) {
  const map = {
    'NCA-ECC': '<span class="badge badge-nca">NCA</span>',
    'SAMA':    '<span class="badge badge-sama">SAMA</span>',
    'CST':     '<span class="badge badge-cst">CST</span>',
  };
  return map[code] || `<span class="badge badge-gray">${code}</span>`;
}
function difficultyBadge(d) {
  const map = { beginner:'badge-success', intermediate:'badge-warning', advanced:'badge-danger' };
  return `<span class="badge ${map[d]||'badge-gray'}">${capitalize(d)}</span>`;
}
function progressBar(pct, cls = '') {
  const color = pct >= 80 ? 'success' : pct >= 40 ? 'warning' : pct > 0 ? '' : 'danger';
  return `<div class="progress"><div class="progress-bar ${color} ${cls}" style="width:${pct}%"></div></div>`;
}
function avatarHtml(user, size = 'md') {
  return `<div class="avatar avatar-${size}" style="background:${user.color||'#0ea5e9'};color:#fff">${getInitials(user.name)}</div>`;
}

/* ── Chart Helpers ── */
function renderDonutChart(containerId, pct, color) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const c = color || (pct >= 80 ? '#22c55e' : pct >= 40 ? '#f59e0b' : '#ef4444');
  el.style.setProperty('--pct', Math.min(100, pct));
  el.style.background = `conic-gradient(${c} 0% ${pct}%, var(--gray-200) ${pct}% 100%)`;
  const label = el.querySelector('.donut-label');
  if (label) label.textContent = pct + '%';
}

function renderBarChart(containerId, data) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const max = Math.max(...data.map(d => d.value), 1);
  el.innerHTML = data.map(d => {
    const w = Math.round((d.value / max) * 100);
    const color = d.color || (d.value >= 80 ? '#22c55e' : d.value >= 40 ? '#f59e0b' : '#ef4444');
    return `<div class="bar-chart-row">
      <div class="bar-label" title="${escHtml(d.label)}">${escHtml(d.label)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${w}%;background:${color}"></div></div>
      <div class="bar-pct">${d.value}%</div>
    </div>`;
  }).join('');
}

function heatmapColor(pct) {
  if (pct >= 80) return '#16a34a';
  if (pct >= 60) return '#22c55e';
  if (pct >= 40) return '#f59e0b';
  if (pct >= 20) return '#f97316';
  if (pct >  0)  return '#ef4444';
  return '#9ca3af';
}

/* ── Certificate ── */
function renderCertificate(containerEl, user, mod, result) {
  if (!containerEl) return;
  containerEl.innerHTML = `
    <div class="certificate">
      <div class="cert-logo">🛡️</div>
      <div class="cert-title">Certificate of Completion</div>
      <div class="cert-name">${escHtml(user.name)}</div>
      <div class="cert-sub">has successfully completed</div>
      <div class="cert-module">${escHtml(mod ? mod.title : 'Cybersecurity Training')}</div>
      <div class="cert-score">Score: ${result ? result.percentage : 100}% ${result && result.passed ? '✅ Passed' : ''}</div>
      <div class="cert-date">Completed on ${formatDate(result ? result.submittedAt : new Date().toISOString())}</div>
      <div class="cert-footer">
        <div class="cert-issuer">Smart Shield Cyber Security</div>
        <div class="cert-issuer-sub">MSSP Cybersecurity Awareness Platform | NCA · SAMA · CST Certified</div>
      </div>
    </div>`;
}

/* ── Phishing Landing Handler ── */
function handlePhishingLanding() {
  const params = new URLSearchParams(window.location.search);
  const campaignId = params.get('campaign');
  const userId     = params.get('uid');
  const eventType  = params.get('event') || 'clicked';
  if (campaignId && userId) recordPhishingEvent(campaignId, userId, eventType);
}

/* ── Framework Helpers ── */
function getFrameworks() { return dbGet(DB.FRAMEWORKS); }
function getModuleFrameworks(moduleId) {
  const mod = dbGetOne(DB.MODULES, moduleId);
  if (!mod) return [];
  const codes = [...new Set((mod.frameworkControls || []).map(fc => fc.framework))];
  return codes;
}
function ctrlChip(ctrl) {
  const cls = ctrl.framework === 'NCA-ECC' ? 'nca' : ctrl.framework === 'SAMA' ? 'sama' : 'cst';
  return `<span class="ctrl-chip ${cls}" title="${ctrl.framework}">${ctrl.control}</span>`;
}
function moduleFrameworkChips(mod) {
  return (mod.frameworkControls || []).map(fc => ctrlChip(fc)).join(' ');
}

/* ── Misc ── */
function formatCurrency(amount) { return 'SAR ' + Number(amount||0).toLocaleString('en-SA', { minimumFractionDigits:2 }); }
function getOrgOverallScore() {
  const codes = ['NCA-ECC','SAMA','CST'];
  const scores = codes.map(c => getOrgComplianceScore(c));
  return Math.round(scores.reduce((a,b)=>a+b,0)/scores.length);
}

/* ── Tabs ── */
function initTabs(tabsId) {
  const container = document.getElementById(tabsId);
  if (!container) return;
  container.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const target = btn.dataset.tab;
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      const panel = document.getElementById(target);
      if (panel) panel.classList.add('active');
    });
  });
}
