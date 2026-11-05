import { Router } from 'express';
import { z } from 'zod';
import { CATEGORY_INFO, SEVERITY_LABELS, type FindingDTO, type LighthouseReportDTO, type ViewportName, type WordPressReportDTO } from '@wpcg/shared';
import { config } from '../config.js';
import { one, query, tx } from '../db/pool.js';
import { AppError, notFound, parse } from '../http/errors.js';
import { AiUnavailableError, generate, scanData } from '../ai/provider.js';
import { buildReport } from '../reports/build.js';
import { performancePrompt } from '../ai/performancePrompt.js';
import { consumeAi } from '../services/quota.js';

export const aiRouter = Router();

function ensureEnabled(aiEnabled: boolean) {
  if (!config.aiConfigured) throw new AppError(503, 'ai_unavailable', 'AI explanations are not configured on this server. All scan results remain available without AI.');
  if (!aiEnabled) throw new AppError(403, 'ai_disabled', 'AI explanations are turned off for this workspace (Settings).');
}

async function run(workspaceId: string, plan: Parameters<typeof consumeAi>[1], prompt: string) {
  // Charge the quota only when a generation is actually attempted.
  await tx((c) => consumeAi(workspaceId, plan, c));
  try {
    return await generate(prompt);
  } catch (e) {
    if (e instanceof AiUnavailableError) throw new AppError(502, 'ai_failed', e.message);
    throw e;
  }
}

aiRouter.get('/status', (req, res) => {
  res.json({
    configured: config.aiConfigured,
    provider: config.aiConfigured ? config.AI_PROVIDER : null,
    model: config.AI_PROVIDER === 'anthropic' ? config.ANTHROPIC_MODEL : config.AI_PROVIDER === 'ollama' ? config.OLLAMA_MODEL : null,
    enabledForWorkspace: req.auth!.workspace.aiEnabled,
  });
});

aiRouter.get('/issues/:id', async (req, res) => {
  const row = await one<{ content: string; provider: string; model: string; created_at: string }>(
    `SELECT a.content, a.provider, a.model, a.created_at FROM ai_outputs a
      WHERE a.issue_id = $1 AND a.workspace_id = $2 AND a.kind = 'issue_explanation' ORDER BY a.created_at DESC LIMIT 1`,
    [req.params.id, req.auth!.workspace.id],
  );
  res.json(row ? { content: row.content, provider: row.provider, model: row.model, createdAt: row.created_at } : null);
});

