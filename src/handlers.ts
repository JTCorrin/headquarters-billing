import type { Context } from 'hono';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
	claimExpiryIso,
	createStripe,
	createSupabase,
	generateClaimToken,
	hashClaimToken,
	loadEnv,
	mapStripeSubscriptionStatus,
	normalizeEmail,
	safeEqualString,
	type Env,
	type HostedSubscriptionStatus
} from './lib.js';

export type AppBindings = {
	Variables: {
		env: Env;
		stripe: Stripe;
		supabase: SupabaseClient;
	};
};

export function initContext(c: Context<AppBindings>): void {
	if (!c.get('env')) {
		const env = loadEnv();
		c.set('env', env);
		c.set('stripe', createStripe(env));
		c.set('supabase', createSupabase(env));
	}
}

export async function createCheckoutSession(c: Context<AppBindings>) {
	const env = c.get('env');
	const stripe = c.get('stripe');
	const supabase = c.get('supabase');

	let body: { email?: string } = {};
	try {
		body = await c.req.json();
	} catch {
		body = {};
	}

	const email = body.email ? normalizeEmail(body.email) : '';
	const claimToken = generateClaimToken();
	const claimTokenHash = hashClaimToken(claimToken, env.claimHmacSecret);
	const claimExpiresAt = claimExpiryIso(7);

	const { data: row, error: insertError } = await supabase
		.from('hosted_subscriptions')
		.insert({
			email: email || null,
			status: 'pending_checkout',
			claim_token_hash: claimTokenHash,
			claim_expires_at: claimExpiresAt,
			seats_included: 3
		})
		.select('id')
		.single();

	if (insertError || !row) {
		console.error('insert hosted_subscriptions failed', insertError);
		return c.json({ error: 'Could not start checkout' }, 500);
	}

	const successUrl = `${env.crmUrl}/signup?claim=${encodeURIComponent(claimToken)}&session_id={CHECKOUT_SESSION_ID}`;
	const cancelUrl = `${env.landingUrl}/#pricing`;

	const sessionParams: Stripe.Checkout.SessionCreateParams = {
		mode: 'subscription',
		line_items: [{ price: env.stripePriceHqHosted, quantity: 1 }],
		success_url: successUrl,
		cancel_url: cancelUrl,
		client_reference_id: row.id,
		metadata: {
			hosted_subscription_id: row.id,
			claim_token_hash: claimTokenHash
		},
		subscription_data: {
			metadata: {
				hosted_subscription_id: row.id
			}
		}
	};

	if (email) {
		sessionParams.customer_email = email;
	}

	let session: Stripe.Checkout.Session;
	try {
		session = await stripe.checkout.sessions.create(sessionParams);
	} catch (err) {
		console.error('stripe checkout.sessions.create failed', err);
		await supabase.from('hosted_subscriptions').delete().eq('id', row.id);
		return c.json({ error: 'Stripe checkout failed' }, 502);
	}

	await supabase
		.from('hosted_subscriptions')
		.update({ stripe_checkout_session_id: session.id })
		.eq('id', row.id);

	if (!session.url) {
		return c.json({ error: 'Stripe did not return a checkout URL' }, 502);
	}

	return c.json({ url: session.url, session_id: session.id });
}

export async function handleStripeWebhook(c: Context<AppBindings>) {
	const env = c.get('env');
	const stripe = c.get('stripe');
	const supabase = c.get('supabase');
	const signature = c.req.header('stripe-signature');
	if (!signature) {
		return c.json({ error: 'Missing stripe-signature' }, 400);
	}

	const rawBody = await c.req.text();
	let event: Stripe.Event;
	try {
		event = stripe.webhooks.constructEvent(rawBody, signature, env.stripeWebhookSecret);
	} catch (err) {
		console.error('webhook signature verification failed', err);
		return c.json({ error: 'Invalid signature' }, 400);
	}

	try {
		switch (event.type) {
			case 'checkout.session.completed':
				await onCheckoutSessionCompleted(supabase, stripe, event.data.object as Stripe.Checkout.Session);
				break;
			case 'customer.subscription.updated':
			case 'customer.subscription.deleted':
				await onSubscriptionChanged(supabase, event.data.object as Stripe.Subscription);
				break;
			case 'invoice.paid':
			case 'invoice.payment_failed':
				await onInvoiceEvent(supabase, stripe, event.data.object as Stripe.Invoice);
				break;
			default:
				break;
		}
	} catch (err) {
		console.error(`webhook handler failed for ${event.type}`, err);
		return c.json({ error: 'Webhook handler failed' }, 500);
	}

	return c.json({ received: true });
}

