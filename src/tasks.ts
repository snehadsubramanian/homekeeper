/**
 * Google Tasks API calls. The app only ever touches the one list it owns.
 */
import { GoogleApiError } from "./google";

const TASKS_BASE = "https://tasks.googleapis.com/tasks/v1";
const LISTS_URL = `${TASKS_BASE}/users/@me/lists`;

interface TaskList {
  id: string;
  title: string;
}

/** A task as the Tasks API returns it (only the fields the app reads). */
export interface GoogleTask {
  id: string;
  title?: string;
  status?: string;
  due?: string;
  completed?: string;
  deleted?: boolean;
  hidden?: boolean;
  updated: string;
}

async function call<T>(accessToken: string, url: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${accessToken}` };
  if (init.body) headers["content-type"] = "application/json";
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) throw new GoogleApiError(`Tasks API returned ${res.status}`, res.status);
  return (await res.json()) as T;
}

/** Returns the id of the list with this title, creating it if there isn't one. Safe to repeat. */
export async function ensureTaskList(accessToken: string, title: string): Promise<string> {
  let pageToken: string | undefined;
  do {
    const url = new URL(LISTS_URL);
    url.searchParams.set("maxResults", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await call<{ items?: TaskList[]; nextPageToken?: string }>(accessToken, url.toString());
    const existing = page.items?.find((list) => list.title === title);
    if (existing) return existing.id;
    pageToken = page.nextPageToken;
  } while (pageToken);

  const created = await call<TaskList>(accessToken, LISTS_URL, { method: "POST", body: JSON.stringify({ title }) });
  return created.id;
}

export function getTaskList(accessToken: string, id: string): Promise<TaskList> {
  return call<TaskList>(accessToken, `${LISTS_URL}/${encodeURIComponent(id)}`);
}

function tasksUrl(listId: string): URL {
  return new URL(`${TASKS_BASE}/lists/${encodeURIComponent(listId)}/tasks`);
}

/**
 * Every task in the list changed since `updatedMin` (or all of them if null),
 * including completed, hidden and deleted ones. Tasks ticked off in Google's
 * own apps are hidden, so showHidden is essential.
 */
export async function listChangedTasks(
  accessToken: string,
  listId: string,
  updatedMin: Date | null,
): Promise<GoogleTask[]> {
  const all: GoogleTask[] = [];
  let pageToken: string | undefined;
  do {
    const url = tasksUrl(listId);
    url.searchParams.set("showCompleted", "true");
    url.searchParams.set("showHidden", "true");
    url.searchParams.set("showDeleted", "true");
    url.searchParams.set("maxResults", "100");
    if (updatedMin) url.searchParams.set("updatedMin", updatedMin.toISOString());
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await call<{ items?: GoogleTask[]; nextPageToken?: string }>(accessToken, url.toString());
    all.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return all;
}

export function createTask(
  accessToken: string,
  listId: string,
  task: { title: string; notes?: string; due: string },
): Promise<GoogleTask> {
  return call<GoogleTask>(accessToken, tasksUrl(listId).toString(), { method: "POST", body: JSON.stringify(task) });
}
