import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { runRollForward } from "../src/jobs";
import { type FakeTask, fakeGoogle, insertUser, resetDatabase, seedDuty } from "./helpers";

// vitest.config.ts sets HOUSEHOLD_TZ to America/Chicago (UTC-6 in November).
// 09:00 UTC on Nov 23 is 3 a.m. on Nov 23 in Chicago.
const NOW = new Date("2026-11-23T09:00:00.000Z");
const TODAY = "2026-11-23";
const LIST = "list-a";

function task(id: string, due: string): FakeTask {
  return { id, title: "Test task", status: "needsAction", due: `${due}T00:00:00.000Z`, updated: "2026-11-15T12:00:00.000Z" };
}

async function occurrences() {
  const { results } = await env.DB.prepare(
    "SELECT id, duty_id, slot_date, due_date, status FROM occurrences ORDER BY id",
  ).all<{ id: number; duty_id: number; slot_date: string; due_date: string; status: string }>();
  return results;
}

async function dueDateOf(occurrenceId: number): Promise<string> {
  const row = await env.DB.prepare("SELECT due_date FROM occurrences WHERE id = ?").bind(occurrenceId).first<{ due_date: string }>();
  return row!.due_date;
}

function patches(google: ReturnType<typeof fakeGoogle>) {
  return google.calls.filter((c) => c.method === "PATCH");
}

async function rollRuns() {
  const { results } = await env.DB.prepare(
    "SELECT started_at, finished_at, ok, error FROM job_runs WHERE job = 'roll_forward' ORDER BY id",
  ).all<{ started_at: string; finished_at: string | null; ok: number | null; error: string | null }>();
  return results;
}

beforeEach(resetDatabase);
afterEach(() => vi.unstubAllGlobals());

