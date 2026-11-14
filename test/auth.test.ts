import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { decryptToken } from "../src/crypto";
import {
  ALLOWED,
  DAY,
  type FakeGoogleOptions,
  fakeGoogle,
  insertUser,
  resetDatabase,
  sessionCookie,
  TASKS_SCOPE,
} from "./helpers";

function cookieFrom(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
}

async function startLogin() {
  const res = await app.request("/auth/login", {}, env);
  const stateCookie = cookieFrom(res, "oauth_state");
  const state = new URL(res.headers.get("location") ?? "").searchParams.get("state");
  return { res, cookie: stateCookie?.split(";")[0] ?? "", state: state ?? "" };
}

async function completeLogin(opts: FakeGoogleOptions = {}) {
  const { cookie, state } = await startLogin();
  const google = fakeGoogle(opts);
  const res = await app.request(`/auth/callback?code=test-code&state=${state}`, { headers: { cookie } }, env);
  return { res, google };
}

async function userCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(resetDatabase);
afterEach(() => vi.unstubAllGlobals());

describe("signed-out visitors", () => {
  it("are sent from / to the sign-in page", async () => {
    const res = await app.request("/", {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/signin");
  });

  it("see a sign-in page that links to Google sign-in and the privacy policy", async () => {
    const res = await app.request("/signin", {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/auth/login"');
    expect(html).toContain('href="/privacy"');
  });

  it("can read the privacy policy without signing in", async () => {
    const res = await app.request("/privacy", {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Privacy policy");
    expect(html).toContain("Google API Services User Data Policy");
  });
});

describe("GET /auth/login", () => {
  it("redirects to Google asking for identity and offline Tasks access, with state and PKCE", async () => {
    const { res, cookie, state } = await startLogin();
    expect(res.status).toBe(302);

    const url = new URL(res.headers.get("location") ?? "");
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(env.GOOGLE_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(`${env.APP_BASE_URL}/auth/callback`);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe(`openid email profile ${TASKS_SCOPE}`);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("select_account consent");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(state).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(cookie).toMatch(/^oauth_state=/);

    const raw = cookieFrom(res, "oauth_state") ?? "";
    expect(raw).toContain("HttpOnly");
    expect(raw).toContain("Secure");
    expect(raw).toContain("SameSite=Lax");
  });
});

describe("GET /auth/callback", () => {
  it("signs in an allowed account, creates the user and sets a 30-day session cookie", async () => {
    const { res, google } = await completeLogin();

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");

    const session = cookieFrom(res, "session") ?? "";
    expect(session).toContain("HttpOnly");
    expect(session).toContain("Secure");
    expect(session).toContain("SameSite=Lax");
    expect(session).toContain(`Max-Age=${30 * DAY}`);

    const user = await env.DB.prepare("SELECT email, display_name, google_sub FROM users").first();
    expect(user).toEqual({ email: ALLOWED, display_name: "Alex Example", google_sub: "google-sub-alex" });

    // The code is exchanged with the client secret and the PKCE verifier.
    const exchange = google.calls[0]!;
    expect(exchange.url.href).toBe("https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(exchange.body);
    expect(body.get("code")).toBe("test-code");
    expect(body.get("client_secret")).toBe(env.GOOGLE_CLIENT_SECRET);
    expect(body.get("redirect_uri")).toBe(`${env.APP_BASE_URL}/auth/callback`);
    expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  });

  it("stores the refresh token encrypted, never in plain text", async () => {
    await completeLogin({ refreshToken: "test-refresh-token" });

    const row = await env.DB.prepare("SELECT refresh_token_enc FROM users").first<{ refresh_token_enc: string }>();
    expect(row!.refresh_token_enc).toBeTruthy();
    expect(row!.refresh_token_enc).not.toContain("test-refresh-token");
    expect(await decryptToken(env.TOKEN_ENC_KEY, row!.refresh_token_enc, "google-sub-alex")).toBe("test-refresh-token");
  });

  it("keeps the stored refresh token when Google doesn't send a new one", async () => {
    await completeLogin({ refreshToken: "first-refresh-token" });
    await completeLogin({ refreshToken: null });

    const row = await env.DB.prepare("SELECT refresh_token_enc FROM users").first<{ refresh_token_enc: string }>();
    expect(await decryptToken(env.TOKEN_ENC_KEY, row!.refresh_token_enc, "google-sub-alex")).toBe("first-refresh-token");
  });

  it("creates the task list named by TASKLIST_NAME when it doesn't exist, and stores its id", async () => {
    const { google } = await completeLogin({ lists: [{ id: "other", title: "My own list" }] });

    const create = google.calls.find((c) => c.method === "POST" && c.url.origin === "https://tasks.googleapis.com");
    expect(create).toBeDefined();
    expect(JSON.parse(create!.body)).toEqual({ title: env.TASKLIST_NAME });
    expect(create!.authorization).toBe("Bearer test-access-token");

    const row = await env.DB.prepare("SELECT tasklist_id FROM users").first();
    expect(row).toEqual({ tasklist_id: "list-2" });
  });

  it("reuses an existing list with that name instead of creating another", async () => {
    const { google } = await completeLogin({ lists: [{ id: "existing", title: env.TASKLIST_NAME }] });

    expect(google.calls.some((c) => c.method === "POST" && c.url.origin === "https://tasks.googleapis.com")).toBe(false);
    const row = await env.DB.prepare("SELECT tasklist_id FROM users").first();
    expect(row).toEqual({ tasklist_id: "existing" });
  });

  it("refuses sign-in when Tasks access wasn't granted, storing nothing", async () => {
    const { res, google } = await completeLogin({
      grantedScope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile",
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Google Tasks");
    expect(cookieFrom(res, "session")).toBeUndefined();
    expect(await userCount()).toBe(0);
    expect(google.calls.some((c) => c.url.origin === "https://tasks.googleapis.com")).toBe(false);
  });

  it("fails sign-in cleanly when Google Tasks can't be reached", async () => {
    const { res } = await completeLogin({ tasksStatus: 503 });
    expect(res.status).toBe(502);
    expect(cookieFrom(res, "session")).toBeUndefined();
    expect(await userCount()).toBe(0);
  });

  it("matches the allow-list case-insensitively", async () => {
    const { res } = await completeLogin({ claims: { email: "SAM@example.COM", sub: "google-sub-sam" } });
    expect(res.status).toBe(302);
    expect(await userCount()).toBe(1);
  });

  it("updates the existing user on a second sign-in instead of adding another", async () => {
    await completeLogin();
    await completeLogin({ claims: { name: "Alex Renamed" }, lists: [{ id: "list-1", title: env.TASKLIST_NAME }] });
    expect(await userCount()).toBe(1);
    const user = await env.DB.prepare("SELECT display_name FROM users").first();
    expect(user).toEqual({ display_name: "Alex Renamed" });
  });

  it("refuses an account that is not on the allow-list, with no session and no user", async () => {
    const { res, google } = await completeLogin({ claims: { email: "stranger@example.net", sub: "google-sub-x" } });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("not allowed");
    expect(cookieFrom(res, "session")).toBeUndefined();
    expect(await userCount()).toBe(0);
    expect(google.calls.some((c) => c.url.origin === "https://tasks.googleapis.com")).toBe(false);
  });

  it("refuses an unverified email address", async () => {
    const { res } = await completeLogin({ claims: { email_verified: false } });
    expect(res.status).toBe(403);
    expect(cookieFrom(res, "session")).toBeUndefined();
  });

  it("rejects an id_token issued for a different client", async () => {
    const { res } = await completeLogin({ claims: { aud: "someone-else.apps.googleusercontent.com" } });
    expect(res.status).toBe(400);
    expect(cookieFrom(res, "session")).toBeUndefined();
  });

  it("rejects a callback whose state doesn't match, without calling Google", async () => {
    const { cookie } = await startLogin();
    const google = fakeGoogle();
    const res = await app.request("/auth/callback?code=test-code&state=forged", { headers: { cookie } }, env);
    expect(res.status).toBe(400);
    expect(google.mock).not.toHaveBeenCalled();
  });

  it("rejects a callback with no state cookie", async () => {
    const { state } = await startLogin();
    fakeGoogle();
    const res = await app.request(`/auth/callback?code=test-code&state=${state}`, {}, env);
    expect(res.status).toBe(400);
  });

  it("returns to the sign-in page when the user cancels at Google", async () => {
    const res = await app.request("/auth/callback?error=access_denied", {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/signin");
  });
});

describe("sessions", () => {
  it("let a signed-in user see the home page with a sign-out form", async () => {
    const id = await insertUser();
    const res = await app.request("/", { headers: { cookie: await sessionCookie(id) } }, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(ALLOWED);
    expect(html).toMatch(/<form[^>]*method="post"[^>]*action="\/auth\/logout"/);
    expect(html).toMatch(/name="_csrf" value="[A-Za-z0-9_-]+"/);
  });

  it("reject a tampered cookie", async () => {
    const id = await insertUser();
    const forged = (await sessionCookie(id)).replace(`session=${id}.`, `session=${id + 1}.`);
    const res = await app.request("/", { headers: { cookie: forged } }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/signin");
  });

  it("reject a malformed cookie without crashing", async () => {
    await insertUser();
    const res = await app.request("/", { headers: { cookie: "session=1.9999999999.wrong" } }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/signin");
  });

  it("reject an expired session", async () => {
    const id = await insertUser();
    const cookie = await sessionCookie(id, Math.floor(Date.now() / 1000) - 1);
    const res = await app.request("/", { headers: { cookie } }, env);
    expect(res.status).toBe(302);
  });

  it("end when the user is removed from the allow-list", async () => {
    const id = await insertUser();
    const res = await app.request(
      "/",
      { headers: { cookie: await sessionCookie(id) } },
      { ...env, ALLOWED_EMAILS: "someone-else@example.com" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/signin");
  });
});

describe("home page Google status", () => {
  it("says the daily check hasn't run yet", async () => {
    const id = await insertUser({ tasklistId: "list-a" });
    const html = await (await app.request("/", { headers: { cookie: await sessionCookie(id) } }, env)).text();
    expect(html).toContain(`Task list: ${env.TASKLIST_NAME}`);
    expect(html).toContain("Daily Google check: not run yet");
  });

  it("shows the latest daily check and whether it worked", async () => {
    const id = await insertUser({ tasklistId: "list-a" });
    await env.DB.prepare(
      `INSERT INTO job_runs (job, started_at, finished_at, ok, error) VALUES
       ('token_refresh', '2026-11-19T09:00:00.000Z', '2026-11-19T09:00:01.000Z', 0, 'user 1: invalid_grant'),
       ('token_refresh', '2026-11-20T09:00:00.000Z', '2026-11-20T09:00:02.000Z', 1, NULL)`,
    ).run();
    const html = await (await app.request("/", { headers: { cookie: await sessionCookie(id) } }, env)).text();
    expect(html).toContain("Daily Google check: OK, last ran 2026-11-20 09:00 UTC");
  });

  it("shows the error when the latest daily check failed", async () => {
    const id = await insertUser({ tasklistId: "list-a" });
    await env.DB.prepare(
      `INSERT INTO job_runs (job, started_at, finished_at, ok, error)
       VALUES ('token_refresh', '2026-11-20T09:00:00.000Z', '2026-11-20T09:00:02.000Z', 0, 'user 1: invalid_grant')`,
    ).run();
    const html = await (await app.request("/", { headers: { cookie: await sessionCookie(id) } }, env)).text();
    expect(html).toContain("Daily Google check: FAILED, last ran 2026-11-20 09:00 UTC (user 1: invalid_grant)");
  });
});

describe("POST /auth/logout", () => {
  async function csrfFor(cookie: string): Promise<string> {
    const html = await (await app.request("/", { headers: { cookie } }, env)).text();
    return /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
  }

  it("clears the session when the CSRF token is valid", async () => {
    const cookie = await sessionCookie(await insertUser());
    const res = await app.request(
      "/auth/logout",
      { method: "POST", headers: { cookie }, body: new URLSearchParams({ _csrf: await csrfFor(cookie) }) },
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/signin");
    expect(cookieFrom(res, "session")).toMatch(/Max-Age=0/);
  });

  it("refuses a request without a valid CSRF token", async () => {
    const cookie = await sessionCookie(await insertUser());
    const res = await app.request(
      "/auth/logout",
      { method: "POST", headers: { cookie }, body: new URLSearchParams({ _csrf: "wrong" }) },
      env,
    );
    expect(res.status).toBe(403);
    expect(cookieFrom(res, "session")).toBeUndefined();
  });
});
