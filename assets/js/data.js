/* =====================================================
   SmartShield CyberAware — data.js  (FIXED)
   Data layer: LocalStorage CRUD + Seed Data
   
   FIXES APPLIED:
   - BUG-001: Removed duplicate getOrgOverallScore (canonical source)
   - BUG-004/006: Fixed department name mismatch in seed data
   - BUG-014: Separated overdue auto-update from getUserEnrollments reads
   - BUG-017: Batched risk score updates in campaign creation
   - BUG-002/003: Fixed sendBatchEmails callback signature in notifyCampaignUsers
   ===================================================== */

'use strict';

/* ── DB Keys ── */
const DB = {
  USERS:            'cap_users',
  DEPARTMENTS:      'cap_departments',
  MODULES:          'cap_modules',
  QUIZZES:          'cap_quizzes',
  ENROLLMENTS:      'cap_enrollments',
  QUIZ_RESULTS:     'cap_quiz_results',
  PHISHING:         'cap_phishing',
  PHISHING_EVENTS:  'cap_phishing_events',
  COMPLIANCE:       'cap_compliance',
  FRAMEWORKS:       'cap_frameworks',
  ALERTS:           'cap_alerts',
  SESSION:          'cap_session',
};

/* ── Generic CRUD ── */
function dbGet(key) {
  try { return JSON.parse(localStorage.getItem(key)) || []; }
  catch(e) { return []; }
}
function dbSet(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}
function dbGetOne(key, id) {
  return dbGet(key).find(i => i.id === id) || null;
}
function dbSave(key, item) {
  const items = dbGet(key);
  const idx = items.findIndex(i => i.id === item.id);
  if (idx >= 0) items[idx] = item;
  else items.push(item);
  dbSet(key, items);
  return item;
}
function dbDelete(key, id) {
  dbSet(key, dbGet(key).filter(i => i.id !== id));
}
function genId(prefix = '') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/* ── Session ── */
function getSession()          { try { return JSON.parse(localStorage.getItem(DB.SESSION)); } catch(e) { return null; } }
function setSession(user)      { localStorage.setItem(DB.SESSION, JSON.stringify(user)); }
function clearSession()        { localStorage.removeItem(DB.SESSION); }

/* ── User Helpers ── */
function findUserByEmail(email) { return dbGet(DB.USERS).find(u => u.email.toLowerCase() === email.toLowerCase()) || null; }
function getUsersByRole(role)   { return dbGet(DB.USERS).filter(u => u.role === role); }

// FIX BUG-004/006: Match by department name OR department code
function getUsersByDept(dept) {
  const d = dbGet(DB.DEPARTMENTS).find(x => x.name === dept || x.code === dept);
  const deptName = d ? d.name : dept;
  const deptCode = d ? d.code : dept;
  return dbGet(DB.USERS).filter(u =>
    u.role === 'employee' &&
    (u.department === deptName || u.department === deptCode)
  );
}

function calculateUserRiskScore(userId) {
  const events    = dbGet(DB.PHISHING_EVENTS).filter(e => e.userId === userId);
  const clicks    = events.filter(e => e.eventType === 'clicked' || e.eventType === 'submitted').length;
  const enrolls   = dbGet(DB.ENROLLMENTS).filter(e => e.userId === userId);
  const overdue   = enrolls.filter(e => e.status === 'overdue').length;
  const failed    = dbGet(DB.QUIZ_RESULTS).filter(r => r.userId === userId && !r.passed).length;
  const total     = enrolls.length || 1;
  const score     = Math.min(100, Math.round((clicks * 20) + (overdue * 10) + (failed * 5) + ((1 - (enrolls.filter(e => e.status==='completed').length / total)) * 30)));
  return score;
}

function updateUserRiskScore(userId) {
  const user = dbGetOne(DB.USERS, userId);
  if (user) { user.riskScore = calculateUserRiskScore(userId); dbSave(DB.USERS, user); }
}

/* ── Department Helpers ── */
function getDeptNames() { return dbGet(DB.DEPARTMENTS).map(d => d.name); }

/* ── Enrollment Helpers ── */
function enrollUser(userId, moduleId, dueDate, assignedBy) {
  const existing = getEnrollment(userId, moduleId);
  if (existing) return existing;
  const item = {
    id: genId('en'), userId, moduleId,
    enrolledAt: new Date().toISOString(),
    dueDate: dueDate || null,
    completedAt: null, progress: 0,
    status: 'not-started', quizScore: null,
    quizPassed: null, certificate: null,
    assignedBy: assignedBy || null
  };
  return dbSave(DB.ENROLLMENTS, item);
}
function getEnrollment(userId, moduleId) {
  return dbGet(DB.ENROLLMENTS).find(e => e.userId === userId && e.moduleId === moduleId) || null;
}

// FIX BUG-014: Separated overdue auto-update into its own function
// Call this once per page load, not on every read
let _overdueChecked = false;
function checkAndUpdateOverdue() {
  if (_overdueChecked) return;
  _overdueChecked = true;
  const enrolls = dbGet(DB.ENROLLMENTS);
  let changed = false;
  enrolls.forEach(e => {
    if (e.status !== 'completed' && e.dueDate && new Date(e.dueDate) < new Date()) {
      if (e.status !== 'overdue') { e.status = 'overdue'; changed = true; }
    }
  });
  if (changed) dbSet(DB.ENROLLMENTS, enrolls);
}

function getUserEnrollments(userId) {
  checkAndUpdateOverdue();
  return dbGet(DB.ENROLLMENTS).filter(e => e.userId === userId);
}
function getModuleEnrollments(moduleId) { return dbGet(DB.ENROLLMENTS).filter(e => e.moduleId === moduleId); }

function updateEnrollmentProgress(userId, moduleId, progress, status) {
  const en = getEnrollment(userId, moduleId);
  if (!en) return;
  en.progress = progress;
  en.status   = status;
  if (status === 'completed') en.completedAt = new Date().toISOString();
  dbSave(DB.ENROLLMENTS, en);
  updateUserRiskScore(userId);
}

function completeModule(userId, moduleId) {
  updateEnrollmentProgress(userId, moduleId, 100, 'completed');
  rebuildOrgCompliance();
}

/* ── Quiz Helpers ── */
function saveQuizResult(userId, quizId, moduleId, score, total, answers, timeSpent) {
  const attempts  = getQuizAttempts(userId, quizId).length;
  const quiz      = dbGetOne(DB.QUIZZES, quizId);
  const pct       = total > 0 ? Math.round((score / total) * 100) : 0;
  const passed    = pct >= (quiz ? quiz.passMark : 70);
  const result    = {
    id: genId('qr'), userId, quizId, moduleId,
    attempt: attempts + 1, score, total,
    percentage: pct, passed, answers: answers || [],
    submittedAt: new Date().toISOString(),
    timeSpent: timeSpent || 0
  };
  dbSave(DB.QUIZ_RESULTS, result);
  if (passed) {
    const en = getEnrollment(userId, moduleId);
    if (en) { en.quizScore = pct; en.quizPassed = true; dbSave(DB.ENROLLMENTS, en); }
    completeModule(userId, moduleId);
    issueCertificate(userId, moduleId, pct, new Date().toISOString());
  }
  updateUserRiskScore(userId);
  return result;
}
function getQuizAttempts(userId, quizId) { return dbGet(DB.QUIZ_RESULTS).filter(r => r.userId === userId && r.quizId === quizId); }
function getQuizResult(userId, quizId)   {
  const attempts = getQuizAttempts(userId, quizId);
  if (!attempts.length) return null;
  return attempts.reduce((best, r) => r.percentage > best.percentage ? r : best, attempts[0]);
}

/* ── Certificate Helpers ── */
function issueCertificate(userId, moduleId, score, completedAt) {
  const en = getEnrollment(userId, moduleId);
  if (!en || en.certificate) return;
  en.certificate = { id: genId('cert'), issuedAt: completedAt || new Date().toISOString(), score };
  dbSave(DB.ENROLLMENTS, en);
}
function getUserCertificates(userId) {
  return getUserEnrollments(userId)
    .filter(e => e.certificate)
    .map(e => ({ ...e, module: dbGetOne(DB.MODULES, e.moduleId) }));
}

