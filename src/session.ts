/**
 * Signed session cookies and CSRF tokens, using HMAC-SHA256 with SESSION_KEY.
 *
 * A session cookie holds `<userId>.<expiresAt>.<signature>`, where expiresAt is
 * Unix seconds. Nothing else about the user is stored client-side.
 */

export const SESSION_COOKIE = "session";
export const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

const encoder = new TextEncoder();

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  } catch {
    return null; // not valid base64, e.g. a forged token of the wrong length
  }
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

async function sign(secret: string, message: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(message));
  return base64url(signature);
}

/** Constant-time check, via crypto.subtle.verify. */
async function verify(secret: string, message: string, signature: string): Promise<boolean> {
  const bytes = fromBase64url(signature);
  if (!bytes) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(secret), bytes, encoder.encode(message));
}

export async function signSession(secret: string, userId: number, expiresAt: number): Promise<string> {
  const payload = `${userId}.${expiresAt}`;
  return `${payload}.${await sign(secret, payload)}`;
}

/** Returns the user id from a valid, unexpired session value, or null. */
export async function verifySession(
  secret: string,
  value: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<number | null> {
  const [id, expiresAt, signature, ...rest] = value.split(".");
  if (rest.length > 0 || !id || !expiresAt || !signature) return null;
  if (!/^\d+$/.test(id) || !/^\d+$/.test(expiresAt)) return null;
  if (!(await verify(secret, `${id}.${expiresAt}`, signature))) return null;
  if (Number(expiresAt) <= nowSeconds) return null;
  return Number(id);
}

/** A per-session CSRF token that every state-changing form must carry. */
export function csrfToken(secret: string, userId: number): Promise<string> {
  return sign(secret, `csrf:${userId}`);
}

export function verifyCsrf(secret: string, userId: number, token: string): Promise<boolean> {
  return verify(secret, `csrf:${userId}`, token);
}

/** A random URL-safe string with the given number of bytes of entropy. */
export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Base64url(text: string): Promise<string> {
  return base64url(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}
