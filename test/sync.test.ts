import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { runSync } from "../src/jobs";
import { type FakeTask, fakeGoogle, insertUser, resetDatabase, seedDuty } from "./helpers";

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

async function occurrences() {
  const { results } = await env.DB.prepare(
    "SELECT id, duty_id, slot_date, due_date, status, completed_date FROM occurrences ORDER BY id",
  ).all();
  return results;
}

async function assignments() {
  const { results } = await env.DB.prepare(
    "SELECT occurrence_id, user_id, google_task_id, status, completed_date FROM assignments ORDER BY id",
  ).all();
  return results;
}

function taskCreations(google: ReturnType<typeof fakeGoogle>) {
  return google.calls.filter((c) => c.method === "POST" && c.url.pathname === `/tasks/v1/lists/${LIST}/tasks`);
}

/** The same task, now ticked off in Google at `completed` (UTC). */
function ticked(id: string, completed: string): FakeTask {
  return task({ id, status: "completed", completed, hidden: true, updated: completed });
}

async function syncRuns() {
  const { results } = await env.DB.prepare("SELECT started_at, ok, error FROM job_runs WHERE job = 'sync' ORDER BY id").all();
  return results;
}

beforeEach(resetDatabase);
afterEach(() => vi.unstubAllGlobals());

