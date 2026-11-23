import errors from '../../shared/providerError.js';

const { ProviderError } = errors;

// Only hosts the Xbox Live services themselves return for title art and gamerpics.
// store-images is the Microsoft Store CDN used by titlehub displayImage/images.
const imageHosts = new Set([
  'images-eds-ssl.xboxlive.com',
  'images-eds.xboxlive.com',
  'image-ssl.xboxlive.com',
  'store-images.s-microsoft.com',
  'titlehub.xboxlive.com',
]);
const avatarHosts = new Set([
  'images-eds-ssl.xboxlive.com',
  'images-eds.xboxlive.com',
  'image-ssl.xboxlive.com',
  'store-images.s-microsoft.com',
]);
const MAX_TEXT = 2_000;
const MAX_GAMES = 4_000;
const MAX_ACHIEVEMENTS = 5_000;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonnegativeInteger = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

function text(value, max = MAX_TEXT) {
  return typeof value === 'string' && value.length <= max ? value : null;
}

function token(value, max = 128) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\s\0/\\?#]/.test(value) ? value : null;
}

function date(value) {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

// Title art is frequently returned as http:// on the Microsoft Store CDN; the same
// resource is served over https, and the public contract requires https.
function safeImage(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2_048) return null;
  let url;
  try { url = new URL(value); }
  catch { return null; }
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:' || !imageHosts.has(url.hostname) || url.username || url.password || url.port || url.hash) return null;
  return url.href;
}

function safeAvatar(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2_048) return null;
  let url;
  try { url = new URL(value); }
  catch { return null; }
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:' || !avatarHosts.has(url.hostname) || url.username || url.password || url.port || url.hash) return null;
  return url.href;
}

function titleId(value) {
  const normalized = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof normalized !== 'string' || !/^\d{1,20}$/.test(normalized) || !Number.isSafeInteger(Number(normalized))) {
    throw new ProviderError('invalid-identifier', 'schema');
  }
  return normalized;
}

