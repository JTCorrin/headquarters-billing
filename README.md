# Headquarters Billing

Railway-only Stripe billing service for **Headquarters Hosted**. Self-hosters do not run this.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/checkout` | Create a hosted Checkout Session |
| `POST` | `/v1/webhooks/stripe` | Receive signed Stripe events |
| `GET` | `/v1/claim?token=` | Look up a signup claim |
| `POST` | `/v1/claim` | Claim a payment using the shared secret and user bearer token |
| `POST` | `/v1/recover` | Recover a payment using its checkout reference |
| `POST` | `/v1/recover-email` | Recover payments using verified inbox proof |
| `POST` | `/v1/portal` | Open the authenticated payer's customer portal |
| `GET` | `/v1/entitlement?user_id=` | Check access using the shared secret |
| `GET` | `/health` | Check service health |

## Env

```
PORT=8080
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PORTAL_CONFIGURATION=
STRIPE_PRICE_HQ_HOSTED=      # recurring price in the same Stripe environment as the key
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
CRM_URL=https://app.example.com
LANDING_URL=https://www.example.com
CLAIM_HMAC_SECRET=          # long random; hashes claim tokens
CLAIM_SHARED_SECRET=        # shared with CRM server for claim/entitlement
CORS_ORIGINS=               # optional comma list; defaults to CRM_URL,LANDING_URL
```

## Webhook events

`checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`

Endpoint: `https://<billing-host>/v1/webhooks/stripe`

## Local

```sh
pnpm install
pnpm dev
```

## Deploy

Dockerfile included. Point Railway at this directory; set env vars; generate a public domain; register the webhook in Stripe.

## Deployment order

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

`POST /v1/recover-email` discovers payments for the authenticated email only after the CRM has
completed its PKCE email-link callback. In addition to the shared secret and bearer token, it requires
a short-lived signed `recovery_proof` bound to that user and email. Billing rechecks the Stripe checkout
and Headquarters price before recovering each matching payment; already-owned payments cannot be
transferred to another user. Deploy billing before the matching CRM UI and configure Supabase's email
callback allowlist with the CRM origin's `/billing/email-callback` URL. The Supabase Magic Link
template must use `{{ .ConfirmationURL }}` and custom SMTP must be configured. Recovery links
must be opened in the same browser that requested them; the checkout-reference fallback remains
available when the email flow cannot be completed.

## Verification

`pnpm test` runs isolated handler tests without external credentials. The CRM pgTAP suite covers
atomic claim outcomes, terminal state protection, tenant access and included-seat enforcement.
A real test-mode checkout still requires a test key, matching test price and webhook endpoint against
an isolated database. Never use live keys with test cards. CI does not make live Stripe requests.

Run `pnpm setup:portal` with the intended Stripe environment key to create (or reuse) a
Headquarters-specific portal configuration. Save the printed ID as `STRIPE_PORTAL_CONFIGURATION`
in that environment before deployment. This command is an explicit operator action, not part of CI.
