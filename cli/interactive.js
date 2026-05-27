#!/usr/bin/env node

/**
 * Interactive CLI — can also be run directly: node cli/interactive.js
 */

import { input, confirm } from '@inquirer/prompts';
import { loadApiKey, tryLoadRentmanToken } from '../lib/config.js';
import { lookupDevices } from '../lib/api.js';
import { lookupByRef, updateSerial } from '../lib/rentman.js';

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const c = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  cyan:    '\x1b[36m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  red:     '\x1b[31m',
  magenta: '\x1b[35m',
};

function paynlessFound(s)  { return Boolean(s && s !== 'null'); }
function rentmanFound(s)   { return Boolean(s && s.trim()); }

function rowStatus(paynlessSerial, rentmanEntry) {
  const pf = paynlessFound(paynlessSerial);
  const rf = rentmanEntry && rentmanFound(rentmanEntry.serial);
  if (pf && rf)  return paynlessSerial === rentmanEntry.serial ? 'match' : 'mismatch';
  if (pf && !rf) return rentmanEntry ? 'paynless_only' : 'no_rentman';
  if (!pf && rf) return 'rentman_only';
  return 'not_found';
}

function renderTable(ids, paynlessSerials, rentmanEntries) {
  const rows = ids.map((id, i) => {
    const paynless = paynlessFound(paynlessSerials[i]) ? paynlessSerials[i] : null;
    const rentman  = rentmanEntries[i];
    return {
      id,
      paynless,
      rentmanSerial: rentman?.serial ?? null,
      rentmanId:     rentman?.id     ?? null,
      status:        rowStatus(paynless, rentman),
    };
  });

  const hasRentman = rentmanEntries.some(e => e !== null);

  // Column widths
  const w0 = Math.max(12, ...rows.map(r => r.id.length)) + 2;
  const w1 = Math.max(12, ...rows.map(r => (r.paynless       ?? '—').length)) + 2;
  const w2 = Math.max(12, ...rows.map(r => (r.rentmanSerial  ?? '—').length)) + 2;
  const w3 = 14;

  const line = (l, ms, r) =>
    `  ${l}${'─'.repeat(w0)}${ms}${'─'.repeat(w1)}${ms}${'─'.repeat(w2)}${ms}${'─'.repeat(w3)}${r}`;

  const row = (a, b, d, e, ac = '', bc = '', dc = '', ec = '') => {
    const pad = (s, w) => s.padEnd(w - 2);
    return `  │ ${ac}${pad(a,w0)}${c.reset} │ ${bc}${pad(b,w1)}${c.reset} │ ${dc}${pad(d,w2)}${c.reset} │ ${ec}${pad(e,w3)}${c.reset} │`;
  };

  const STATUS_TEXT = {
    match:         `${c.green}✓ Match${c.reset}`,
    mismatch:      `${c.yellow}≠ Abweichung${c.reset}`,
    paynless_only: `${c.yellow}fehlt Rentman${c.reset}`,
    rentman_only:  `${c.dim}nur Rentman${c.reset}`,
    no_rentman:    `${c.dim}nicht Rentman${c.reset}`,
    not_found:     `${c.dim}—${c.reset}`,
  };

  console.log(line('┌', '┬', '┐'));
  console.log(row(
    'Unser Kürzel', 'Paynless SN',
    hasRentman ? 'Rentman SN' : 'Rentman SN (–)', 'Status',
    c.bold + c.dim, c.bold + c.dim, c.bold + c.dim, c.bold + c.dim,
  ));
  console.log(line('├', '┼', '┤'));

  for (const r of rows) {
    const statusStr = STATUS_TEXT[r.status] ?? STATUS_TEXT.not_found;
    // Strip ANSI for padding calculation
    const statusPad = (r.status ?? 'not_found').replace(/_/g, ' ').padEnd(w3 - 2);
    console.log(
      `  │ ${c.cyan}${r.id.padEnd(w0 - 2)}${c.reset}` +
      ` │ ${r.paynless      ? c.green : c.dim}${(r.paynless      ?? '—').padEnd(w1 - 2)}${c.reset}` +
      ` │ ${r.rentmanSerial ? c.green : c.dim}${(r.rentmanSerial ?? '—').padEnd(w2 - 2)}${c.reset}` +
      ` │ ${statusStr.padEnd ? '' : ''}${statusStr} │`
    );
  }

  console.log(line('└', '┴', '┘'));

  // Summary
  const matchCount = rows.filter(r => r.status === 'match').length;
  console.log(
    `\n  ${matchCount === rows.length ? c.green : c.yellow}` +
    `${matchCount}/${rows.length} in Sync${c.reset}`
  );

  return rows;
}

