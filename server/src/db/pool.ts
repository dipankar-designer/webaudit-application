import pg from 'pg';
import { config } from '../config.js';

// Return timestamps as ISO strings and bigint counts as numbers (counts here never exceed 2^53).
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.TIMESTAMPTZ, (v) => new Date(v).toISOString());

// connectionTimeoutMillis: a request that cannot get a connection fails after 10 s instead of
// waiting forever (which would also stall scan heartbeats and make healthy scans look stale).
export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 20, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });

pool.on('error', (err) => {
  console.error('[db] idle client error', err.message);
});

/**
 * Waits for PostgreSQL to accept connections before start-up continues. In development the
 * database starts alongside the API (`npm run dev`), so the first attempts can race it.
 */
export async function waitForDatabase(timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      if (attempt > 1) console.log('[db] connected');
      return;
    } catch (e) {
      if (Date.now() >= deadline) throw e;
      if (attempt === 1) console.log(`[db] waiting for PostgreSQL (${(e as Error).message || 'not reachable'})…`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

export type Queryable = pg.Pool | pg.PoolClient;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = [], db: Queryable = pool): Promise<T[]> {
  const res = await db.query<T>(text, params);
  return res.rows;
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = [], db: Queryable = pool): Promise<T | null> {
  const rows = await query<T>(text, params, db);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
