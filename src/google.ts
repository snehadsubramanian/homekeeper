/**
 * Google sign-in (OAuth 2.0 authorization-code flow with PKCE), called with
 * plain fetch. Step 2a asks only for identity; later steps add the Tasks scope.
 */
import type { AppEnv } from "./env";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
export const SIGN_IN_SCOPES = "openid email profile";

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
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return url.toString();
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

export class GoogleSignInError extends Error {}

/** Exchanges the authorization code and returns the signed-in identity. */
export async function exchangeCode(env: AppEnv, code: string, codeVerifier: string): Promise<GoogleIdentity> {
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

  const body = (await res.json()) as { id_token?: string };
  if (!body.id_token) throw new GoogleSignInError("no id_token in token response");
  return identityFromIdToken(env, body.id_token);
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
