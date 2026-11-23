import { createHash, randomBytes } from 'node:crypto';
import errors from '../../shared/providerError.js';
import normalize from './normalize.mjs';

const { ProviderError } = errors;

const AUTHORIZE_URL = 'https://login.live.com/oauth20_authorize.srf';
const TOKEN_URL = 'https://login.live.com/oauth20_token.srf';
const USER_AUTH_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const PROFILE_URL = 'https://profile.xboxlive.com';
const TITLEHUB_URL = 'https://titlehub.xboxlive.com';
const USERSTATS_URL = 'https://userstats.xboxlive.com';
const ACHIEVEMENTS_URL = 'https://achievements.xboxlive.com';

const SCOPES = 'XboxLive.signin XboxLive.offline_access';
const XBOX_RELYING_PARTY = 'http://xboxlive.com';
const USER_RELYING_PARTY = 'http://auth.xboxlive.com';

// Every upstream request is restricted to these fixed HTTPS origins, mirroring the
// allowlisted-origin invariant in the provider contract.
const ALLOWED_ORIGINS = new Set([
  'https://login.live.com',
  'https://user.auth.xboxlive.com',
  'https://xsts.auth.xboxlive.com',
  'https://profile.xboxlive.com',
  'https://titlehub.xboxlive.com',
  'https://userstats.xboxlive.com',
  'https://achievements.xboxlive.com',
]);

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ITEMS = 1_000;
const MAX_PAGES = 20;
const MAX_RECORDS = 5_000;
const CALLBACK_KEYS = new Set(['code', 'state', 'error', 'error_description', 'session_state', 'lc']);

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const secret = value => typeof value === 'string' && value.length > 0 && value.length <= 16_384 && !/[\r\n]/.test(value);
const dateString = value => typeof value === 'string' && value.length > 0 && value.length <= 64 && Number.isFinite(Date.parse(value));

