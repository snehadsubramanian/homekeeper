import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../src/app";

describe("skeleton", () => {
  it("serves an HTML page", async () => {
    const res = await app.request("/signin", {}, env);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("homekeeper");
  });

  it("has a reachable D1 database with the migrated schema", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name",
    ).all();

    expect(results).toEqual([{ name: "job_runs" }, { name: "users" }]);
  });
});
