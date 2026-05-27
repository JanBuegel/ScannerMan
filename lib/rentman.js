/**
 * Rentman API helpers
 *
 * GET  /serialnumbers?ref=L2s021  → look up our internal serial
 * PUT  /serialnumbers/{id}        → update the vendor (manufacturer) serial
 *
 * Rentman uses standard REST — no body on GET — so native fetch is fine here.
 */

const BASE = 'https://api.rentman.net';

async function rentmanGet(path, token) {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept:        'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Rentman ${res.status} ${res.statusText}${text ? ': ' + text : ''}`);
  }
  return res.json();
}

/**
 * Look up a serial-number entry by our internal ref (case-sensitive as stored in Rentman).
 * Returns null if not found.
 * @returns {Promise<{ id: number, ref: string, serial: string|null } | null>}
 */
export async function lookupByRef(ref, token) {
  try {
    const data = await rentmanGet(`/serialnumbers?ref=${encodeURIComponent(ref)}`, token);
    const item  = data.data?.[0];
    if (!item) return null;
    return {
      id:     item.id,
      ref:    item.ref,
      serial: item.serial?.trim() || null,
    };
  } catch {
    return null; // network error / token wrong → treat as unavailable
  }
}

/**
 * Like lookupByRef, but falls back to trailing-number variants when the exact
 * ref isn't found in Rentman.
 *
 * Example: QR code says "L2G028", Rentman only has "28" or "028".
 *   1. Try exact:               "L2G028"  → null
 *   2. Try trailing digits:     "028"     → null or found
 *   3. Try parseInt (no zeros): "28"      → found ✓
 *
 * Returns { entry, scannedRef, refMismatch } or { entry: null, scannedRef, refMismatch: false }.
 * `refMismatch` is true when the Rentman ref differs from what was scanned.
 */
export async function lookupByRefWithFallback(ref, token) {
  const make = (entry) => ({
    entry,
    scannedRef:   ref,
    refMismatch:  entry !== null && entry.ref !== ref,
  });

  // 1. Exact match
  const exact = await lookupByRef(ref, token);
  if (exact) return make(exact);

  // 2. Extract trailing digit block
  const m = ref.match(/(\d+)$/);
  if (!m) return make(null);

  const trailingRaw = m[1];  // e.g. "028"

  // 3. Try with leading zeros preserved (e.g. "028")
  if (trailingRaw !== ref) {
    const withZeros = await lookupByRef(trailingRaw, token);
    if (withZeros) return make(withZeros);
  }

  // 4. Try without leading zeros (e.g. "28")
  const stripped = String(parseInt(trailingRaw, 10));
  if (stripped !== trailingRaw && stripped !== ref) {
    const noZeros = await lookupByRef(stripped, token);
    if (noZeros) return make(noZeros);
  }

  return make(null);
}

/**
 * Update the vendor serial for an existing serialnumber entry.
 * Rentman uses PUT (not PATCH) for updates.
 * @returns {Promise<{ id: number, ref: string, serial: string }>}
 */
export async function updateSerial(id, serial, token) {
  const res = await fetch(`${BASE}/serialnumbers/${id}`, {
    method:  'PUT',
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept:         'application/json',
    },
    body: JSON.stringify({ serial }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Rentman PUT ${res.status}${text ? ': ' + text : ''}`);
  }
  const data = await res.json();
  return { id: data.data.id, ref: data.data.ref, serial: data.data.serial };
}

/**
 * Correct the internal ref of a serialnumber entry.
 * Used when Rentman has "28" but the actual QR code says "L2G028".
 * @returns {Promise<{ id: number, ref: string, serial: string }>}
 */
export async function updateRef(id, newRef, token) {
  const res = await fetch(`${BASE}/serialnumbers/${id}`, {
    method:  'PUT',
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept:         'application/json',
    },
    body: JSON.stringify({ ref: newRef }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Rentman PUT ref ${res.status}${text ? ': ' + text : ''}`);
  }
  const data = await res.json();
  return { id: data.data.id, ref: data.data.ref, serial: data.data.serial };
}
