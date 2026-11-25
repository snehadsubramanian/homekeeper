import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { taskNotes } from "../src/assignments";
import { MAX_TASK_NOTES } from "../src/duties";
import { defaultLandingDay } from "../src/schedule";
import { householdDate } from "../src/time";
import { fakeGoogle, type FakeTask, insertUser, resetDatabase, seedDuty, sessionCookie } from "./helpers";

// Step 7: the list view, the complete form (notes and links, editing), pause, resume and delete.
// Made-up duties only.
const LIST = "list-a";
const TASKS_PATH = `/tasks/v1/lists/${LIST}/tasks`;
const PAST = "2020-01-04";
const FUTURE = "2030-01-05";

const today = () => householdDate(env.HOUSEHOLD_TZ);

async function signedIn() {
  const userId = await insertUser({ refreshToken: "rt-alex", tasklistId: LIST });
  return { userId, cookie: await sessionCookie(userId) };
}

async function csrfFor(cookie: string): Promise<string> {
  const html = await (await app.request("/duties/new", { headers: { cookie } }, env)).text();
  return /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
}

function post(path: string, cookie: string, fields: Record<string, string | string[]>) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    for (const v of Array.isArray(value) ? value : [value]) body.append(key, v);
  }
  return app.request(path, { method: "POST", headers: { cookie }, body }, env);
}

async function page(path: string, cookie: string): Promise<string> {
  return (await app.request(path, { headers: { cookie } }, env)).text();
}

/** The list view's row for one duty, or null if it isn't listed. */
function row(html: string, dutyId: number): string | null {
  return new RegExp(`<tr data-duty="${dutyId}">([\\s\\S]*?)</tr>`).exec(html)?.[1] ?? null;
}

function listedIds(html: string): number[] {
  return [...html.matchAll(/<tr data-duty="(\d+)">/g)].map((m) => Number(m[1]));
}

function googleTask(id: string, overrides: Partial<FakeTask> = {}): FakeTask {
  return { id, title: "Water the ferns", status: "needsAction", due: `${FUTURE}T00:00:00.000Z`, updated: "2026-11-01T00:00:00.000Z", ...overrides };
}

async function duty(id: number) {
  return env.DB.prepare("SELECT * FROM duties WHERE id = ?").bind(id).first<Record<string, unknown>>();
}

async function occurrencesOf(dutyId: number) {
  const { results } = await env.DB.prepare("SELECT * FROM occurrences WHERE duty_id = ? ORDER BY id").bind(dutyId).all<{
    id: number;
    slot_date: string;
    due_date: string;
    status: string;
    completed_date: string | null;
  }>();
  return results;
}

async function assignmentsOf(occurrenceId: number) {
  const { results } = await env.DB.prepare("SELECT * FROM assignments WHERE occurrence_id = ? ORDER BY id")
    .bind(occurrenceId)
    .all<{ id: number; status: string; google_task_id: string | null }>();
  return results;
}

function googleCalls(google: ReturnType<typeof fakeGoogle>, method: string) {
  return google.calls.filter((c) => c.method === method && c.url.pathname.startsWith(TASKS_PATH));
}

/**
 * A description and three links whose Google task notes come to exactly
 * MAX_TASK_NOTES characters (with the longest occurrence marker the form
 * allows for), plus `extra` characters.
 */
function notesNear(extra: number): { notes: string; links: string } {
  const description = "d".repeat(2000);
  const link = (length: number) => `https://example.com/${"a".repeat(length - 20)}`;
  const fixed = [link(1990), link(1990)];
  const without = taskNotes(description, JSON.stringify([...fixed, ""]), 999_999_999_999).length;
  const third = link(MAX_TASK_NOTES - without + extra);
  return { notes: description, links: [...fixed, third].join("\n") };
}

beforeEach(resetDatabase);
afterEach(() => vi.unstubAllGlobals());

