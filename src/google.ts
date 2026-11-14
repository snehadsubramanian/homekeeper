/**
 * Google sign-in (OAuth 2.0 authorization-code flow with PKCE) and token
 * refresh, called with plain fetch.
 */
import type { AppEnv } from "./env";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

export const TASKS_SCOPE = "https://www.googleapis.com/auth/tasks";
export const SIGN_IN_SCOPES = `openid email profile ${TASKS_SCOPE}`;

export function redirectUri(env: AppEnv): string {
  return new URL("/auth/callback", env.APP_BASE_URL).toString();
}

export function authorizationUrl(env: AppEnv, state: string, codeChallenge: string): string {
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(env),
    response_type: "code",
    scope: SIGN_IN_SCOPES,
    // offline + consent makes Google return a refresh token on every sign-in.
    access_type: "offline",
    prompt: "select_account consent",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

export interface SignInResult {
  identity: GoogleIdentity;
  accessToken: string;
  /** Null if Google didn't send one this time. */
  refreshToken: string | null;
  grantedScopes: Set<string>;
}

/** The sign-in response was missing, malformed or not meant for this app. */
export class GoogleSignInError extends Error {}

/** A Google API call failed. Never includes token values in its message. */
export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Exchanges the authorization code for tokens and the signed-in identity. */
export async function exchangeCode(env: AppEnv, code: string, codeVerifier: string): Promise<SignInResult> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(env),
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    }).toString(),
  });
  if (!res.ok) throw new GoogleSignInError(`token endpoint returned ${res.status}`);

  const body = (await res.json()) as {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    scope?: string;
  };
  if (!body.id_token || !body.access_token) throw new GoogleSignInError("incomplete token response");

  return {
    identity: identityFromIdToken(env, body.id_token),
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    grantedScopes: new Set((body.scope ?? "").split(" ").filter(Boolean)),
  };
}

/** Trades a stored refresh token for a short-lived access token. */
export async function refreshAccessToken(env: AppEnv, refreshToken: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!res.ok || !body.access_token) {
    throw new GoogleApiError(`token refresh failed: ${body.error ?? `HTTP ${res.status}`}`, res.status);
  }
  return body.access_token;
}

/**
 * Reads and checks the id_token's claims. The token came straight from
 * Google's token endpoint over TLS, so its signature doesn't need checking
 * (Google's OpenID Connect guide allows this), but issuer, audience and expiry do.
 */
function identityFromIdToken(env: AppEnv, idToken: string): GoogleIdentity {
  const payload = idToken.split(".")[1];
  if (!payload) throw new GoogleSignInError("malformed id_token");

  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    throw new GoogleSignInError("unreadable id_token");
  }

  if (!ISSUERS.has(String(claims.iss))) throw new GoogleSignInError("wrong issuer");
  if (claims.aud !== env.GOOGLE_CLIENT_ID) throw new GoogleSignInError("wrong audience");
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) throw new GoogleSignInError("expired");
  if (typeof claims.sub !== "string" || typeof claims.email !== "string") {
    throw new GoogleSignInError("missing sub or email");
  }

  return {
    sub: claims.sub,
    email: claims.email.toLowerCase(),
    emailVerified: claims.email_verified === true,
    name: typeof claims.name === "string" ? claims.name : null,
  };
}
