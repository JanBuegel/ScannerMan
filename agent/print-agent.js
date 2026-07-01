#!/usr/bin/env node

/**
 * TiTo print agent — runs on the LAN box (the "NUC") that owns the printers.
 *
 * The web UI now lives online, but the Zebra printers still hang off this box's
 * CUPS. This agent connects OUTBOUND to the cloud server (no inbound ports, no
 * cert, no firewall changes) and:
 *
 *   1. reports its CUPS printer list  (POST /api/agent/roster)  every ROSTER_MS
 *   2. long-polls for print jobs       (GET  /api/agent/next-job)
 *   3. prints each job via `lpr -o raw` and reports the outcome
 *                                       (POST /api/agent/result)
 *
 * Run:  CLOUD_URL=https://… PRINT_AGENT_TOKEN=… node agent/print-agent.js
 * (or put CLOUD_URL / PRINT_AGENT_TOKEN in a .env file next to the repo root)
 *
 * Requires Node 18+ (global fetch) and CUPS (`lpstat`, `lpr`) on the host.
 */

import { spawn }        from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

// ── config ────────────────────────────────────────────────────────────────────
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function env(name) {
  if (process.env[name]) return process.env[name];
  try {
    const raw = readFileSync(join(ROOT, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const i = line.indexOf('=');
      if (i !== -1 && line.slice(0, i).trim() === name) return line.slice(i + 1).trim() || undefined;
    }
  } catch {}
  return undefined;
}

const CLOUD_URL = (env('CLOUD_URL') || '').replace(/\/+$/, '');
const TOKEN     = env('PRINT_AGENT_TOKEN');
const ROSTER_MS = Number(env('AGENT_ROSTER_MS')) || 30_000;

if (!CLOUD_URL || !TOKEN) {
  console.error('Fehlt: CLOUD_URL und/oder PRINT_AGENT_TOKEN (env oder .env).');
  process.exit(1);
}

const HEADERS = { 'X-Agent-Token': TOKEN, 'Content-Type': 'application/json' };

// ── shell helpers ───────────────────────────────────────────────────────────
function run(cmd, args, stdin = null) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let out = '', err = '';
    proc.stdout.on('data', d => (out += d));
    proc.stderr.on('data', d => (err += d));
    proc.on('error', reject);
    proc.on('close', code =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}${err ? ': ' + err.trim() : ''}`)));
    if (stdin !== null) { proc.stdin.write(stdin); proc.stdin.end(); }
  });
}

async function listPrinters() {
  try {
    const out = await run('lpstat', ['-e']);
    return out.split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// Send raw ZPL straight to a CUPS destination (stdin → lpr, no temp file).
function printRaw(zpl, printer) {
  return run('lpr', ['-o', 'raw', '-P', printer], zpl);
}

// ── cloud helpers ─────────────────────────────────────────────────────────────
function post(path, body) {
  return fetch(`${CLOUD_URL}${path}`, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
}

// ── roster loop ─────────────────────────────────────────────────────────────
async function reportRoster() {
  try {
    const printers = await listPrinters();
    await post('/api/agent/roster', { printers });
  } catch (e) {
    console.warn(`Roster-Report fehlgeschlagen: ${e.message}`);
  }
}

// ── job loop ──────────────────────────────────────────────────────────────────
async function jobLoop() {
  for (;;) {
    let job = null;
    try {
      const res = await fetch(`${CLOUD_URL}/api/agent/next-job`, { headers: HEADERS });
      if (!res.ok) throw new Error(`next-job ${res.status}`);
      ({ job } = await res.json());
    } catch (e) {
      // Cloud unreachable / restarting — back off, then retry.
      console.warn(`Warte auf Cloud (${e.message})…`);
      await new Promise(r => setTimeout(r, 5_000));
      continue;
    }

    if (!job) continue;   // long-poll timed out with no work → poll again

    try {
      await printRaw(job.zpl, job.printer);
      console.log(`✓ gedruckt: ${job.id} → ${job.printer}`);
      await post('/api/agent/result', { id: job.id, ok: true });
    } catch (e) {
      console.error(`✗ Druckfehler ${job.id}: ${e.message}`);
      await post('/api/agent/result', { id: job.id, ok: false, error: e.message }).catch(() => {});
    }
  }
}

// ── start ─────────────────────────────────────────────────────────────────────
console.log(`TiTo print agent → ${CLOUD_URL}`);
await reportRoster();
setInterval(reportRoster, ROSTER_MS);
jobLoop();
