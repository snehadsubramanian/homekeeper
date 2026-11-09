# homekeeper

A small web app that keeps recurring household chores on schedule using Google Tasks.

You define each duty once, with what it is, who owns it and how often it recurs. homekeeper puts the next occurrence into the owner's Google Calendar as a task. When someone checks it off, homekeeper records the completion and schedules the next one. When a task is missed, it rolls forward to today every morning until it gets done.

> **Status:** early development. The app is being built in small, testable steps, and nothing here is ready for general use yet.

## What it does

- Supports **weekly, monthly, quarterly, twice-yearly and yearly** duties. A cadence can be pinned to specific months (for example, April and October) or counted from the last completion.
- Creates **Google Tasks** that appear in Google Calendar, so you check things off where you already look.
- Lets each duty belong to one person or be **joint**, with either "anyone can complete it" or "everyone must complete it".
- **Rolls overdue tasks forward** each morning instead of letting them silently slip.
- Responds to changes made in Google: un-checking a task undoes its completion, deleting a task skips that occurrence, and dragging a task to another date is reset to the app's date.
- Can send an optional **weekly summary email** of overdue and upcoming duties.

## How it works

homekeeper is a single [Cloudflare Worker](https://developers.cloudflare.com/workers/) with a [D1](https://developers.cloudflare.com/d1/) database.

- A web page lists your duties and lets you add, edit, pause or mark them done.
- A background job runs every 5 minutes to check Google Tasks for check-offs and other changes.
- A daily job rolls overdue tasks forward and sends the weekly email.

The Google Tasks API has no push notifications, so homekeeper polls for changes. A check-off reaches the app within about 5 minutes.

## Privacy

- Only Google accounts on an allow-list can sign in. Everyone else sees a sign-in page that turns them away.
- Duty data lives in your own Cloudflare account. Google refresh tokens are encrypted at rest.
- The app touches only its own Google Tasks list. Gmail access, if enabled, is send-only.

## Tech stack

TypeScript · Cloudflare Workers · Hono · htmx · Cloudflare D1 · Google Tasks and Gmail APIs · Vitest

## Running your own copy

Full setup instructions will come once the first version works end to end. In outline:

1. Create a free Cloudflare account and a Google Cloud project with the Tasks API enabled.
2. Clone this repo, run `npm install`, and create the D1 database with Wrangler.
3. Set the secrets (Google client secret, session key, token-encryption key) and variables (`ALLOWED_EMAILS`, `APP_BASE_URL`, `HOUSEHOLD_TZ`).
4. Deploy with `npx wrangler deploy`.

## License

[MIT](LICENSE)
