import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { defaultLandingDay } from "../src/schedule";
import { householdDate } from "../src/time";
import { fakeGoogle, insertUser, resetDatabase, seedDuty, sessionCookie } from "./helpers";

// Made-up duties only.
const LIST = "list-a";
const TASKS_PATH = `/tasks/v1/lists/${LIST}/tasks`;

async function signedIn(opts: { refreshToken?: string | null; tasklistId?: string | null } = {}) {
  const userId = await insertUser({
    refreshToken: opts.refreshToken === undefined ? "rt-alex" : opts.refreshToken,
    tasklistId: opts.tasklistId === undefined ? LIST : opts.tasklistId,
  });
  return { userId, cookie: await sessionCookie(userId) };
}

/** The hidden _csrf and form_token values from a freshly loaded form. */
async function loadForm(cookie: string) {
  const html = await (await app.request("/duties/new", { headers: { cookie } }, env)).text();
  return {
    csrf: /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "",
    formToken: /name="form_token" value="([^"]+)"/.exec(html)?.[1] ?? "",
  };
}

function submit(cookie: string, fields: Record<string, string | string[]>) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    for (const v of Array.isArray(value) ? value : [value]) body.append(key, v);
  }
  return app.request("/duties", { method: "POST", headers: { cookie }, body }, env);
}

async function validFields(cookie: string, overrides: Record<string, string | string[]> = {}) {
  const { csrf, formToken } = await loadForm(cookie);
  return {
    _csrf: csrf,
    form_token: formToken,
    title: "Water the ferns",
    cadence: "weekly",
    anchor_mode: "fixed",
    first_due: "2030-01-05",
    ...overrides,
  };
}