aiRouter.post('/issues/:id', async (req, res) => {
  const ws = req.auth!.workspace;
  ensureEnabled(ws.aiEnabled);
  if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw notFound('Issue');
  const issue = await one<{ id: string; title: string; severity: keyof typeof SEVERITY_LABELS; category: keyof typeof CATEGORY_INFO; status: string; rule_id: string; wcag: string[]; details: Record<string, unknown>; last_scan_id: string; website: string }>(
    `SELECT i.id, i.title, i.severity, i.category, i.status, i.rule_id, i.wcag, i.details, i.last_scan_id, w.base_url AS website
       FROM issues i JOIN websites w ON w.id = i.website_id WHERE i.id = $1 AND i.workspace_id = $2`,
    [req.params.id, ws.id],
  );
  if (!issue) throw notFound('Issue');
  const findings = await query<{ page_url: string; viewport: string | null; evidence: FindingDTO['evidence'] }>(
    'SELECT page_url, viewport, evidence FROM findings WHERE issue_id = $1 AND scan_id = $2 ORDER BY page_url LIMIT 5',
    [issue.id, issue.last_scan_id],
  );
  const d = issue.details as { description: string; detectionMethod: string; limitations: string | null; remediation: { steps: string[] } };
  const prompt = `Explain this website audit issue to the site owner.

Cover, in this order:
1. What the problem is, in one or two plain sentences.
2. Who it affects and why it matters.
3. The most likely causes, based only on the evidence (say clearly if the evidence is not enough to tell).
4. Step-by-step what to do. Build on the recommended steps provided; adapt them to the evidence where you can.
5. How to confirm it is fixed (mention running a verification scan in WebAudit AI).
6. Anything a developer should check that the automated scan could not.

${scanData({
  website: issue.website,
  issue: {
    title: issue.title,
    severity: SEVERITY_LABELS[issue.severity],
    category: CATEGORY_INFO[issue.category].label,
    status: issue.status,
    rule: issue.rule_id,
    wcag: issue.wcag,
    description: d.description,
    detectionMethod: d.detectionMethod,
    limitations: d.limitations,
    recommendedSteps: d.remediation?.steps ?? [],
  },
  evidenceFromLatestScan: findings.map((f) => ({ page: f.page_url, viewport: f.viewport, evidence: f.evidence.map((e) => ({ [e.label]: e.value.slice(0, 1500) })) })),
})}`;
  const out = await run(ws.id, ws.plan, prompt);
  const saved = await one<{ created_at: string }>(
    `INSERT INTO ai_outputs (workspace_id, issue_id, kind, provider, model, content, created_by) VALUES ($1,$2,'issue_explanation',$3,$4,$5,$6) RETURNING created_at`,
    [ws.id, issue.id, out.provider, out.model, out.content, req.auth!.user.id],
  );
  res.json({ ...out, createdAt: saved!.created_at });
});

aiRouter.post('/scans/:id/summary', async (req, res) => {
  const ws = req.auth!.workspace;
  ensureEnabled(ws.aiEnabled);
  parse(z.object({}).passthrough(), req.body ?? {});
  if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw notFound('Scan');
  const r = await buildReport(req.params.id, ws.id);
  if (r.scan.status !== 'completed') throw new AppError(409, 'conflict', 'Only completed scans can be summarised.');
  const prompt = `Write a short executive summary (about 150–250 words) of this website audit for the site owner, then a list of the three to five most important next steps. Mention which tests did not complete, if any, and that automated checks have limits.

${scanData({
  website: r.scan.websiteUrl,
  scanType: r.scan.kind,
  pagesScanned: r.scan.summary?.pagesScanned,
  issuesBySeverity: r.severity,
  newIssues: r.scan.summary?.newIssues,
  resolvedIssues: r.scan.summary?.resolvedIssues,
  reopenedIssues: r.scan.summary?.reopenedIssues,
  testsNotCompleted: r.notCompleted.map((c) => ({ category: CATEGORY_INFO[c.category].label, status: c.status, reason: c.detail })),
  topPriorities: r.topPriorities.map((i) => ({ title: i.title, severity: SEVERITY_LABELS[i.severity], category: CATEGORY_INFO[i.category].label, pages: i.affectedCount })),
  allIssueTitles: r.issues.slice(0, 40).map((i) => `${SEVERITY_LABELS[i.severity]}: ${i.title} (${i.affectedCount} page(s))`),
})}`;
  const out = await run(ws.id, ws.plan, prompt);
  const saved = await one<{ created_at: string }>(
    `INSERT INTO ai_outputs (workspace_id, scan_id, kind, provider, model, content, created_by) VALUES ($1,$2,'report_summary',$3,$4,$5,$6) RETURNING created_at`,
    [ws.id, r.scan.id, out.provider, out.model, out.content, req.auth!.user.id],
  );
  res.json({ ...out, createdAt: saved!.created_at });
});

// ---------------------------------------------------------------- AI Performance Fix Assistant

