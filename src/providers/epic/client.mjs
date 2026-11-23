// Epic OAuth, library and catalog protocol adapted from gaming-stats-api (MIT License),
// https://github.com/AniketRaj314/gaming-stats-api/tree/main/src/providers/epic
// The public launcher OAuth client identifiers are protocol constants, not owner credentials.
import errorsModule from '../../shared/providerError.js';

const { ProviderError } = errorsModule;

const CLIENT_ID = '34a02cf8f4414e29b15921876da36f9a';
const CLIENT_SECRET = 'daafbccc737745039dffe53d94fc76cf';
const BASIC = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;
const ACCOUNT = 'https://account-public-service-prod03.ol.epicgames.com';
const LIBRARY = 'https://library-service.live.use1a.on.epicgames.com';
const CATALOG = 'https://catalog-public-service-prod06.ol.epicgames.com';
const ALLOWED_ORIGINS = new Set([ACCOUNT, LIBRARY, CATALOG]);
const REDIRECT = 'https://www.epicgames.com/id/api/redirect';
const LOGIN = 'https://www.epicgames.com/id/login';
const MAX_LIBRARY_RECORDS = 5_000;
const MAX_LIBRARY_PAGES = 100;
const MAX_CATALOG_BATCH = 50;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const tokenValue = value => typeof value === 'string' && value.length > 0 && value.length <= 16_384 && !/[\r\n]/.test(value);

function expiry(raw, absoluteNames, relativeNames, currentTime) {
  for (const name of absoluteNames) {
    const absolute = Date.parse(raw?.[name]);
    if (Number.isFinite(absolute) && absolute > 0 && absolute <= currentTime + 366 * 86_400_000) return absolute;
  }
  for (const name of relativeNames) {
    const seconds = raw?.[name];
    if (Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 366 * 86_400) return currentTime + seconds * 1_000;
  }
  return null;
}

