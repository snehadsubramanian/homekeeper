import { Hono } from "hono";
import { type AppContext, auth, requireUser } from "./auth";
import { duties } from "./duties";
import { type DutyRow, HomePage, PrivacyPage, SignInPage } from "./pages";
import { csrfToken } from "./session";
import { householdDate, householdDateTime } from "./time";

const app = new Hono<AppContext>();

// Public routes: the sign-in page, the privacy policy and the sign-in flow itself.
app.get("/signin", (c) => c.html(<SignInPage />));
app.get("/privacy", (c) => c.html(<PrivacyPage />));
app.route("/auth", auth);

// Everything below needs a signed-in, allow-listed user.
app.use("*", requireUser);

app.route("/duties", duties);

/** "2026-11-20T09:00:02.000Z" → "2026-11-20 09:00 UTC" */
function utcMinute(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

app.get("/", async (c) => {
  const user = c.get("user");
  const tz = c.env.HOUSEHOLD_TZ;
  const csrf = await csrfToken(c.env.SESSION_KEY, user.id);

  const lastCheck = await c.env.DB.prepare(
    "SELECT started_at, ok, error FROM job_runs WHERE job = 'token_refresh' ORDER BY started_at DESC, id DESC LIMIT 1",
  ).first<{ started_at: string; ok: number | null; error: string | null }>();

  const taskListLine = user.tasklist_id ? `Task list: ${c.env.TASKLIST_NAME}` : "Task list: not set up yet";
  let checkLine = "Daily Google check: not run yet";
  if (lastCheck) {
    const result = lastCheck.ok === 1 ? "OK" : lastCheck.ok === 0 ? "FAILED" : "RUNNING";
    const detail = lastCheck.ok === 0 && lastCheck.error ? ` (${lastCheck.error})` : "";
    checkLine = `Daily Google check: ${result}, last ran ${utcMinute(lastCheck.started_at)}${detail}`;
  }

  const synced = await c.env.DB.prepare("SELECT last_synced_at FROM users WHERE id = ?")
    .bind(user.id)
    .first<{ last_synced_at: string | null }>();
  const syncLine = `Last sync: ${synced?.last_synced_at ? householdDateTime(tz, new Date(synced.last_synced_at)) : "never"}`;

  // Confirms a duty just added through the form (only the signed-in person's own).
  const addedId = Number(c.req.query("added"));
  const added = Number.isInteger(addedId) && addedId > 0
    ? await c.env.DB.prepare(
        `SELECT d.title, o.due_date, a.google_task_id
         FROM duties d
         JOIN occurrences o ON o.duty_id = d.id AND o.status = 'open'
         JOIN assignments a ON a.occurrence_id = o.id AND a.user_id = ?
         WHERE d.id = ? AND d.owner_user_id = ?`,
      )
        .bind(user.id, addedId, user.id)
        .first<{ title: string; due_date: string; google_task_id: string | null }>()
    : null;

  // The list view: the signed-in person's duties, soonest first, paused ones last.
  // Overdue means the open occurrence's original slot has passed, since roll-forward
  // keeps moving its due date to today.
  const today = householdDate(tz);
  const overdueOnly = c.req.query("overdue") === "1";
  const { results } = await c.env.DB.prepare(
    `SELECT d.id, d.title, d.cadence, d.cadence_months, d.anchor_mode, d.last_done_date, d.status,
            o.slot_date, o.due_date
     FROM duties d
     LEFT JOIN occurrences o ON o.duty_id = d.id AND o.status = 'open'
     WHERE d.owner_user_id = ? AND d.deleted_at IS NULL
     ORDER BY d.status = 'paused', o.due_date, d.title COLLATE NOCASE, d.id`,
  )
    .bind(user.id)
    .all<{
      id: number;
      title: string;
      cadence: string;
      cadence_months: string | null;
      anchor_mode: string;
      last_done_date: string | null;
      status: string;
      slot_date: string | null;
      due_date: string | null;
    }>();
  const dutyRows: DutyRow[] = results
    .map((r) => ({
      id: r.id,
      title: r.title,
      cadence: r.cadence,
      cadenceMonths: r.cadence_months ? (JSON.parse(r.cadence_months) as number[]) : null,
      anchorMode: r.anchor_mode,
      lastDone: r.last_done_date,
      nextDue: r.due_date,
      overdueSince: r.slot_date && r.slot_date < today ? r.slot_date : null,
      paused: r.status === "paused",
    }))
    .filter((r) => !overdueOnly || r.overdueSince !== null);

  // Confirms an edit, pause, resume or delete (deleted duties are still found here).
  const noticeKind = c.req.query("notice");
  const noticeId = Number(c.req.query("duty"));
  let notice: string | null = null;
  if (["saved", "paused", "resumed", "deleted"].includes(noticeKind ?? "") && Number.isInteger(noticeId) && noticeId > 0) {
    const d = await c.env.DB.prepare(
      `SELECT d.title, o.due_date FROM duties d
       LEFT JOIN occurrences o ON o.duty_id = d.id AND o.status = 'open'
       WHERE d.id = ? AND d.owner_user_id = ?`,
    )
      .bind(noticeId, user.id)
      .first<{ title: string; due_date: string | null }>();
    if (d) {
      notice = {
        saved: `Saved ${d.title}.`,
        paused: `Paused ${d.title}. Its Google task was removed.`,
        resumed: `Resumed ${d.title}. Next due ${d.due_date ?? "soon"}.`,
        deleted: `Deleted ${d.title}. Its Google task was removed.`,
      }[noticeKind as "saved" | "paused" | "resumed" | "deleted"];
    }
  }

  return c.html(
    <HomePage
      name={user.display_name}
      email={user.email}
      csrf={csrf}
      statusLines={[taskListLine, checkLine, syncLine]}
      added={added ? { title: added.title, dueDate: added.due_date, taskPending: added.google_task_id === null } : null}
      notice={notice}
      duties={dutyRows}
      overdueOnly={overdueOnly}
    />,
  );
});

export default app;
