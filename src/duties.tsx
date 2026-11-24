/**
 * The duty form and the actions on a duty: add (Step 5), and edit, pause,
 * resume and delete (Step 7). Changes that touch an open Google task go to
 * Google first; if Google fails, nothing is changed in the app.
 */
import { type Context, Hono } from "hono";
import { pushPendingTasks, taskNotes } from "./assignments";
import { type AppContext, formCsrfOk } from "./auth";
import type { AppEnv } from "./env";
import { GoogleApiError } from "./google";
import { accessTokenFor } from "./jobs";
import { type DutyFormValues, DutyFormPage, MessagePage, type SavedDuty } from "./pages";
import {
  type AnchorMode,
  type Cadence,
  type Precision,
  firstDueDate,
  firstOccurrence,
  namedMonthsProblem,
} from "./schedule";
import { csrfToken, randomToken } from "./session";
import { deleteTask, patchTask } from "./tasks";
import { householdDate } from "./time";

export const duties = new Hono<AppContext>();
type DutyContext = Context<AppContext>;

const CADENCES: readonly Cadence[] = ["weekly", "monthly", "quarterly", "semiannual", "yearly"];
const ANCHOR_MODES: readonly AnchorMode[] = ["fixed", "after_completion"];
const FORM_TOKEN_RE = /^[A-Za-z0-9_-]{16,100}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_NOTES = 2000;
const MAX_LINKS = 10;
const MAX_LINK_LENGTH = 2000;

const EMPTY_FORM: Omit<DutyFormValues, "formToken"> = {
  title: "",
  cadence: "weekly",
  months: [],
  anchorMode: "fixed",
  notes: "",
  links: "",
  firstDue: "",
};

/** A duty's own fields as they will be saved, after checking. */
interface DutyInput {
  title: string;
  notes: string | null;
  /** JSON array of URLs, or null for none. */
  links: string | null;
  cadence: Cadence;
  anchorMode: AnchorMode;
  months: number[] | null;
}

/** A saved duty as the edit page and the actions read it. */
interface DutyRecord {
  id: number;
  title: string;
  notes: string | null;
  links: string | null;
  owner_user_id: number;
  cadence: Cadence;
  cadence_months: string | null;
  anchor_mode: AnchorMode;
  last_done_date: string | null;
  last_done_precision: Precision;
  status: "active" | "paused";
}

class GoogleUnavailable extends Error {}
class TasksAccessNeeded extends Error {}

const GOOGLE_DOWN = "Google Tasks could not be reached, so nothing was changed. Please try again in a minute.";
const NEEDS_ACCESS =
  "homekeeper can't use your Google Tasks yet. Please sign out and sign in again, allowing access to Google Tasks.";

/** Whether a cadence uses named months (only fixed quarterly, twice-yearly and yearly ones do). */
function usesNamedMonths(cadence: Cadence, anchorMode: AnchorMode): boolean {
  return anchorMode === "fixed" && cadence !== "weekly" && cadence !== "monthly";
}

/** The form as submitted, for showing it again if it is refused. */
async function readForm(c: DutyContext): Promise<DutyFormValues> {
  const form = await c.req.parseBody({ all: true });
  const text = (key: string) => (typeof form[key] === "string" ? (form[key] as string).trim() : "");
  const rawMonths = ([] as unknown[]).concat(form.months ?? []);
  return {
    title: text("title"),
    cadence: text("cadence"),
    months: rawMonths.filter((m): m is string => typeof m === "string").map(Number),
    anchorMode: text("anchor_mode"),
    notes: text("notes"),
    links: text("links"),
    firstDue: text("first_due"),
    formToken: text("form_token"),
  };
}

