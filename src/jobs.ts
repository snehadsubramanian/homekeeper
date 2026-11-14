/**
 * Background jobs, run from the Worker's cron trigger. Each run is logged in
 * job_runs, and every job is safe to re-run.
 */
import { isAllowed } from "./allowlist";
import { decryptToken } from "./crypto";
import type { AppEnv } from "./env";
import { GoogleApiError, refreshAccessToken } from "./google";
import { getTaskList } from "./tasks";

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
    const { results: users } = await env.DB.prepare(
      "SELECT id, email, google_sub, refresh_token_enc, tasklist_id FROM users WHERE refresh_token_enc IS NOT NULL ORDER BY id",
    ).all<{ id: number; email: string; google_sub: string; refresh_token_enc: string; tasklist_id: string | null }>();

    for (const user of users) {
      // Someone removed from the allow-list keeps their row, but the app stops using their Google access.
      if (!isAllowed(env, user.email)) continue;
      try {
        const refreshToken = await decryptToken(env.TOKEN_ENC_KEY, user.refresh_token_enc, user.google_sub);
        const accessToken = await refreshAccessToken(env, refreshToken);
        if (user.tasklist_id) {
          await getTaskList(accessToken, user.tasklist_id).catch((err) => {
            if (err instanceof GoogleApiError && err.status === 404) throw new Error("task list not found in Google");
            throw err;
          });
        }
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
