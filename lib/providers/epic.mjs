// Epic Games provider. Session lifecycle adapted from gaming-stats-api (MIT License),
// https://github.com/AniketRaj314/gaming-stats-api; store/lease semantics follow the local PSN provider.
import { randomBytes } from 'node:crypto';
import { createClient } from '../../src/providers/epic/client.mjs';
import * as normalize from '../../src/providers/epic/normalize.mjs';
import errors from '../../src/shared/providerError.js';

const { ProviderError } = errors;
const CONFIRMATION_MS = 5 * 60 * 1_000;
const LIBRARY_MS = 15 * 60 * 1_000;
const CATALOG_MS = 24 * 60 * 60 * 1_000;
const MAX_BACKOFF_MS = 60 * 60 * 1_000;

const iso = value => value == null ? null : new Date(value).toISOString();
const cleanState = state => state && typeof state === 'object' && !Array.isArray(state) ? state : {};

function validateStore(store) {
  if (!store || typeof store.readSnapshot !== 'function' || typeof store.locked !== 'function') {
    throw new ProviderError('invalid-store', 'configuration');
  }
  return store;
}

function parseAuthorizationCode(value) {
  let candidate = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('"')) {
      try { candidate = JSON.parse(trimmed); }
      catch { throw new ProviderError('invalid-authorization-code', 'authentication'); }
    } else {
      candidate = trimmed;
    }
  }
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) candidate = candidate.authorizationCode;
  if (typeof candidate !== 'string' || !/^[A-Za-z0-9._~-]{1,2048}$/.test(candidate)) {
    throw new ProviderError('invalid-authorization-code', 'authentication');
  }
  return candidate;
}

function confirmation(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(value)) throw new ProviderError('confirmation-expired', 'connection');
  return value;
}

function statusFor(state, refreshing = false) {
  if ((state.rotationPending && !refreshing) || state.status === 'reconnect-required') return 'reconnect-required';
  return state.status === 'connected' ? 'connected' : 'not-configured';
}

function failureCode(error) { return error instanceof ProviderError ? error.code : 'network-error'; }

function cleanIdentity(displayName, accountId) {
  if (typeof displayName !== 'string' || displayName.length < 1 || displayName.length > 64 || /[\r\n]/.test(displayName)) return null;
  if (typeof accountId !== 'string' || !/^[a-f0-9]{32}$/.test(accountId)) return null;
  return { id: null, displayName, avatarUrl: null };
}

function failureDelay(error, failures) {
  const exponential = Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** Math.min(failures, 6));
  return Math.max(exponential, error instanceof ProviderError ? error.retryAfterMs : 0);
}