async function onCheckoutSessionCompleted(
	supabase: SupabaseClient,
	stripe: Stripe,
	session: Stripe.Checkout.Session
) {
	const hostedId = session.metadata?.hosted_subscription_id ?? session.client_reference_id;
	const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
	const subscriptionId =
		typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
	const emailFromSession =
		session.customer_details?.email ?? session.customer_email ?? undefined;

	let status: HostedSubscriptionStatus = 'active';
	if (subscriptionId) {
		const sub = await stripe.subscriptions.retrieve(subscriptionId);
		status = mapStripeSubscriptionStatus(sub.status);
	}

	const patch: Record<string, unknown> = {
		status,
		stripe_checkout_session_id: session.id
	};
	if (customerId) patch.stripe_customer_id = customerId;
	if (subscriptionId) patch.stripe_subscription_id = subscriptionId;
	if (emailFromSession) patch.email = normalizeEmail(emailFromSession);

	if (hostedId) {
		const { error } = await supabase.from('hosted_subscriptions').update(patch).eq('id', hostedId);
		if (error) throw error;
		return;
	}

	if (session.id) {
		const { error } = await supabase
			.from('hosted_subscriptions')
			.update(patch)
			.eq('stripe_checkout_session_id', session.id);
		if (error) throw error;
	}
}

async function onSubscriptionChanged(supabase: SupabaseClient, subscription: Stripe.Subscription) {
	const status = mapStripeSubscriptionStatus(subscription.status);
	const hostedId = subscription.metadata?.hosted_subscription_id;
	const patch = {
		status,
		stripe_subscription_id: subscription.id,
		stripe_customer_id:
			typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id
	};

	if (hostedId) {
		const { error } = await supabase.from('hosted_subscriptions').update(patch).eq('id', hostedId);
		if (error) throw error;
		return;
	}

	const { error } = await supabase
		.from('hosted_subscriptions')
		.update(patch)
		.eq('stripe_subscription_id', subscription.id);
	if (error) throw error;
}

async function onInvoiceEvent(
	supabase: SupabaseClient,
	stripe: Stripe,
	invoice: Stripe.Invoice
) {
	const raw = invoice as Stripe.Invoice & {
		subscription?: string | Stripe.Subscription | null;
		parent?: { subscription_details?: { subscription?: string | null } | null } | null;
	};
	const subscriptionId =
		(typeof raw.subscription === 'string' ? raw.subscription : raw.subscription?.id) ??
		raw.parent?.subscription_details?.subscription ??
		null;
	if (!subscriptionId) return;

	const sub = await stripe.subscriptions.retrieve(subscriptionId);
	await onSubscriptionChanged(supabase, sub);
}

