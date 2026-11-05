import pg from 'pg';

/** Resets the test database schema before the run; the migrations are applied by the tests' first import. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://wpcg:wpcg_dev_password@127.0.0.1:5433/wpcg_test';
  const c = new pg.Client(url);
  try {
    await c.connect();
  } catch (e) {
    throw new Error(`Cannot reach the test database (${url}). Start it with "npm run db:start". ${(e as Error).message}`);
  }
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
}