/** Checks the fields shared by adding and editing; returns what to save, or why not. */
function checkDuty(values: DutyFormValues): DutyInput | string {
  if (!values.title) return "Please enter a title.";
  if (values.title.length > 200) return "Please keep the title under 200 characters.";
  if (values.notes.length > MAX_NOTES) return `Please keep the description under ${MAX_NOTES} characters.`;

  const links = values.links
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (links.length > MAX_LINKS) return `Please give at most ${MAX_LINKS} links.`;
  for (const link of links) {
    let url: URL | null = null;
    try {
      url = new URL(link);
    } catch {
      // Not a URL at all.
    }
    if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || link.length > MAX_LINK_LENGTH) {
      return `Each link must be a web address starting with https:// (not "${link.slice(0, 80)}").`;
    }
  }

  const cadence = CADENCES.find((x) => x === values.cadence);
  if (!cadence) return "Please choose a cadence.";
  const anchorMode = ANCHOR_MODES.find((x) => x === values.anchorMode);
  if (!anchorMode) return "Please choose how the schedule is anchored.";

  const months = usesNamedMonths(cadence, anchorMode) ? [...new Set(values.months)].sort((a, b) => a - b) : null;
  // Checked on the months as ticked, so a repeated month counts as a mistake.
  const monthsProblem = namedMonthsProblem({ cadence, anchorMode, cadenceMonths: months ? values.months : null });
  if (monthsProblem) return monthsProblem;

  return {
    title: values.title,
    notes: values.notes || null,
    links: links.length > 0 ? JSON.stringify(links) : null,
    cadence,
    anchorMode,
    months,
  };
}

/** One person's Google Tasks access: a fresh access token and their list. */
async function googleFor(env: AppEnv, userId: number): Promise<{ accessToken: string; listId: string }> {
  const row = await env.DB.prepare("SELECT google_sub, refresh_token_enc, tasklist_id FROM users WHERE id = ?")
    .bind(userId)
    .first<{ google_sub: string; refresh_token_enc: string | null; tasklist_id: string | null }>();
  if (!row?.refresh_token_enc || !row.tasklist_id) throw new TasksAccessNeeded();
  try {
    const accessToken = await accessTokenFor(env, { google_sub: row.google_sub, refresh_token_enc: row.refresh_token_enc });
    return { accessToken, listId: row.tasklist_id };
  } catch (err) {
    throw new GoogleUnavailable(err instanceof Error ? err.message : String(err));
  }
}

interface OpenTask {
  occurrence_id: number;
  user_id: number;
  google_task_id: string;
}

/** The Google tasks of a duty's open occurrence (none if paused, or not yet created). */
async function openTasks(env: AppEnv, dutyId: number): Promise<OpenTask[]> {
  const { results } = await env.DB.prepare(
    `SELECT o.id AS occurrence_id, a.user_id, a.google_task_id
     FROM occurrences o JOIN assignments a ON a.occurrence_id = o.id
     WHERE o.duty_id = ? AND o.status = 'open' AND a.status = 'open' AND a.google_task_id IS NOT NULL`,
  )
    .bind(dutyId)
    .all<OpenTask>();
  return results;
}

/**
 * Applies `change` to each open Google task of a duty. A task already gone
 * from Google (404) counts as done; any other failure throws GoogleUnavailable.
 */
async function forEachOpenTask(
  env: AppEnv,
  dutyId: number,
  change: (google: { accessToken: string; listId: string }, task: OpenTask) => Promise<unknown>,
): Promise<void> {
  const access = new Map<number, { accessToken: string; listId: string }>();
  for (const task of await openTasks(env, dutyId)) {
    let google = access.get(task.user_id);
    if (!google) {
      google = await googleFor(env, task.user_id);
      access.set(task.user_id, google);
    }
    try {
      await change(google, task);
    } catch (err) {
      if (err instanceof GoogleApiError && err.status === 404) continue;
      throw new GoogleUnavailable(err instanceof Error ? err.message : String(err));
    }
  }
}

/** Statements that close a duty's open occurrence: its assignments removed, the occurrence cancelled. */
function closeOpenOccurrence(env: AppEnv, dutyId: number): D1PreparedStatement[] {
  return [
    env.DB.prepare(
      `UPDATE assignments SET status = 'removed'
       WHERE status = 'open' AND occurrence_id IN (SELECT id FROM occurrences WHERE duty_id = ? AND status = 'open')`,
    ).bind(dutyId),
    env.DB.prepare("UPDATE occurrences SET status = 'cancelled' WHERE duty_id = ? AND status = 'open'").bind(dutyId),
  ];
}

