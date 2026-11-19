import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import errors from '../src/shared/providerError.js';

const { ProviderError } = errors;
const leaseSeconds = 90;

export function createPlatformStore({ connectionString, encryptionSecret, pool = new pg.Pool({
  connectionString, max: 2, connectionTimeoutMillis: 5_000, query_timeout: 5_000, allowExitOnIdle: true,
}) }) {
  const key = createHash('sha256').update(encryptionSecret).digest();
  let initialized;
  const init = () => initialized ??= (async () => {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(229193011, 1)');
      await db.query(`CREATE TABLE IF NOT EXISTS game_profile_platform_v1 (
        provider text PRIMARY KEY, payload bytea, lease_id uuid, lease_until timestamptz
      )`);
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { db.release(); }
  })().catch(error => { initialized = undefined; throw error; });

  function seal(provider, data) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(provider));
    const payload = cipher.update(JSON.stringify(data), 'utf8');
    return Buffer.concat([iv, cipher.final(), cipher.getAuthTag(), payload]);
  }
  function unseal(provider, payload) {
    if (!payload) return {};
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12));
      decipher.setAAD(Buffer.from(provider));
      decipher.setAuthTag(payload.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]));
    } catch { throw new ProviderError('credential-integrity-failed', 'storage'); }
  }

  return provider => ({
    async read() {
      await init();
      const { rows } = await pool.query('SELECT payload FROM game_profile_platform_v1 WHERE provider = $1', [provider]);
      return unseal(provider, rows[0]?.payload);
    },
    async locked(action) {
      await init();
      const id = randomUUID();
      const acquired = await pool.query(`INSERT INTO game_profile_platform_v1 AS stored (provider, lease_id, lease_until)
        VALUES ($1, $2, now() + make_interval(secs => $3))
        ON CONFLICT (provider) DO UPDATE SET lease_id = EXCLUDED.lease_id, lease_until = EXCLUDED.lease_until
        WHERE stored.lease_until IS NULL OR stored.lease_until <= now() RETURNING payload`, [provider, id, leaseSeconds]);
      if (!acquired.rowCount) throw new ProviderError('sync-busy', 'storage');
      try {
        return await action(unseal(provider, acquired.rows[0].payload), async data => {
          const result = await pool.query(`UPDATE game_profile_platform_v1 SET payload = $3
            WHERE provider = $1 AND lease_id = $2 AND lease_until > now()`, [provider, id, seal(provider, data)]);
          if (!result.rowCount) throw new ProviderError('sync-lease-expired', 'storage');
        });
      } finally {
        await pool.query(`UPDATE game_profile_platform_v1 SET lease_id = NULL, lease_until = NULL
          WHERE provider = $1 AND lease_id = $2`, [provider, id]).catch(() => {});
      }
    },
  });
}
