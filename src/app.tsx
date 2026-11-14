import { Hono } from "hono";
import { type AppContext, auth, requireUser } from "./auth";
import { HomePage, PrivacyPage, SignInPage } from "./pages";
import { csrfToken } from "./session";

const app = new Hono<AppContext>();

// Public routes: the sign-in page, the privacy policy and the sign-in flow itself.
app.get("/signin", (c) => c.html(<SignInPage />));
app.get("/privacy", (c) => c.html(<PrivacyPage />));
app.route("/auth", auth);

// Everything below needs a signed-in, allow-listed user.
app.use("*", requireUser);

/** "2026-11-20T09:00:02.000Z" → "2026-11-20 09:00 UTC" */
function utcMinute(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

app.get("/", async (c) => {
  const user = c.get("user");
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

  return c.html(
    <HomePage
      name={user.display_name}
      email={user.email}
      csrf={csrf}
      statusLines={[taskListLine, checkLine]}
    />,
  );
});

export default app;