/** Creates any waiting Google tasks for this person; if Google is unavailable, the next sync does it. */
async function pushQuietly(env: AppEnv, userId: number): Promise<void> {
  try {
    const google = await googleFor(env, userId);
    const { problems } = await pushPendingTasks(env, { id: userId, tasklist_id: google.listId }, google.accessToken);
    if (problems.length > 0) console.warn("task creation left for sync:", problems.join("; "));
  } catch (err) {
    console.warn("task creation left for sync:", err instanceof Error ? err.message : String(err));
  }
}

/** The signed-in person's duty from the URL, unless it doesn't exist or was deleted. */
async function loadDuty(c: DutyContext): Promise<DutyRecord | null> {
  const id = c.req.param("id") ?? "";
  if (!/^[1-9]\d{0,15}$/.test(id)) return null;
  return c.env.DB.prepare(
    `SELECT id, title, notes, links, owner_user_id, cadence, cadence_months, anchor_mode,
            last_done_date, last_done_precision, status
     FROM duties WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL`,
  )
    .bind(Number(id), c.get("user").id)
    .first<DutyRecord>();
}

function notFound(c: DutyContext) {
  return c.html(<MessagePage title="Not found" message="That duty does not exist." back={["/", "Back to the list"]} />, 404);
}

function forbidden(c: DutyContext) {
  return c.html(<MessagePage title="Not allowed" message="That request could not be verified." />, 403);
}

/** The edit page's summary of a saved duty. */
async function savedSummary(env: AppEnv, duty: DutyRecord): Promise<SavedDuty> {
  const open = await env.DB.prepare("SELECT due_date FROM occurrences WHERE duty_id = ? AND status = 'open'")
    .bind(duty.id)
    .first<{ due_date: string }>();
  return { id: duty.id, paused: duty.status === "paused", lastDone: duty.last_done_date, nextDue: open?.due_date ?? null };
}

function valuesOf(duty: DutyRecord): DutyFormValues {
  return {
    title: duty.title,
    cadence: duty.cadence,
    months: duty.cadence_months ? (JSON.parse(duty.cadence_months) as number[]) : [],
    anchorMode: duty.anchor_mode,
    notes: duty.notes ?? "",
    links: duty.links ? (JSON.parse(duty.links) as string[]).join("\n") : "",
    firstDue: "",
    formToken: "",
  };
}

/** Shows the edit page again with an error, keeping what was typed. */
async function refuseEdit(c: DutyContext, duty: DutyRecord, values: DutyFormValues, error: string, status: 400 | 409 | 502) {
  const csrf = await csrfToken(c.env.SESSION_KEY, c.get("user").id);
  return c.html(<DutyFormPage csrf={csrf} values={values} error={error} saved={await savedSummary(c.env, duty)} />, status);
}

/** Maps a Google failure during an action to the page that explains it. */
function googleProblem(err: unknown): { error: string; status: 409 | 502 } {
  if (err instanceof TasksAccessNeeded) return { error: NEEDS_ACCESS, status: 409 };
  if (err instanceof GoogleUnavailable) {
    console.warn("duty change refused:", err.message);
    return { error: GOOGLE_DOWN, status: 502 };
  }
  throw err;
}

duties.get("/new", async (c) => {
  const user = c.get("user");
  const csrf = await csrfToken(c.env.SESSION_KEY, user.id);
  return c.html(<DutyFormPage csrf={csrf} values={{ ...EMPTY_FORM, formToken: randomToken() }} />);
});

