// Billing with Stripe Checkout, the Customer Portal and signature-verified webhooks.
// Premium access is only ever granted from a verified webhook (never from a browser redirect),
// each Stripe event is processed at most once, and nothing works without real credentials.

import type { Request, Response } from 'express';
import { Router } from 'express';
import Stripe from 'stripe';
import { z } from 'zod';
import { PLANS, type PlanId } from '@wpcg/shared';
import { config } from '../config.js';
import { one, query } from '../db/pool.js';
import { AppError, badRequest, parse } from '../http/errors.js';
import { requireRole } from '../auth/session.js';
import { usageFor } from '../services/quota.js';

export const billingRouter = Router();

let stripeClient: Stripe | null = null;
function stripe(): Stripe {
  if (!config.STRIPE_SECRET_KEY) throw new AppError(503, 'payments_unavailable', 'Online payments are not enabled on this server.');
  stripeClient ??= new Stripe(config.STRIPE_SECRET_KEY);
  return stripeClient;
}

const priceFor = (plan: 'pro' | 'agency') => (plan === 'pro' ? config.STRIPE_PRICE_PRO : config.STRIPE_PRICE_AGENCY);
function planForPrice(priceId: string | undefined): PlanId | null {
  if (priceId && priceId === config.STRIPE_PRICE_PRO) return 'pro';
  if (priceId && priceId === config.STRIPE_PRICE_AGENCY) return 'agency';
  return null;
}

billingRouter.get('/', async (req, res) => {
  const ws = req.auth!.workspace;
  const row = await one<{ subscription_status: string | null; subscription_period_end: string | null; plan_source: string; stripe_customer_id: string | null }>(
    'SELECT subscription_status, subscription_period_end, plan_source, stripe_customer_id FROM workspaces WHERE id = $1',
    [ws.id],
  );
  res.json({
    currentPlan: ws.plan,
    plans: Object.values(PLANS),
    usage: await usageFor(ws.id, ws.plan),
    paymentsConfigured: config.stripeConfigured,
    purchasable: { pro: config.stripeConfigured && !!config.STRIPE_PRICE_PRO, agency: config.stripeConfigured && !!config.STRIPE_PRICE_AGENCY },
    subscription: {
      status: row?.subscription_status ?? null,
      periodEnd: row?.subscription_period_end ?? null,
      planSource: row?.plan_source ?? 'default',
      hasCustomer: !!row?.stripe_customer_id,
    },
    message: config.stripeConfigured
      ? 'Payments are handled by Stripe. Your plan changes once Stripe confirms the payment.'
      : 'Online payments are not enabled in this deployment. Plans are assigned by an operator (npm run plan:set). No card details are collected.',
  });
});

/** Starts Stripe Checkout for a paid plan. */
billingRouter.post('/checkout', requireRole('owner', 'admin'), async (req, res) => {
  const body = parse(z.object({ plan: z.enum(['pro', 'agency']) }), req.body);
  if (!config.stripeConfigured) throw new AppError(503, 'payments_unavailable', 'Online payments are not enabled on this server.');
  const price = priceFor(body.plan);
  if (!price) throw badRequest(`The ${PLANS[body.plan].name} plan is not available for online purchase yet.`);
  const ws = req.auth!.workspace;
  const row = await one<{ stripe_customer_id: string | null; subscription_status: string | null }>('SELECT stripe_customer_id, subscription_status FROM workspaces WHERE id = $1', [ws.id]);
  if (row?.subscription_status && ['active', 'trialing', 'past_due'].includes(row.subscription_status))
    throw badRequest('This workspace already has a subscription. Use "Manage billing" to change plan.');
  let customer = row?.stripe_customer_id ?? null;
  if (!customer) {
    const c = await stripe().customers.create({ email: req.auth!.user.email, name: ws.name, metadata: { workspace_id: ws.id } });
    customer = c.id;
    await query('UPDATE workspaces SET stripe_customer_id = $2 WHERE id = $1', [ws.id, customer]);
  }
  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    customer,
    client_reference_id: ws.id,
    line_items: [{ price, quantity: 1 }],
    subscription_data: { metadata: { workspace_id: ws.id } },
    allow_promotion_codes: true,
    success_url: `${config.publicUrl}/billing?checkout=success`,
    cancel_url: `${config.publicUrl}/billing?checkout=cancelled`,
  });
  res.json({ url: session.url });
});

/** Opens the Stripe Customer Portal (change plan, payment method, cancel, invoices). */
billingRouter.post('/portal', requireRole('owner', 'admin'), async (req, res) => {
  const row = await one<{ stripe_customer_id: string | null }>('SELECT stripe_customer_id FROM workspaces WHERE id = $1', [req.auth!.workspace.id]);
  if (!row?.stripe_customer_id) throw badRequest('There is no billing account for this workspace yet.');
  const session = await stripe().billingPortal.sessions.create({ customer: row.stripe_customer_id, return_url: `${config.publicUrl}/billing` });
  res.json({ url: session.url });
});

