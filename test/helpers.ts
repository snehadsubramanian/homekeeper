import { env } from "cloudflare:workers";
import { vi } from "vitest";
import { encryptToken } from "../src/crypto";
import { signSession } from "../src/session";

// Every account and value here is made up.
export const ALLOWED = "alex@example.com";
export const TASKS_SCOPE = "https://www.googleapis.com/auth/tasks";
export const DAY = 24 * 60 * 60;

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const LISTS_PATH = "/tasks/v1/users/@me/lists";

function b64url(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function idToken(claims: Record<string, unknown>): string {
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(claims)}.not-checked`;
}

export function googleClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: "https://accounts.google.com",
    aud: env.GOOGLE_CLIENT_ID,
    sub: "google-sub-alex",
    email: ALLOWED,
    email_verified: true,
    name: "Alex Example",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

export interface FakeGoogleOptions {
  /** Overrides for the id_token returned at sign-in. */
  claims?: Record<string, unknown>;
  /** Refresh token returned at sign-in; null means Google returns none. */
  refreshToken?: string | null;
  /** Space-separated scopes Google says were granted at sign-in. */
  grantedScope?: string;
  /** Task lists that already exist in the account. */
  lists?: { id: string; title: string }[];
  /** If set, every Tasks API call fails with this status. */
  tasksStatus?: number;
  /** Refresh tokens that Google rejects, mapped to the OAuth error code. */
  refreshErrors?: Record<string, string>;
}

export interface FakeCall {
  method: string;
  url: URL;
  body: string;
  authorization: string | null;
}

/** Replaces fetch with a fake Google: sign-in, token refresh and the Tasks list endpoints. */
export function fakeGoogle(opts: FakeGoogleOptions = {}) {
  const lists = [...(opts.lists ?? [])];
  const calls: FakeCall[] = [];

  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = request.method === "GET" ? "" : await request.text();
    calls.push({ method: request.method, url, body, authorization: request.headers.get("authorization") });

    if (url.href === TOKEN_URL) {
      const form = new URLSearchParams(body);
      if (form.get("grant_type") === "refresh_token") {
        const refreshToken = form.get("refresh_token") ?? "";
        const error = opts.refreshErrors?.[refreshToken];
        if (error) return Response.json({ error }, { status: 400 });
        return Response.json({ access_token: `access-for-${refreshToken}`, expires_in: 3599 });
      }
      return Response.json({
        access_token: "test-access-token",
        expires_in: 3599,
        id_token: idToken(googleClaims(opts.claims)),
        scope:
          opts.grantedScope ??
          `openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile ${TASKS_SCOPE}`,
        ...(opts.refreshToken === null ? {} : { refresh_token: opts.refreshToken ?? "test-refresh-token" }),
      });
    }

    if (url.origin === "https://tasks.googleapis.com") {
      if (opts.tasksStatus) return Response.json({ error: { code: opts.tasksStatus } }, { status: opts.tasksStatus });
      if (url.pathname === LISTS_PATH && request.method === "GET") return Response.json({ items: lists });
      if (url.pathname === LISTS_PATH && request.method === "POST") {
        const { title } = JSON.parse(body) as { title: string };
        const list = { id: `list-${lists.length + 1}`, title };
        lists.push(list);
        return Response.json(list);
      }
      const one = url.pathname.startsWith(`${LISTS_PATH}/`) ? decodeURIComponent(url.pathname.slice(LISTS_PATH.length + 1)) : null;
      if (one && request.method === "GET") {
        const list = lists.find((l) => l.id === one);
        return list ? Response.json(list) : Response.json({ error: { code: 404 } }, { status: 404 });
      }
    }

    throw new Error(`unexpected fetch: ${request.method} ${url}`);
  });

  vi.stubGlobal("fetch", mock);
  return { mock, calls, lists };
}

export async function insertUser(
  opts: { email?: string; sub?: string; refreshToken?: string | null; tasklistId?: string | null } = {},
): Promise<number> {
  const sub = opts.sub ?? "google-sub-alex";
  const tokenEnc = opts.refreshToken ? await encryptToken(env.TOKEN_ENC_KEY, opts.refreshToken, sub) : null;
  const row = await env.DB.prepare(
    `INSERT INTO users (email, display_name, google_sub, refresh_token_enc, tasklist_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(opts.email ?? ALLOWED, "Alex Example", sub, tokenEnc, opts.tasklistId ?? null, new Date().toISOString())
    .first<{ id: number }>();
  return row!.id;
}

export async function sessionCookie(userId: number, expiresAt = Math.floor(Date.now() / 1000) + 30 * DAY) {
  return `session=${await signSession(env.SESSION_KEY, userId, expiresAt)}`;
}

export async function resetDatabase() {
  await env.DB.exec("DELETE FROM users; DELETE FROM job_runs;");
}
