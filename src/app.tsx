import { Hono } from "hono";
import { type AppContext, auth, requireUser } from "./auth";
import { HomePage, PrivacyPage, SignInPage, type SyncLogRow } from "./pages";
import { csrfToken } from "./session";
import { spike } from "./spike";
import { householdDateTime } from "./time";

const app = new Hono<AppContext>();

// Public routes: the sign-in page, the privacy policy and the sign-in flow itself.
app.get("/signin", (c) => c.html(<SignInPage />));
app.get("/privacy", (c) => c.html(<PrivacyPage />));
app.route("/auth", auth);

// Everything below needs a signed-in, allow-listed user.
app.use("*", requireUser);

// TEMPORARY (Step 3): the test-task button.
app.route("/spike", spike);

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

  // TEMPORARY (Step 3): what sync has seen in this user's list.
  const synced = await c.env.DB.prepare("SELECT last_synced_at FROM users WHERE id = ?")
    .bind(user.id)
    .first<{ last_synced_at: string | null }>();
  const { results: log } = await c.env.DB.prepare(
    `SELECT seen_at, title, status, due_date, completed_date, deleted, hidden FROM sync_log
     WHERE user_id = ? ORDER BY id DESC LIMIT 20`,
  )
    .bind(user.id)
    .all<{
      seen_at: string;
      title: string | null;
      status: string | null;
      due_date: string | null;
      completed_date: string | null;
      deleted: number;
      hidden: number;
    }>();
  const rows: SyncLogRow[] = log.map((r) => ({
    seen: householdDateTime(tz, new Date(r.seen_at)),
    title: r.title ?? "(no title)",
    status: r.status === "completed" ? "completed" : r.status === "needsAction" ? "open" : (r.status ?? ""),
    due: r.due_date ?? "",
    completed: r.completed_date ?? "",
    flags: [r.deleted ? "deleted" : "", r.hidden ? "hidden" : ""].filter(Boolean).join(", "),
  }));

  return c.html(
    <HomePage
      name={user.display_name}
      email={user.email}
      csrf={csrf}
      statusLines={[taskListLine, checkLine]}
      spike={{
        lastSync: synced?.last_synced_at ? householdDateTime(tz, new Date(synced.last_synced_at)) : "never",
        rows,
      }}
    />,
  );
});

export default app;