function numericText(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d{1,12}$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

function percentage(value) {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 && number <= 100 ? number : null;
}

// device lists appear as ["XboxSeries","XboxOne","PC","Win32","Xbox360","Mobile","Web"].
// Prefer the newest console generation when a title spans several devices.
const devicePlatforms = [
  ['xboxseries', 'xbox-series'],
  ['xboxone', 'xbox-one'],
  ['xbox360', 'xbox-360'],
  ['pc', 'windows'],
  ['win32', 'windows'],
];
function platform(devices) {
  if (!Array.isArray(devices) || devices.length > 16) throw new ProviderError('invalid-game-record', 'library');
  const values = devices.map(device => typeof device === 'string' ? device.toLowerCase() : '');
  for (const [device, name] of devicePlatforms) {
    if (values.includes(device)) return name;
  }
  return 'xbox';
}

function achievementSummary(value) {
  if (!object(value)) return null;
  return {
    currentAchievements: nonnegativeInteger(value.currentAchievements),
    totalAchievements: nonnegativeInteger(value.totalAchievements),
    currentGamerscore: nonnegativeInteger(value.currentGamerscore),
    totalGamerscore: nonnegativeInteger(value.totalGamerscore),
  };
}

function history(raw, expectedXuid) {
  if (!object(raw) || !Array.isArray(raw.titles) || raw.titles.length > MAX_GAMES) {
    throw new ProviderError('invalid-title-history', 'library');
  }
  // The service echoes the caller's XUID; it must be the bound account.
  const echoed = typeof raw.xuid === 'number' ? String(raw.xuid) : raw.xuid;
  if (echoed !== undefined && echoed !== null && (typeof echoed !== 'string' || echoed !== expectedXuid)) {
    throw new ProviderError('account-mismatch', 'identity');
  }
  const seen = new Set();
  const games = [];
  const statsTargets = [];
  const achievementInfo = {};
  const legacyTitles = [];
  for (const record of raw.titles) {
    if (!object(record)) throw new ProviderError('invalid-game-record', 'library');
    // The dashboard is public: never republish titles the owner hid on Xbox.
    if (record.type !== 'Game' || record.titleHistory?.visible === false) continue;
    const id = titleId(record.titleId);
    if (seen.has(id)) throw new ProviderError('duplicate-game', 'library');
    seen.add(id);
    const name = text(record.name, 512);
    if (!name) throw new ProviderError('invalid-game-record', 'library');
    const lastPlayedAt = object(record.titleHistory) ? date(record.titleHistory.lastTimePlayed) : null;
    const scid = token(record.serviceConfigId, 64);
    const summary = achievementSummary(record.achievement);
    const devices = Array.isArray(record.devices) ? record.devices.map(device => typeof device === 'string' ? device.toLowerCase() : '') : [];
    if (devices.includes('xbox360')) legacyTitles.push(id);
    games.push({
      providerGameId: id,
      name,
      platform: platform(record.devices),
      playtimeMinutes: null,
      lastPlayedAt,
      imageUrl: safeImage(record.displayImage) ?? safeImage(Array.isArray(record.images) ? record.images.find(image => object(image))?.url : null),
    });
    statsTargets.push({ titleId: id, scid: scid || null });
    if (summary) achievementInfo[id] = summary;
  }
  games.sort((left, right) => (right.lastPlayedAt || '').localeCompare(left.lastPlayedAt || '') ||
    left.name.localeCompare(right.name) || left.providerGameId.localeCompare(right.providerGameId));
  const playedAt = new Map(games.map(game => [game.providerGameId, game.lastPlayedAt || '']));
  statsTargets.sort((left, right) => (playedAt.get(right.titleId) || '').localeCompare(playedAt.get(left.titleId) || ''));
  return { games, statsTargets, achievementInfo, legacyTitles };
}

// The single-scid endpoint returns statlists at the top level; the batch endpoint
// groups them per title. MinutesPlayed is an integer string when the title
// publishes it. Absent means unknown, not zero.
function playtime(raw) {
  if (!object(raw)) throw new ProviderError('invalid-stat-response', 'playtime');
  const collections = [];
  if (raw.statlistscollection !== undefined) {
    if (!Array.isArray(raw.statlistscollection)) throw new ProviderError('invalid-stat-response', 'playtime');
    collections.push(...raw.statlistscollection);
  }
  if (raw.groups !== undefined) {
    if (!Array.isArray(raw.groups)) throw new ProviderError('invalid-stat-response', 'playtime');
    for (const group of raw.groups.slice(0, 32)) {
      if (!object(group)) throw new ProviderError('invalid-stat-response', 'playtime');
      if (group.statlistscollection === undefined) continue;
      if (!Array.isArray(group.statlistscollection)) throw new ProviderError('invalid-stat-response', 'playtime');
      collections.push(...group.statlistscollection);
    }
  }
  if (raw.statlistscollection === undefined && raw.groups === undefined) {
    throw new ProviderError('invalid-stat-response', 'playtime');
  }
  for (const list of collections.slice(0, 64)) {
    if (!object(list) || !Array.isArray(list.stats)) continue;
    for (const stat of list.stats.slice(0, 64)) {
      if (object(stat) && stat.name === 'MinutesPlayed') return numericText(stat.value);
    }
  }
  return null;
}

function mergePlaytime(games, fetched, previous) {
  const prior = previous instanceof Map ? previous : new Map();
  return games.map(game => ({
    ...game,
    playtimeMinutes: fetched.has(game.providerGameId) ? fetched.get(game.providerGameId)
      : prior.has(game.providerGameId) ? prior.get(game.providerGameId) : null,
  }));
}

function library(games) {
  const platforms = [
    ...new Set(games.map(game => game.platform).filter(Boolean)),
  ];
  return {
    coverage: { kind: 'played-history', platforms, complete: true, purchaseLibrary: false },
    totals: {
      recordCount: games.length,
      knownRecordPlaytimeMinutes: games.reduce((sum, game) => sum + (game.playtimeMinutes ?? 0), 0),
      knownPlaytimeRecords: games.filter(game => game.playtimeMinutes !== null).length,
      unknownPlaytimeRecords: games.filter(game => game.playtimeMinutes === null).length,
      unknownPlatformRecords: games.filter(game => game.platform === 'xbox').length,
    },
    games,
  };
}

function profile(raw, expectedXuid) {
  if (!object(raw) || !Array.isArray(raw.profileUsers) || raw.profileUsers.length !== 1) {
    throw new ProviderError('invalid-profile', 'identity');
  }
  const user = raw.profileUsers[0];
  if (!object(user) || (typeof user.id === 'number' ? String(user.id) : user.id) !== expectedXuid || !Array.isArray(user.settings)) {
    throw new ProviderError('account-mismatch', 'identity');
  }
  const settings = new Map();
  for (const setting of user.settings.slice(0, 64)) {
    if (object(setting) && typeof setting.id === 'string' && typeof setting.value === 'string') settings.set(setting.id, setting.value);
  }
  const gamertag = text(settings.get('Gamertag') ?? settings.get('ModernGamertag'), 64);
  if (!gamertag || /[\u0000-\u001f\u007f]/.test(gamertag)) throw new ProviderError('invalid-profile', 'identity');
  return { gamertag, avatarUrl: safeAvatar(settings.get('GameDisplayPicRaw')), gamerscore: numericText(settings.get('Gamerscore')) };
}

function identity(gamertag, avatarUrl) {
  const name = text(gamertag, 64);
  if (!name || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return { id: name, displayName: name, avatarUrl: safeAvatar(avatarUrl) };
}

function storedIdentity(value) {
  if (!object(value)) return null;
  const name = text(value.displayName ?? value.id, 64);
  if (!name || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return { id: name, displayName: name, avatarUrl: safeAvatar(value.avatarUrl) };
}

function page(raw, stage) {
  if (!object(raw) || !Array.isArray(raw.achievements) || !object(raw.pagingInfo)) {
    throw new ProviderError('invalid-achievement-page', stage);
  }
  const total = raw.pagingInfo.totalItems ?? raw.pagingInfo.totalRecords ?? null;
  if (total !== null && (!Number.isSafeInteger(total) || total < 0 || total > MAX_ACHIEVEMENTS)) {
    throw new ProviderError('invalid-achievement-page', stage);
  }
  const next = raw.pagingInfo.continuationToken;
  if (!Object.hasOwn(raw.pagingInfo, 'continuationToken') || (next !== null && (typeof next !== 'string' || next.length < 1 || next.length > 4_096))) {
    throw new ProviderError('invalid-achievement-page', stage);
  }
  return { records: raw.achievements, total, next: next ?? null };
}

function reward(record) {
  if (!Array.isArray(record.rewards)) return null;
  for (const row of record.rewards.slice(0, 16)) {
    if (object(row) && row.type === 'Gamerscore') return nonnegativeInteger(numericText(row.value));
  }
  return null;
}

function icon(record) {
  if (!Array.isArray(record.mediaAssets)) return null;
  for (const asset of record.mediaAssets.slice(0, 16)) {
    if (object(asset) && typeof asset.type === 'string' && asset.type.toLowerCase() === 'icon') {
      const url = safeImage(asset.url);
      if (url) return url;
    }
  }
  return null;
}

// progressState is the only documented achievement state source. Anything outside
// the documented enumeration stays unknown (null) rather than being reported locked.
function unlockedState(record) {
  if (record.progressState === 'Achieved') return true;
  if (record.progressState === 'InProgress' || record.progressState === 'NotStarted') return false;
  return null;
}

function modernAchievement(record, seen) {
  if (!object(record)) throw new ProviderError('invalid-achievement', 'details');
  const id = typeof record.id === 'number' && Number.isSafeInteger(record.id) ? String(record.id) : token(record.id, 128);
  if (!id || seen.has(id)) throw new ProviderError('invalid-achievement', 'details');
  seen.add(id);
  const name = text(record.name, 512);
  if (!name) throw new ProviderError('invalid-achievement', 'details');
  const unlocked = unlockedState(record);
  const unlockedAt = unlocked === true ? date(record.progression?.timeUnlocked) : null;
  const rarity = object(record.rarity) ? percentage(record.rarity.currentPercentage) : null;
  return {
    id,
    name,
    description: text(unlocked === true ? record.description : record.lockedDescription ?? record.description, MAX_TEXT),
    unlocked,
    unlockedAt,
    iconUrl: icon(record),
    rarityPercent: rarity,
    gamerscore: reward(record),
    hidden: record.isSecret === true,
  };
}

function legacyAchievement(record, seen) {
  if (!object(record)) throw new ProviderError('invalid-achievement', 'details');
  const id = Number.isSafeInteger(record.id) && record.id >= 0 ? String(record.id) : token(record.id, 128);
  if (!id || seen.has(id)) throw new ProviderError('invalid-achievement', 'details');
  seen.add(id);
  const name = text(record.name, 512);
  if (!name) throw new ProviderError('invalid-achievement', 'details');
  const unlocked = typeof record.unlocked === 'boolean' ? record.unlocked : null;
  return {
    id,
    name,
    description: text(unlocked === true ? record.description : record.lockedDescription ?? record.description, MAX_TEXT),
    unlocked,
    unlockedAt: unlocked === true ? date(record.timeUnlocked) : null,
    // The Xbox 360 achievement payload exposes only imageId; there is no documented
    // icon URL, so none is fabricated.
    iconUrl: null,
    rarityPercent: null,
    gamerscore: nonnegativeInteger(record.gamerscore),
    hidden: record.isSecret === true,
  };
}

function achievements(records, { legacy = false } = {}) {
  if (!Array.isArray(records) || records.length > MAX_ACHIEVEMENTS) throw new ProviderError('invalid-achievement-page', 'details');
  const seen = new Set();
  const map = legacy ? legacyAchievement : modernAchievement;
  return records.map(record => map(record, seen));
}

function parseCallback(callback) {
  if (typeof callback !== 'string' || callback.length < 1 || callback.length > 8_192 || callback !== callback.trim()) {
    throw new ProviderError('invalid-callback', 'connection');
  }
  let url;
  try { url = new URL(callback); }
  catch { throw new ProviderError('invalid-callback', 'connection'); }
  return url;
}

const normalize = {
  titleId, history, playtime, mergePlaytime, library, profile, identity, storedIdentity,
  page, achievements, parseCallback,
};

export default normalize;
export {
  titleId, history, playtime, mergePlaytime, library, profile, identity, storedIdentity,
  page, achievements, parseCallback,
};
