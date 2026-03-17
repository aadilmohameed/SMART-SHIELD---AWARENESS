/* =====================================================
   SmartShield CyberAware — graph.js
   Microsoft Graph API + MSAL.js Integration
   Office 365 / Azure AD / Exchange Online
   ===================================================== */

'use strict';

/* ── Azure Config Keys ── */
const AZ_CONFIG_KEY = 'cap_azure_config';
const AZ_SESSION_KEY = 'cap_az_session';

/* ── Default MSAL Config ── */
function getAzureConfig() {
  const saved = JSON.parse(localStorage.getItem(AZ_CONFIG_KEY) || '{}');
  return {
    clientId:    saved.clientId    || '',
    tenantId:    saved.tenantId    || 'common',
    redirectUri: saved.redirectUri || (window.location.origin + (window.location.pathname.includes('/Awareness') ? '/Awareness/' : '/')),
    senderEmail: saved.senderEmail || '',
    senderName:  saved.senderName  || 'Smart Shield Cyber Security',
    enabled:     saved.enabled     !== undefined ? saved.enabled : false,
  };
}

function saveAzureConfig(config) {
  localStorage.setItem(AZ_CONFIG_KEY, JSON.stringify(config));
}

function isAzureConfigured() {
  const c = getAzureConfig();
  return c.enabled && c.clientId && c.tenantId;
}

/* ── MSAL Instance (lazy init) ── */
let _msalInstance = null;
let _msalInitialized = false;

function getMsalInstance() {
  if (_msalInstance) return _msalInstance;
  const cfg = getAzureConfig();
  if (!cfg.clientId) return null;
  if (typeof msal === 'undefined') { console.warn('MSAL.js not loaded'); return null; }

  const msalConfig = {
    auth: {
      clientId:    cfg.clientId,
      authority:   `https://login.microsoftonline.com/${cfg.tenantId}`,
      redirectUri: cfg.redirectUri || window.location.origin,
    },
    cache: { cacheLocation: 'localStorage', storeAuthStateInCookie: true },
    system: { loggerOptions: { logLevel: msal.LogLevel.Warning } },
  };

  _msalInstance = new msal.PublicClientApplication(msalConfig);
  return _msalInstance;
}

/* ── MSAL Scopes ── */
const GRAPH_SCOPES = {
  basic:    ['openid', 'profile', 'email', 'User.Read'],
  users:    ['openid', 'profile', 'email', 'User.Read', 'User.ReadBasic.All'],
  mail:     ['openid', 'profile', 'email', 'User.Read', 'Mail.Send'],
  full:     ['openid', 'profile', 'email', 'User.Read', 'User.ReadBasic.All', 'Mail.Send'],
};

/* ── Microsoft SSO Login ── */
async function msSignIn(scopeSet = 'full') {
  const instance = getMsalInstance();
  if (!instance) throw new Error('Azure configuration is missing. Please set up Azure App Registration in Settings → Azure Integration.');
  const scopes = GRAPH_SCOPES[scopeSet] || GRAPH_SCOPES.full;
  try {
    const result = await instance.loginPopup({ scopes, prompt: 'select_account' });
    localStorage.setItem(AZ_SESSION_KEY, JSON.stringify({
      accountId:   result.account.homeAccountId,
      name:        result.account.name,
      email:       result.account.username,
      tenantId:    result.tenantId,
      expiresOn:   result.expiresOn,
    }));
    return result;
  } catch (err) {
    if (err.errorCode === 'user_cancelled') return null;
    throw err;
  }
}

async function msSignOut() {
  const instance = getMsalInstance();
  localStorage.removeItem(AZ_SESSION_KEY);
  if (!instance) return;
  const accounts = instance.getAllAccounts();
  if (accounts.length > 0) {
    await instance.logoutPopup({ account: accounts[0] }).catch(() => {});
  }
}

function getMsSession() {
  try { return JSON.parse(localStorage.getItem(AZ_SESSION_KEY)); }
  catch(e) { return null; }
}

function isMsSignedIn() {
  const session = getMsSession();
  if (!session) return false;
  // Check token not expired
  return new Date(session.expiresOn) > new Date();
}