describe("list view", () => {
  it("shows each duty with its cadence, last done and next due, soonest first", async () => {
    const { userId, cookie } = await signedIn();
    const later = await seedDuty({ userId, title: "Clean the gutters", cadence: "semiannual", months: [4, 10], slotDate: "2031-04-05", googleTaskId: "t1" });
    const sooner = await seedDuty({
      userId,
      title: "Water the ferns",
      anchorMode: "after_completion",
      slotDate: FUTURE,
      googleTaskId: "t2",
      lastDoneDate: "2026-11-01",
    });

    const html = await page("/", cookie);

    expect(listedIds(html)).toEqual([sooner.dutyId, later.dutyId]);
    const ferns = row(html, sooner.dutyId)!;
    expect(ferns).toContain("Water the ferns");
    expect(ferns).toContain("Weekly");
    expect(ferns).toContain("after completion");
    expect(ferns).toContain("2026-11-01");
    expect(ferns).toContain(FUTURE);
    expect(ferns).not.toContain("Overdue");
    const gutters = row(html, later.dutyId)!;
    expect(gutters).toContain("Twice yearly");
    expect(gutters).toContain("Apr, Oct");
    expect(gutters).toContain("never");
    expect(gutters).toContain(`href="/duties/${later.dutyId}"`);
  });

  it("flags a duty as overdue from its original slot, even after roll-forward moved it to today", async () => {
    const { userId, cookie } = await signedIn();
    const overdue = await seedDuty({ userId, title: "Descale the kettle", slotDate: PAST, dueDate: today(), googleTaskId: "t1" });
    const dueToday = await seedDuty({ userId, title: "Water the ferns", slotDate: today(), googleTaskId: "t2" });

    const html = await page("/", cookie);

    expect(row(html, overdue.dutyId)).toContain(`Overdue since ${PAST}`);
    expect(row(html, overdue.dutyId)).toContain(today());
    expect(row(html, dueToday.dutyId)).not.toContain("Overdue");
  });

  it("filters to overdue duties only", async () => {
    const { userId, cookie } = await signedIn();
    const overdue = await seedDuty({ userId, title: "Descale the kettle", slotDate: PAST, dueDate: today(), googleTaskId: "t1" });
    await seedDuty({ userId, title: "Water the ferns", slotDate: FUTURE, googleTaskId: "t2" });

    const html = await page("/?overdue=1", cookie);

    expect(listedIds(html)).toEqual([overdue.dutyId]);
    expect(html).toContain('href="/"');
    expect(await page("/", cookie)).toContain('href="/?overdue=1"');
  });

  it("lists paused duties last, marked paused, and leaves deleted ones out", async () => {
    const { userId, cookie } = await signedIn();
    const paused = await seedDuty({ userId, title: "Clean the gutters", slotDate: PAST, googleTaskId: null });
    const deleted = await seedDuty({ userId, title: "Oil the hinges", slotDate: PAST, googleTaskId: null });
    const active = await seedDuty({ userId, title: "Water the ferns", slotDate: FUTURE, googleTaskId: null });
    await env.DB.batch([
      env.DB.prepare("UPDATE duties SET status = 'paused' WHERE id = ?").bind(paused.dutyId),
      env.DB.prepare("UPDATE occurrences SET status = 'cancelled' WHERE duty_id IN (?, ?)").bind(paused.dutyId, deleted.dutyId),
      env.DB.prepare("UPDATE duties SET deleted_at = ? WHERE id = ?").bind(new Date().toISOString(), deleted.dutyId),
    ]);

    const html = await page("/", cookie);

    expect(listedIds(html)).toEqual([active.dutyId, paused.dutyId]);
    expect(row(html, paused.dutyId)).toContain("Paused");
    expect(row(html, paused.dutyId)).not.toContain("Overdue");
  });

  it("says when there are no duties yet", async () => {
    const { cookie } = await signedIn();
    expect(await page("/", cookie)).toContain("No duties yet");
  });
});

