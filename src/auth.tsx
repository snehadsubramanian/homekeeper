import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { encryptToken } from "./crypto";
import type { AppEnv } from "./env";
import { authorizationUrl, exchangeCode, GoogleApiError, GoogleSignInError, TASKS_SCOPE } from "./google";
import { MessagePage } from "./pages";
import {
  randomToken,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  sha256Base64url,
  signSession,
  verifyCsrf,
  verifySession,
} from "./session";
import { ensureTaskList } from "./tasks";

export interface User {
  id: number;
  email: string;
  display_name: string | null;
  tasklist_id: string | null;
}

export type AppContext = { Bindings: AppEnv; Variables: { user: User } };

const STATE_COOKIE = "oauth_state";
const COOKIE_BASE = { httpOnly: true, secure: true, sameSite: "Lax" } as const;

export function isAllowed(env: AppEnv, email: string): boolean {
  const allowed = env.ALLOWED_EMAILS.split(",").map((e) => e.trim().toLowerCase());
  return allowed.includes(email.trim().toLowerCase());
}

/** The signed-in user, or null if the cookie is missing, invalid, expired or no longer allowed. */
export async function currentUser(c: Context<AppContext>): Promise<User | null> {
  const cookie = getCookie(c, SESSION_COOKIE);
  if (!cookie) return null;
  const userId = await verifySession(c.env.SESSION_KEY, cookie);
  if (userId === null) return null;
  const user = await c.env.DB.prepare("SELECT id, email, display_name, tasklist_id FROM users WHERE id = ?")
    .bind(userId)
    .first<User>();
  if (!user || !isAllowed(c.env, user.email)) return null;
  return user;
}

/** Sends signed-out visitors to the sign-in page. */
export const requireUser: MiddlewareHandler<AppContext> = async (c, next) => {
  const user = await currentUser(c);
  if (!user) return c.redirect("/signin");
  c.set("user", user);
  await next();
};

export const auth = new Hono<AppContext>();

auth.get("/login", async (c) => {
  const state = randomToken();
  const verifier = randomToken();
  setCookie(c, STATE_COOKIE, `${state}.${verifier}`, { ...COOKIE_BASE, path: "/auth", maxAge: 10 * 60 });
  return c.redirect(authorizationUrl(c.env, state, await sha256Base64url(verifier)));
});

auth.get("/callback", async (c) => {
  if (c.req.query("error")) return c.redirect("/signin");

  const saved = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: "/auth" });
  const [savedState, verifier] = saved?.split(".") ?? [];
  const code = c.req.query("code");
  if (!savedState || !verifier || !code || c.req.query("state") !== savedState) {
    return c.html(<MessagePage title="Sign-in failed" message="That sign-in link expired. Please try again." />, 400);
  }

  let signIn;
  try {
    signIn = await exchangeCode(c.env, code, verifier);
  } catch (err) {
    if (!(err instanceof GoogleSignInError)) throw err;
    console.warn("sign-in rejected:", err.message);
    return c.html(<MessagePage title="Sign-in failed" message="Google sign-in didn't complete. Please try again." />, 400);
  }
  const { identity } = signIn;

  if (!identity.emailVerified || !isAllowed(c.env, identity.email)) {
    return c.html(
      <MessagePage title="Not allowed" message="That Google account is not allowed to use homekeeper." />,
      403,
    );
  }

  // Google lets people untick individual permissions; the app is useless without Tasks.
  if (!signIn.grantedScopes.has(TASKS_SCOPE)) {
    return c.html(
      <MessagePage
        title="Tasks access needed"
        message="homekeeper needs permission to manage its own Google Tasks list. Please sign in again and allow access to Google Tasks."
      />,
      403,
    );
  }

  let tasklistId: string;
  try {
    tasklistId = await ensureTaskList(signIn.accessToken, c.env.TASKLIST_NAME);
  } catch (err) {
    if (!(err instanceof GoogleApiError)) throw err;
    console.warn("task list setup failed:", err.message);
    return c.html(
      <MessagePage title="Sign-in failed" message="Couldn't reach Google Tasks. Please try again in a minute." />,
      502,
    );
  }

  const tokenEnc = signIn.refreshToken
    ? await encryptToken(c.env.TOKEN_ENC_KEY, signIn.refreshToken, identity.sub)
    : null;

  const user = await c.env.DB.prepare(
    `INSERT INTO users (email, display_name, google_sub, refresh_token_enc, tasklist_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (google_sub) DO UPDATE SET
       email = excluded.email,
       display_name = excluded.display_name,
       refresh_token_enc = COALESCE(excluded.refresh_token_enc, users.refresh_token_enc),
       tasklist_id = excluded.tasklist_id
     RETURNING id`,
  )
    .bind(identity.email, identity.name, identity.sub, tokenEnc, tasklistId, new Date().toISOString())
    .first<{ id: number }>();
  if (!user) throw new Error("user upsert returned no row");

  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE;
  setCookie(c, SESSION_COOKIE, await signSession(c.env.SESSION_KEY, user.id, expiresAt), {
    ...COOKIE_BASE,
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return c.redirect("/");
});

auth.post("/logout", async (c) => {
  const user = await currentUser(c);
  if (user) {
    const form = await c.req.parseBody();
    const token = typeof form._csrf === "string" ? form._csrf : "";
    if (!(await verifyCsrf(c.env.SESSION_KEY, user.id, token))) {
      return c.html(<MessagePage title="Not allowed" message="That request could not be verified." />, 403);
    }
  }
  deleteCookie(c, SESSION_COOKIE, { ...COOKIE_BASE, path: "/" });
  return c.redirect("/signin");
});
