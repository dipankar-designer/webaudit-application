import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { Router } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { config } from './config.js';
import { errorHandler, notFound } from './http/errors.js';
import { loadSession, originCheck, requireAuth } from './auth/session.js';
import { authRouter } from './routes/auth.js';
import { websitesRouter } from './routes/websites.js';
import { scansRouter } from './routes/scans.js';
import { issuesRouter } from './routes/issues.js';
import { reportsRouter } from './routes/reports.js';
import { aiRouter } from './routes/ai.js';
import { baselinesRouter, filesRouter, healthRouter, overviewRouter, workspaceRouter } from './routes/misc.js';
import { billingRouter, stripeWebhook } from './routes/billing.js';
import { alertsRouter, heartbeatRouter, incidentsRouter, monitorsRouter } from './routes/monitors.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.TRUST_PROXY) app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          styleSrc: ["'self'", "'unsafe-inline'"],
          fontSrc: ["'self'", 'data:'],
          scriptSrc: ["'self'"],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  // Stripe signs the raw body, so its webhook is mounted before the JSON parser.
  app.post('/api/billing/webhook', express.raw({ type: 'application/json', limit: '1mb' }), stripeWebhook);
  app.use(express.json({ limit: '200kb' }));

  const api = Router();
  api.use(
    rateLimit({
      windowMs: 60_000,
      limit: config.NODE_ENV === 'test' ? 100_000 : 600,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: { code: 'rate_limited', message: 'Too many requests. Please slow down.' } },
    }),
  );
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  api.use(originCheck);
  api.use('/health', healthRouter);
  api.use('/auth', authRouter);
  api.use('/heartbeat', heartbeatRouter);

  const authed = Router();
  authed.use(loadSession, requireAuth);
  authed.use('/overview', overviewRouter);
  authed.use('/websites', websitesRouter);
  authed.use('/scans', scansRouter);
  authed.use('/issues', issuesRouter);
  authed.use('/reports', reportsRouter);
  authed.use('/baselines', baselinesRouter);
  authed.use('/files', filesRouter);
  authed.use('/workspace', workspaceRouter);
  authed.use('/billing', billingRouter);
  authed.use('/monitors', monitorsRouter);
  authed.use('/incidents', incidentsRouter);
  authed.use('/alerts', alertsRouter);
  authed.use('/ai', aiRouter);
  api.use(authed);
  api.use((_req, _res, next) => next(notFound('That API endpoint')));
  api.use(errorHandler);
  app.use('/api', api);

  // Production: serve the built web client from the same origin.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const clientDist = [path.resolve(here, '../../client/dist'), path.resolve(here, '../client/dist')].find((p) => fs.existsSync(path.join(p, 'index.html')));
  if (clientDist) {
    app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
  }
  return app;
}
