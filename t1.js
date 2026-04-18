const fs = require('fs');
const path = require('path');
const https = require('https'); // fallback if needed
const http = require('http');

require('dotenv').config();

const DIFY_BASE = process.env.DIFY_API_BASE || 'https://pc105port80.octopus-tech.com';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const WORKFLOWS_DIR = process.env.WORKFLOWS_DIR || '/workflows';
const IMPORT_MODE = (process.env.IMPORT_MODE || 'skip').toLowerCase();

const axios = require('axios').default;

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseCookieValue(cookie, name) {
  const match = cookie.match(new RegExp(`${name}=([^;]+)`));
  return match ? match[1] : null;
}

function getAccessTokenFromCookies(setCookie) {
  if (!setCookie) return null;
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const cookie of cookies) {
    const token = parseCookieValue(cookie, '__Host-access_token');
    if (token) return token;
  }
  return null;
}

function getCsrfTokenFromCookies(setCookie) {
  if (!setCookie) return null;
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const cookie of cookies) {
    const token = parseCookieValue(cookie, '__Host-csrf_token');
    if (token) return token;
  }
  return null;
}

function getCookieHeader(setCookie) {
  if (!setCookie) return null;
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  return cookies
    .map(cookie => cookie.split(';')[0])
    .join('; ');
}

async function login() {
  const url = `${DIFY_BASE}/console/api/login`;
  const encodedPassword = Buffer.from(ADMIN_PASSWORD, 'utf8').toString('base64');
  console.log(`🔐 Logging in as ${ADMIN_EMAIL}...`);
  const response = await axios.post(url, {
    email: ADMIN_EMAIL,
    password: encodedPassword,
  }, { timeout: 10000 });

  const token = getAccessTokenFromCookies(response.headers['set-cookie']) ||
                response.data.access_token ||
                response.data.data?.access_token;
  if (!token) throw new Error('No access_token received from login');

  const cookieHeader = getCookieHeader(response.headers['set-cookie']);
  const csrfToken = getCsrfTokenFromCookies(response.headers['set-cookie']);
  console.log('🔑 Logged in successfully');
  return { token, cookieHeader, csrfToken };
}

function buildAuthHeaders({ token, csrfToken, cookieHeader }) {
  const headers = {
    Authorization: `Bearer ${token}`,
  };
  if (cookieHeader) headers.Cookie = cookieHeader;
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  return headers;
}

async function getCurrentWorkspace(auth) {
  const res = await axios.post(`${DIFY_BASE}/console/api/workspaces/current`, {}, {
    headers: buildAuthHeaders(auth),
  });
  console.log('📍 Current workspace:', res.data.name || res.data.id);
  return res.data;
}

async function listAllWorkspaces(auth) {
  try {
    const res = await axios.get(`${DIFY_BASE}/console/api/workspaces`, {
        headers: buildAuthHeaders(auth),
    });
    const workspaces = res.data.data || res.data || [];
    console.log(`📋 Found ${workspaces.length} workspace(s):`);
    workspaces.forEach(ws => {
      console.log(`   - ${ws.name} (ID: ${ws.id}) ${ws.id === ws.current_tenant_id ? '(current)' : ''}`);
    });
    return workspaces;
  } catch (err) {
    console.log('⚠️  Could not list all workspaces (single-workspace deployment?):', err.response?.status, err.response?.data);
    return [];
  }
}

async function switchWorkspace(auth, tenantId) {
  if (!tenantId) return false;

  try {
    const url = `${DIFY_BASE}/console/api/workspaces/switch`;
    await axios.post(url, { tenant_id: tenantId }, {
      headers: buildAuthHeaders(auth),
      timeout: 10000,
    });
    console.log(`✅ Switched to workspace ID: ${tenantId}`);
    await delay(1500); // small delay for session propagation
    return true;
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.message || err.message;
    console.log(`⚠️ Failed to switch to workspace ${tenantId} (${status}): ${msg}`);
    console.log('   → Continuing with current workspace');
    return false;
  }
}

async function getApps(auth) {
  const url = `${DIFY_BASE}/console/api/apps`;
  const response = await axios.get(url, {
    headers: buildAuthHeaders(auth),
    timeout: 10000,
  });
  const apps = response.data.data || [];
  const nameToApp = {};
  apps.forEach(app => {
    if (app.name) nameToApp[app.name] = app;
  });
  console.log(`📋 Found ${apps.length} existing apps: `);
  console.log(Object.keys(nameToApp).map(name => `   - ${name} (ID: ${nameToApp[name].id})`).join('\n'));
  return nameToApp;
}

