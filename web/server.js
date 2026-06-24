#!/usr/bin/env node

/**
 * Unified web server — Serial Checker + Serial Pairing + Print Suite
 * Can also be run directly: node web/server.js
 */

import { createServer }                    from 'http';
import { readFileSync, writeFileSync,
         unlinkSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath }                    from 'url';
import { join, dirname, extname, resolve }  from 'path';
import { exec, spawn }                      from 'child_process';
import { promisify }                        from 'util';

import { loadApiKey, tryLoadRentmanToken,
         tryLoadSunmiCreds, loadAuthConfig } from '../lib/config.js';
import { verifyPassword, createSessionToken, verifySessionToken,
         parseCookies, serializeCookie }    from '../lib/auth.js';
import { lookupDevices }                                          from '../lib/api.js';
import { lookupByRef, lookupByRefWithFallback,
         updateSerial, updateRef }                               from '../lib/rentman.js';
import { getDeviceInfoBySnList, listGroups,
         moveDeviceToGroup, rebootDevices } from '../lib/sunmi.js';
import { generateLabelZPL, generateCardZPL,
         expandSerials }                    from '../lib/zpl.js';

const execAsync  = promisify(exec);
const __dirname  = dirname(fileURLToPath(import.meta.url));
const PUBLIC     = join(__dirname, 'public');
const TMP        = join(__dirname, '..', 'tmp');
const LOGO_PATH  = join(PUBLIC, 'images', 'Logo_teamtoaster_full.png');
const PORT       = Number(process.env.PORT) || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

// ── helpers ───────────────────────────────────────────────────────────────────
function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', chunk => (buf += chunk));
    req.on('end',  () => resolve(buf));
    req.on('error', reject);
  });
}

function paynlessFound(s) { return s && s !== 'null'; }
function rentmanFound(s)   { return s && s.trim() !== ''; }

function rowStatus(paynlessSerial, rentmanEntry) {
  const pf = paynlessFound(paynlessSerial);
  const rf = rentmanEntry && rentmanFound(rentmanEntry.serial);
  if (pf && rf)  return paynlessSerial === rentmanEntry.serial ? 'match' : 'mismatch';
  if (pf && !rf) return rentmanEntry ? 'paynless_only' : 'no_rentman';
  if (!pf && rf) return 'rentman_only';
  return 'not_found';
}

// Send a ZPL file to a CUPS printer
async function printZPL(zpl, printerName) {
  if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });
  const tmpFile = join(TMP, `label_${Date.now()}.zpl`);
  writeFileSync(tmpFile, zpl, 'utf8');

  return new Promise((resolve, reject) => {
    const proc = spawn('lpr', ['-o', 'raw', '-P', printerName, tmpFile]);
    proc.on('error', err => { safeUnlink(tmpFile); reject(err); });
    proc.on('exit',  code => {
      safeUnlink(tmpFile);
      if (code === 0) resolve();
      else reject(new Error(`lpr exited with code ${code}`));
    });
  });
}

function safeUnlink(f) { try { unlinkSync(f); } catch {} }