/* ── Get Access Token Silently ── */
async function getAccessToken(scopes = GRAPH_SCOPES.full) {
  const instance = getMsalInstance();
  if (!instance) throw new Error('MSAL not initialized');
  const accounts = instance.getAllAccounts();
  if (!accounts.length) throw new Error('No Microsoft account signed in. Please sign in with Microsoft first.');
  try {
    const result = await instance.acquireTokenSilent({ scopes, account: accounts[0] });
    return result.accessToken;
  } catch (err) {
    // Silent failed — try interactive
    if (err instanceof msal.InteractionRequiredAuthError) {
      const result = await instance.acquireTokenPopup({ scopes, account: accounts[0] });
      return result.accessToken;
    }
    throw err;
  }
}

/* ── Microsoft Graph API Base Call ── */
async function graphCall(method, endpoint, body = null, scopes = GRAPH_SCOPES.full) {
  const token   = await getAccessToken(scopes);
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
  };
  if (body) options.body = JSON.stringify(body);
  const response = await fetch(`https://graph.microsoft.com/v1.0${endpoint}`, options);
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: { message: response.statusText } }));
    throw new Error(err.error?.message || `Graph API error: ${response.status}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

/* ── Sync Users from Azure AD ── */
async function syncUsersFromAzureAD(onProgress) {
  if (onProgress) onProgress('Connecting to Azure AD…', 0);
  let endpoint = '/users?$select=id,displayName,mail,userPrincipalName,jobTitle,department,accountEnabled&$top=100';
  const allUsers = [];

  while (endpoint) {
    const data = await graphCall('GET', endpoint, null, GRAPH_SCOPES.users);
    if (data.value) allUsers.push(...data.value);
    endpoint = data['@odata.nextLink'] ? data['@odata.nextLink'].replace('https://graph.microsoft.com/v1.0', '') : null;
    if (onProgress) onProgress(`Fetched ${allUsers.length} users…`, Math.min(80, allUsers.length));
  }

  if (onProgress) onProgress('Importing users into platform…', 85);
  const colors = ['#0ea5e9','#22c55e','#f59e0b','#ef4444','#8b5cf6','#ec4899','#14b8a6','#f97316','#6366f1'];
  let imported = 0, skipped = 0, updated = 0;

  allUsers.forEach((azUser, i) => {
    const email = (azUser.mail || azUser.userPrincipalName || '').toLowerCase();
    if (!email || !azUser.displayName) { skipped++; return; }
    // Skip service/system accounts
    if (email.includes('#ext#') || email.startsWith('sync_')) { skipped++; return; }

    const existing = findUserByEmail(email);
    const dept = azUser.department || 'General';

    // Ensure dept exists
    const depts = dbGet(DB.DEPARTMENTS);
    if (!depts.find(d => d.name === dept)) {
      dbSave(DB.DEPARTMENTS, { id: genId('dept'), name: dept, code: dept.slice(0,4).toUpperCase(), headCount:0, riskLevel:'medium', compliancePct:0 });
    }

    if (existing) {
      existing.name       = azUser.displayName;
      existing.jobTitle   = azUser.jobTitle || existing.jobTitle || '';
      existing.department = dept;
      existing.azureId    = azUser.id;
      existing.status     = azUser.accountEnabled ? 'active' : 'inactive';
      dbSave(DB.USERS, existing);
      updated++;
    } else {
      dbSave(DB.USERS, {
        id:         genId('u'),
        name:       azUser.displayName,
        email,
        password:   'AzureAD_SSO',
        role:       'employee',
        department: dept,
        jobTitle:   azUser.jobTitle || '',
        sector:     'corporate',
        riskScore:  0,
        color:      colors[i % colors.length],
        azureId:    azUser.id,
        lastLogin:  null,
        createdAt:  new Date().toISOString(),
        status:     azUser.accountEnabled ? 'active' : 'inactive',
      });
      imported++;
    }
  });

  if (onProgress) onProgress('Done!', 100);
  return { total: allUsers.length, imported, updated, skipped };
}

/* ── Send Email via Graph (Mail.Send delegated) ── */
async function sendEmailViaGraph(toEmail, toName, subject, htmlBody, fromName) {
  const cfg     = getAzureConfig();
  const message = {
    message: {
      subject,
      body: { contentType: 'HTML', content: htmlBody },
      toRecipients: [{ emailAddress: { address: toEmail, name: toName || toEmail } }],
    },
    saveToSentItems: false,
  };
  await graphCall('POST', '/me/sendMail', message, GRAPH_SCOPES.mail);
  return true;
}

/* ── Send Batch Emails (with delay to avoid throttling) ── */
async function sendBatchEmails(recipients, subjectFn, bodyFn, onProgress) {
  let sent = 0, failed = 0;
  for (const r of recipients) {
    try {
      await sendEmailViaGraph(r.email, r.name, subjectFn(r), bodyFn(r));
      sent++;
    } catch (err) {
      console.error('Failed to send to', r.email, err);
      failed++;
    }
    if (onProgress) onProgress(sent + failed, recipients.length, sent, failed);
    // Rate limit: Graph allows ~30 requests/minute for Mail.Send
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  return { sent, failed };
}

/* ── Phishing Email Templates ── */
const PHISHING_TEMPLATES = {
  'tpl-pwd-reset': {
    name: 'IT Password Reset Request',
    subject: 'ACTION REQUIRED: Your Password Will Expire in 24 Hours',
    fromDisplay: 'IT Support Team',
    body: (user, campaign, clickUrl) => `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff">
        <div style="background:#0078d4;padding:20px;text-align:center">
          <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/4/44/Microsoft_logo.svg/200px-Microsoft_logo.svg.png" height="30" alt="Microsoft" style="filter:brightness(0)invert(1)">
        </div>
        <div style="padding:32px">
          <h2 style="color:#1f2937;margin-bottom:8px">Your password is expiring soon</h2>
          <p style="color:#374151">Dear ${user.name},</p>
          <p style="color:#374151">Your Microsoft account password will expire in <strong>24 hours</strong>. You must reset it immediately to avoid losing access to your email, Teams, and company systems.</p>
          <div style="text-align:center;margin:32px 0">
            <a href="${clickUrl}" style="background:#0078d4;color:#fff;padding:14px 32px;border-radius:4px;text-decoration:none;font-weight:bold;font-size:16px">Reset Password Now</a>
          </div>
          <p style="color:#6b7280;font-size:13px">If you do not reset your password, you will be locked out of your account. Contact IT Support at extension 1234 if you have any questions.</p>
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
          <p style="color:#9ca3af;font-size:12px">This email was sent by IT Support. © ${new Date().getFullYear()} Company IT Department.</p>
        </div>
      </div>`,
  },
  'tpl-it-support': {
    name: 'IT Support Ticket Alert',
    subject: 'Your IT Support Ticket #TK-8821 Requires Immediate Action',
    fromDisplay: 'IT Helpdesk',
    body: (user, campaign, clickUrl) => `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff">
        <div style="background:#1f2937;padding:20px;display:flex;align-items:center;gap:12px">
          <span style="color:#22c55e;font-size:24px">🛡️</span>
          <span style="color:#fff;font-weight:bold;font-size:18px">IT Helpdesk Portal</span>
        </div>
        <div style="padding:32px">
          <div style="background:#fef2f2;border-left:4px solid #ef4444;padding:16px;margin-bottom:24px">
            <strong style="color:#991b1b">⚠️ URGENT: Security Incident Detected</strong>
          </div>
          <p style="color:#374151">Dear ${user.name},</p>
          <p style="color:#374151">A security alert has been raised on your account. Suspicious login activity was detected from an unrecognized device. Your account has been temporarily flagged.</p>
          <p style="color:#374151"><strong>Ticket ID:</strong> TK-8821<br><strong>Priority:</strong> HIGH<br><strong>Status:</strong> Awaiting your verification</p>
          <div style="text-align:center;margin:32px 0">
            <a href="${clickUrl}" style="background:#ef4444;color:#fff;padding:14px 32px;border-radius:4px;text-decoration:none;font-weight:bold;font-size:16px">Verify My Account Now</a>
          </div>
          <p style="color:#9ca3af;font-size:12px">IT Helpdesk | Do not reply to this email</p>
        </div>
      </div>`,
  },
  'tpl-hr-policy': {
    name: 'HR Policy Update Required',
    subject: 'Important: Updated HR Policy — Your Acknowledgment Required by End of Day',
    fromDisplay: 'Human Resources',
    body: (user, campaign, clickUrl) => `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff">
        <div style="background:#7c3aed;padding:20px;text-align:center">
          <span style="color:#fff;font-weight:bold;font-size:20px">HR Department</span>
        </div>
        <div style="padding:32px">
          <p style="color:#374151">Dear ${user.name},</p>
          <p style="color:#374151">As part of our annual compliance review, all employees are required to review and acknowledge the updated <strong>Acceptable Use Policy and Code of Conduct</strong>.</p>
          <p style="color:#374151"><strong>Deadline: Today by 5:00 PM</strong></p>
          <p style="color:#ef4444">Failure to acknowledge may result in temporary suspension of system access.</p>
          <div style="text-align:center;margin:32px 0">
            <a href="${clickUrl}" style="background:#7c3aed;color:#fff;padding:14px 32px;border-radius:4px;text-decoration:none;font-weight:bold;font-size:16px">Review & Acknowledge Policy</a>
          </div>
          <p style="color:#9ca3af;font-size:12px">Human Resources Department</p>
        </div>
      </div>`,
  },
  'tpl-bank-verify': {
    name: 'Account Verification Alert',
    subject: 'Security Alert: Verify Your Account Immediately',
    fromDisplay: 'Security Team',
    body: (user, campaign, clickUrl) => `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff">
        <div style="background:#b45309;padding:20px;text-align:center">
          <span style="color:#fff;font-size:24px;font-weight:bold">🔐 Security Alert</span>
        </div>
        <div style="padding:32px">
          <div style="background:#fffbeb;border:1px solid #f59e0b;border-radius:8px;padding:16px;margin-bottom:24px">
            <p style="margin:0;color:#92400e"><strong>Your account requires immediate verification</strong></p>
          </div>
          <p style="color:#374151">Dear ${user.name},</p>
          <p style="color:#374151">We detected an unusual sign-in to your account from a new location. To secure your account, please verify your identity immediately.</p>
          <div style="text-align:center;margin:32px 0">
            <a href="${clickUrl}" style="background:#f59e0b;color:#fff;padding:14px 32px;border-radius:4px;text-decoration:none;font-weight:bold;font-size:16px">Verify Account Now</a>
          </div>
          <p style="color:#9ca3af;font-size:12px">Security Team | Do not share this email</p>
        </div>
      </div>`,
  },
  'tpl-ceo-request': {
    name: 'Executive Urgent Request (CEO Fraud)',
    subject: 'Urgent Request — Please Handle Immediately',
    fromDisplay: 'CEO Office',
    body: (user, campaign, clickUrl) => `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;padding:32px">
        <p style="color:#374151">Hi ${user.name},</p>
        <p style="color:#374151">I'm in a board meeting right now and need you to handle something urgent. Please review the attached confidential document and confirm receipt.</p>
        <p style="color:#374151">I need your response within the next 30 minutes. Please do not call me — I'm in the meeting.</p>
        <div style="text-align:center;margin:32px 0">
          <a href="${clickUrl}" style="background:#1f2937;color:#fff;padding:14px 32px;border-radius:4px;text-decoration:none;font-weight:bold;font-size:16px">View Confidential Document</a>
        </div>
        <p style="color:#374151">Best regards,<br><strong>CEO</strong><br><em>Sent from iPhone</em></p>
      </div>`,
  },
};

/* ── Training Reminder Email Template ── */
function buildReminderEmail(user, enrollment, mod) {
  const daysLeft = daysUntil ? daysUntil(enrollment.dueDate) : '—';
  const isOverdueFlag = enrollment.status === 'overdue';
  const platformUrl = getAzureConfig().redirectUri || window.location.origin;
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff">
      <div style="background:linear-gradient(135deg,#060d14,#0a1628);padding:24px;display:flex;align-items:center;gap:14px">
        <span style="font-size:28px">🛡️</span>
        <div>
          <div style="color:#fff;font-weight:800;font-size:18px">SmartShield CyberAware</div>
          <div style="color:rgba(255,255,255,0.5);font-size:12px;text-transform:uppercase;letter-spacing:.08em">Smart Shield Cyber Security</div>
        </div>
      </div>
      <div style="padding:32px">
        <div style="background:${isOverdueFlag?'#fef2f2':'#fffbeb'};border-left:4px solid ${isOverdueFlag?'#ef4444':'#f59e0b'};padding:16px;margin-bottom:24px;border-radius:4px">
          <strong style="color:${isOverdueFlag?'#991b1b':'#92400e'}">${isOverdueFlag?'⏰ OVERDUE — Immediate Action Required':'⚠️ Training Due Soon'}</strong>
        </div>
        <p style="color:#374151">Dear ${user.name},</p>
        <p style="color:#374151">
          ${isOverdueFlag
            ? `Your mandatory cybersecurity training <strong>"${mod.title}"</strong> is <strong style="color:#ef4444">OVERDUE</strong>. Please complete it immediately.`
            : `You have ${daysLeft} day(s) remaining to complete <strong>"${mod.title}"</strong> before the deadline.`
          }
        </p>
        <div style="background:#f9fafb;border-radius:8px;padding:20px;margin:20px 0">
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:4px 0;color:#6b7280;font-size:13px">Module</td><td style="color:#111827;font-weight:600;font-size:13px">${mod.title}</td></tr>
            <tr><td style="padding:4px 0;color:#6b7280;font-size:13px">Framework</td><td style="color:#111827;font-size:13px">${[...new Set((mod.frameworkControls||[]).map(f=>f.framework))].join(', ')}</td></tr>
            <tr><td style="padding:4px 0;color:#6b7280;font-size:13px">Duration</td><td style="color:#111827;font-size:13px">${mod.duration||'—'}</td></tr>
            <tr><td style="padding:4px 0;color:#6b7280;font-size:13px">Due Date</td><td style="color:${isOverdueFlag?'#ef4444':'#111827'};font-weight:600;font-size:13px">${enrollment.dueDate ? new Date(enrollment.dueDate).toLocaleDateString('en-SA') : '—'}</td></tr>
          </table>
        </div>
        <div style="text-align:center;margin:28px 0">
          <a href="${platformUrl}/employee/learn.html?module=${mod.id}" style="background:linear-gradient(135deg,#0ea5e9,#0284c7);color:#fff;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:16px">Start Training Now →</a>
        </div>
        <p style="color:#6b7280;font-size:13px">NCA · SAMA · CST Framework Compliance</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0">
        <p style="color:#9ca3af;font-size:12px">You are receiving this because you are enrolled in cybersecurity awareness training at your organization. For support, contact your IT Security team.</p>
        <p style="color:#9ca3af;font-size:12px">Smart Shield Cyber Security | MSSP Cybersecurity Awareness Platform</p>
      </div>
    </div>`;
}

