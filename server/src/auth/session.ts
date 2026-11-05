import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { PlanId, SessionDTO, UserDTO, WorkspaceDTO } from '@wpcg/shared';
import { config } from '../config.js';
import { one, query } from '../db/pool.js';
import { forbidden, unauthorised } from '../http/errors.js';

export const SESSION_COOKIE = config.isProd ? '__Host-wpcg_session' : 'wpcg_session';

export interface AuthContext {
  sessionId: string;
  csrfToken: string;
  user: UserDTO;
  workspace: WorkspaceDTO;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export async function createSession(res: Response, userId: string, workspaceId: string): Promise<void> {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + config.SESSION_TTL_HOURS * 3600 * 1000);
  await query('INSERT INTO sessions (id, user_id, workspace_id, csrf_token, expires_at) VALUES ($1,$2,$3,$4,$5)', [
    sha256(token),
    userId,
    workspaceId,
    csrf,
    expires.toISOString(),
  ]);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'lax',
    path: '/',
    expires,
  });
}

export async function destroySession(req: Request, res: Response): Promise<void> {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) await query('DELETE FROM sessions WHERE id = $1', [sha256(token)]);
  res.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, secure: config.isProd, sameSite: 'lax' });
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

interface SessionRow {
  session_id: string;
  csrf_token: string;
  expires_at: string;
  last_seen_at: string;
  user_id: string;
  email: string;
  user_name: string;
  user_created_at: string;
  workspace_id: string;
  workspace_name: string;
  plan: PlanId;
  retention_days: number;
  ai_enabled: boolean;
  report_brand_name: string | null;
  role: 'owner' | 'admin' | 'member';
}

/** Loads the session if present; does not reject anonymous requests. */
export async function loadSession(req: Request, _res: Response, next: NextFunction) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token || token.length > 100) return next();
  const row = await one<SessionRow>(
    `SELECT s.id AS session_id, s.csrf_token, s.expires_at, s.last_seen_at,
            u.id AS user_id, u.email, u.name AS user_name, u.created_at AS user_created_at,
            w.id AS workspace_id, w.name AS workspace_name, w.plan, w.retention_days, w.ai_enabled, w.report_brand_name,
            m.role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN workspaces w ON w.id = s.workspace_id
       JOIN memberships m ON m.workspace_id = w.id AND m.user_id = u.id
      WHERE s.id = $1 AND s.expires_at > now()`,
    [sha256(token)],
  );
  if (!row) return next();
  if (Date.now() - Date.parse(row.last_seen_at) > 5 * 60 * 1000) {
    await query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.session_id]);
  }
  req.auth = {
    sessionId: row.session_id,
    csrfToken: row.csrf_token,
    user: { id: row.user_id, email: row.email, name: row.user_name, createdAt: row.user_created_at },
    workspace: {
      id: row.workspace_id,
      name: row.workspace_name,
      plan: row.plan,
      role: row.role,
      retentionDays: row.retention_days,
      aiEnabled: row.ai_enabled,
      reportBrandName: row.report_brand_name,
    },
  };
  next();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Requires a signed-in user and, for state-changing requests, a matching CSRF header. */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) return next(unauthorised());
  if (!SAFE_METHODS.has(req.method)) {
    const sent = String(req.headers['x-csrf-token'] ?? '');
    const a = Buffer.from(sent);
    const b = Buffer.from(req.auth.csrfToken);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return next(forbidden('Your session security token is missing or out of date. Reload the page and try again.'));
  }
  next();
}

export function requireRole(...roles: Array<'owner' | 'admin' | 'member'>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(unauthorised());
    if (!roles.includes(req.auth.workspace.role)) return next(forbidden('Only a workspace owner or admin can do this.'));
    next();
  };
}

/** Rejects cross-site state-changing requests by Origin (defence in depth next to SameSite + CSRF tokens). */
export function originCheck(req: Request, _res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  const allowed = new Set([config.APP_ORIGIN, `${req.protocol}://${req.headers.host}`]);
  if (!allowed.has(origin)) return next(forbidden('Cross-site request blocked.'));
  next();
}

export function sessionDTO(auth: AuthContext): SessionDTO {
  return { user: auth.user, workspace: auth.workspace, csrfToken: auth.csrfToken };
}

export async function purgeExpiredSessions(): Promise<void> {
  await query('DELETE FROM sessions WHERE expires_at < now()');
}