describe("sync", () => {
  it("turns a check-off of a weekly duty into a completion and creates next week's task", async () => {
    // 2026-11-14 is a Saturday.
    const google = fakeGoogle({ tasks: { [LIST]: [ticked("t1", "2026-11-14T14:30:00.000Z")] } });
    const userId = await insertUser({ refreshToken: "rt-alex", tasklistId: LIST });
    const { dutyId, occurrenceId } = await seedDuty({
      userId,
      title: "Take out the recycling",
      cadence: "weekly",
      anchorMode: "fixed",
      slotDate: "2026-11-14",
      googleTaskId: "t1",
    });

    await runSync(env, NOW);

    expect(await occurrences()).toEqual([
      { id: occurrenceId, duty_id: dutyId, slot_date: "2026-11-14", due_date: "2026-11-14", status: "done", completed_date: "2026-11-14" },
      { id: expect.any(Number), duty_id: dutyId, slot_date: "2026-11-21", due_date: "2026-11-21", status: "open", completed_date: null },
    ]);
    const next = (await occurrences())[1]!;
    expect(await assignments()).toEqual([
      { occurrence_id: occurrenceId, user_id: userId, google_task_id: "t1", status: "done", completed_date: "2026-11-14" },
      { occurrence_id: next.id, user_id: userId, google_task_id: "task-2", status: "open", completed_date: null },
    ]);
    expect(await env.DB.prepare("SELECT last_done_date, last_done_precision FROM duties").first()).toEqual({
      last_done_date: "2026-11-14",
      last_done_precision: "day",
    });

    const created = taskCreations(google);
    expect(created).toHaveLength(1);
    expect(created[0]!.authorization).toBe("Bearer access-for-rt-alex");
    const body = JSON.parse(created[0]!.body) as { title: string; due: string; notes: string };
    expect(body).toMatchObject({ title: "Take out the recycling", due: "2026-11-21T00:00:00.000Z" });
    expect(body.notes).toContain(`homekeeper occurrence ${next.id}`);
  });

  it("records a completion on the household's date, not the UTC date", async () => {
    // 11:30 p.m. on Nov 13 in Chicago is 05:30 UTC on Nov 14.
    fakeGoogle({ tasks: { [LIST]: [ticked("t1", "2026-11-14T05:30:00.000Z")] } });
    const userId = await insertUser({ refreshToken: "rt-alex", tasklistId: LIST });
    await seedDuty({ userId, cadence: "monthly", anchorMode: "after_completion", slotDate: "2026-11-10", googleTaskId: "t1" });

    await runSync(env, NOW);

    expect((await occurrences()).map((o) => [o.status, o.completed_date, o.due_date])).toEqual([
      ["done", "2026-11-13", "2026-11-10"],
      ["open", null, "2026-12-13"],
    ]);
  });

  it("uses the scheduling engine for fixed duties (named months, day of the completion)", async () => {
    fakeGoogle({ tasks: { [LIST]: [ticked("t1", "2026-11-14T14:30:00.000Z")] } });
    const userId = await insertUser({ refreshToken: "rt-alex", tasklistId: LIST });
    await seedDuty({
      userId,
      cadence: "semiannual",
      anchorMode: "fixed",
      months: [4, 10],
      slotDate: "2026-10-03",
      dueDate: "2026-11-14",
      googleTaskId: "t1",
    });

    await runSync(env, NOW);

    expect((await occurrences())[1]).toMatchObject({ slot_date: "2027-04-14", due_date: "2027-04-14", status: "open" });
  });

  it("is safe to re-run: overlapping syncs record the completion and create the next task once", async () => {
    const google = fakeGoogle({ tasks: { [LIST]: [ticked("t1", "2026-11-14T14:30:00.000Z")] } });
    const userId = await insertUser({ refreshToken: "rt-alex", tasklistId: LIST });
    await seedDuty({ userId, slotDate: "2026-11-14", googleTaskId: "t1" });

    await runSync(env, NOW);
    await runSync(env, new Date(NOW.getTime() + 5 * 60 * 1000));

    expect((await occurrences()).map((o) => o.status)).toEqual(["done", "open"]);
    expect(taskCreations(google)).toHaveLength(1);
  });

  it("writes all of a run's completions in one database batch", async () => {
    fakeGoogle({
      tasks: { [LIST]: [ticked("t1", "2026-11-14T14:30:00.000Z"), ticked("t2", "2026-11-14T14:31:00.000Z")] },
    });
    const userId = await insertUser({ refreshToken: "rt-alex", tasklistId: LIST });
    await seedDuty({ userId, title: "Water the ferns", slotDate: "2026-11-14", googleTaskId: "t1" });
    await seedDuty({ userId, title: "Wipe the counters", slotDate: "2026-11-14", googleTaskId: "t2" });
    const batch = vi.spyOn(env.DB, "batch");

    await runSync(env, NOW);

    expect((await occurrences()).map((o) => o.status)).toEqual(["done", "done", "open", "open"]);
    // One batch for both completions (and the sync time), one for the new tasks' ids.
    expect(batch).toHaveBeenCalledTimes(2);
    batch.mockRestore();
  });

  it("skips and logs a duty it can't schedule, and still completes the others", async () => {
    fakeGoogle({
      tasks: { [LIST]: [ticked("t1", "2026-11-14T14:30:00.000Z"), ticked("t2", "2026-11-14T14:31:00.000Z")] },
    });
    const userId = await insertUser({ refreshToken: "rt-alex", tasklistId: LIST });
    // Saved before form checks existed: a quarterly fixed duty with only three months.
    const bad = await seedDuty({
      userId,
      title: "Clean the gutters",
      cadence: "quarterly",
      anchorMode: "fixed",
      months: [2, 5, 8],
      slotDate: "2026-11-14",
      googleTaskId: "t1",
    });
    const good = await seedDuty({ userId, title: "Water the ferns", slotDate: "2026-11-14", googleTaskId: "t2" });

    await runSync(env, NOW);

    const all = await occurrences();
    const statuses = (dutyId: number) => all.filter((o) => o.duty_id === dutyId).map((o) => o.status);
    expect(statuses(bad.dutyId)).toEqual(["open"]);
    expect(statuses(good.dutyId)).toEqual(["done", "open"]);
    const runs = await syncRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ ok: 0 });
    expect(String(runs[0]!.error)).toContain(`duty ${bad.dutyId}`);
  });

  it("creates any Google task that couldn't be created earlier", async () => {
    const google = fakeGoogle({ tasks: { [LIST]: [] } });
    const userId = await insertUser({ refreshToken: "rt-alex", tasklistId: LIST });
    const { occurrenceId } = await seedDuty({ userId, title: "Water the ferns", slotDate: "2026-11-21", googleTaskId: null });

    await runSync(env, NOW);
    await runSync(env, new Date(NOW.getTime() + 5 * 60 * 1000));

    expect(taskCreations(google)).toHaveLength(1);
    expect(JSON.parse(taskCreations(google)[0]!.body)).toMatchObject({
      title: "Water the ferns",
      due: "2026-11-21T00:00:00.000Z",
    });
    expect(await assignments()).toEqual([
      { occurrence_id: occurrenceId, user_id: userId, google_task_id: "task-1", status: "open", completed_date: null },
    ]);
  });

  it("leaves everything alone for open, deleted and unknown tasks (deletes and un-checks are Step 11)", async () => {
    const google = fakeGoogle({
      tasks: {
        [LIST]: [
          task({ id: "t1" }),
          task({ id: "t2", deleted: true, hidden: true }),
          ticked("old-test-task", "2026-11-14T14:30:00.000Z"),
        ],
      },
    });
    const userId = await insertUser({ refreshToken: "rt-alex", tasklistId: LIST });
    await seedDuty({ userId, title: "Water the ferns", slotDate: "2026-11-14", googleTaskId: "t1" });
    await seedDuty({ userId, title: "Wipe the counters", slotDate: "2026-11-14", googleTaskId: "t2" });

    await runSync(env, NOW);

    expect((await occurrences()).map((o) => o.status)).toEqual(["open", "open"]);
    expect(taskCreations(google)).toHaveLength(0);
    expect(await syncRuns()).toEqual([]);
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

  it("skips users without Tasks access and anyone removed from the allow-list", async () => {
    const google = fakeGoogle({ tasks: { [LIST]: [ticked("t1", "2026-11-14T14:30:00.000Z")] } });
    await insertUser({ refreshToken: null, tasklistId: null });
    const removed = await insertUser({
      email: "removed@example.net",
      sub: "google-sub-removed",
      refreshToken: "rt-removed",
      tasklistId: LIST,
    });
    await seedDuty({ userId: removed, slotDate: "2026-11-14", googleTaskId: "t1" });

    await runSync(env, NOW);

    expect(google.calls).toHaveLength(0);
    expect((await occurrences()).map((o) => o.status)).toEqual(["open"]);
  });
});

