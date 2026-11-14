import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { signSession } from "../src/session";

// Test values come from vitest.config.ts; every address is made up.
const ALLOWED = "alex@example.com";
const DAY = 24 * 60 * 60;

function b64url(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function idToken(claims: Record<string, unknown>): string {
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(claims)}.not-checked`;
}

function googleClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

/** Replaces fetch so Google's token endpoint returns an id_token with these claims. */
function stubGoogleToken(claims: Record<string, unknown>) {
  const mock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({ access_token: "test-access-token", id_token: idToken(claims), expires_in: 3599 }),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

function cookieFrom(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
}

async function startLogin() {
  const res = await app.request("/auth/login", {}, env);
  const stateCookie = cookieFrom(res, "oauth_state");
  const state = new URL(res.headers.get("location") ?? "").searchParams.get("state");
  return { res, cookie: stateCookie?.split(";")[0] ?? "", state: state ?? "" };
}

async function completeLogin(claims: Record<string, unknown>) {
  const { cookie, state } = await startLogin();
  const fetchMock = stubGoogleToken(claims);
  const res = await app.request(`/auth/callback?code=test-code&state=${state}`, { headers: { cookie } }, env);
  return { res, fetchMock };
}

async function userCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
  return row?.n ?? 0;
}

async function insertUser(email = ALLOWED): Promise<number> {
  const row = await env.DB.prepare(
    "INSERT INTO users (email, display_name, google_sub, created_at) VALUES (?, ?, ?, ?) RETURNING id",
  )
    .bind(email, "Alex Example", "google-sub-alex", new Date().toISOString())
    .first<{ id: number }>();
  return row!.id;
}

async function sessionCookie(userId: number, expiresAt = Math.floor(Date.now() / 1000) + 30 * DAY) {
  return `session=${await signSession(env.SESSION_KEY, userId, expiresAt)}`;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM users");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("signed-out visitors", () => {
  it("are sent from / to the sign-in page", async () => {
    const res = await app.request("/", {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/signin");
  });

  it("see a sign-in page that links to Google sign-in", async () => {
    const res = await app.request("/signin", {}, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('href="/auth/login"');
  });
});

describe("GET /auth/login", () => {
  it("redirects to Google with the app's callback, minimal scopes, state and PKCE", async () => {
    const { res, cookie, state } = await startLogin();
    expect(res.status).toBe(302);

    const url = new URL(res.headers.get("location") ?? "");
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(env.GOOGLE_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(`${env.APP_BASE_URL}/auth/callback`);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
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
    const { res, fetchMock } = await completeLogin(googleClaims());

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
    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).toBe("https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("code")).toBe("test-code");
    expect(body.get("client_secret")).toBe(env.GOOGLE_CLIENT_SECRET);
    expect(body.get("redirect_uri")).toBe(`${env.APP_BASE_URL}/auth/callback`);
    expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  });

  it("matches the allow-list case-insensitively", async () => {
    const { res } = await completeLogin(googleClaims({ email: "SAM@example.COM", sub: "google-sub-sam" }));
    expect(res.status).toBe(302);
    expect(await userCount()).toBe(1);
  });

  it("updates the existing user on a second sign-in instead of adding another", async () => {
    await completeLogin(googleClaims());
    await completeLogin(googleClaims({ name: "Alex Renamed" }));
    expect(await userCount()).toBe(1);
    const user = await env.DB.prepare("SELECT display_name FROM users").first();
    expect(user).toEqual({ display_name: "Alex Renamed" });
  });

  it("refuses an account that is not on the allow-list, with no session and no user", async () => {
    const { res } = await completeLogin(googleClaims({ email: "stranger@example.net", sub: "google-sub-x" }));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("not allowed");
    expect(cookieFrom(res, "session")).toBeUndefined();
    expect(await userCount()).toBe(0);
  });

  it("refuses an unverified email address", async () => {
    const { res } = await completeLogin(googleClaims({ email_verified: false }));
    expect(res.status).toBe(403);
    expect(cookieFrom(res, "session")).toBeUndefined();
  });

  it("rejects an id_token issued for a different client", async () => {
    const { res } = await completeLogin(googleClaims({ aud: "someone-else.apps.googleusercontent.com" }));
    expect(res.status).toBe(400);
    expect(cookieFrom(res, "session")).toBeUndefined();
  });

  it("rejects a callback whose state doesn't match, without calling Google", async () => {
    const { cookie } = await startLogin();
    const fetchMock = stubGoogleToken(googleClaims());
    const res = await app.request("/auth/callback?code=test-code&state=forged", { headers: { cookie } }, env);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a callback with no state cookie", async () => {
    const { state } = await startLogin();
    stubGoogleToken(googleClaims());
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
