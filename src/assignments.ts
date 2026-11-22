/**
 * Getting open assignments into Google Tasks. An assignment is saved first
 * with no google_task_id; this creates its task and records the id. The form
 * calls it straight after saving a duty, and every sync calls it again, so a
 * task that failed to be created is retried.
 */
import type { AppEnv } from "./env";
import { createTask } from "./tasks";
import { toGoogleDue } from "./time";

/** The line in a task's notes that ties it to its occurrence. */
export function occurrenceMarker(occurrenceId: number): string {
  return `homekeeper occurrence ${occurrenceId}`;
}

interface PendingAssignment {
  assignment_id: number;
  occurrence_id: number;
  due_date: string;
  title: string;
}

/**
 * Creates the Google task for each of this user's open assignments that has
 * none yet, then records the new task ids in one batch. One task failing
 * doesn't stop the others; its problem is returned and it is retried next sync.
 */
export async function pushPendingTasks(
  env: AppEnv,
  user: { id: number; tasklist_id: string },
  accessToken: string,
): Promise<{ created: number; problems: string[] }> {
  const { results } = await env.DB.prepare(
    `SELECT a.id AS assignment_id, o.id AS occurrence_id, o.due_date, d.title
     FROM assignments a
     JOIN occurrences o ON o.id = a.occurrence_id
     JOIN duties d ON d.id = o.duty_id
     WHERE a.user_id = ? AND a.status = 'open' AND a.google_task_id IS NULL AND o.status = 'open'
     ORDER BY a.id`,
  )
    .bind(user.id)
    .all<PendingAssignment>();

  const updates: D1PreparedStatement[] = [];
  const problems: string[] = [];
  for (const pending of results) {
    try {
      const task = await createTask(accessToken, user.tasklist_id, {
        title: pending.title,
        notes: occurrenceMarker(pending.occurrence_id),
        due: toGoogleDue(pending.due_date),
      });
      updates.push(
        env.DB.prepare("UPDATE assignments SET google_task_id = ? WHERE id = ? AND google_task_id IS NULL").bind(
          task.id,
          pending.assignment_id,
        ),
      );
    } catch (err) {
      problems.push(`assignment ${pending.assignment_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (updates.length > 0) await env.DB.batch(updates);
  return { created: updates.length, problems };
}