// ── login page ──────────────────────────────────────────────────────────────
function serveLoginPage(res) {
  const html = `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ScannerMan — Anmelden</title>
  <style>
    :root {
      --bg:#f4f6fb; --surface:#fff; --border:#dde1ee; --text:#1a1d2e;
      --muted:#6b7280; --primary:#6366f1; --primary-dark:#4f46e5;
      --err-bg:#fff1f2; --err-border:#fecdd3; --err:#e11d48;
    }
    @media (prefers-color-scheme: dark) {
      :root { --bg:#0c0e1a; --surface:#141828; --border:#272c4a; --text:#e2e8f0;
              --muted:#94a3b8; --primary:#818cf8; --primary-dark:#6366f1;
              --err-bg:#1c0a10; --err-border:#9f1239; --err:#fb7185; }
    }
    * { box-sizing:border-box; margin:0; padding:0; }
    body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
           background:var(--bg); color:var(--text); min-height:100vh;
           display:flex; align-items:center; justify-content:center; padding:24px; }
    .card { background:var(--surface); border:1px solid var(--border);
            border-radius:12px; box-shadow:0 6px 24px rgba(0,0,0,.08);
            padding:32px 28px; width:100%; max-width:360px; }
    .title { font-size:22px; font-weight:800; letter-spacing:-.4px; text-align:center; margin-bottom:4px; }
    .title span { color:var(--primary); }
    .sub { font-size:13px; color:var(--muted); text-align:center; margin-bottom:24px; }
    label { display:block; font-size:11px; font-weight:700; text-transform:uppercase;
            letter-spacing:.08em; color:var(--muted); margin-bottom:7px; }
    input { width:100%; background:var(--surface); border:1.5px solid var(--border);
            border-radius:6px; padding:10px 12px; color:var(--text); font-size:15px; outline:none; }
    input:focus { border-color:var(--primary); box-shadow:0 0 0 3px color-mix(in srgb,var(--primary) 18%,transparent); }
    button { width:100%; margin-top:18px; background:var(--primary); color:#fff; border:none;
             border-radius:6px; padding:11px; font-size:15px; font-weight:600; cursor:pointer;
             transition:background .15s; }
    button:hover:not(:disabled) { background:var(--primary-dark); }
    button:disabled { opacity:.6; cursor:not-allowed; }
    .err { display:none; margin-top:16px; background:var(--err-bg); border:1px solid var(--err-border);
           color:var(--err); border-radius:6px; padding:10px 12px; font-size:13px; }
  </style>
</head>
<body>
  <form class="card" id="form" autocomplete="off">
    <div class="title">Scanner<span>Man</span></div>
    <div class="sub">Bitte anmelden</div>
    <label for="pw">Passwort</label>
    <input id="pw" type="password" autocomplete="current-password" autofocus />
    <button type="submit" id="btn">Anmelden</button>
    <div class="err" id="err"></div>
  </form>
  <script>
    const form = document.getElementById('form');
    const pw   = document.getElementById('pw');
    const btn  = document.getElementById('btn');
    const err  = document.getElementById('err');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.style.display = 'none';
      btn.disabled = true; btn.textContent = 'Anmelden…';
      try {
        const res = await fetch('/api/login', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ password: pw.value }),
        });
        if (res.ok) { location.href = '/'; return; }
        const data = await res.json().catch(() => ({}));
        err.textContent = data.error || 'Anmeldung fehlgeschlagen';
        err.style.display = 'block';
      } catch (e) {
        err.textContent = 'Netzwerkfehler';
        err.style.display = 'block';
      }
      btn.disabled = false; btn.textContent = 'Anmelden';
      pw.value = ''; pw.focus();
    });
  </script>
</body>
</html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

// ── server factory ────────────────────────────────────────────────────────────
const SESSION_TTL = 7 * 24 * 60 * 60;   // 7 days
const COOKIE_NAME = 'sid';

export function startServer() {
  let apiKey;
  try { apiKey = loadApiKey(); }
  catch (e) { console.error(`\nError: ${e.message}\n`); process.exit(1); }

  // Auth is mandatory — fail closed if not configured.
  let auth;
  try { auth = loadAuthConfig(); }
  catch (e) { console.error(`\nError: ${e.message}\n`); process.exit(1); }

  const rentmanToken     = tryLoadRentmanToken();
  const rentmanAvailable = Boolean(rentmanToken);

  if (!rentmanAvailable) {
    console.warn('  ⚠  RENTMAN_API_TOKEN not set — Rentman features disabled.\n');
  }

  const sunmiCreds     = tryLoadSunmiCreds();
  const sunmiAvailable = Boolean(sunmiCreds);

  if (!sunmiAvailable) {
    console.warn('  ⚠  SUNMI_APP_ID/SUNMI_APP_KEY not set — Sunmi features disabled.\n');
  }

  // Lazy-load heavy PDF deps only when first needed
  let _pdfLib = null, _qrcode = null;
  async function getPdfDeps() {
    if (!_pdfLib) {
      _pdfLib  = await import('pdf-lib');
      _qrcode  = (await import('qrcode')).default;
    }
    return { PDFDocument: _pdfLib.PDFDocument, rgb: _pdfLib.rgb, StandardFonts: _pdfLib.StandardFonts, QRCode: _qrcode };
  }

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const { method, url } = req;
    const path = url.split('?')[0];

    // ── Authentication gate ────────────────────────────────────────────────────
    const cookies = parseCookies(req.headers.cookie);
    const authed  = verifySessionToken(cookies[COOKIE_NAME], auth.sessionSecret);

    // POST /api/login — verify password, issue session cookie
    if (method === 'POST' && path === '/api/login') {
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return json(res, 400, { error: 'Invalid JSON body' }); }

      if (!verifyPassword(body?.password, auth.passwordHash)) {
        await new Promise(r => setTimeout(r, 400));   // slow down brute-force
        return json(res, 401, { error: 'Falsches Passwort' });
      }
      const token = createSessionToken(auth.sessionSecret, SESSION_TTL);
      res.setHeader('Set-Cookie', serializeCookie(COOKIE_NAME, token, SESSION_TTL));
      return json(res, 200, { ok: true });
    }

    // POST /api/logout — clear cookie
    if (method === 'POST' && path === '/api/logout') {
      res.setHeader('Set-Cookie', serializeCookie(COOKIE_NAME, '', 0));
      return json(res, 200, { ok: true });
    }

    // GET /login — login page (redirect to app if already authed)
    if (method === 'GET' && path === '/login') {
      if (authed) { res.writeHead(302, { Location: '/' }); return res.end(); }
      return serveLoginPage(res);
    }

    // Everything else requires a valid session.
    if (!authed) {
      if (path.startsWith('/api/')) return json(res, 401, { error: 'Not authenticated' });
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }

    // ── GET /api/printers ─────────────────────────────────────────────────────
    if (method === 'GET' && url === '/api/printers') {
      try {
        const { stdout } = await execAsync('lpstat -e');
        const printers = stdout.split('\n').map(s => s.trim()).filter(Boolean);
        return json(res, 200, printers);
      } catch {
        return json(res, 200, []); // no printers configured — return empty list
      }
    }

    // ── POST /api/lookup-full ─────────────────────────────────────────────────
    if (method === 'POST' && url === '/api/lookup-full') {
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return json(res, 400, { error: 'Invalid JSON body' }); }

      const ids = body?.ids;
      if (!Array.isArray(ids) || ids.length === 0)
        return json(res, 400, { error: '`ids` must be a non-empty array' });

      try {
        const [paynlessResult, rentmanResults] = await Promise.all([
          lookupDevices(ids, apiKey),
          rentmanToken
            ? Promise.all(ids.map(id => lookupByRefWithFallback(id, rentmanToken)))
            : Promise.resolve(ids.map(() => ({ entry: null, scannedRef: '', refMismatch: false }))),
        ]);

        const paynlessSerials = paynlessResult.vendor_serials ?? [];
        const rows = ids.map((ref, i) => {
          const paynlessSerial = paynlessFound(paynlessSerials[i]) ? paynlessSerials[i] : null;
          const { entry: rentmanEntry, refMismatch } = rentmanResults[i];
          return {
            ref,
            paynlessSerial,
            rentmanId:     rentmanEntry?.id     ?? null,
            rentmanRef:    rentmanEntry?.ref     ?? null,
            rentmanSerial: rentmanEntry?.serial  ?? null,
            refMismatch:   refMismatch ?? false,
            status: rowStatus(paynlessSerial, rentmanEntry),
            // Sunmi fields — filled in below (the resolved serial IS the Sunmi SN)
            sunmiSn:        null,
            sunmiGroupId:   null,
            sunmiGroupName: null,
            sunmiOnline:    null,
          };
        });

        // ── enrich with Sunmi group / online status ─────────────────────────
        // The canonical device serial (Rentman preferred, Paynless fallback) is
        // the Sunmi S/N. Failures here never break the lookup.
        if (sunmiCreds) {
          try {
            const serialOf = (r) => r.rentmanSerial || r.paynlessSerial || null;
            const sns = [...new Set(rows.map(serialOf).filter(Boolean))];
            const info = await getDeviceInfoBySnList(sns, sunmiCreds);
            const bySn = new Map(info.map(d => [d.sn, d]));
            for (const r of rows) {
              const d = bySn.get(serialOf(r));
              if (!d) continue;
              r.sunmiSn        = d.sn;
              r.sunmiGroupId   = d.group_id   ?? null;
              r.sunmiGroupName = d.group_name ?? null;
              r.sunmiOnline    = d.online_status === 1;
            }
          } catch (e) {
            console.warn(`  ⚠  Sunmi lookup failed: ${e.message}`);
          }
        }

        return json(res, 200, { rows, rentmanAvailable, sunmiAvailable });
      } catch (e) {
        return json(res, 502, { error: e.message });
      }
    }

    // ── POST /api/update-rentman ──────────────────────────────────────────────
    if (method === 'POST' && url === '/api/update-rentman') {
      if (!rentmanToken)
        return json(res, 503, { error: 'RENTMAN_API_TOKEN not configured' });

      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return json(res, 400, { error: 'Invalid JSON body' }); }

      const { rentmanId, serial } = body ?? {};
      if (!rentmanId || typeof serial !== 'string' || !serial.trim())
        return json(res, 400, { error: '`rentmanId` and `serial` are required' });

      try {
        const updated = await updateSerial(rentmanId, serial.trim(), rentmanToken);
        return json(res, 200, { updated });
      } catch (e) {
        return json(res, 502, { error: e.message });
      }
    }

    // ── POST /api/fix-ref ────────────────────────────────────────────────────
    // Body: { rentmanId: number, correctRef: string }
    // Corrects the `ref` field in Rentman (e.g. "28" → "L2G028").
    if (method === 'POST' && url === '/api/fix-ref') {
      if (!rentmanToken)
        return json(res, 503, { error: 'RENTMAN_API_TOKEN not configured' });

      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return json(res, 400, { error: 'Invalid JSON body' }); }

      const { rentmanId, correctRef } = body ?? {};
      if (!rentmanId || typeof correctRef !== 'string' || !correctRef.trim())
        return json(res, 400, { error: '`rentmanId` and `correctRef` are required' });

      try {
        const updated = await updateRef(rentmanId, correctRef.trim(), rentmanToken);
        return json(res, 200, { updated });
      } catch (e) {
        return json(res, 502, { error: e.message });
      }
    }

    // ── POST /api/serial-pair ─────────────────────────────────────────────────
    // Body: { ref: string, vendorSerial: string }
    // Looks up the ref in Rentman, then PUTs the vendor serial.
    if (method === 'POST' && url === '/api/serial-pair') {
      if (!rentmanToken)
        return json(res, 503, { error: 'RENTMAN_API_TOKEN not configured' });

      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return json(res, 400, { error: 'Invalid JSON body' }); }

      const { ref, vendorSerial } = body ?? {};
      if (!ref?.trim() || !vendorSerial?.trim())
        return json(res, 400, { error: '`ref` and `vendorSerial` are required' });

      try {
        const { entry, scannedRef, refMismatch } = await lookupByRefWithFallback(ref.trim(), rentmanToken);
        if (!entry) {
          return json(res, 404, {
            error: `"${ref}" nicht in Rentman gefunden — Gerät anlegen und nochmal versuchen.`,
          });
        }

        const previous = entry.serial ?? null;
        const updated  = await updateSerial(entry.id, vendorSerial.trim(), rentmanToken);

        return json(res, 200, {
          ref:          scannedRef,
          rentmanRef:   entry.ref,
          rentmanId:    entry.id,
          vendorSerial: updated.serial,
          previous,
          refMismatch,
        });
      } catch (e) {
        return json(res, 502, { error: e.message });
      }
    }

    // ── GET /api/sunmi/groups ─────────────────────────────────────────────────
    // Returns the full account-wide list of device groups for the dropdown.
    if (method === 'GET' && url === '/api/sunmi/groups') {
      if (!sunmiCreds)
        return json(res, 503, { error: 'SUNMI_APP_ID/SUNMI_APP_KEY not configured' });
      try {
        const groups = await listGroups(sunmiCreds);
        return json(res, 200, { groups });
      } catch (e) {
        return json(res, 502, { error: e.message });
      }
    }

    // ── POST /api/sunmi/move-group ────────────────────────────────────────────
    // Body: { groupId: number, sns: string[] }  → moves devices into the group.
    if (method === 'POST' && url === '/api/sunmi/move-group') {
      if (!sunmiCreds)
        return json(res, 503, { error: 'SUNMI_APP_ID/SUNMI_APP_KEY not configured' });

      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return json(res, 400, { error: 'Invalid JSON body' }); }

      const groupId = Number(body?.groupId);
      const sns     = body?.sns;
      if (!Number.isFinite(groupId) || !Array.isArray(sns) || sns.length === 0)
        return json(res, 400, { error: '`groupId` (number) and non-empty `sns` are required' });

      try {
        await moveDeviceToGroup(groupId, sns, sunmiCreds);
        return json(res, 200, { moved: sns.length, groupId });
      } catch (e) {
        return json(res, 502, { error: e.message });
      }
    }

    // ── POST /api/sunmi/reboot ────────────────────────────────────────────────
    // Body: { sns: string[] }  → reboots the given devices.
    if (method === 'POST' && url === '/api/sunmi/reboot') {
      if (!sunmiCreds)
        return json(res, 503, { error: 'SUNMI_APP_ID/SUNMI_APP_KEY not configured' });

      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return json(res, 400, { error: 'Invalid JSON body' }); }

      const sns = body?.sns;
      if (!Array.isArray(sns) || sns.length === 0)
        return json(res, 400, { error: 'non-empty `sns` is required' });

      try {
        await rebootDevices(sns, sunmiCreds);
        return json(res, 200, { rebooted: sns.length });
      } catch (e) {
        return json(res, 502, { error: e.message });
      }
    }

    // ── POST /api/print ───────────────────────────────────────────────────────
    // Body (label/standard): { mode:'label', serialNumber, quantity, printer }
    // Body (label/custom):   { mode:'label', lines:[str,...], qrContent, quantity, printer }
    // Body (card):           { mode:'card', serialNumber, productType, accessories, quantity, printer }
    if (method === 'POST' && url === '/api/print') {
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return json(res, 400, { error: 'Invalid JSON body' }); }

      const { mode, printer, quantity: qty } = body ?? {};
      const quantity = Math.max(1, Math.min(parseInt(qty) || 1, 200));

      if (!printer) return json(res, 400, { error: '`printer` is required' });

      try {
        let zplBatch = '';

        if (mode === 'label') {
          if (body.lines) {
            // Custom mode — same label repeated `quantity` times
            const lines = (body.lines ?? []).filter(l => l?.trim());
            if (!lines.length) return json(res, 400, { error: 'At least one text line required' });
            const qrContent = body.qrContent?.trim() || null;
            const zpl = generateLabelZPL(lines, qrContent);
            zplBatch  = Array(quantity).fill(zpl).join('\n');
          } else {
            // Standard mode — serial number, auto-increment
            const { serialNumber } = body;
            if (!serialNumber?.trim())
              return json(res, 400, { error: '`serialNumber` is required' });

            // Multi-line: each line = separate run of `quantity` labels
            const inputLines = serialNumber.split('\n')
              .map(l => l.trim()).filter(Boolean);

            const allZpl = [];
            for (const line of inputLines) {
              const hasDigit = /\d/.test(line);
              const serials  = hasDigit ? expandSerials(line, quantity) : Array(quantity).fill(line);
              for (const serial of serials) {
                const qrVal = hasDigit ? serial : null;
                allZpl.push(generateLabelZPL([serial], qrVal));
              }
            }
            zplBatch = allZpl.join('\n');
          }
        } else if (mode === 'card') {
          const { serialNumber, productType, accessories } = body;
          if (!serialNumber?.trim() || !productType?.trim())
            return json(res, 400, { error: '`serialNumber` and `productType` are required' });

          const serials = expandSerials(serialNumber.trim(), quantity);
          zplBatch = serials
            .map(s => generateCardZPL(s, productType, accessories ?? ''))
            .join('\n');
        } else {
          return json(res, 400, { error: '`mode` must be "label" or "card"' });
        }

        await printZPL(zplBatch, printer);
        return json(res, 200, { ok: true, count: quantity });
      } catch (e) {
        return json(res, 502, { error: e.message });
      }
    }

    // ── POST /api/generate-pdf ────────────────────────────────────────────────
    // Body: { serialNumber, productType, accessories }
    if (method === 'POST' && url === '/api/generate-pdf') {
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return json(res, 400, { error: 'Invalid JSON body' }); }

      const { serialNumber, productType, accessories } = body ?? {};
      if (!serialNumber?.trim() || !productType?.trim())
        return json(res, 400, { error: '`serialNumber` and `productType` are required' });

      try {
        const { PDFDocument, rgb, StandardFonts, QRCode } = await getPdfDeps();

        const pdfDoc = await PDFDocument.create();
        const page   = pdfDoc.addPage([400, 600]);
        const { width, height } = page.getSize();
        const font   = await pdfDoc.embedFont(StandardFonts.Helvetica);

        page.drawText(`${productType} — ${serialNumber}`, {
          x: 50, y: height - 80, size: 18, font, color: rgb(0, 0, 0),
        });
        page.drawText('Zubehör:', {
          x: 50, y: height - 130, size: 14, font, color: rgb(.3, .3, .3),
        });

        const accLines = (accessories ?? '').split('\n');
        accLines.forEach((line, i) => {
          page.drawText(line.trim(), {
            x: 50, y: height - 160 - i * 22, size: 13, font, color: rgb(0, 0, 0),
          });
        });

        // QR code
        const qrDataUrl = await QRCode.toDataURL(serialNumber);
        const qrImg     = await pdfDoc.embedPng(qrDataUrl);
        const qrDims    = qrImg.scale(0.7);
        page.drawImage(qrImg, {
          x: width - qrDims.width - 30,
          y: height - qrDims.height - 30,
          ...qrDims,
        });

        // Logo
        try {
          const logoBytes = readFileSync(LOGO_PATH);
          const logoImg   = await pdfDoc.embedPng(logoBytes);
          const logoDims  = logoImg.scale(0.12);
          page.drawImage(logoImg, {
            x: (width - logoDims.width) / 2,
            y: 70,
            ...logoDims,
          });
        } catch { /* logo optional */ }

        // Footer
        const f1 = 'Eigentum der Tickettoaster event technologies GmbH';
        const f2 = 'Wolfhager Str. 39a, 34117 Kassel';
        page.drawText(f1, {
          x: (width - font.widthOfTextAtSize(f1, 9)) / 2,
          y: 48, size: 9, font, color: rgb(.4, .4, .4),
        });
        page.drawText(f2, {
          x: (width - font.widthOfTextAtSize(f2, 9)) / 2,
          y: 36, size: 9, font, color: rgb(.4, .4, .4),
        });

        const pdfBytes = await pdfDoc.save();
        res.writeHead(200, {
          'Content-Type':        'application/pdf',
          'Content-Disposition': `attachment; filename="Geraetekarte_${serialNumber}.pdf"`,
          'Content-Length':      pdfBytes.byteLength,
        });
        res.end(Buffer.from(pdfBytes));
      } catch (e) {
        return json(res, 502, { error: e.message });
      }
      return;
    }

    // ── POST /api/lookup (legacy) ─────────────────────────────────────────────
    if (method === 'POST' && url === '/api/lookup') {
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch { return json(res, 400, { error: 'Invalid JSON body' }); }

      const ids = body?.ids;
      if (!Array.isArray(ids) || ids.length === 0)
        return json(res, 400, { error: '`ids` must be a non-empty array' });

      try {
        const data = await lookupDevices(ids, apiKey);
        return json(res, 200, data);
      } catch (e) {
        return json(res, 502, { error: e.message });
      }
    }

    // ── static files ──────────────────────────────────────────────────────────
    const urlPath  = url === '/' ? '/index.html' : url.split('?')[0];
    const filePath = join(PUBLIC, urlPath);

    if (!filePath.startsWith(PUBLIC))
      return json(res, 403, { error: 'Forbidden' });

    try {
      const content = readFileSync(filePath);
      const ct = MIME[extname(filePath)] ?? 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': ct });
      res.end(content);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });

  server.listen(PORT, () => {
    console.log(`
  TiTo Suite
  ──────────────────────────────────────
  http://localhost:${PORT}
  Rentman: ${rentmanAvailable ? '✓ verbunden' : '✗ kein Token'}
  Sunmi:   ${sunmiAvailable ? '✓ verbunden' : '✗ keine Keys'}
  ──────────────────────────────────────
  Ctrl-C zum Beenden
`);
  });

  return server;
}

// ── run directly ──────────────────────────────────────────────────────────────
if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer();
}