function banner() {
  console.log();
  console.log(`  ${c.bold}${c.cyan}Serial Checker${c.reset}  ${c.dim}interactive mode${c.reset}`);
  console.log(`  ${c.dim}${'─'.repeat(38)}${c.reset}`);
  console.log();
}

export async function runInteractive() {
  banner();

  let apiKey;
  try {
    apiKey = loadApiKey();
    console.log(`  ${c.dim}Paynless API key geladen ✓${c.reset}`);
  } catch (e) {
    console.error(`  ${c.red}${e.message}${c.reset}\n`);
    process.exit(1);
  }

  const rentmanToken = tryLoadRentmanToken();
  if (rentmanToken) {
    console.log(`  ${c.dim}Rentman Token geladen ✓${c.reset}\n`);
  } else {
    console.log(`  ${c.yellow}RENTMAN_API_TOKEN nicht gesetzt — Rentman-Spalte leer.${c.reset}\n`);
  }

  let running = true;

  while (running) {
    const ids = [];

    console.log(`  ${c.dim}Seriennummern scannen oder eintippen — leere Zeile = Abfrage starten.${c.reset}\n`);

    while (true) {
      const prompt = ids.length === 0
        ? 'Seriennummer:'
        : `${c.dim}[${ids.length} erfasst]${c.reset} Nächste SN (oder Enter zum Abfragen):`;

      let val;
      try { val = await input({ message: prompt }); }
      catch { running = false; break; }

      const trimmed = val.trim();
      if (!trimmed) {
        if (ids.length === 0) {
          console.log(`  ${c.yellow}Mindestens eine SN eingeben.${c.reset}\n`);
          continue;
        }
        break;
      }

      const newIds = trimmed.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
      const added  = newIds.filter(id => !ids.includes(id));
      ids.push(...added);
      console.log(
        `  ${c.green}✓${c.reset} ${added.join(', ')}` +
        (ids.length > 1 ? `  ${c.dim}(${ids.length} gesamt)${c.reset}` : '')
      );
    }

    if (!running || ids.length === 0) break;

    console.log(`\n  ${c.dim}Abfrage läuft…${c.reset}`);
    const t0 = Date.now();

    try {
      const [paynlessResult, rentmanEntries] = await Promise.all([
        lookupDevices(ids, apiKey),
        rentmanToken
          ? Promise.all(ids.map(id => lookupByRef(id, rentmanToken)))
          : Promise.resolve(ids.map(() => null)),
      ]);

      const ms = Date.now() - t0;
      console.log(`  ${c.dim}Fertig in ${ms}ms${c.reset}\n`);

      const rows = renderTable(ids, paynlessResult.vendor_serials ?? [], rentmanEntries);

      // Offer to save mismatches to Rentman
      if (rentmanToken) {
        const saveable = rows.filter(r =>
          (r.status === 'mismatch' || r.status === 'paynless_only') && r.rentmanId && r.paynless
        );

        if (saveable.length > 0) {
          console.log(`\n  ${c.yellow}${saveable.length} Abweichung(en) — Paynless SN in Rentman speichern?${c.reset}`);
          saveable.forEach(r =>
            console.log(`  ${c.dim}  ${r.id}: ${r.paynless}${c.reset}`)
          );

          let doSave = false;
          try { doSave = await confirm({ message: 'Jetzt speichern?', default: false }); }
          catch { /* Ctrl-C */ }

          if (doSave) {
            for (const r of saveable) {
              try {
                await updateSerial(r.rentmanId, r.paynless, rentmanToken);
                console.log(`  ${c.green}✓${c.reset} ${r.id} → ${r.paynless}`);
              } catch (e) {
                console.error(`  ${c.red}✗ ${r.id}: ${e.message}${c.reset}`);
              }
            }
          }
        }
      }

    } catch (e) {
      console.error(`\n  ${c.red}✗ ${e.message}${c.reset}`);
    }

    console.log();

    try { running = await confirm({ message: 'Weitere Abfrage?', default: true }); }
    catch { running = false; }

    if (running) console.log();
  }

  console.log(`\n  ${c.dim}Tschüss!${c.reset}\n`);
}

// ── run directly ──────────────────────────────────────────────────────────────
import { fileURLToPath } from 'url';
import { resolve } from 'path';

if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runInteractive();
}
