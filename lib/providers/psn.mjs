import { randomBytes } from 'node:crypto';
import clientModule from '../../src/providers/psn/client.js';
import normalize from '../../src/providers/psn/normalize.js';
import errors from '../../src/shared/providerError.js';

const { createClient } = clientModule;
const { ProviderError } = errors;
const CONFIRMATION_MS = 5 * 60 * 1_000;
const LIBRARY_MS = 15 * 60 * 1_000;
const PRESENCE_MS = 60 * 1_000;
const PRESENCE_MAX_AGE_MS = 90 * 1_000;
const DETAIL_MS = 60 * 60 * 1_000;
const MAX_DETAIL_RECORDS = 16;
const MAX_TROPHY_SETS = 10;
const MAX_DETAIL_TROPHIES = 2_500;
const MAX_BACKOFF_MS = 60 * 60 * 1_000;

const iso = value => value == null ? null : new Date(value).toISOString();
const unavailablePresence = lastSuccessAt => ({ status: 'unavailable', lastSuccessAt: iso(lastSuccessAt), activity: 'unavailable', online: null, platform: null, games: [] });
const cleanState = state => state && typeof state === 'object' && !Array.isArray(state) ? state : {};

function validateStore(store) {
  if (!store || typeof store.read !== 'function' || typeof store.locked !== 'function') {
    throw new ProviderError('invalid-store', 'configuration');
  }
  return store;
}
function parseNpsso(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{64}$/.test(value)) throw new ProviderError('invalid-npsso-format', 'authentication');
  return value;
}
function confirmation(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(value)) throw new ProviderError('confirmation-expired', 'connection');
  return value;
}
function statusFor(state) {
  if (state.rotationPending || state.status === 'reconnect-required') return 'reconnect-required';
  return state.status === 'connected' ? 'connected' : 'not-configured';
}
function failureCode(error) { return error instanceof ProviderError ? error.code : 'network-error'; }
function failureDelay(error, failures) {
  const exponential = Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** Math.min(failures, 6));
  return Math.max(exponential, error instanceof ProviderError ? error.retryAfterMs : 0);
}