describe("daily roll-forward", () => {
  it("moves a weekly task overdue by 8 days to today, keeping one task and the original slot", async () => {
    const google = fakeGoogle({ tasks: { [LIST]: [task("t1", "2026-11-15")] } });
    const userId = await insertUser({ refreshToken: "rt-alex", tasklistId: LIST });
    const { dutyId, occurrenceId } = await seedDuty({ userId, cadence: "weekly", slotDate: "2026-11-15", googleTaskId: "t1" });

    await runRollForward(env, NOW);

    expect(await occurrences()).toEqual([
      { id: occurrenceId, duty_id: dutyId, slot_date: "2026-11-15", due_date: TODAY, status: "open" },
    ]);
    expect(google.tasks[LIST]).toHaveLength(1);
    expect(google.tasks[LIST]![0]!.due).toBe(`${TODAY}T00:00:00.000Z`);
    const [patch] = patches(google);
    expect(patch!.url.pathname).toBe(`/tasks/v1/lists/${LIST}/tasks/t1`);
    expect(JSON.parse(patch!.body)).toEqual({ due: `${TODAY}T00:00:00.000Z` });
    expect(patch!.authorization).toBe("Bearer access-for-rt-alex");
    expect(google.calls.some((c) => c.method === "POST" && c.url.pathname.endsWith("/tasks"))).toBe(false);

    const [run] = await rollRuns();
    expect(run).toMatchObject({ ok: 1, error: null });
    expect(run!.finished_at).not.toBeNull();
  });

  it("leaves tasks due today or later alone", async () => {
    const google = fakeGoogle({ tasks: { [LIST]: [task("t1", TODAY), task("t2", "2026-11-30")] } });
    const userId = await insertUser({ refreshToken: "rt-alex", tasklistId: LIST });
    const a = await seedDuty({ userId, title: "Water the ferns", slotDate: TODAY, googleTaskId: "t1" });
    const b = await seedDuty({ userId, title: "Wipe the counters", slotDate: "2026-11-30", googleTaskId: "t2" });

    await runRollForward(env, NOW);

    expect(patches(google)).toHaveLength(0);
    expect(await dueDateOf(a.occurrenceId)).toBe(TODAY);
    expect(await dueDateOf(b.occurrenceId)).toBe("2026-11-30");
    expect(await rollRuns()).toMatchObject([{ ok: 1, error: null }]);
  });

  it("leaves completed occurrences alone", async () => {
    const google = fakeGoogle({ tasks: { [LIST]: [task("t1", "2026-11-15")] } });
    const userId = await insertUser({ refreshToken: "rt-alex", tasklistId: LIST });
    const { occurrenceId, assignmentId } = await seedDuty({ userId, slotDate: "2026-11-15", googleTaskId: "t1" });
    await env.DB.batch([
      env.DB.prepare("UPDATE occurrences SET status = 'done', completed_date = '2026-11-16' WHERE id = ?").bind(occurrenceId),
      env.DB.prepare("UPDATE assignments SET status = 'done', completed_date = '2026-11-16' WHERE id = ?").bind(assignmentId),
    ]);

    await runRollForward(env, NOW);

    expect(patches(google)).toHaveLength(0);
    expect(await dueDateOf(occurrenceId)).toBe("2026-11-15");
  });

  it("is a no-op when re-run on the same day", async () => {
    const google = fakeGoogle({ tasks: { [LIST]: [task("t1", "2026-11-20")] } });
    const userId = await insertUser({ refreshToken: "rt-alex", tasklistId: LIST });
    const { occurrenceId } = await seedDuty({ userId, slotDate: "2026-11-20", googleTaskId: "t1" });

    await runRollForward(env, NOW);
    await runRollForward(env, new Date("2026-11-23T09:30:00.000Z"));

    expect(patches(google)).toHaveLength(1);
    expect(await occurrences()).toHaveLength(1);
    expect(await dueDateOf(occurrenceId)).toBe(TODAY);
    expect((await rollRuns()).map((r) => r.ok)).toEqual([1, 1]);
  });

  it("keeps the old date when Google can't update a task, and retries it on the next run", async () => {
    const google = fakeGoogle({ tasks: { [LIST]: [task("t1", "2026-11-20"), task("t2", "2026-11-21")] }, patchErrors: { t1: 503 } });
    const userId = await insertUser({ refreshToken: "rt-alex", tasklistId: LIST });
    const failing = await seedDuty({ userId, title: "Water the ferns", slotDate: "2026-11-20", googleTaskId: "t1" });
    const fine = await seedDuty({ userId, title: "Wipe the counters", slotDate: "2026-11-21", googleTaskId: "t2" });

    await runRollForward(env, NOW);

    expect(await dueDateOf(failing.occurrenceId)).toBe("2026-11-20");
    expect(await dueDateOf(fine.occurrenceId)).toBe(TODAY);
    const [failed] = await rollRuns();
    expect(failed!.ok).toBe(0);
    expect(failed!.error).toContain(`user ${userId}`);
    expect(failed!.error).toContain(`assignment ${failing.assignmentId}`);
    expect(failed!.error).toContain("503");
    expect(failed!.error).not.toContain("rt-alex");

    delete google.patchErrors.t1;
    await runRollForward(env, new Date("2026-11-23T10:00:00.000Z"));

    expect(await dueDateOf(failing.occurrenceId)).toBe(TODAY);
    expect(google.tasks[LIST]!.map((t) => t.due)).toEqual([`${TODAY}T00:00:00.000Z`, `${TODAY}T00:00:00.000Z`]);
    expect((await rollRuns()).map((r) => r.ok)).toEqual([0, 1]);
    // The task that already moved isn't patched again.
    expect(patches(google).filter((c) => c.url.pathname.endsWith("/t2"))).toHaveLength(1);
  });

  it("writes a run's date changes in one database batch", async () => {
    fakeGoogle({ tasks: { [LIST]: [task("t1", "2026-11-20"), task("t2", "2026-11-21")] } });
    const userId = await insertUser({ refreshToken: "rt-alex", tasklistId: LIST });
    await seedDuty({ userId, title: "Water the ferns", slotDate: "2026-11-20", googleTaskId: "t1" });
    await seedDuty({ userId, title: "Wipe the counters", slotDate: "2026-11-21", googleTaskId: "t2" });
    const batch = vi.spyOn(env.DB, "batch");

    await runRollForward(env, NOW);

    expect(batch).toHaveBeenCalledTimes(1);
    expect((await occurrences()).map((o) => o.due_date)).toEqual([TODAY, TODAY]);
    batch.mockRestore();
  });

  it("moves an occurrence whose Google task doesn't exist yet, so sync creates it dated today", async () => {
    const google = fakeGoogle({ tasks: { [LIST]: [] } });
    const userId = await insertUser({ refreshToken: "rt-alex", tasklistId: LIST });
    const { occurrenceId } = await seedDuty({ userId, slotDate: "2026-11-20", googleTaskId: null });

    await runRollForward(env, NOW);

    expect(patches(google)).toHaveLength(0);
    expect(await dueDateOf(occurrenceId)).toBe(TODAY);
    expect(await rollRuns()).toMatchObject([{ ok: 1 }]);
  });

  it("skips and logs a row it can't roll, and still moves the others", async () => {
    const google = fakeGoogle({ tasks: { [LIST]: [task("t1", "2026-11-20"), task("t2", "2026-11-20")] } });
    const userId = await insertUser({ refreshToken: "rt-alex", tasklistId: LIST });
    const bad = await seedDuty({ userId, title: "Water the ferns", slotDate: "2026-1-5", googleTaskId: "t1" });
    const good = await seedDuty({ userId, title: "Wipe the counters", slotDate: "2026-11-20", googleTaskId: "t2" });

    await runRollForward(env, NOW);

    expect(await dueDateOf(bad.occurrenceId)).toBe("2026-1-5");
    expect(await dueDateOf(good.occurrenceId)).toBe(TODAY);
    expect(patches(google).map((c) => c.url.pathname)).toEqual([`/tasks/v1/lists/${LIST}/tasks/t2`]);
    const [run] = await rollRuns();
    expect(run!.ok).toBe(0);
    expect(run!.error).toContain(`assignment ${bad.assignmentId}`);
  });

  it("rolls each person's tasks with their own Google access", async () => {
    const google = fakeGoogle({ tasks: { "list-a": [task("t1", "2026-11-20")], "list-s": [task("t9", "2026-11-19")] } });
    const alex = await insertUser({ sub: "google-sub-alex", refreshToken: "rt-alex", tasklistId: "list-a" });
    const sam = await insertUser({ email: "sam@example.com", sub: "google-sub-sam", refreshToken: "rt-sam", tasklistId: "list-s" });
    await seedDuty({ userId: alex, slotDate: "2026-11-20", googleTaskId: "t1" });
    await seedDuty({ userId: sam, title: "Sweep the porch", slotDate: "2026-11-19", googleTaskId: "t9" });

    await runRollForward(env, NOW);

    expect(patches(google).map((c) => [c.url.pathname, c.authorization])).toEqual([
      ["/tasks/v1/lists/list-a/tasks/t1", "Bearer access-for-rt-alex"],
      ["/tasks/v1/lists/list-s/tasks/t9", "Bearer access-for-rt-sam"],
    ]);
    expect((await occurrences()).map((o) => o.due_date)).toEqual([TODAY, TODAY]);
  });

  it("logs a person whose token Google rejects, and still rolls everyone else", async () => {
    fakeGoogle({
      tasks: { "list-a": [task("t1", "2026-11-20")], "list-s": [task("t9", "2026-11-19")] },
      refreshErrors: { "rt-alex": "invalid_grant" },
    });
    const alex = await insertUser({ sub: "google-sub-alex", refreshToken: "rt-alex", tasklistId: "list-a" });
    const sam = await insertUser({ email: "sam@example.com", sub: "google-sub-sam", refreshToken: "rt-sam", tasklistId: "list-s" });
    const a = await seedDuty({ userId: alex, slotDate: "2026-11-20", googleTaskId: "t1" });
    const s = await seedDuty({ userId: sam, title: "Sweep the porch", slotDate: "2026-11-19", googleTaskId: "t9" });

    await runRollForward(env, NOW);

    expect(await dueDateOf(a.occurrenceId)).toBe("2026-11-20");
    expect(await dueDateOf(s.occurrenceId)).toBe(TODAY);
    const [run] = await rollRuns();
    expect(run!.ok).toBe(0);
    expect(run!.error).toContain(`user ${alex}`);
    expect(run!.error).toContain("invalid_grant");
  });

  it("skips anyone removed from the allow-list or without Tasks access", async () => {
    const google = fakeGoogle({ tasks: { "list-r": [task("t1", "2026-11-20")] } });
    const removed = await insertUser({ email: "removed@example.net", sub: "google-sub-removed", refreshToken: "rt-removed", tasklistId: "list-r" });
    const noAccess = await insertUser({ email: "sam@example.com", sub: "google-sub-sam", refreshToken: null });
    const r = await seedDuty({ userId: removed, slotDate: "2026-11-20", googleTaskId: "t1" });
    const n = await seedDuty({ userId: noAccess, title: "Sweep the porch", slotDate: "2026-11-20", googleTaskId: null });

    await runRollForward(env, NOW);

    expect(google.calls).toHaveLength(0);
    expect(await dueDateOf(r.occurrenceId)).toBe("2026-11-20");
    expect(await dueDateOf(n.occurrenceId)).toBe("2026-11-20");
    expect(await rollRuns()).toMatchObject([{ ok: 1, error: null }]);
  });
});

