// Operator tool: assign a plan to the workspace owned by an account.
//   npm run plan:set -- someone@example.com pro
import { PLANS, type PlanId } from '@wpcg/shared';
import { one, pool } from '../db/pool.js';

const [email, plan] = process.argv.slice(2);
if (!email || !plan || !(plan in PLANS)) {
  console.error(`Usage: npm run plan:set -- <email> <${Object.keys(PLANS).join('|')}>`);
  process.exit(1);
}
const row = await one<{ id: string; name: string }>(
  `UPDATE workspaces w SET plan = $2 FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = w.id AND m.role = 'owner' AND u.email = $1 RETURNING w.id, w.name`,
  [email.toLowerCase(), plan as PlanId],
);
console.log(row ? `Workspace "${row.name}" is now on the ${PLANS[plan as PlanId].name} plan.` : 'No workspace owned by that e-mail address.');
await pool.end();
