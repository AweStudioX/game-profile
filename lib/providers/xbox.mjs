import { timingSafeEqual } from 'node:crypto';
import clientModule from '../../src/providers/xbox/client.mjs';
import normalize from '../../src/providers/xbox/normalize.mjs';
import errors from '../../src/shared/providerError.js';

const { createClient } = clientModule;
const { ProviderError } = errors;

const PENDING_MS = 10 * 60 * 1_000;
const LIBRARY_MS = 15 * 60 * 1_000;
const DETAIL_MS = 60 * 60 * 1_000;
const MAX_DETAIL_RECORDS = 16;
const MAX_BACKOFF_MS = 60 * 60 * 1_000;

const iso = value => value == null ? null : new Date(value).toISOString();
const cleanState = state => state && typeof state === 'object' && !Array.isArray(state) ? state : {};

function validateStore(store) {
  if (!store || typeof store.readSnapshot !== 'function' || typeof store.locked !== 'function') {
    throw new ProviderError('invalid-store', 'configuration');
  }
  return store;
}

// Configuration is validated lazily so the provider object is always constructible;
// snapshots and identity stay readable without Xbox OAuth settings.
function configuration(clientId, clientSecret, redirectUri) {
  if (typeof clientId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(clientId)) return null;
  if (typeof clientSecret !== 'string' || clientSecret.length < 1 || clientSecret.length > 512 || /[\r\n]/.test(clientSecret)) return null;
  if (typeof redirectUri !== 'string' || redirectUri.length > 2_048) return null;
  let url;
  try { url = new URL(redirectUri); }
  catch { return null; }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.username || url.password || url.hash || url.search) return null;
  if (!(url.protocol === 'https:' || (loopback && url.protocol === 'http:'))) return null;
  return { clientId, clientSecret, redirectUri: url.href };
}

function statusFor(state, refreshing = false) {
  if (state.status === 'reconnect-required') return 'reconnect-required';
  if (state.rotationPending && !refreshing) return 'reconnect-required';
  return state.status === 'connected' && state.session ? 'connected' : 'not-configured';
}

function failureCode(error) {
  return error instanceof ProviderError ? error.code : 'network-error';
}

function failureDelay(error, failures) {
  const exponential = Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** Math.min(failures, 6));
  return Math.max(exponential, error instanceof ProviderError ? error.retryAfterMs : 0);
}

