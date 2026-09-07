# Headquarters Billing

Railway-only Stripe billing service for **Headquarters Hosted**. Self-hosters do not run this.

## Stripe (Corrin AI)

| Item         | Value                                                                    |
| ------------ | ------------------------------------------------------------------------ |
| Account      | Corrin AI (`acct_1SZpNSBNNTLJiAPA`)                                      |
| Product      | `prod_VAAkphL6K8P2Gn` — Headquarters Hosted                              |
| Price (live) | `price_1U9qOkBNNTLJiAPAWERQRFic` — £10 GBP / month (`hq_hosted_monthly`) |

The following Headquarters-specific configurations were verified on 2026-09-07:

| Environment | Price | Customer portal configuration |
| --- | --- | --- |
| Live | `price_1U9qOkBNNTLJiAPAWERQRFic` | `bpc_1UD3tHBNNTLJiAPAIfxwp4Bk` |
| Test | `price_1UD3xsBNNTLJiAPAfPuZ3dQ4` | `bpc_1UD3xsBNNTLJiAPAhIRFrPXs` |

The test price is £10 GBP per month. Use test keys and an isolated database with the test
configuration. The live portal ID is saved in Railway production with deployment skipped;
it takes effect on the next deployment. Real payment E2E verification remains pending.

## Endpoints

| Method | Path                       | Purpose                                    |
| ------ | -------------------------- | ------------------------------------------ |
| `POST` | `/v1/checkout`             | Create Checkout Session → `{ url }`        |
| `POST` | `/v1/webhooks/stripe`      | Stripe webhooks                            |
| `GET`  | `/v1/claim?token=`         | Public claim lookup for CRM signup         |
| `POST` | `/v1/claim`                | Claim after Auth signup (`x-claim-secret`) |
| `GET`  | `/v1/entitlement?user_id=` | Entitlement check (`x-claim-secret`)       |
| `GET`  | `/health`                  | Health                                     |

## Env

```
PORT=8080
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PORTAL_CONFIGURATION=
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

## Hosted launch deployment order

1. Run the CRM migrations, including `20260907140000_hosted_billing_enforcement.sql`.
2. On billing, set `CRM_URL=https://app.headquarters-crm.com`,
   `LANDING_URL=https://headquarters-crm.com`, and include both origins in `CORS_ORIGINS`.
   Legacy Headquarters Railway origins are normalized to the public domains by the service.
3. Create a **Headquarters-specific** Stripe customer portal configuration with invoice history,
   payment-method updates, and cancellation at period end enabled. Set
   `STRIPE_PORTAL_CONFIGURATION` to its `bpc_…` ID. Do not reuse another product's configuration.
4. Deploy billing. Startup enables the private database hosted gate through a service-role-only RPC;
   startup fails if the migration or required configuration is absent. Self-hosters never run billing
   and keep the database gate disabled.
5. Deploy the CRM with `PUBLIC_HOSTED_BILLING=true`, the billing API URL and matching claim secret.
   Set its `PUBLIC_LANDING_URL` and `APP_BASE_URL` to the public marketing/app origins.
6. Register checkout completed/async-payment events, subscription created/updated/deleted,
   and invoice paid/payment_failed webhooks. Deploy the marketing site.

The launch plan is £10/month for **one organisation and at most three seats**, including pending
invitations. Extra-seat purchases are not offered yet. Owners of an existing organisation can attach
an unassigned paid subscription from `/billing`; included members inherit the organisation's access.
The original payer manages the subscription. Changing the CRM organisation owner does not transfer
Stripe billing ownership.

`/v1/claim`, `/v1/recover` and `/v1/portal` require both the CRM shared secret and the authenticated
user's bearer token. Billing derives user/customer identity server-side. Recovery requires the
completed Checkout Session reference and a matching signed-in email; email alone is not proof.
The portal remains available for canceled subscriptions. Do not tell an existing payer to repurchase
to recover a missing/expired signup link.

## Verification

`pnpm test` runs isolated handler tests without external credentials. The CRM pgTAP suite covers
atomic claim outcomes, terminal state protection, tenant access and included-seat enforcement.
A real test-mode checkout still requires a test key, matching test price and webhook endpoint against
an isolated database. Never use live keys with test cards. CI does not make live Stripe requests.

Run `pnpm setup:portal` with the intended Stripe environment key to create (or reuse) a
Headquarters-specific portal configuration. Save the printed ID as `STRIPE_PORTAL_CONFIGURATION`
in that environment before deployment. This command is an explicit operator action, not part of CI.