describe("roll-forward around midnight in the household time zone", () => {
  it("at 11:30 p.m. household time, 'today' is still the household date, not the UTC date", async () => {
    // 05:30 UTC Nov 23 is 11:30 p.m. Nov 22 in Chicago.
    const google = fakeGoogle({ tasks: { [LIST]: [task("t1", "2026-11-21"), task("t2", "2026-11-22")] } });
    const userId = await insertUser({ refreshToken: "rt-alex", tasklistId: LIST });
    const yesterday = await seedDuty({ userId, title: "Water the ferns", slotDate: "2026-11-21", googleTaskId: "t1" });
    const today = await seedDuty({ userId, title: "Wipe the counters", slotDate: "2026-11-22", googleTaskId: "t2" });

    await runRollForward(env, new Date("2026-11-23T05:30:00.000Z"));

    expect(await dueDateOf(yesterday.occurrenceId)).toBe("2026-11-22");
    expect(await dueDateOf(today.occurrenceId)).toBe("2026-11-22");
    expect(patches(google).map((c) => JSON.parse(c.body))).toEqual([{ due: "2026-11-22T00:00:00.000Z" }]);
  });

  it("just after midnight household time, yesterday's task moves to the new day", async () => {
    // 06:30 UTC Nov 23 is 12:30 a.m. Nov 23 in Chicago.
    fakeGoogle({ tasks: { [LIST]: [task("t1", "2026-11-22")] } });
    const userId = await insertUser({ refreshToken: "rt-alex", tasklistId: LIST });
    const { occurrenceId } = await seedDuty({ userId, slotDate: "2026-11-22", googleTaskId: "t1" });

    await runRollForward(env, new Date("2026-11-23T06:30:00.000Z"));

    expect(await dueDateOf(occurrenceId)).toBe("2026-11-23");
  });
});

describe("daily cron trigger", () => {
  it("runs the token check, then the roll-forward, at the scheduled time", async () => {
    const google = fakeGoogle({ lists: [{ id: LIST, title: "x" }], tasks: { [LIST]: [task("t1", "2026-11-15")] } });
    const userId = await insertUser({ refreshToken: "rt-alex", tasklistId: LIST });
    const { occurrenceId } = await seedDuty({ userId, slotDate: "2026-11-15", googleTaskId: "t1" });

    const ctx = createExecutionContext();
    await worker.scheduled!(createScheduledController({ cron: "0 9 * * *", scheduledTime: NOW.getTime() }), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await dueDateOf(occurrenceId)).toBe(TODAY);
    const { results } = await env.DB.prepare("SELECT job, ok FROM job_runs ORDER BY id").all();
    expect(results).toEqual([
      { job: "token_refresh", ok: 1 },
      { job: "roll_forward", ok: 1 },
    ]);
    const listRead = google.calls.findIndex((c) => c.url.pathname.endsWith(`/lists/${LIST}`));
    const patch = google.calls.findIndex((c) => c.method === "PATCH");
    expect(listRead).toBeGreaterThanOrEqual(0);
    expect(listRead).toBeLessThan(patch);
  });
});
