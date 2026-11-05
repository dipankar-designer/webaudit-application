// Local test inbox for development: an SMTP server that accepts the app's alert e-mails and a small
// web page to read them. Messages are NOT delivered to real mailboxes.
//
//   node scripts/dev-mail.mjs            (started by `npm run dev`)
//   SMTP:  127.0.0.1:2525  (set SMTP_HOST=127.0.0.1, SMTP_PORT=2525, SMTP_SECURE=false in .env)
//   Inbox: http://127.0.0.1:8025
//
// Messages are kept in C:\wpcg-app-dev\mail (or DEV_MAIL_DIR) so they survive restarts; the newest
// 200 are kept.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';

const SMTP_PORT = Number(process.env.DEV_MAIL_SMTP_PORT || 2525);
const WEB_PORT = Number(process.env.DEV_MAIL_WEB_PORT || 8025);
const DIR = process.env.DEV_MAIL_DIR || (process.platform === 'win32' ? 'C:\\wpcg-app-dev\\mail' : path.join(os.tmpdir(), 'wpcg-dev-mail'));
const KEEP = 200;
fs.mkdirSync(DIR, { recursive: true });

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function list() {
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse()
    .map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
}

function prune() {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP))) {
    fs.rmSync(path.join(DIR, f), { force: true });
    fs.rmSync(path.join(DIR, f.replace(/\.json$/, '.eml')), { force: true });
  }
}

