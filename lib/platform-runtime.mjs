import { createPlatformStore } from './platform-store.mjs';
import { createPsn } from './providers/psn.mjs';
import { createNintendo } from './providers/nintendo.mjs';
import { createSteamConnection, steamIdPattern, steamKeyPattern } from './steam-connection.mjs';
import { createSyncSettings } from './sync-settings.mjs';

const { DATABASE_URL, PROFILE_ENCRYPTION_KEY, STEAM_ID, STEAM_WEB_API_KEY } = process.env;
const ready = /^postgres(?:ql)?:\/\//.test(DATABASE_URL ?? '') && /^[\x21-\x7e]{32,120}$/.test(PROFILE_ENCRYPTION_KEY ?? '');
const store = ready ? createPlatformStore({ connectionString: DATABASE_URL, encryptionSecret: PROFILE_ENCRYPTION_KEY }) : null;
const fallback = steamIdPattern.test(STEAM_ID ?? '') && steamKeyPattern.test(STEAM_WEB_API_KEY ?? '')
  ? { steamId: STEAM_ID, apiKey: STEAM_WEB_API_KEY } : undefined;

export const platformRuntime = {
  storageStatus: ready ? 'configured' : DATABASE_URL || PROFILE_ENCRYPTION_KEY ? 'invalid-config' : 'not-configured',
  platforms: store ? {
    steam: createSteamConnection({ store: store('steam'), fallback }),
    psn: createPsn({ store: store('psn') }),
    nintendo: createNintendo({ store: store('nintendo') }),
  } : {},
  syncSettings: store ? createSyncSettings({ store: store('sync-settings') }) : undefined,
};