export function createClient({ fetchImpl = global.fetch, now = Date.now, requestMs = 8_000, maxBytes = 4 * 1024 * 1024 } = {}) {
  const context = (jobMs = 55_000) => ({ signal: AbortSignal.timeout(jobMs), remaining: 5_120 });

  async function request(origin, pathname, { method = 'GET', query, headers = {}, body, empty = false } = {}, ctx, stage) {
    if (!ALLOWED_ORIGINS.has(origin) || typeof pathname !== 'string' || !pathname.startsWith('/')) {
      throw new ProviderError('invalid-request', stage);
    }
    if (--ctx.remaining < 0) throw new ProviderError('request-budget-exhausted', stage);
    const url = new URL(pathname, origin);
    if (url.origin !== origin || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) {
      throw new ProviderError('invalid-request', stage);
    }
    if (query) for (const [name, value] of query) url.searchParams.append(name, value);
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(requestMs)]);
    try {
      const response = await fetchImpl(url.toString(), { method, headers, body, redirect: 'error', signal });
      if (!response.ok) {
        const retry = response.headers.get('retry-after');
        await response.body?.cancel();
        if (response.status === 429) {
          const parsed = /^\d+$/.test(retry || '') ? Number(retry) * 1_000 : Date.parse(retry) - now();
          throw new ProviderError('rate-limited', stage, Number.isFinite(parsed) ? Math.max(60_000, Math.min(parsed, 86_400_000)) : 300_000);
        }
        if (response.status === 401 || (stage === 'authentication' && response.status === 400)) {
          throw new ProviderError('reconnect-required', stage);
        }
        if (response.status === 403) throw new ProviderError(stage === 'catalog' ? 'forbidden' : 'private', stage);
        if (response.status === 404) throw new ProviderError('not-found', stage);
        throw new ProviderError(`upstream-${response.status}`, stage);
      }
      if (empty) {
        await response.body?.cancel();
        return null;
      }
      if (Number(response.headers.get('content-length')) > maxBytes) {
        await response.body?.cancel();
        throw new ProviderError('response-too-large', stage);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new ProviderError('invalid-response', stage);
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            await reader.cancel();
            throw new ProviderError('response-too-large', stage);
          }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new ProviderError('invalid-json', stage); }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(signal.aborted ? 'timeout' : 'network-error', stage);
    }
  }

  function session(raw) {
    if (!object(raw) || !tokenValue(raw.access_token) || !tokenValue(raw.refresh_token) ||
      typeof raw.account_id !== 'string' || !/^[a-f\d]{32}$/i.test(raw.account_id) ||
      typeof raw.displayName !== 'string' || raw.displayName.length < 1 || raw.displayName.length > 64 || /[\r\n]/.test(raw.displayName)) {
      throw new ProviderError('invalid-token-response', 'authentication');
    }
    const issuedAt = now();
    const accessExpiresAt = expiry(raw, ['expires_at'], ['expires_in'], issuedAt);
    const refreshExpiresAt = expiry(raw, ['refresh_expires_at'], ['refresh_token_expires_in', 'refresh_expires'], issuedAt);
    if (accessExpiresAt === null || refreshExpiresAt === null || accessExpiresAt <= issuedAt || refreshExpiresAt <= issuedAt) {
      throw new ProviderError('invalid-token-expiry', 'authentication');
    }
    return {
      accessToken: raw.access_token,
      refreshToken: raw.refresh_token,
      accessExpiresAt,
      refreshExpiresAt,
      accountId: raw.account_id.toLowerCase(),
      displayName: raw.displayName,
    };
  }

  async function token(form, ctx) {
    const raw = await request(ACCOUNT, '/account/api/oauth/token', {
      method: 'POST',
      headers: { Authorization: BASIC, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    }, ctx, 'authentication');
    return session(raw);
  }

  function loginUrl() {
    const redirect = new URL(REDIRECT);
    redirect.searchParams.set('clientId', CLIENT_ID);
    redirect.searchParams.set('responseType', 'code');
    const login = new URL(LOGIN);
    login.searchParams.set('redirectUrl', redirect.toString());
    return login.toString();
  }

  async function connect(code, ctx) {
    if (typeof code !== 'string' || !/^[A-Za-z0-9._~-]{1,2048}$/.test(code)) {
      throw new ProviderError('invalid-authorization-code', 'authentication');
    }
    return token({ grant_type: 'authorization_code', code, token_type: 'eg1' }, ctx);
  }

  async function renew(saved, ctx) {
    const next = await token({ grant_type: 'refresh_token', refresh_token: saved.refreshToken, token_type: 'eg1' }, ctx);
    if (next.accountId !== saved.accountId) throw new ProviderError('account-mismatch', 'identity');
    return next;
  }

  async function verify(saved, ctx, expectedAccountId) {
    const raw = await request(ACCOUNT, '/account/api/oauth/verify', {
      headers: { Authorization: `Bearer ${saved.accessToken}`, Accept: 'application/json' },
    }, ctx, 'identity');
    if (!object(raw) || typeof raw.account_id !== 'string' || !/^[a-f\d]{32}$/i.test(raw.account_id) ||
      raw.account_id.toLowerCase() !== expectedAccountId ||
      typeof raw.displayName !== 'string' || raw.displayName.length < 1 || raw.displayName.length > 64 || /[\r\n]/.test(raw.displayName)) {
      throw new ProviderError('account-mismatch', 'identity');
    }
    // Only the verified account identity is returned; email and other profile fields stay unread.
    return { ...saved, accountId: raw.account_id.toLowerCase(), displayName: raw.displayName };
  }

  const authHeaders = saved => ({ Authorization: `Bearer ${saved.accessToken}`, Accept: 'application/json' });

  async function library(saved, ctx) {
    const records = [];
    const cursors = new Set();
    let cursor;
    for (let page = 0; page < MAX_LIBRARY_PAGES; page++) {
      const query = [['includeMetadata', 'true']];
      if (cursor) query.push(['cursor', cursor]);
      const raw = await request(LIBRARY, '/library/api/public/items', { headers: authHeaders(saved), query }, ctx, 'library');
      if (!object(raw) || !Array.isArray(raw.records) || records.length + raw.records.length > MAX_LIBRARY_RECORDS) {
        throw new ProviderError('invalid-library-page', 'library');
      }
      records.push(...raw.records);
      const next = raw.responseMetadata?.nextCursor;
      if (next == null || next === '') return records;
      if (typeof next !== 'string' || next.length > 2_048 || /[\r\n]/.test(next) || cursors.has(next)) {
        throw new ProviderError('invalid-library-cursor', 'library');
      }
      cursors.add(next);
      cursor = next;
    }
    throw new ProviderError('page-budget-exhausted', 'library');
  }

  const playtime = (saved, ctx) => request(LIBRARY,
    `/library/api/public/playtime/account/${encodeURIComponent(saved.accountId)}/all`,
    { headers: authHeaders(saved) }, ctx, 'playtime');

  async function catalog(items, saved, ctx) {
    const output = new Map();
    const groups = new Map();
    for (const item of items) {
      if (!groups.has(item.namespace)) groups.set(item.namespace, []);
      groups.get(item.namespace).push(item.catalogItemId);
    }
    const batches = [];
    for (const [namespace, ids] of groups) {
      for (let offset = 0; offset < ids.length; offset += MAX_CATALOG_BATCH) {
        batches.push({ namespace, ids: ids.slice(offset, offset + MAX_CATALOG_BATCH) });
      }
    }
    let next = 0;
    let failed = false;
    const workers = await Promise.allSettled(Array.from({ length: Math.min(6, batches.length) }, async () => {
      while (!failed && next < batches.length) {
        const { namespace, ids } = batches[next++];
        const query = ids.map(id => ['id', id]);
        query.push(['includeMainGameDetails', 'true'], ['country', 'US'], ['locale', 'en-US']);
        try {
          const raw = await request(CATALOG, `/catalog/api/shared/namespace/${encodeURIComponent(namespace)}/bulk/items`,
            { headers: authHeaders(saved), query }, ctx, 'catalog');
          if (!object(raw)) throw new ProviderError('invalid-catalog-response', 'catalog');
          for (const id of ids) {
            if (object(raw[id])) output.set(`${namespace}\0${id}`, raw[id]);
          }
        } catch (error) { failed = true; throw error; }
      }
    }));
    const failure = workers.find(worker => worker.status === 'rejected');
    if (failure) throw failure.reason;
    return output;
  }

  async function revoke(saved, ctx) {
    return request(ACCOUNT, `/account/api/oauth/sessions/kill/${encodeURIComponent(saved.accessToken)}`,
      { method: 'DELETE', headers: authHeaders(saved), empty: true }, ctx, 'revocation');
  }

  return { context, loginUrl, connect, renew, verify, library, playtime, catalog, revoke };
}

export default { createClient };
