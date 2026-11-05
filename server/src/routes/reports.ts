import { Router } from 'express';
import { PLANS } from '@wpcg/shared';
import { notFound, quotaExceeded } from '../http/errors.js';
import { buildReport } from '../reports/build.js';
import { issuesCsv, renderPdf, reportHtml } from '../reports/exporters.js';

export const reportsRouter = Router();

const id = (v: unknown) => {
  const s = String(v);
  if (!/^[0-9a-f-]{36}$/.test(s)) throw notFound('Report');
  return s;
};

function fileName(url: string, ext: string) {
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return 'website';
    }
  })();
  return `webaudit-${host}-${new Date().toISOString().slice(0, 10)}.${ext}`;
}

reportsRouter.get('/:scanId', async (req, res) => {
  res.json(await buildReport(id(req.params.scanId), req.auth!.workspace.id));
});

reportsRouter.get('/:scanId/issues.csv', async (req, res) => {
  const report = await buildReport(id(req.params.scanId), req.auth!.workspace.id);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName(report.scan.websiteUrl, 'csv')}"`);
  res.send(issuesCsv(report));
});

reportsRouter.get('/:scanId/report.pdf', async (req, res) => {
  const ws = req.auth!.workspace;
  if (!PLANS[ws.plan].pdfExport) throw quotaExceeded('PDF export is not included in your plan.');
  const report = await buildReport(id(req.params.scanId), ws.id);
  const pdf = await renderPdf(await reportHtml(report, ws.id));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName(report.scan.websiteUrl, 'pdf')}"`);
  res.send(pdf);
});
