/**
 * The bare duty form (Step 5): create a duty for the signed-in person, with
 * its first occurrence, assignment and Google task.
 */
import { Hono } from "hono";
import { pushPendingTasks } from "./assignments";
import { type AppContext, formCsrfOk } from "./auth";
import { accessTokenFor } from "./jobs";
import { type DutyFormValues, DutyFormPage, MessagePage } from "./pages";
import { type AnchorMode, type Cadence, firstOccurrence, namedMonthsProblem } from "./schedule";
import { csrfToken, randomToken } from "./session";
import { householdDate } from "./time";

export const duties = new Hono<AppContext>();

const CADENCES: readonly Cadence[] = ["weekly", "monthly", "quarterly", "semiannual", "yearly"];
const ANCHOR_MODES: readonly AnchorMode[] = ["fixed", "after_completion"];
const FORM_TOKEN_RE = /^[A-Za-z0-9_-]{16,100}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const EMPTY_FORM: Omit<DutyFormValues, "formToken"> = {
  title: "",
  cadence: "weekly",
  months: [],
  anchorMode: "fixed",
  firstDue: "",
};

duties.get("/new", async (c) => {
  const user = c.get("user");
  const csrf = await csrfToken(c.env.SESSION_KEY, user.id);
  return c.html(<DutyFormPage csrf={csrf} values={{ ...EMPTY_FORM, formToken: randomToken() }} />);
});

/** Whether a cadence uses named months (only fixed quarterly, twice-yearly and yearly ones do). */
function usesNamedMonths(cadence: Cadence, anchorMode: AnchorMode): boolean {
  return anchorMode === "fixed" && cadence !== "weekly" && cadence !== "monthly";
}

duties.post("/", async (c) => {
  const user = c.get("user");
  if (!(await formCsrfOk(c, user.id))) {
    return c.html(<MessagePage title="Not allowed" message="That request could not be verified." />, 403);
  }

  const row = await c.env.DB.prepare("SELECT google_sub, refresh_token_enc, tasklist_id FROM users WHERE id = ?")
    .bind(user.id)
    .first<{ google_sub: string; refresh_token_enc: string | null; tasklist_id: string | null }>();
  if (!row?.refresh_token_enc || !row.tasklist_id) {
    return c.html(
      <MessagePage
        title="Tasks access needed"
        message="homekeeper can't use your Google Tasks yet. Please sign out and sign in again, allowing access to Google Tasks."
      />,
      409,
    );
  }

  const form = await c.req.parseBody({ all: true });
  const text = (key: string) => (typeof form[key] === "string" ? (form[key] as string).trim() : "");
  const rawMonths = ([] as unknown[]).concat(form.months ?? []);
  const values: DutyFormValues = {
    title: text("title"),
    cadence: text("cadence"),
    months: rawMonths.filter((m): m is string => typeof m === "string").map(Number),
    anchorMode: text("anchor_mode"),
    firstDue: text("first_due"),
    formToken: text("form_token"),
  };
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

  if (!values.title) return refuse("Please enter a title.");
  if (values.title.length > 200) return refuse("Please keep the title under 200 characters.");
  const cadence = CADENCES.find((x) => x === values.cadence);
  if (!cadence) return refuse("Please choose a cadence.");
  const anchorMode = ANCHOR_MODES.find((x) => x === values.anchorMode);
  if (!anchorMode) return refuse("Please choose how the schedule is anchored.");

  const months = usesNamedMonths(cadence, anchorMode) ? [...new Set(values.months)].sort((a, b) => a - b) : null;
  // Checked on the months as ticked, so a repeated month counts as a mistake.
  const monthsProblem = namedMonthsProblem({ cadence, anchorMode, cadenceMonths: months ? values.months : null });
  if (monthsProblem) return refuse(monthsProblem);

  const today = householdDate(c.env.HOUSEHOLD_TZ);
  let first: { slotDate: string; dueDate: string };
  try {
    if (values.firstDue && !DATE_RE.test(values.firstDue)) throw new Error("not a full date");
    first = firstOccurrence({ cadence, anchorMode, cadenceMonths: months }, today, values.firstDue || null);
  } catch {
    return refuse("The first-due date must be a real date, written YYYY-MM-DD, or left blank.");
  }

  const token = values.formToken;
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO duties (title, owner, owner_user_id, cadence, cadence_months, anchor_mode, last_done_precision, status, create_token, created_at)
         VALUES (?, 'user', ?, ?, ?, ?, 'unknown', 'active', ?, ?)`,
      ).bind(values.title, user.id, cadence, months ? JSON.stringify(months) : null, anchorMode, token, new Date().toISOString()),
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
  try {
    const accessToken = await accessTokenFor(c.env, {
      google_sub: row.google_sub,
      refresh_token_enc: row.refresh_token_enc,
    });
    const { problems } = await pushPendingTasks(c.env, { id: user.id, tasklist_id: row.tasklist_id }, accessToken);
    if (problems.length > 0) console.warn("task creation left for sync:", problems.join("; "));
  } catch (err) {
    console.warn("task creation left for sync:", err instanceof Error ? err.message : String(err));
  }

  return c.redirect(`/?added=${saved.id}`, 303);
});
