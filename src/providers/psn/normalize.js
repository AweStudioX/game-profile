const { ProviderError } = require('../../shared/providerError');

const imageHosts = new Set(['image.api.playstation.com', 'image.api.np.km.playstation.net', 'psnobj.prod.dl.playstation.net']);
const grades = ['bronze', 'silver', 'gold', 'platinum'];
const text = (value, max = 500) => typeof value === 'string' && value.length <= max ? value : null;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{3,64}$/.test(value)) throw new ProviderError('invalid-identifier', 'schema');
  return value;
}
function accountId(value) {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) throw new ProviderError('invalid-account-id', 'identity');
  return value;
}
function date(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null; }
function artwork(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && imageHosts.has(url.hostname) && !url.username && !url.password && !url.port && !url.search && !url.hash ? url.href : null;
  } catch { return null; }
}
function mediaImages(...values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    if (!object(value) || !Array.isArray(value.images)) continue;
    for (const row of value.images) {
      if (!object(row)) continue;
      const type = text(row.type, 128);
      const format = text(row.format, 128);
      const url = artwork(row.url);
      if (!type || !url) continue;
      const key = `${type}\0${format || ''}\0${url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push({ type, format, url });
    }
  }
  return output;
}
function durationMinutes(value) {
  if (typeof value !== 'string') return null;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!match || !match.slice(1).some(part => part !== undefined) || value.endsWith('T')) return null;
  const seconds = Number(match[1] || 0) * 86_400 + Number(match[2] || 0) * 3_600 + Number(match[3] || 0) * 60 + Number(match[4] || 0);
  return Number.isFinite(seconds) && seconds <= Number.MAX_SAFE_INTEGER ? seconds / 60 : null;
}
function counts(value) { return Object.fromEntries(grades.map(grade => [grade, integer(value?.[grade])])); }

function library(records) {
  const seen = new Set();
  const games = records.map(record => {
    const id = identifier(record.titleId);
    if (seen.has(id) || !text(record.name) || !['ps4_game', 'ps5_native_game', 'unknown'].includes(record.category)) {
      throw new ProviderError('invalid-game-record', 'library');
    }
    seen.add(id);
    const rawConceptId = typeof record.concept?.id === 'string' || Number.isSafeInteger(record.concept?.id) ? String(record.concept.id) : null;
    return {
      providerGameId: id,
      conceptId: rawConceptId && /^\d+$/.test(rawConceptId) ? rawConceptId : null,
      canonicalGameId: null,
      name: record.name,
      platform: record.category === 'ps4_game' ? 'PS4' : record.category === 'ps5_native_game' ? 'PS5' : null,
      playtimeMinutes: durationMinutes(record.playDuration),
      playCount: integer(record.playCount),
      firstPlayedAt: date(record.firstPlayedDateTime),
      lastPlayedAt: date(record.lastPlayedDateTime),
      activityStatus: 'played-history',
      artwork: {
        url: artwork(record.imageUrl), localizedUrl: artwork(record.localizedImageUrl), width: null, height: null,
        images: mediaImages(record.media, record.concept?.media),
      },
    };
  });
  games.sort((left, right) => (right.playtimeMinutes ?? -1) - (left.playtimeMinutes ?? -1) || left.providerGameId.localeCompare(right.providerGameId));
  return {
    coverage: { kind: 'played-history', platforms: ['PS4', 'PS5'], complete: true, purchaseLibrary: false },
    totals: {
      recordCount: games.length,
      conceptCount: new Set(games.map(game => game.conceptId).filter(Boolean)).size,
      knownRecordPlaytimeMinutes: games.reduce((sum, game) => sum + (game.playtimeMinutes ?? 0), 0),
      knownPlaytimeRecords: games.filter(game => game.playtimeMinutes !== null).length,
      unknownPlaytimeRecords: games.filter(game => game.playtimeMinutes === null).length,
      unknownPlatformRecords: games.filter(game => game.platform === null).length,
    },
    games,
  };
}

function percentage(value) {
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const number = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 && number <= 100 ? number : null;
}
function trophyLists(records) {
  const seen = new Set();
  return records.filter(record => record.hiddenFlag !== true).map(record => {
    if (record.hiddenFlag !== false || !['trophy', 'trophy2'].includes(record.npServiceName)) throw new ProviderError('invalid-trophy-list', 'schema');
    const id = identifier(record.npCommunicationId);
    const key = `${record.npServiceName}:${id}`;
    if (seen.has(key)) throw new ProviderError('duplicate-trophy-set', 'schema');
    seen.add(key);
    return {
      id, service: record.npServiceName, name: text(record.trophyTitleName), platform: text(record.trophyTitlePlatform, 100),
      imageUrl: artwork(record.trophyTitleIconUrl), progress: percentage(record.progress), defined: counts(record.definedTrophies), earned: counts(record.earnedTrophies),
    };
  });
}
function summarySnapshot(raw, visible) {
  if (!object(raw)) throw new ProviderError('invalid-summary', 'schema');
  const level = typeof raw.trophyLevel === 'string' && /^\d+$/.test(raw.trophyLevel) ? Number(raw.trophyLevel) : raw.trophyLevel;
  return { trophyLevel: integer(level), earnedTrophies: counts(raw.earnedTrophies), visibleTrophySets: visible.length, totalsMayIncludeHiddenTitles: true };
}
function presence(raw) {
  const value = raw?.basicPresence;
  if (!object(value)) throw new ProviderError('invalid-presence', 'schema');
  const online = value.primaryPlatformInfo?.onlineStatus ?? value.onlineStatus;
  const platform = text(value.primaryPlatformInfo?.platform, 32);
  if (online === 'offline') return { activity: 'idle', online: false, platform, games: [] };
  if (online !== 'online') return { activity: 'unavailable', online: null, platform: null, games: [] };
  if (value.gameTitleInfoList !== undefined && !Array.isArray(value.gameTitleInfoList)) throw new ProviderError('invalid-presence-games', 'schema');
  const games = (value.gameTitleInfoList || []).slice(0, 10).map(game => ({
    providerGameId: identifier(game.npTitleId), name: text(game.titleName), platform: text(game.format, 32),
    imageUrl: artwork(game.npTitleIconUrl || game.conceptIconUrl),
  }));
  return { activity: games.length ? 'playing' : 'idle', online: true, platform, games };
}
function mappedSets(response, titleId, visible) {
  if (!Array.isArray(response?.titles)) throw new ProviderError('invalid-title-mapping', 'schema');
  const matches = response.titles.filter(title => title.npTitleId === titleId);
  if (matches.length > 1) throw new ProviderError('ambiguous-title-mapping', 'schema');
  if (!matches.length) return [];
  if (!Array.isArray(matches[0].trophyTitles)) throw new ProviderError('invalid-title-mapping', 'schema');
  const ids = new Set(matches[0].trophyTitles.map(title => identifier(title.npCommunicationId)));
  return visible.filter(set => ids.has(set.id));
}
function trophies(definitions, player) {
  const rows = new Map();
  for (const record of player) {
    if (integer(record.trophyId) === null || rows.has(record.trophyId)) throw new ProviderError('invalid-player-trophy-id', 'schema');
    rows.set(record.trophyId, record);
  }
  const seen = new Set();
  const result = definitions.map(definition => {
    if (integer(definition.trophyId) === null || seen.has(definition.trophyId) || !grades.includes(definition.trophyType) || typeof definition.trophyHidden !== 'boolean') {
      throw new ProviderError('invalid-trophy-definition', 'schema');
    }
    seen.add(definition.trophyId);
    const playerRow = rows.get(definition.trophyId);
    const earned = typeof playerRow?.earned === 'boolean' ? playerRow.earned : null;
    const concealed = definition.trophyHidden && earned !== true;
    return {
      id: definition.trophyId, grade: definition.trophyType, hidden: definition.trophyHidden, earned,
      name: concealed ? 'Hidden trophy' : text(definition.trophyName), description: concealed ? null : text(definition.trophyDetail, 2_000),
      imageUrl: concealed ? null : artwork(definition.trophyIconUrl), earnedAt: earned === true ? date(playerRow.earnedDateTime) : null,
      earnedRate: percentage(playerRow?.trophyEarnedRate),
    };
  });
  const knownRarity = result.filter(trophy => trophy.earned === true && trophy.earnedRate !== null).sort((left, right) => left.earnedRate - right.earnedRate);
  return {
    complete: result.every(trophy => trophy.earned !== null), trophies: result, rarestUnlock: knownRarity[0] || null,
    rarityCoverage: { earned: result.filter(trophy => trophy.earned === true).length, earnedWithKnownRarity: knownRarity.length },
  };
}

module.exports = {
  object, text, nonnegative, integer, identifier, accountId, date, artwork, mediaImages, durationMinutes,
  library, trophyLists, summary: summarySnapshot, presence, mappedSets, trophies,
};