duties.post("/", async (c) => {
  const user = c.get("user");
  if (!(await formCsrfOk(c, user.id))) return forbidden(c);

  const row = await c.env.DB.prepare("SELECT refresh_token_enc, tasklist_id FROM users WHERE id = ?")
    .bind(user.id)
    .first<{ refresh_token_enc: string | null; tasklist_id: string | null }>();
  if (!row?.refresh_token_enc || !row.tasklist_id) {
    return c.html(<MessagePage title="Tasks access needed" message={NEEDS_ACCESS} />, 409);
  }

  const values = await readForm(c);
  const csrf = await csrfToken(c.env.SESSION_KEY, user.id);
  const refuse = (error: string) => c.html(<DutyFormPage csrf={csrf} values={values} error={error} />, 400);

  if (!FORM_TOKEN_RE.test(values.formToken)) {
    values.formToken = randomToken();
    return refuse("This form has expired. Please check the details and submit it again.");
  }

  // A repeat submit of a form that already created its duty.
  const existing = await c.env.DB.prepare("SELECT id FROM duties WHERE create_token = ? AND owner_user_id = ?")
    .bind(values.formToken, user.id)
    .first<{ id: number }>();
  if (existing) return c.redirect(`/?added=${existing.id}`, 303);

  const input = checkDuty(values);
  if (typeof input === "string") return refuse(input);

  const today = householdDate(c.env.HOUSEHOLD_TZ);
  let first: { slotDate: string; dueDate: string };
  try {
    if (values.firstDue && !DATE_RE.test(values.firstDue)) throw new Error("not a full date");
    first = firstOccurrence(
      { cadence: input.cadence, anchorMode: input.anchorMode, cadenceMonths: input.months },
      today,
      values.firstDue || null,
    );
  } catch {
    return refuse("The first-due date must be a real date, written YYYY-MM-DD, or left blank.");
  }

  const token = values.formToken;
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO duties (title, notes, links, owner, owner_user_id, cadence, cadence_months, anchor_mode,
                             last_done_precision, status, create_token, created_at)
         VALUES (?, ?, ?, 'user', ?, ?, ?, ?, 'unknown', 'active', ?, ?)`,
      ).bind(
        input.title,
        input.notes,
        input.links,
        user.id,
        input.cadence,
        input.months ? JSON.stringify(input.months) : null,
        input.anchorMode,
        token,
        new Date().toISOString(),
      ),
      c.env.DB.prepare(
        `INSERT INTO occurrences (duty_id, slot_date, due_date, status)
         VALUES ((SELECT id FROM duties WHERE create_token = ?), ?, ?, 'open')`,
      ).bind(token, first.slotDate, first.dueDate),
      c.env.DB.prepare(
        `INSERT INTO assignments (occurrence_id, user_id, status)
         VALUES ((SELECT o.id FROM occurrences o JOIN duties d ON d.id = o.duty_id
                  WHERE d.create_token = ? AND o.status = 'open'), ?, 'open')`,
      ).bind(token, user.id),
    ]);
  } catch (err) {
    // Two submits racing: the other one saved the duty first.
    if (!String(err).includes("UNIQUE")) throw err;
  }
  const saved = await c.env.DB.prepare("SELECT id FROM duties WHERE create_token = ? AND owner_user_id = ?")
    .bind(token, user.id)
    .first<{ id: number }>();
  if (!saved) throw new Error("duty was not saved");

  // The duty is saved; if Google is unavailable, the next sync creates the task.
  await pushQuietly(c.env, user.id);
  return c.redirect(`/?added=${saved.id}`, 303);
});

duties.get("/:id", async (c) => {
  const duty = await loadDuty(c);
  if (!duty) return notFound(c);
  const csrf = await csrfToken(c.env.SESSION_KEY, c.get("user").id);
  return c.html(<DutyFormPage csrf={csrf} values={valuesOf(duty)} saved={await savedSummary(c.env, duty)} />);
});

duties.post("/:id", async (c) => {
  const duty = await loadDuty(c);
  if (!duty) return notFound(c);
  if (!(await formCsrfOk(c, c.get("user").id))) return forbidden(c);

  const values = await readForm(c);
  const input = checkDuty(values);
  if (typeof input === "string") return refuseEdit(c, duty, values, input, 400);

  // The open task shows the title, notes and links, so only those reach Google now.
  // A schedule change applies from the next occurrence.
  if (input.title !== duty.title || input.notes !== duty.notes || input.links !== duty.links) {
    try {
      await forEachOpenTask(c.env, duty.id, (google, task) =>
        patchTask(google.accessToken, google.listId, task.google_task_id, {
          title: input.title,
          notes: taskNotes(input.notes, input.links, task.occurrence_id),
        }),
      );
    } catch (err) {
      const { error, status } = googleProblem(err);
      return refuseEdit(c, duty, values, error, status);
    }
  }

  await c.env.DB.prepare(
    `UPDATE duties SET title = ?, notes = ?, links = ?, cadence = ?, cadence_months = ?, anchor_mode = ?
     WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(
      input.title,
      input.notes,
      input.links,
      input.cadence,
      input.months ? JSON.stringify(input.months) : null,
      input.anchorMode,
      duty.id,
    )
    .run();
  return c.redirect(`/?notice=saved&duty=${duty.id}`, 303);
});