async function count(table: string): Promise<number> {
  return (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
}

function taskCreations(google: ReturnType<typeof fakeGoogle>) {
  return google.calls.filter((c) => c.method === "POST" && c.url.pathname === TASKS_PATH);
}

beforeEach(resetDatabase);
afterEach(() => vi.unstubAllGlobals());

describe("GET /duties/new", () => {
  it("shows the bare form with a CSRF token and a one-time form token", async () => {
    const { cookie } = await signedIn();

    const res = await app.request("/duties/new", { headers: { cookie } }, env);

    expect(res.status).toBe(200);
    const html = await res.text();
    for (const name of ["title", "cadence", "months", "anchor_mode", "first_due", "_csrf", "form_token"]) {
      expect(html).toContain(`name="${name}"`);
    }
    expect(html).not.toContain("last_done");
    const first = await loadForm(cookie);
    const second = await loadForm(cookie);
    expect(first.csrf).not.toBe("");
    expect(first.formToken).not.toBe("");
    expect(first.formToken).not.toBe(second.formToken);
  });

  it("sends signed-out visitors to sign in", async () => {
    const res = await app.request("/duties/new", {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/signin");
  });
});

describe("POST /duties", () => {
  it("saves the duty, its first occurrence and assignment, and creates the Google task", async () => {
    const { userId, cookie } = await signedIn();
    const fields = await validFields(cookie);
    const google = fakeGoogle({ tasks: { [LIST]: [] } });

    const res = await submit(cookie, fields);

    const duty = await env.DB.prepare("SELECT * FROM duties").first<Record<string, unknown>>();
    expect(duty).toMatchObject({
      title: "Water the ferns",
      owner: "user",
      owner_user_id: userId,
      joint_mode: null,
      cadence: "weekly",
      cadence_months: null,
      anchor_mode: "fixed",
      last_done_date: null,
      last_done_precision: "unknown",
      status: "active",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/?added=${duty!.id}`);

    const occurrence = await env.DB.prepare("SELECT * FROM occurrences").first<Record<string, unknown>>();
    expect(occurrence).toMatchObject({
      duty_id: duty!.id,
      slot_date: "2030-01-05",
      due_date: "2030-01-05",
      status: "open",
      completed_date: null,
    });
    const assignment = await env.DB.prepare("SELECT * FROM assignments").first<Record<string, unknown>>();
    expect(assignment).toMatchObject({
      occurrence_id: occurrence!.id,
      user_id: userId,
      google_task_id: "task-1",
      status: "open",
    });

    const created = taskCreations(google);
    expect(created).toHaveLength(1);
    expect(created[0]!.authorization).toBe("Bearer access-for-rt-alex");
    const body = JSON.parse(created[0]!.body) as { title: string; due: string; notes: string };
    expect(body.title).toBe("Water the ferns");
    expect(body.due).toBe("2030-01-05T00:00:00.000Z");
    expect(body.notes).toContain(`homekeeper occurrence ${occurrence!.id}`);
  });

  it("with no first-due date, uses the no-history rule (weekly: the next Saturday)", async () => {
    const { cookie } = await signedIn();
    const fields = await validFields(cookie, { first_due: "" });
    fakeGoogle({ tasks: { [LIST]: [] } });

    await submit(cookie, fields);

    const today = householdDate(env.HOUSEHOLD_TZ);
    const occurrence = await env.DB.prepare("SELECT slot_date, due_date FROM occurrences").first();
    const saturday = defaultLandingDay("weekly", today);
    expect(occurrence).toEqual({ slot_date: saturday, due_date: saturday });
  });

  it("a first-due date in the past keeps its slot and is due today", async () => {
    const { cookie } = await signedIn();
    const fields = await validFields(cookie, { first_due: "2020-03-07" });
    fakeGoogle({ tasks: { [LIST]: [] } });

    await submit(cookie, fields);

    const today = householdDate(env.HOUSEHOLD_TZ);
    expect(await env.DB.prepare("SELECT slot_date, due_date FROM occurrences").first()).toEqual({
      slot_date: "2020-03-07",
      due_date: today,
    });
  });

  it("stores named months for fixed quarterly, twice-yearly and yearly duties", async () => {
    const { cookie } = await signedIn();
    const fields = await validFields(cookie, {
      title: "Change the furnace filter",
      cadence: "semiannual",
      months: ["10", "4"],
      first_due: "",
    });
    fakeGoogle({ tasks: { [LIST]: [] } });

    const res = await submit(cookie, fields);

    expect(res.status).toBe(303);
    expect(await env.DB.prepare("SELECT cadence, cadence_months FROM duties").first()).toEqual({
      cadence: "semiannual",
      cadence_months: "[4,10]",
    });
  });

  it("ignores ticked months where the cadence doesn't use them", async () => {
    const { cookie } = await signedIn();
    const fields = await validFields(cookie, { cadence: "quarterly", anchor_mode: "after_completion", months: ["1"] });
    fakeGoogle({ tasks: { [LIST]: [] } });

    await submit(cookie, fields);

    expect(await env.DB.prepare("SELECT cadence_months FROM duties").first()).toEqual({ cadence_months: null });
  });

  it("refuses wrong named months before saving anything, and keeps what was typed", async () => {
    const { cookie } = await signedIn();
    const fields = await validFields(cookie, {
      title: "Clean the gutters",
      cadence: "quarterly",
      months: ["2", "5", "8"],
    });
    const google = fakeGoogle({ tasks: { [LIST]: [] } });

    const res = await submit(cookie, fields);

    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("4 different months");
    expect(html).toContain('value="Clean the gutters"');
    expect(html).toContain(`value="${fields.form_token}"`);
    expect(await count("duties")).toBe(0);
    expect(google.calls).toHaveLength(0);
  });

  it.each([
    ["a missing title", { title: "   " }, "title"],
    ["an unknown cadence", { cadence: "fortnightly" }, "cadence"],
    ["an unknown anchor mode", { anchor_mode: "sometimes" }, "schedule"],
    ["an impossible first-due date", { first_due: "2030-02-30" }, "first-due"],
    ["a first-due date that isn't a full date", { first_due: "2030-02" }, "first-due"],
  ])("refuses %s", async (_label, overrides, message) => {
    const { cookie } = await signedIn();
    const fields = await validFields(cookie, overrides);
    const google = fakeGoogle({ tasks: { [LIST]: [] } });

    const res = await submit(cookie, fields);

    expect(res.status).toBe(400);
    expect((await res.text()).toLowerCase()).toContain(message);
    expect(await count("duties")).toBe(0);
    expect(google.calls).toHaveLength(0);
  });

  it("a double submit of the same form creates one duty and one task", async () => {
    const { cookie } = await signedIn();
    const fields = await validFields(cookie);
    const google = fakeGoogle({ tasks: { [LIST]: [] } });

    const first = await submit(cookie, fields);
    const second = await submit(cookie, fields);

    expect(await count("duties")).toBe(1);
    expect(await count("occurrences")).toBe(1);
    expect(taskCreations(google)).toHaveLength(1);
    expect(second.status).toBe(303);
    expect(second.headers.get("location")).toBe(first.headers.get("location"));
  });

  it("a form without its one-time token is refused", async () => {
    const { cookie } = await signedIn();
    const fields = await validFields(cookie, { form_token: "" });
    fakeGoogle({ tasks: { [LIST]: [] } });

    const res = await submit(cookie, fields);

    expect(res.status).toBe(400);
    expect(await count("duties")).toBe(0);
  });

  it("refuses a request without a valid CSRF token, without saving or calling Google", async () => {
    const { cookie } = await signedIn();
    const fields = await validFields(cookie, { _csrf: "wrong" });
    const google = fakeGoogle({ tasks: { [LIST]: [] } });

    const res = await submit(cookie, fields);

    expect(res.status).toBe(403);
    expect(await count("duties")).toBe(0);
    expect(google.calls).toHaveLength(0);
  });

  it("if Google Tasks fails, saves the duty anyway and leaves the task for the next sync", async () => {
    const { cookie } = await signedIn();
    const fields = await validFields(cookie);
    fakeGoogle({ tasksStatus: 503 });

    const res = await submit(cookie, fields);

    expect(res.status).toBe(303);
    expect(await env.DB.prepare("SELECT google_task_id, status FROM assignments").first()).toEqual({
      google_task_id: null,
      status: "open",
    });
  });

  it("asks the user to sign in again if the app has no Tasks access for them", async () => {
    const { cookie } = await signedIn({ refreshToken: null, tasklistId: null });
    const fields = await validFields(cookie);
    const google = fakeGoogle();

    const res = await submit(cookie, fields);

    expect(res.status).toBe(409);
    expect(await res.text()).toContain("sign in again");
    expect(await count("duties")).toBe(0);
    expect(google.calls).toHaveLength(0);
  });

  it("sends signed-out visitors to sign in", async () => {
    const res = await app.request("/duties", { method: "POST", body: new URLSearchParams({ title: "x" }) }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/signin");
  });
});

describe("home page", () => {
  it("links to the form and has no test-task button any more", async () => {
    const { cookie } = await signedIn();

    const html = await (await app.request("/", { headers: { cookie } }, env)).text();

    expect(html).toContain('href="/duties/new"');
    expect(html).not.toContain("Create test task");
    expect(html).not.toContain("/spike");
  });

  it("confirms a newly added duty with its first due date", async () => {
    const { userId, cookie } = await signedIn();
    const { dutyId } = await seedDuty({ userId, title: "Sweep the porch", slotDate: "2030-01-05", googleTaskId: "t1" });

    const html = await (await app.request(`/?added=${dutyId}`, { headers: { cookie } }, env)).text();

    expect(html).toContain("Added Sweep the porch");
    expect(html).toContain("2030-01-05");
    expect(html).not.toContain("next sync");
  });

  it("says when the Google task is still waiting for the next sync", async () => {
    const { userId, cookie } = await signedIn();
    const { dutyId } = await seedDuty({ userId, slotDate: "2030-01-05", googleTaskId: null });

    const html = await (await app.request(`/?added=${dutyId}`, { headers: { cookie } }, env)).text();

    expect(html).toContain("next sync");
  });

  it("does not confirm another person's duty", async () => {
    const { cookie } = await signedIn();
    const other = await insertUser({ email: "sam@example.com", sub: "google-sub-sam", refreshToken: "rt-sam" });
    const { dutyId } = await seedDuty({ userId: other, title: "Sweep the porch", slotDate: "2030-01-05", googleTaskId: "t1" });

    const html = await (await app.request(`/?added=${dutyId}`, { headers: { cookie } }, env)).text();

    expect(html).not.toContain("Sweep the porch");
  });
});

describe("schema", () => {
  it("allows only one open occurrence per duty", async () => {
    const userId = await insertUser();
    const { dutyId, occurrenceId } = await seedDuty({ userId, slotDate: "2030-01-05", googleTaskId: "t1" });
    const insertOpen = env.DB.prepare(
      "INSERT INTO occurrences (duty_id, slot_date, due_date, status) VALUES (?, '2030-01-12', '2030-01-12', 'open')",
    ).bind(dutyId);

    await expect(insertOpen.run()).rejects.toThrow(/UNIQUE/);

    await env.DB.prepare("UPDATE occurrences SET status = 'done', completed_date = '2030-01-05' WHERE id = ?")
      .bind(occurrenceId)
      .run();
    await expect(insertOpen.run()).resolves.toBeTruthy();
  });
});
