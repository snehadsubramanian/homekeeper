import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { decryptToken, encryptToken } from "../src/crypto";

const OTHER_KEY = btoa("another-32-byte-key-for-testing!");

describe("refresh-token encryption", () => {
  it("round-trips and never stores the token in plain text", async () => {
    const sealed = await encryptToken(env.TOKEN_ENC_KEY, "test-refresh-token", "google-sub-alex");
    expect(sealed).not.toContain("test-refresh-token");
    expect(await decryptToken(env.TOKEN_ENC_KEY, sealed, "google-sub-alex")).toBe("test-refresh-token");
  });

  it("uses a fresh random IV each time", async () => {
    const a = await encryptToken(env.TOKEN_ENC_KEY, "same", "google-sub-alex");
    const b = await encryptToken(env.TOKEN_ENC_KEY, "same", "google-sub-alex");
    expect(a).not.toBe(b);
  });

  it("fails with the wrong key", async () => {
    const sealed = await encryptToken(env.TOKEN_ENC_KEY, "test-refresh-token", "google-sub-alex");
    await expect(decryptToken(OTHER_KEY, sealed, "google-sub-alex")).rejects.toThrow();
  });

  it("fails if the value is moved to another user's row", async () => {
    const sealed = await encryptToken(env.TOKEN_ENC_KEY, "test-refresh-token", "google-sub-alex");
    await expect(decryptToken(env.TOKEN_ENC_KEY, sealed, "google-sub-sam")).rejects.toThrow();
  });

  it("rejects a key that isn't 32 bytes", async () => {
    await expect(encryptToken(btoa("too-short"), "x", "google-sub-alex")).rejects.toThrow(/32 bytes/);
  });
});
