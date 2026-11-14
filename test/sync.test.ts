import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { runSync } from "../src/jobs";
import { type FakeTask, fakeGoogle, insertUser, resetDatabase } from "./helpers";

// vitest.config.ts sets HOUSEHOLD_TZ to America/Chicago (UTC-6 in November).
const NOW = new Date("2026-11-14T15:00:00.000Z");
const LIST = "list-a";

function task(overrides: Partial<FakeTask> & { id: string }): FakeTask {
  return {
    title: "Test task",
    status: "needsAction",
    due: "2026-11-14T00:00:00.000Z",
    updated: "2026-11-14T14:58:00.000Z",
    ...overrides,
  };
}

async function logRows() {
  const { results } = await env.DB.prepare(
    `SELECT user_id, google_task_id, title, status, due_date, completed_date, completed_at, deleted, hidden, google_updated
     FROM sync_log ORDER BY id`,
  ).all();
  return results;
}

async function syncRuns() {
  const { results } = await env.DB.prepare("SELECT started_at, ok, error FROM job_runs WHERE job = 'sync' ORDER BY id").all();
  return results;
}

beforeEach(resetDatabase);
afterEach(() => vi.unstubAllGlobals());

describe("sync", () => {
  it("logs a task ticked off in Google, with the household's completion date", async () => {
    fakeGoogle({
      tasks: {
        [LIST]: [
          task({
            id: "t1",
            status: "completed",
            // 11:30 p.m. on Nov 13 in Chicago.
            completed: "2026-11-14T05:30:00.000Z",
            hidden: true,
            updated: "2026-11-14T05:30:01.000Z",
          }),
        ],
      },
    });
    const id = await insertUser({ refreshToken: "rt-alex", tasklistId: LIST });

    await runSync(env, NOW);

    expect(await logRows()).toEqual([
      {
        user_id: id,
        google_task_id: "t1",
        title: "Test task",
        status: "completed",
        due_date: "2026-11-14",
        completed_date: "2026-11-13",
        completed_at: "2026-11-14T05:30:00.000Z",
        deleted: 0,
        hidden: 1,
        google_updated: "2026-11-14T05:30:01.000Z",
      },
    ]);
  });

  it("asks Google for completed, hidden and deleted tasks changed since the last sync, minus 10 minutes", async () => {
    const google = fakeGoogle({ tasks: { [LIST]: [] } });
    await insertUser({ refreshToken: "rt-alex", tasklistId: LIST, lastSyncedAt: "2026-11-14T14:55:00.000Z" });

    await runSync(env, NOW);

    const listCall = google.calls.find((c) => c.url.pathname === `/tasks/v1/lists/${LIST}/tasks`)!;
    expect(listCall.authorization).toBe("Bearer access-for-rt-alex");
    const q = listCall.url.searchParams;
    expect(q.get("showCompleted")).toBe("true");
    expect(q.get("showHidden")).toBe("true");
    expect(q.get("showDeleted")).toBe("true");
    expect(q.get("updatedMin")).toBe("2026-11-14T14:45:00.000Z");
  });

  it("reads the whole list on the first sync, then records when it synced", async () => {
    const google = fakeGoogle({ tasks: { [LIST]: [] } });
    await insertUser({ refreshToken: "rt-alex", tasklistId: LIST });

    await runSync(env, NOW);

    const listCall = google.calls.find((c) => c.url.pathname === `/tasks/v1/lists/${LIST}/tasks`)!;
    expect(listCall.url.searchParams.has("updatedMin")).toBe(false);
    const user = await env.DB.prepare("SELECT last_synced_at FROM users").first();
    expect(user).toEqual({ last_synced_at: NOW.toISOString() });
  });

  it("logs a task deleted in Google", async () => {
    fakeGoogle({ tasks: { [LIST]: [task({ id: "t1", deleted: true, hidden: true })] } });
    await insertUser({ refreshToken: "rt-alex", tasklistId: LIST });

    await runSync(env, NOW);

    expect(await logRows()).toMatchObject([{ google_task_id: "t1", deleted: 1, completed_date: null }]);
  });

  it("doesn't log the same change twice when sync windows overlap", async () => {
    fakeGoogle({ tasks: { [LIST]: [task({ id: "t1" })] } });
    await insertUser({ refreshToken: "rt-alex", tasklistId: LIST });

    await runSync(env, NOW);
    await runSync(env, new Date(NOW.getTime() + 5 * 60 * 1000));

    expect(await logRows()).toHaveLength(1);
  });

  it("logs each new version of a task", async () => {
    const google = fakeGoogle({ tasks: { [LIST]: [task({ id: "t1" })] } });
    await insertUser({ refreshToken: "rt-alex", tasklistId: LIST });
    await runSync(env, NOW);

    google.tasks[LIST]![0] = task({
      id: "t1",
      status: "completed",
      completed: "2026-11-14T15:02:00.000Z",
      updated: "2026-11-14T15:02:00.000Z",
    });
    await runSync(env, new Date(NOW.getTime() + 5 * 60 * 1000));

    expect((await logRows()).map((r) => r.status)).toEqual(["needsAction", "completed"]);
  });

  it("skips users without Tasks access and anyone removed from the allow-list", async () => {
    const google = fakeGoogle({ tasks: { [LIST]: [task({ id: "t1" })] } });
    await insertUser({ refreshToken: null, tasklistId: null });
    await insertUser({ email: "removed@example.net", sub: "google-sub-removed", refreshToken: "rt-removed", tasklistId: LIST });

    await runSync(env, NOW);

    expect(google.calls).toHaveLength(0);
    expect(await logRows()).toHaveLength(0);
  });
});

