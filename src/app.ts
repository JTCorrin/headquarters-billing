import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import {
  createCheckoutSession,
  handleStripeWebhook,
  lookupClaim,
  claimSubscription,
  entitlementForUser,
  createPortalSession,
  recoverSubscription,
  initContext,
  type AppBindings,
} from "./handlers.js";

export function createApp(initialize = initContext) {
  const app = new Hono<AppBindings>();
  app.get("/health", (c) =>
    c.json({ ok: true, service: "headquarters-billing" }),
  );
  app.use("/v1/*", bodyLimit({ maxSize: 256 * 1024 }));
  app.use("/v1/*", async (c, next) => {
    try {
      initialize(c);
    } catch {
      return c.json({ error: "Server misconfigured" }, 503);
    }
    c.header("Cache-Control", "no-store");
    const env = c.get("env");
    return cors({
      origin: (origin) => (env.corsOrigins.includes(origin) ? origin : ""),
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "x-claim-secret"],
    })(c, next);
  });
  app.post("/v1/checkout", createCheckoutSession);
  app.post("/v1/webhooks/stripe", handleStripeWebhook);
  app.get("/v1/claim", lookupClaim);
  app.post("/v1/claim", claimSubscription);
  app.post("/v1/recover", recoverSubscription);
  app.post("/v1/portal", createPortalSession);
  app.get("/v1/entitlement", entitlementForUser);
  app.onError((error, c) => {
    console.error(
      "Billing request failed",
      error instanceof Error ? error.name : "Unknown",
    );
    return c.json(
      { error: "Billing is temporarily unavailable. Please retry." },
      502,
    );
  });
  return app;
}
