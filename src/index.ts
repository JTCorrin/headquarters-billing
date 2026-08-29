import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
	claimSubscription,
	createCheckoutSession,
	entitlementForUser,
	handleStripeWebhook,
	initContext,
	lookupClaim,
	type AppBindings
} from './handlers.js';
import { loadEnv } from './lib.js';

const app = new Hono<AppBindings>();

app.use('*', async (c, next) => {
	try {
		initContext(c);
	} catch (err) {
		console.error(err);
		return c.json({ error: 'Server misconfigured' }, 500);
	}
	await next();
});

app.use('/v1/*', async (c, next) => {
	const env = c.get('env');
	const corsMiddleware = cors({
		origin: (origin) => {
			if (!origin) return env.corsOrigins[0] ?? '*';
			const normalized = origin.replace(/\/$/, '');
			return env.corsOrigins.includes(normalized) ? origin : '';
		},
		allowMethods: ['GET', 'POST', 'OPTIONS'],
		allowHeaders: ['Content-Type', 'x-claim-secret']
	});
	return corsMiddleware(c, next);
});

app.get('/health', (c) => c.json({ ok: true, service: 'headquarters-billing' }));

app.post('/v1/checkout', createCheckoutSession);
app.post('/v1/webhooks/stripe', handleStripeWebhook);
app.get('/v1/claim', lookupClaim);
app.post('/v1/claim', claimSubscription);
app.get('/v1/entitlement', entitlementForUser);

const env = (() => {
	try {
		return loadEnv();
	} catch (err) {
		console.error(err);
		process.exit(1);
	}
})();

serve({ fetch: app.fetch, port: env.port }, (info) => {
	console.log(`headquarters-billing listening on :${info.port}`);
});