describe("adding a duty with notes and links", () => {
  async function addFields(cookie: string, overrides: Record<string, string | string[]> = {}) {
    const html = await page("/duties/new", cookie);
    return {
      _csrf: /name="_csrf" value="([^"]+)"/.exec(html)![1]!,
      form_token: /name="form_token" value="([^"]+)"/.exec(html)![1]!,
      title: "Replace the water filter",
      notes: "Cartridge is under the sink",
      links: "https://example.com/filter\n\n  https://example.com/manual  ",
      cadence: "quarterly",
      anchor_mode: "after_completion",
      first_due: FUTURE,
      ...overrides,
    };
  }

  it("shows notes and links on the form", async () => {
    const { cookie } = await signedIn();
    const html = await page("/duties/new", cookie);
    expect(html).toContain('name="notes"');
    expect(html).toContain("Description (optional)");
    expect(html).not.toContain("Notes (optional)");
    expect(html).toContain('name="links"');
  });

  it("stores them and puts them in the Google task notes above the marker", async () => {
    const { cookie } = await signedIn();
    const google = fakeGoogle();

    const res = await post("/duties", cookie, await addFields(cookie));

    expect(res.status).toBe(303);
    const saved = await env.DB.prepare("SELECT id, notes, links FROM duties").first<{ id: number; notes: string; links: string }>();
    expect(saved!.notes).toBe("Cartridge is under the sink");
    expect(JSON.parse(saved!.links)).toEqual(["https://example.com/filter", "https://example.com/manual"]);
    const [occurrence] = await occurrencesOf(saved!.id);
    const created = JSON.parse(googleCalls(google, "POST")[0]!.body) as { notes: string };
    expect(created.notes).toBe(
      `Cartridge is under the sink\n\nhttps://example.com/filter\nhttps://example.com/manual\n\nhomekeeper occurrence ${occurrence!.id}`,
    );
  });

  it("refuses a link that is not a web address, keeping what was typed", async () => {
    const { cookie } = await signedIn();
    fakeGoogle();

    const res = await post("/duties", cookie, await addFields(cookie, { links: "example.com/filter" }));

    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Each link must be a web address");
    expect(html).toContain("example.com/filter");
    expect(html).toContain("Cartridge is under the sink");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM duties").first<{ n: number }>())!.n).toBe(0);
  });

  it("refuses a description that is too long", async () => {
    const { cookie } = await signedIn();
    fakeGoogle();

    const res = await post("/duties", cookie, await addFields(cookie, { notes: "x".repeat(2001) }));

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Please keep the description under 2000 characters.");
  });

  it("refuses a description and links too long together for a Google task", async () => {
    const { cookie } = await signedIn();
    const google = fakeGoogle();

    const res = await post("/duties", cookie, await addFields(cookie, notesNear(1)));

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("The description and links together are too long for a Google task");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM duties").first<{ n: number }>())!.n).toBe(0);
    expect(googleCalls(google, "POST")).toHaveLength(0);
  });

  it("accepts a description and links that just fit, and Google gets all of them", async () => {
    const { cookie } = await signedIn();
    const google = fakeGoogle();
    const fits = notesNear(0);

    const res = await post("/duties", cookie, await addFields(cookie, fits));

    expect(res.status).toBe(303);
    const created = JSON.parse(googleCalls(google, "POST")[0]!.body) as { notes: string };
    expect(created.notes.length).toBeLessThanOrEqual(MAX_TASK_NOTES);
    expect(created.notes).toContain(fits.links.split("\n")[2]);
  });
});

