import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Made-up values for tests only. Real values live in .dev.vars and Cloudflare.
const TEST_VARS = {
  APP_BASE_URL: "http://localhost:8787",
  ALLOWED_EMAILS: "alex@example.com, Sam@Example.com",
  GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  SESSION_KEY: "test-session-key-not-a-real-secret",
};

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: { bindings: { ...TEST_VARS, TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