const smtp = new SMTPServer({
  authOptional: true,
  disabledCommands: ['STARTTLS'],
  // Accept any login, so a .env with SMTP_USER/SMTP_PASS set still works against the test inbox.
  onAuth(_auth, _session, cb) {
    cb(null, { user: 'dev' });
  },
  size: 10 * 1024 * 1024,
  onData(stream, session, cb) {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', async () => {
      try {
        const raw = Buffer.concat(chunks);
        const mail = await simpleParser(raw);
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const meta = {
          id,
          receivedAt: new Date().toISOString(),
          from: mail.from?.text ?? session.envelope.mailFrom?.address ?? '',
          to: session.envelope.rcptTo.map((r) => r.address),
          subject: mail.subject ?? '(no subject)',
          text: mail.text ?? '',
          html: typeof mail.html === 'string' ? mail.html : '',
        };
        fs.writeFileSync(path.join(DIR, `${id}.eml`), raw);
        fs.writeFileSync(path.join(DIR, `${id}.json`), JSON.stringify(meta));
        prune();
        console.log(`[dev-mail] ${meta.to.join(', ')} — ${meta.subject}`);
        cb();
      } catch (e) {
        cb(e);
      }
    });
  },
});
// Another inbox already listening (e.g. started separately): stay idle instead of exiting, because
// `concurrently -k` in `npm run dev` would stop the whole dev stack if this process ended.
const idle = (what) => {
  console.log(`[dev-mail] ${what} port already in use — another test inbox is running; this one stays idle.`);
  setInterval(() => {}, 1 << 30);
};
smtp.on('error', (e) => (e.code === 'EADDRINUSE' ? idle('SMTP') : console.error('[dev-mail] SMTP error:', e.message)));
smtp.listen(SMTP_PORT, '127.0.0.1', () => console.log(`[dev-mail] SMTP on 127.0.0.1:${SMTP_PORT}`));

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background: #0b0d15; color: #dde2ea; }
  main { max-width: 960px; margin: 0 auto; padding: 24px 16px; }
  h1 { font-size: 22px; margin: 0 0 4px; } a { color: #6fe68d; } a:focus-visible, button:focus-visible { outline: 2px solid #3ddc63; outline-offset: 2px; }
  .note { background: #2a2108; border: 1px solid #5b4612; color: #fde68a; border-radius: 8px; padding: 10px 12px; margin: 12px 0 20px; font-size: 14px; }
  ul { list-style: none; padding: 0; margin: 0; border: 1px solid #262c42; border-radius: 10px; overflow: hidden; }
  li { border-top: 1px solid #262c42; } li:first-child { border-top: 0; }
  li a { display: block; padding: 12px 14px; color: inherit; text-decoration: none; background: #131726; } li a:hover { background: #1a1f31; }
  .sub { font-weight: 600; color: #eef1f6; } .meta { font-size: 13px; color: #9aa4b6; }
  iframe { width: 100%; min-height: 70vh; border: 1px solid #262c42; border-radius: 10px; background: #fff; }
  pre { white-space: pre-wrap; background: #131726; border: 1px solid #262c42; border-radius: 10px; padding: 12px; }
  .empty { padding: 28px; text-align: center; color: #9aa4b6; background: #131726; }
  .back { display: inline-block; margin-bottom: 12px; }
  @media (prefers-reduced-motion: no-preference) { li a { transition: background .15s; } }
</style></head><body><main>${body}</main></body></html>`;

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${WEB_PORT}`);
    const send = (status, type, body) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(body);
    };
    if (url.pathname === '/api/messages') return send(200, 'application/json', JSON.stringify(list()));
    const m = url.pathname.match(/^\/(m|raw|html)\/([\w-]{8,40})$/);
    if (m) {
      const file = path.join(DIR, `${m[2]}.json`);
      if (!fs.existsSync(file)) return send(404, 'text/plain', 'Not found');
      const msg = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (m[1] === 'raw') return send(200, 'text/plain; charset=utf-8', fs.readFileSync(path.join(DIR, `${m[2]}.eml`)));
      // The message HTML is shown in a sandboxed frame (no scripts, no same-origin access).
      if (m[1] === 'html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; img-src data: https:; style-src 'unsafe-inline'", 'cache-control': 'no-store' });
        return res.end(msg.html || `<pre>${esc(msg.text)}</pre>`);
      }
      return send(
        200,
        'text/html; charset=utf-8',
        page(
          msg.subject,
          `<a class="back" href="/">← Back to inbox</a><h1>${esc(msg.subject)}</h1>
<p class="meta">From ${esc(msg.from)} · To ${esc(msg.to.join(', '))} · ${esc(new Date(msg.receivedAt).toLocaleString())} · <a href="/raw/${esc(msg.id)}">Raw message</a></p>
<iframe title="Message body" sandbox src="/html/${esc(msg.id)}"></iframe>
<h2 style="font-size:16px">Plain-text version</h2><pre>${esc(msg.text)}</pre>`,
        ),
      );
    }
    if (url.pathname !== '/') return send(404, 'text/plain', 'Not found');
    const msgs = list();
    return send(
      200,
      'text/html; charset=utf-8',
      page(
        'Local test inbox',
        `<h1>Local test inbox</h1>
<p class="note">Development only: e-mails sent by WebAudit AI to <strong>127.0.0.1:${SMTP_PORT}</strong> appear here. They are <strong>not</strong> delivered to real mailboxes. Configure a real SMTP provider in <code>.env</code> for real delivery.</p>
${msgs.length ? `<ul>${msgs.map((x) => `<li><a href="/m/${esc(x.id)}"><div class="sub">${esc(x.subject)}</div><div class="meta">To ${esc(x.to.join(', '))} · ${esc(new Date(x.receivedAt).toLocaleString())}</div></a></li>`).join('')}</ul>` : '<ul><li class="empty">No messages yet. Use “Send test” on the Alerts page.</li></ul>'}
<script>setTimeout(() => location.reload(), 5000)</script>`,
      ),
    );
  })
  .on('error', (e) => (e.code === 'EADDRINUSE' ? idle('Inbox') : console.error('[dev-mail] web error:', e.message)))
  .listen(WEB_PORT, '127.0.0.1', () => console.log(`[dev-mail] Inbox on http://127.0.0.1:${WEB_PORT}`));
