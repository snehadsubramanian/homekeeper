/**
 * Background jobs, run from the Worker's cron triggers. Every job is safe to
 * re-run, and runs are logged in job_runs.
 */
import { isAllowed } from "./allowlist";
import { pushPendingTasks } from "./assignments";
import { decryptToken } from "./crypto";
import type { AppEnv } from "./env";
import { GoogleApiError, refreshAccessToken } from "./google";
import { type AnchorMode, type Cadence, nextDueDate, rolledDueDate } from "./schedule";
import { type GoogleTask, getTaskList, listChangedTasks, patchTask } from "./tasks";
import { householdDate, toGoogleDue } from "./time";

/** Must match the "crons" in wrangler.jsonc. */
export const CRON_DAILY = "0 9 * * *";
export const CRON_SYNC = "*/5 * * * *";

/** How far back each sync re-reads, so a change made during the previous run isn't missed. */
const SYNC_OVERLAP_MS = 10 * 60 * 1000;

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A fresh access token from the user's stored, encrypted refresh token. */
export async function accessTokenFor(
  env: AppEnv,
  user: { google_sub: string; refresh_token_enc: string },
): Promise<string> {
  const refreshToken = await decryptToken(env.TOKEN_ENC_KEY, user.refresh_token_enc, user.google_sub);
  return refreshAccessToken(env, refreshToken);
}

interface SyncUser {
  id: number;
  email: string;
  google_sub: string;
  refresh_token_enc: string;
  tasklist_id: string;
  last_synced_at: string | null;
}