/** The scan's home-page Lighthouse report for one device (the page the Performance section shows). */
async function homeReport(scanId: string, workspaceId: string, viewport: ViewportName) {
  return one<{ page_url: string; report: Omit<LighthouseReportDTO, 'pageUrl' | 'viewport'>; summary: { wordpress?: WordPressReportDTO | null } | null; base_url: string; status: string }>(
    `SELECT l.page_url, l.report, s.summary, w.base_url, s.status FROM lighthouse_reports l
       JOIN scans s ON s.id = l.scan_id JOIN websites w ON w.id = s.website_id
      WHERE l.scan_id = $1 AND s.workspace_id = $2 AND l.viewport = $3
      ORDER BY length(l.page_url), l.page_url LIMIT 1`,
    [scanId, workspaceId, viewport],
  );
}

/**
 * Plans being written in the background, by workspace, scan and device. A local model on a CPU can need
 * several minutes — longer than an HTTP request may stay open — so POST starts the job and returns at
 * once, and the page polls GET. Held in memory: a plan in progress is lost if the API restarts (the
 * page then offers to start again); finished plans are stored in ai_outputs.
 */
const pendingPlans = new Map<string, { startedAt: string; error: string | null }>();
/** Background jobs may run longer than one request: at least 15 minutes. */
const PLAN_TIMEOUT_MS = Math.max(config.AI_TIMEOUT_MS, 15 * 60_000);

aiRouter.get('/scans/:id/performance', async (req, res) => {
  if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw notFound('Scan');
  const q = parse(z.object({ viewport: z.enum(['desktop', 'mobile']) }), req.query);
  const ws = req.auth!.workspace.id;
  const row = await one<{ content: string; provider: string; model: string; created_at: string }>(
    `SELECT content, provider, model, created_at FROM ai_outputs WHERE scan_id = $1 AND workspace_id = $2 AND kind = $3 ORDER BY created_at DESC LIMIT 1`,
    [req.params.id, ws, `performance_plan:${q.viewport}`],
  );
  const job = pendingPlans.get(`${ws}:${req.params.id}:${q.viewport}`);
  res.json({
    plan: row ? { content: row.content, provider: row.provider, model: row.model, createdAt: row.created_at } : null,
    pending: !!job && !job.error,
    startedAt: job?.startedAt ?? null,
    error: job?.error ?? null,
  });
});

aiRouter.post('/scans/:id/performance', async (req, res) => {
  const ws = req.auth!.workspace;
  ensureEnabled(ws.aiEnabled);
  if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw notFound('Scan');
  const body = parse(z.object({ viewport: z.enum(['desktop', 'mobile']) }), req.body ?? {});
  const key = `${ws.id}:${req.params.id}:${body.viewport}`;
  if (pendingPlans.get(key)?.error === null) return void res.status(202).json({ pending: true });
  const r = await homeReport(req.params.id, ws.id, body.viewport);
  if (!r) throw notFound('Lighthouse report');
  const prompt = performancePrompt({ website: r.base_url, pageUrl: r.page_url, viewport: body.viewport, report: r.report, wordpress: r.summary?.wordpress ?? null });
  // Charge the quota when the generation is actually started, as the other AI features do.
  await tx((c) => consumeAi(ws.id, ws.plan, c));
  const startedAt = new Date().toISOString();
  pendingPlans.set(key, { startedAt, error: null });
  const userId = req.auth!.user.id;
  const scanId = req.params.id;
  void generate(prompt, { timeoutMs: PLAN_TIMEOUT_MS })
    .then((out) =>
      query(`INSERT INTO ai_outputs (workspace_id, scan_id, kind, provider, model, content, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
        ws.id,
        scanId,
        `performance_plan:${body.viewport}`,
        out.provider,
        out.model,
        out.content,
        userId,
      ]),
    )
    .then(() => pendingPlans.delete(key))
    .catch((e) => {
      const message = e instanceof AiUnavailableError ? e.message : 'The plan could not be written. Please try again.';
      if (!(e instanceof AiUnavailableError)) console.error('[ai] performance plan failed:', (e as Error).message);
      pendingPlans.set(key, { startedAt, error: message });
    });
  res.status(202).json({ pending: true, startedAt });
});
