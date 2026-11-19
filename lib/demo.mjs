const lastSuccessAt = '2026-01-01T00:00:00.000Z';
const ready = fields => ({ status: 'ready', lastSuccessAt, ...fields });
const game = (providerGameId, name, playtimeMinutes, platform) => ({ providerGameId, name, playtimeMinutes, platform });
const steam = [game('100', 'Starlight Courier', 732), game('101', 'Quiet Orbit', 315)];
const psn = [game('PPSA00001_00', 'Starlight Courier', 140, 'PS5'), game('CUSA00001_00', 'Lantern Isles', 282, 'PS4')];
const nintendo = [{ ...game('demo-switch', 'Starlight Courier', 96, 'HAC'), titleId: '0100000000000100' },
  { ...game('demo-switch-2', 'Paper Orchard', 480, 'HAC'), titleId: '0100000000000200' }];

export const demo = {
  steamService: {
    read: resource => ready(resource === 'library' ? { games: steam } : { currentGame: steam[0] }),
    game: () => ({ httpStatus: 200, body: { achievementStatus: 'available', achievements: [
      { apiName: 'FIRST', name: 'First delivery', description: 'Finish your first delivery.', achieved: true, globalPercent: 72 },
      { apiName: 'ORBIT', name: 'Around the moon', achieved: false, globalPercent: 28 },
    ] } }),
  },
  psnService: {
    read: resource => ready(resource === 'library' ? { games: psn } : { activity: 'idle' }),
    game: () => ({ httpStatus: 200, body: { trophyStatus: 'available', trophySets: [
      { id: 'demo', service: 'trophy', name: 'Base game', trophies: [
        { id: 1, name: 'Welcome aboard', grade: 'bronze', earned: true, earnedRate: 68 },
        { id: 2, name: 'Touch the stars', grade: 'gold', earned: false, earnedRate: 12 },
      ] },
    ] } }),
  },
  nintendoService: { read: () => ready({ games: nintendo }) },
};
