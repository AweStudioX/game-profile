import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProfile } from '../lib/profile.mjs';
import { createSyncSettings } from '../lib/sync-settings.mjs';
import aggregate from '../src/providers/aggregate/service.js';
import { libraryModel, filterGames } from '../public/dashboard/model.mjs';
import { providerGameId } from '../src/providers/epic/normalize.mjs';

const { createAggregateService } = aggregate;
const origin = 'https://profile.example';
const env = { PROFILE_PASSWORD: 'test-password-2026' };
const authorization = `Basic ${Buffer.from(`owner:${env.PROFILE_PASSWORD}`).toString('base64')}`;
const stamp = '2026-11-23T08:00:00.000Z';
const xboxGames = [
  { providerGameId: '42', name: 'Shared Adventure', platform: 'xbox-one', playtimeMinutes: 90, imageUrl: null },
  { providerGameId: '43', name: 'Unknown Time', platform: 'xbox', playtimeMinutes: null, imageUrl: null },
];
const epicGames = [
  { providerGameId: providerGameId('epic-namespace', 'copy'), name: 'Shared Adventure', playtimeMinutes: 0, playtimeStatus: 'known', lastPlayedAt: null },
  { providerGameId: providerGameId('epic-namespace', 'new'), name: 'Unplayed Claim', playtimeMinutes: null, playtimeStatus: 'unknown', lastPlayedAt: null },
];
const snapshot = games => ({ status: 'ready', lastSuccessAt: stamp, games });
const xboxDetail = { httpStatus: 200, body: { achievementStatus: 'available', achievements: [
  { id: '1', name: 'First Step', unlocked: true, unlockedAt: stamp, gamerscore: 10, rarityPercent: 32 },
  { id: '2', name: 'Finish', unlocked: false, unlockedAt: null, gamerscore: 50, rarityPercent: null },
] } };

function setup() {
  let state = {};
  const syncSettings = createSyncSettings({ store: {
    read: async () => structuredClone(state),
    locked: action => action(structuredClone(state), async value => { state = structuredClone(value); }),
  } });
  const identities = {
    xbox: { id: 'SampleTag', displayName: 'SampleTag', avatarUrl: null },
    epic: { id: null, displayName: 'EpicPlayer', avatarUrl: null },
  };
  let reads = 0;
  const platforms = {
    steam: { snapshots: async () => ({ library: { status: 'not-configured' } }), credentials: async () => null },
    xbox: { snapshots: async () => ({ library: snapshot(xboxGames) }), identity: async () => identities.xbox,
      detail: async id => { reads++; assert.equal(id, '42'); return xboxDetail; },
      start: async () => ({ url: 'https://login.live.com/oauth20_authorize.srf?state=example' }),
    },
    epic: { snapshots: async () => ({ library: snapshot(epicGames) }), identity: async () => identities.epic,
      start: async () => ({ url: 'https://www.epicgames.com/id/login' }),
    },
  };
  const handle = createProfile({ env, platforms, syncSettings });
  const get = resource => handle(new Request(`${origin}/api/profile?resource=${encodeURIComponent(resource)}`));
  const action = (body, headers = { Authorization: authorization, Origin: origin }) => handle(new Request(`${origin}/api/profile?resource=platform-action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  }));
  return { get, action, identities, readCount: () => reads };
}

test('Xbox and Epic retain independent playtime and Xbox achievement sets in public game detail', async () => {
  const { get, readCount } = setup();
  const library = await (await get('library')).json();
  assert.equal(library.sources.xbox.status, 'ready');
  assert.equal(library.sources.epic.status, 'ready');
  const model = libraryModel(library);
  assert.equal(filterGames(model.games, { provider: 'xbox', search: '', sort: 'title' }).length, 2);
  assert.equal(filterGames(model.games, { provider: 'epic', search: '', sort: 'title' }).length, 2);
  const shared = model.games.find(game => game.name === 'Shared Adventure');
  assert.deepEqual(new Set(shared.providers), new Set(['xbox', 'epic']));
  assert.equal(shared.seconds, 5400);
  assert.equal(model.games.find(game => game.name === 'Unknown Time').seconds, null);
  const response = await get(`games/${shared.id}`);
  assert.equal(response.status, 200);
  const detail = await response.json();
  const set = detail.progress.sets.find(set => set.source === 'xbox');
  assert.equal(set.summary.earned, 1);
  assert.equal(set.summary.available, 2);
  assert.equal(set.unlocks[0].gamerscore, 10);
  assert.equal(set.unlocks[1].unlocked, false);
  assert.equal(detail.progress.sources.find(source => source.source === 'epic').status, 'unsupported');
  assert.equal(readCount(), 1);
  assert.equal((await get('games/xbox-9999')).status, 404);
  assert.equal(readCount(), 1, 'Unknown title must not cause an upstream achievement read');
  const epicOnly = model.games.find(game => game.name === 'Unplayed Claim');
  const epicResponse = await get(`games/${epicOnly.id}`);
  assert.equal(epicResponse.status, 200);
  assert.equal((await epicResponse.json()).progress.sources[0].status, 'unsupported');
});

test('new platform identity disclosures require owner consent and remain off independently', async () => {
  const { get, action, identities } = setup();
  assert.deepEqual(await (await get('identities')).json(), { identities: {} });
  for (const platform of ['xbox', 'epic']) {
    const body = { provider: 'profile', action: 'visibility', platform, visible: true };
    assert.equal((await action(body, { Origin: origin })).status, 401);
    assert.equal((await action(body, { Authorization: authorization, Origin: 'https://foreign.example' })).status, 403);
    assert.equal((await action(body)).status, 200);
    assert.deepEqual(await (await get('identities')).json(), { identities: { [platform]: identities[platform] } });
    assert.equal((await action({ ...body, visible: false })).status, 200);
  }
});

test('Xbox and Epic connection starts remain authenticated and origin-bound', async () => {
  const { action } = setup();
  for (const provider of ['xbox', 'epic']) {
    const body = { provider, action: 'start' };
    assert.equal((await action(body, { Origin: origin })).status, 401);
    assert.equal((await action(body, { Authorization: authorization, Origin: 'https://foreign.example' })).status, 403);
    const response = await action(body);
    assert.equal(response.status, 200);
    assert.equal(new URL((await response.json()).url).protocol, 'https:');
  }
});

test('Epic-only and Xbox-only snapshots preserve unknown time and do not invent current activity', () => {
  for (const [key, games] of [['xboxService', xboxGames], ['epicService', epicGames]]) {
    const service = createAggregateService({ registryEntries: [], [key]: { read: () => snapshot(games) } });
    const model = libraryModel(service.library());
    assert.equal(model.games.length, 2);
    assert.equal(model.incomplete, true);
    assert.equal(model.games.find(game => game.name === games[1].name).seconds, null);
    assert.equal(service.nowPlaying().sessions.length, 0);
    assert.equal(service.nowPlaying().state, 'unknown');
  }
});