// async function deleteApp(token, appId, name) {
//   const url = `${DIFY_BASE}/console/api/apps/${appId}`;
//   try {
//     await axios.delete(url, {
//       headers: { Authorization: `Bearer ${token}` },
//       timeout: 10000,
//     });
//     console.log(`🗑️  Deleted old app '${name}' (ID: ${appId})`);
//     return true;
//   } catch (err) {
//     console.log(`⚠️  Failed to delete app '${name}': ${err.response?.status || err.message}`);
//     return false;
//   }
// }

// async function importWorkflow(token, yamlPath, yamlContent) {
//   const filename = path.basename(yamlPath);
//   console.log(`📤 Importing ${filename}...`);

//   const url = `${DIFY_BASE}/console/api/apps/import`;
//   const payload = {
//     mode: 'yaml-content',
//     yaml_content: yamlContent,
//   };

//   try {
//     const response = await axios.post(url, payload, {
//       headers: {
//         Authorization: `Bearer ${token}`,
//         'Content-Type': 'application/json',
//       },
//       timeout: 30000,
//     });

//     console.log(`✅ Successfully imported ${filename}`);

//     // Auto-confirm if needed (newer DSL)
//     const respData = response.data;
//     const importId = respData.import_id || respData.data?.import_id;
//     if (importId) {
//       const confirmUrl = `${DIFY_BASE}/console/api/apps/import/${importId}/confirm`;
//       await axios.post(confirmUrl, {}, {
//         headers: { Authorization: `Bearer ${token}` },
//       }).catch(() => {}); // silent if not needed
//       console.log('   → Confirmed import');
//     }
//     return true;
//   } catch (err) {
//     const status = err.response?.status || 'unknown';
//     const msg = err.response?.data ? JSON.stringify(err.response.data).slice(0, 200) : err.message;
//     console.log(`❌ Import failed for ${filename}: ${status} ${msg}`);
//     return false;
//   }
// }

async function main() {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.error('❌ ADMIN_EMAIL or ADMIN_PASSWORD not set in .env');
    process.exit(1);
  }

  console.log(`🚀 Import mode: ${IMPORT_MODE.toUpperCase()}`);

  // Wait for Dify API
  console.log('⏳ Waiting for Dify API to be ready...');
  for (let i = 0; i < 40; i++) {
    try {
      const res = await axios.get(`${DIFY_BASE}/console/api/system-features`, { timeout: 5000 });
      if (res.status === 200) break;
    } catch (e) {
        process.stdout.write('.');
    }
    await delay(3000);
  }

  const auth = await login();
  let nameToApp = await getApps(auth);

  await getCurrentWorkspace(auth);
  await listAllWorkspaces(auth);


//   const ymlFiles = [];
//   const extensions = ['.yml', '.yaml'];
//   fs.readdirSync(WORKFLOWS_DIR).forEach(file => {
//     if (extensions.some(ext => file.toLowerCase().endsWith(ext))) {
//       ymlFiles.push(path.join(WORKFLOWS_DIR, file));
//     }
//   });

//   if (ymlFiles.length === 0) {
//     console.log('⚠️  No .yml/.yaml files found in /workflows');
//     return;
//   }

//   let processed = 0;

//   for (const ymlPath of ymlFiles) {
//     const filename = path.basename(ymlPath);
//     let content;
//     let workflowName = filename.replace(/\.(yml|yaml)$/i, '');

//     try {
//       content = fs.readFileSync(ymlPath, 'utf-8');
//       const dsl = require('js-yaml').load(content);   // we'll install js-yaml too
//       workflowName = dsl?.name ||
//                      dsl?.app?.name ||
//                      dsl?.workflow?.name ||
//                      workflowName;
//     } catch (e) {
//       console.log(`⚠️  Could not parse YAML for ${filename}, using filename as name`);
//       content = fs.readFileSync(ymlPath, 'utf-8');
//     }

//     const existing = nameToApp[workflowName];

//     if (IMPORT_MODE === 'skip' && existing) {
//       console.log(`⏭️  Skipping '${workflowName}' (ID: ${existing.id}) — already exists`);
//       continue;
//     }

//     if (IMPORT_MODE === 'overwrite' && existing) {
//       console.log(`🔄 Overwriting '${workflowName}' (ID: ${existing.id})`);
//       await deleteApp(token, existing.id, workflowName);
//       await delay(2000);
//     }

//     const success = await importWorkflow(token, ymlPath, content);
//     if (success) {
//       processed++;
//       if (IMPORT_MODE === 'overwrite') {
//         await delay(2000);
//         nameToApp = await getApps(auth); // refresh
//       }
//     }
//   }

//   console.log(`\n🎉 Done! ${processed}/${ymlFiles.length} workflows processed (${IMPORT_MODE} mode)`);
}

main().catch(err => {
  console.error('💥 Fatal error:', err.message, err.response?.data);
  process.exit(1);
});