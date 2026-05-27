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