/** Users the app may act for: allow-listed, with Tasks access and a list. */
async function activeUsers(env: AppEnv): Promise<SyncUser[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, email, google_sub, refresh_token_enc, tasklist_id, last_synced_at FROM users
     WHERE refresh_token_enc IS NOT NULL ORDER BY id`,
  ).all<Omit<SyncUser, "tasklist_id"> & { tasklist_id: string | null }>();
  // Someone removed from the allow-list keeps their row, but the app stops using their Google access.
  return results.filter((u): u is SyncUser => isAllowed(env, u.email) && u.tasklist_id !== null);
}

/**
 * Daily check that Google access still works: refresh each user's token and
 * read their task list. This is Step 2's proof that sign-in doesn't expire.
 */
export async function runTokenRefresh(env: AppEnv): Promise<void> {
  const run = await env.DB.prepare("INSERT INTO job_runs (job, started_at) VALUES ('token_refresh', ?) RETURNING id")
    .bind(new Date().toISOString())
    .first<{ id: number }>();
  const problems: string[] = [];

  try {
    for (const user of await activeUsers(env)) {
      try {
        const accessToken = await accessTokenFor(env, user);
        await getTaskList(accessToken, user.tasklist_id).catch((err) => {
          if (err instanceof GoogleApiError && err.status === 404) throw new Error("task list not found in Google");
          throw err;
        });
      } catch (err) {
        problems.push(`user ${user.id}: ${describe(err)}`);
      }
    }
  } catch (err) {
    problems.push(`job: ${describe(err)}`);
  }

  if (problems.length > 0) console.warn("token_refresh problems:", problems.join("; "));
  await env.DB.prepare("UPDATE job_runs SET finished_at = ?, ok = ?, error = ? WHERE id = ?")
    .bind(new Date().toISOString(), problems.length === 0 ? 1 : 0, problems.join("; ") || null, run!.id)
    .run();
}

/**
 * Every five minutes, for each person: read what changed in their task list
 * since the last sync, turn each check-off into a completion and schedule the
 * next occurrence, then create any Google tasks still missing. Each person's
 * completions are written in one batch, so a run never half-records one.
 * Deletes, date moves and un-checks are Step 11; for now they change nothing.
 */
export async function runSync(env: AppEnv, now: Date = new Date()): Promise<void> {
  const problems: string[] = [];
  let activity = 0;

  try {
    for (const user of await activeUsers(env)) {
      try {
        const accessToken = await accessTokenFor(env, user);
        const since = user.last_synced_at ? new Date(Date.parse(user.last_synced_at) - SYNC_OVERLAP_MS) : null;
        const tasks = await listChangedTasks(accessToken, user.tasklist_id, since);

        const { statements, completions, skipped } = await completionWrites(env, user.id, tasks, now);
        problems.push(...skipped.map((p) => `user ${user.id}: ${p}`));
        // The run's start time, not its end: with the overlap, nothing in between is missed.
        statements.push(
          env.DB.prepare("UPDATE users SET last_synced_at = ? WHERE id = ?").bind(now.toISOString(), user.id),
        );
        await env.DB.batch(statements);
        activity += completions;

        const pushed = await pushPendingTasks(env, user, accessToken);
        problems.push(...pushed.problems.map((p) => `user ${user.id}: ${p}`));
        activity += pushed.created;
      } catch (err) {
        problems.push(`user ${user.id}: ${describe(err)}`);
      }
    }
  } catch (err) {
    problems.push(`job: ${describe(err)}`);
  }

  await recordSyncRun(env, now, problems, activity);
}

interface OpenAssignment {
  assignment_id: number;
  google_task_id: string;
  occurrence_id: number;
  slot_date: string;
  duty_id: number;
  cadence: Cadence;
  cadence_months: string | null;
  anchor_mode: AnchorMode;
}

/**
 * The writes that record each newly checked-off task: its assignment and
 * occurrence done on the household date, the duty's last-done date, and the
 * next occurrence with an assignment waiting for its Google task. A duty that
 * can't be scheduled is skipped and reported, and the rest go ahead.
 *
 * Only open assignments are considered, so a check-off seen again in the next
 * sync's overlap does nothing. If two runs ever raced, the one-open-occurrence
 * index would make the second batch fail as a whole.
 */
async function completionWrites(
  env: AppEnv,
  userId: number,
  tasks: GoogleTask[],
  now: Date,
): Promise<{ statements: D1PreparedStatement[]; completions: number; skipped: string[] }> {
  const statements: D1PreparedStatement[] = [];
  const skipped: string[] = [];
  const ticked = tasks.filter((t) => t.status === "completed" && t.completed && !t.deleted);
  if (ticked.length === 0) return { statements, completions: 0, skipped };

  const { results } = await env.DB.prepare(
    `SELECT a.id AS assignment_id, a.google_task_id, o.id AS occurrence_id, o.slot_date,
            d.id AS duty_id, d.cadence, d.cadence_months, d.anchor_mode
     FROM assignments a
     JOIN occurrences o ON o.id = a.occurrence_id
     JOIN duties d ON d.id = o.duty_id
     WHERE a.user_id = ? AND a.status = 'open' AND o.status = 'open' AND a.google_task_id IS NOT NULL`,
  )
    .bind(userId)
    .all<OpenAssignment>();
  const byTask = new Map(results.map((r) => [r.google_task_id, r]));
  const today = householdDate(env.HOUSEHOLD_TZ, now);

  let completions = 0;
  for (const task of ticked) {
    const open = byTask.get(task.id);
    if (!open) continue; // Already recorded, or not one of the app's tasks.
    try {
      const doneDate = householdDate(env.HOUSEHOLD_TZ, new Date(task.completed!));
      const next = nextDueDate(
        {
          cadence: open.cadence,
          anchorMode: open.anchor_mode,
          cadenceMonths: open.cadence_months ? (JSON.parse(open.cadence_months) as number[]) : null,
        },
        doneDate,
        open.slot_date,
      );
      statements.push(
        env.DB.prepare("UPDATE assignments SET status = 'done', completed_date = ? WHERE id = ? AND status = 'open'").bind(
          doneDate,
          open.assignment_id,
        ),
        env.DB.prepare("UPDATE occurrences SET status = 'done', completed_date = ? WHERE id = ? AND status = 'open'").bind(
          doneDate,
          open.occurrence_id,
        ),
        env.DB.prepare("UPDATE duties SET last_done_date = ?, last_done_precision = 'day' WHERE id = ?").bind(
          doneDate,
          open.duty_id,
        ),
        env.DB.prepare("INSERT INTO occurrences (duty_id, slot_date, due_date, status) VALUES (?, ?, ?, 'open')").bind(
          open.duty_id,
          next,
          rolledDueDate(next, today),
        ),
        env.DB.prepare(
          `INSERT INTO assignments (occurrence_id, user_id, status)
           VALUES ((SELECT id FROM occurrences WHERE duty_id = ? AND status = 'open'), ?, 'open')`,
        ).bind(open.duty_id, userId),
      );
      completions++;
    } catch (err) {
      skipped.push(`duty ${open.duty_id} skipped: ${describe(err)}`);
    }
  }
  return { statements, completions, skipped };
}

/**
 * Sync runs 288 times a day, so job_runs gets every failed run but at most
 * one successful run per hour, and only for hours where sync recorded a
 * completion or created a task.
 */
async function recordSyncRun(env: AppEnv, now: Date, problems: string[], activity: number): Promise<void> {
  const startedAt = now.toISOString();
  const insert = (ok: number, error: string | null) =>
    env.DB.prepare("INSERT INTO job_runs (job, started_at, finished_at, ok, error) VALUES ('sync', ?, ?, ?, ?)")
      .bind(startedAt, new Date().toISOString(), ok, error)
      .run();

  if (problems.length > 0) {
    console.warn("sync problems:", problems.join("; "));
    await insert(0, problems.join("; "));
    return;
  }
  if (activity === 0) return;

  const sameHour = await env.DB.prepare(
    "SELECT 1 FROM job_runs WHERE job = 'sync' AND ok = 1 AND substr(started_at, 1, 13) = ?",
  )
    .bind(startedAt.slice(0, 13))
    .first();
  if (!sameHour) await insert(1, null);
}


/** The daily cron run: the token check, then the roll-forward. Each logs its own job_runs row. */
export async function runDaily(env: AppEnv, now: Date = new Date()): Promise<void> {
  await runTokenRefresh(env);
  await runRollForward(env, now);
}

interface OverdueAssignment {
  assignment_id: number;
  google_task_id: string | null;
  occurrence_id: number;
  due_date: string;
}

/**
 * Each morning, every open occurrence whose due date has passed moves to
 * today (the household date), in Google first and then in the database.
 * slot_date keeps the original due date. Nothing is ever created, so a duty
 * keeps its one task.
 *
 * A task Google can't update keeps its old date in the database, so the next
 * run (even the same day) tries again. A row that can't be rolled is skipped
 * and reported while the others go ahead. A re-run finds nothing overdue.
 * All of a run's date changes are written in one batch at the end.
 */
export async function runRollForward(env: AppEnv, now: Date = new Date()): Promise<void> {
  const run = await env.DB.prepare("INSERT INTO job_runs (job, started_at) VALUES ('roll_forward', ?) RETURNING id")
    .bind(new Date().toISOString())
    .first<{ id: number }>();
  const problems: string[] = [];
  const moves: D1PreparedStatement[] = [];

  try {
    const today = householdDate(env.HOUSEHOLD_TZ, now);
    for (const user of await activeUsers(env)) {
      try {
        const { results: overdue } = await env.DB.prepare(
          `SELECT a.id AS assignment_id, a.google_task_id, o.id AS occurrence_id, o.due_date
           FROM assignments a
           JOIN occurrences o ON o.id = a.occurrence_id
           WHERE a.user_id = ? AND a.status = 'open' AND o.status = 'open' AND o.due_date < ?
           ORDER BY a.id`,
        )
          .bind(user.id, today)
          .all<OverdueAssignment>();
        if (overdue.length === 0) continue;
        const accessToken = overdue.some((r) => r.google_task_id) ? await accessTokenFor(env, user) : null;

        for (const row of overdue) {
          try {
            const due = rolledDueDate(row.due_date, today);
            // No task yet: sync's pushPendingTasks will create it with the new date.
            if (row.google_task_id) await patchTask(accessToken!, user.tasklist_id, row.google_task_id, { due: toGoogleDue(due) });
            moves.push(
              env.DB.prepare("UPDATE occurrences SET due_date = ? WHERE id = ? AND status = 'open' AND due_date < ?").bind(
                due,
                row.occurrence_id,
                due,
              ),
            );
          } catch (err) {
            problems.push(`user ${user.id}: assignment ${row.assignment_id}: ${describe(err)}`);
          }
        }
      } catch (err) {
        problems.push(`user ${user.id}: ${describe(err)}`);
      }
    }
    if (moves.length > 0) await env.DB.batch(moves);
  } catch (err) {
    problems.push(`job: ${describe(err)}`);
  }

  if (problems.length > 0) console.warn("roll_forward problems:", problems.join("; "));
  await env.DB.prepare("UPDATE job_runs SET finished_at = ?, ok = ?, error = ? WHERE id = ?")
    .bind(new Date().toISOString(), problems.length === 0 ? 1 : 0, problems.join("; ") || null, run!.id)
    .run();
}
