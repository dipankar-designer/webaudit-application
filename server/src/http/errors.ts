import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';

export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'bad_request', message, details);
export const unauthorised = (message = 'Please sign in to continue.') => new AppError(401, 'unauthorised', message);
export const forbidden = (message = 'You do not have access to this.') => new AppError(403, 'forbidden', message);
export const notFound = (what = 'That item') => new AppError(404, 'not_found', `${what} was not found.`);
export const conflict = (message: string) => new AppError(409, 'conflict', message);
export const quotaExceeded = (message: string) => new AppError(402, 'quota_exceeded', message);

export function parse<S extends ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    const first = r.error.issues[0];
    throw badRequest(first ? `${first.path.join('.') || 'input'}: ${first.message}` : 'Invalid input', r.error.issues);
  }
  return r.data;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: { code: 'bad_request', message: 'Invalid input', details: err.issues } });
    return;
  }
  // A malformed id (e.g. /api/websites/abc against a uuid column) is a missing item, not a server fault.
  if ((err as { code?: string })?.code === '22P02') {
    res.status(404).json({ error: { code: 'not_found', message: 'That item was not found.' } });
    return;
  }
  const e = err as { status?: number; statusCode?: number; expose?: boolean; message?: string };
  const status = e?.status ?? e?.statusCode;
  if (status && status >= 400 && status < 500) {
    // Only errors marked public (body-parser: bad JSON, body too large) may show their own text.
    if (e.expose === true) {
      res.status(status).json({ error: { code: 'bad_request', message: e.message } });
      return;
    }
    // A missing file from res.sendFile: its message holds the absolute storage path.
    if (status === 404) {
      res.status(404).json({ error: { code: 'not_found', message: 'That file was not found.' } });
      return;
    }
    // A 4xx from an upstream service (e.g. Stripe rejecting our key) is our fault, not the user's — and
    // passing a 401 through would make the client think the user was signed out.
    console.error('[api] upstream error:', status, e.message?.slice(0, 200));
    res.status(502).json({ error: { code: 'upstream_error', message: 'A connected service rejected the request. Please try again later.' } });
    return;
  }
  // Never echo internal error text to clients; log a short line without request bodies.
  console.error('[api] unhandled error:', err instanceof Error ? err.stack?.split('\n').slice(0, 3).join(' | ') : err);
  res.status(500).json({ error: { code: 'internal', message: 'Something went wrong on our side. Please try again.' } });
}
