import { handleSchedule } from '@vercel/schedules';
import { platformRuntime } from '../lib/platform-runtime.mjs';

export const POST = handleSchedule(async ({ name, scheduledAt }) => {
  if (name !== 'profile-hourly' || process.env.VERCEL_ENV !== 'production') return;
  if (!/^[\x21-\x7e]{12,120}$/.test(process.env.PROFILE_PASSWORD ?? '')) return;
  try { await platformRuntime.syncSettings?.run(scheduledAt, platformRuntime.platforms); }
  catch { throw new Error('Scheduled profile sync could not access storage'); }
});
