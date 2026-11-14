import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { runTokenRefresh } from "../src/jobs";
import { fakeGoogle, insertUser, resetDatabase } from "./helpers";

interface JobRun {
  job: string;
  started_at: string;
  finished_at: string | null;
  ok: number | null;
  error: string | null;
}

async function jobRuns(): Promise<JobRun[]> {
  const { results } = await env.DB.prepare(
    "SELECT job, started_at, finished_at, ok, error FROM job_runs ORDER BY id",
  ).all<JobRun>();
  return results;
}

beforeEach(resetDatabase);
afterEach(() => vi.unstubAllGlobals());

describe("daily token refresh", () => {
  it("refreshes each user's token, reads their task list and logs a successful run", async () => {
    const google = fakeGoogle({ lists: [{ id: "list-a", title: "Household duties (test)" }] });
    await insertUser({ sub: "google-sub-alex", refreshToken: "rt-alex", tasklistId: "list-a" });
    await insertUser({ email: "sam@example.com", sub: "google-sub-sam", refreshToken: "rt-sam", tasklistId: "list-a" });

    await runTokenRefresh(env);

    const refreshes = google.calls.filter((c) => c.url.href === "https://oauth2.googleapis.com/token");
    expect(refreshes.map((c) => new URLSearchParams(c.body).get("refresh_token")).sort()).toEqual(["rt-alex", "rt-sam"]);
    const listReads = google.calls.filter((c) => c.url.pathname.endsWith("/lists/list-a"));
    expect(listReads.map((c) => c.authorization).sort()).toEqual(["Bearer access-for-rt-alex", "Bearer access-for-rt-sam"]);

    const [run] = await jobRuns();
    expect(run).toMatchObject({ job: "token_refresh", ok: 1, error: null });
    expect(run!.finished_at).not.toBeNull();
    expect(run!.started_at <= run!.finished_at!).toBe(true);
  });

  it("logs a failure when Google rejects a token, and still checks everyone else", async () => {
    const google = fakeGoogle({ lists: [{ id: "list-a", title: "x" }], refreshErrors: { "rt-alex": "invalid_grant" } });
    const alex = await insertUser({ sub: "google-sub-alex", refreshToken: "rt-alex", tasklistId: "list-a" });
    await insertUser({ email: "sam@example.com", sub: "google-sub-sam", refreshToken: "rt-sam", tasklistId: "list-a" });

    await runTokenRefresh(env);

    expect(google.calls.filter((c) => c.url.href === "https://oauth2.googleapis.com/token")).toHaveLength(2);
    const [run] = await jobRuns();
    expect(run!.ok).toBe(0);
    expect(run!.error).toContain(`user ${alex}`);
    expect(run!.error).toContain("invalid_grant");
    expect(run!.error).not.toContain("rt-alex");
  });

  it("logs a failure when the user's task list is gone", async () => {
    fakeGoogle({ lists: [] });
    await insertUser({ refreshToken: "rt-alex", tasklistId: "list-deleted" });

    await runTokenRefresh(env);

    const [run] = await jobRuns();
    expect(run!.ok).toBe(0);
    expect(run!.error).toContain("task list");
  });

  it("skips users who haven't granted Tasks access yet", async () => {
    const google = fakeGoogle();
    await insertUser({ refreshToken: null });

    await runTokenRefresh(env);

    expect(google.calls).toHaveLength(0);
    const [run] = await jobRuns();
    expect(run).toMatchObject({ ok: 1, error: null });
  });

  it("leaves alone anyone who has been removed from the allow-list", async () => {
    const google = fakeGoogle({ lists: [{ id: "list-a", title: "x" }] });
    await insertUser({ sub: "google-sub-alex", refreshToken: "rt-alex", tasklistId: "list-a" });
    await insertUser({ email: "removed@example.net", sub: "google-sub-removed", refreshToken: "rt-removed", tasklistId: "list-a" });

    await runTokenRefresh(env);

    const used = google.calls
      .filter((c) => c.url.href === "https://oauth2.googleapis.com/token")
      .map((c) => new URLSearchParams(c.body).get("refresh_token"));
    expect(used).toEqual(["rt-alex"]);
    expect(google.calls.some((c) => c.authorization === "Bearer access-for-rt-removed")).toBe(false);
    const [run] = await jobRuns();
    expect(run).toMatchObject({ ok: 1, error: null });
  });

  it("is safe to run twice", async () => {
    fakeGoogle({ lists: [{ id: "list-a", title: "x" }] });
    await insertUser({ refreshToken: "rt-alex", tasklistId: "list-a" });

    await runTokenRefresh(env);
    await runTokenRefresh(env);

    const runs = await jobRuns();
    expect(runs.map((r) => r.ok)).toEqual([1, 1]);
  });

  it("runs from the Worker's cron trigger", async () => {
    fakeGoogle({ lists: [{ id: "list-a", title: "x" }] });
    await insertUser({ refreshToken: "rt-alex", tasklistId: "list-a" });

    const ctx = createExecutionContext();
    await worker.scheduled!(createScheduledController({ cron: "0 9 * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);

    const [run] = await jobRuns();
    expect(run).toMatchObject({ job: "token_refresh", ok: 1 });
  });
});
