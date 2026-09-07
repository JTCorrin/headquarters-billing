import type { Context } from "hono";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
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
} from "./lib.js";

export type AppBindings = {
  Variables: { env: Env; stripe: Stripe; supabase: SupabaseClient };
};
type C = Context<AppBindings>;
export function initContext(c: C) {
  const env = loadEnv();
  c.set("env", env);
  c.set("stripe", createStripe(env));
  c.set("supabase", createSupabase(env));
}
async function body(c: C): Promise<Record<string, unknown> | null> {
  try {
    const value = await c.req.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}
const string = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";
const active = (status: string) =>
  ["active", "trialing", "past_due"].includes(status);
const shared = (c: C) =>
  safeEqualString(
    c.req.header("x-claim-secret") ?? "",
    c.get("env").claimSharedSecret,
  );

export async function createCheckoutSession(c: C) {
  const input = await body(c);
  if (!input || ("email" in input && typeof input.email !== "string"))
    return c.json({ error: "Invalid checkout request" }, 400);
  const email = normalizeEmail(string(input.email));
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return c.json({ error: "Invalid email address" }, 400);
  const env = c.get("env"),
    stripe = c.get("stripe"),
    db = c.get("supabase");
  const token = generateClaimToken(),
    hash = hashClaimToken(token, env.claimHmacSecret);
  const { data: row, error } = await db
    .from("hosted_subscriptions")
    .insert({
      email: email || null,
      status: "pending_checkout",
      claim_token_hash: hash,
      claim_expires_at: claimExpiryIso(7),
      seats_included: 3,
    })
    .select("id")
    .single();
  if (error || !row) return c.json({ error: "Could not start checkout" }, 503);
  let session: Stripe.Checkout.Session | undefined;
  try {
    session = await stripe.checkout.sessions.create(
      {
        mode: "subscription",
        line_items: [{ price: env.stripePriceHqHosted, quantity: 1 }],
        success_url: `${env.crmUrl}/signup?claim=${encodeURIComponent(token)}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${env.landingUrl}/#pricing`,
        client_reference_id: row.id,
        metadata: { hosted_subscription_id: row.id, claim_token_hash: hash },
        subscription_data: { metadata: { hosted_subscription_id: row.id } },
        ...(email ? { customer_email: email } : {}),
      },
      { idempotencyKey: `hq-checkout-${row.id}` },
    );
    const saved = await db
      .from("hosted_subscriptions")
      .update({ stripe_checkout_session_id: session.id })
      .eq("id", row.id);
    if (saved.error || !session.url)
      throw new Error("Checkout could not be saved");
    return c.json({ url: session.url, session_id: session.id });
  } catch {
    // Do not leave a payable session whose local linkage was not persisted.
    if (session?.status === "open")
      await stripe.checkout.sessions.expire(session.id);
    await db
      .from("hosted_subscriptions")
      .delete()
      .eq("id", row.id)
      .eq("status", "pending_checkout");
    return c.json({ error: "Could not start checkout. Please retry." }, 502);
  }
}

/** Always fetch current Stripe state; the SQL RPC serializes writes and keeps terminal states terminal. */
export async function syncSubscription(
  c: C,
  id: string,
  checkout?: Stripe.Checkout.Session,
) {
  const observedAt = new Date().toISOString();
  const sub = await c.get("stripe").subscriptions.retrieve(id);
  if (
    !sub.items.data.some(
      (item) => item.price.id === c.get("env").stripePriceHqHosted,
    )
  )
    return;
  const hostedId = sub.metadata.hosted_subscription_id;
  if (!hostedId) return; // This Stripe account can contain unrelated products.
  if (
    checkout &&
    (checkout.metadata?.hosted_subscription_id !== hostedId ||
      checkout.mode !== "subscription")
  )
    throw new Error("Checkout metadata mismatch");
  const { error } = await c.get("supabase").rpc("sync_hosted_subscription", {
    p_hosted_id: hostedId,
    p_subscription_id: sub.id,
    p_customer_id:
      typeof sub.customer === "string" ? sub.customer : sub.customer.id,
    p_status: mapStripeSubscriptionStatus(sub.status),
    p_observed_at: observedAt,
    p_checkout_id: checkout?.id ?? null,
    p_email:
      checkout?.customer_details?.email ?? checkout?.customer_email ?? null,
  });
  if (error) throw new Error("Subscription synchronization failed");
}
async function syncCheckout(c: C, session: Stripe.Checkout.Session) {
  if (session.mode !== "subscription" || session.status !== "complete") return;
  const id =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription?.id;
  if (id) await syncSubscription(c, id, session);
}
export async function handleStripeWebhook(c: C) {
  const signature = c.req.header("stripe-signature");
  if (!signature) return c.json({ error: "Missing stripe-signature" }, 400);
  let event: Stripe.Event;
  try {
    event = c
      .get("stripe")
      .webhooks.constructEvent(
        await c.req.text(),
        signature,
        c.get("env").stripeWebhookSecret,
      );
  } catch {
    return c.json({ error: "Invalid signature" }, 400);
  }
  if (event.livemode !== /^(sk|rk)_live_/.test(c.get("env").stripeSecretKey))
    return c.json({ error: "Stripe mode mismatch" }, 400);
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
    case "checkout.session.async_payment_failed": {
      const session = await c
        .get("stripe")
        .checkout.sessions.retrieve(
          (event.data.object as Stripe.Checkout.Session).id,
        );
      await syncCheckout(c, session);
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await syncSubscription(c, (event.data.object as Stripe.Subscription).id);
      break;
    case "invoice.paid":
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const sub = invoice.parent?.subscription_details?.subscription;
      const id = typeof sub === "string" ? sub : sub?.id;
      if (id) await syncSubscription(c, id);
      break;
    }
  }
  return c.json({ received: true });
}

