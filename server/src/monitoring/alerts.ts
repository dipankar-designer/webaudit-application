// E-mail alerts for incidents. One delivery row per (incident, contact, event) — the unique
// key makes retries and concurrent workers unable to send the same alert twice.

import nodemailer, { type Transporter } from 'nodemailer';
import { PRIORITIES, PRIORITY_LABELS, WATCHERS, type CheckKey, type Priority } from '@wpcg/shared';
import { config } from '../config.js';
import { one, query } from '../db/pool.js';

let transport: Transporter | null = null;
function mailer(): Transporter | null {
  if (!config.emailConfigured) return null;
  transport ??= nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
  return transport;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

interface IncidentRow {
  id: string;
  workspace_id: string;
  monitor_id: string;
  check_key: CheckKey;
  severity: Priority;
  title: string;
  status: string;
  opened_at: string;
  resolved_at: string | null;
  monitor_name: string;
  monitor_url: string | null;
  alert_min_severity: Priority;
}

function compose(inc: IncidentRow, event: 'opened' | 'resolved') {
  const label = WATCHERS[inc.check_key]?.label ?? inc.check_key;
  const link = `${config.publicUrl}/monitors/${inc.monitor_id}`;
  const prefix = event === 'opened' ? `[${inc.severity.toUpperCase()}]` : '[Resolved]';
  const subject = `${prefix} ${inc.monitor_name}: ${inc.title}`.slice(0, 200);
  const minutes = inc.resolved_at ? Math.max(1, Math.round((Date.parse(inc.resolved_at) - Date.parse(inc.opened_at)) / 60000)) : null;
  const lines =
    event === 'opened'
      ? [`${PRIORITY_LABELS[inc.severity]} — ${label}`, '', inc.title, '', `Monitor: ${inc.monitor_name}${inc.monitor_url ? ` (${inc.monitor_url})` : ''}`, `Detected: ${new Date(inc.opened_at).toUTCString()}`, '', `Details and evidence: ${link}`]
      : [`Recovered after ${minutes} minute(s) — ${label}`, '', `Was: ${inc.title}`, '', `Monitor: ${inc.monitor_name}${inc.monitor_url ? ` (${inc.monitor_url})` : ''}`, `Resolved: ${new Date(inc.resolved_at!).toUTCString()}`, '', `History: ${link}`];
  const text = `${lines.join('\n')}\n\n— WebAudit AI monitoring. Change alert settings in the app under Alerts.`;
  const colour = event === 'opened' ? (inc.severity === 'p1' ? '#ff6b6b' : '#ff7f0e') : '#3ddc63';
  const html = `<!doctype html><html><body style="margin:0;background:#0b0d15;font-family:Arial,Helvetica,sans-serif;color:#c9d0dd">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#131726;border-radius:12px;border-left:4px solid ${colour}">
<tr><td style="padding:24px">
<p style="margin:0 0 8px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#9aa4b6">${esc(event === 'opened' ? PRIORITY_LABELS[inc.severity] : 'Resolved')} · ${esc(label)}</p>
<h1 style="margin:0 0 12px;font-size:20px;color:#ffffff">${esc(event === 'opened' ? inc.title : `Recovered: ${inc.title}`)}</h1>
<p style="margin:0 0 4px;color:#c9d0dd">${esc(inc.monitor_name)}${inc.monitor_url ? ` — ${esc(inc.monitor_url)}` : ''}</p>
<p style="margin:0 0 20px;color:#9aa4b6;font-size:13px">${esc(event === 'opened' ? `Detected ${new Date(inc.opened_at).toUTCString()}` : `Resolved ${new Date(inc.resolved_at!).toUTCString()} after ${minutes} minute(s)`)}</p>
<a href="${esc(link)}" style="display:inline-block;background:#3ddc63;color:#04170a;text-decoration:none;font-weight:bold;padding:10px 16px;border-radius:8px">Open in WebAudit AI</a>
</td></tr></table>
<p style="color:#9aa4b6;font-size:12px">You receive this because your address is an alert contact for this workspace.</p>
</td></tr></table></body></html>`;
  return { subject, text, html };
}

export const severityRank = (p: Priority) => PRIORITIES.indexOf(p);

/** Sends (once) the opened/resolved alert for an incident to every enabled contact. */
export async function sendIncidentAlerts(incidentId: string, event: 'opened' | 'resolved'): Promise<void> {
  const inc = await one<IncidentRow>(
    `SELECT i.*, m.name AS monitor_name, m.url AS monitor_url, w.alert_min_severity
       FROM incidents i JOIN monitors m ON m.id = i.monitor_id JOIN workspaces w ON w.id = i.workspace_id WHERE i.id = $1`,
    [incidentId],
  );
  if (!inc) return;
  if (severityRank(inc.severity) > severityRank(inc.alert_min_severity)) return; // below the workspace's alert threshold
  const contacts = await query<{ id: string; target: string }>('SELECT id, target FROM alert_contacts WHERE workspace_id = $1 AND enabled ORDER BY created_at', [inc.workspace_id]);
  if (!contacts.length) return;
  const msg = compose(inc, event);
  const t = mailer();
  for (const c of contacts) {
    const claim = await one<{ id: string }>(
      `INSERT INTO alert_deliveries (workspace_id, incident_id, contact_id, target, event, status, error)
       VALUES ($1,$2,$3,$4,$5,'skipped',$6) ON CONFLICT (incident_id, contact_id, event) DO NOTHING RETURNING id`,
      [inc.workspace_id, inc.id, c.id, c.target, event, t ? null : 'E-mail is not configured on this server (SMTP_HOST).'],
    );
    if (!claim || !t) continue; // already delivered by another run, or nowhere to send
    try {
      await t.sendMail({ from: config.ALERT_FROM, to: c.target, subject: msg.subject, text: msg.text, html: msg.html });
      await query("UPDATE alert_deliveries SET status = 'sent', error = NULL WHERE id = $1", [claim.id]);
    } catch (e) {
      await query("UPDATE alert_deliveries SET status = 'failed', error = $2 WHERE id = $1", [claim.id, (e as Error).message.slice(0, 300)]);
    }
  }
}

/** Sends a test message to one contact and records the delivery. */
export async function sendTestAlert(workspaceId: string, contactId: string): Promise<{ status: 'sent' | 'failed' | 'skipped'; error: string | null }> {
  const c = await one<{ id: string; target: string }>('SELECT id, target FROM alert_contacts WHERE id = $1 AND workspace_id = $2', [contactId, workspaceId]);
  if (!c) throw new Error('Contact not found');
  const t = mailer();
  let status: 'sent' | 'failed' | 'skipped' = 'skipped';
  let error: string | null = t ? null : 'E-mail is not configured on this server (SMTP_HOST).';
  if (t) {
    try {
      await t.sendMail({
        from: config.ALERT_FROM,
        to: c.target,
        subject: 'WebAudit AI test alert',
        text: `This is a test alert from WebAudit AI.\n\nIf you can read this, monitoring alerts will reach ${c.target}.\n\n${config.publicUrl}/alerts`,
      });
      status = 'sent';
    } catch (e) {
      status = 'failed';
      error = (e as Error).message.slice(0, 300);
    }
  }
  await query("INSERT INTO alert_deliveries (workspace_id, contact_id, target, event, status, error) VALUES ($1,$2,$3,'test',$4,$5)", [workspaceId, c.id, c.target, status, error]);
  return { status, error };
}

/** Re-sends incident alerts that failed in the last hour (e.g. a brief SMTP outage). */
export async function retryFailedDeliveries(): Promise<number> {
  const t = mailer();
  if (!t) return 0;
  const rows = await query<{ id: string; incident_id: string; target: string; event: 'opened' | 'resolved' }>(
    `SELECT id, incident_id, target, event FROM alert_deliveries
      WHERE status = 'failed' AND incident_id IS NOT NULL AND event <> 'test' AND created_at > now() - interval '1 hour'
      ORDER BY created_at LIMIT 20`,
  );
  let sent = 0;
  for (const r of rows) {
    const inc = await one<IncidentRow>(
      `SELECT i.*, m.name AS monitor_name, m.url AS monitor_url, w.alert_min_severity
         FROM incidents i JOIN monitors m ON m.id = i.monitor_id JOIN workspaces w ON w.id = i.workspace_id WHERE i.id = $1`,
      [r.incident_id],
    );
    if (!inc) continue;
    const msg = compose(inc, r.event);
    try {
      await t.sendMail({ from: config.ALERT_FROM, to: r.target, subject: msg.subject, text: msg.text, html: msg.html });
      await query("UPDATE alert_deliveries SET status = 'sent', error = NULL WHERE id = $1", [r.id]);
      sent++;
    } catch (e) {
      await query('UPDATE alert_deliveries SET error = $2 WHERE id = $1', [r.id, `Retry failed: ${(e as Error).message.slice(0, 280)}`]);
    }
  }
  return sent;
}