describe("editing a duty", () => {
  async function editFields(cookie: string, overrides: Record<string, string | string[]> = {}) {
    return {
      _csrf: await csrfFor(cookie),
      title: "Water the ferns",
      notes: "",
      links: "",
      cadence: "weekly",
      anchor_mode: "fixed",
      ...overrides,
    };
  }

  it("shows the duty on its edit page, with pause and delete", async () => {
    const { userId, cookie } = await signedIn();
    const d = await seedDuty({
      userId,
      title: "Replace the water filter",
      notes: "Under the sink",
      links: ["https://example.com/filter"],
      cadence: "quarterly",
      months: [2, 5, 8, 11],
      slotDate: FUTURE,
      googleTaskId: "t1",
    });

    const res = await app.request(`/duties/${d.dutyId}`, { headers: { cookie } }, env);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('value="Replace the water filter"');
    expect(html).toContain("Under the sink");
    expect(html).toContain("https://example.com/filter");
    expect(html).toMatch(/<option value="quarterly" selected/);
    expect(html).toMatch(/value="5" checked/);
    expect(html).not.toContain('name="first_due"');
    expect(html).toContain(`action="/duties/${d.dutyId}/pause"`);
    expect(html).toContain(`action="/duties/${d.dutyId}/delete"`);
    expect(html).toContain(FUTURE);
  });

  it("is not found for a duty that does not exist, was deleted or belongs to someone else", async () => {
    const { userId, cookie } = await signedIn();
    const other = await insertUser({ email: "sam@example.com", sub: "google-sub-sam" });
    const theirs = await seedDuty({ userId: other, slotDate: FUTURE, googleTaskId: null });
    const deleted = await seedDuty({ userId, slotDate: FUTURE, googleTaskId: null });
    await env.DB.prepare("UPDATE duties SET deleted_at = ? WHERE id = ?").bind(new Date().toISOString(), deleted.dutyId).run();

    for (const path of ["/duties/999", `/duties/${theirs.dutyId}`, `/duties/${deleted.dutyId}`, "/duties/abc"]) {
      expect((await app.request(path, { headers: { cookie } }, env)).status).toBe(404);
    }
    const res = await post(`/duties/${theirs.dutyId}`, cookie, await editFields(cookie, { title: "Taken over" }));
    expect(res.status).toBe(404);
    expect((await duty(theirs.dutyId))!.title).toBe("Water the ferns");
  });

  it("saves the changes and updates the open task title and notes in Google, keeping its date", async () => {
    const { userId, cookie } = await signedIn();
    const d = await seedDuty({ userId, slotDate: FUTURE, googleTaskId: "t1" });
    const google = fakeGoogle({ tasks: { [LIST]: [googleTask("t1")] } });

    const res = await post(
      `/duties/${d.dutyId}`,
      cookie,
      await editFields(cookie, {
        title: "Water the ferns and palms",
        notes: "Use rainwater",
        links: "https://example.com/ferns",
        cadence: "quarterly",
        months: ["3", "6", "9", "12"],
      }),
    );

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/?notice=saved&duty=${d.dutyId}`);
    const saved = (await duty(d.dutyId))!;
    expect(saved.title).toBe("Water the ferns and palms");
    expect(saved.notes).toBe("Use rainwater");
    expect(JSON.parse(saved.links as string)).toEqual(["https://example.com/ferns"]);
    expect(saved.cadence).toBe("quarterly");
    expect(JSON.parse(saved.cadence_months as string)).toEqual([3, 6, 9, 12]);
    const [occurrence] = await occurrencesOf(d.dutyId);
    expect(occurrence).toMatchObject({ id: d.occurrenceId, slot_date: FUTURE, due_date: FUTURE, status: "open" });
    const patches = googleCalls(google, "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]!.url.pathname).toBe(`${TASKS_PATH}/t1`);
    expect(JSON.parse(patches[0]!.body)).toEqual({
      title: "Water the ferns and palms",
      notes: `Use rainwater\n\nhttps://example.com/ferns\n\nhomekeeper occurrence ${d.occurrenceId}`,
    });
    expect(google.tasks[LIST]![0]!.due).toBe(`${FUTURE}T00:00:00.000Z`);
  });

  it("does not call Google when only the schedule changed", async () => {
    const { userId, cookie } = await signedIn();
    const d = await seedDuty({ userId, slotDate: FUTURE, googleTaskId: "t1" });
    const google = fakeGoogle({ tasks: { [LIST]: [googleTask("t1")] } });

    const res = await post(`/duties/${d.dutyId}`, cookie, await editFields(cookie, { cadence: "monthly", anchor_mode: "after_completion" }));

    expect(res.status).toBe(303);
    expect((await duty(d.dutyId))!.cadence).toBe("monthly");
    expect(google.calls.filter((c) => c.url.origin === "https://tasks.googleapis.com")).toHaveLength(0);
  });

  it("saves nothing when Google cannot be reached, and says so", async () => {
    const { userId, cookie } = await signedIn();
    const d = await seedDuty({ userId, slotDate: FUTURE, googleTaskId: "t1" });
    fakeGoogle({ tasks: { [LIST]: [googleTask("t1")] }, patchErrors: { t1: 503 } });

    const res = await post(`/duties/${d.dutyId}`, cookie, await editFields(cookie, { title: "Water the palms" }));

    expect(res.status).toBe(502);
    const html = await res.text();
    expect(html).toContain("Google Tasks could not be reached, so nothing was changed");
    expect(html).toContain('value="Water the palms"');
    expect((await duty(d.dutyId))!.title).toBe("Water the ferns");
  });

  it("still saves when the open task was already deleted in Google", async () => {
    const { userId, cookie } = await signedIn();
    const d = await seedDuty({ userId, slotDate: FUTURE, googleTaskId: "gone" });
    fakeGoogle({ tasks: { [LIST]: [] } });

    const res = await post(`/duties/${d.dutyId}`, cookie, await editFields(cookie, { title: "Water the palms" }));

    expect(res.status).toBe(303);
    expect((await duty(d.dutyId))!.title).toBe("Water the palms");
  });

  it("refuses bad input with the same checks as adding", async () => {
    const { userId, cookie } = await signedIn();
    const d = await seedDuty({ userId, slotDate: FUTURE, googleTaskId: "t1" });
    fakeGoogle({ tasks: { [LIST]: [googleTask("t1")] } });

    const months = await post(`/duties/${d.dutyId}`, cookie, await editFields(cookie, { cadence: "quarterly", months: ["1", "2"] }));
    expect(months.status).toBe(400);
    const blank = await post(`/duties/${d.dutyId}`, cookie, await editFields(cookie, { title: "  " }));
    expect(blank.status).toBe(400);
    expect(await blank.text()).toContain("Please enter a title.");
    expect((await duty(d.dutyId))!.cadence).toBe("weekly");
  });

  it("refuses a description and links too long together, without calling Google", async () => {
    const { userId, cookie } = await signedIn();
    const d = await seedDuty({ userId, slotDate: FUTURE, googleTaskId: "t1" });
    const google = fakeGoogle({ tasks: { [LIST]: [googleTask("t1")] } });

    const res = await post(`/duties/${d.dutyId}`, cookie, await editFields(cookie, notesNear(1)));

    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("The description and links together are too long for a Google task");
    expect(html).not.toContain("could not be reached");
    expect((await duty(d.dutyId))!.notes).toBeNull();
    expect(googleCalls(google, "PATCH")).toHaveLength(0);
  });

  it("refuses a request without a valid CSRF token", async () => {
    const { userId, cookie } = await signedIn();
    const d = await seedDuty({ userId, slotDate: FUTURE, googleTaskId: "t1" });

    const res = await post(`/duties/${d.dutyId}`, cookie, await editFields(cookie, { _csrf: "forged", title: "Hijacked" }));

    expect(res.status).toBe(403);
    expect((await duty(d.dutyId))!.title).toBe("Water the ferns");
  });

  it("confirms the save on the list page", async () => {
    const { userId, cookie } = await signedIn();
    const d = await seedDuty({ userId, slotDate: FUTURE, googleTaskId: null });

    const html = await page(`/?notice=saved&duty=${d.dutyId}`, cookie);

    expect(html).toContain("Saved Water the ferns.");
  });
});