/* ── Certificate Email Template ── */
function buildCertificateEmail(user, mod, result) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff">
      <div style="background:linear-gradient(135deg,#060d14,#0a1628);padding:24px;text-align:center">
        <span style="font-size:40px">🛡️</span>
        <div style="color:#fff;font-weight:800;font-size:20px;margin-top:8px">SmartShield CyberAware</div>
      </div>
      <div style="padding:40px;text-align:center">
        <div style="background:linear-gradient(135deg,#0c1f3d,#0f2a50);border-radius:12px;padding:40px;color:#fff;border:2px solid rgba(14,165,233,0.3)">
          <div style="font-size:48px;margin-bottom:12px">🏆</div>
          <div style="font-size:11px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:#0ea5e9;margin-bottom:8px">Certificate of Completion</div>
          <div style="font-size:26px;font-weight:800;margin-bottom:6px">${user.name}</div>
          <div style="color:rgba(255,255,255,0.6);margin-bottom:20px">has successfully completed</div>
          <div style="font-size:18px;font-weight:700;color:#38bdf8;margin-bottom:20px">${mod.title}</div>
          <div style="display:inline-block;background:rgba(34,197,94,0.15);border:1px solid rgba(34,197,94,0.3);padding:8px 24px;border-radius:999px;font-size:14px;color:#4ade80;margin-bottom:20px">Score: ${result.percentage}% ✅ Passed</div>
          <div style="font-size:13px;color:rgba(255,255,255,0.4)">Completed on ${new Date(result.submittedAt||new Date()).toLocaleDateString('en-SA',{day:'2-digit',month:'long',year:'numeric'})}</div>
          <div style="margin-top:28px;padding-top:20px;border-top:1px solid rgba(255,255,255,0.1)">
            <div style="font-weight:700;color:#38bdf8">Smart Shield Cyber Security</div>
            <div style="font-size:11px;color:rgba(255,255,255,0.4)">MSSP Awareness Platform | NCA · SAMA · CST Certified</div>
          </div>
        </div>
        <p style="color:#6b7280;font-size:13px;margin-top:20px">Congratulations on completing your cybersecurity training! Keep up the great work in protecting our organization.</p>
      </div>
    </div>`;
}

/* ── Get Current Microsoft User Profile ── */
async function getMyProfile() {
  return graphCall('GET', '/me?$select=displayName,mail,userPrincipalName,jobTitle,department', null, GRAPH_SCOPES.basic);
}

/* ── Test Connection ── */
async function testGraphConnection() {
  try {
    const profile = await getMyProfile();
    return { ok: true, user: profile };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