export async function lookupClaim(c: Context<AppBindings>) {
	const env = c.get('env');
	const supabase = c.get('supabase');
	const token = c.req.query('token')?.trim();
	if (!token) {
		return c.json({ error: 'Missing token' }, 400);
	}

	const claimTokenHash = hashClaimToken(token, env.claimHmacSecret);
	const { data, error } = await supabase.rpc('lookup_hosted_claim', {
		p_claim_token_hash: claimTokenHash
	});

	if (error) {
		console.error('lookup_hosted_claim failed', error);
		return c.json({ error: 'Lookup failed' }, 500);
	}
	if (!data) {
		return c.json({ error: 'Claim not found' }, 404);
	}

	const claim = data as {
		id: string;
		email: string | null;
		status: string;
		claim_expires_at: string;
		claimed_at: string | null;
		user_id: string | null;
		seats_included: number;
	};

	const expired = new Date(claim.claim_expires_at).getTime() < Date.now();
	const payable = claim.status === 'active' || claim.status === 'trialing' || claim.status === 'past_due';
	const alreadyClaimed = Boolean(claim.claimed_at || claim.user_id);

	return c.json({
		id: claim.id,
		email: claim.email,
		status: claim.status,
		claim_expires_at: claim.claim_expires_at,
		expired,
		already_claimed: alreadyClaimed,
		usable: payable && !expired && !alreadyClaimed,
		seats_included: claim.seats_included
	});
}

export async function claimSubscription(c: Context<AppBindings>) {
	const env = c.get('env');
	const supabase = c.get('supabase');

	const shared = c.req.header('x-claim-secret') ?? '';
	if (!safeEqualString(shared, env.claimSharedSecret)) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	let body: { token?: string; user_id?: string; email?: string };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: 'Invalid JSON' }, 400);
	}

	const token = body.token?.trim();
	const userId = body.user_id?.trim();
	const email = body.email ? normalizeEmail(body.email) : '';
	if (!token || !userId || !email) {
		return c.json({ error: 'token, user_id, and email are required' }, 400);
	}

	const claimTokenHash = hashClaimToken(token, env.claimHmacSecret);
	const { data, error } = await supabase.rpc('lookup_hosted_claim', {
		p_claim_token_hash: claimTokenHash
	});
	if (error) {
		console.error('lookup_hosted_claim failed', error);
		return c.json({ error: 'Lookup failed' }, 500);
	}
	if (!data) {
		return c.json({ error: 'Claim not found' }, 404);
	}

	const claim = data as {
		id: string;
		email: string | null;
		status: string;
		claim_expires_at: string;
		claimed_at: string | null;
		user_id: string | null;
	};

	if (claim.claimed_at || claim.user_id) {
		if (claim.user_id === userId) {
			return c.json({ ok: true, already_claimed: true, id: claim.id });
		}
		return c.json({ error: 'Claim already used' }, 409);
	}

	if (new Date(claim.claim_expires_at).getTime() < Date.now()) {
		return c.json({ error: 'Claim expired' }, 410);
	}

	const payable = claim.status === 'active' || claim.status === 'trialing' || claim.status === 'past_due';
	if (!payable) {
		return c.json({ error: 'Subscription is not active yet', status: claim.status }, 402);
	}

	if (claim.email && normalizeEmail(claim.email) !== email) {
		return c.json({ error: 'Email does not match paid checkout' }, 403);
	}

	const { error: updateError } = await supabase
		.from('hosted_subscriptions')
		.update({
			user_id: userId,
			claimed_at: new Date().toISOString(),
			email
		})
		.eq('id', claim.id)
		.is('claimed_at', null);

	if (updateError) {
		console.error('claim update failed', updateError);
		return c.json({ error: 'Could not claim subscription' }, 500);
	}

	return c.json({ ok: true, id: claim.id });
}

export async function entitlementForUser(c: Context<AppBindings>) {
	const env = c.get('env');
	const supabase = c.get('supabase');

	const shared = c.req.header('x-claim-secret') ?? '';
	if (!safeEqualString(shared, env.claimSharedSecret)) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	const userId = c.req.query('user_id')?.trim();
	if (!userId) {
		return c.json({ error: 'Missing user_id' }, 400);
	}

	const { data, error } = await supabase.rpc('hosted_entitlement_for_user', {
		p_user_id: userId
	});
	if (error) {
		console.error('hosted_entitlement_for_user failed', error);
		return c.json({ error: 'Lookup failed' }, 500);
	}

	return c.json({ entitlement: data ?? null });
}
