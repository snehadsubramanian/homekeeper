/**
 * Variables and secrets the app reads. None of them live in wrangler.jsonc:
 * locally they come from .dev.vars, in production from Cloudflare
 * (variables in the dashboard, secrets via `wrangler secret put`).
 */
export interface AppVars {
  /** The app's own address, e.g. http://localhost:8787. Never hard-code it. */
  APP_BASE_URL: string;
  /** Comma-separated email addresses that may sign in. */
  ALLOWED_EMAILS: string;
  GOOGLE_CLIENT_ID: string;
  /** Secret. */
  GOOGLE_CLIENT_SECRET: string;
  /** Secret. Signs session cookies and CSRF tokens. */
  SESSION_KEY: string;
}

export type AppEnv = Env & AppVars;