duties.post("/:id/pause", async (c) => {
  const duty = await loadDuty(c);
  if (!duty) return notFound(c);
  if (!(await formCsrfOk(c, c.get("user").id))) return forbidden(c);
  if (duty.status === "paused") return c.redirect(`/?notice=paused&duty=${duty.id}`, 303);

  try {
    await forEachOpenTask(c.env, duty.id, (google, task) => deleteTask(google.accessToken, google.listId, task.google_task_id));
  } catch (err) {
    const { error, status } = googleProblem(err);
    return refuseEdit(c, duty, valuesOf(duty), error, status);
  }
  await c.env.DB.batch([
    ...closeOpenOccurrence(c.env, duty.id),
    c.env.DB.prepare("UPDATE duties SET status = 'paused' WHERE id = ?").bind(duty.id),
  ]);
  return c.redirect(`/?notice=paused&duty=${duty.id}`, 303);
});

duties.post("/:id/resume", async (c) => {
  const duty = await loadDuty(c);
  if (!duty) return notFound(c);
  if (!(await formCsrfOk(c, c.get("user").id))) return forbidden(c);
  if (duty.status !== "paused") return c.redirect(`/?notice=resumed&duty=${duty.id}`, 303);

  const form = await c.req.parseBody();
  const nextDue = typeof form.next_due === "string" ? form.next_due.trim() : "";
  const schedule = {
    cadence: duty.cadence,
    anchorMode: duty.anchor_mode,
    cadenceMonths: duty.cadence_months ? (JSON.parse(duty.cadence_months) as number[]) : null,
    lastDoneDate: duty.last_done_date,
    lastDonePrecision: duty.last_done_precision,
  };
  const today = householdDate(c.env.HOUSEHOLD_TZ);
  let next: { slotDate: string; dueDate: string };
  try {
    if (nextDue) {
      if (!DATE_RE.test(nextDue)) throw new Error("not a full date");
      next = firstOccurrence(schedule, today, nextDue);
    } else {
      const due = firstDueDate(schedule, today);
      next = { slotDate: due, dueDate: due };
    }
  } catch {
    return refuseEdit(c, duty, valuesOf(duty), "The next-due date must be a real date, written YYYY-MM-DD, or left blank.", 400);
  }

  try {
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE duties SET status = 'active' WHERE id = ? AND status = 'paused'").bind(duty.id),
      c.env.DB.prepare("INSERT INTO occurrences (duty_id, slot_date, due_date, status) VALUES (?, ?, ?, 'open')").bind(
        duty.id,
        next.slotDate,
        next.dueDate,
      ),
      c.env.DB.prepare(
        `INSERT INTO assignments (occurrence_id, user_id, status)
         VALUES ((SELECT id FROM occurrences WHERE duty_id = ? AND status = 'open'), ?, 'open')`,
      ).bind(duty.id, duty.owner_user_id),
    ]);
  } catch (err) {
    // Two resumes racing: the one-open-occurrence index let the other one win.
    if (!String(err).includes("UNIQUE")) throw err;
  }
  await pushQuietly(c.env, duty.owner_user_id);
  return c.redirect(`/?notice=resumed&duty=${duty.id}`, 303);
});

duties.post("/:id/delete", async (c) => {
  const duty = await loadDuty(c);
  if (!duty) return notFound(c);
  if (!(await formCsrfOk(c, c.get("user").id))) return forbidden(c);

  try {
    await forEachOpenTask(c.env, duty.id, (google, task) => deleteTask(google.accessToken, google.listId, task.google_task_id));
  } catch (err) {
    const { error, status } = googleProblem(err);
    return refuseEdit(c, duty, valuesOf(duty), error, status);
  }
  // Completed occurrences stay, so the duty's history is kept.
  await c.env.DB.batch([
    ...closeOpenOccurrence(c.env, duty.id),
    c.env.DB.prepare("UPDATE duties SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").bind(
      new Date().toISOString(),
      duty.id,
    ),
  ]);
  return c.redirect(`/?notice=deleted&duty=${duty.id}`, 303);
});