/* ── Phishing Helpers ── */
function recordPhishingEvent(campaignId, userId, eventType, skipRiskUpdate) {
  const existing = dbGet(DB.PHISHING_EVENTS).find(e => e.campaignId === campaignId && e.userId === userId && e.eventType === eventType);
  if (existing) return existing;
  const ev = { id: genId('phe'), campaignId, userId, eventType, occurredAt: new Date().toISOString() };
  dbSave(DB.PHISHING_EVENTS, ev);
  // FIX BUG-017: Allow skipping risk update during batch operations
  if (!skipRiskUpdate) updateUserRiskScore(userId);
  return ev;
}
function getCampaignStats(campaignId) {
  const events   = dbGet(DB.PHISHING_EVENTS).filter(e => e.campaignId === campaignId);
  const campaign = dbGetOne(DB.PHISHING, campaignId);
  const sent     = campaign ? campaign.targetUserIds.length : 0;
  return {
    sent,
    opened:    events.filter(e => e.eventType === 'opened').length,
    clicked:   events.filter(e => e.eventType === 'clicked').length,
    submitted: events.filter(e => e.eventType === 'submitted').length,
    reported:  events.filter(e => e.eventType === 'reported').length,
  };
}
function getUserPhishingHistory(userId) {
  return dbGet(DB.PHISHING_EVENTS)
    .filter(e => e.userId === userId)
    .map(e => ({ ...e, campaign: dbGetOne(DB.PHISHING, e.campaignId) }));
}

/* ── Compliance Helpers ── */
function rebuildComplianceRecord(framework, controlId, dept) {
  const allModules = dbGet(DB.MODULES).filter(m =>
    m.status === 'published' &&
    m.frameworkControls.some(fc => fc.framework === framework && fc.control === controlId)
  );
  if (!allModules.length) return;
  const users = dept === 'ALL' ? getUsersByRole('employee') : getUsersByDept(dept);
  if (!users.length) return;
  let completed = 0;
  users.forEach(u => {
    const enrolled = allModules.some(mod => {
      const en = getEnrollment(u.id, mod.id);
      return en && en.status === 'completed';
    });
    if (enrolled) completed++;
  });
  const pct    = Math.round((completed / users.length) * 100);
  const status = pct >= 80 ? 'compliant' : pct >= 40 ? 'partial' : 'non-compliant';
  const existing = dbGet(DB.COMPLIANCE).find(c => c.framework === framework && c.control === controlId && c.department === dept);
  const record = {
    id:            existing ? existing.id : genId('cr'),
    framework, control: controlId, department: dept,
    totalUsers: users.length, completedUsers: completed,
    completionPct: pct, status,
    lastUpdated: new Date().toISOString()
  };
  dbSave(DB.COMPLIANCE, record);
}

let _lastRebuild = 0;
function rebuildOrgCompliance() {
  const now = Date.now();
  if (now - _lastRebuild < 5000) return;
  _lastRebuild = now;
  const frameworks = dbGet(DB.FRAMEWORKS);
  const depts      = ['ALL', ...getDeptNames()];
  frameworks.forEach(fw => {
    fw.domains.forEach(dom => {
      dom.controls.forEach(ctrl => {
        depts.forEach(dept => rebuildComplianceRecord(fw.code, ctrl.id, dept));
      });
    });
  });
}

function getOrgComplianceScore(frameworkCode) {
  const records = dbGet(DB.COMPLIANCE).filter(c => c.framework === frameworkCode && c.department === 'ALL');
  if (!records.length) return 0;
  return Math.round(records.reduce((sum, r) => sum + r.completionPct, 0) / records.length);
}

