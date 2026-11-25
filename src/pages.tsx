import type { Child } from "hono/jsx";

function Layout({ title, children }: { title: string; children: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <style>{"table{border-collapse:collapse}th,td{padding:4px 10px;text-align:left;border-bottom:1px solid #ddd}"}</style>
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

/** One row of the list view. */
export interface DutyRow {
  id: number;
  title: string;
  cadence: string;
  cadenceMonths: number[] | null;
  anchorMode: string;
  lastDone: string | null;
  /** The open occurrence's current date; null when paused. */
  nextDue: string | null;
  /** The open occurrence's original slot when it has passed, else null. */
  overdueSince: string | null;
  paused: boolean;
}

export function HomePage({
  name,
  email,
  csrf,
  statusLines,
  added,
  notice,
  duties,
  overdueOnly,
}: {
  name: string | null;
  email: string;
  csrf: string;
  statusLines: string[];
  /** The duty just added through the form, if any. */
  added: { title: string; dueDate: string; taskPending: boolean } | null;
  /** Confirms an edit, pause, resume or delete. */
  notice: string | null;
  duties: DutyRow[];
  overdueOnly: boolean;
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
      {notice && (
        <p>
          <strong>{notice}</strong>
        </p>
      )}

      <h2>Duties</h2>
      <p>
        <a href="/duties/new">Add a duty</a>
        {" · "}
        {overdueOnly ? <a href="/">Show all duties</a> : <a href="/?overdue=1">Show overdue only</a>}
      </p>
      {duties.length === 0 ? (
        <p>{overdueOnly ? "Nothing is overdue." : "No duties yet."}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Duty</th>
              <th>Cadence</th>
              <th>Last done</th>
              <th>Next due</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {duties.map((d) => (
              <tr data-duty={String(d.id)}>
                <td>
                  <a href={`/duties/${d.id}`}>{d.title}</a>
                </td>
                <td>{cadenceLabel(d.cadence, d.cadenceMonths, d.anchorMode)}</td>
                <td>{d.lastDone ?? "never"}</td>
                <td>{d.paused ? "Paused" : (d.nextDue ?? "")}</td>
                <td>{d.overdueSince && <strong>Overdue since {d.overdueSince}</strong>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

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
  notes: string;
  /** As typed: one link per line. */
  links: string;
  /** Adding only. */
  firstDue: string;
  /** Adding only. One-time token: a second submit of the same form creates no second duty. */
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

/** "Twice yearly in Apr, Oct, fixed" or "Weekly, after completion". */
export function cadenceLabel(cadence: string, months: number[] | null, anchorMode: string): string {
  const name = CADENCE_LABELS.find(([value]) => value === cadence)?.[1] ?? cadence;
  const named = months && months.length > 0 ? ` in ${months.map((m) => MONTH_NAMES[m - 1]).join(", ")}` : "";
  return `${name}${named}, ${anchorMode === "after_completion" ? "after completion" : "fixed"}`;
}

/**
 * Shows the named-months section only when it applies: a fixed quarterly,
 * twice-yearly or yearly duty. Hidden, it is also disabled, so its ticks
 * aren't sent. Without scripts the section simply stays visible.
 */
const SHOW_NAMED_MONTHS = `(() => {
  const months = document.getElementById("named-months");
  const form = months.form;
  const update = () => {
    const usesMonths =
      ["quarterly", "semiannual", "yearly"].includes(form.cadence.value) && form.anchor_mode.value === "fixed";
    months.hidden = !usesMonths;
    months.disabled = !usesMonths;
  };
  form.cadence.addEventListener("change", update);
  for (const radio of form.anchor_mode) radio.addEventListener("change", update);
  update();
})();`;

/** What the edit page shows about a saved duty, beside the form. */
export interface SavedDuty {
  id: number;
  paused: boolean;
  lastDone: string | null;
  nextDue: string | null;
}

/** The add form, or with `saved` the edit form plus pause/resume and delete. */
export function DutyFormPage({
  csrf,
  values,
  error,
  saved,
}: {
  csrf: string;
  values: DutyFormValues;
  error?: string;
  saved?: SavedDuty;
}) {
  const heading = saved ? "Edit duty" : "Add a duty";
  return (
    <Layout title={`${heading} · homekeeper`}>
      <h2>{heading}</h2>
      {error && (
        <p role="alert">
          <strong>{error}</strong>
        </p>
      )}
      {saved && (
        <p>
          Last done: {saved.lastDone ?? "never"}. {saved.paused ? "Paused." : `Next due: ${saved.nextDue ?? "not scheduled"}.`}
        </p>
      )}
      <form
        method="post"
        action={saved ? `/duties/${saved.id}` : "/duties"}
        onsubmit="this.querySelector('button[type=submit]').disabled = true"
      >
        <input type="hidden" name="_csrf" value={csrf} />
        {!saved && <input type="hidden" name="form_token" value={values.formToken} />}

        <p>
          <label>
            Title <input name="title" value={values.title} required maxlength={200} />
          </label>
        </p>

        <p>
          <label>
            Description (optional)
            <br />
            <textarea name="notes" rows={3} cols={60} maxlength={2000}>
              {values.notes}
            </textarea>
          </label>
        </p>

        <p>
          <label>
            Links (optional, one per line)
            <br />
            <textarea name="links" rows={3} cols={60}>
              {values.links}
            </textarea>
          </label>
          <br />
          <small>The description and links are copied into the Google task.</small>
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

        <fieldset id="named-months">
          <legend>Named months (fixed quarterly: 4, twice yearly: 2, yearly: 1)</legend>
          {MONTH_NAMES.map((label, i) => (
            <label>
              <input type="checkbox" name="months" value={String(i + 1)} checked={values.months.includes(i + 1)} />{" "}
              {label}{" "}
            </label>
          ))}
        </fieldset>
        <script dangerouslySetInnerHTML={{ __html: SHOW_NAMED_MONTHS }} />

        {!saved && (
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
        )}
        {saved && (
          <p>
            <small>A schedule change applies from the next occurrence; the open task keeps its date.</small>
          </p>
        )}

        <p>
          <button type="submit">{saved ? "Save changes" : "Add duty"}</button> <a href="/">Cancel</a>
        </p>
      </form>

      {saved && saved.paused && (
        <form method="post" action={`/duties/${saved.id}/resume`}>
          <h3>Resume</h3>
          <input type="hidden" name="_csrf" value={csrf} />
          <label>
            Next due (optional) <input type="date" name="next_due" />
          </label>{" "}
          <button type="submit">Resume</button>
          <br />
          <small>Leave blank to count from the last completion, or use the default landing day if it was never done.</small>
        </form>
      )}
      {saved && !saved.paused && (
        <form method="post" action={`/duties/${saved.id}/pause`}>
          <input type="hidden" name="_csrf" value={csrf} />
          <button type="submit">Pause</button> <small>Removes the open Google task until you resume.</small>
        </form>
      )}
      {saved && (
        <form
          method="post"
          action={`/duties/${saved.id}/delete`}
          onsubmit="return confirm('Delete this duty? Its Google task is removed and it leaves the list.')"
        >
          <p>
            <input type="hidden" name="_csrf" value={csrf} />
            <button type="submit">Delete</button>
          </p>
        </form>
      )}
    </Layout>
  );
}

export function MessagePage({ title, message, back }: { title: string; message: string; back?: [string, string] }) {
  const [href, label] = back ?? ["/signin", "Back to sign-in"];
  return (
    <Layout title={`${title} · homekeeper`}>
      <p>{message}</p>
      <p>
        <a href={href}>{label}</a>
      </p>
    </Layout>
  );
}
