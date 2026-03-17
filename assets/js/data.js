/* =====================================================
   SmartShield CyberAware — data.js
   Data layer: LocalStorage CRUD + Seed Data
   Smart Shield Cyber Security MSSP Platform
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
function getUsersByDept(dept)   { return dbGet(DB.USERS).filter(u => u.department === dept && u.role === 'employee'); }

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
function getUserEnrollments(userId) {
  const enrolls = dbGet(DB.ENROLLMENTS).filter(e => e.userId === userId);
  // Auto-update overdue status based on current date
  let changed = false;
  enrolls.forEach(e => {
    if (e.status !== 'completed' && e.dueDate && new Date(e.dueDate) < new Date()) {
      if (e.status !== 'overdue') { e.status = 'overdue'; dbSave(DB.ENROLLMENTS, e); changed = true; }
    }
  });
  return enrolls;
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
  en.certificate = { id: genId('cert'), issuedAt: completedAt, score };
  dbSave(DB.ENROLLMENTS, en);
}
function getUserCertificates(userId) {
  return getUserEnrollments(userId)
    .filter(e => e.certificate)
    .map(e => ({ ...e, module: dbGetOne(DB.MODULES, e.moduleId) }));
}

/* ── Phishing Helpers ── */
function recordPhishingEvent(campaignId, userId, eventType) {
  const existing = dbGet(DB.PHISHING_EVENTS).find(e => e.campaignId === campaignId && e.userId === userId && e.eventType === eventType);
  if (existing) return existing;
  const ev = { id: genId('phe'), campaignId, userId, eventType, occurredAt: new Date().toISOString() };
  dbSave(DB.PHISHING_EVENTS, ev);
  updateUserRiskScore(userId);
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
  if (now - _lastRebuild < 5000) return; // debounce: max once per 5s
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

/* ── Overall Org Score (average across all frameworks) ── */
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

// Called after a new user is created by admin (users.html saveUser)
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
        <p style="color:#374151">Your cybersecurity awareness training account has been created. You can now log in to complete your assigned training modules and stay compliant with NCA, SAMA, and CST frameworks.</p>
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
        <p style="color:#6b7280;font-size:13px">Please change your password after your first login for security.</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0">
        <p style="color:#9ca3af;font-size:12px">Smart Shield Cyber Security | MSSP Cybersecurity Awareness Platform | NCA · SAMA · CST</p>
      </div>
    </div>`;
  try {
    await sendEmailViaGraph(user.email, user.name, subject, body);
  } catch(e) {
    console.warn('Welcome email failed:', e.message);
  }
}

// Called when a phishing campaign is launched (phishing.html launchCampaign)
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

// Called after module enrollment
async function notifyEnrollment(userId, moduleId, dueDate) {
  if (typeof isAzureConfigured === 'undefined' || !isAzureConfigured()) return;
  const u   = dbGetOne(DB.USERS, userId);
  const mod = dbGetOne(DB.MODULES, moduleId);
  if (!u || !mod || !u.email) return;
  const en = getEnrollment(userId, moduleId) || { dueDate, status:'not-started' };
  try {
    const body = buildReminderEmail(u, en, mod);
    await sendEmailViaGraph(u.email, u.name, `New Training Assigned: ${mod.title}`, body);
  } catch(e) {
    console.warn('Enrollment notification failed:', e.message);
  }
}

/* ── Seed Data ── */
function initSeedData() {
  if (localStorage.getItem('cap_seeded')) return;

  /* Departments */
  const depts = [
    { id:'dept1', name:'Information Technology', code:'IT',      headCount:12, riskLevel:'medium', compliancePct:71 },
    { id:'dept2', name:'Finance',                code:'Finance', headCount:9,  riskLevel:'high',   compliancePct:52 },
    { id:'dept3', name:'Human Resources',        code:'HR',      headCount:6,  riskLevel:'low',    compliancePct:85 },
    { id:'dept4', name:'Operations',             code:'Ops',     headCount:15, riskLevel:'medium', compliancePct:63 },
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

  /* Users */
  const colors = ['#0ea5e9','#22c55e','#f59e0b','#ef4444','#8b5cf6','#ec4899','#14b8a6','#f97316','#6366f1'];
  const users = [
    { id:'u1', name:'Admin User',          email:'admin@smartshield.sa',  password:'admin123',   role:'admin',    department:'IT',      jobTitle:'Security Manager',      sector:'corporate', riskScore:5,  color:colors[0], lastLogin: new Date().toISOString(), createdAt:'2026-01-01T00:00:00Z', status:'active' },
    { id:'u2', name:'Ahmad Al-Rashidi',    email:'ahmad@company.sa',      password:'emp123',     role:'employee', department:'IT',      jobTitle:'IT Administrator',       sector:'corporate', riskScore:20, color:colors[1], lastLogin: new Date().toISOString(), createdAt:'2026-01-05T00:00:00Z', status:'active' },
    { id:'u3', name:'Sara Al-Mutairi',     email:'sara@company.sa',       password:'emp123',     role:'employee', department:'Finance', jobTitle:'Finance Analyst',        sector:'corporate', riskScore:55, color:colors[2], lastLogin: new Date().toISOString(), createdAt:'2026-01-06T00:00:00Z', status:'active' },
    { id:'u4', name:'Khalid Al-Zahrani',   email:'khalid@company.sa',     password:'emp123',     role:'employee', department:'HR',      jobTitle:'HR Specialist',          sector:'corporate', riskScore:15, color:colors[3], lastLogin: new Date().toISOString(), createdAt:'2026-01-07T00:00:00Z', status:'active' },
    { id:'u5', name:'Noura Al-Ghamdi',     email:'noura@company.sa',      password:'emp123',     role:'employee', department:'Finance', jobTitle:'Chief Accountant',       sector:'corporate', riskScore:72, color:colors[4], lastLogin: new Date().toISOString(), createdAt:'2026-01-08T00:00:00Z', status:'active' },
    { id:'u6', name:'Faisal Al-Otaibi',    email:'faisal@company.sa',     password:'emp123',     role:'employee', department:'Ops',     jobTitle:'Operations Manager',     sector:'corporate', riskScore:30, color:colors[5], lastLogin: new Date().toISOString(), createdAt:'2026-01-09T00:00:00Z', status:'active' },
    { id:'u7', name:'Reem Al-Shammari',    email:'reem@company.sa',       password:'emp123',     role:'employee', department:'IT',      jobTitle:'Network Engineer',       sector:'corporate', riskScore:10, color:colors[6], lastLogin: new Date().toISOString(), createdAt:'2026-01-10T00:00:00Z', status:'active' },
    { id:'u8', name:'Tariq Al-Harbi',      email:'tariq@company.sa',      password:'emp123',     role:'employee', department:'Ops',     jobTitle:'Operations Analyst',     sector:'government',riskScore:45, color:colors[7], lastLogin: new Date().toISOString(), createdAt:'2026-01-11T00:00:00Z', status:'active' },
    { id:'u9', name:'Hana Al-Dossari',     email:'hana@company.sa',       password:'emp123',     role:'employee', department:'HR',      jobTitle:'Recruitment Specialist', sector:'government',riskScore:25, color:colors[8], lastLogin: new Date().toISOString(), createdAt:'2026-01-12T00:00:00Z', status:'active' },
    { id:'u10',name:'Mohammed Al-Saud',    email:'mohammed@company.sa',   password:'emp123',     role:'employee', department:'Finance', jobTitle:'Finance Director',       sector:'corporate', riskScore:60, color:colors[0], lastLogin: new Date().toISOString(), createdAt:'2026-01-13T00:00:00Z', status:'active' },
  ];
  dbSet(DB.USERS, users);

  /* Training Modules */
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
      content:{ richText:'<h3>What is Phishing?</h3><p>Phishing is a cyberattack using deceptive emails, messages, or websites to steal credentials, financial data, or install malware.</p><h3>Types of Phishing</h3><ul><li><strong>Email Phishing:</strong> Mass emails impersonating trusted brands</li><li><strong>Spear Phishing:</strong> Targeted attacks on specific individuals</li><li><strong>Smishing:</strong> Phishing via SMS text messages</li><li><strong>Vishing:</strong> Voice/phone-based phishing</li><li><strong>Whaling:</strong> Targeting senior executives</li></ul><h3>Red Flags to Watch For</h3><ul><li>Urgent or threatening language ("Act now or lose access")</li><li>Suspicious sender email addresses</li><li>Generic greetings ("Dear Customer")</li><li>Unexpected attachments or links</li><li>Requests for sensitive information via email</li><li>Poor grammar or spelling</li></ul><h3>How to Respond</h3><ul><li>Do NOT click links or download attachments from suspicious emails</li><li>Hover over links to verify the real URL before clicking</li><li>Report suspicious emails to your IT/Security team immediately</li><li>When in doubt, call the sender directly to verify</li></ul>' },
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
      content:{ richText:'<h3>What is Data Classification?</h3><p>Data classification is the process of organizing data into categories based on sensitivity and importance to the organization.</p><h3>NCA Classification Levels</h3><ul><li><strong>Top Secret:</strong> Highest sensitivity — disclosure would cause severe damage</li><li><strong>Secret:</strong> Sensitive — unauthorized disclosure would be damaging</li><li><strong>Confidential:</strong> Internal use — limited to authorized personnel</li><li><strong>Public:</strong> Can be shared with the public without restriction</li></ul><h3>Your Responsibilities</h3><ul><li>Label all documents and files with appropriate classification</li><li>Store classified data on approved, secure systems only</li><li>Never share classified data via personal email or USB drives</li><li>Encrypt data when transmitting outside the organization</li><li>Dispose of classified data through approved secure methods (shredding)</li></ul><h3>Data Handling Rules</h3><ul><li>Access data only on a need-to-know basis</li><li>Lock your screen when leaving your desk</li><li>Do not discuss classified matters in public areas</li><li>Report any suspected data leaks immediately</li></ul>' },
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
      content:{ richText:'<h3>What is a Security Incident?</h3><p>Any event that potentially compromises the confidentiality, integrity, or availability of information systems or data.</p><h3>Common Incidents</h3><ul><li>Ransomware or malware infection</li><li>Suspected phishing email received or clicked</li><li>Lost or stolen device containing company data</li><li>Unauthorized access to systems or data</li><li>Data sent to wrong recipient</li><li>Suspicious network activity</li></ul><h3>Incident Reporting Steps</h3><ol><li><strong>Recognize:</strong> Identify that something unusual has occurred</li><li><strong>Contain:</strong> Disconnect affected device from network immediately</li><li><strong>Report:</strong> Contact your IT/Security team via the official incident hotline</li><li><strong>Document:</strong> Record what happened, when, and what you did</li><li><strong>Cooperate:</strong> Follow instructions from the security team</li></ol><h3>Critical Points</h3><ul><li>Report ALL incidents, no matter how minor they seem</li><li>Do NOT try to fix it yourself — you may destroy evidence</li><li>Do NOT discuss the incident publicly or via social media</li><li>Time is critical — report immediately</li></ul>' },
      frameworkControls:[
        { framework:'NCA-ECC', domain:'ECC-2', control:'ECC-2-7' },
        { framework:'SAMA',    domain:'SAMA-3', control:'SAMA-3-3' },
        { framework:'CST',     domain:'CST-RS', control:'RS-CO-2' },
      ],
      passMark:70, quizId:'q4', mandatory:true,
      targetRoles:['employee'], targetDepts:[], createdAt:'2026-01-18T00:00:00Z', createdBy:'u1', status:'published'
    },
    {
      id:'m5', title:'Social Engineering Awareness', description:'Recognize manipulation tactics used by attackers to deceive employees into revealing sensitive information.',
      category:'threats', type:'text', difficulty:'intermediate', duration:'20 min',
      thumbnail:null, icon:'🎭', thumbColor:'linear-gradient(135deg,#ec4899,#be185d)',
      content:{ richText:'<h3>What is Social Engineering?</h3><p>Social engineering is the psychological manipulation of people into performing actions or divulging confidential information.</p><h3>Common Tactics</h3><ul><li><strong>Pretexting:</strong> Creating a fabricated scenario to extract information</li><li><strong>Baiting:</strong> Leaving infected USB drives in parking lots or offices</li><li><strong>Quid Pro Quo:</strong> Offering a service in exchange for information</li><li><strong>Tailgating:</strong> Physically following authorized personnel into restricted areas</li><li><strong>Impersonation:</strong> Pretending to be IT support, vendor, or authority figure</li></ul><h3>How to Protect Yourself</h3><ul><li>Always verify identity before sharing information (even to "IT")</li><li>Do NOT plug in found USB drives or devices</li><li>Challenge anyone entering secure areas without visible ID</li><li>Be skeptical of unusually urgent requests</li><li>Discuss suspicious contacts with your security team</li></ul>' },
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
      id:'m6', title:'Secure Remote Working', description:'Best practices for working securely from home or remote locations, protecting organizational data on personal networks.',
      category:'remote-work', type:'text', difficulty:'beginner', duration:'20 min',
      thumbnail:null, icon:'🏠', thumbColor:'linear-gradient(135deg,#14b8a6,#0f766e)',
      content:{ richText:'<h3>Remote Work Security Risks</h3><p>Working outside the office introduces additional cybersecurity risks including insecure networks, home device vulnerabilities, and physical security concerns.</p><h3>Key Security Measures</h3><ul><li><strong>Always use VPN</strong> when connecting to company systems remotely</li><li><strong>Secure your home WiFi</strong> with WPA3 encryption and a strong password</li><li><strong>Use company-approved devices</strong> for work — avoid personal devices</li><li><strong>Lock your screen</strong> when stepping away, even at home</li><li><strong>Avoid public WiFi</strong> — use a mobile hotspot if needed</li></ul><h3>Video Conferencing Security</h3><ul><li>Use meeting passwords for all virtual meetings</li><li>Be aware of your background — no sensitive documents should be visible</li><li>Use the waiting room feature to vet participants</li><li>Report any unauthorized meeting participants immediately</li></ul><h3>Physical Security</h3><ul><li>Keep work documents secure and out of sight</li><li>Shred or securely dispose of printed work materials</li><li>Do not let family members use work devices</li></ul>' },
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
      id:'m7', title:'Mobile Device Security', description:'Protect smartphones and tablets containing corporate data from theft, loss, and malicious applications.',
      category:'endpoint-security', type:'text', difficulty:'beginner', duration:'15 min',
      thumbnail:null, icon:'📱', thumbColor:'linear-gradient(135deg,#6366f1,#4338ca)',
      content:{ richText:'<h3>Mobile Security Threats</h3><p>Mobile devices are increasingly targeted by attackers due to their access to email, corporate systems, and sensitive data.</p><h3>Essential Security Settings</h3><ul><li>Enable screen lock with PIN, password, or biometrics</li><li>Keep operating system and apps updated</li><li>Enable remote wipe capability (MDM enrollment)</li><li>Encrypt device storage</li><li>Disable Bluetooth and WiFi when not in use</li></ul><h3>Safe App Usage</h3><ul><li>Only install apps from official stores (App Store, Google Play)</li><li>Review app permissions before installing</li><li>Remove unused applications regularly</li><li>Never install apps from unknown sources or links</li></ul><h3>If Your Device is Lost or Stolen</h3><ul><li>Report immediately to IT Security team</li><li>Use remote wipe to erase all data</li><li>Change all passwords that were stored on the device</li><li>Review recent activity for unauthorized access</li></ul>' },
      frameworkControls:[
        { framework:'NCA-ECC', domain:'ECC-2', control:'ECC-2-5' },
        { framework:'SAMA',    domain:'SAMA-4', control:'SAMA-4-1' },
        { framework:'CST',     domain:'CST-PR', control:'PR-PT-3' },  // Least Privilege — correct control for mobile security
      ],
      passMark:70, quizId:'q7', mandatory:false,
      targetRoles:['employee'], targetDepts:[], createdAt:'2026-01-21T00:00:00Z', createdBy:'u1', status:'published'
    },
    {
      id:'m8', title:'Third-Party & Vendor Risk', description:'Understanding the cybersecurity risks posed by third-party vendors, suppliers, and contractors.',
      category:'third-party', type:'text', difficulty:'advanced', duration:'30 min',
      thumbnail:null, icon:'🤝', thumbColor:'linear-gradient(135deg,#f59e0b,#b45309)',
      content:{ richText:'<h3>Third-Party Risk Defined</h3><p>Third-party risk refers to the potential for harm to your organization through vendors, suppliers, partners, or contractors who have access to your systems or data.</p><h3>Why Third-Party Risk Matters</h3><ul><li>Major breaches often start through a vendor (e.g., Target, SolarWinds)</li><li>Vendors may have access to sensitive data or systems</li><li>Contractual and regulatory obligations require vendor oversight</li><li>SAMA and NCA frameworks specifically require third-party controls</li></ul><h3>Your Role in Third-Party Security</h3><ul><li>Never share your credentials with third-party vendors</li><li>Verify vendor identity before granting access</li><li>Report any unexpected vendor contact to your manager</li><li>Do not connect vendor equipment to company networks without IT approval</li><li>Follow the principle of least privilege for all external access</li></ul><h3>Regulatory Requirements</h3><ul><li>SAMA requires formal third-party security assessment and contracts</li><li>NCA ECC-4-1 requires controls for all third-party relationships</li><li>Annual reviews of vendor access rights are mandatory</li></ul>' },
      frameworkControls:[
        { framework:'NCA-ECC', domain:'ECC-4', control:'ECC-4-1' },
        { framework:'SAMA',    domain:'SAMA-4', control:'SAMA-4-1' },
        { framework:'SAMA',    domain:'SAMA-4', control:'SAMA-4-2' },
        { framework:'CST',     domain:'CST-ID', control:'ID-SC-1' },
      ],
      passMark:75, quizId:'q8', mandatory:false,
      targetRoles:['employee'], targetDepts:['IT','Finance'], createdAt:'2026-01-22T00:00:00Z', createdBy:'u1', status:'published'
    },
    {
      id:'m9', title:'Business Continuity & Cyber Resilience', description:'Understanding your role in maintaining business continuity during and after a cyber incident.',
      category:'resilience', type:'text', difficulty:'advanced', duration:'25 min',
      thumbnail:null, icon:'🏗️', thumbColor:'linear-gradient(135deg,#0284c7,#075985)',
      content:{ richText:'<h3>What is Cyber Resilience?</h3><p>Cyber resilience is the ability to continuously deliver intended outcomes despite adverse cyber events — the capacity to anticipate, withstand, recover from, and adapt to attacks.</p><h3>Business Continuity Planning (BCP)</h3><ul><li>Every organization must have a tested Business Continuity Plan</li><li>BCP covers what to do if key systems become unavailable</li><li>Know your role in the BCP — ask your manager</li><li>Participate in BCP drills and exercises</li></ul><h3>Disaster Recovery</h3><ul><li>Critical systems must be backed up regularly</li><li>Backup data must be stored offline or offsite</li><li>Recovery Time Objectives (RTO) define how quickly systems must be restored</li><li>Never bypass backup procedures — they protect the entire organization</li></ul><h3>Your Role During an Incident</h3><ul><li>Follow the Incident Response Plan (IRP) guidelines</li><li>Communicate only through approved channels</li><li>Do NOT use compromised systems even if they "seem fine"</li><li>Support the IT Security team by providing accurate incident information</li></ul>' },
      frameworkControls:[
        { framework:'NCA-ECC', domain:'ECC-3', control:'ECC-3-1' },
        { framework:'SAMA',    domain:'SAMA-5', control:'SAMA-5-1' },
        { framework:'SAMA',    domain:'SAMA-5', control:'SAMA-5-2' },
        { framework:'CST',     domain:'CST-RC', control:'RC-RP-1' },
      ],
      passMark:70, quizId:'q9', mandatory:false,
      targetRoles:['employee'], targetDepts:['IT','Ops'], createdAt:'2026-01-23T00:00:00Z', createdBy:'u1', status:'published'
    },
    {
      id:'m10', title:'Cloud Security Basics', description:'Essential cloud security practices for employees using cloud applications and storage services.',
      category:'cloud-security', type:'text', difficulty:'intermediate', duration:'25 min',
      thumbnail:null, icon:'☁️', thumbColor:'linear-gradient(135deg,#22c55e,#15803d)',
      content:{ richText:'<h3>Cloud Security Overview</h3><p>Cloud computing provides flexibility and efficiency but introduces unique security challenges, particularly around data control, access management, and compliance.</p><h3>Shared Responsibility Model</h3><ul><li>Cloud providers secure the infrastructure (hardware, network)</li><li>You (the customer) are responsible for securing your data and access</li><li>Always understand the shared responsibility boundaries of your cloud service</li></ul><h3>Safe Cloud Usage Practices</h3><ul><li>Only use organization-approved cloud services — no personal Dropbox/Google Drive for work data</li><li>Enable Multi-Factor Authentication (MFA) on all cloud accounts</li><li>Never share cloud account credentials with colleagues</li><li>Review sharing permissions regularly — avoid "anyone with link" sharing</li><li>Encrypt sensitive data before uploading to cloud storage</li></ul><h3>NCA Cloud Security Requirements</h3><ul><li>NCA CCC requires organizations to maintain cloud asset inventories</li><li>Data stored in cloud must meet NCA data residency requirements (Saudi Arabia)</li><li>Cloud Identity & Access Management must be centrally managed</li><li>Report any unauthorized cloud application usage to IT immediately</li></ul>' },
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

  /* Quizzes */
  const quizzes = [
    {
      id:'q1', moduleId:'m1', title:'Password Security Assessment', timeLimit:10, passMark:70, attempts:3,
      questions:[
        { id:'qq1', text:'What is the minimum recommended password length?', options:['6 characters','8 characters','12 characters','20 characters'], correct:2, explanation:'Modern security standards recommend at least 12 characters for strong passwords.' },
        { id:'qq2', text:'Which of the following is the STRONGEST password?', options:['ahmed@1990','P@ssw0rd!','MyD0g!Likes3Bones#2024','password123'], correct:2, explanation:'Passphrases combining multiple words with special characters are the strongest option.' },
        { id:'qq3', text:'What should you do if you suspect your password has been compromised?', options:['Wait and see if anything happens','Change it immediately','Tell your colleagues','Write a new one on paper'], correct:1, explanation:'Immediately changing a compromised password prevents unauthorized access.' },
        { id:'qq4', text:'What is Multi-Factor Authentication (MFA)?', options:['Using two different passwords','A second verification step beyond the password','Changing your password monthly','Using a longer password'], correct:1, explanation:'MFA adds an extra verification layer (OTP, biometric) beyond just the password.' },
        { id:'qq5', text:'Which of the following is safe password practice?', options:['Reusing passwords across sites','Sharing passwords with trusted colleagues','Using a password manager','Writing passwords in your email drafts'], correct:2, explanation:'Password managers securely store and generate unique passwords for each account.' },
      ]
    },
    {
      id:'q2', moduleId:'m2', title:'Phishing Awareness Assessment', timeLimit:10, passMark:70, attempts:3,
      questions:[
        { id:'qq1', text:'You receive an email asking you to "verify your account immediately or it will be suspended." What should you do first?', options:['Click the link to verify','Forward to colleagues','Check the sender address and report if suspicious','Reply asking for more details'], correct:2, explanation:'Urgency is a classic phishing tactic. Always verify the sender and report suspicious emails.' },
        { id:'qq2', text:'What is "Spear Phishing"?', options:['Phishing using fishing-themed emails','Mass phishing targeting everyone','Targeted phishing aimed at specific individuals','Phishing via phone calls'], correct:2, explanation:'Spear phishing is highly targeted, using personal information to appear legitimate.' },
        { id:'qq3', text:'You receive an email with an attachment from an unknown sender. What is the safest action?', options:['Open it to see what it contains','Scan it with antivirus then open','Do not open — report to IT Security','Forward to your manager to check'], correct:2, explanation:'Never open attachments from unknown senders. Report to IT Security immediately.' },
        { id:'qq4', text:'How can you check if a link in an email is safe before clicking?', options:['Click quickly and close if suspicious','Hover over the link to see the real URL','Ask the sender via the same email','Copy and paste it into Google'], correct:1, explanation:'Hovering reveals the actual destination URL without clicking, allowing you to spot fake links.' },
        { id:'qq5', text:'Which is a red flag indicating a phishing email?', options:['Personalized greeting with your full name','Sent from the company domain','Generic greeting like "Dear Customer"','Contains company logo'], correct:2, explanation:'Generic greetings like "Dear Customer" or "Dear User" indicate a mass phishing attempt.' },
      ]
    },
    {
      id:'q3', moduleId:'m3', title:'Data Classification Assessment', timeLimit:12, passMark:70, attempts:3,
      questions:[
        { id:'qq1', text:'Which classification level should be applied to a document containing national security information?', options:['Public','Confidential','Secret','Top Secret'], correct:3, explanation:'Top Secret is the highest classification for information whose disclosure would cause severe national damage.' },
        { id:'qq2', text:'You need to send a confidential file to an external partner. What is the correct procedure?', options:['Attach it to a regular email','Use an approved secure file transfer method with encryption','Upload to personal Google Drive and share the link','Print it and mail it'], correct:1, explanation:'Confidential data must be transmitted using approved, encrypted channels only.' },
        { id:'qq3', text:'What should you do with classified printed documents you no longer need?', options:['Put them in the regular trash bin','Leave them on your desk','Shred using a cross-cut shredder','Store in your desk drawer indefinitely'], correct:2, explanation:'Classified documents must be destroyed using approved secure shredding methods.' },
        { id:'qq4', text:'Who can access "Secret" classified information?', options:['Any company employee','Anyone who asks politely','Only authorized personnel with a need-to-know','Senior management only'], correct:2, explanation:'Access to classified information is restricted to authorized personnel with a verified need-to-know.' },
        { id:'qq5', text:'A colleague asks to borrow your access credentials to retrieve a confidential document. What do you do?', options:['Share your credentials briefly','Help them apply for proper access through official channels','Tell your manager after sharing','Refuse without explanation'], correct:1, explanation:'Credentials must never be shared. Help colleagues obtain proper authorized access through official processes.' },
      ]
    },
    {
      id:'q4', moduleId:'m4', title:'Incident Reporting Assessment', timeLimit:10, passMark:70, attempts:3,
      questions:[
        { id:'qq1', text:'You notice your computer is running unusually slow and displaying unexpected pop-ups. What is your FIRST action?', options:['Restart the computer','Continue working and monitor','Disconnect from the network and contact IT Security','Run a public antivirus scan'], correct:2, explanation:'Disconnecting prevents potential malware from spreading across the network while IT investigates.' },
        { id:'qq2', text:'You accidentally clicked a phishing link. What should you do?', options:['Nothing if nothing happened','Wait 24 hours and report if problems arise','Report to IT Security immediately, even if nothing seems wrong','Close the browser and forget it'], correct:2, explanation:'All phishing clicks must be reported immediately — attackers may have already acted.' },
        { id:'qq3', text:'Who should you report a cybersecurity incident to?', options:['Your direct manager','Your colleagues first','The official IT Security team via the incident hotline','Post about it on the company intranet'], correct:2, explanation:'Always report incidents through the official IT Security incident reporting channel.' },
        { id:'qq4', text:'Why should you NOT try to fix a security incident yourself?', options:['It is against company policy','You could destroy digital evidence needed for investigation','It takes too long','IT Security will be angry'], correct:1, explanation:'Attempting to fix it yourself can destroy critical forensic evidence and worsen the situation.' },
        { id:'qq5', text:'Which of these is NOT a security incident that requires reporting?', options:['Receiving a suspicious email','Your regular scheduled system update','A colleague asking for your password','Finding an unattended USB drive'], correct:1, explanation:'Routine system updates are not security incidents. All other scenarios require reporting.' },
      ]
    },
    {
      id:'q5', moduleId:'m5', title:'Social Engineering Assessment', timeLimit:10, passMark:70, attempts:3,
      questions:[
        { id:'qq1', text:'Someone calls claiming to be from IT Support and asks for your password to fix an issue. What do you do?', options:['Give it — IT needs it to help you','Ask them to email you first','Refuse — IT never needs your password','Give it but change it afterwards'], correct:2, explanation:'Legitimate IT support never needs your password. This is a classic social engineering attack.' },
        { id:'qq2', text:'You find a USB drive labeled "Salary Information 2026" in the office parking lot. What do you do?', options:['Plug it in to see if it belongs to a colleague','Give it to the reception desk','Hand it to IT Security without plugging it in','Keep it for yourself'], correct:2, explanation:'Found USB drives are a classic baiting attack. Hand it to IT Security who can safely analyze it.' },
        { id:'qq3', text:'What is "Pretexting" in the context of social engineering?', options:['Sending fake emails','Creating a fabricated story to manipulate someone into sharing information','Physically breaking into a building','Installing hidden cameras'], correct:1, explanation:'Pretexting involves creating a false scenario (e.g., "I\'m an auditor") to manipulate victims.' },
        { id:'qq4', text:'Someone follows closely behind you as you badge into a secure area. What should you do?', options:['Hold the door — it would be rude not to','Challenge them politely and ask them to badge in separately','Ignore it — they probably work here','Report to security only if they look suspicious'], correct:1, explanation:'Tailgating is a physical social engineering attack. Always require everyone to badge in individually.' },
        { id:'qq5', text:'How can you best protect yourself from social engineering?', options:['Trust everyone who seems professional','Verify identity before sharing any information, regardless of urgency','Only be suspicious of people you do not recognize','Share information quickly to avoid inconveniencing legitimate requesters'], correct:1, explanation:'Always verify identity and authorization before sharing any sensitive information, no matter how urgent the request seems.' },
      ]
    },
    {
      id:'q6', moduleId:'m6', title:'Remote Work Security Assessment', timeLimit:10, passMark:70, attempts:3,
      questions:[
        { id:'qq1', text:'What must you always use when accessing company systems from home?', options:['A fast internet connection','The company VPN','A separate computer','Your personal email'], correct:1, explanation:'A VPN encrypts your connection, protecting data from interception on untrusted home networks.' },
        { id:'qq2', text:'You need to urgently access work systems at a coffee shop. What should you do?', options:['Connect to the coffee shop WiFi','Use your mobile phone hotspot with VPN','Any public WiFi is fine with VPN','Wait until you get home'], correct:1, explanation:'Use your mobile hotspot (not public WiFi) and always connect via VPN for security.' },
        { id:'qq3', text:'Your child wants to use your work laptop for schoolwork. What is the correct response?', options:['Allow it briefly since you will supervise','Allow only on weekends','Never allow personal use of work devices','Allow if they only use educational sites'], correct:2, explanation:'Work devices must never be used for personal activities. They may contain sensitive data and security configurations.' },
        { id:'qq4', text:'You step away from your home office for 5 minutes. What should you do?', options:['Leave your work visible — no one is home','Lock your screen','Log out completely','Nothing — you will be right back'], correct:1, explanation:'Always lock your screen when stepping away, even briefly and even at home.' },
        { id:'qq5', text:'What WiFi security protocol should your home router use?', options:['WEP','WPA','WPA2 or WPA3','No password is fine for convenience'], correct:2, explanation:'WPA2 or WPA3 provides strong encryption. WEP and WPA are outdated and easily compromised.' },
      ]
    },
    {
      id:'q7', moduleId:'m7', title:'Mobile Security Assessment', timeLimit:8, passMark:70, attempts:3,
      questions:[
        { id:'qq1', text:'Your work phone is lost. What is the FIRST thing you should do?', options:['Buy a new phone','Report to IT Security for remote wipe','Try to find it first','Change your email password'], correct:1, explanation:'Reporting immediately allows IT to remotely wipe the device before data is accessed.' },
        { id:'qq2', text:'Which of these is a safe mobile app practice?', options:['Install apps from any website for cheaper prices','Install apps only from official app stores','Install apps recommended by friends on messaging apps','Install apps with the highest number of downloads'], correct:1, explanation:'Official app stores (App Store, Google Play) review apps for malware. Third-party sources are unsafe.' },
        { id:'qq3', text:'What should you enable to protect data if your device is lost?', options:['Location sharing','Remote wipe (MDM)','Auto-brightness','App notifications'], correct:1, explanation:'Mobile Device Management (MDM) remote wipe erases all data on a lost or stolen device.' },
        { id:'qq4', text:'You receive an SMS with a link to "claim your prize." What do you do?', options:['Click the link — it might be real','Forward to colleagues to check','Delete the SMS and do not click the link','Reply asking for more information'], correct:2, explanation:'This is a smishing (SMS phishing) attack. Delete it without clicking the link.' },
        { id:'qq5', text:'Why should you disable Bluetooth when not using it?', options:['It drains battery too fast','Attackers can exploit Bluetooth to access your device','It slows down WiFi','It is company policy'], correct:1, explanation:'Bluetooth attacks (BlueSnarfing, BlueBugging) can allow attackers to access your device when Bluetooth is enabled.' },
      ]
    },
    {
      id:'q8', moduleId:'m8', title:'Third-Party Risk Assessment', timeLimit:12, passMark:75, attempts:2,
      questions:[
        { id:'qq1', text:'A vendor requests remote access to your computer to fix an issue. What should you verify first?', options:['Their company name','Their identity and that the request was authorized by IT Security','That they have a nice website','Their price quote'], correct:1, explanation:'Always verify vendor identity and confirm authorization with IT Security before granting any access.' },
        { id:'qq2', text:'Which framework requires formal third-party security assessments?', options:['Only SAMA','Only NCA ECC','Both SAMA and NCA ECC-4-1','Neither framework covers this'], correct:2, explanation:'Both SAMA (Third-Party Cybersecurity domain) and NCA ECC-4-1 require formal third-party security controls.' },
        { id:'qq3', text:'A contractor wants to connect their personal laptop to the company network. What should you say?', options:['Allow it if they need it for their work','Direct them to IT Security for proper network access provisioning','Allow it temporarily for urgent tasks','Refuse without explanation'], correct:1, explanation:'Third-party device access must go through IT Security for proper vetting and provisioning.' },
        { id:'qq4', text:'Why are third-party vendors a significant cybersecurity risk?', options:['They use different software','They may have access to your systems and data, creating an indirect attack surface','They work slower','They charge higher fees'], correct:1, explanation:'Vendors with system access create indirect attack paths — many major breaches started through a trusted vendor.' },
        { id:'qq5', text:'How often should vendor access rights be reviewed according to best practice?', options:['Never — if you gave them access, trust them','Only when you suspect a problem','At least annually','Every five years'], correct:2, explanation:'Annual reviews of all third-party access rights are required by SAMA and NCA frameworks.' },
      ]
    },
    {
      id:'q9', moduleId:'m9', title:'Business Continuity Assessment', timeLimit:12, passMark:70, attempts:3,
      questions:[
        { id:'qq1', text:'What is a Business Continuity Plan (BCP)?', options:['A financial backup plan','A documented plan to maintain operations during and after a disruption','A data backup schedule','A list of emergency contacts'], correct:1, explanation:'A BCP ensures the organization can continue critical operations despite cyber incidents or disasters.' },
        { id:'qq2', text:'What does "Recovery Time Objective (RTO)" mean?', options:['How much data you can afford to lose','The maximum acceptable time to restore a system after failure','The cost of recovery','The number of staff needed for recovery'], correct:1, explanation:'RTO defines the maximum tolerable downtime — how quickly systems must be restored to avoid unacceptable impact.' },
        { id:'qq3', text:'During a cyber incident, you discover you can still access some compromised systems. Should you continue using them?', options:['Yes — if they work, use them','Only for urgent tasks','No — report and avoid compromised systems until cleared by IT Security','Yes if your work is critical'], correct:2, explanation:'Compromised systems must not be used even if they appear functional — they may be spreading malware or leaking data.' },
        { id:'qq4', text:'Why must backup data be stored offline or offsite?', options:['To save server storage space','To prevent ransomware from encrypting backups along with live data','For easier access','To comply with cost reduction policies'], correct:1, explanation:'Ransomware attacks specifically target and encrypt network-connected backups. Offline backups are the last line of defense.' },
        { id:'qq5', text:'What should you do if a major cyber incident disrupts your normal communication systems?', options:['Use personal email and messaging apps','Follow the approved backup communication channels in the BCP','Post updates on social media','Wait for IT to fix everything'], correct:1, explanation:'The BCP defines approved backup communication channels to be used when primary systems are compromised.' },
      ]
    },
    {
      id:'q10', moduleId:'m10', title:'Cloud Security Assessment', timeLimit:10, passMark:70, attempts:3,
      questions:[
        { id:'qq1', text:'Under the cloud Shared Responsibility Model, who is responsible for protecting your data in the cloud?', options:['Entirely the cloud provider','Entirely the customer (you)','It is shared — the provider secures infrastructure, you secure your data','Nobody — cloud is inherently secure'], correct:2, explanation:'The Shared Responsibility Model means you are responsible for your data and access even in the cloud.' },
        { id:'qq2', text:'Which of the following violates cloud security policy?', options:['Using the company-approved cloud storage','Enabling MFA on your cloud account','Storing work documents on your personal Google Drive','Reviewing your file sharing permissions'], correct:2, explanation:'Personal cloud services (personal Google Drive, Dropbox) are not approved for work data under NCA guidelines.' },
        { id:'qq3', text:'What does NCA require regarding cloud data storage location?', options:['Data can be stored anywhere globally','Data must meet Saudi Arabia data residency requirements','Data must be stored in the US','No specific location requirements'], correct:1, explanation:'NCA regulations require that specific categories of Saudi organizational data be stored within Saudi Arabia.' },
        { id:'qq4', text:'You notice someone has shared a sensitive company document via "Anyone with the link." What should you do?', options:['Leave it — it is convenient for collaboration','Change the sharing setting to restrict access and report to IT Security','Only report if the document is labeled confidential','Ask the person who shared it if they mind'], correct:1, explanation:'Unrestricted sharing of company documents violates data protection policies. Restrict access and report immediately.' },
        { id:'qq5', text:'What is the MOST important security control for cloud account access?', options:['A strong password alone','Multi-Factor Authentication (MFA)','Logging in from the same device always','Using a private browser window'], correct:1, explanation:'MFA is the single most effective control for preventing unauthorized cloud account access, even if passwords are stolen.' },
      ]
    },
  ];
  dbSet(DB.QUIZZES, quizzes);

  /* Enrollments */
  const now = new Date();
  const due30 = new Date(now.getTime() + 30*24*60*60*1000).toISOString();
  const due7  = new Date(now.getTime() + 7*24*60*60*1000).toISOString();
  const past  = new Date(now.getTime() - 5*24*60*60*1000).toISOString(); // 5 days ago (overdue)
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
    { id:'qr1', userId:'u2', quizId:'q1', moduleId:'m1', attempt:1, score:9, total:10, percentage:90, passed:true,  answers:[2,2,1,1,2], submittedAt:'2026-02-10T10:00:00Z', timeSpent:480 },
    { id:'qr2', userId:'u2', quizId:'q2', moduleId:'m2', attempt:1, score:8, total:10, percentage:80, passed:true,  answers:[2,2,2,1,2], submittedAt:'2026-02-14T10:00:00Z', timeSpent:520 },
    { id:'qr3', userId:'u4', quizId:'q1', moduleId:'m1', attempt:1, score:5,  total:5, percentage:100,passed:true,  answers:[2,2,1,1,2], submittedAt:'2026-02-20T10:00:00Z', timeSpent:400 },
    { id:'qr4', userId:'u4', quizId:'q2', moduleId:'m2', attempt:1, score:4,  total:5, percentage:85, passed:true,  answers:[2,2,2,1,2], submittedAt:'2026-02-22T10:00:00Z', timeSpent:450 },
    { id:'qr5', userId:'u5', quizId:'q1', moduleId:'m1', attempt:1, score:3,  total:5, percentage:60, passed:false, answers:[0,2,0,1,2], submittedAt:'2026-02-20T10:00:00Z', timeSpent:600 },
    { id:'qr6', userId:'u6', quizId:'q1', moduleId:'m1', attempt:1, score:3,  total:4, percentage:75, passed:true,  answers:[2,2,1,1,2], submittedAt:'2026-03-01T10:00:00Z', timeSpent:380 },
    { id:'qr7', userId:'u7', quizId:'q1', moduleId:'m1', attempt:1, score:5,  total:5, percentage:95, passed:true,  answers:[2,2,1,1,2], submittedAt:'2026-02-12T10:00:00Z', timeSpent:300 },
    { id:'qr8', userId:'u7', quizId:'q7', moduleId:'m7', attempt:1, score:4,  total:5, percentage:80, passed:true,  answers:[1,1,1,2,1], submittedAt:'2026-02-18T10:00:00Z', timeSpent:350 },
    { id:'qr9', userId:'u9', quizId:'q1', moduleId:'m1', attempt:1, score:4,  total:5, percentage:85, passed:true,  answers:[2,2,1,1,2], submittedAt:'2026-03-05T10:00:00Z', timeSpent:420 },
  ];
  dbSet(DB.QUIZ_RESULTS, qresults);

  /* Phishing Campaigns */
  const campaigns = [
    {
      id:'ph1', name:'Q1 2026 IT Password Reset Simulation',
      description:'Tests susceptibility to fake IT department password reset emails.',
      templateId:'tpl-pwd-reset', status:'completed',
      targetUserIds:['u2','u3','u4','u5','u6','u8','u9','u10'],
      targetDepts:['IT','Finance','HR','Ops'],
      launchedAt:'2026-02-01T00:00:00Z', endsAt:'2026-02-28T00:00:00Z',
      createdBy:'u1'
    },
    {
      id:'ph2', name:'March 2026 — IT Support Ticket Simulation',
      description:'Simulates a fake IT support ticket requiring immediate login to resolve a "security issue".',
      templateId:'tpl-it-support', status:'active',
      targetUserIds:['u3','u5','u8','u10'],
      targetDepts:['Finance','Ops'],
      launchedAt:'2026-03-01T00:00:00Z', endsAt:'2026-03-31T00:00:00Z',
      createdBy:'u1'
    },
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

  /* Build initial compliance records */
  rebuildOrgCompliance();

  localStorage.setItem('cap_seeded', '1');
}
