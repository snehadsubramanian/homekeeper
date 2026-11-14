/**
 * TEMPORARY (Step 3 round-trip spike): a button that creates one test task due
 * today. Step 5 replaces it with real duties; Step 14 removes any leftovers.
 */
import { Hono } from "hono";
import { type AppContext, formCsrfOk } from "./auth";
import { GoogleApiError } from "./google";
import { accessTokenFor } from "./jobs";
import { MessagePage } from "./pages";
import { createTask } from "./tasks";
import { householdDate, householdDateTime, toGoogleDue } from "./time";

export const spike = new Hono<AppContext>();

spike.post("/test-task", async (c) => {
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

  const now = new Date();
  try {
    const accessToken = await accessTokenFor(c.env, { google_sub: row.google_sub, refresh_token_enc: row.refresh_token_enc });
    await createTask(accessToken, row.tasklist_id, {
      title: `homekeeper test task (${householdDateTime(c.env.HOUSEHOLD_TZ, now)})`,
      notes: "Created by homekeeper's Step 3 test button. Safe to tick, untick or delete.",
      due: toGoogleDue(householdDate(c.env.HOUSEHOLD_TZ, now)),
    });
  } catch (err) {
    if (!(err instanceof GoogleApiError)) throw err;
    console.warn("test task failed:", err.message);
    return c.html(
      <MessagePage title="Couldn't create the task" message="Google Tasks didn't respond. Please try again in a minute." />,
      502,
    );
  }

  return c.redirect("/");
});
