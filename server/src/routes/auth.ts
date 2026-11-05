import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import { one, query, tx } from '../db/pool.js';
import { AppError, badRequest, conflict, forbidden, parse, unauthorised } from '../http/errors.js';
import { dummyPasswordHash, hashPassword, verifyPassword } from '../auth/passwords.js';
import { SESSION_COOKIE, createSession, destroySession, loadSession, requireAuth, sessionDTO } from '../auth/session.js';
import { deleteWorkspaceFiles } from '../storage/files.js';

export const authRouter = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.NODE_ENV === 'test' ? 1000 : 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many attempts. Please wait a few minutes and try again.' } },
});

const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(254);
const password = z.string().min(10, 'Use at least 10 characters').max(200);

authRouter.post('/signup', authLimiter, async (req, res) => {
  if (!config.SIGNUPS_ENABLED) throw forbidden('New sign-ups are currently closed.');
  const body = parse(
    z.object({
      name: z.string().trim().min(1, 'Enter your name').max(100),
      email,
      password,
      workspaceName: z.string().trim().max(100).optional(),
      acceptTerms: z.literal(true, { errorMap: () => ({ message: 'You must accept the acceptable-use terms' }) }),
    }),
    req.body,
  );
  const hash = await hashPassword(body.password);
  const alreadyExists = () => conflict('An account with that email already exists. Try signing in.');
  const created = await tx(async (c) => {
    const exists = await one('SELECT 1 FROM users WHERE email = $1', [body.email], c);
    if (exists) throw alreadyExists();
    const user = await one<{ id: string }>('INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3) RETURNING id', [body.email, body.name, hash], c);
    const ws = await one<{ id: string }>('INSERT INTO workspaces (name, retention_days) VALUES ($1, $2) RETURNING id', [
      body.workspaceName || `${body.name.split(' ')[0]}'s workspace`,
      config.DEFAULT_RETENTION_DAYS,
    ], c);
    await query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [ws!.id, user!.id], c);
    return { userId: user!.id, workspaceId: ws!.id };
  }).catch((e) => {
    // Two sign-ups with the same email at once: the second hits the unique index, not the check above.
    if ((e as { code?: string }).code === '23505') throw alreadyExists();
    throw e;
  });
  await createSession(res, created.userId, created.workspaceId);
  res.status(201).json({ ok: true });
});

authRouter.post('/login', authLimiter, async (req, res) => {
  const body = parse(z.object({ email, password: z.string().min(1).max(200) }), req.body);
  const user = await one<{ id: string; password_hash: string }>('SELECT id, password_hash FROM users WHERE email = $1', [body.email]);
  const valid = await verifyPassword(body.password, user?.password_hash ?? (await dummyPasswordHash()));
  if (!user || !valid) throw new AppError(401, 'invalid_credentials', 'That email and password combination is not correct.');
  const membership = await one<{ workspace_id: string }>(
    'SELECT workspace_id FROM memberships WHERE user_id = $1 ORDER BY (role = \'owner\') DESC, created_at LIMIT 1',
    [user.id],
  );
  if (!membership) throw forbidden('Your account is not a member of any workspace.');
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  await createSession(res, user.id, membership.workspace_id);
  res.json({ ok: true });
});

authRouter.post('/logout', loadSession, async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
});

authRouter.get('/me', loadSession, (req, res) => {
  if (!req.auth) throw unauthorised();
  res.json(sessionDTO(req.auth));
});

authRouter.post('/password', loadSession, requireAuth, authLimiter, async (req, res) => {
  const body = parse(z.object({ currentPassword: z.string().min(1).max(200), newPassword: password }), req.body);
  const user = await one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [req.auth!.user.id]);
  if (!user || !(await verifyPassword(body.currentPassword, user.password_hash))) throw badRequest('Your current password is not correct.');
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(body.newPassword), req.auth!.user.id]);
  // Sign out every other session.
  await query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [req.auth!.user.id, req.auth!.sessionId]);
  res.json({ ok: true });
});

/** Permanently deletes the user. Workspaces where they are the only owner are deleted with all scan data. */
authRouter.post('/delete-account', loadSession, requireAuth, authLimiter, async (req, res) => {
  const body = parse(z.object({ password: z.string().min(1).max(200), confirm: z.literal('DELETE') }), req.body);
  const userId = req.auth!.user.id;
  const user = await one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (!user || !(await verifyPassword(body.password, user.password_hash))) throw badRequest('Your password is not correct.');
  const soleOwned = await query<{ workspace_id: string }>(
    `SELECT m.workspace_id FROM memberships m
      WHERE m.user_id = $1 AND m.role = 'owner'
        AND NOT EXISTS (SELECT 1 FROM memberships o WHERE o.workspace_id = m.workspace_id AND o.role = 'owner' AND o.user_id <> $1)`,
    [userId],
  );
  await tx(async (c) => {
    for (const w of soleOwned) await query('DELETE FROM workspaces WHERE id = $1', [w.workspace_id], c);
    await query('DELETE FROM users WHERE id = $1', [userId], c);
  });
  for (const w of soleOwned) await deleteWorkspaceFiles(w.workspace_id);
  res.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, secure: config.isProd, sameSite: 'lax' });
  res.json({ ok: true, deletedWorkspaces: soleOwned.length });
});