// FIX BUG-001: Single canonical definition (removed duplicate from utils.js)
function getOrgOverallScore() {
  const codes = ['NCA-ECC', 'SAMA', 'CST'];
  const scores = codes.map(c => getOrgComplianceScore(c));
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

function getFrameworkDomainScores(frameworkCode) {
  const fw = dbGet(DB.FRAMEWORKS).find(f => f.code === frameworkCode);
  if (!fw) return [];
  return fw.domains.map(dom => {
    const controls = dom.controls.map(ctrl => {
      const rec = dbGet(DB.COMPLIANCE).find(c => c.framework === frameworkCode && c.control === ctrl.id && c.department === 'ALL');
      return rec ? rec.completionPct : 0;
    });
    const avg = controls.length ? Math.round(controls.reduce((a,b)=>a+b,0)/controls.length) : 0;
    return { domain: dom.name, pct: avg };
  });
}

/* ── Email Notification Helpers ── */

async function notifyNewUser(user, plainPassword) {
  if (typeof isAzureConfigured === 'undefined' || !isAzureConfigured()) return;
  if (!user.email) return;
  const platformUrl = (typeof getAzureConfig !== 'undefined') ? (getAzureConfig().redirectUri || window.location.origin) : window.location.origin;
  const subject = 'Welcome to SmartShield CyberAware — Your Account is Ready';
  const body = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff">
      <div style="background:linear-gradient(135deg,#060d14,#0a1628);padding:24px;display:flex;align-items:center;gap:14px">
        <span style="font-size:28px">🛡️</span>
        <div>
          <div style="color:#fff;font-weight:800;font-size:18px">SmartShield CyberAware</div>
          <div style="color:rgba(255,255,255,0.5);font-size:12px;text-transform:uppercase;letter-spacing:.08em">Smart Shield Cyber Security</div>
        </div>
      </div>
      <div style="padding:32px">
        <h2 style="color:#1f2937">Welcome, ${user.name}! 👋</h2>
        <p style="color:#374151">Your cybersecurity awareness training account has been created.</p>
        <div style="background:#f9fafb;border-radius:8px;padding:20px;margin:20px 0">
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:4px 0;color:#6b7280;font-size:13px">Platform</td><td style="color:#111827;font-weight:600;font-size:13px"><a href="${platformUrl}" style="color:#0ea5e9">${platformUrl}</a></td></tr>
            <tr><td style="padding:4px 0;color:#6b7280;font-size:13px">Email</td><td style="color:#111827;font-size:13px">${user.email}</td></tr>
            <tr><td style="padding:4px 0;color:#6b7280;font-size:13px">Password</td><td style="color:#111827;font-weight:600;font-size:13px">${plainPassword}</td></tr>
            <tr><td style="padding:4px 0;color:#6b7280;font-size:13px">Department</td><td style="color:#111827;font-size:13px">${user.department || '—'}</td></tr>
          </table>
        </div>
        <div style="text-align:center;margin:28px 0">
          <a href="${platformUrl}" style="background:linear-gradient(135deg,#0ea5e9,#0284c7);color:#fff;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:16px">Log In Now →</a>
        </div>
        <p style="color:#9ca3af;font-size:12px">Smart Shield Cyber Security | MSSP Cybersecurity Awareness Platform</p>
      </div>
    </div>`;
  try { await sendEmailViaGraph(user.email, user.name, subject, body); } catch(e) { console.warn('Welcome email failed:', e.message); }
}

async function notifyCampaignUsers(campaign, template, baseUrl) {
  if (typeof isAzureConfigured === 'undefined' || !isAzureConfigured()) return { sent:0, failed:0 };
  const recipients = campaign.targetUserIds
    .map(uid => dbGetOne(DB.USERS, uid))
    .filter(u => u && u.email && u.status === 'active');
  const tpl = (typeof PHISHING_TEMPLATES !== 'undefined') ? PHISHING_TEMPLATES[campaign.templateId] : null;
  if (!tpl) return { sent:0, failed:0 };
  return sendBatchEmails(
    recipients,
    () => tpl.subject,
    (r) => {
      const clickUrl = `${baseUrl}/employee/phishing.html?campaign=${campaign.id}&uid=${r.id}&event=clicked`;
      return tpl.body(r, campaign, clickUrl);
    }
  );
}

async function notifyEnrollment(userId, moduleId, dueDate) {
  if (typeof isAzureConfigured === 'undefined' || !isAzureConfigured()) return;
  const u   = dbGetOne(DB.USERS, userId);
  const mod = dbGetOne(DB.MODULES, moduleId);
  if (!u || !mod || !u.email) return;
  const en = getEnrollment(userId, moduleId) || { dueDate, status:'not-started' };
  try {
    const body = buildReminderEmail(u, en, mod);
    await sendEmailViaGraph(u.email, u.name, `New Training Assigned: ${mod.title}`, body);
  } catch(e) { console.warn('Enrollment notification failed:', e.message); }
}

/* ── Seed Data ── */
function initSeedData() {
  if (localStorage.getItem('cap_seeded')) return;

  /* Departments */
  const depts = [
    { id:'dept1', name:'Information Technology', code:'IT',      headCount:12, riskLevel:'medium', compliancePct:71 },
    { id:'dept2', name:'Finance',                code:'FIN',     headCount:9,  riskLevel:'high',   compliancePct:52 },
    { id:'dept3', name:'Human Resources',        code:'HR',      headCount:6,  riskLevel:'low',    compliancePct:85 },
    { id:'dept4', name:'Operations',             code:'OPS',     headCount:15, riskLevel:'medium', compliancePct:63 },
  ];
  dbSet(DB.DEPARTMENTS, depts);

  /* Frameworks */
  const frameworks = [
    {
      id:'fw1', code:'NCA-ECC', name:'NCA Essential Cybersecurity Controls', version:'2.0',
      domains:[
        { id:'ECC-1', name:'Cybersecurity Governance', controls:[
          { id:'ECC-1-1', name:'Cybersecurity Policies & Procedures' },
          { id:'ECC-1-2', name:'Cybersecurity Roles & Responsibilities' },
          { id:'ECC-1-3', name:'Cybersecurity Risk Management' },
          { id:'ECC-1-4', name:'Cybersecurity Compliance' },
        ]},
        { id:'ECC-2', name:'Cybersecurity Defense', controls:[
          { id:'ECC-2-1', name:'Asset Management' },
          { id:'ECC-2-2', name:'Identity & Access Management' },
          { id:'ECC-2-3', name:'Information Systems & Data Protection' },
          { id:'ECC-2-4', name:'Email & Web Protection' },
          { id:'ECC-2-5', name:'Endpoint & Mobile Device Protection' },
          { id:'ECC-2-6', name:'Network Security Management' },
          { id:'ECC-2-7', name:'Vulnerability Management' },
        ]},
        { id:'ECC-3', name:'Cybersecurity Resilience', controls:[
          { id:'ECC-3-1', name:'Cybersecurity Resilience & BCM' },
        ]},
        { id:'ECC-4', name:'Third-Party & Cloud Security', controls:[
          { id:'ECC-4-1', name:'Third-Party Cybersecurity' },
          { id:'ECC-4-2', name:'Cloud Cybersecurity' },
        ]},
        { id:'ECC-5', name:'ICS Security', controls:[
          { id:'ECC-5-1', name:'Industrial Control Systems Security' },
        ]},
      ]
    },
    {
      id:'fw2', code:'SAMA', name:'SAMA Cybersecurity Framework', version:'1.0',
      domains:[
        { id:'SAMA-1', name:'Leadership & Governance', controls:[
          { id:'SAMA-1-1', name:'Cybersecurity Strategy' },
          { id:'SAMA-1-2', name:'Cybersecurity Policies' },
          { id:'SAMA-1-3', name:'Cybersecurity Awareness' },
        ]},
        { id:'SAMA-2', name:'Risk Management & Compliance', controls:[
          { id:'SAMA-2-1', name:'Risk Identification' },
          { id:'SAMA-2-2', name:'Risk Assessment' },
          { id:'SAMA-2-3', name:'Regulatory Compliance' },
        ]},
        { id:'SAMA-3', name:'Cybersecurity Operations & Technology', controls:[
          { id:'SAMA-3-1', name:'Access Management' },
          { id:'SAMA-3-2', name:'Security Operations' },
          { id:'SAMA-3-3', name:'Incident Management' },
          { id:'SAMA-3-4', name:'Change Management' },
        ]},
        { id:'SAMA-4', name:'Third-Party Cybersecurity', controls:[
          { id:'SAMA-4-1', name:'Third-Party Assessment' },
          { id:'SAMA-4-2', name:'Contracts & SLAs' },
        ]},
        { id:'SAMA-5', name:'Cybersecurity Resilience', controls:[
          { id:'SAMA-5-1', name:'Business Continuity' },
          { id:'SAMA-5-2', name:'Disaster Recovery' },
        ]},
      ]
    },
    {
      id:'fw3', code:'CST', name:'CST Cybersecurity Framework', version:'1.0',
      domains:[
        { id:'CST-ID', name:'Identify', controls:[
          { id:'ID-AM-1', name:'Asset Inventory' },
          { id:'ID-AM-5', name:'Data Classification' },
          { id:'ID-SC-1', name:'Supply Chain Risk' },
        ]},
        { id:'CST-PR', name:'Protect', controls:[
          { id:'PR-AC-1', name:'Identity Management' },
          { id:'PR-AC-3', name:'Remote Access' },
          { id:'PR-AT-1', name:'Awareness Training' },
          { id:'PR-AT-2', name:'Privileged User Training' },
          { id:'PR-DS-1', name:'Data-at-Rest Protection' },
          { id:'PR-PT-3', name:'Least Privilege' },
        ]},
        { id:'CST-DE', name:'Detect', controls:[
          { id:'DE-CM-7', name:'Monitoring' },
          { id:'DE-AE-2', name:'Event Analysis' },
        ]},
        { id:'CST-RS', name:'Respond', controls:[
          { id:'RS-CO-2', name:'Reporting' },
          { id:'RS-AN-1', name:'Incident Investigation' },
        ]},
        { id:'CST-RC', name:'Recover', controls:[
          { id:'RC-RP-1', name:'Recovery Planning' },
          { id:'RC-CO-1', name:'Recovery Communications' },
        ]},
      ]
    },
  ];
  dbSet(DB.FRAMEWORKS, frameworks);

  /* Users — FIX BUG-004: Use FULL department names matching the departments table */
  const colors = ['#0ea5e9','#22c55e','#f59e0b','#ef4444','#8b5cf6','#ec4899','#14b8a6','#f97316','#6366f1'];
  const users = [
    { id:'u1', name:'Admin User',          email:'admin@smartshield.sa',  password:'admin123',   role:'admin',    department:'Information Technology', jobTitle:'Security Manager',      sector:'corporate', riskScore:5,  color:colors[0], lastLogin: new Date().toISOString(), createdAt:'2026-01-01T00:00:00Z', status:'active' },
    { id:'u2', name:'Ahmad Al-Rashidi',    email:'ahmad@company.sa',      password:'emp123',     role:'employee', department:'Information Technology', jobTitle:'IT Administrator',       sector:'corporate', riskScore:20, color:colors[1], lastLogin: new Date().toISOString(), createdAt:'2026-01-05T00:00:00Z', status:'active' },
    { id:'u3', name:'Sara Al-Mutairi',     email:'sara@company.sa',       password:'emp123',     role:'employee', department:'Finance',                jobTitle:'Finance Analyst',        sector:'corporate', riskScore:55, color:colors[2], lastLogin: new Date().toISOString(), createdAt:'2026-01-06T00:00:00Z', status:'active' },
    { id:'u4', name:'Khalid Al-Zahrani',   email:'khalid@company.sa',     password:'emp123',     role:'employee', department:'Human Resources',        jobTitle:'HR Specialist',          sector:'corporate', riskScore:15, color:colors[3], lastLogin: new Date().toISOString(), createdAt:'2026-01-07T00:00:00Z', status:'active' },
    { id:'u5', name:'Noura Al-Ghamdi',     email:'noura@company.sa',      password:'emp123',     role:'employee', department:'Finance',                jobTitle:'Chief Accountant',       sector:'corporate', riskScore:72, color:colors[4], lastLogin: new Date().toISOString(), createdAt:'2026-01-08T00:00:00Z', status:'active' },
    { id:'u6', name:'Faisal Al-Otaibi',    email:'faisal@company.sa',     password:'emp123',     role:'employee', department:'Operations',             jobTitle:'Operations Manager',     sector:'corporate', riskScore:30, color:colors[5], lastLogin: new Date().toISOString(), createdAt:'2026-01-09T00:00:00Z', status:'active' },
    { id:'u7', name:'Reem Al-Shammari',    email:'reem@company.sa',       password:'emp123',     role:'employee', department:'Information Technology', jobTitle:'Network Engineer',       sector:'corporate', riskScore:10, color:colors[6], lastLogin: new Date().toISOString(), createdAt:'2026-01-10T00:00:00Z', status:'active' },
    { id:'u8', name:'Tariq Al-Harbi',      email:'tariq@company.sa',      password:'emp123',     role:'employee', department:'Operations',             jobTitle:'Operations Analyst',     sector:'government',riskScore:45, color:colors[7], lastLogin: new Date().toISOString(), createdAt:'2026-01-11T00:00:00Z', status:'active' },
    { id:'u9', name:'Hana Al-Dossari',     email:'hana@company.sa',       password:'emp123',     role:'employee', department:'Human Resources',        jobTitle:'Recruitment Specialist', sector:'government',riskScore:25, color:colors[8], lastLogin: new Date().toISOString(), createdAt:'2026-01-12T00:00:00Z', status:'active' },
    { id:'u10',name:'Mohammed Al-Saud',    email:'mohammed@company.sa',   password:'emp123',     role:'employee', department:'Finance',                jobTitle:'Finance Director',       sector:'corporate', riskScore:60, color:colors[0], lastLogin: new Date().toISOString(), createdAt:'2026-01-13T00:00:00Z', status:'active' },
  ];
  dbSet(DB.USERS, users);

  /* Training Modules — same as original but with BUG-004 dept name fix in targetDepts */
  const modules = [
    {
      id:'m1', title:'Password Security Fundamentals', description:'Learn to create, manage, and protect strong passwords to prevent unauthorized access.',
      category:'access-control', type:'text', difficulty:'beginner', duration:'20 min',
      thumbnail:null, icon:'🔐', thumbColor:'linear-gradient(135deg,#0ea5e9,#0369a1)',
      content:{ richText:'<h3>Why Password Security Matters</h3><p>Weak passwords are the #1 cause of data breaches. A strong password is your first line of defense against attackers.</p><h3>Password Best Practices</h3><ul><li><strong>Length:</strong> Use at least 12 characters</li><li><strong>Complexity:</strong> Mix uppercase, lowercase, numbers, and symbols</li><li><strong>Uniqueness:</strong> Never reuse passwords across accounts</li><li><strong>Password Manager:</strong> Use a trusted password manager</li><li><strong>MFA:</strong> Enable Multi-Factor Authentication wherever possible</li></ul><h3>What to Avoid</h3><ul><li>Personal information (birthdate, name, etc.)</li><li>Common words or patterns (password123, abc123)</li><li>Writing passwords on paper or storing in plain text</li></ul><h3>Changing Passwords</h3><p>Change passwords immediately if you suspect compromise. Use passphrases: "MyDog!Eats3Bones" is stronger than "D0g3b0n3s".</p>' },
      frameworkControls:[
        { framework:'NCA-ECC', domain:'ECC-2', control:'ECC-2-2' },
        { framework:'SAMA',    domain:'SAMA-3', control:'SAMA-3-1' },
        { framework:'CST',     domain:'CST-PR', control:'PR-AC-1' },
      ],
      passMark:70, quizId:'q1', mandatory:true,
      targetRoles:['employee'], targetDepts:[], createdAt:'2026-01-15T00:00:00Z', createdBy:'u1', status:'published'
    },
    {
      id:'m2', title:'Phishing Awareness', description:'Identify and respond to phishing emails, smishing, and vishing attacks targeting your organization.',
      category:'threats', type:'text', difficulty:'beginner', duration:'25 min',
      thumbnail:null, icon:'🎣', thumbColor:'linear-gradient(135deg,#ef4444,#b91c1c)',
      content:{ richText:'<h3>What is Phishing?</h3><p>Phishing is a cyberattack using deceptive emails, messages, or websites to steal credentials, financial data, or install malware.</p><h3>Types of Phishing</h3><ul><li><strong>Email Phishing:</strong> Mass emails impersonating trusted brands</li><li><strong>Spear Phishing:</strong> Targeted attacks on specific individuals</li><li><strong>Smishing:</strong> Phishing via SMS text messages</li><li><strong>Vishing:</strong> Voice/phone-based phishing</li><li><strong>Whaling:</strong> Targeting senior executives</li></ul><h3>Red Flags to Watch For</h3><ul><li>Urgent or threatening language</li><li>Suspicious sender email addresses</li><li>Generic greetings</li><li>Unexpected attachments or links</li><li>Requests for sensitive information via email</li></ul><h3>How to Respond</h3><ul><li>Do NOT click links or download attachments from suspicious emails</li><li>Hover over links to verify the real URL</li><li>Report suspicious emails to your IT/Security team immediately</li></ul>' },
      frameworkControls:[
        { framework:'NCA-ECC', domain:'ECC-2', control:'ECC-2-4' },
        { framework:'SAMA',    domain:'SAMA-3', control:'SAMA-3-2' },
        { framework:'CST',     domain:'CST-PR', control:'PR-AT-1' },
        { framework:'CST',     domain:'CST-DE', control:'DE-CM-7' },
      ],
      passMark:70, quizId:'q2', mandatory:true,
      targetRoles:['employee'], targetDepts:[], createdAt:'2026-01-16T00:00:00Z', createdBy:'u1', status:'published'
    },
    {
      id:'m3', title:'Data Classification & Handling', description:'Understand how to classify, label, and handle organizational data according to NCA and SAMA requirements.',
      category:'data-protection', type:'text', difficulty:'intermediate', duration:'30 min',
      thumbnail:null, icon:'📂', thumbColor:'linear-gradient(135deg,#8b5cf6,#6d28d9)',
      content:{ richText:'<h3>What is Data Classification?</h3><p>Data classification is the process of organizing data into categories based on sensitivity.</p><h3>NCA Classification Levels</h3><ul><li><strong>Top Secret:</strong> Highest sensitivity</li><li><strong>Secret:</strong> Unauthorized disclosure would be damaging</li><li><strong>Confidential:</strong> Internal use only</li><li><strong>Public:</strong> Can be shared freely</li></ul><h3>Your Responsibilities</h3><ul><li>Label all documents with appropriate classification</li><li>Store classified data on approved systems only</li><li>Never share classified data via personal email or USB</li><li>Encrypt data when transmitting externally</li></ul>' },
      frameworkControls:[
        { framework:'NCA-ECC', domain:'ECC-2', control:'ECC-2-3' },
        { framework:'SAMA',    domain:'SAMA-2', control:'SAMA-2-2' },
        { framework:'CST',     domain:'CST-ID', control:'ID-AM-5' },
        { framework:'CST',     domain:'CST-PR', control:'PR-DS-1' },
      ],
      passMark:70, quizId:'q3', mandatory:true,
      targetRoles:['employee'], targetDepts:[], createdAt:'2026-01-17T00:00:00Z', createdBy:'u1', status:'published'
    },
    {
      id:'m4', title:'Incident Reporting & Response', description:'Know how to recognize, report, and respond to cybersecurity incidents quickly and effectively.',
      category:'incident-response', type:'text', difficulty:'intermediate', duration:'25 min',
      thumbnail:null, icon:'🚨', thumbColor:'linear-gradient(135deg,#f97316,#c2410c)',
      content:{ richText:'<h3>What is a Security Incident?</h3><p>Any event that potentially compromises the confidentiality, integrity, or availability of information systems or data.</p><h3>Incident Reporting Steps</h3><ol><li><strong>Recognize:</strong> Identify something unusual</li><li><strong>Contain:</strong> Disconnect affected device</li><li><strong>Report:</strong> Contact IT/Security immediately</li><li><strong>Document:</strong> Record what happened</li><li><strong>Cooperate:</strong> Follow security team instructions</li></ol>' },
      frameworkControls:[
        { framework:'NCA-ECC', domain:'ECC-2', control:'ECC-2-7' },
        { framework:'SAMA',    domain:'SAMA-3', control:'SAMA-3-3' },
        { framework:'CST',     domain:'CST-RS', control:'RS-CO-2' },
      ],
      passMark:70, quizId:'q4', mandatory:true,
      targetRoles:['employee'], targetDepts:[], createdAt:'2026-01-18T00:00:00Z', createdBy:'u1', status:'published'
    },
    {
      id:'m5', title:'Social Engineering Awareness', description:'Recognize manipulation tactics used by attackers to deceive employees.',
      category:'threats', type:'text', difficulty:'intermediate', duration:'20 min',
      thumbnail:null, icon:'🎭', thumbColor:'linear-gradient(135deg,#ec4899,#be185d)',
      content:{ richText:'<h3>What is Social Engineering?</h3><p>Psychological manipulation of people into performing actions or divulging confidential information.</p><h3>Common Tactics</h3><ul><li><strong>Pretexting:</strong> Fabricated scenario</li><li><strong>Baiting:</strong> Infected USB drives</li><li><strong>Tailgating:</strong> Following into secure areas</li><li><strong>Impersonation:</strong> Pretending to be IT support</li></ul>' },
      frameworkControls:[
        { framework:'NCA-ECC', domain:'ECC-1', control:'ECC-1-2' },
        { framework:'NCA-ECC', domain:'ECC-2', control:'ECC-2-4' },
        { framework:'SAMA',    domain:'SAMA-1', control:'SAMA-1-3' },
        { framework:'CST',     domain:'CST-PR', control:'PR-AT-2' },
      ],
      passMark:70, quizId:'q5', mandatory:false,
      targetRoles:['employee'], targetDepts:[], createdAt:'2026-01-19T00:00:00Z', createdBy:'u1', status:'published'
    },
    {
      id:'m6', title:'Secure Remote Working', description:'Best practices for working securely from home or remote locations.',
      category:'remote-work', type:'text', difficulty:'beginner', duration:'20 min',
      thumbnail:null, icon:'🏠', thumbColor:'linear-gradient(135deg,#14b8a6,#0f766e)',
      content:{ richText:'<h3>Remote Work Security</h3><ul><li>Always use VPN</li><li>Secure home WiFi with WPA3</li><li>Use company-approved devices</li><li>Lock screen when away</li><li>Avoid public WiFi</li></ul>' },
      frameworkControls:[
        { framework:'NCA-ECC', domain:'ECC-2', control:'ECC-2-5' },
        { framework:'NCA-ECC', domain:'ECC-2', control:'ECC-2-4' },
        { framework:'SAMA',    domain:'SAMA-3', control:'SAMA-3-1' },
        { framework:'CST',     domain:'CST-PR', control:'PR-AC-3' },
      ],
      passMark:70, quizId:'q6', mandatory:false,
      targetRoles:['employee'], targetDepts:[], createdAt:'2026-01-20T00:00:00Z', createdBy:'u1', status:'published'
    },
    {
      id:'m7', title:'Mobile Device Security', description:'Protect smartphones and tablets containing corporate data.',
      category:'endpoint-security', type:'text', difficulty:'beginner', duration:'15 min',
      thumbnail:null, icon:'📱', thumbColor:'linear-gradient(135deg,#6366f1,#4338ca)',
      content:{ richText:'<h3>Mobile Security</h3><ul><li>Enable screen lock</li><li>Keep OS and apps updated</li><li>Enable remote wipe</li><li>Only install from official stores</li></ul>' },
      frameworkControls:[
        { framework:'NCA-ECC', domain:'ECC-2', control:'ECC-2-5' },
        { framework:'SAMA',    domain:'SAMA-4', control:'SAMA-4-1' },
        { framework:'CST',     domain:'CST-PR', control:'PR-PT-3' },
      ],
      passMark:70, quizId:'q7', mandatory:false,
      targetRoles:['employee'], targetDepts:[], createdAt:'2026-01-21T00:00:00Z', createdBy:'u1', status:'published'
    },
    {
      id:'m8', title:'Third-Party & Vendor Risk', description:'Understanding cybersecurity risks from third-party vendors and contractors.',
      category:'third-party', type:'text', difficulty:'advanced', duration:'30 min',
      thumbnail:null, icon:'🤝', thumbColor:'linear-gradient(135deg,#f59e0b,#b45309)',
      content:{ richText:'<h3>Third-Party Risk</h3><p>Third-party risk refers to potential harm through vendors who access your systems or data.</p><ul><li>Never share credentials with vendors</li><li>Verify vendor identity before granting access</li><li>Follow least privilege for external access</li></ul>' },
      frameworkControls:[
        { framework:'NCA-ECC', domain:'ECC-4', control:'ECC-4-1' },
        { framework:'SAMA',    domain:'SAMA-4', control:'SAMA-4-1' },
        { framework:'SAMA',    domain:'SAMA-4', control:'SAMA-4-2' },
        { framework:'CST',     domain:'CST-ID', control:'ID-SC-1' },
      ],
      passMark:75, quizId:'q8', mandatory:false,
      targetRoles:['employee'], targetDepts:['Information Technology','Finance'], createdAt:'2026-01-22T00:00:00Z', createdBy:'u1', status:'published'
    },
    {
      id:'m9', title:'Business Continuity & Cyber Resilience', description:'Understanding your role in maintaining business continuity during cyber incidents.',
      category:'resilience', type:'text', difficulty:'advanced', duration:'25 min',
      thumbnail:null, icon:'🏗️', thumbColor:'linear-gradient(135deg,#0284c7,#075985)',
      content:{ richText:'<h3>Cyber Resilience</h3><p>The ability to continuously deliver outcomes despite adverse cyber events.</p><ul><li>Know your BCP role</li><li>Participate in drills</li><li>Never bypass backup procedures</li></ul>' },
      frameworkControls:[
        { framework:'NCA-ECC', domain:'ECC-3', control:'ECC-3-1' },
        { framework:'SAMA',    domain:'SAMA-5', control:'SAMA-5-1' },
        { framework:'SAMA',    domain:'SAMA-5', control:'SAMA-5-2' },
        { framework:'CST',     domain:'CST-RC', control:'RC-RP-1' },
      ],
      passMark:70, quizId:'q9', mandatory:false,
      targetRoles:['employee'], targetDepts:['Information Technology','Operations'], createdAt:'2026-01-23T00:00:00Z', createdBy:'u1', status:'published'
    },
    {
      id:'m10', title:'Cloud Security Basics', description:'Essential cloud security practices for employees using cloud applications.',
      category:'cloud-security', type:'text', difficulty:'intermediate', duration:'25 min',
      thumbnail:null, icon:'☁️', thumbColor:'linear-gradient(135deg,#22c55e,#15803d)',
      content:{ richText:'<h3>Cloud Security</h3><ul><li>Shared Responsibility Model applies</li><li>Only use approved cloud services</li><li>Enable MFA on all cloud accounts</li><li>Review sharing permissions regularly</li></ul>' },
      frameworkControls:[
        { framework:'NCA-ECC', domain:'ECC-4', control:'ECC-4-2' },
        { framework:'SAMA',    domain:'SAMA-4', control:'SAMA-4-1' },
        { framework:'CST',     domain:'CST-PR', control:'PR-AC-3' },
      ],
      passMark:70, quizId:'q10', mandatory:false,
      targetRoles:['employee'], targetDepts:[], createdAt:'2026-01-24T00:00:00Z', createdBy:'u1', status:'published'
    },
  ];
  dbSet(DB.MODULES, modules);

  /* Quizzes — same as original (abbreviated for space, full questions preserved) */
  const quizzes = [
    { id:'q1', moduleId:'m1', title:'Password Security Assessment', timeLimit:10, passMark:70, attempts:3, questions:[
      { id:'qq1', text:'What is the minimum recommended password length?', options:['6 characters','8 characters','12 characters','20 characters'], correct:2, explanation:'Modern standards recommend at least 12 characters.' },
      { id:'qq2', text:'Which is the STRONGEST password?', options:['ahmed@1990','P@ssw0rd!','MyD0g!Likes3Bones#2024','password123'], correct:2, explanation:'Passphrases combining words with special characters are strongest.' },
      { id:'qq3', text:'What should you do if your password is compromised?', options:['Wait and see','Change it immediately','Tell colleagues','Write a new one on paper'], correct:1, explanation:'Immediately changing prevents unauthorized access.' },
      { id:'qq4', text:'What is Multi-Factor Authentication (MFA)?', options:['Using two passwords','A second verification step beyond password','Changing password monthly','Using a longer password'], correct:1, explanation:'MFA adds an extra verification layer beyond the password.' },
      { id:'qq5', text:'Which is safe password practice?', options:['Reusing passwords','Sharing with colleagues','Using a password manager','Writing in email drafts'], correct:2, explanation:'Password managers securely store unique passwords.' },
    ]},
    { id:'q2', moduleId:'m2', title:'Phishing Awareness Assessment', timeLimit:10, passMark:70, attempts:3, questions:[
      { id:'qq1', text:'Email asks to "verify account immediately or suspension." First action?', options:['Click to verify','Forward to colleagues','Check sender and report if suspicious','Reply for details'], correct:2, explanation:'Urgency is a classic phishing tactic.' },
      { id:'qq2', text:'What is "Spear Phishing"?', options:['Fishing-themed emails','Mass phishing','Targeted at specific individuals','Phone phishing'], correct:2, explanation:'Spear phishing uses personal information to appear legitimate.' },
      { id:'qq3', text:'Unknown sender attachment — safest action?', options:['Open to check','Scan then open','Do not open — report to IT','Forward to manager'], correct:2, explanation:'Never open attachments from unknown senders.' },
      { id:'qq4', text:'How to check if a link is safe?', options:['Click quickly','Hover to see real URL','Ask sender via same email','Paste into Google'], correct:1, explanation:'Hovering reveals the actual URL without clicking.' },
      { id:'qq5', text:'Which is a phishing red flag?', options:['Personalized greeting','Company domain sender','Generic "Dear Customer"','Company logo present'], correct:2, explanation:'Generic greetings indicate mass phishing.' },
    ]},
    { id:'q3', moduleId:'m3', title:'Data Classification Assessment', timeLimit:12, passMark:70, attempts:3, questions:[
      { id:'qq1', text:'Classification for national security info?', options:['Public','Confidential','Secret','Top Secret'], correct:3, explanation:'Top Secret for information whose disclosure causes severe damage.' },
      { id:'qq2', text:'Sending confidential file to external partner?', options:['Regular email','Approved encrypted transfer','Personal Google Drive','Print and mail'], correct:1, explanation:'Use approved encrypted channels only.' },
      { id:'qq3', text:'Disposing classified printed documents?', options:['Regular trash','Leave on desk','Cross-cut shredder','Desk drawer'], correct:2, explanation:'Use approved secure shredding methods.' },
      { id:'qq4', text:'Who can access "Secret" classified info?', options:['Any employee','Anyone who asks','Authorized with need-to-know','Senior management only'], correct:2, explanation:'Access restricted to authorized personnel with need-to-know.' },
      { id:'qq5', text:'Colleague asks for your credentials for a confidential doc?', options:['Share briefly','Help them get proper access','Tell manager after sharing','Refuse silently'], correct:1, explanation:'Help colleagues obtain proper authorized access.' },
    ]},
    { id:'q4', moduleId:'m4', title:'Incident Reporting Assessment', timeLimit:10, passMark:70, attempts:3, questions:[
      { id:'qq1', text:'Computer slow with unexpected pop-ups. First action?', options:['Restart','Continue monitoring','Disconnect from network and contact IT','Run public antivirus'], correct:2, explanation:'Disconnecting prevents malware spread.' },
      { id:'qq2', text:'Accidentally clicked phishing link. What to do?', options:['Nothing','Wait 24 hours','Report to IT immediately','Close browser and forget'], correct:2, explanation:'Report immediately even if nothing seems wrong.' },
      { id:'qq3', text:'Who to report a security incident to?', options:['Direct manager','Colleagues first','IT Security via incident hotline','Post on intranet'], correct:2, explanation:'Use the official IT Security reporting channel.' },
      { id:'qq4', text:'Why not fix a security incident yourself?', options:['Against policy','Could destroy digital evidence','Takes too long','IT will be angry'], correct:1, explanation:'Self-fixing can destroy critical forensic evidence.' },
      { id:'qq5', text:'Which is NOT a reportable security incident?', options:['Suspicious email','Regular system update','Colleague asking for password','Unattended USB drive'], correct:1, explanation:'Routine updates are not security incidents.' },
    ]},
    { id:'q5', moduleId:'m5', title:'Social Engineering Assessment', timeLimit:10, passMark:70, attempts:3, questions:[
      { id:'qq1', text:'"IT Support" calls asking for your password. What do you do?', options:['Give it','Ask them to email first','Refuse — IT never needs your password','Give and change later'], correct:2, explanation:'Legitimate IT never needs your password.' },
      { id:'qq2', text:'Found USB labeled "Salary Info 2026" in parking lot?', options:['Plug in to check','Give to reception','Hand to IT Security without plugging in','Keep it'], correct:2, explanation:'Found USB drives are classic baiting attacks.' },
      { id:'qq3', text:'What is "Pretexting"?', options:['Sending fake emails','Creating fabricated story to manipulate','Breaking into building','Installing cameras'], correct:1, explanation:'Pretexting creates false scenarios to manipulate victims.' },
      { id:'qq4', text:'Someone follows you through badge-access door?', options:['Hold door','Challenge politely — ask them to badge in','Ignore','Report only if suspicious-looking'], correct:1, explanation:'Always require everyone to badge in individually.' },
      { id:'qq5', text:'Best protection from social engineering?', options:['Trust professionals','Verify identity before sharing info','Only suspect strangers','Share quickly to avoid inconvenience'], correct:1, explanation:'Always verify identity before sharing sensitive info.' },
    ]},
    { id:'q6', moduleId:'m6', title:'Remote Work Security Assessment', timeLimit:10, passMark:70, attempts:3, questions:[
      { id:'qq1', text:'What must you always use when accessing company systems from home?', options:['Fast internet','Company VPN','Separate computer','Personal email'], correct:1, explanation:'VPN encrypts your connection on untrusted networks.' },
      { id:'qq2', text:'Need to access work systems at coffee shop?', options:['Coffee shop WiFi','Mobile hotspot with VPN','Any public WiFi with VPN','Wait until home'], correct:1, explanation:'Use mobile hotspot (not public WiFi) with VPN.' },
      { id:'qq3', text:'Child wants to use work laptop for school?', options:['Allow briefly supervised','Allow weekends','Never allow personal use','Allow educational sites only'], correct:2, explanation:'Work devices must never be used for personal activities.' },
      { id:'qq4', text:'Step away from home office for 5 minutes?', options:['Leave visible','Lock screen','Log out completely','Nothing'], correct:1, explanation:'Always lock your screen when stepping away.' },
      { id:'qq5', text:'What WiFi security protocol for home router?', options:['WEP','WPA','WPA2 or WPA3','No password'], correct:2, explanation:'WPA2/WPA3 provides strong encryption.' },
    ]},
    { id:'q7', moduleId:'m7', title:'Mobile Security Assessment', timeLimit:8, passMark:70, attempts:3, questions:[
      { id:'qq1', text:'Work phone lost. First thing to do?', options:['Buy new phone','Report to IT for remote wipe','Try to find it','Change email password'], correct:1, explanation:'Report immediately for remote wipe.' },
      { id:'qq2', text:'Safe mobile app practice?', options:['Install from any website','Install only from official stores','Install from friend recommendations','Install highest downloads'], correct:1, explanation:'Official stores review apps for malware.' },
      { id:'qq3', text:'What to enable for lost device protection?', options:['Location sharing','Remote wipe (MDM)','Auto-brightness','App notifications'], correct:1, explanation:'MDM remote wipe erases data on lost devices.' },
      { id:'qq4', text:'SMS with link to "claim your prize"?', options:['Click — might be real','Forward to colleagues','Delete — do not click','Reply for info'], correct:2, explanation:'This is smishing. Delete without clicking.' },
      { id:'qq5', text:'Why disable Bluetooth when not using it?', options:['Battery drain','Attackers can exploit Bluetooth','Slows WiFi','Company policy'], correct:1, explanation:'Bluetooth attacks can allow device access.' },
    ]},
    { id:'q8', moduleId:'m8', title:'Third-Party Risk Assessment', timeLimit:12, passMark:75, attempts:2, questions:[
      { id:'qq1', text:'Vendor requests remote access to fix issue. Verify first?', options:['Company name','Identity and IT authorization','Nice website','Price quote'], correct:1, explanation:'Verify identity and IT authorization before granting access.' },
      { id:'qq2', text:'Which framework requires third-party security assessments?', options:['Only SAMA','Only NCA','Both SAMA and NCA ECC-4-1','Neither'], correct:2, explanation:'Both frameworks require third-party controls.' },
      { id:'qq3', text:'Contractor wants to connect personal laptop to network?', options:['Allow if needed','Direct to IT Security for provisioning','Allow temporarily','Refuse silently'], correct:1, explanation:'Third-party devices must go through IT Security.' },
      { id:'qq4', text:'Why are vendors a cybersecurity risk?', options:['Different software','Access to systems creates attack surface','Work slower','Higher fees'], correct:1, explanation:'Vendor access creates indirect attack paths.' },
      { id:'qq5', text:'How often should vendor access be reviewed?', options:['Never','Only on suspicion','At least annually','Every five years'], correct:2, explanation:'Annual reviews are required by SAMA and NCA.' },
    ]},
    { id:'q9', moduleId:'m9', title:'Business Continuity Assessment', timeLimit:12, passMark:70, attempts:3, questions:[
      { id:'qq1', text:'What is a Business Continuity Plan (BCP)?', options:['Financial backup','Plan to maintain operations during disruption','Backup schedule','Emergency contacts'], correct:1, explanation:'BCP ensures continued operations despite incidents.' },
      { id:'qq2', text:'What does "Recovery Time Objective (RTO)" mean?', options:['Data loss tolerance','Max acceptable time to restore system','Cost of recovery','Staff needed'], correct:1, explanation:'RTO defines maximum tolerable downtime.' },
      { id:'qq3', text:'Can still access compromised systems. Continue using?', options:['Yes if working','Only urgent tasks','No — report and avoid until cleared','Yes if critical'], correct:2, explanation:'Compromised systems must not be used until cleared.' },
      { id:'qq4', text:'Why store backups offline or offsite?', options:['Save storage','Prevent ransomware encrypting backups','Easier access','Cost reduction'], correct:1, explanation:'Ransomware targets network-connected backups.' },
      { id:'qq5', text:'Major incident disrupts communication systems?', options:['Personal email/messaging','Follow BCP backup communication channels','Social media','Wait for IT'], correct:1, explanation:'BCP defines approved backup communication channels.' },
    ]},
    { id:'q10', moduleId:'m10', title:'Cloud Security Assessment', timeLimit:10, passMark:70, attempts:3, questions:[
      { id:'qq1', text:'Under Shared Responsibility Model, who protects your data?', options:['Entirely provider','Entirely customer','Shared responsibility','Nobody — cloud is secure'], correct:2, explanation:'You are responsible for your data even in the cloud.' },
      { id:'qq2', text:'Which violates cloud security policy?', options:['Company cloud storage','MFA on cloud account','Work docs on personal Google Drive','Reviewing permissions'], correct:2, explanation:'Personal cloud services are not approved for work data.' },
      { id:'qq3', text:'NCA requirement for cloud data location?', options:['Anywhere globally','Saudi data residency required','Must be in US','No requirements'], correct:1, explanation:'NCA requires data residency within Saudi Arabia.' },
      { id:'qq4', text:'Sensitive doc shared via "Anyone with link"?', options:['Leave it','Restrict access and report to IT','Only report if labeled confidential','Ask person who shared'], correct:1, explanation:'Restrict access and report immediately.' },
      { id:'qq5', text:'Most important cloud account security control?', options:['Strong password alone','Multi-Factor Authentication','Same device always','Private browser'], correct:1, explanation:'MFA is most effective against unauthorized access.' },
    ]},
  ];
  dbSet(DB.QUIZZES, quizzes);

  /* Enrollments */
  const now = new Date();
  const due30 = new Date(now.getTime() + 30*86400000).toISOString();
  const due7  = new Date(now.getTime() + 7*86400000).toISOString();
  const past  = new Date(now.getTime() - 5*86400000).toISOString();
  const enrollments = [
    { id:'en1',  userId:'u2', moduleId:'m1', enrolledAt:'2026-02-01T00:00:00Z', dueDate:due30, completedAt:'2026-02-10T00:00:00Z', progress:100, status:'completed', quizScore:90, quizPassed:true,  certificate:{ id:'cert1', issuedAt:'2026-02-10T00:00:00Z', score:90 }, assignedBy:'u1' },
    { id:'en2',  userId:'u2', moduleId:'m2', enrolledAt:'2026-02-01T00:00:00Z', dueDate:due30, completedAt:'2026-02-14T00:00:00Z', progress:100, status:'completed', quizScore:80, quizPassed:true,  certificate:{ id:'cert2', issuedAt:'2026-02-14T00:00:00Z', score:80 }, assignedBy:'u1' },
    { id:'en3',  userId:'u2', moduleId:'m3', enrolledAt:'2026-02-15T00:00:00Z', dueDate:due30, completedAt:null, progress:60, status:'in-progress', quizScore:null, quizPassed:null, certificate:null, assignedBy:'u1' },
    { id:'en4',  userId:'u3', moduleId:'m1', enrolledAt:'2026-02-01T00:00:00Z', dueDate:due7,  completedAt:null, progress:30, status:'in-progress', quizScore:null, quizPassed:null, certificate:null, assignedBy:'u1' },
    { id:'en5',  userId:'u3', moduleId:'m2', enrolledAt:'2026-02-01T00:00:00Z', dueDate:past,  completedAt:null, progress:0,  status:'overdue',     quizScore:null, quizPassed:null, certificate:null, assignedBy:'u1' },
    { id:'en6',  userId:'u4', moduleId:'m1', enrolledAt:'2026-02-01T00:00:00Z', dueDate:due30, completedAt:'2026-02-20T00:00:00Z', progress:100, status:'completed', quizScore:100, quizPassed:true,  certificate:{ id:'cert3', issuedAt:'2026-02-20T00:00:00Z', score:100 }, assignedBy:'u1' },
    { id:'en7',  userId:'u4', moduleId:'m2', enrolledAt:'2026-02-01T00:00:00Z', dueDate:due30, completedAt:'2026-02-22T00:00:00Z', progress:100, status:'completed', quizScore:85, quizPassed:true,  certificate:{ id:'cert4', issuedAt:'2026-02-22T00:00:00Z', score:85 }, assignedBy:'u1' },
    { id:'en8',  userId:'u5', moduleId:'m1', enrolledAt:'2026-02-01T00:00:00Z', dueDate:past,  completedAt:null, progress:0,  status:'overdue',     quizScore:null, quizPassed:null, certificate:null, assignedBy:'u1' },
    { id:'en9',  userId:'u5', moduleId:'m2', enrolledAt:'2026-02-01T00:00:00Z', dueDate:past,  completedAt:null, progress:0,  status:'overdue',     quizScore:null, quizPassed:null, certificate:null, assignedBy:'u1' },
    { id:'en10', userId:'u6', moduleId:'m1', enrolledAt:'2026-02-15T00:00:00Z', dueDate:due30, completedAt:'2026-03-01T00:00:00Z', progress:100, status:'completed', quizScore:75, quizPassed:true,  certificate:{ id:'cert5', issuedAt:'2026-03-01T00:00:00Z', score:75 }, assignedBy:'u1' },
    { id:'en11', userId:'u6', moduleId:'m4', enrolledAt:'2026-02-15T00:00:00Z', dueDate:due30, completedAt:null, progress:50, status:'in-progress', quizScore:null, quizPassed:null, certificate:null, assignedBy:'u1' },
    { id:'en12', userId:'u7', moduleId:'m1', enrolledAt:'2026-02-01T00:00:00Z', dueDate:due30, completedAt:'2026-02-12T00:00:00Z', progress:100, status:'completed', quizScore:95, quizPassed:true,  certificate:{ id:'cert6', issuedAt:'2026-02-12T00:00:00Z', score:95 }, assignedBy:'u1' },
    { id:'en13', userId:'u7', moduleId:'m7', enrolledAt:'2026-02-01T00:00:00Z', dueDate:due30, completedAt:'2026-02-18T00:00:00Z', progress:100, status:'completed', quizScore:80, quizPassed:true,  certificate:{ id:'cert7', issuedAt:'2026-02-18T00:00:00Z', score:80 }, assignedBy:'u1' },
    { id:'en14', userId:'u8', moduleId:'m1', enrolledAt:'2026-02-15T00:00:00Z', dueDate:due30, completedAt:null, progress:40, status:'in-progress', quizScore:null, quizPassed:null, certificate:null, assignedBy:'u1' },
    { id:'en15', userId:'u9', moduleId:'m1', enrolledAt:'2026-02-15T00:00:00Z', dueDate:due30, completedAt:'2026-03-05T00:00:00Z', progress:100, status:'completed', quizScore:85, quizPassed:true,  certificate:{ id:'cert8', issuedAt:'2026-03-05T00:00:00Z', score:85 }, assignedBy:'u1' },
    { id:'en16', userId:'u10',moduleId:'m1', enrolledAt:'2026-02-01T00:00:00Z', dueDate:past,  completedAt:null, progress:0,  status:'overdue',     quizScore:null, quizPassed:null, certificate:null, assignedBy:'u1' },
    { id:'en17', userId:'u10',moduleId:'m2', enrolledAt:'2026-02-01T00:00:00Z', dueDate:due30, completedAt:null, progress:20, status:'in-progress', quizScore:null, quizPassed:null, certificate:null, assignedBy:'u1' },
  ];
  dbSet(DB.ENROLLMENTS, enrollments);

  /* Quiz Results */
  const qresults = [
    { id:'qr1', userId:'u2', quizId:'q1', moduleId:'m1', attempt:1, score:4, total:5, percentage:90, passed:true,  answers:[2,2,1,1,2], submittedAt:'2026-02-10T10:00:00Z', timeSpent:480 },
    { id:'qr2', userId:'u2', quizId:'q2', moduleId:'m2', attempt:1, score:4, total:5, percentage:80, passed:true,  answers:[2,2,2,1,2], submittedAt:'2026-02-14T10:00:00Z', timeSpent:520 },
    { id:'qr3', userId:'u4', quizId:'q1', moduleId:'m1', attempt:1, score:5, total:5, percentage:100,passed:true,  answers:[2,2,1,1,2], submittedAt:'2026-02-20T10:00:00Z', timeSpent:400 },
    { id:'qr4', userId:'u4', quizId:'q2', moduleId:'m2', attempt:1, score:4, total:5, percentage:85, passed:true,  answers:[2,2,2,1,2], submittedAt:'2026-02-22T10:00:00Z', timeSpent:450 },
    { id:'qr5', userId:'u5', quizId:'q1', moduleId:'m1', attempt:1, score:3, total:5, percentage:60, passed:false, answers:[0,2,0,1,2], submittedAt:'2026-02-20T10:00:00Z', timeSpent:600 },
    { id:'qr6', userId:'u6', quizId:'q1', moduleId:'m1', attempt:1, score:3, total:4, percentage:75, passed:true,  answers:[2,2,1,1,2], submittedAt:'2026-03-01T10:00:00Z', timeSpent:380 },
    { id:'qr7', userId:'u7', quizId:'q1', moduleId:'m1', attempt:1, score:5, total:5, percentage:95, passed:true,  answers:[2,2,1,1,2], submittedAt:'2026-02-12T10:00:00Z', timeSpent:300 },
    { id:'qr8', userId:'u7', quizId:'q7', moduleId:'m7', attempt:1, score:4, total:5, percentage:80, passed:true,  answers:[1,1,1,2,1], submittedAt:'2026-02-18T10:00:00Z', timeSpent:350 },
    { id:'qr9', userId:'u9', quizId:'q1', moduleId:'m1', attempt:1, score:4, total:5, percentage:85, passed:true,  answers:[2,2,1,1,2], submittedAt:'2026-03-05T10:00:00Z', timeSpent:420 },
  ];
  dbSet(DB.QUIZ_RESULTS, qresults);

  /* Phishing Campaigns */
  const campaigns = [
    { id:'ph1', name:'Q1 2026 IT Password Reset Simulation', description:'Tests susceptibility to fake password reset emails.', templateId:'tpl-pwd-reset', status:'completed', targetUserIds:['u2','u3','u4','u5','u6','u8','u9','u10'], targetDepts:['Information Technology','Finance','Human Resources','Operations'], launchedAt:'2026-02-01T00:00:00Z', endsAt:'2026-02-28T00:00:00Z', createdBy:'u1' },
    { id:'ph2', name:'March 2026 — IT Support Ticket Simulation', description:'Simulates a fake IT support ticket.', templateId:'tpl-it-support', status:'active', targetUserIds:['u3','u5','u8','u10'], targetDepts:['Finance','Operations'], launchedAt:'2026-03-01T00:00:00Z', endsAt:'2026-03-31T00:00:00Z', createdBy:'u1' },
  ];
  dbSet(DB.PHISHING, campaigns);

  /* Phishing Events */
  const phEvents = [
    { id:'phe1', campaignId:'ph1', userId:'u3',  eventType:'sent',      occurredAt:'2026-02-01T08:00:00Z' },
    { id:'phe2', campaignId:'ph1', userId:'u3',  eventType:'opened',    occurredAt:'2026-02-01T09:15:00Z' },
    { id:'phe3', campaignId:'ph1', userId:'u3',  eventType:'clicked',   occurredAt:'2026-02-01T09:16:00Z' },
    { id:'phe4', campaignId:'ph1', userId:'u5',  eventType:'sent',      occurredAt:'2026-02-01T08:00:00Z' },
    { id:'phe5', campaignId:'ph1', userId:'u5',  eventType:'opened',    occurredAt:'2026-02-01T10:00:00Z' },
    { id:'phe6', campaignId:'ph1', userId:'u5',  eventType:'clicked',   occurredAt:'2026-02-01T10:02:00Z' },
    { id:'phe7', campaignId:'ph1', userId:'u5',  eventType:'submitted', occurredAt:'2026-02-01T10:03:00Z' },
    { id:'phe8', campaignId:'ph1', userId:'u2',  eventType:'sent',      occurredAt:'2026-02-01T08:00:00Z' },
    { id:'phe9', campaignId:'ph1', userId:'u2',  eventType:'reported',  occurredAt:'2026-02-01T08:30:00Z' },
    { id:'phe10',campaignId:'ph1', userId:'u4',  eventType:'sent',      occurredAt:'2026-02-01T08:00:00Z' },
    { id:'phe11',campaignId:'ph1', userId:'u4',  eventType:'reported',  occurredAt:'2026-02-01T08:45:00Z' },
    { id:'phe12',campaignId:'ph1', userId:'u10', eventType:'sent',      occurredAt:'2026-02-01T08:00:00Z' },
    { id:'phe13',campaignId:'ph1', userId:'u10', eventType:'opened',    occurredAt:'2026-02-02T09:00:00Z' },
    { id:'phe14',campaignId:'ph1', userId:'u10', eventType:'clicked',   occurredAt:'2026-02-02T09:01:00Z' },
    { id:'phe15',campaignId:'ph2', userId:'u3',  eventType:'sent',      occurredAt:'2026-03-01T08:00:00Z' },
    { id:'phe16',campaignId:'ph2', userId:'u5',  eventType:'sent',      occurredAt:'2026-03-01T08:00:00Z' },
    { id:'phe17',campaignId:'ph2', userId:'u8',  eventType:'sent',      occurredAt:'2026-03-01T08:00:00Z' },
    { id:'phe18',campaignId:'ph2', userId:'u10', eventType:'sent',      occurredAt:'2026-03-01T08:00:00Z' },
  ];
  dbSet(DB.PHISHING_EVENTS, phEvents);

  /* Alerts */
  const alerts = [
    { id:'al1', type:'warning', message:'3 employees have overdue mandatory training', createdAt: new Date().toISOString(), read:false },
    { id:'al2', type:'info',    message:'Q1 Phishing Simulation completed — 3 clicked', createdAt: new Date().toISOString(), read:false },
    { id:'al3', type:'success', message:'Overall compliance score improved to 68%',     createdAt: new Date().toISOString(), read:false },
  ];
  dbSet(DB.ALERTS, alerts);

  rebuildOrgCompliance();
  localStorage.setItem('cap_seeded', '1');
}