// ---------------------------------------------------------------- webhooks

const GRANTING = new Set(['active', 'trialing']);
const KEEP_DURING_GRACE = new Set(['past_due']);

/** Applies a subscription's state to its workspace. The only place that grants paid plans. */
export async function syncSubscription(sub: Stripe.Subscription): Promise<void> {
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  const ws = await one<{ id: string; stripe_subscription_id: string | null; subscription_status: string | null }>(
    'SELECT id, stripe_subscription_id, subscription_status FROM workspaces WHERE ($1::text IS NOT NULL AND id::text = $1) OR stripe_customer_id = $2 LIMIT 1',
    [sub.metadata?.workspace_id ?? null, customerId],
  );
  if (!ws) throw new Error(`No workspace for Stripe customer ${customerId}`);
  const item = sub.items.data[0];
  const plan = planForPrice(item?.price.id);
  const periodEnd = (item as unknown as { current_period_end?: number })?.current_period_end ?? (sub as unknown as { current_period_end?: number }).current_period_end;
  const status = sub.status;
  // An event about a different (older) subscription must not overwrite a current one that still gives
  // access — e.g. the old subscription's late "deleted" arriving after the customer subscribed again.
  const current = ws.stripe_subscription_id;
  const currentStillValid = !!ws.subscription_status && (GRANTING.has(ws.subscription_status) || KEEP_DURING_GRACE.has(ws.subscription_status));
  if (current && current !== sub.id && currentStillValid && !GRANTING.has(status)) {
    console.warn(`[billing] ignored ${status} for ${sub.id}: workspace ${ws.id} is on ${current} (${ws.subscription_status})`);
    return;
  }
  let newPlan: PlanId | null = null;
  if (GRANTING.has(status) && plan) newPlan = plan;
  else if (!GRANTING.has(status) && !KEEP_DURING_GRACE.has(status)) newPlan = 'free';
  await query(
    `UPDATE workspaces SET stripe_customer_id = $2, stripe_subscription_id = $3, subscription_status = $4,
            subscription_period_end = $5,
            plan = COALESCE($6, plan),
            plan_source = CASE WHEN $6 IS NULL THEN plan_source WHEN $6 = 'free' THEN 'default' ELSE 'stripe' END
      WHERE id = $1`,
    [ws.id, customerId, sub.id, status, periodEnd ? new Date(periodEnd * 1000).toISOString() : null, newPlan],
  );
}

/** Express handler mounted with express.raw() so the signature can be verified on the exact bytes. */
export async function stripeWebhook(req: Request, res: Response) {
  if (!config.STRIPE_WEBHOOK_SECRET || !config.STRIPE_SECRET_KEY) {
    res.status(503).json({ error: { code: 'payments_unavailable', message: 'Stripe is not configured.' } });
    return;
  }
  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(req.body as Buffer, String(req.headers['stripe-signature'] ?? ''), config.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    res.status(400).json({ error: { code: 'bad_signature', message: `Webhook signature verification failed: ${(e as Error).message}` } });
    return;
  }
  // A row never marked processed (the server stopped mid-way) is retried once it is 5 minutes old,
  // instead of every Stripe retry being answered "duplicate" and the event lost for good.
  const fresh = await one(
    `INSERT INTO stripe_events (id, type) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET received_at = now()
       WHERE stripe_events.processed_at IS NULL AND stripe_events.received_at < now() - interval '5 minutes'
     RETURNING id`,
    [event.id, event.type],
  );
  if (!fresh) {
    res.json({ received: true, duplicate: true });
    return;
  }
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object as Stripe.Checkout.Session;
        if (s.mode === 'subscription' && s.subscription) {
          if (s.client_reference_id && s.customer)
            await query('UPDATE workspaces SET stripe_customer_id = COALESCE(stripe_customer_id, $2) WHERE id::text = $1', [s.client_reference_id, typeof s.customer === 'string' ? s.customer : s.customer.id]);
          const sub = typeof s.subscription === 'string' ? await stripe().subscriptions.retrieve(s.subscription) : s.subscription;
          await syncSubscription(sub);
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
      case 'customer.subscription.paused':
      case 'customer.subscription.resumed':
        await syncSubscription(event.data.object as Stripe.Subscription);
        break;
      default:
        break; // other events are acknowledged but not needed
    }
    await query('UPDATE stripe_events SET processed_at = now() WHERE id = $1', [event.id]);
    res.json({ received: true });
  } catch (e) {
    // Let Stripe retry: forget the event so the retry is processed.
    await query('DELETE FROM stripe_events WHERE id = $1', [event.id]);
    console.error('[billing] webhook processing failed:', (e as Error).message);
    res.status(500).json({ error: { code: 'webhook_failed', message: 'Processing failed; Stripe will retry.' } });
  }
}
