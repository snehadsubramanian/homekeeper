/**
 * The one place that converts between instants and the household's dates.
 *
 * Dates are `YYYY-MM-DD` strings in the household time zone (HOUSEHOLD_TZ);
 * timestamps are UTC ISO strings. Everything that needs "today" or a local
 * date or time goes through here.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  if (!timeZone) throw new Error("HOUSEHOLD_TZ is not set");
  let f = formatters.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
    } catch {
      throw new Error(`HOUSEHOLD_TZ "${timeZone}" is not a recognised time zone`);
    }
    formatters.set(timeZone, f);
  }
  return f;
}

function localParts(timeZone: string, instant: Date): Record<string, string> {
  return Object.fromEntries(formatter(timeZone).formatToParts(instant).map((p) => [p.type, p.value]));
}

/** The household's calendar date at this instant, as YYYY-MM-DD. */
export function householdDate(timeZone: string, instant: Date = new Date()): string {
  const p = localParts(timeZone, instant);
  return `${p.year}-${p.month}-${p.day}`;
}

/** The household's local date and time at this instant, as "YYYY-MM-DD HH:MM". */
export function householdDateTime(timeZone: string, instant: Date = new Date()): string {
  const p = localParts(timeZone, instant);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/**
 * Google Tasks stores due dates without a time: it takes the date part of
 * whatever is sent. Midnight UTC keeps that date exactly as given.
 */
export function toGoogleDue(date: string): string {
  return `${date}T00:00:00.000Z`;
}

/** The date part of a Google Tasks due value. No time-zone shift: Google's due is date-only. */
export function dateFromGoogleDue(due: string): string {
  return due.slice(0, 10);
}
