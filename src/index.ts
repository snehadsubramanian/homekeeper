import app from "./app";
import type { AppEnv } from "./env";
import { CRON_DAILY, CRON_SYNC, runDaily, runSync } from "./jobs";

export default {
  fetch: app.fetch,

  // Cron triggers are listed in wrangler.jsonc.
  async scheduled(controller, env, ctx) {
    if (controller.cron === CRON_SYNC) {
      ctx.waitUntil(runSync(env, new Date(controller.scheduledTime)));
    } else if (controller.cron === CRON_DAILY) {
      ctx.waitUntil(runDaily(env, new Date(controller.scheduledTime)));
    } else {
      console.warn("unknown cron trigger:", controller.cron);
    }
  },
} satisfies ExportedHandler<AppEnv>;
