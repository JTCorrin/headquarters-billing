import { test } from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { createApp } from "./app.js";
import {
  canonicalOrigin,
  loadEnv,
  mapStripeSubscriptionStatus,
  type Env,
} from "./lib.js";
import type { SupabaseClient } from "@supabase/supabase-js";

function harness() {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const env: Env = {
    port: 8080,
    stripeSecretKey: "sk_test_local_only",
    stripeWebhookSecret: "whsec_local",
    stripePriceHqHosted: "price_hq",
    supabaseUrl: "https://example.test",
    supabaseServiceRoleKey: "local",
    crmUrl: "https://app.headquarters-crm.com",
    landingUrl: "https://headquarters-crm.com",
    claimHmacSecret: "local-hash",
    claimSharedSecret: "local-shared",
    corsOrigins: [
      "https://headquarters-crm.com",
      "https://app.headquarters-crm.com",
    ],
    stripePortalConfiguration: "bpc_hq",
  };
  const state = {
    status: "active",
    claim: { ok: true, id: "row" },
    rpcError: null as unknown,
    sessionStatus: "complete",
    email: "buyer@example.test",
    price: "price_hq",
    portalCustomer: "cus_buyer",
  };
  const verifier = new Stripe(env.stripeSecretKey);
  const stripe = {
    webhooks: verifier.webhooks,
    subscriptions: {
      retrieve: async () => ({
        id: "sub_hq",
        status: state.status,
        customer: "cus_buyer",
        metadata: { hosted_subscription_id: "row" },
        items: { data: [{ price: { id: state.price } }] },
      }),
    },
    checkout: {
      sessions: {
        retrieve: async (id: string) => ({
          id,
          mode: "subscription",
          status: state.sessionStatus,
          subscription: "sub_hq",
          metadata: { hosted_subscription_id: "row" },
          customer_details: { email: state.email },
        }),
        create: async (args: Record<string, unknown>) => {
          calls.push({ name: "checkout", args });
          return {
            id: "cs_test_new",
            url: "https://checkout.stripe.com/test",
            status: "open",
          };
        },
        expire: async () => {
          calls.push({ name: "expire", args: {} });
        },
      },
    },
    billingPortal: {
      sessions: {
        create: async (args: Record<string, unknown>) => {
          calls.push({ name: "portal", args });
          return { url: "https://billing.stripe.com/session" };
        },
      },
    },
  } as unknown as Stripe;
  const db = {
    auth: {
      getUser: async (token: string) => ({
        data: {
          user:
            token === "valid"
              ? { id: "buyer", email: "buyer@example.test" }
              : null,
        },
        error: null,
      }),
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return {
        data:
          name === "claim_hosted_subscription" ||
          name === "recover_hosted_subscription"
            ? state.claim
            : null,
        error: state.rpcError,
      };
    },
    from: () => {
      const q: any = {
        insert: () => q,
        select: () => q,
        single: async () => ({ data: { id: "row" }, error: null }),
        update: () => q,
        delete: () => q,
        eq: () => q,
        not: () => q,
        order: () => q,
        limit: () => q,
        maybeSingle: async () => ({
          data: state.portalCustomer
            ? { stripe_customer_id: state.portalCustomer }
            : null,
          error: null,
        }),
        then: (resolve: any) => Promise.resolve({ error: null }).then(resolve),
      };
      return q;
    },
  } as unknown as SupabaseClient;
  const app = createApp((c) => {
    c.set("env", env);
    c.set("stripe", stripe);
    c.set("supabase", db);
  });
  const post = (path: string, input: unknown = {}, authorized = true) =>
    app.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorized
          ? { "x-claim-secret": "local-shared", Authorization: "Bearer valid" }
          : {}),
      },
      body: JSON.stringify(input),
    });
  const webhook = (type: string, object: unknown, livemode = false) => {
    const payload = JSON.stringify({
      id: "evt_test",
      type,
      livemode,
      created: 1,
      data: { object },
    });
    return app.request("/v1/webhooks/stripe", {
      method: "POST",
      headers: {
        "stripe-signature": verifier.webhooks.generateTestHeaderString({
          payload,
          secret: env.stripeWebhookSecret,
        }),
      },
      body: payload,
    });
  };
  return { app, state, calls, post, webhook };
}
test("canonical domains replace old deployment URLs", () => {
  assert.equal(
    canonicalOrigin("https://headquarters-production-a08d.up.railway.app/"),
    "https://app.headquarters-crm.com",
  );
  assert.equal(
    canonicalOrigin("https://headquarters-web-production-3e78.up.railway.app"),
    "https://headquarters-crm.com",
  );
  assert.equal(
    canonicalOrigin("http://localhost:8080/"),
    "http://localhost:8080",
  );
});
test("unknown Stripe statuses fail closed", () =>
  assert.equal(
    mapStripeSubscriptionStatus("future-status" as Stripe.Subscription.Status),
    "unpaid",
  ));
