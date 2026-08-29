# Headquarters Billing

Railway-only Stripe billing service for **Headquarters Hosted**. Self-hosters do not run this.

## Stripe (Corrin AI)

| Item | Value |
|------|--------|
| Account | Corrin AI (`acct_1SZpNSBNNTLJiAPA`) |
| Product | `prod_VAAkphL6K8P2Gn` — Headquarters Hosted |
| Price (live) | `price_1U9qOkBNNTLJiAPAWERQRFic` — £10 GBP / month (`hq_hosted_monthly`) |

Create a matching **test-mode** product/price in the Dashboard (test toggle) and use that price ID with `sk_test_…` keys for staging.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v1/checkout` | Create Checkout Session → `{ url }` |
| `POST` | `/v1/webhooks/stripe` | Stripe webhooks |
| `GET` | `/v1/claim?token=` | Public claim lookup for CRM signup |
| `POST` | `/v1/claim` | Claim after Auth signup (`x-claim-secret`) |
| `GET` | `/v1/entitlement?user_id=` | Entitlement check (`x-claim-secret`) |
| `GET` | `/health` | Health |

## Env

```
PORT=8080
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_HQ_HOSTED=price_1U9qOkBNNTLJiAPAWERQRFic
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
CRM_URL=https://app.example.com
LANDING_URL=https://www.example.com
CLAIM_HMAC_SECRET=          # long random; hashes claim tokens
CLAIM_SHARED_SECRET=        # shared with CRM server for claim/entitlement
CORS_ORIGINS=               # optional comma list; defaults to CRM_URL,LANDING_URL
```

## Webhook events

`checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`

Endpoint: `https://<billing-host>/v1/webhooks/stripe`

## Local

```sh
pnpm install
pnpm dev
```

## Deploy

Dockerfile included. Point Railway at this directory; set env vars; generate a public domain; register the webhook in Stripe (Corrin AI).
