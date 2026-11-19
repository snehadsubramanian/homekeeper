/**
 * Background jobs, run from the Worker's cron triggers. Every job is safe to
 * re-run, and runs are logged in job_runs.
 */
import { isAllowed } from "./allowlist";
import { decryptToken } from "./crypto";
import type { AppEnv } from "./env";
import { GoogleApiError, refreshAccessToken } from "./google";
import { getTaskList, listChangedTasks } from "./tasks";
import { dateFromGoogleDue, householdDate } from "./time";

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
 * Every five minutes: read what changed in each user's task list since the
 * last sync and record it. In Step 3 this only logs to sync_log (temporary);
 * Step 5 turns check-offs into completions.
 */
export async function runSync(env: AppEnv, now: Date = new Date()): Promise<void> {
  const problems: string[] = [];
  let newEntries = 0;

  try {
    for (const user of await activeUsers(env)) {
      try {
        const accessToken = await accessTokenFor(env, user);
        const since = user.last_synced_at ? new Date(Date.parse(user.last_synced_at) - SYNC_OVERLAP_MS) : null;
        const tasks = await listChangedTasks(accessToken, user.tasklist_id, since);

        for (const task of tasks) {
          const completedDate = task.completed ? householdDate(env.HOUSEHOLD_TZ, new Date(task.completed)) : null;
          const result = await env.DB.prepare(
            `INSERT OR IGNORE INTO sync_log
               (seen_at, user_id, google_task_id, title, status, due_date, completed_date, completed_at, deleted, hidden, google_updated)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
            .bind(
              now.toISOString(),
              user.id,
              task.id,
              task.title ?? null,
              task.status ?? null,
              task.due ? dateFromGoogleDue(task.due) : null,
              completedDate,
              task.completed ?? null,
              task.deleted ? 1 : 0,
              task.hidden ? 1 : 0,
              task.updated,
            )
            .run();
          newEntries += result.meta.changes ?? 0;
        }

        // The run's start time, not its end: with the overlap, nothing in between is missed.
        await env.DB.prepare("UPDATE users SET last_synced_at = ? WHERE id = ?").bind(now.toISOString(), user.id).run();
      } catch (err) {
        problems.push(`user ${user.id}: ${describe(err)}`);
      }
    }
  } catch (err) {
    problems.push(`job: ${describe(err)}`);
  }

  await recordSyncRun(env, now, problems, newEntries);
}

/**
 * Sync runs 288 times a day, so job_runs gets every failed run but at most
 * one successful run per hour, and only for hours where sync saw a change.
 */
async function recordSyncRun(env: AppEnv, now: Date, problems: string[], newEntries: number): Promise<void> {
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
  if (newEntries === 0) return;

  const sameHour = await env.DB.prepare(
    "SELECT 1 FROM job_runs WHERE job = 'sync' AND ok = 1 AND substr(started_at, 1, 13) = ?",
  )
    .bind(startedAt.slice(0, 13))
    .first();
  if (!sameHour) await insert(1, null);
}
