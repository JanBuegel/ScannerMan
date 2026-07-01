import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── shared .env reader ────────────────────────────────────────────────────────
function readEnvFile() {
  try {
    return readFileSync(join(ROOT, '.env'), 'utf8');
  } catch {
    return '';
  }
}

function getEnvVar(name) {
  if (process.env[name]) return process.env[name];
  const raw = readEnvFile();
  for (const line of raw.split('\n')) {
    const eqIdx = line.indexOf('=');
    if (eqIdx !== -1 && line.slice(0, eqIdx).trim() === name) {
      return line.slice(eqIdx + 1).trim() || undefined;
    }
  }
  return undefined;
}

// ── public loaders ────────────────────────────────────────────────────────────

export function loadApiKey() {
  const key = getEnvVar('API_KEY');
  if (!key) throw new Error(
    'API key not found.\n' +
    '  → Set it in a .env file:  echo "API_KEY=xxx" > .env\n' +
    '  → Or inline:              API_KEY=xxx node index.js ...'
  );
  return key;
}

export function loadRentmanToken() {
  const token = getEnvVar('RENTMAN_API_TOKEN');
  if (!token) throw new Error(
    'Rentman token not found.\n' +
    '  → Add RENTMAN_API_TOKEN=xxx to your .env file'
  );
  return token;
}

/** Returns the Rentman token or null if not configured (non-throwing). */
export function tryLoadRentmanToken() {
  try { return loadRentmanToken(); } catch { return null; }
}

export function loadSunmiCreds() {
  const appId  = getEnvVar('SUNMI_APP_ID');
  const appKey = getEnvVar('SUNMI_APP_KEY');
  if (!appId || !appKey) throw new Error(
    'Sunmi credentials not found.\n' +
    '  → Add SUNMI_APP_ID=xxx and SUNMI_APP_KEY=xxx to your .env file'
  );
  return { appId, appKey };
}

/** Returns { appId, appKey } or null if not configured (non-throwing). */
export function tryLoadSunmiCreds() {
  try { return loadSunmiCreds(); } catch { return null; }
}

/** Shared secret the NUC print agent uses to authenticate. Null if not set. */
export function tryLoadPrintAgentToken() {
  return getEnvVar('PRINT_AGENT_TOKEN') || null;
}

export function loadAuthConfig() {
  const passwordHash  = getEnvVar('AUTH_PASSWORD_HASH');
  const sessionSecret = getEnvVar('SESSION_SECRET');
  if (!passwordHash || !sessionSecret) throw new Error(
    'Authentication not configured.\n' +
    '  → Run:  node tools/set-password.js <password>\n' +
    '    (writes AUTH_PASSWORD_HASH + SESSION_SECRET to .env)'
  );
  return { passwordHash, sessionSecret };
}