test("public marketing origin can preflight checkout; arbitrary origin cannot", async () => {
  const { app } = harness();
  for (const origin of [
    "https://headquarters-crm.com",
    "https://attacker.test",
  ]) {
    const r = await app.request("/v1/checkout", {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    assert.equal(r.status, 204);
    assert.equal(
      r.headers.get("access-control-allow-origin"),
      origin.includes("attacker") ? null : origin,
    );
  }
});
test("checkout uses the agreed price and public return domains", async () => {
  const h = harness();
  assert.equal((await h.post("/v1/checkout", {})).status, 200);
  const args = h.calls.find((c) => c.name === "checkout")!.args;
  assert.deepEqual(args.line_items, [{ price: "price_hq", quantity: 1 }]);
  assert.match(
    String(args.success_url),
    /^https:\/\/app.headquarters-crm.com\/signup\?claim=/,
  );
  assert.equal(args.cancel_url, "https://headquarters-crm.com/#pricing");
});
test("malformed checkout data is rejected before storage or Stripe", async () => {
  const h = harness();
  for (const value of [null, [], { email: 4 }, { email: "bad" }])
    assert.equal((await h.post("/v1/checkout", value)).status, 400);
  assert.equal(h.calls.length, 0);
});
test("claim requires an authenticated user, not a supplied user id", async () => {
  const h = harness();
  assert.equal(
    (await h.post("/v1/claim", { token: "proof", user_id: "victim" }, false))
      .status,
    401,
  );
  assert.equal(
    (await h.post("/v1/claim", { token: "proof", user_id: "victim" })).status,
    200,
  );
  const call = h.calls.find((c) => c.name === "claim_hosted_subscription")!;
  assert.equal(call.args.p_user_id, "buyer");
  assert.equal(call.args.p_email, "buyer@example.test");
});
test("atomic claim conflict is surfaced instead of false success", async () => {
  const h = harness();
  h.state.claim = { ok: false, status: 409, error: "Already used" } as any;
  assert.equal((await h.post("/v1/claim", { token: "proof" })).status, 409);
});
test("forged and wrong-mode webhook events are rejected", async () => {
  const h = harness();
  assert.equal(
    (
      await h.app.request("/v1/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "invalid" },
        body: "{}",
      })
    ).status,
    400,
  );
  assert.equal(
    (await h.webhook("customer.subscription.updated", { id: "sub_hq" }, true))
      .status,
    400,
  );
});
test("stale active event reconciles current canceled state", async () => {
  const h = harness();
  h.state.status = "canceled";
  assert.equal(
    (
      await h.webhook("customer.subscription.updated", {
        id: "sub_hq",
        status: "active",
      })
    ).status,
    200,
  );
  assert.equal(
    h.calls.find((c) => c.name === "sync_hosted_subscription")!.args.p_status,
    "canceled",
  );
});
test("events for another product cannot grant Headquarters access", async () => {
  const h = harness();
  h.state.price = "price_other";
  assert.equal(
    (await h.webhook("customer.subscription.updated", { id: "sub_other" }))
      .status,
    200,
  );
  assert.equal(h.calls.length, 0);
});
test("failed webhook persistence is retryable", async () => {
  const h = harness();
  h.state.rpcError = { message: "DB unavailable" };
  assert.equal(
    (await h.webhook("customer.subscription.updated", { id: "sub_hq" })).status,
    502,
  );
});
test("recovery verifies checkout email and completion before claiming", async () => {
  const h = harness();
  h.state.email = "someone-else@example.test";
  assert.equal(
    (await h.post("/v1/recover", { session_id: "cs_test_known" })).status,
    403,
  );
  h.state.email = "buyer@example.test";
  h.state.sessionStatus = "open";
  assert.equal(
    (await h.post("/v1/recover", { session_id: "cs_test_known" })).status,
    403,
  );
  h.state.sessionStatus = "complete";
  assert.equal(
    (await h.post("/v1/recover", { session_id: "cs_test_known" })).status,
    200,
  );
  assert.ok(h.calls.some((c) => c.name === "recover_hosted_subscription"));
});
test("portal derives customer from authenticated account and pins configuration", async () => {
  const h = harness();
  assert.equal(
    (await h.post("/v1/portal", { customer: "cus_victim" })).status,
    200,
  );
  assert.deepEqual(h.calls.find((c) => c.name === "portal")!.args, {
    customer: "cus_buyer",
    configuration: "bpc_hq",
    return_url: "https://app.headquarters-crm.com/billing",
  });
});
test("portal rejects unauthenticated or unlinked users", async () => {
  const h = harness();
  assert.equal((await h.post("/v1/portal", {}, false)).status, 401);
  h.state.portalCustomer = "";
  assert.equal((await h.post("/v1/portal")).status, 404);
});

test('legacy CORS configuration still includes public customer-facing origins', () => {
 const previous = {...process.env};
 try {
 Object.assign(process.env, {
  STRIPE_SECRET_KEY:'sk_test_config', STRIPE_WEBHOOK_SECRET:'whsec_config', STRIPE_PRICE_HQ_HOSTED:'price_hq',
  SUPABASE_URL:'https://db.example.test', SUPABASE_SERVICE_ROLE_KEY:'local-test',
  CLAIM_HMAC_SECRET:'hash', CLAIM_SHARED_SECRET:'shared', STRIPE_PORTAL_CONFIGURATION:'bpc_hq',
  CRM_URL:'https://headquarters-production-a08d.up.railway.app',
  LANDING_URL:'https://headquarters-web-production-3e78.up.railway.app',
  CORS_ORIGINS:'https://headquarters-web-production-3e78.up.railway.app'
 });
 const env=loadEnv();
 assert.equal(env.crmUrl,'https://app.headquarters-crm.com');
 assert.ok(env.corsOrigins.includes('https://headquarters-crm.com'));
 assert.ok(env.corsOrigins.includes('https://app.headquarters-crm.com'));
 } finally {
 for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
 Object.assign(process.env,previous);
 }
});
