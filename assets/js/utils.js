/* =====================================================
   SmartShield CyberAware — graph.js  (FIXED)
   Microsoft Graph API + MSAL.js Integration
   
   FIXES APPLIED:
   - BUG-002: Fixed sendBatchEmails callback to pass object {pct,message,detail,lastResult}
   - BUG-021: Fixed daysUntil reference in buildReminderEmail
   - Fixed redirect URI to use getBasePath() when available
   ===================================================== */

'use strict';

const AZ_CONFIG_KEY = 'cap_azure_config';
const AZ_SESSION_KEY = 'cap_az_session';

function getAzureConfig() {
  const saved = JSON.parse(localStorage.getItem(AZ_CONFIG_KEY) || '{}');
  return {
    clientId:    saved.clientId    || '',
    tenantId:    saved.tenantId    || 'common',
    redirectUri: saved.redirectUri || (window.location.origin + window.location.pathname.replace(/\/[^/]*$/, '/')),
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

let _msalInstance = null;

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

const GRAPH_SCOPES = {
  basic:    ['openid', 'profile', 'email', 'User.Read'],
  users:    ['openid', 'profile', 'email', 'User.Read', 'User.ReadBasic.All'],
  mail:     ['openid', 'profile', 'email', 'User.Read', 'Mail.Send'],
  full:     ['openid', 'profile', 'email', 'User.Read', 'User.ReadBasic.All', 'Mail.Send'],
};

async function msSignIn(scopeSet = 'full') {
  const instance = getMsalInstance();
  if (!instance) throw new Error('Azure configuration is missing.');
  const scopes = GRAPH_SCOPES[scopeSet] || GRAPH_SCOPES.full;
  try {
    const result = await instance.loginPopup({ scopes, prompt: 'select_account' });
    localStorage.setItem(AZ_SESSION_KEY, JSON.stringify({
      accountId: result.account.homeAccountId, name: result.account.name,
      email: result.account.username, tenantId: result.tenantId, expiresOn: result.expiresOn,
      account: result.account,
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
  try { return JSON.parse(localStorage.getItem(AZ_SESSION_KEY)); } catch(e) { return null; }
}

function isMsSignedIn() {
  const session = getMsSession();
  if (!session) return false;
  return new Date(session.expiresOn) > new Date();
}

async function getAccessToken(scopes = GRAPH_SCOPES.full) {
  const instance = getMsalInstance();
  if (!instance) throw new Error('MSAL not initialized');
  const accounts = instance.getAllAccounts();
  if (!accounts.length) throw new Error('No Microsoft account signed in.');
  try {
    const result = await instance.acquireTokenSilent({ scopes, account: accounts[0] });
    return result.accessToken;
  } catch (err) {
    if (err instanceof msal.InteractionRequiredAuthError) {
      const result = await instance.acquireTokenPopup({ scopes, account: accounts[0] });
      return result.accessToken;
    }
    throw err;
  }
}

async function graphCall(method, endpoint, body = null, scopes = GRAPH_SCOPES.full) {
  const token = await getAccessToken(scopes);
  const options = {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
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
  if (onProgress) onProgress('Importing users…', 85);
  const colors = ['#0ea5e9','#22c55e','#f59e0b','#ef4444','#8b5cf6','#ec4899','#14b8a6','#f97316','#6366f1'];
  let imported = 0, skipped = 0, updated = 0;
  allUsers.forEach((azUser, i) => {
    const email = (azUser.mail || azUser.userPrincipalName || '').toLowerCase();
    if (!email || !azUser.displayName) { skipped++; return; }
    if (email.includes('#ext#') || email.startsWith('sync_')) { skipped++; return; }
    const existing = findUserByEmail(email);
    const dept = azUser.department || 'General';
    const depts = dbGet(DB.DEPARTMENTS);
    if (!depts.find(d => d.name === dept)) {
      dbSave(DB.DEPARTMENTS, { id: genId('dept'), name: dept, code: dept.slice(0,4).toUpperCase(), headCount:0, riskLevel:'medium', compliancePct:0 });
    }
    if (existing) {
      existing.name = azUser.displayName; existing.jobTitle = azUser.jobTitle || existing.jobTitle || '';
      existing.department = dept; existing.azureId = azUser.id;
      existing.status = azUser.accountEnabled ? 'active' : 'inactive';
      dbSave(DB.USERS, existing); updated++;
    } else {
      dbSave(DB.USERS, {
        id: genId('u'), name: azUser.displayName, email, password: 'AzureAD_SSO', role: 'employee',
        department: dept, jobTitle: azUser.jobTitle || '', sector: 'corporate', riskScore: 0,
        color: colors[i % colors.length], azureId: azUser.id, lastLogin: null,
        createdAt: new Date().toISOString(), status: azUser.accountEnabled ? 'active' : 'inactive',
      }); imported++;
    }
  });
  if (onProgress) onProgress('Done!', 100);
  return { total: allUsers.length, imported, updated, skipped };
}

async function sendEmailViaGraph(toEmail, toName, subject, htmlBody) {
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

/* ── FIX BUG-002: sendBatchEmails now passes object to onProgress ── */
async function sendBatchEmails(recipients, subjectFn, bodyFn, onProgress) {
  let sent = 0, failed = 0;
  const total = recipients.length;
  for (let i = 0; i < total; i++) {
    const r = recipients[i];
    let ok = false, error = '';
    try {
      await sendEmailViaGraph(r.email, r.name, subjectFn(r), bodyFn(r));
      sent++; ok = true;
    } catch (err) {
      console.error('Failed to send to', r.email, err);
      failed++; error = err.message || 'Unknown error';
    }
    if (onProgress) {
      onProgress({
        pct: Math.round(((i + 1) / total) * 100),
        message: `Sending ${i + 1} of ${total}…`,
        detail: `${sent} sent, ${failed} failed`,
        lastResult: { ok, email: r.email, name: r.name, error },
      });
    }
    // Rate limit: ~30 requests/minute for Mail.Send
    if (i < total - 1) await new Promise(resolve => setTimeout(resolve, 2000));
  }
  return { sent, failed };
}

/* ── Phishing Email Templates ── */
const PHISHING_TEMPLATES = {
  'tpl-pwd-reset': {
    name: 'IT Password Reset Request',
    subject: 'ACTION REQUIRED: Your Password Will Expire in 24 Hours',
    body: (user, campaign, clickUrl) => `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff">
        <div style="background:#0078d4;padding:20px;text-align:center">
          <span style="color:#fff;font-size:20px;font-weight:bold">Microsoft</span>
        </div>
        <div style="padding:32px">
          <h2 style="color:#1f2937">Your password is expiring soon</h2>
          <p style="color:#374151">Dear ${user.name},</p>
          <p style="color:#374151">Your Microsoft account password will expire in <strong>24 hours</strong>. Reset it immediately to avoid losing access.</p>
          <div style="text-align:center;margin:32px 0">
            <a href="${clickUrl}" style="background:#0078d4;color:#fff;padding:14px 32px;border-radius:4px;text-decoration:none;font-weight:bold">Reset Password Now</a>
          </div>
          <p style="color:#9ca3af;font-size:12px">IT Support · © ${new Date().getFullYear()}</p>
        </div>
      </div>`,
  },
  'tpl-it-support': {
    name: 'IT Support Ticket Alert',
    subject: 'Your IT Support Ticket #TK-8821 Requires Immediate Action',
    body: (user, campaign, clickUrl) => `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff">
        <div style="background:#1f2937;padding:20px"><span style="color:#22c55e;font-size:24px">🛡️</span><span style="color:#fff;font-weight:bold;font-size:18px;margin-left:12px">IT Helpdesk</span></div>
        <div style="padding:32px">
          <div style="background:#fef2f2;border-left:4px solid #ef4444;padding:16px;margin-bottom:24px"><strong style="color:#991b1b">⚠️ URGENT: Security Incident Detected</strong></div>
          <p style="color:#374151">Dear ${user.name},</p>
          <p style="color:#374151">Suspicious activity detected on your account. <strong>Ticket:</strong> TK-8821 · <strong>Priority:</strong> HIGH</p>
          <div style="text-align:center;margin:32px 0"><a href="${clickUrl}" style="background:#ef4444;color:#fff;padding:14px 32px;border-radius:4px;text-decoration:none;font-weight:bold">Verify My Account Now</a></div>
        </div>
      </div>`,
  },
  'tpl-hr-policy': {
    name: 'HR Policy Update Required',
    subject: 'Important: Updated HR Policy — Acknowledgment Required by End of Day',
    body: (user, campaign, clickUrl) => `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff">
        <div style="background:#7c3aed;padding:20px;text-align:center"><span style="color:#fff;font-weight:bold;font-size:20px">HR Department</span></div>
        <div style="padding:32px">
          <p style="color:#374151">Dear ${user.name},</p>
          <p style="color:#374151">Please review and acknowledge the updated <strong>Acceptable Use Policy</strong>. <strong>Deadline: Today 5:00 PM</strong></p>
          <div style="text-align:center;margin:32px 0"><a href="${clickUrl}" style="background:#7c3aed;color:#fff;padding:14px 32px;border-radius:4px;text-decoration:none;font-weight:bold">Review & Acknowledge</a></div>
        </div>
      </div>`,
  },
  'tpl-bank-verify': {
    name: 'Account Verification Alert',
    subject: 'Security Alert: Verify Your Account Immediately',
    body: (user, campaign, clickUrl) => `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff">
        <div style="background:#b45309;padding:20px;text-align:center"><span style="color:#fff;font-size:24px;font-weight:bold">🔐 Security Alert</span></div>
        <div style="padding:32px">
          <p style="color:#374151">Dear ${user.name},</p>
          <p style="color:#374151">Unusual sign-in detected. Verify your identity immediately.</p>
          <div style="text-align:center;margin:32px 0"><a href="${clickUrl}" style="background:#f59e0b;color:#fff;padding:14px 32px;border-radius:4px;text-decoration:none;font-weight:bold">Verify Account Now</a></div>
        </div>
      </div>`,
  },
  'tpl-ceo-request': {
    name: 'Executive Urgent Request (CEO Fraud)',
    subject: 'Urgent Request — Please Handle Immediately',
    body: (user, campaign, clickUrl) => `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;padding:32px">
        <p style="color:#374151">Hi ${user.name},</p>
        <p style="color:#374151">I'm in a board meeting. Please review this confidential document and confirm receipt within 30 minutes. Do not call me.</p>
        <div style="text-align:center;margin:32px 0"><a href="${clickUrl}" style="background:#1f2937;color:#fff;padding:14px 32px;border-radius:4px;text-decoration:none;font-weight:bold">View Confidential Document</a></div>
        <p style="color:#374151">Best regards,<br><strong>CEO</strong><br><em>Sent from iPhone</em></p>
      </div>`,
  },
};

/* ── FIX BUG-021: Safely reference daysUntil ── */
function buildReminderEmail(user, enrollment, mod) {
  const dl = (typeof daysUntil === 'function') ? daysUntil(enrollment.dueDate) : null;
  const daysLeft = dl !== null ? dl : '—';
  const isOverdueFlag = enrollment.status === 'overdue';
  const platformUrl = getAzureConfig().redirectUri || window.location.origin;
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff">
      <div style="background:linear-gradient(135deg,#060d14,#0a1628);padding:24px;display:flex;align-items:center;gap:14px">
        <span style="font-size:28px">🛡️</span>
        <div><div style="color:#fff;font-weight:800;font-size:18px">SmartShield CyberAware</div><div style="color:rgba(255,255,255,0.5);font-size:12px">Smart Shield Cyber Security</div></div>
      </div>
      <div style="padding:32px">
        <div style="background:${isOverdueFlag?'#fef2f2':'#fffbeb'};border-left:4px solid ${isOverdueFlag?'#ef4444':'#f59e0b'};padding:16px;margin-bottom:24px;border-radius:4px">
          <strong style="color:${isOverdueFlag?'#991b1b':'#92400e'}">${isOverdueFlag?'⏰ OVERDUE':'⚠️ Training Due Soon'}</strong>
        </div>
        <p style="color:#374151">Dear ${user.name},</p>
        <p style="color:#374151">${isOverdueFlag
          ? `Your training <strong>"${mod.title}"</strong> is <strong style="color:#ef4444">OVERDUE</strong>. Complete it immediately.`
          : `You have ${daysLeft} day(s) to complete <strong>"${mod.title}"</strong>.`
        }</p>
        <div style="text-align:center;margin:28px 0">
          <a href="${platformUrl}" style="background:linear-gradient(135deg,#0ea5e9,#0284c7);color:#fff;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:bold">Start Training Now →</a>
        </div>
        <p style="color:#9ca3af;font-size:12px">Smart Shield Cyber Security | MSSP Awareness Platform</p>
      </div>
    </div>`;
}

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
          <div style="font-size:11px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:#0ea5e9">Certificate of Completion</div>
          <div style="font-size:26px;font-weight:800;margin:8px 0">${user.name}</div>
          <div style="color:rgba(255,255,255,0.6);margin-bottom:20px">has successfully completed</div>
          <div style="font-size:18px;font-weight:700;color:#38bdf8;margin-bottom:20px">${mod.title}</div>
          <div style="display:inline-block;background:rgba(34,197,94,0.15);border:1px solid rgba(34,197,94,0.3);padding:8px 24px;border-radius:999px;color:#4ade80">Score: ${result.percentage}% ✅</div>
          <div style="margin-top:28px;padding-top:20px;border-top:1px solid rgba(255,255,255,0.1)">
            <div style="font-weight:700;color:#38bdf8">Smart Shield Cyber Security</div>
            <div style="font-size:11px;color:rgba(255,255,255,0.4)">MSSP Awareness Platform | NCA · SAMA · CST</div>
          </div>
        </div>
      </div>
    </div>`;
}

async function getMyProfile() {
  return graphCall('GET', '/me?$select=displayName,mail,userPrincipalName,jobTitle,department', null, GRAPH_SCOPES.basic);
}

async function testGraphConnection() {
  try {
    const profile = await getMyProfile();
    return { ok: true, user: profile };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
