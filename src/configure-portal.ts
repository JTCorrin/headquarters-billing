import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY?.trim();
if (!key) throw new Error('Set STRIPE_SECRET_KEY for the intended Stripe environment');
const stripe = new Stripe(key);
const existing = await stripe.billingPortal.configurations.list({ limit: 100 });
let configuration = existing.data.find(
 (item) => item.active && item.metadata?.application === 'headquarters'
);
if (!configuration) {
 configuration = await stripe.billingPortal.configurations.create({
  metadata: { application: 'headquarters' },
  business_profile: { headline: 'Manage your Headquarters subscription' },
  features: {
   invoice_history: { enabled: true },
   payment_method_update: { enabled: true },
   subscription_cancel: { enabled: true, mode: 'at_period_end' }
  }
 }, { idempotencyKey: 'headquarters-portal-v1' });
}
console.log(`STRIPE_PORTAL_CONFIGURATION=${configuration.id}`);
