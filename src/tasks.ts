/**
 * Google Tasks API: only the task-list calls Step 2 needs. The app only ever
 * touches the one list it owns.
 */
import { GoogleApiError } from "./google";

const LISTS_URL = "https://tasks.googleapis.com/tasks/v1/users/@me/lists";

interface TaskList {
  id: string;
  title: string;
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
