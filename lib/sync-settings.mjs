import errors from '../src/shared/providerError.js';

const { ProviderError } = errors;
const hour = 3_600_000;

export function createSyncSettings({ store, now = Date.now }) {
  return {
    async status() {
      const state = await store.read();
      return { cadence: state.cadence ?? 'daily', lastScheduledAt: state.lastScheduledAt ?? null };
    },
    async configure({ cadence }) {
      if (cadence !== 'daily' && cadence !== 'hourly') throw new ProviderError('invalid-cadence', 'configuration');
      return store.locked(async (state, save) => {
        await save({ ...state, cadence });
        return { status: 'saved', cadence };
      });
    },
    async run(scheduledAt, providers) {
      const instant = scheduledAt.getTime();
      if (!Number.isFinite(instant) || now() - instant > hour || instant > now() + 60_000) return;
      await store.locked(async (state, save) => {
        if (instant <= (state.lastSlot ?? 0)) return;
        if ((state.cadence ?? 'daily') === 'daily' && scheduledAt.getUTCHours() !== 2) return;
        await save({ ...state, lastSlot: instant, lastScheduledAt: scheduledAt.toISOString() });
        await Promise.allSettled(Object.values(providers).map(provider => provider.refresh({ force: true })));
      });
    },
  };
}
