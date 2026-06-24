import { request }    from 'https';
import { createHmac } from 'crypto';

// ── Sunmi OpenAPI (Remote management) ─────────────────────────────────────────
// Docs: https://docs.sunmi.com/en-US/cdixeghjk491/  (Device Group APIs)
const API_HOSTNAME = 'openapi.sunmi.com';

const PATH = {
  deviceInfo: '/v2/mdm/open/open/deviceCenter/device/getDeviceInfoBySnList',
  groupList:  '/v2/mdm/open/open/deviceCenter/group/list',            // full group list (body {})
  moveGroup:  '/v2/mdm/open/open/deviceCenter/group/moveDeviceToGroup',
  reboot:     '/v2/mdm/open/open/cmd/reboot',                         // needs Source header, msn_list
};

// ── signing ───────────────────────────────────────────────────────────────────
// Sunmi-Sign = HMAC_SHA256( json_body + appid + timestamp + nonce , appkey )  (hex)
// NOTE: if a live call returns an auth error, the concatenation ORDER below is the
//       single most likely culprit — it's isolated here on purpose.
function sign(body, appId, timestamp, nonce, appKey) {
  const message = body + appId + timestamp + nonce;
  return createHmac('sha256', appKey).update(message).digest('hex');
}

// ── low-level request ─────────────────────────────────────────────────────────
function sunmiRequest(path, payload, { appId, appKey }, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const body      = payload == null ? '' : JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));        // 10-digit unix seconds
    const nonce     = String(Math.floor(100000 + Math.random() * 900000)); // 6-digit
    const sunmiSign = sign(body, appId, timestamp, nonce, appKey);

    const req = request(
      {
        hostname: API_HOSTNAME,
        path,
        method: 'POST',
        headers: {
          'Content-Type':    'application/json',
          'Sunmi-Appid':     appId,
          'Sunmi-Nonce':     nonce,
          'Sunmi-Timestamp': timestamp,
          'Sunmi-Sign':      sunmiSign,
          'Content-Length':  Buffer.byteLength(body),
          ...extraHeaders,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          let data;
          try { data = JSON.parse(raw); }
          catch { return reject(new Error(`Sunmi: Non-JSON response (${res.statusCode}): ${raw}`)); }

          // Sunmi wraps every response: { code, data, msg } — code === 1 means OK.
          if (res.statusCode >= 200 && res.statusCode < 300 && data.code === 1) {
            resolve(data);
          } else {
            reject(new Error(`Sunmi API error (${res.statusCode}, code ${data.code}): ${data.msg || raw}`));
          }
        });
      }
    );

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Look up current group + online status for a list of device serials.
 * @returns {Promise<Array<{sn,group_id,group_name,online_status,...}>>}
 */
export async function getDeviceInfoBySnList(sns, creds) {
  if (!sns.length) return [];
  const data = await sunmiRequest(PATH.deviceInfo, { sn_list: sns }, creds);
  return data.data?.list ?? [];
}

/**
 * List every device group in the account.
 * @returns {Promise<Array<{group_id,group_name,parent_group_id}>>}
 */
export async function listGroups(creds) {
  // This endpoint requires a JSON object body — empty body returns "params error".
  const data = await sunmiRequest(PATH.groupList, {}, creds);
  return data.data?.list ?? [];
}

/**
 * Move one or more devices (by SN) into the given group.
 */
export async function moveDeviceToGroup(groupId, sns, creds) {
  return sunmiRequest(PATH.moveGroup, { group_id: groupId, sn_list: sns }, creds);
}

/**
 * Reboot one or more devices (by SN). This endpoint expects `msn_list` and a
 * `Source: openapi` header (unlike the others).
 */
export async function rebootDevices(sns, creds) {
  return sunmiRequest(PATH.reboot, { msn_list: sns }, creds, { Source: 'openapi' });
}
