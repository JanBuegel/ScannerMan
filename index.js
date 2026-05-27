#!/usr/bin/env node

/**
 * serialchecker — unified entry point
 *
 *   node index.js D2024 L2S021        direct lookup
 *   node index.js --interactive / -i  interactive CLI
 *   node index.js --web / -w          start web UI
 *   node index.js --help / -h         show this help
 */

import { loadApiKey } from './lib/config.js';
import { lookupDevices } from './lib/api.js';

const args = process.argv.slice(2);
const flag = args[0];

// ── help ─────────────────────────────────────────────────────────────────────
if (!flag || flag === '--help' || flag === '-h') {
  console.log(`
  serialchecker — device lookup tool

  Modes
    node index.js <ID1> [ID2] ...   Direct lookup (one shot)
    node index.js -i / --interactive  Interactive prompt loop
    node index.js -w / --web          Start web UI  (default port 3000)

  Environment
    API_KEY   Your API key — set via .env file or environment variable

  Examples
    node index.js D2024 L2S021
    node index.js -i
    node index.js -w
    PORT=8080 node index.js -w
  `);
  process.exit(0);
}

// ── interactive CLI ───────────────────────────────────────────────────────────
if (flag === '--interactive' || flag === '-i') {
  const { runInteractive } = await import('./cli/interactive.js');
  await runInteractive();
  process.exit(0);
}

// ── web server ────────────────────────────────────────────────────────────────
if (flag === '--web' || flag === '-w') {
  const { startServer } = await import('./web/server.js');
  startServer();
  // HTTP server keeps the event loop alive; no further code needed.
} else {

// ── direct lookup ─────────────────────────────────────────────────────────────
  let apiKey;
  try {
    apiKey = loadApiKey();
  } catch (e) {
    console.error(`\nError: ${e.message}\n`);
    process.exit(1);
  }

  const ids = args;
  console.log(`\nLooking up ${ids.length} device(s): ${ids.join(', ')}\n`);

  try {
    const data = await lookupDevices(ids, apiKey);
    console.log(JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}