describe("sync run log", () => {
  it("records nothing when a run is quiet", async () => {
    fakeGoogle({ tasks: { [LIST]: [] } });
    await insertUser({ refreshToken: "rt-alex", tasklistId: LIST });

    await runSync(env, NOW);

    expect(await syncRuns()).toEqual([]);
  });

  it("records nothing when sync only sees open tasks", async () => {
    fakeGoogle({ tasks: { [LIST]: [task({ id: "t1" })] } });
    const userId = await insertUser({ refreshToken: "rt-alex", tasklistId: LIST });
    await seedDuty({ userId, slotDate: "2026-11-14", googleTaskId: "t1" });

    await runSync(env, NOW);

    expect(await syncRuns()).toEqual([]);
  });

  it("records at most one successful run per hour that did something", async () => {
    const google = fakeGoogle({ tasks: { [LIST]: [] } });
    const userId = await insertUser({ refreshToken: "rt-alex", tasklistId: LIST });

    await seedDuty({ userId, slotDate: "2026-11-21", googleTaskId: null });
    await runSync(env, NOW); // 15:00, creates a task
    google.tasks[LIST]!.push(ticked("task-1", "2026-11-14T15:03:00.000Z"));
    await runSync(env, new Date("2026-11-14T15:05:00.000Z")); // same hour, a completion
    await seedDuty({ userId, slotDate: "2026-11-28", googleTaskId: null });
    await runSync(env, new Date("2026-11-14T16:05:00.000Z")); // next hour, creates a task

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
    fakeGoogle({ tasks: { [LIST]: [ticked("t1", "2026-11-14T14:30:00.000Z")] } });
    const userId = await insertUser({ refreshToken: "rt-alex", tasklistId: LIST });
    await seedDuty({ userId, slotDate: "2026-11-14", googleTaskId: "t1" });

    const ctx = createExecutionContext();
    await worker.scheduled!(createScheduledController({ cron: "*/5 * * * *", scheduledTime: NOW.getTime() }), env, ctx);
    await waitOnExecutionContext(ctx);

    expect((await occurrences()).map((o) => o.status)).toEqual(["done", "open"]);
    expect(await env.DB.prepare("SELECT last_synced_at FROM users").first()).toEqual({
      last_synced_at: NOW.toISOString(),
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM job_runs WHERE job = 'token_refresh'").first()).toEqual({ n: 0 });
  });

  it("runs the daily job, not sync, at 09:00 UTC", async () => {
    fakeGoogle({ lists: [{ id: LIST, title: "x" }], tasks: { [LIST]: [ticked("t1", "2026-11-14T14:30:00.000Z")] } });
    const userId = await insertUser({ refreshToken: "rt-alex", tasklistId: LIST });
    await seedDuty({ userId, slotDate: "2026-11-14", googleTaskId: "t1" });

    const ctx = createExecutionContext();
    await worker.scheduled!(createScheduledController({ cron: "0 9 * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);

    expect((await occurrences()).map((o) => o.status)).toEqual(["open"]);
    expect(await env.DB.prepare("SELECT ok FROM job_runs WHERE job = 'token_refresh'").first()).toEqual({ ok: 1 });
  });
});