describe("pausing a duty", () => {
  it("removes its Google task, cancels the open occurrence and marks it paused", async () => {
    const { userId, cookie } = await signedIn();
    const d = await seedDuty({ userId, slotDate: FUTURE, googleTaskId: "t1" });
    const google = fakeGoogle({ tasks: { [LIST]: [googleTask("t1")] } });

    const res = await post(`/duties/${d.dutyId}/pause`, cookie, { _csrf: await csrfFor(cookie) });

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/?notice=paused&duty=${d.dutyId}`);
    expect(googleCalls(google, "DELETE").map((c) => c.url.pathname)).toEqual([`${TASKS_PATH}/t1`]);
    expect((await duty(d.dutyId))!.status).toBe("paused");
    expect((await occurrencesOf(d.dutyId)).map((o) => o.status)).toEqual(["cancelled"]);
    expect((await assignmentsOf(d.occurrenceId)).map((a) => a.status)).toEqual(["removed"]);
    expect(await page(`/?notice=paused&duty=${d.dutyId}`, cookie)).toContain("Paused Water the ferns.");
  });

  it("changes nothing when Google cannot be reached", async () => {
    const { userId, cookie } = await signedIn();
    const d = await seedDuty({ userId, slotDate: FUTURE, googleTaskId: "t1" });
    fakeGoogle({ tasks: { [LIST]: [googleTask("t1")] }, patchErrors: { t1: 500 } });

    const res = await post(`/duties/${d.dutyId}/pause`, cookie, { _csrf: await csrfFor(cookie) });

    expect(res.status).toBe(502);
    expect(await res.text()).toContain("Google Tasks could not be reached, so nothing was changed");
    expect((await duty(d.dutyId))!.status).toBe("active");
    expect((await occurrencesOf(d.dutyId)).map((o) => o.status)).toEqual(["open"]);
  });

  it("goes ahead when the task is already gone from Google, or was never created", async () => {
    const { userId, cookie } = await signedIn();
    const gone = await seedDuty({ userId, slotDate: FUTURE, googleTaskId: "gone" });
    const pending = await seedDuty({ userId, title: "Oil the hinges", slotDate: FUTURE, googleTaskId: null });
    const google = fakeGoogle({ tasks: { [LIST]: [] } });
    const csrf = await csrfFor(cookie);

    expect((await post(`/duties/${gone.dutyId}/pause`, cookie, { _csrf: csrf })).status).toBe(303);
    expect((await post(`/duties/${pending.dutyId}/pause`, cookie, { _csrf: csrf })).status).toBe(303);

    expect((await duty(gone.dutyId))!.status).toBe("paused");
    expect((await duty(pending.dutyId))!.status).toBe("paused");
    expect(googleCalls(google, "DELETE")).toHaveLength(1);
  });

  it("does nothing more for a duty that is already paused", async () => {
    const { userId, cookie } = await signedIn();
    const d = await seedDuty({ userId, slotDate: FUTURE, googleTaskId: "t1" });
    const google = fakeGoogle({ tasks: { [LIST]: [googleTask("t1")] } });
    const csrf = await csrfFor(cookie);

    await post(`/duties/${d.dutyId}/pause`, cookie, { _csrf: csrf });
    const again = await post(`/duties/${d.dutyId}/pause`, cookie, { _csrf: csrf });

    expect(again.status).toBe(303);
    expect(googleCalls(google, "DELETE")).toHaveLength(1);
    expect(await occurrencesOf(d.dutyId)).toHaveLength(1);
  });

  it("refuses a request without a valid CSRF token", async () => {
    const { userId, cookie } = await signedIn();
    const d = await seedDuty({ userId, slotDate: FUTURE, googleTaskId: "t1" });

    const res = await post(`/duties/${d.dutyId}/pause`, cookie, { _csrf: "forged" });

    expect(res.status).toBe(403);
    expect((await duty(d.dutyId))!.status).toBe("active");
  });

  it("shows a resume form instead of pause on the edit page", async () => {
    const { userId, cookie } = await signedIn();
    const d = await seedDuty({ userId, slotDate: FUTURE, googleTaskId: null });
    await post(`/duties/${d.dutyId}/pause`, cookie, { _csrf: await csrfFor(cookie) });

    const html = await page(`/duties/${d.dutyId}`, cookie);

    expect(html).toContain(`action="/duties/${d.dutyId}/resume"`);
    expect(html).toContain('name="next_due"');
    expect(html).not.toContain(`action="/duties/${d.dutyId}/pause"`);
  });
});

describe("resuming a duty", () => {
  async function pausedDuty(opts: { lastDoneDate?: string; anchorMode?: string } = {}) {
    const { userId, cookie } = await signedIn();
    const d = await seedDuty({ userId, slotDate: FUTURE, googleTaskId: null, notes: "Use rainwater", ...opts });
    await post(`/duties/${d.dutyId}/pause`, cookie, { _csrf: await csrfFor(cookie) });
    return { ...d, cookie };
  }

  it("with no date and no history, schedules by the no-history rules and creates the task", async () => {
    const d = await pausedDuty();
    const google = fakeGoogle();

    const res = await post(`/duties/${d.dutyId}/resume`, d.cookie, { _csrf: await csrfFor(d.cookie), next_due: "" });

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/?notice=resumed&duty=${d.dutyId}`);
    const expected = defaultLandingDay("weekly", today());
    expect((await duty(d.dutyId))!.status).toBe("active");
    const occurrences = await occurrencesOf(d.dutyId);
    expect(occurrences.map((o) => o.status)).toEqual(["cancelled", "open"]);
    expect(occurrences[1]).toMatchObject({ slot_date: expected, due_date: expected });
    const [assignment] = await assignmentsOf(occurrences[1]!.id);
    expect(assignment!.google_task_id).not.toBeNull();
    const created = JSON.parse(googleCalls(google, "POST")[0]!.body) as { notes: string; due: string };
    expect(created.due).toBe(`${expected}T00:00:00.000Z`);
    expect(created.notes).toBe(`Use rainwater\n\nhomekeeper occurrence ${occurrences[1]!.id}`);
    expect(await page(`/?notice=resumed&duty=${d.dutyId}`, d.cookie)).toContain(`Resumed Water the ferns. Next due ${expected}.`);
  });

  it("with no date, counts from the last completion, and a past result is due today", async () => {
    const d = await pausedDuty({ lastDoneDate: "2020-01-01", anchorMode: "after_completion" });
    fakeGoogle();

    await post(`/duties/${d.dutyId}/resume`, d.cookie, { _csrf: await csrfFor(d.cookie) });

    const open = (await occurrencesOf(d.dutyId)).find((o) => o.status === "open")!;
    expect(open.due_date).toBe(today());
  });

  it("uses the date given, as a new duty would", async () => {
    const d = await pausedDuty();
    fakeGoogle();

    await post(`/duties/${d.dutyId}/resume`, d.cookie, { _csrf: await csrfFor(d.cookie), next_due: PAST });

    const open = (await occurrencesOf(d.dutyId)).find((o) => o.status === "open")!;
    expect(open).toMatchObject({ slot_date: PAST, due_date: today() });
  });

  it("refuses a date that is not real, changing nothing", async () => {
    const d = await pausedDuty();
    fakeGoogle();

    const res = await post(`/duties/${d.dutyId}/resume`, d.cookie, { _csrf: await csrfFor(d.cookie), next_due: "2030-02-30" });

    expect(res.status).toBe(400);
    expect((await duty(d.dutyId))!.status).toBe("paused");
  });

  it("is saved even when Google cannot be reached, leaving the task for the next sync", async () => {
    const d = await pausedDuty();
    fakeGoogle({ tasksStatus: 503 });

    const res = await post(`/duties/${d.dutyId}/resume`, d.cookie, { _csrf: await csrfFor(d.cookie) });

    expect(res.status).toBe(303);
    const open = (await occurrencesOf(d.dutyId)).find((o) => o.status === "open")!;
    expect((await assignmentsOf(open.id))[0]!.google_task_id).toBeNull();
  });

  it("does nothing for a duty that is already active", async () => {
    const { userId, cookie } = await signedIn();
    const d = await seedDuty({ userId, slotDate: FUTURE, googleTaskId: "t1" });
    fakeGoogle();

    const res = await post(`/duties/${d.dutyId}/resume`, cookie, { _csrf: await csrfFor(cookie) });

    expect(res.status).toBe(303);
    expect(await occurrencesOf(d.dutyId)).toHaveLength(1);
  });
});

