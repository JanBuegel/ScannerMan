import { request } from 'https';

const API_HOSTNAME = 'cloud.cshlss.de';
const API_PATH     = '/api/custom/lookup_devices';

// ── low-level HTTP request ────────────────────────────────────────────────────
function makeRequest(ids, apiKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ ids });

    const req = request(
      {
        hostname: API_HOSTNAME,
        path:     API_PATH,
        method:   'GET',
        headers: {
          'X-API-Key':      apiKey,
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(raw));
            } catch {
              reject(new Error(`Non-JSON response: ${raw}`));
            }
          } else {
            const err = new Error(
              `API responded ${res.statusCode} ${res.statusMessage}` +
              (raw ? `\n${raw}` : '')
            );
            err.statusCode = res.statusCode;
            reject(err);
          }
        });
      }
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── single-ID lookup (never throws — returns 'null' string on any error) ──────
async function lookupOne(id, apiKey) {
  try {
    const data = await makeRequest([id], apiKey);
    return data.vendor_serials?.[0] ?? 'null';
  } catch {
    // Device not found in DB (server 500) or any other error → treat as not found
    return 'null';
  }
}

// ── public API ────────────────────────────────────────────────────────────────
/**
 * Look up one or more device IDs.
 *
 * Strategy:
 *   1. Try a single batch request (fast).
 *   2. If the API returns a server error (e.g. a device ID that doesn't exist
 *      causes a Ruby NilClass crash), fall back to individual requests so we
 *      still get results for all the IDs that *do* exist.
 *
 * @param {string[]} ids
 * @param {string}   apiKey
 * @returns {Promise<{ success: boolean, vendor_serials: string[] }>}
 */
export async function lookupDevices(ids, apiKey) {
  // Fast path — single batch request
  try {
    return await makeRequest(ids, apiKey);
  } catch (batchErr) {
    // If it was already a single ID there's nothing to retry
    if (ids.length === 1) {
      return { success: false, vendor_serials: ['null'] };
    }

    // Slow path — one request per ID in parallel; failed ones become 'null'
    const vendor_serials = await Promise.all(
      ids.map((id) => lookupOne(id, apiKey))
    );
    return { success: true, vendor_serials };
  }
}
