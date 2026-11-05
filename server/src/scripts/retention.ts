// Run data-retention deletion once (the API also runs it hourly).
import { pool } from '../db/pool.js';
import { applyRetention } from '../services/retention.js';

const r = await applyRetention();
console.log(`Deleted ${r.scans} expired scan(s) and ${r.issues} stale issue(s).`);
await pool.end();
