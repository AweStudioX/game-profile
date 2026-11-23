import errors from '../src/shared/providerError.js';

const { ProviderError } = errors;
const actions = {
  steam: { configure: ['steamId', 'apiKey'], refresh: null },
  profile: { schedule: ['cadence'], visibility: ['platform', 'visible'] },
  psn: { identify: ['npsso'], confirm: ['confirmationId'], refresh: null, disconnect: null },
  nintendo: { start: null, confirm: ['callback'], refresh: null, disconnect: null },
  xbox: { start: null, confirm: ['callback'], refresh: null, disconnect: null },
  epic: { start: null, identify: ['authorizationCode'], confirm: ['confirmationId'], refresh: null, disconnect: null },
};
const json = (body, status = 200) => Response.json(body, { status, headers: {
  'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff',
} });

async function input(request) {
  const limit = 12 * 1024;
  if (Number(request.headers.get('content-length')) > limit || !request.body) throw new Error('invalid-request');
  const reader = request.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('invalid-request'); }
      chunks.push(value);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-request');
    return value;
  } finally { reader.releaseLock(); }
}

export async function platformSnapshots(platforms, { live = false } = {}) {
  return Object.fromEntries(await Promise.all(Object.entries(platforms).map(async ([name, provider]) => {
    if (live && name === 'psn') {
      try { await provider.refresh({ presenceOnly: true }); } catch { /* Preserve the last observed snapshot. */ }
    }
    try {
      const snapshot = await provider.snapshots();
      const library = snapshot.library;
      return [name, { ...snapshot, library: { ...library, lastSuccessAt: library.lastSuccessAt ?? library.latest,
        stale: library.status === 'stale' } }];
    }
    catch { return [name, { library: { status: 'unavailable' } }]; }
  })));
}

export async function readIdentities(platforms, visibility) {
  const entries = await Promise.all(['steam', 'psn', 'nintendo', 'xbox', 'epic'].map(async platform => {
    if (visibility && visibility[platform] !== true) return null;
    try {
      const identity = await platforms[platform]?.identity?.();
      if (!identity || (!identity.id && !identity.displayName)) return null;
      return [platform, { id: identity.id ?? null, displayName: identity.displayName ?? null, avatarUrl: identity.avatarUrl ?? null }];
    } catch { return null; }
  }));
  return Object.fromEntries(entries.filter(Boolean));
}

export async function platformRoutes(request, resource, platforms, storageStatus, syncSettings) {
  if (resource === 'platforms') {
    const snapshots = await platformSnapshots(platforms);
    const sources = Object.fromEntries(Object.entries(snapshots).map(([name, { library }]) => [name, {
      status: library.status, lastSuccessAt: library.lastSuccessAt ?? null,
    }]));
    let sync;
    try { sync = await syncSettings?.status(); } catch { /* Existing sources still render during storage failures. */ }
    const identities = await readIdentities(platforms);
    const identityVisibility = sync?.identityVisibility ?? { steam: false, psn: false, nintendo: false, xbox: false, epic: false };
    return json({ storage: storageStatus, sources, identities, identityVisibility, ...(sync && { sync }) });
  }
  if (request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'origin-mismatch' }, 403);
  if ((request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    return json({ error: 'unsupported-content-type' }, 415);
  }
  let body;
  try { body = await input(request); }
  catch { return json({ error: 'invalid-request' }, 400); }
  const { provider, action } = body;
  if (!Object.hasOwn(actions, provider) || !Object.hasOwn(actions[provider], action)) return json({ error: 'invalid-action' }, 400);
  const adapter = provider === 'profile' ? syncSettings : platforms[provider];
  if (!adapter) return json({ error: 'storage-not-configured' }, 503);
  const fields = actions[provider][action];
  const argument = fields ? Object.fromEntries(fields.map(field => [field, body[field]]))
    : action === 'refresh' ? { force: true } : undefined;
  if (provider === 'psn' && action === 'identify' && typeof argument.npsso === 'string' && argument.npsso.startsWith('{')) {
    try { argument.npsso = JSON.parse(argument.npsso)?.npsso; } catch { return json({ error: 'invalid-npsso-format' }, 422); }
  }
  try {
    const result = await adapter[action === 'schedule' ? 'configure' : action](argument);
    if (['psn', 'xbox', 'epic'].includes(provider) && action === 'confirm') {
      try { return json(await adapter.refresh()); } catch { /* The connection is already persisted. */ }
    }
    return json(result);
  }
  catch (error) {
    const code = error instanceof ProviderError && /^[a-z0-9-]{1,80}$/.test(error.code) ? error.code : 'platform-unavailable';
    return json({ error: code }, code === 'sync-busy' ? 409 : code === 'platform-unavailable' ? 503 : 422);
  }
}
