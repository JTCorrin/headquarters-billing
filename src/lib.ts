import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

export type HostedSubscriptionStatus =
	| 'pending_checkout'
	| 'active'
	| 'past_due'
	| 'canceled'
	| 'unpaid'
	| 'incomplete'
	| 'incomplete_expired'
	| 'trialing'
	| 'paused';

export interface Env {
	port: number;
	stripeSecretKey: string;
	stripeWebhookSecret: string;
	stripePriceHqHosted: string;
	supabaseUrl: string;
	supabaseServiceRoleKey: string;
	crmUrl: string;
	landingUrl: string;
	claimHmacSecret: string;
	claimSharedSecret: string;
	corsOrigins: string[];
}

function requireEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) {
		throw new Error(`Missing required env var: ${name}`);
	}
	return value;
}

export function loadEnv(): Env {
	const corsRaw = process.env.CORS_ORIGINS?.trim() ?? '';
	const landingUrl = requireEnv('LANDING_URL').replace(/\/$/, '');
	const crmUrl = requireEnv('CRM_URL').replace(/\/$/, '');
	const corsOrigins = corsRaw
		? corsRaw.split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean)
		: [landingUrl, crmUrl];

	return {
		port: Number(process.env.PORT ?? '8080'),
		stripeSecretKey: requireEnv('STRIPE_SECRET_KEY'),
		stripeWebhookSecret: requireEnv('STRIPE_WEBHOOK_SECRET'),
		stripePriceHqHosted: requireEnv('STRIPE_PRICE_HQ_HOSTED'),
		supabaseUrl: requireEnv('SUPABASE_URL').replace(/\/$/, ''),
		supabaseServiceRoleKey: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
		crmUrl,
		landingUrl,
		claimHmacSecret: requireEnv('CLAIM_HMAC_SECRET'),
		claimSharedSecret: requireEnv('CLAIM_SHARED_SECRET'),
		corsOrigins
	};
}

export function createStripe(env: Env): Stripe {
	return new Stripe(env.stripeSecretKey, {
		apiVersion: '2026-08-26.dahlia',
		typescript: true
	});
}

export function createSupabase(env: Env): SupabaseClient {
	return createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
		auth: { persistSession: false, autoRefreshToken: false }
	});
}

export function generateClaimToken(): string {
	return randomBytes(32).toString('base64url');
}

export function hashClaimToken(token: string, secret: string): string {
	return createHash('sha256').update(`${secret}:${token}`, 'utf8').digest('hex');
}

export function safeEqualString(a: string, b: string): boolean {
	const aBuf = Buffer.from(a);
	const bBuf = Buffer.from(b);
	if (aBuf.length !== bBuf.length) return false;
	return timingSafeEqual(aBuf, bBuf);
}

export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

export function mapStripeSubscriptionStatus(
	status: Stripe.Subscription.Status
): HostedSubscriptionStatus {
	const known: HostedSubscriptionStatus[] = [
		'active',
		'past_due',
		'canceled',
		'unpaid',
		'incomplete',
		'incomplete_expired',
		'trialing',
		'paused'
	];
	if ((known as string[]).includes(status)) {
		return status as HostedSubscriptionStatus;
	}
	return 'active';
}

export function claimExpiryIso(days = 7): string {
	return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}
