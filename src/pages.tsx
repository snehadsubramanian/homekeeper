import type { Child } from "hono/jsx";

function Layout({ title, children }: { title: string; children: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
      </head>
      <body>
        <h1>homekeeper</h1>
        {children}
      </body>
    </html>
  );
}

export function SignInPage() {
  return (
    <Layout title="Sign in · homekeeper">
      <p>
        <a href="/auth/login">Sign in with Google</a>
      </p>
      <p>
        <small>
          <a href="/privacy">Privacy policy</a>
        </small>
      </p>
    </Layout>
  );
}

export function PrivacyPage() {
  return (
    <Layout title="Privacy policy · homekeeper">
      <h2>Privacy policy</h2>
      <p>
        homekeeper is a private app for keeping one household's recurring duties on schedule. It is not offered to the
        public.
      </p>

      <h3>Who can use it</h3>
      <p>
        Only the Google accounts on this household's allow-list can sign in. If any other account tries, it is turned
        away and nothing about it is stored.
      </p>

      <h3>What it stores</h3>
      <ul>
        <li>For each allowed person: their email address, name and Google account ID.</li>
        <li>
          Once Google Tasks access is granted: an encrypted Google refresh token and the ID of the app's own task list.
        </li>
        <li>The household's duties, their schedules and when they were done.</li>
      </ul>
      <p>
        This data is kept in the household's own Cloudflare account. It is not sold or shared, and the app uses no
        analytics or advertising.
      </p>

      <h3>What it does with your Google account</h3>
      <ul>
        <li>Sign-in uses only your name and email address.</li>
        <li>
          With your permission, it creates, updates and reads tasks in a single task list of its own. It does not touch
          your other task lists.
        </li>
        <li>If the weekly summary is turned on, it can send that email from your Gmail. It cannot read your mail.</li>
      </ul>
      <p>
        homekeeper's use of information received from Google APIs adheres to the{" "}
        <a href="https://developers.google.com/terms/api-services-user-data-policy">
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements.
      </p>

      <h3>Removing access</h3>
      <p>
        You can cut off the app at any time from your Google Account's third-party access page. To have your data
        deleted, ask the person who runs this copy of homekeeper.
      </p>

      <p>
        <a href="/signin">Back to sign-in</a>
      </p>
    </Layout>
  );
}

export function HomePage({
  name,
  email,
  csrf,
  statusLines,
  added,
}: {
  name: string | null;
  email: string;
  csrf: string;
  statusLines: string[];
  /** The duty just added through the form, if any. */
  added: { title: string; dueDate: string; taskPending: boolean } | null;
}) {
  return (
    <Layout title="homekeeper">
      <p>
        Signed in as {name ? `${name} (${email})` : email}.
      </p>
      {statusLines.map((line) => (
        <p>{line}</p>
      ))}

      {added && (
        <p>
          <strong>
            Added {added.title}. First task due {added.dueDate}.
          </strong>
          {added.taskPending
            ? " Google Tasks could not be reached, so its task will be created at the next sync (within 5 minutes)."
            : " It is in your Google Tasks list now."}
        </p>
      )}

      <p>
        <a href="/duties/new">Add a duty</a>
      </p>

      <form method="post" action="/auth/logout">
        <input type="hidden" name="_csrf" value={csrf} />
        <button type="submit">Sign out</button>
      </form>
    </Layout>
  );
}

/** What the duty form shows: blank for a new form, or as submitted when it is refused. */
export interface DutyFormValues {
  title: string;
  cadence: string;
  months: number[];
  anchorMode: string;
  firstDue: string;
  /** One-time token: a second submit of the same form creates no second duty. */
  formToken: string;
}

const CADENCE_LABELS: [string, string][] = [
  ["weekly", "Weekly"],
  ["monthly", "Monthly"],
  ["quarterly", "Quarterly"],
  ["semiannual", "Twice yearly"],
  ["yearly", "Yearly"],
];

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function DutyFormPage({ csrf, values, error }: { csrf: string; values: DutyFormValues; error?: string }) {
  return (
    <Layout title="Add a duty · homekeeper">
      <h2>Add a duty</h2>
      {error && (
        <p role="alert">
          <strong>{error}</strong>
        </p>
      )}
      <form method="post" action="/duties" onsubmit="this.querySelector('button').disabled = true">
        <input type="hidden" name="_csrf" value={csrf} />
        <input type="hidden" name="form_token" value={values.formToken} />

        <p>
          <label>
            Title <input name="title" value={values.title} required maxlength={200} />
          </label>
        </p>

        <p>
          <label>
            Cadence{" "}
            <select name="cadence">
              {CADENCE_LABELS.map(([value, label]) => (
                <option value={value} selected={values.cadence === value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </p>

        <fieldset>
          <legend>Schedule</legend>
          <label>
            <input type="radio" name="anchor_mode" value="fixed" checked={values.anchorMode !== "after_completion"} />{" "}
            Fixed schedule (stays on its weeks or named months)
          </label>
          <br />
          <label>
            <input
              type="radio"
              name="anchor_mode"
              value="after_completion"
              checked={values.anchorMode === "after_completion"}
            />{" "}
            After completion (counts from when it was done)
          </label>
        </fieldset>

        <fieldset>
          <legend>Named months (fixed quarterly: 4, twice yearly: 2, yearly: 1)</legend>
          {MONTH_NAMES.map((label, i) => (
            <label>
              <input type="checkbox" name="months" value={String(i + 1)} checked={values.months.includes(i + 1)} />{" "}
              {label}{" "}
            </label>
          ))}
        </fieldset>

        <p>
          <label>
            First due (optional) <input type="date" name="first_due" value={values.firstDue} />
          </label>
          <br />
          <small>
            Leave blank to use the default: weekly duties on the next Saturday, fixed duties on the first Saturday of
            their next named month, after-completion duties today.
          </small>
        </p>

        <p>
          <button type="submit">Add duty</button> <a href="/">Cancel</a>
        </p>
      </form>
    </Layout>
  );
}

export function MessagePage({ title, message }: { title: string; message: string }) {
  return (
    <Layout title={`${title} · homekeeper`}>
      <p>{message}</p>
      <p>
        <a href="/signin">Back to sign-in</a>
      </p>
    </Layout>
  );
}
