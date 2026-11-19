import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import providerErrors from '../../src/shared/providerError.js';

const { ProviderError } = providerErrors;

const CLIENT_ID = '5c38e31cd085304b';
const CALLBACK = `npf${CLIENT_ID}://auth`;
const ACCOUNTS = 'https://accounts.nintendo.com';
const APP_API = 'https://app-api.znej.nintendo.com';
const USER_AGENT = 'com.nintendo.znej/3.0.3 (iOS/26.0.1)';
const LOCALE = 'en-GB';
const PENDING_MS = 10 * 60 * 1000;
const REFRESH_MS = 60 * 60 * 1000;
const REQUEST_MS = 8 * 1000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_GAMES = 2_000;

class NintendoError extends ProviderError {
  constructor(code, retryAfterMs = 0) {
    super(code, 'nintendo', retryAfterMs);
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validSecret = value => typeof value === 'string' && value.length > 0 && value.length <= 16_384 && !/[\r\n]/.test(value);
const randomBase64 = bytes => randomBytes(bytes).toString('base64url');

function timestamp(now) {
  const value = Number(now());
  if (!Number.isFinite(value)) throw new NintendoError('invalid-clock');
  return value;
}

function authorizationRequest(currentTime) {
  const state = randomBase64(36);
  const verifier = randomBase64(32);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const url = new URL('/connect/1.0.0/authorize', ACCOUNTS);
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', CALLBACK);
  url.searchParams.set('response_type', 'session_token_code');
  url.searchParams.set('scope', 'openid user user.mii user.email user.links[].id');
  url.searchParams.set('session_token_code_challenge', challenge);
  url.searchParams.set('session_token_code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('theme', 'login_form');
  return { url: url.toString(), pending: { state, verifier, expiresAt: currentTime + PENDING_MS } };
}

function parseCallback(callback, expectedState) {
  if (typeof callback !== 'string' || callback.length < 1 || callback.length > 8_192 || callback !== callback.trim()) {
    throw new NintendoError('invalid-callback');
  }
  let url;
  try { url = new URL(callback); }
  catch { throw new NintendoError('invalid-callback'); }
  if (url.protocol !== `npf${CLIENT_ID}:` || url.hostname !== 'auth' || url.username || url.password || url.port ||
    (url.pathname !== '' && url.pathname !== '/') || url.search || !url.hash) {
    throw new NintendoError('invalid-callback');
  }
  const fragment = new URLSearchParams(url.hash.slice(1));
  if ([...fragment.keys()].some(key => !['session_token_code', 'state', 'session_state'].includes(key)) ||
    fragment.getAll('session_token_code').length !== 1 || fragment.getAll('state').length !== 1 ||
    fragment.getAll('session_state').length > 1) {
    throw new NintendoError('invalid-callback');
  }
  const code = fragment.get('session_token_code');
  const state = fragment.get('state');
  if (!validSecret(code) || !validSecret(state)) throw new NintendoError('invalid-callback');
  const actual = Buffer.from(state);
  const expected = Buffer.from(expectedState);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new NintendoError('state-mismatch');
  return code;
}

async function responseJson(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new NintendoError('response-too-large');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new NintendoError('invalid-response');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new NintendoError('response-too-large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new NintendoError('invalid-response'); }
}

function createRequester(fetchImpl) {
  return async (url, options = {}) => {
    const signal = AbortSignal.timeout(REQUEST_MS);
    let response;
    try {
      response = await fetchImpl(url, {
        ...options,
        redirect: 'manual',
        signal,
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...options.headers },
      });
    } catch {
      throw new NintendoError(signal.aborted ? 'timeout' : 'network-error');
    }
    if (!response?.ok) {
      await response?.body?.cancel();
      if ([400, 401, 403].includes(response?.status)) throw new NintendoError('reconnect-required');
      if (response?.status === 429) {
        const seconds = Number(response.headers.get('retry-after'));
        throw new NintendoError('rate-limited', Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : 0);
      }
      throw new NintendoError('upstream-error');
    }
    return responseJson(response);
  };
}

function safeDate(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64) return null;
  const normalized = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?$/.test(value) ? `${value}Z` : value;
  const milliseconds = Date.parse(normalized);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function safeText(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\r\n\0]/.test(value) ? value : null;
}

function safeImage(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizeHistory(raw) {
  if (!isObject(raw) || !Array.isArray(raw.playHistories) || raw.playHistories.length > MAX_GAMES) {
    throw new NintendoError('invalid-history-response');
  }
  const games = raw.playHistories.map(row => {
    if (!isObject(row)) throw new NintendoError('invalid-history-response');
    const titleId = typeof row.titleId === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(row.titleId) ? row.titleId : null;
    const name = safeText(row.titleName, 512);
    const platform = safeText(row.platform, 128) || safeText(row.deviceType, 128);
    if (!titleId || !name || !platform) throw new NintendoError('invalid-history-response');
    let playtimeMinutes = null;
    if (row.totalPlayedMinutes !== undefined && row.totalPlayedMinutes !== null) {
      if (!Number.isSafeInteger(row.totalPlayedMinutes) || row.totalPlayedMinutes < 0) {
        throw new NintendoError('invalid-history-response');
      }
      playtimeMinutes = row.totalPlayedMinutes;
    }
    const providerGameId = createHash('sha256').update(titleId).update('\0').update(platform).digest('base64url');
    return {
      providerGameId,
      titleId,
      name,
      platform,
      playtimeMinutes,
      firstPlayedAt: safeDate(row.firstPlayedAt),
      lastPlayedAt: safeDate(row.lastPlayedAt),
      imageUrl: safeImage(row.imageUrl),
    };
  });
  const identities = new Set();
  for (const game of games) {
    if (identities.has(game.providerGameId)) throw new NintendoError('duplicate-history-record');
    identities.add(game.providerGameId);
  }
  games.sort((left, right) => (right.lastPlayedAt || '').localeCompare(left.lastPlayedAt || '') ||
    left.name.localeCompare(right.name) || left.platform.localeCompare(right.platform));
  return games;
}

function createProtocol(fetchImpl) {
  const request = createRequester(fetchImpl);
  const exchangeSession = async (code, verifier) => {
    const raw = await request(`${ACCOUNTS}/connect/1.0.0/api/session_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        session_token_code: code,
        session_token_code_verifier: verifier,
      }).toString(),
    });
    if (!isObject(raw) || !validSecret(raw.session_token)) throw new NintendoError('invalid-session-response');
    return raw.session_token;
  };
  const tokens = async sessionToken => {
    const raw = await request(`${ACCOUNTS}/connect/1.0.0/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        session_token: sessionToken,
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer-session-token',
      }),
    });
    if (!isObject(raw) || !validSecret(raw.access_token) ||
      (raw.id_token !== undefined && !validSecret(raw.id_token))) {
      throw new NintendoError('invalid-token-response');
    }
    return { accessToken: raw.access_token, idToken: raw.id_token || null };
  };
  const history = bearer => request(`${APP_API}/api/v2.0/users/me/play_histories`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${bearer}`, 'Gentry-Locale': LOCALE },
  });
  const games = async sessionToken => {
    const token = await tokens(sessionToken);
    let raw;
    try {
      raw = await history(token.accessToken);
    } catch (error) {
      if (!(error instanceof ProviderError && error.code === 'reconnect-required' && token.idToken)) throw error;
      raw = await history(token.idToken);
    }
    return normalizeHistory(raw);
  };
  return { exchangeSession, games };
}

function cleanState(value) {
  return isObject(value) ? value : {};
}

function withoutPending(state) {
  const { pending: _pending, ...rest } = state;
  return rest;
}

function statusFor(state) {
  if (!validSecret(state.sessionToken)) return 'not-configured';
  if (state.failureCode === 'reconnect-required') return 'reconnect-required';
  const latest = safeDate(state.library?.latest);
  if (state.failureCode || !latest || !Array.isArray(state.library?.games)) {
    return 'stale';
  }
  return 'ready';
}

function publicLibrary(state) {
  const status = statusFor(state);
  const latest = safeDate(state.library?.latest);
  const games = Array.isArray(state.library?.games) ? state.library.games.slice(0, MAX_GAMES).map(game => ({ ...game })) : [];
  return { status, latest, games };
}

export function createNintendo({ store, fetchImpl = fetch, now = Date.now } = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.locked !== 'function' ||
    typeof fetchImpl !== 'function' || typeof now !== 'function') {
    throw new NintendoError('invalid-configuration');
  }
  const protocol = createProtocol(fetchImpl);

  async function start() {
    const request = authorizationRequest(timestamp(now));
    await store.locked(async (stored, save) => {
      const state = cleanState(stored);
      await save({ ...state, pending: request.pending });
    });
    return { url: request.url };
  }

  async function confirm({ callback } = {}) {
    return store.locked(async (stored, save) => {
      const state = cleanState(stored);
      const pending = state.pending;
      await save(withoutPending(state));
      const currentTime = timestamp(now);
      if (!isObject(pending) || !validSecret(pending.state) || !validSecret(pending.verifier) ||
        !Number.isFinite(pending.expiresAt) || currentTime >= pending.expiresAt) {
        throw new NintendoError('authorization-not-pending');
      }
      const code = parseCallback(callback, pending.state);
      const candidate = await protocol.exchangeSession(code, pending.verifier);
      const games = await protocol.games(candidate);
      const latest = new Date(currentTime).toISOString();
      await save({
        version: 1,
        sessionToken: candidate,
        lastAttemptAt: latest,
        failureCode: null,
        library: { latest, games },
      });
      return { status: 'ready' };
    });
  }

  async function refresh({ force = false } = {}) {
    return store.locked(async (stored, save) => {
      const state = cleanState(stored);
      const currentTime = timestamp(now);
      if (!validSecret(state.sessionToken)) return { status: 'not-configured' };
      const previousAttempt = safeDate(state.lastAttemptAt);
      if (!force && previousAttempt && currentTime - Date.parse(previousAttempt) < REFRESH_MS) {
        return { status: statusFor(state) };
      }
      if (state.failureCode === 'reconnect-required') return { status: 'reconnect-required' };
      const lastAttemptAt = new Date(currentTime).toISOString();
      try {
        const games = await protocol.games(state.sessionToken);
        await save({
          ...state,
          version: 1,
          lastAttemptAt,
          failureCode: null,
          library: { latest: lastAttemptAt, games },
        });
        return { status: 'ready' };
      } catch (error) {
        const code = error instanceof ProviderError ? error.code : 'internal-error';
        const next = { ...state, lastAttemptAt, failureCode: code };
        await save(next);
        return { status: statusFor(next) };
      }
    });
  }

  async function snapshots() {
    const state = cleanState(await store.read());
    return { library: publicLibrary(state) };
  }

  async function disconnect() {
    return store.locked(async (_stored, save) => {
      await save({});
      return { status: 'not-configured' };
    });
  }

  return { start, confirm, refresh, snapshots, disconnect };
}