export function createEpic({ store: rawStore, fetchImpl = fetch, now = Date.now } = {}) {
  const store = validateStore(rawStore);
  const client = createClient({ fetchImpl, now });

  function librarySnapshot(state, refreshing = false) {
    const connection = statusFor(state, refreshing);
    if (connection !== 'connected') return { status: connection, lastSuccessAt: null };
    const row = state.library;
    if (!row?.payload) return { status: row?.status === 'private' ? 'private' : 'unavailable', lastSuccessAt: iso(row?.lastSuccessAt) };
    const stale = row.status !== 'ready';
    return { status: stale ? 'stale' : 'ready', stale, lastSuccessAt: iso(row.lastSuccessAt), ...row.payload };
  }

  async function snapshots() {
    // Read the lease together with the payload so an active rotation is not mistaken for a crash.
    const { state: raw, busy } = await store.readSnapshot();
    const state = cleanState(raw);
    return { library: librarySnapshot(state, busy) };
  }

  async function identify({ authorizationCode } = {}) {
    const code = parseAuthorizationCode(authorizationCode);
    return store.locked(async (raw, save) => {
      const state = cleanState(raw);
      if (state.status === 'connected' && !state.rotationPending) throw new ProviderError('disconnect-before-reconnecting', 'connection');
      const expectedAccountId = typeof state.accountId === 'string' ? state.accountId : null;
      const ctx = client.context();
      let issued;
      try { issued = await client.connect(code, ctx); }
      catch (error) {
        if (error instanceof ProviderError && error.code === 'reconnect-required') {
          throw new ProviderError('invalid-authorization-code', 'authentication');
        }
        throw error;
      }
      if (expectedAccountId && issued.accountId !== expectedAccountId) throw new ProviderError('owner-account-mismatch', 'connection');
      const verified = await client.verify(issued, ctx, expectedAccountId || issued.accountId);
      const confirmationId = randomBytes(24).toString('base64url');
      state.pending = {
        confirmationId,
        expiresAt: now() + CONFIRMATION_MS,
        accountId: verified.accountId,
        displayName: verified.displayName,
        session: { ...verified },
      };
      await save(state);
      return { displayName: verified.displayName, confirmationId };
    });
  }

  async function confirm({ confirmationId } = {}) {
    const selected = confirmation(confirmationId);
    return store.locked(async (raw, save) => {
      const state = cleanState(raw);
      const pending = state.pending;
      if (!pending || pending.confirmationId !== selected || !Number.isFinite(pending.expiresAt) || pending.expiresAt <= now()) {
        if (pending && Number.isFinite(pending.expiresAt) && pending.expiresAt <= now()) {
          delete state.pending;
          await save(state);
        }
        throw new ProviderError('confirmation-expired', 'connection');
      }
      if (state.accountId && state.accountId !== pending.accountId) {
        delete state.pending;
        await save(state);
        throw new ProviderError('owner-account-mismatch', 'connection');
      }
      const replacement = {
        version: 1,
        status: 'connected',
        accountId: pending.accountId,
        displayName: pending.displayName,
        identity: cleanIdentity(pending.displayName, pending.accountId),
        session: pending.session,
        rotationPending: false,
        retryAt: 0,
        failures: 0,
      };
      if (state.accountId === pending.accountId) {
        for (const key of ['library', 'catalog']) {
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
    // Do not clear the in-memory marker until the durable replacement succeeds; a failed
    // save leaves rotationPending so the old, already-consumed refresh token is never retried.
    await save(replacement);
    Object.assign(state, replacement);
    try {
      const verified = await client.verify(rotated, ctx, state.accountId);
      state.displayName = verified.displayName;
      state.identity = cleanIdentity(verified.displayName, state.accountId);
      state.session = verified;
    } catch (error) {
      if (['reconnect-required', 'account-mismatch'].includes(failureCode(error))) state.status = 'reconnect-required';
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

  async function collectLibrary(state, saved, ctx) {
    const source = normalize.inventory(await client.library(saved, ctx));
    const cached = state.catalog && typeof state.catalog === 'object' && !Array.isArray(state.catalog)
      ? { ...state.catalog } : {};
    const values = new Map();
    for (const item of source.items) {
      const row = cached[item.key];
      if (row?.payload?.schemaVersion === 2) values.set(item.key, row.payload);
    }
    const due = source.items.filter(item => {
      const row = cached[item.key];
      return !row?.payload || row.payload.schemaVersion !== 2 || !Number.isFinite(row.refreshedAt) || now() - row.refreshedAt >= CATALOG_MS;
    });
    let catalogStale = false;
    if (due.length) {
      try {
        const raw = await client.catalog(due, saved, ctx);
        for (const item of due) {
          const entry = normalize.catalogEntry(item, raw.get(item.key));
          values.set(item.key, entry);
          cached[item.key] = { payload: entry, refreshedAt: now() };
        }
      } catch (error) {
        // Reuse cached metadata only when every due item already has it; otherwise the
        // catalog is incomplete and the previous complete snapshot must be retained.
        if (!due.every(item => values.has(item.key))) throw error;
        catalogStale = true;
      }
    }
    let playtimeRaw;
    let playtimeUnavailable = false;
    try { playtimeRaw = await client.playtime(saved, ctx); }
    catch (error) {
      if (state.library?.payload || ['reconnect-required', 'account-mismatch'].includes(failureCode(error))) throw error;
      playtimeRaw = [];
      playtimeUnavailable = true;
    }
    const payload = normalize.library({ inventory: source, catalog: values, playtimeRaw,
      accountId: saved.accountId, catalogStale, playtimeUnavailable });
    const catalog = {};
    for (const item of source.items) {
      const row = cached[item.key];
      if (row) catalog[item.key] = row;
    }
    return { payload, catalog };
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
      if (state.status !== 'connected') return { status: statusFor(state) };
      if (state.retryAt > now()) return { status: librarySnapshot(state).status };
      const due = force || !state.library?.payload || now() >= (state.library.nextRefreshAt || 0);
      if (!due) return { status: librarySnapshot(state).status };
      const ctx = client.context();
      let saved;
      try { saved = await session(state, save, ctx); }
      catch (error) { return { status: await markFailure(state, save, error, ['library']) }; }
      try {
        const { payload, catalog } = await collectLibrary(state, saved, ctx);
        const finished = now();
        state.library = { status: payload.coverage.catalogStale ? 'stale' : 'ready',
          payload, lastSuccessAt: finished, attemptedAt: finished, nextRefreshAt: finished + LIBRARY_MS };
        state.catalog = catalog;
        state.failures = 0;
        state.retryAt = 0;
        await save(state);
        return { status: librarySnapshot(state).status };
      } catch (error) {
        return { status: await markFailure(state, save, error, ['library']) };
      }
    });
  }

  async function identity() {
    const { state: raw, busy } = await store.readSnapshot();
    const state = cleanState(raw);
    if (statusFor(state, busy) !== 'connected') return null;
    return cleanIdentity(state.identity?.displayName ?? state.displayName, state.accountId);
  }

  async function revokeSession(state, save) {
    const ctx = client.context(30_000);
    const current = state.session;
    try {
      await client.revoke(current, ctx);
      return;
    } catch (error) {
      const code = failureCode(error);
      if (code === 'not-found') return; // The session no longer exists upstream.
      if (code !== 'reconnect-required') throw error;
      // A rejected but still-fresh access token cannot be explained by expiry: clear locally.
      if (Number.isFinite(current.accessExpiresAt) && current.accessExpiresAt - now() >= 120_000) return;
    }
    if (!Number.isFinite(current.refreshExpiresAt) || current.refreshExpiresAt <= now()) return;
    if (state.rotationPending) throw new ProviderError('reconnect-required', 'revocation');
    state.rotationPending = true;
    await save(state);
    let next;
    try { next = await client.renew(current, ctx); }
    catch (error) {
      if (['reconnect-required', 'not-found', 'private'].includes(failureCode(error))) return;
      // The refresh may have rotated upstream before the failure: never retry its old token.
      throw error;
    }
    const rotated = { ...next, accountId: state.accountId };
    // Persist the rotated session before revoking with it so a retry uses valid credentials.
    await save({ ...state, session: rotated, rotationPending: false });
    try { await client.revoke(rotated, ctx); }
    catch (error) { if (!['reconnect-required', 'not-found'].includes(failureCode(error))) throw error; }
  }

  async function disconnect() {
    return store.locked(async (raw, save) => {
      const state = cleanState(raw);
      if (state.session) await revokeSession(state, save);
      await save({});
      return { status: 'not-configured' };
    });
  }

  function start() {
    return { url: client.loginUrl() };
  }

  return { start, identify, confirm, refresh, snapshots, identity, disconnect };
}