type Claim = {
  id: string;
  email: string | null;
  status: string;
  claim_expires_at: string;
  claimed_at: string | null;
  user_id: string | null;
  seats_included: number;
  stripe_checkout_session_id?: string | null;
};
async function readClaim(c: C, token: string): Promise<Claim | null> {
  const { data, error } = await c
    .get("supabase")
    .rpc("lookup_hosted_claim", {
      p_claim_token_hash: hashClaimToken(token, c.get("env").claimHmacSecret),
    });
  if (error) throw new Error("Claim lookup unavailable");
  return data;
}
export async function lookupClaim(c: C) {
  const token = string(c.req.query("token"));
  if (!token || token.length > 256)
    return c.json({ error: "Missing or invalid token" }, 400);
  let claim = await readClaim(c, token);
  if (!claim) return c.json({ error: "Claim not found" }, 404);
  // Reconcile on landing as well as via webhooks, but only for a known secret claim.
  if (claim.status === "pending_checkout" && claim.stripe_checkout_session_id) {
    await syncCheckout(
      c,
      await c
        .get("stripe")
        .checkout.sessions.retrieve(claim.stripe_checkout_session_id),
    );
    claim = await readClaim(c, token);
  }
  if (!claim) return c.json({ error: "Claim not found" }, 404);
  const expired = new Date(claim.claim_expires_at).getTime() < Date.now();
  return c.json({
    id: claim.id,
    email: claim.email,
    status: claim.status,
    claim_expires_at: claim.claim_expires_at,
    expired,
    already_claimed: !!claim.user_id,
    usable: active(claim.status) && !expired && !claim.user_id,
    seats_included: claim.seats_included,
  });
}
async function authenticatedUser(c: C) {
  if (!shared(c)) return null;
  const match = c.req.header("Authorization")?.match(/^Bearer (.+)$/i);
  if (!match) return null;
  const { data, error } = await c.get("supabase").auth.getUser(match[1]);
  return !error && data.user?.email ? data.user : null;
}
export async function claimSubscription(c: C) {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);
  const input = await body(c),
    token = string(input?.token);
  if (!token || token.length > 256)
    return c.json({ error: "A payment claim token is required" }, 400);
  const { data, error } = await c
    .get("supabase")
    .rpc("claim_hosted_subscription", {
      p_claim_token_hash: hashClaimToken(token, c.get("env").claimHmacSecret),
      p_user_id: user.id,
      p_email: normalizeEmail(user.email!),
    });
  if (error) throw new Error("Claim unavailable");
  if (!data?.ok)
    return c.json(
      { error: data?.error ?? "Claim failed" },
      data?.status ?? 400,
    );
  return c.json({ ok: true, id: data.id });
}
export async function recoverSubscription(c: C) {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);
  const input = await body(c),
    sessionId = string(input?.session_id);
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId))
    return c.json(
      { error: "Enter the checkout reference from your payment return URL" },
      400,
    );
  const session = await c.get("stripe").checkout.sessions.retrieve(sessionId);
  const email = session.customer_details?.email ?? session.customer_email;
  if (
    !email ||
    normalizeEmail(email) !== normalizeEmail(user.email!) ||
    session.status !== "complete"
  )
    return c.json(
      { error: "No completed checkout matching this account" },
      403,
    );
  await syncCheckout(c, session);
  const { data, error } = await c
    .get("supabase")
    .rpc("recover_hosted_subscription", {
      p_checkout_id: session.id,
      p_user_id: user.id,
      p_email: normalizeEmail(user.email!),
    });
  if (error) throw new Error("Recovery unavailable");
  if (!data?.ok)
    return c.json(
      { error: data?.error ?? "Recovery failed" },
      data?.status ?? 400,
    );
  return c.json({ ok: true });
}
export async function createPortalSession(c: C) {
  const user = await authenticatedUser(c);
  if (!user) return c.json({ error: "Not authenticated" }, 401);
  const input = await body(c);
 const subscriptionId = string(input?.subscription_id);
 let query = c
    .get("supabase")
    .from("hosted_subscriptions")
    .select("stripe_customer_id")
    .eq("user_id", user.id)
    .not("stripe_customer_id", "is", null)
    .order("claimed_at", { ascending: false })
    .limit(1);
  if (subscriptionId) query = query.eq("id", subscriptionId);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error("Billing lookup unavailable");
  if (!data?.stripe_customer_id)
    return c.json(
      { error: "No linked subscription. Recover your payment first." },
      404,
    );
  const env = c.get("env");
  const session = await c
    .get("stripe")
    .billingPortal.sessions.create({
      customer: data.stripe_customer_id,
      configuration: env.stripePortalConfiguration,
      return_url: `${env.crmUrl}/billing`,
    });
  return c.json({ url: session.url });
}
export async function entitlementForUser(c: C) {
  if (!shared(c)) return c.json({ error: "Unauthorized" }, 401);
  const userId = string(c.req.query("user_id"));
  if (!userId) return c.json({ error: "Missing user_id" }, 400);
  const { data, error } = await c
    .get("supabase")
    .rpc("hosted_entitlement_for_user", { p_user_id: userId });
  if (error) throw new Error("Entitlement lookup unavailable");
  return c.json({ entitlement: data ?? null });
}
