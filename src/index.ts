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

app.get('/health', (c) => c.json({ ok: true, service: 'headquarters-billing' }));

app.use('/v1/*', async (c, next) => {
	try {
		initContext(c);
	} catch (err) {
		console.error(err);
		return c.json({ error: 'Server misconfigured' }, 500);
	}
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

app.post('/v1/checkout', createCheckoutSession);
app.post('/v1/webhooks/stripe', handleStripeWebhook);
app.get('/v1/claim', lookupClaim);
app.post('/v1/claim', claimSubscription);
app.get('/v1/entitlement', entitlementForUser);

const port = Number(process.env.PORT ?? '8080');

serve({ fetch: app.fetch, port }, (info) => {
	console.log(`headquarters-billing listening on :${info.port}`);
	try {
		loadEnv();
		console.log('env ok');
	} catch (err) {
		console.warn('env incomplete — /health works; /v1/* will return 500 until vars are set');
		console.warn(err instanceof Error ? err.message : err);
	}
});
