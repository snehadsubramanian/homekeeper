import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../src/index";

describe("deployed skeleton", () => {
  it("serves the hello page at /", async () => {
    const res = await app.request("/", {}, env);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("homekeeper");
  });

  it("has a reachable D1 database with no app tables yet", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    ).all();

    expect(results).toEqual([]);
  });
});