function sameState(actual, expected) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createXbox({
  store: rawStore, fetchImpl = fetch, now = Date.now, clientId, clientSecret, redirectUri,
} = {}) {
  const store = validateStore(rawStore);
  const client = createClient({ fetchImpl, now });
  const config = () => configuration(clientId, clientSecret, redirectUri);

  function librarySnapshot(state, refreshing = false) {
    const connection = statusFor(state, refreshing);
    if (connection !== 'connected') return { status: connection, lastSuccessAt: null };
    const row = state.library;
    if (!row?.payload) return { status: row?.status === 'private' ? 'private' : 'unavailable', lastSuccessAt: iso(row?.lastSuccessAt) };
    const stale = row.status !== 'ready';
    return { status: stale ? 'stale' : 'ready', stale, lastSuccessAt: iso(row.lastSuccessAt), ...row.payload };
  }

  async function snapshots() {
    // Reading the lease with the payload keeps an active rotation from looking like a crash.
    const { state: raw, busy } = await store.readSnapshot();
    const state = cleanState(raw);
    return { library: librarySnapshot(state, busy) };
  }

  async function start() {
    const current = config();
    if (!current) throw new ProviderError('xbox-oauth-not-configured', 'configuration');
    const request = client.authorization(current);
    await store.locked(async (raw, save) => {
      const state = cleanState(raw);
      await save({
        ...state,
        pending: {
          state: request.state,
          verifier: request.verifier,
          expiresAt: now() + PENDING_MS,
          redirectUri: current.redirectUri,
        },
      });
    });
    return { url: request.url };
  }

  async function confirm({ callback } = {}) {
    return store.locked(async (raw, save) => {
      const state = cleanState(raw);
      const pending = state.pending;
      const currentTime = now();
      if (!pending || typeof pending.state !== 'string' || typeof pending.verifier !== 'string' ||
        typeof pending.redirectUri !== 'string' || !Number.isFinite(pending.expiresAt)) {
        throw new ProviderError('authorization-not-pending', 'connection');
      }
      if (currentTime >= pending.expiresAt) {
        delete state.pending;
        await save(state);
        throw new ProviderError('authorization-not-pending', 'connection');
      }
      const current = config();
      // Structure and origin are checked before the one-time pending state is burned.
      const parsed = client.parseCallback(callback, pending.redirectUri);
      delete state.pending;
      await save(state);
      if (!current) throw new ProviderError('xbox-oauth-not-configured', 'configuration');
      if (current.redirectUri !== pending.redirectUri) throw new ProviderError('xbox-oauth-not-configured', 'configuration');
      if (!sameState(parsed.state, pending.state)) throw new ProviderError('state-mismatch', 'connection');

      const ctx = client.context();
      const oauth = await client.exchange({ ...current, code: parsed.code, verifier: pending.verifier }, ctx);
      const principal = await client.establish(oauth, ctx);
      if (state.xuid && state.xuid !== principal.xuid) throw new ProviderError('owner-account-mismatch', 'connection');
      const rawProfile = await client.profile(principal.xuid, principal, ctx);
      const profile = normalize.profile(rawProfile, principal.xuid);
      const identity = normalize.identity(profile.gamertag, profile.avatarUrl);
      if (!identity) throw new ProviderError('invalid-profile', 'identity');

      const replacement = {
        version: 1,
        status: 'connected',
        xuid: principal.xuid,
        gamertag: profile.gamertag,
        identity,
        session: {
          accessToken: oauth.accessToken,
          refreshToken: oauth.refreshToken,
          accessExpiresAt: oauth.accessExpiresAt,
          refreshExpiresAt: oauth.refreshExpiresAt,
          uhs: principal.uhs,
          xstsToken: principal.xstsToken,
          xstsExpiresAt: principal.xstsExpiresAt,
        },
        rotationPending: false,
        retryAt: 0,
        failures: 0,
      };
      if (state.xuid === principal.xuid) {
        for (const key of ['library', 'details', 'achievementInfo', 'legacyTitles']) {
          if (state[key] !== undefined) replacement[key] = state[key];
        }
      }
      await save(replacement);
      return { status: 'connected' };
    });
  }

  // Renews the OAuth access token (durably, before any data request) and re-derives
  // the XSTS ticket when needed. Any interruption leaves the rotation marker set.
  async function session(state, save, current, ctx) {
    if (state.status !== 'connected' || !state.session) throw new ProviderError('not-connected', 'authentication');
    if (state.rotationPending) {
      state.status = 'reconnect-required';
      await save(state);
      throw new ProviderError('rotation-interrupted-reconnect', 'authentication');
    }
    let saved = state.session;
    if (!current) throw new ProviderError('xbox-oauth-not-configured', 'configuration');
    if (saved.refreshExpiresAt !== null && Number.isFinite(saved.refreshExpiresAt) && saved.refreshExpiresAt <= now()) {
      state.status = 'reconnect-required';
      await save(state);
      throw new ProviderError('reconnect-required', 'authentication');
    }

    if (!(saved.accessExpiresAt - now() >= 120_000)) {
      state.rotationPending = true;
      await save(state);
      let renewed;
      try { renewed = await client.renew(saved, current, ctx); }
      catch (error) {
        state.status = 'reconnect-required';
        await save(state);
        throw error;
      }
      const rotated = {
        ...saved,
        accessToken: renewed.accessToken,
        refreshToken: renewed.refreshToken ?? saved.refreshToken,
        accessExpiresAt: renewed.accessExpiresAt,
        refreshExpiresAt: renewed.refreshExpiresAt ?? saved.refreshExpiresAt,
        xstsToken: null,
        xstsExpiresAt: 0,
      };
      // Persist the rotated session durably before any further upstream work; if this
      // write fails the durable marker keeps the old refresh token unusable.
      const replacement = { ...state, session: rotated, rotationPending: false };
      await save(replacement);
      Object.assign(state, replacement);
      saved = rotated;
    }

    if (!saved.xstsToken || !(saved.xstsExpiresAt - now() >= 60_000)) {
      const principal = await client.establish({ accessToken: saved.accessToken }, ctx);
      if (principal.xuid !== state.xuid) {
        state.status = 'reconnect-required';
        await save(state);
        throw new ProviderError('account-mismatch', 'identity');
      }
      const next = { ...saved, uhs: principal.uhs, xstsToken: principal.xstsToken, xstsExpiresAt: principal.xstsExpiresAt };
      const replacement = { ...state, session: next };
      await save(replacement);
      Object.assign(state, replacement);
      saved = next;
    }
    return saved;
  }

  async function markFailure(state, save, error, resources) {
    const code = failureCode(error);
    if (state.rotationPending || ['reconnect-required', 'account-mismatch', 'rotation-interrupted-reconnect', 'credential-integrity-failed', 'account-ineligible'].includes(code)) {
      state.status = 'reconnect-required';
      await save(state);
      return 'reconnect-required';
    }
    state.failures = Math.min((state.failures || 0) + 1, 16);
    const delay = failureDelay(error, state.failures);
    state.retryAt = now() + delay;
    for (const resource of resources) {
      const old = state[resource];
      state[resource] = {
        ...(old || {}),
        status: code === 'private' ? 'private' : 'unavailable',
        attemptedAt: now(),
        nextRefreshAt: now() + delay,
        ...(code === 'private' ? { payload: undefined } : {}),
      };
    }
    await save(state);
    return state.library?.payload ? 'stale' : code === 'private' ? 'private' : 'unavailable';
  }

  function pruneDetails(state, ownedIds) {
    const details = Object.entries(state.details || {}).filter(([id]) => ownedIds.has(id));
    details.sort((left, right) => (left[1].lastSuccessAt || 0) - (right[1].lastSuccessAt || 0));
    if (details.length) state.details = Object.fromEntries(details.slice(-MAX_DETAIL_RECORDS));
    else delete state.details;
    const info = Object.fromEntries(Object.entries(state.achievementInfo || {}).filter(([id]) => ownedIds.has(id)));
    if (Object.keys(info).length) state.achievementInfo = info;
    else delete state.achievementInfo;
    const legacy = Object.fromEntries(Object.entries(state.legacyTitles || {}).filter(([id]) => ownedIds.has(id)));
    if (Object.keys(legacy).length) state.legacyTitles = legacy;
    else delete state.legacyTitles;
  }

  async function refresh({ force = false } = {}) {
    if (typeof force !== 'boolean') throw new ProviderError('invalid-refresh-options', 'configuration');
    return store.locked(async (raw, save) => {
      const state = cleanState(raw);
      if (state.rotationPending) {
        state.status = 'reconnect-required';
        await save(state);
        return { status: 'reconnect-required' };
      }
      if (state.status !== 'connected' || !state.session) return { status: statusFor(state) };
      if (typeof state.xuid !== 'string' || !/^\d{1,20}$/.test(state.xuid)) {
        state.status = 'reconnect-required';
        await save(state);
        return { status: 'reconnect-required' };
      }
      // A manual refresh never defeats rate-limit / failure backoff.
      if (state.retryAt > now()) return { status: librarySnapshot(state).status };
      const due = force || !state.library?.payload || now() >= (state.library.nextRefreshAt || 0);
      if (!due) return { status: librarySnapshot(state).status };
      const current = config();
      if (!current) return { status: librarySnapshot(state).status };

      const ctx = client.context();
      let saved;
      try { saved = await session(state, save, current, ctx); }
      catch (error) { return { status: await markFailure(state, save, error, ['library']) }; }

      try {
        const history = normalize.history(await client.titleHistory(state.xuid, saved, ctx), state.xuid);

        // Query every visible title. A missing/private stat is unknown; a transient
        // failure preserves the previous complete snapshot rather than losing time.
        const previous = new Map((state.library?.payload?.games || []).map(game => [game.providerGameId, game.playtimeMinutes]));
        const fetched = new Map();
        let next = 0;
        let failed = false;
        const workers = await Promise.allSettled(Array.from({ length: Math.min(6, history.statsTargets.length) }, async () => {
          while (!failed && next < history.statsTargets.length) {
            const target = history.statsTargets[next++];
            try {
              const raw = target.scid
                ? await client.playtime(target.scid, state.xuid, saved, ctx)
                : await client.playtimeByTitle(target.titleId, state.xuid, saved, ctx);
              fetched.set(target.titleId, normalize.playtime(raw));
            } catch (error) {
              if (['not-found', 'private', 'upstream-400'].includes(failureCode(error))) fetched.set(target.titleId, null);
              else { failed = true; throw error; }
            }
          }
        }));
        const failure = workers.find(worker => worker.status === 'rejected');
        if (failure) throw failure.reason;
        const games = normalize.mergePlaytime(history.games, fetched, previous);

        // Profile is a best-effort identity upgrade; the title-history XUID echo above
        // is the account verification that can never be skipped.
        let profile = null;
        try { profile = normalize.profile(await client.profile(state.xuid, saved, ctx), state.xuid); }
        catch (error) {
          const code = failureCode(error);
          if (code === 'account-mismatch' || code === 'reconnect-required' || code === 'rate-limited') throw error;
        }

        const finished = now();
        state.library = {
          status: 'ready',
          payload: normalize.library(games),
          lastSuccessAt: finished,
          attemptedAt: finished,
          nextRefreshAt: finished + LIBRARY_MS,
        };
        state.achievementInfo = history.achievementInfo;
        state.legacyTitles = Object.fromEntries(history.legacyTitles.map(id => [id, true]));
        if (profile) {
          state.gamertag = profile.gamertag;
          state.identity = normalize.identity(profile.gamertag, profile.avatarUrl) || state.identity;
        }
        pruneDetails(state, new Set(games.map(game => game.providerGameId)));
        state.failures = 0;
        state.retryAt = 0;
        await save(state);
        return { status: librarySnapshot(state).status };
      } catch (error) {
        return { status: await markFailure(state, save, error, ['library']) };
      }
    });
  }

  function shapeDetail(row, stale = false) {
    const body = {
      achievementStatus: row?.payload?.achievementStatus || 'unavailable',
      achievements: row?.payload?.achievements || [],
    };
    return stale ? { ...body, stale: true } : body;
  }

  async function detail(value) {
    const titleId = normalize.titleId(value);
    return store.locked(async (raw, save) => {
      const state = cleanState(raw);
      const connection = statusFor(state);
      if (connection !== 'connected' || !state.library?.payload ||
        typeof state.xuid !== 'string' || !/^\d{1,20}$/.test(state.xuid)) {
        return { httpStatus: 503, body: { achievementStatus: 'unavailable', achievements: [] } };
      }
      const game = state.library.payload.games.find(row => row.providerGameId === titleId);
      if (!game) return { httpStatus: 404, body: { error: 'Game not in the cached Xbox played history' } };

      const cached = state.details?.[titleId];
      if (cached?.payload && now() < (cached.nextRefreshAt || 0)) {
        return { httpStatus: 200, body: shapeDetail(cached) };
      }
      if (state.retryAt > now()) {
        return cached?.payload ? { httpStatus: 200, body: shapeDetail(cached, true) }
          : { httpStatus: 503, body: { achievementStatus: 'unavailable', achievements: [] } };
      }
      const current = config();
      if (!current) {
        return cached?.payload ? { httpStatus: 200, body: shapeDetail(cached, true) }
          : { httpStatus: 503, body: { achievementStatus: 'unavailable', achievements: [] } };
      }

      const ctx = client.context();
      let saved;
      try { saved = await session(state, save, current, ctx); }
      catch (error) {
        await markFailure(state, save, error, []);
        return cached?.payload ? { httpStatus: 200, body: shapeDetail(cached, true) }
          : { httpStatus: 503, body: { achievementStatus: 'unavailable', achievements: [] } };
      }

      const legacy = game.platform === 'xbox-360' || state.legacyTitles?.[titleId] === true;
      try {
        const records = await client.achievements(titleId, state.xuid, saved, ctx, { legacy });
        const achievements = normalize.achievements(records, { legacy });
        // An empty definition list means the title exposes no achievements here.
        const achievementStatus = achievements.length ? 'available' : 'not-supported';
        const finished = now();
        const row = {
          status: 'ready',
          payload: { achievementStatus, achievements },
          lastSuccessAt: finished,
          attemptedAt: finished,
          nextRefreshAt: finished + DETAIL_MS,
        };
        const details = { ...(state.details || {}), [titleId]: row };
        const entries = Object.entries(details).sort((left, right) => (left[1].lastSuccessAt || 0) - (right[1].lastSuccessAt || 0));
        state.details = Object.fromEntries(entries.slice(-MAX_DETAIL_RECORDS));
        state.failures = 0;
        state.retryAt = 0;
        await save(state);
        return { httpStatus: 200, body: shapeDetail(row) };
      } catch (error) {
        const code = failureCode(error);
        if (code === 'private') {
          const payload = { achievementStatus: 'private', achievements: [] };
          state.details = { ...(state.details || {}), [titleId]: {
            payload, nextRefreshAt: now() + 60_000,
          } };
          pruneDetails(state, new Set(state.library.payload.games.map(row => row.providerGameId)));
          await markFailure(state, save, error, []);
          return { httpStatus: 200, body: payload };
        }
        const unsupported = (legacy && ['not-found', 'upstream-400', 'upstream-404'].includes(code)) || code === 'not-found';
        if (cached?.payload) {
          await markFailure(state, save, error, []);
          return { httpStatus: 200, body: shapeDetail(cached, true) };
        }
        // Legacy titles without a usable achievements endpoint are honestly reported
        // as unsupported rather than as a transient failure, and that outcome is cached.
        if (unsupported) {
          const finished = now();
          const row = {
            status: 'ready',
            payload: { achievementStatus: 'not-supported', achievements: [] },
            lastSuccessAt: finished,
            attemptedAt: finished,
            nextRefreshAt: finished + DETAIL_MS,
          };
          const details = { ...(state.details || {}), [titleId]: row };
          const entries = Object.entries(details).sort((left, right) => (left[1].lastSuccessAt || 0) - (right[1].lastSuccessAt || 0));
          state.details = Object.fromEntries(entries.slice(-MAX_DETAIL_RECORDS));
          await save(state);
          return { httpStatus: 200, body: shapeDetail(row) };
        }
        await markFailure(state, save, error, []);
        return { httpStatus: 503, body: { achievementStatus: 'unavailable', achievements: [] } };
      }
    });
  }

  async function identity() {
    const { state: raw, busy } = await store.readSnapshot();
    const state = cleanState(raw);
    if (statusFor(state, busy) !== 'connected') return null;
    return normalize.storedIdentity(state.identity);
  }

  async function disconnect() {
    return store.locked(async (_state, save) => {
      await save({});
      return { status: 'not-configured' };
    });
  }

  return { start, confirm, refresh, snapshots, identity, detail, disconnect };
}
