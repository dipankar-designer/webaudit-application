import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Load .env from the working directory, then from the repository root (values already set win).
dotenv.config({ quiet: true });
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env'), quiet: true });

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const int = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => {
      const n = v === undefined || v === '' ? fallback : Number.parseInt(v, 10);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, n));
    });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(4100, 1, 65535),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  APP_ORIGIN: z.string().default('http://localhost:5174'),
  TRUST_PROXY: bool(false),
  SESSION_TTL_HOURS: int(24 * 7, 1, 24 * 90),
  STORAGE_DIR: z.string().default('./storage'),

  CHROME_PATH: z.string().optional(),
  RUN_WORKER_IN_PROCESS: bool(false),
  WORKER_CONCURRENCY: int(1, 1, 8),
  SCAN_PAGE_CONCURRENCY: int(2, 1, 6),
  SCAN_HARD_MAX_PAGES: int(1000, 1, 5000),
  SCAN_PAGE_TIMEOUT_MS: int(30000, 5000, 120000),
  SCAN_MAX_DURATION_MS: int(90 * 60 * 1000, 60000, 6 * 60 * 60 * 1000),
  SCAN_MAX_RESPONSE_BYTES: int(5 * 1024 * 1024, 64 * 1024, 50 * 1024 * 1024),
  SCAN_MAX_REDIRECTS: int(5, 0, 10),
  SCAN_MAX_CRAWL_DEPTH: int(3, 0, 10),
  LINK_CHECK_MAX: int(2000, 0, 20000),
  LINK_CHECK_CONCURRENCY: int(4, 1, 16),
  LIGHTHOUSE_MAX_PAGES: int(3, 0, 20),
  /** Lighthouse runs per page and device; the median run (by performance score) is reported. */
  LIGHTHOUSE_RUNS: int(3, 1, 5),
  /**
   * Development/test escape hatch: comma-separated host[:port] values that may be
   * scanned even though they resolve to private addresses (e.g. a local fixture site).
   * Ignored when NODE_ENV=production.
   */
  SCAN_ALLOW_PRIVATE_TARGETS: z.string().default(''),
  SCAN_USER_AGENT: z.string().default('WebAuditAIBot/0.1 (+https://webaudit.example/bot)'),

  DEFAULT_RETENTION_DAYS: int(90, 1, 3650),
  SIGNUPS_ENABLED: bool(true),

  AI_PROVIDER: z.enum(['none', 'anthropic', 'ollama']).default('none'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-opus-5-5'),
  ANTHROPIC_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  OLLAMA_URL: z.string().default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: z.string().default('llama3.2:3b'),
  /** Largest context window requested from Ollama (tokens); prompts are sized to fit up to this. */
  OLLAMA_MAX_CTX: int(16384, 2048, 131072),
  AI_MAX_OUTPUT_TOKENS: int(16000, 256, 64000),
  AI_TIMEOUT_MS: int(90000, 5000, 600000),

  // Scheduled monitoring
  MONITORING_ENABLED: bool(true),
  MONITOR_CONCURRENCY: int(4, 1, 32),
  /** Public base URL used in alert e-mails and heartbeat URLs. Defaults to APP_ORIGIN. */
  APP_PUBLIC_URL: z.string().optional(),

  // E-mail alerts (SMTP). Without SMTP_HOST alerts are recorded in the app as "skipped".
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: int(587, 1, 65535),
  SMTP_SECURE: bool(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  ALERT_FROM: z.string().default('WebAudit AI <alerts@localhost>'),
  /** Development: URL of the local test inbox (scripts/dev-mail.mjs) so the UI labels mail as test-only. */
  SMTP_DEV_INBOX_URL: z.string().url().optional(),

  // Real-user (field) Core Web Vitals from the Chrome UX Report API. A free Google Cloud API key with
  // the "Chrome UX Report API" enabled; kept server-side. Without it the report says field data is not connected.
  CRUX_API_KEY: z.string().optional(),
  /** Override for tests (a local stub); production always uses Google's endpoint. */
  CRUX_API_BASE: z.string().url().default('https://chromeuxreport.googleapis.com/v1'),

  // Stripe billing. Payments stay disabled unless the secret key, webhook secret and prices are set.
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_PRO: z.string().optional(),
  STRIPE_PRICE_AGENCY: z.string().optional(),
});

export type Config = z.infer<typeof schema> & {
  storageDir: string;
  privateTargetAllowlist: Set<string>;
  isProd: boolean;
  aiConfigured: boolean;
  emailConfigured: boolean;
  stripeConfigured: boolean;
  publicUrl: string;
};

function load(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${msg}`);
  }
  const c = parsed.data;
  const isProd = c.NODE_ENV === 'production';
  const allow = new Set(
    isProd
      ? []
      : c.SCAN_ALLOW_PRIVATE_TARGETS.split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
  );
  const aiConfigured =
    (c.AI_PROVIDER === 'anthropic' && !!c.ANTHROPIC_API_KEY) || c.AI_PROVIDER === 'ollama';
  return {
    ...c,
    isProd,
    storageDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..', c.STORAGE_DIR),
    privateTargetAllowlist: allow,
    aiConfigured,
    emailConfigured: !!c.SMTP_HOST,
    stripeConfigured: !!(c.STRIPE_SECRET_KEY && c.STRIPE_WEBHOOK_SECRET && (c.STRIPE_PRICE_PRO || c.STRIPE_PRICE_AGENCY)),
    publicUrl: (c.APP_PUBLIC_URL ?? c.APP_ORIGIN).replace(/\/$/, ''),
  };
}

export const config: Config = load();