export function createPsn({ store: rawStore, fetchImpl = fetch, now = Date.now } = {}) {
  const store = validateStore(rawStore);
  const client = createClient({ fetchImpl, now });

  function librarySnapshot(state) {
    const connection = statusFor(state);
    if (connection !== 'connected') return { status: connection, lastSuccessAt: null };
    const row = state.library;
    if (!row?.payload) return { status: row?.status === 'private' ? 'private' : 'unavailable', lastSuccessAt: iso(row?.lastSuccessAt) };
    const stale = row.status !== 'ready';
    return { status: stale ? 'stale' : 'ready', stale, lastSuccessAt: iso(row.lastSuccessAt), ...row.payload };
  }

  function presenceSnapshot(state) {
    const connection = statusFor(state);
    if (connection !== 'connected') return { status: connection, lastSuccessAt: null, activity: 'unavailable', online: null, platform: null, games: [] };
    const row = state.presence;
    if (!row?.payload || row.status !== 'ready' || now() - row.lastSuccessAt > PRESENCE_MAX_AGE_MS || now() >= row.nextRefreshAt) {
      return unavailablePresence(row?.lastSuccessAt);
    }
    return { status: 'ready', lastSuccessAt: iso(row.lastSuccessAt), ...row.payload };
  }

  async function snapshots() {
    const state = cleanState(await store.read());
    return { library: librarySnapshot(state), presence: presenceSnapshot(state) };
  }

  async function identify({ npsso } = {}) {
    const token = parseNpsso(npsso);
    return store.locked(async (raw, save) => {
      const state = cleanState(raw);
      if (state.status === 'connected' && !state.rotationPending) throw new ProviderError('disconnect-before-reconnecting', 'connection');
      const expectedAccountId = state.accountId;
      const ctx = client.context();
      const issued = await client.connect(token, ctx);
      const identity = await client.identify(issued, ctx, expectedAccountId);
      if (state.onlineId && identity.onlineId.toLowerCase() !== state.onlineId.toLowerCase()) {
        throw new ProviderError('owner-account-mismatch', 'connection');
      }
      const confirmationId = randomBytes(24).toString('base64url');
      state.pending = {
        confirmationId,
        expiresAt: now() + CONFIRMATION_MS,
        onlineId: identity.onlineId,
        accountId: identity.accountId,
        session: { ...issued, accountId: identity.accountId },
      };
      await save(state);
      return { onlineId: identity.onlineId, confirmationId };
    });
  }

  async function confirm({ confirmationId } = {}) {
    const selected = confirmation(confirmationId);
    return store.locked(async (raw, save) => {
      const state = cleanState(raw);
      const pending = state.pending;
      if (!pending || pending.confirmationId !== selected || !Number.isFinite(pending.expiresAt) || pending.expiresAt <= now()) {
        if (pending?.expiresAt <= now()) {
          delete state.pending;
          await save(state);
        }
        throw new ProviderError('confirmation-expired', 'connection');
      }
      if ((state.accountId && state.accountId !== pending.accountId) ||
        (state.onlineId && state.onlineId.toLowerCase() !== pending.onlineId.toLowerCase())) {
        delete state.pending;
        await save(state);
        throw new ProviderError('owner-account-mismatch', 'connection');
      }
      const replacement = {
        version: 1,
        status: 'connected',
        onlineId: pending.onlineId,
        accountId: pending.accountId,
        session: pending.session,
        rotationPending: false,
        retryAt: 0,
        failures: 0,
      };
      if (state.accountId === pending.accountId) {
        for (const key of ['library', 'presence', 'lists', 'summary', 'details']) {
          if (state[key] !== undefined) replacement[key] = state[key];
        }
      }
      await save(replacement);
      return { status: 'connected' };
    });
  }

  async function session(state, save, ctx) {
    if (state.status !== 'connected' || !state.session) throw new ProviderError('not-connected', 'authentication');
    if (state.rotationPending) {
      state.status = 'reconnect-required';
      await save(state);
      throw new ProviderError('rotation-interrupted-reconnect', 'authentication');
    }
    if (!Number.isFinite(state.session.refreshExpiresAt) || state.session.refreshExpiresAt <= now()) {
      state.status = 'reconnect-required';
      await save(state);
      throw new ProviderError('reconnect-required', 'authentication');
    }
    if (state.session.accessExpiresAt - now() >= 120_000) return state.session;

    state.rotationPending = true;
    await save(state);
    let next;
    try { next = await client.renew(state.session, ctx); }
    catch (error) {
      state.status = 'reconnect-required';
      await save(state);
      throw error;
    }
    const rotated = { ...next, accountId: state.accountId };
    const replacement = { ...state, session: rotated, rotationPending: false };
    // Do not clear the in-memory marker until the durable replacement succeeds.
    // If this save throws, the caller sees rotationPending and can only persist a
    // reconnect-required marker with the old, never-reused refresh token.
    await save(replacement);
    Object.assign(state, replacement);
    try { await client.verify(rotated, state.onlineId, ctx, state.accountId); }
    catch (error) {
      state.status = 'reconnect-required';
      await save(state);
      throw error;
    }
    return rotated;
  }

  async function markFailure(state, save, error, resources) {
    const code = failureCode(error);
    if (state.rotationPending || ['reconnect-required', 'account-mismatch', 'rotation-interrupted-reconnect', 'credential-integrity-failed'].includes(code)) {
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

  async function refresh({ force = false, presenceOnly = false } = {}) {
    if (typeof force !== 'boolean') throw new ProviderError('invalid-refresh-options', 'configuration');
    return store.locked(async (raw, save) => {
      const state = cleanState(raw);
      if (state.rotationPending) {
        state.status = 'reconnect-required';
        await save(state);
        return { status: 'reconnect-required' };
      }
      if (state.status !== 'connected') return { status: statusFor(state) };
      if (state.retryAt > now()) return { status: librarySnapshot(state).status };
      const libraryDue = !presenceOnly && (force || !state.library?.payload || now() >= (state.library.nextRefreshAt || 0));
      const presenceDue = force || !state.presence?.payload || now() >= (state.presence.nextRefreshAt || 0);
      if (!libraryDue && !presenceDue) return { status: librarySnapshot(state).status };
      const ctx = client.context();
      let saved;
      try { saved = await session(state, save, ctx); }
      catch (error) { return { status: await markFailure(state, save, error, []) }; }

      if (libraryDue) {
        try {
          const games = normalize.library(await client.library(saved, ctx));
          const lists = normalize.trophyLists(await client.lists(saved, ctx));
          const rawSummary = await client.summary(saved, ctx);
          if (normalize.accountId(rawSummary?.accountId) !== state.accountId) throw new ProviderError('account-mismatch', 'identity');
          const finished = now();
          state.library = { status: 'ready', payload: games, lastSuccessAt: finished, attemptedAt: finished, nextRefreshAt: finished + LIBRARY_MS };
          state.lists = { status: 'ready', payload: { sets: lists }, lastSuccessAt: finished, attemptedAt: finished, nextRefreshAt: finished + LIBRARY_MS };
          state.summary = { status: 'ready', payload: normalize.summary(rawSummary, lists), lastSuccessAt: finished, attemptedAt: finished, nextRefreshAt: finished + LIBRARY_MS };
          state.details = Object.fromEntries(Object.entries(state.details || {}).filter(([id]) => games.games.some(game => game.providerGameId === id)).slice(-MAX_DETAIL_RECORDS));
          state.failures = 0;
          state.retryAt = 0;
          await save(state);
        } catch (error) {
          const status = await markFailure(state, save, error, ['library', 'lists', 'summary']);
          return { status };
        }
      }

      if (presenceDue) {
        try {
          const payload = normalize.presence(await client.presence(saved, ctx));
          const finished = now();
          state.presence = { status: 'ready', payload, lastSuccessAt: finished, attemptedAt: finished, nextRefreshAt: finished + PRESENCE_MS };
          state.failures = 0;
          state.retryAt = 0;
          await save(state);
        } catch (error) {
          const status = await markFailure(state, save, error, ['presence']);
          return { status: state.library?.payload ? (state.library.status === 'ready' ? 'ready' : 'stale') : status };
        }
      }
      return { status: librarySnapshot(state).status };
    });
  }

  function shapeDetail(state, titleId, row) {
    const found = state.library.payload.games.find(game => game.providerGameId === titleId);
    const visible = new Set((state.lists?.payload?.sets || []).map(set => `${set.service}:${set.id}`));
    const sets = (row?.payload?.trophySets || []).filter(set => visible.has(`${set.service}:${set.id}`));
    const trophyStatus = !state.lists?.payload ? (state.lists?.status === 'private' ? 'private' : 'unavailable')
      : row?.payload ? (sets.length ? 'available' : 'no-visible-synced-set') : 'pending';
    const earnedWithRarity = sets.flatMap(set => set.trophies.filter(trophy => trophy.earned === true && trophy.earnedRate !== null)
      .map(trophy => ({ ...trophy, trophySetId: set.id, service: set.service }))).sort((left, right) => left.earnedRate - right.earnedRate);
    const relatedEditions = found.conceptId ? state.library.payload.games.filter(game => game.conceptId === found.conceptId)
      .map(game => ({ providerGameId: game.providerGameId, name: game.name, platform: game.platform })) : [];
    return {
      ...(row?.payload || {}),
      game: found,
      relatedEditions,
      trophyStatus,
      rarestUnlock: state.lists?.payload ? earnedWithRarity[0] || null : null,
      rarityComparison: 'earned-trophies-with-known-rarity-in-visible-cached-sets',
      trophySets: state.lists?.payload ? sets : [],
    };
  }

  async function detail(id) {
    const titleId = normalize.identifier(id);
    return store.locked(async (raw, save) => {
      const state = cleanState(raw);
      if (statusFor(state) !== 'connected' || !state.library?.payload) {
        return { httpStatus: 503, body: { status: statusFor(state) === 'connected' ? 'unavailable' : statusFor(state) } };
      }
      if (!state.library.payload.games.some(game => game.providerGameId === titleId)) {
        return { httpStatus: 404, body: { error: 'Game not in the cached PSN played history' } };
      }
      const cached = state.details?.[titleId];
      if (cached?.payload && now() < cached.nextRefreshAt) return { httpStatus: 200, body: shapeDetail(state, titleId, cached) };
      if (!state.lists?.payload) return { httpStatus: 200, body: shapeDetail(state, titleId, cached) };
      if (state.retryAt > now() && cached?.payload) return { httpStatus: 200, body: shapeDetail(state, titleId, cached) };

      const ctx = client.context();
      let saved;
      try { saved = await session(state, save, ctx); }
      catch (error) {
        await markFailure(state, save, error, []);
        return cached?.payload ? { httpStatus: 200, body: shapeDetail(state, titleId, cached) }
          : { httpStatus: 503, body: { trophyStatus: 'unavailable', trophySets: [] } };
      }
      try {
        const sets = normalize.mappedSets(await client.mapping(titleId, saved, ctx), titleId, state.lists.payload.sets);
        if (sets.length > MAX_TROPHY_SETS) throw new ProviderError('too-many-trophy-sets', 'details');
        const detailed = [];
        let trophyCount = 0;
        for (const set of sets) {
          const definitions = await client.trophies(set, false, saved, ctx);
          trophyCount += definitions.length;
          if (trophyCount > MAX_DETAIL_TROPHIES) throw new ProviderError('too-many-trophies', 'details');
          const earned = await client.trophies(set, true, saved, ctx);
          detailed.push({ ...set, ...normalize.trophies(definitions, earned) });
        }
        const finished = now();
        const row = { status: 'ready', payload: { trophyStatus: sets.length ? 'available' : 'no-synced-set', trophySets: detailed },
          lastSuccessAt: finished, attemptedAt: finished, nextRefreshAt: finished + DETAIL_MS };
        state.details = { ...(state.details || {}), [titleId]: row };
        const entries = Object.entries(state.details).sort((left, right) => (left[1].lastSuccessAt || 0) - (right[1].lastSuccessAt || 0));
        state.details = Object.fromEntries(entries.slice(-MAX_DETAIL_RECORDS));
        state.failures = 0;
        state.retryAt = 0;
        await save(state);
        return { httpStatus: 200, body: shapeDetail(state, titleId, row) };
      } catch (error) {
        await markFailure(state, save, error, []);
        return cached?.payload ? { httpStatus: 200, body: shapeDetail(state, titleId, cached) }
          : { httpStatus: 503, body: { trophyStatus: failureCode(error) === 'private' ? 'private' : 'unavailable', trophySets: [] } };
      }
    });
  }

  async function disconnect() {
    return store.locked(async (_state, save) => {
      await save({});
      return { status: 'not-configured' };
    });
  }

  return { identify, confirm, refresh, snapshots, detail, disconnect };
}
