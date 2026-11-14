import type { AppEnv } from "./env";

/** True if this email is on ALLOWED_EMAILS (comma-separated, case-insensitive). */
export function isAllowed(env: Pick<AppEnv, "ALLOWED_EMAILS">, email: string): boolean {
  const allowed = env.ALLOWED_EMAILS.split(",").map((e) => e.trim().toLowerCase());
  return allowed.includes(email.trim().toLowerCase());
}