describe("sync run log", () => {
  it("records nothing when a run is quiet", async () => {
    fakeGoogle({ tasks: { [LIST]: [] } });
    await insertUser({ refreshToken: "rt-alex", tasklistId: LIST });

    await runSync(env, NOW);

    expect(await syncRuns()).toEqual([]);
  });

  it("records at most one successful run per hour that had activity", async () => {
    const google = fakeGoogle({ tasks: { [LIST]: [task({ id: "t1" })] } });
    await insertUser({ refreshToken: "rt-alex", tasklistId: LIST });

    await runSync(env, NOW); // 15:00, new change
    google.tasks[LIST]!.push(task({ id: "t2", updated: "2026-11-14T15:03:00.000Z" }));
    await runSync(env, new Date("2026-11-14T15:05:00.000Z")); // same hour, new change
    google.tasks[LIST]!.push(task({ id: "t3", updated: "2026-11-14T16:01:00.000Z" }));
    await runSync(env, new Date("2026-11-14T16:05:00.000Z")); // next hour, new change

    expect(await syncRuns()).toEqual([
      { started_at: "2026-11-14T15:00:00.000Z", ok: 1, error: null },
      { started_at: "2026-11-14T16:05:00.000Z", ok: 1, error: null },
    ]);
  });

  it("records every failed run, without the token", async () => {
    fakeGoogle({ refreshErrors: { "rt-alex": "invalid_grant" } });
    const id = await insertUser({ refreshToken: "rt-alex", tasklistId: LIST });

    await runSync(env, NOW);
    await runSync(env, new Date("2026-11-14T15:05:00.000Z"));

    const runs = await syncRuns();
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ ok: 0 });
    expect(String(runs[0]!.error)).toContain(`user ${id}: token refresh failed: invalid_grant`);
    expect(String(runs[0]!.error)).not.toContain("rt-alex");
  });
});

describe("cron triggers", () => {
  it("runs sync every five minutes, using the scheduled time", async () => {
    fakeGoogle({ tasks: { [LIST]: [task({ id: "t1" })] } });
    await insertUser({ refreshToken: "rt-alex", tasklistId: LIST });

    const ctx = createExecutionContext();
    await worker.scheduled!(createScheduledController({ cron: "*/5 * * * *", scheduledTime: NOW.getTime() }), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await logRows()).toHaveLength(1);
    expect(await env.DB.prepare("SELECT last_synced_at FROM users").first()).toEqual({
      last_synced_at: NOW.toISOString(),
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM job_runs WHERE job = 'token_refresh'").first()).toEqual({ n: 0 });
  });

  it("runs only the daily token check at 09:00 UTC", async () => {
    fakeGoogle({ lists: [{ id: LIST, title: "x" }], tasks: { [LIST]: [task({ id: "t1" })] } });
    await insertUser({ refreshToken: "rt-alex", tasklistId: LIST });

    const ctx = createExecutionContext();
    await worker.scheduled!(createScheduledController({ cron: "0 9 * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await logRows()).toHaveLength(0);
    expect(await env.DB.prepare("SELECT ok FROM job_runs WHERE job = 'token_refresh'").first()).toEqual({ ok: 1 });
  });
});
