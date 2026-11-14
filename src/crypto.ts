/**
 * Encryption of Google refresh tokens at rest (AES-256-GCM).
 *
 * The key is TOKEN_ENC_KEY: base64 of 32 random bytes, held only as a Worker
 * secret. Each value is bound to its owner's Google account id (as GCM
 * additional data), so a value copied into another user's row won't decrypt.
 *
 * Stored format: `v1.<iv>.<ciphertext>`, both parts base64url.
 */
import { base64url, fromBase64url } from "./session";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function importKey(keyBase64: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = Uint8Array.from(atob(keyBase64), (ch) => ch.charCodeAt(0));
  } catch {
    raw = new Uint8Array(0);
  }
  if (raw.length !== 32) throw new Error("TOKEN_ENC_KEY must be base64 of exactly 32 bytes");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function additionalData(owner: string): Uint8Array {
  return encoder.encode(`homekeeper:refresh-token:${owner}`);
}

export async function encryptToken(keyBase64: string, plaintext: string, owner: string): Promise<string> {
  const key = await importKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalData(owner) },
    key,
    encoder.encode(plaintext),
  );
  return `v1.${base64url(iv)}.${base64url(ciphertext)}`;
}

/** Throws if the value was tampered with, belongs to another owner, or the key is wrong. */
export async function decryptToken(keyBase64: string, sealed: string, owner: string): Promise<string> {
  const key = await importKey(keyBase64);
  const [version, ivText, dataText, ...rest] = sealed.split(".");
  const iv = ivText ? fromBase64url(ivText) : null;
  const data = dataText ? fromBase64url(dataText) : null;
  if (version !== "v1" || rest.length > 0 || !iv || !data) throw new Error("unreadable encrypted token");

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: additionalData(owner) },
      key,
      data,
    );
    return decoder.decode(plaintext);
  } catch {
    throw new Error("could not decrypt refresh token");
  }
}
