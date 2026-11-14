import app from "./app";
import type { AppEnv } from "./env";
import { runTokenRefresh } from "./jobs";

export default {
  fetch: app.fetch,

  // Daily cron (see wrangler.jsonc). For now it only checks Google access.
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runTokenRefresh(env));
  },
} satisfies ExportedHandler<AppEnv>;
