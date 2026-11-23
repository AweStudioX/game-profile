const names = {
  steam: 'Steam', psn: 'PlayStation', nintendo: 'Nintendo', switch: 'Nintendo Switch',
  'nintendo-switch': 'Nintendo Switch', epic: 'Epic Games', playnite: 'Playnite',
  valorant: 'Valorant', riot: 'Riot', 'multi-platform': 'PC', windows: 'Windows',
  macos: 'macOS', linux: 'Linux', ps4: 'PS4', ps5: 'PS5', 'switch-2': 'Switch 2',
  HAC: 'Nintendo Switch', BEE: 'Nintendo Switch 2', hac: 'Nintendo Switch', bee: 'Nintendo Switch 2',
  xbox: 'Xbox', 'xbox-one': 'Xbox One', 'xbox-series': 'Xbox Series X|S', 'xbox-360': 'Xbox 360',
};
export const label = id => Object.hasOwn(names, id) ? names[id] : String(id).replace(/[-_]/g, ' ');
const list = value => Array.isArray(value) ? value : [];
const metric = value => Number.isFinite(value) && value >= 0 ? value : null;

export function libraryModel(payload) {
  const sources = payload.sources ?? {};
  const providerCounts = Object.create(null);
  const games = list(payload.games).map(game => {
    const copies = list(game.editions).flatMap(edition => list(edition.copies).map(copy => ({ ...copy, edition: edition.name })));
    const providers = new Set();
    const platforms = new Set();
    let lastPlayed = null;
    for (const copy of copies) {
      if (copy.platform && copy.platform !== 'unknown') platforms.add(copy.platform);
      for (const observation of list(copy.observations)) {
        if (observation.provider) providers.add(observation.provider);
        const date = Date.parse(observation.data?.lastPlayedAt);
        if (Number.isFinite(date) && (lastPlayed === null || date > lastPlayed)) lastPlayed = date;
      }
      if (copy.playtime?.selectedFrom) providers.add(copy.playtime.selectedFrom);
    }
    for (const provider of providers) providerCounts[provider] = (providerCounts[provider] || 0) + 1;
    const known = metric(game.playtime?.knownSeconds);
    const seconds = game.playtime?.status === 'known' || known > 0 ? known : null;
    return { ...game, copies, providers: [...providers], platforms: [...platforms], lastPlayed, seconds };
  });
  let knownSeconds = null;
  let incomplete = false;
  for (const game of games) {
    if (game.seconds !== null) knownSeconds = (knownSeconds ?? 0) + game.seconds;
    if (game.seconds === null || game.playtime?.unknownCopyCount > 0) incomplete = true;
  }
  return { sources, providerCounts, games, knownSeconds, incomplete };
}

export function filterGames(games, { provider, search, sort }) {
  const query = search.trim().toLocaleLowerCase();
  return games.filter(game => (!provider || game.providers.includes(provider))
    && game.name.toLocaleLowerCase().includes(query))
    .sort((a, b) => {
      const compare = sort === 'recent' ? (b.lastPlayed ?? -Infinity) - (a.lastPlayed ?? -Infinity)
        : sort === 'title' ? 0 : (b.seconds ?? -1) - (a.seconds ?? -1);
      return compare || a.name.localeCompare(b.name);
    });
}
