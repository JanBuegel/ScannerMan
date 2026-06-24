#!/usr/bin/env node

/**
 * Set the shared login password.
 *   node tools/set-password.js <password>
 *
 * Writes AUTH_PASSWORD_HASH (scrypt) to .env and, if missing, generates a
 * SESSION_SECRET. Changing the password keeps the existing SESSION_SECRET so
 * other sessions aren't forcibly logged out (delete SESSION_SECRET to rotate).
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname }  from 'path';
import { randomBytes }     from 'crypto';
import { hashPassword }    from '../lib/auth.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV  = join(ROOT, '.env');

const password = process.argv[2];
if (!password) {
  console.error('Usage: node tools/set-password.js <password>');
  process.exit(1);
}

const lines = existsSync(ENV) ? readFileSync(ENV, 'utf8').split('\n') : [];

function setKey(key, value) {
  const line = `${key}=${value}`;
  const idx  = lines.findIndex(l => l.startsWith(`${key}=`));
  if (idx === -1) lines.push(line);
  else            lines[idx] = line;
}

setKey('AUTH_PASSWORD_HASH', hashPassword(password));

const hasSecret = lines.some(l => l.startsWith('SESSION_SECRET=') &&
                                  l.slice('SESSION_SECRET='.length).trim());
let generatedSecret = false;
if (!hasSecret) { setKey('SESSION_SECRET', randomBytes(32).toString('hex')); generatedSecret = true; }

let out = lines.join('\n');
if (!out.endsWith('\n')) out += '\n';
writeFileSync(ENV, out, 'utf8');

console.log('✓ Password set — AUTH_PASSWORD_HASH written to .env');
if (generatedSecret) console.log('✓ SESSION_SECRET generated');
console.log('  Restart the server for it to take effect.');