describe("deleting a duty", () => {
  it("removes its Google task and hides it, keeping its history", async () => {
    const { userId, cookie } = await signedIn();
    const d = await seedDuty({ userId, slotDate: FUTURE, googleTaskId: "t2" });
    // An earlier, completed occurrence of the same duty.
    await env.DB.prepare("INSERT INTO occurrences (duty_id, slot_date, due_date, status, completed_date) VALUES (?, ?, ?, 'done', ?)")
      .bind(d.dutyId, PAST, PAST, PAST)
      .run();
    const google = fakeGoogle({ tasks: { [LIST]: [googleTask("t2")] } });

    const res = await post(`/duties/${d.dutyId}/delete`, cookie, { _csrf: await csrfFor(cookie) });

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/?notice=deleted&duty=${d.dutyId}`);
    expect(googleCalls(google, "DELETE").map((c) => c.url.pathname)).toEqual([`${TASKS_PATH}/t2`]);
    const saved = (await duty(d.dutyId))!;
    expect(saved.deleted_at).not.toBeNull();
    const occurrences = await occurrencesOf(d.dutyId);
    expect(occurrences.map((o) => o.status).sort()).toEqual(["cancelled", "done"]);
    expect((await assignmentsOf(d.occurrenceId)).map((a) => a.status)).toEqual(["removed"]);
    const html = await page(`/?notice=deleted&duty=${d.dutyId}`, cookie);
    expect(html).toContain("Deleted Water the ferns.");
    expect(listedIds(html)).toEqual([]);
  });

  it("asks for confirmation in the browser before deleting", async () => {
    const { userId, cookie } = await signedIn();
    const d = await seedDuty({ userId, slotDate: FUTURE, googleTaskId: null });

    const html = await page(`/duties/${d.dutyId}`, cookie);

    expect(html).toMatch(new RegExp(`action="/duties/${d.dutyId}/delete"[^>]*onsubmit="return confirm\\(`));
  });

  it("changes nothing when Google cannot be reached", async () => {
    const { userId, cookie } = await signedIn();
    const d = await seedDuty({ userId, slotDate: FUTURE, googleTaskId: "t1" });
    fakeGoogle({ tasks: { [LIST]: [googleTask("t1")] }, patchErrors: { t1: 500 } });

    const res = await post(`/duties/${d.dutyId}/delete`, cookie, { _csrf: await csrfFor(cookie) });

    expect(res.status).toBe(502);
    expect((await duty(d.dutyId))!.deleted_at).toBeNull();
    expect((await occurrencesOf(d.dutyId)).map((o) => o.status)).toEqual(["open"]);
  });

  it("deletes a paused duty without calling Google", async () => {
    const { userId, cookie } = await signedIn();
    const d = await seedDuty({ userId, slotDate: FUTURE, googleTaskId: "t1" });
    const google = fakeGoogle({ tasks: { [LIST]: [googleTask("t1")] } });
    const csrf = await csrfFor(cookie);
    await post(`/duties/${d.dutyId}/pause`, cookie, { _csrf: csrf });

    const res = await post(`/duties/${d.dutyId}/delete`, cookie, { _csrf: csrf });

    expect(res.status).toBe(303);
    expect(googleCalls(google, "DELETE")).toHaveLength(1);
    expect((await duty(d.dutyId))!.deleted_at).not.toBeNull();
  });

  it("refuses a request without a valid CSRF token", async () => {
    const { userId, cookie } = await signedIn();
    const d = await seedDuty({ userId, slotDate: FUTURE, googleTaskId: "t1" });

    const res = await post(`/duties/${d.dutyId}/delete`, cookie, { _csrf: "forged" });

    expect(res.status).toBe(403);
    expect((await duty(d.dutyId))!.deleted_at).toBeNull();
  });
});
