import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createSupabase, loadEnv } from "./lib.js";

// Billing only runs for the hosted offering. Enable the database gate before serving checkout.
// Apply the CRM hosted-billing migration before deploying this service.
const env = loadEnv();
const { error } = await createSupabase(env).rpc("configure_hosted_billing", {
  p_enabled: true,
});
if (error)
  throw new Error("Hosted billing migration/configuration is unavailable");
serve({ fetch: createApp().fetch, port: env.port }, (info) => {
  console.log(`headquarters-billing listening on :${info.port}`);
});
