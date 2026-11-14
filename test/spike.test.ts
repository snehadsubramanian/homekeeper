import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { householdDate } from "../src/time";
import { fakeGoogle, insertUser, resetDatabase, sessionCookie } from "./helpers";

const LIST = "list-a";

async function csrfFor(cookie: string): Promise<string> {
  const html = await (await app.request("/", { headers: { cookie } }, env)).text();
  return /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
}

function post(cookie: string, csrf: string) {
  return app.request(
    "/spike/test-task",
    { method: "POST", headers: { cookie }, body: new URLSearchParams({ _csrf: csrf }) },
    env,
  );
}

beforeEach(resetDatabase);
afterEach(() => vi.unstubAllGlobals());

describe("POST /spike/test-task (temporary, Step 3)", () => {
  it("creates one task due today (household date) in the user's own list", async () => {
    const cookie = await sessionCookie(await insertUser({ refreshToken: "rt-alex", tasklistId: LIST }));
    const csrf = await csrfFor(cookie);
    const google = fakeGoogle({ tasks: { [LIST]: [] } });

    const res = await post(cookie, csrf);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const created = google.calls.filter((c) => c.method === "POST" && c.url.pathname === `/tasks/v1/lists/${LIST}/tasks`);
    expect(created).toHaveLength(1);
    expect(created[0]!.authorization).toBe("Bearer access-for-rt-alex");
    const body = JSON.parse(created[0]!.body) as { title: string; due: string; notes: string };
    expect(body.due).toBe(`${householdDate(env.HOUSEHOLD_TZ, new Date())}T00:00:00.000Z`);
    expect(body.title).toMatch(/^homekeeper test task \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\)$/);
    expect(body.notes).toContain("Safe to tick");
  });

  it("refuses a request without a valid CSRF token, without calling Google", async () => {
    const cookie = await sessionCookie(await insertUser({ refreshToken: "rt-alex", tasklistId: LIST }));
    const google = fakeGoogle({ tasks: { [LIST]: [] } });

    const res = await post(cookie, "wrong");

    expect(res.status).toBe(403);
    expect(google.calls).toHaveLength(0);
  });

  it("sends signed-out visitors to sign in", async () => {
    const res = await post("", "anything");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/signin");
  });

  it("asks the user to sign in again if the app has no Tasks access for them", async () => {
    const cookie = await sessionCookie(await insertUser({ refreshToken: null, tasklistId: null }));
    const csrf = await csrfFor(cookie);
    const google = fakeGoogle();

    const res = await post(cookie, csrf);

    expect(res.status).toBe(409);
    expect(await res.text()).toContain("sign in again");
    expect(google.calls).toHaveLength(0);
  });

  it("explains when Google Tasks can't be reached", async () => {
    const cookie = await sessionCookie(await insertUser({ refreshToken: "rt-alex", tasklistId: LIST }));
    const csrf = await csrfFor(cookie);
    fakeGoogle({ tasksStatus: 503 });

    const res = await post(cookie, csrf);

    expect(res.status).toBe(502);
  });
});

describe("home page spike section (temporary, Step 3)", () => {
  it("has the test button and says sync hasn't run yet", async () => {
    const cookie = await sessionCookie(await insertUser({ refreshToken: "rt-alex", tasklistId: LIST }));
    const html = await (await app.request("/", { headers: { cookie } }, env)).text();

    expect(html).toMatch(/<form[^>]*method="post"[^>]*action="\/spike\/test-task"/);
    expect(html).toContain("Last sync: never");
    expect(html).toContain("Sync has not seen any changes yet.");
  });

  it("shows the last sync time and the user's latest log entries, newest first, in household time", async () => {
    const id = await insertUser({ refreshToken: "rt-alex", tasklistId: LIST, lastSyncedAt: "2026-11-14T15:05:00.000Z" });
    const other = await insertUser({ email: "sam@example.com", sub: "google-sub-sam" });
    await env.DB.prepare(
      `INSERT INTO sync_log (seen_at, user_id, google_task_id, title, status, due_date, completed_date, completed_at, deleted, hidden, google_updated) VALUES
       ('2026-11-14T15:00:00.000Z', ?1, 't1', 'First task', 'needsAction', '2026-11-14', NULL, NULL, 0, 0, 'u1'),
       ('2026-11-14T15:05:00.000Z', ?1, 't1', 'First task', 'completed', '2026-11-14', '2026-11-14', '2026-11-14T15:02:00.000Z', 0, 1, 'u2'),
       ('2026-11-14T15:05:00.000Z', ?2, 't9', 'Someone else''s task', 'needsAction', '2026-11-14', NULL, NULL, 0, 0, 'u3')`,
    )
      .bind(id, other)
      .run();

    const html = await (await app.request("/", { headers: { cookie: await sessionCookie(id) } }, env)).text();

    // Chicago is UTC-6 in November.
    expect(html).toContain("Last sync: 2026-11-14 09:05");
    expect(html).not.toContain("Someone else");
    const completed = html.indexOf("completed");
    const open = html.indexOf(">open<");
    expect(completed).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(completed);
    expect(html).toContain("2026-11-14 09:05");
    expect(html).toContain("hidden");
  });
});
