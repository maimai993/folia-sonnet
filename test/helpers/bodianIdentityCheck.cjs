const { BodianError } = require('../../electron/bodian/http.cjs');

// test/helpers/bodianIdentityCheck.cjs
// Isolated acceptance helper. No session store, profile lookup, library access or credential output.
// Protocol lead: MoeclubM/PyBodian commit 79ed7e25234efa07f4a5445ca10fdf06acedba0d.

function accountId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  const text = String(value ?? '');
  return /^[1-9]\d{0,19}$/.test(text) ? text : null;
}

// Require every supplied identity field to agree with the ID independently supplied by the user.
function matchesExpectedIdentity(data, expectedId) {
  const ids = [data?.id, data?.uid, data?.userId, data?.userInfo?.id, data?.userInfo?.uid]
    .filter(value => value !== undefined && value !== null);
  return ids.length > 0 && ids.every(value => accountId(value) === expectedId);
}

function createIdentityCheck({ client, expectedAccountId, now = Date.now }) {
  const expectedId = accountId(expectedAccountId);
  if (!expectedId) throw new Error('An independently verified account ID is required');
  let active = null;
  let started = false;
  let polling = false;
  const valid = session => active === session && now() < session.expiresAt;
  return {
    async start() {
      if (started) throw new Error('Create a new check for a new scan');
      started = true;
      const session = { key: null, expiresAt: now() + 5 * 60 * 1000 };
      active = session;
      const { data } = await client.call('/api/ucenter/login/qrCode', { anonymous: true, signed: true });
      if (!valid(session)) throw new Error('Identity check cancelled or expired');
      if (typeof data?.qrCode !== 'string' || !data.qrCode) {
        active = null;
        throw new BodianError('invalid-response', 'Missing QR identifier');
      }
      session.key = data.qrCode;
      const url = new URL('https://bodian-oia.kuwo.cn/bodian/download.html');
      url.search = new URLSearchParams({ pageName: 'login_pc', pt: '3', id: session.key }).toString();
      return { qrUrl: url.toString(), expiresAt: session.expiresAt };
    },
    cancel() { active = null; },
    async poll() {
      const session = active;
      if (!session || !session.key || !valid(session)) { active = null; return { state: 'expired' }; }
      if (polling) return { state: 'pending' };
      polling = true;
      try {
        const { data } = await client.call('/api/ucenter/login/qrCodeStatus', {
          anonymous: true, signed: true, params: { qrCode: session.key },
        });
        if (!valid(session)) return { state: 'expired' };
        if (Number(data?.status) === 1) return { state: 'waiting' };
        if (Number(data?.status) === 2) { active = null; return { state: 'expired' }; }
        if (Number(data?.status) !== 3) {
          active = null;
          return { state: 'unsupported-status' };
        }
        const { data: login } = await client.call('/api/ucenter/users/login', {
          anonymous: true, signed: true, method: 'POST', body: { authType: 10, qrCode: session.key },
        });
        if (!valid(session)) return { state: 'expired' };
        active = null;
        if (!matchesExpectedIdentity(login, expectedId)) return { state: 'identity-mismatch' };
        if (typeof login?.token !== 'string' || !login.token.trim()) return { state: 'missing-credential' };
        // A match is an acceptance observation, not a persisted or authenticated product session.
        return { state: 'identity-matched' };
      } catch (error) {
        active = null;
        return { state: 'failed', code: error instanceof BodianError ? error.code : 'network' };
      } finally {
        polling = false;
      }
    },
  };
}

module.exports = { createIdentityCheck };