function createClient({ fetchImpl = global.fetch, now = Date.now, requestMs = 8_000, maxBytes = MAX_BYTES } = {}) {
  const context = (jobMs = 55_000) => ({ signal: AbortSignal.timeout(jobMs), remaining: 5_120 });

  async function request(url, options, ctx, stage) {
    let parsed;
    try { parsed = new URL(url); }
    catch { throw new ProviderError('invalid-upstream-url', stage); }
    if (!ALLOWED_ORIGINS.has(parsed.origin)) throw new ProviderError('blocked-origin', stage);
    if (--ctx.remaining < 0) throw new ProviderError('request-budget-exhausted', stage);

    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(requestMs)]);
    let response;
    try {
      response = await fetchImpl(parsed.href, { ...options, redirect: 'error', signal });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(signal.aborted ? 'timeout' : 'network-error', stage);
    }

    if (!response || !response.ok) {
      if (response?.body) { try { await response.body.cancel(); } catch { /* already consumed */ } }
      const status = response?.status;
      if (status === 429) {
        const header = response.headers.get('retry-after');
        const seconds = /^\d+$/.test(header || '') ? Number(header) * 1_000 : Date.parse(header || '') - now();
        throw new ProviderError('rate-limited', stage, Number.isFinite(seconds) ? Math.max(60_000, Math.min(seconds, 86_400_000)) : 300_000);
      }
      if (status === 401) throw new ProviderError('reconnect-required', stage);
      if (status === 403) throw new ProviderError('private', stage);
      if (status === 404) throw new ProviderError('not-found', stage);
      if (status === 400) throw new ProviderError('upstream-400', stage);
      throw new ProviderError(`upstream-${Number.isSafeInteger(status) ? status : 'error'}`, stage);
    }

    if (Number(response.headers.get('content-length')) > maxBytes) {
      if (response.body) { try { await response.body.cancel(); } catch { /* already consumed */ } }
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
  }

  function authorization({ clientId, redirectUri }) {
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', SCOPES);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('approval_prompt', 'auto');
    return { url: url.toString(), state, verifier };
  }

  function parseCallback(callback, redirectUri) {
    const url = normalize.parseCallback(callback);
    let expected;
    try { expected = new URL(redirectUri); }
    catch { throw new ProviderError('xbox-oauth-not-configured', 'configuration'); }
    if (url.protocol !== expected.protocol || url.hostname !== expected.hostname || url.port !== expected.port ||
      url.pathname !== expected.pathname || url.username || url.password || url.hash) {
      throw new ProviderError('invalid-callback', 'connection');
    }
    if ([...url.searchParams.keys()].some(key => !CALLBACK_KEYS.has(key))) {
      throw new ProviderError('invalid-callback', 'connection');
    }
    if (url.searchParams.has('error')) {
      if (url.searchParams.getAll('error').length !== 1) throw new ProviderError('invalid-callback', 'connection');
      // Cancellation and consent denial are safe, expected outcomes.
      throw new ProviderError('authorization-denied', 'connection');
    }
    const codes = url.searchParams.getAll('code');
    const states = url.searchParams.getAll('state');
    if (codes.length !== 1 || states.length !== 1 || !/^[A-Za-z0-9._~+/=-]{1,4096}$/.test(codes[0]) ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(states[0])) {
      throw new ProviderError('invalid-callback', 'connection');
    }
    return { code: codes[0], state: states[0] };
  }

  function parseOAuth(raw) {
    if (!object(raw) || !secret(raw.access_token) || !Number.isSafeInteger(raw.expires_in) ||
      raw.expires_in < 1 || raw.expires_in > 366 * 86_400 ||
      (raw.refresh_token !== undefined && !secret(raw.refresh_token))) {
      throw new ProviderError('invalid-token-response', 'authentication');
    }
    return {
      accessToken: raw.access_token,
      refreshToken: typeof raw.refresh_token === 'string' ? raw.refresh_token : null,
      accessExpiresAt: now() + raw.expires_in * 1_000,
      refreshExpiresAt: Number.isSafeInteger(raw.refresh_token_expires_in) && raw.refresh_token_expires_in > 0
        ? now() + raw.refresh_token_expires_in * 1_000 : null,
    };
  }

  async function oauthToken(form, ctx) {
    const body = new URLSearchParams(form).toString();
    return parseOAuth(await request(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    }, ctx, 'authentication'));
  }

  async function exchange({ code, verifier, clientId, clientSecret, redirectUri }, ctx) {
    try {
      const result = await oauthToken({
        client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code',
        code, redirect_uri: redirectUri, scope: SCOPES, code_verifier: verifier,
      }, ctx);
      if (!secret(result.refreshToken)) throw new ProviderError('invalid-token-response', 'authentication');
      return result;
    } catch (error) {
      if (error instanceof ProviderError && error.code === 'upstream-400') {
        throw new ProviderError('authorization-failed', 'authentication');
      }
      throw error;
    }
  }

  async function renew(session, { clientId, clientSecret }, ctx) {
    if (!secret(session.refreshToken)) throw new ProviderError('reconnect-required', 'authentication');
    try {
      return await oauthToken({
        client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token',
        refresh_token: session.refreshToken, scope: SCOPES,
      }, ctx);
    } catch (error) {
      if (error instanceof ProviderError && ['upstream-400', 'not-found'].includes(error.code)) {
        throw new ProviderError('reconnect-required', 'authentication');
      }
      throw error;
    }
  }

  function parseUserToken(raw) {
    if (!object(raw) || !secret(raw.Token) || !dateString(raw.NotAfter) ||
      !Array.isArray(raw.DisplayClaims?.xui) || !object(raw.DisplayClaims.xui[0]) ||
      typeof raw.DisplayClaims.xui[0].uhs !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(raw.DisplayClaims.xui[0].uhs)) {
      throw new ProviderError('invalid-token-response', 'authentication');
    }
    return { token: raw.Token, notAfter: Date.parse(raw.NotAfter), uhs: raw.DisplayClaims.xui[0].uhs };
  }

  // OAuth -> Xbox user token -> XSTS ticket for http://xboxlive.com. This is the
  // documented confidential-client flow and also the XUID source for the account.
  async function establish(oauth, ctx) {
    const user = parseUserToken(await request(USER_AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-xbl-contract-version': '1', Accept: 'application/json' },
      body: JSON.stringify({
        RelyingParty: USER_RELYING_PARTY,
        TokenType: 'JWT',
        Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${oauth.accessToken}` },
      }),
    }, ctx, 'authentication'));

    let raw;
    try {
      raw = await request(XSTS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-xbl-contract-version': '1', Accept: 'application/json' },
        body: JSON.stringify({
          RelyingParty: XBOX_RELYING_PARTY,
          TokenType: 'JWT',
          Properties: { UserTokens: [user.token], SandboxId: 'RETAIL' },
        }),
      }, ctx, 'authentication');
    } catch (error) {
      if (error instanceof ProviderError && error.code === 'reconnect-required') {
        throw new ProviderError('account-ineligible', 'identity');
      }
      throw error;
    }
    if (!object(raw) || !secret(raw.Token) || !dateString(raw.NotAfter) ||
      !Array.isArray(raw.DisplayClaims?.xui) || !object(raw.DisplayClaims.xui[0])) {
      throw new ProviderError('invalid-token-response', 'authentication');
    }
    const claim = raw.DisplayClaims.xui[0];
    const xuid = typeof claim.xid === 'string' && /^\d{1,20}$/.test(claim.xid) ? claim.xid
      : typeof claim.xid === 'number' && Number.isSafeInteger(claim.xid) ? String(claim.xid) : null;
    if (!xuid || typeof claim.uhs !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(claim.uhs) || claim.uhs !== user.uhs) {
      throw new ProviderError('invalid-token-response', 'authentication');
    }
    return {
      xuid,
      uhs: claim.uhs,
      xstsToken: raw.Token,
      xstsExpiresAt: Date.parse(raw.NotAfter),
      gamertag: typeof claim.gtg === 'string' ? claim.gtg : null,
    };
  }

  const authHeader = session => `XBL3.0 x=${session.uhs};${session.xstsToken}`;

  async function api(url, query, session, ctx, stage, headers = {}) {
    const target = new URL(url);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined) target.searchParams.set(key, String(value));
    }
    return request(target.href, {
      headers: { Authorization: authHeader(session), Accept: 'application/json', 'Accept-Language': 'en-US', ...headers },
    }, ctx, stage);
  }

  async function profile(xuid, session, ctx) {
    return api(`${PROFILE_URL}/users/xuid(${xuid})/profile/settings`, {
      settings: 'Gamertag,ModernGamertag,GameDisplayPicRaw,Gamerscore',
    }, session, ctx, 'identity', { 'x-xbl-contract-version': '3' });
  }

  async function titleHistory(xuid, session, ctx) {
    const fields = 'achievement,image,scid';
    const path = `${TITLEHUB_URL}/users/xuid(${xuid})/titles/titlehistory/decoration/${fields}`;
    const headers = {
      'x-xbl-contract-version': '2',
      'x-xbl-client-name': 'XboxApp',
      'x-xbl-client-type': 'UWA',
      'x-xbl-client-version': '39.39.22001.0',
    };
    const titles = [];
    const seen = new Set();
    let continuation = null;
    let total = null;
    let echoed = undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const raw = await api(path, { maxItems: MAX_ITEMS, continuationToken: continuation || undefined }, session, ctx, 'library', headers);
      if (!object(raw) || !Array.isArray(raw.titles) || raw.titles.length > MAX_RECORDS) {
        throw new ProviderError('invalid-title-history', 'library');
      }
      if (echoed === undefined) echoed = raw.xuid;
      else if (raw.xuid !== echoed) throw new ProviderError('inventory-changed-during-pagination', 'library');
      titles.push(...raw.titles);
      const paging = object(raw.pagingInfo) ? raw.pagingInfo : null;
      if (!paging) {
        if (titles.length >= MAX_ITEMS) throw new ProviderError('incomplete-pagination', 'library');
        return { xuid: echoed, titles };
      }
      if (!Number.isSafeInteger(paging.totalRecords) || paging.totalRecords < 0 || paging.totalRecords > MAX_RECORDS) {
        throw new ProviderError('invalid-title-history', 'library');
      }
      if (total !== null && total !== paging.totalRecords) throw new ProviderError('inventory-changed-during-pagination', 'library');
      total = paging.totalRecords;
      if (titles.length > total) throw new ProviderError('invalid-page-count', 'library');
      const next = paging.continuationToken ?? null;
      if (next === null) {
        if (titles.length !== total) throw new ProviderError('incomplete-pagination', 'library');
        return { xuid: echoed, titles };
      }
      if (typeof next !== 'string' || next.length < 1 || next.length > 4_096 || seen.has(next) ||
        !raw.titles.length || titles.length >= total) {
        throw new ProviderError('nonadvancing-pagination', 'library');
      }
      seen.add(next);
      continuation = next;
    }
    throw new ProviderError('page-budget-exhausted', 'library');
  }

  async function playtime(scid, xuid, session, ctx) {
    return api(`${USERSTATS_URL}/users/xuid(${xuid})/scids/${encodeURIComponent(scid)}/stats/MinutesPlayed`, null,
      session, ctx, 'playtime', { 'x-xbl-contract-version': '2' });
  }

  // Titles without a service configuration id are queried through the documented
  // userstats batch shape (arrangebyfield/groups/stats/xuids), still for one title.
  async function playtimeByTitle(titleId, xuid, session, ctx) {
    const target = new URL(`${USERSTATS_URL}/batch`);
    return request(target.href, {
      method: 'POST',
      headers: {
        Authorization: authHeader(session),
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-xbl-contract-version': '2',
      },
      body: JSON.stringify({
        arrangebyfield: 'xuid',
        groups: [{ name: 'Hero', titleId }],
        stats: [{ name: 'MinutesPlayed', titleId }],
        xuids: [xuid],
      }),
    }, ctx, 'playtime');
  }

  async function achievements(id, xuid, session, ctx, { legacy = false } = {}) {
    const url = legacy ? `${ACHIEVEMENTS_URL}/users/xuid(${xuid})/titleachievements` : `${ACHIEVEMENTS_URL}/users/xuid(${xuid})/achievements`;
    const headers = { 'x-xbl-contract-version': legacy ? '1' : '2' };
    const records = [];
    const seen = new Set();
    let continuation = null;
    let total = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = { titleId: id, continuationToken: continuation || undefined };
      // maxItems is documented for the v2 collection; the legacy 360 endpoint is
      // called exactly as the protocol reference does.
      if (!legacy) query.maxItems = MAX_ITEMS;
      const raw = await api(url, query, session, ctx, 'details', headers);
      const parsed = normalize.page(raw, 'details');
      if (total !== null && parsed.total !== null && total !== parsed.total) throw new ProviderError('inventory-changed-during-pagination', 'details');
      if (parsed.total !== null) total = parsed.total;
      if (records.length + parsed.records.length > MAX_RECORDS) throw new ProviderError('too-many-achievements', 'details');
      records.push(...parsed.records);
      if (total !== null && records.length > total) throw new ProviderError('invalid-page-count', 'details');
      if (parsed.next === null) {
        if (total !== null && records.length !== total) throw new ProviderError('incomplete-pagination', 'details');
        return records;
      }
      if (!parsed.records.length || seen.has(parsed.next) || (total !== null && records.length >= total)) {
        throw new ProviderError('nonadvancing-pagination', 'details');
      }
      seen.add(parsed.next);
      continuation = parsed.next;
    }
    throw new ProviderError('page-budget-exhausted', 'details');
  }

  return { context, authorization, parseCallback, exchange, renew, establish, profile, titleHistory, playtime, playtimeByTitle, achievements };
}

export { createClient };
export default { createClient };
