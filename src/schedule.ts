/**
 * The scheduling engine: pure functions over household dates.
 *
 * Every date in and out is a `YYYY-MM-DD` string in the household time zone.
 * Nothing here reads the clock, the database or the network; callers pass
 * `today` explicitly, and time-zone conversion stays in `src/time.ts`.
 */
import { addDays, addMonths, differenceInCalendarDays, format, getDaysInMonth, isSaturday, nextSaturday } from "date-fns";

export type Cadence = "weekly" | "monthly" | "quarterly" | "semiannual" | "yearly";
export type AnchorMode = "fixed" | "after_completion";
export type Precision = "day" | "month" | "year" | "unknown";

/** The fields of a duty the engine needs. */
export interface ScheduleDuty {
  cadence: Cadence;
  anchorMode: AnchorMode;
  /** Named months (1–12) for fixed quarterly, semiannual and yearly duties. */
  cadenceMonths?: readonly number[] | null;
  /** `YYYY-MM-DD`; at month precision `YYYY-MM` is enough, at year precision `YYYY`. */
  lastDoneDate?: string | null;
  /** Defaults to `unknown`. */
  lastDonePrecision?: Precision;
}

const INTERVAL_MONTHS: Record<Exclude<Cadence, "weekly">, number> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  yearly: 12,
};

const NAMED_MONTH_COUNT: Record<"quarterly" | "semiannual" | "yearly", number> = {
  quarterly: 4,
  semiannual: 2,
  yearly: 1,
};

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

// ---------------------------------------------------------------------------
// Date helpers. Dates are held at local noon so no daylight-saving edge can
// move them to another day; only the calendar date is ever read back.

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDate(value: string): Date {
  const m = DATE_RE.exec(value);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const date = new Date(y, mo - 1, d, 12);
    date.setFullYear(y); // years below 100 would otherwise map to 19xx
    if (date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d) return date;
  }
  throw new Error(`Invalid date "${value}": expected a real YYYY-MM-DD date`);
}

function toDateString(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

/** Months counted from year 0, so month arithmetic is plain integer arithmetic. */
type MonthIndex = number;

function monthIndexOf(date: Date): MonthIndex {
  return date.getFullYear() * 12 + date.getMonth();
}

/** Day `day` of the month, clamped to the month's last day. */
function dateInMonth(month: MonthIndex, day: number): Date {
  const first = new Date(Math.floor(month / 12), month % 12, 1, 12);
  first.setFullYear(Math.floor(month / 12));
  return new Date(first.getFullYear(), first.getMonth(), Math.min(day, getDaysInMonth(first)), 12);
}

function firstSaturdayOnOrAfter(date: Date): Date {
  return isSaturday(date) ? date : nextSaturday(date);
}

// ---------------------------------------------------------------------------
// Cadence helpers

function namedMonths(cadence: Exclude<Cadence, "weekly">, months: ScheduleDuty["cadenceMonths"]): readonly number[] {
  if (cadence === "monthly") return ALL_MONTHS;
  const expected = NAMED_MONTH_COUNT[cadence];
  const valid =
    Array.isArray(months) &&
    months.length === expected &&
    new Set(months).size === expected &&
    months.every((m) => Number.isInteger(m) && m >= 1 && m <= 12);
  if (!valid) {
    throw new Error(`A fixed ${cadence} duty needs ${expected} distinct named months (1-12)`);
  }
  return months;
}

/** The first named month strictly after `after`. */
function firstNamedMonthAfter(after: MonthIndex, months: readonly number[]): MonthIndex {
  // Months ahead (1-12) to each named month; a month equal to `after`'s is 12 ahead.
  const ahead = months.map((m) => ((m - 1 - (after % 12) + 11) % 12) + 1);
  return after + Math.min(...ahead);
}

/** `date` plus one cadence interval (7 days, or 1, 3, 6 or 12 months, clamped to month end). */
function addInterval(cadence: Cadence, date: Date): Date {
  return cadence === "weekly" ? addDays(date, 7) : addMonths(date, INTERVAL_MONTHS[cadence]);
}

// ---------------------------------------------------------------------------
// Public API

/**
 * Default landing day when no exact day is known.
 * Weekly: the first Saturday on or after `reference`.
 * Other cadences: the first Saturday of `reference`'s month.
 */
export function defaultLandingDay(cadence: Cadence, reference: string): string {
  const ref = parseDate(reference);
  const from = cadence === "weekly" ? ref : dateInMonth(monthIndexOf(ref), 1);
  return toDateString(firstSaturdayOnOrAfter(from));
}

/** Roll-forward: today if `dueDate` has passed, else `dueDate`. */
export function rolledDueDate(dueDate: string, today: string): string {
  parseDate(dueDate);
  parseDate(today);
  return dueDate < today ? today : dueDate;
}

/**
 * Due date of the next occurrence after a completion.
 *
 * - `after_completion`: completion date plus the cadence interval.
 * - `fixed` (monthly and longer): the first named month after whichever is
 *   later, the completed slot's month or the completion's month, on the
 *   completion's day of the month (clamped to month end).
 * - `fixed` weekly: the slot's weekday, in the first week after whichever is
 *   later, the slot or the completion.
 */
export function nextDueDate(duty: ScheduleDuty, completedDate: string, completedSlotDate: string): string {
  const done = parseDate(completedDate);
  const slot = parseDate(completedSlotDate);

  if (duty.anchorMode === "after_completion") return toDateString(addInterval(duty.cadence, done));

  if (duty.cadence === "weekly") {
    const daysLate = Math.max(0, differenceInCalendarDays(done, slot));
    return toDateString(addDays(slot, 7 * (Math.floor(daysLate / 7) + 1)));
  }

  const later = Math.max(monthIndexOf(slot), monthIndexOf(done));
  const target = firstNamedMonthAfter(later, namedMonths(duty.cadence, duty.cadenceMonths));
  return toDateString(dateInMonth(target, done.getDate()));
}

/**
 * Due date of the next occurrence after a skip (task deleted in Google),
 * counted from the skipped slot by the cadence. The result may already be
 * past; the caller rolls it forward with `rolledDueDate`.
 */
export function nextDueAfterSkip(duty: ScheduleDuty, skippedSlotDate: string): string {
  const slot = parseDate(skippedSlotDate);
  if (duty.anchorMode === "after_completion" || duty.cadence === "weekly") {
    return toDateString(addInterval(duty.cadence, slot));
  }
  const target = firstNamedMonthAfter(monthIndexOf(slot), namedMonths(duty.cadence, duty.cadenceMonths));
  return toDateString(dateInMonth(target, slot.getDate()));
}

/**
 * Due date of the first occurrence, when a duty is created or resumed.
 *
 * - Unknown last-done date: weekly → the next Saturday on or after today;
 *   fixed → the first Saturday of the next named month on or after today;
 *   after completion → today, since there is nothing to count from.
 * - Day precision: as if completed on that day (`nextDueDate`).
 * - Month precision: counted from that month; year precision: from January
 *   of that year. Either lands on the default landing day.
 * - A result already in the past becomes today.
 */
export function firstDueDate(duty: ScheduleDuty, today: string): string {
  parseDate(today);
  const precision = duty.lastDonePrecision ?? "unknown";
  if (precision === "unknown") return firstDueWithoutHistory(duty, today);

  const lastDone = duty.lastDoneDate;
  if (!lastDone) throw new Error(`The last-done date is missing for ${precision} precision`);

  let due: string;
  if (precision === "day") {
    due = nextDueDate(duty, lastDone, lastDone);
  } else {
    const month = startOfKnownPeriod(lastDone, precision);
    if (duty.cadence === "weekly") {
      due = defaultLandingDay("weekly", toDateString(addDays(dateInMonth(month, 1), 7)));
    } else {
      const target =
        duty.anchorMode === "fixed"
          ? firstNamedMonthAfter(month, namedMonths(duty.cadence, duty.cadenceMonths))
          : month + INTERVAL_MONTHS[duty.cadence];
      due = defaultLandingDay(duty.cadence, toDateString(dateInMonth(target, 1)));
    }
  }
  return rolledDueDate(due, today);
}

/**
 * Slot and due date of a new duty's first occurrence, from the form's
 * optional first-due date. Given, it is the slot, and the due date unless it
 * has passed (then today). Blank, the no-history rules of `firstDueDate` apply.
 */
export function firstOccurrence(
  duty: ScheduleDuty,
  today: string,
  requestedFirstDue?: string | null,
): { slotDate: string; dueDate: string } {
  if (!requestedFirstDue) {
    const due = firstDueDate({ ...duty, lastDoneDate: null, lastDonePrecision: "unknown" }, today);
    return { slotDate: due, dueDate: due };
  }
  parseDate(requestedFirstDue);
  return { slotDate: requestedFirstDue, dueDate: rolledDueDate(requestedFirstDue, today) };
}

/**
 * Why a duty's named months can't be scheduled, or null if they can. Forms
 * check this before saving, since the engine throws on bad months.
 */
export function namedMonthsProblem(duty: ScheduleDuty): string | null {
  if (duty.anchorMode !== "fixed" || duty.cadence === "weekly" || duty.cadence === "monthly") return null;
  try {
    namedMonths(duty.cadence, duty.cadenceMonths);
    return null;
  } catch {
    const expected = NAMED_MONTH_COUNT[duty.cadence];
    return expected === 1
      ? "A fixed yearly duty needs exactly 1 month."
      : `A fixed ${duty.cadence === "quarterly" ? "quarterly" : "twice-yearly"} duty needs exactly ${expected} different months.`;
  }
}

/** First due date for a duty with no known last-done date. */
function firstDueWithoutHistory(duty: ScheduleDuty, today: string): string {
  if (duty.cadence === "weekly") return defaultLandingDay("weekly", today);
  if (duty.anchorMode === "after_completion") return today;
  const months = namedMonths(duty.cadence, duty.cadenceMonths);
  const thisMonth = monthIndexOf(parseDate(today));
  const thisMonthsDay = defaultLandingDay(duty.cadence, today);
  if (months.includes((thisMonth % 12) + 1) && thisMonthsDay >= today) return thisMonthsDay;
  return defaultLandingDay(duty.cadence, toDateString(dateInMonth(firstNamedMonthAfter(thisMonth, months), 1)));
}

/**
 * The month a partial last-done date counts from: that month at month
 * precision, January of that year at year precision. Accepts `YYYY-MM` or
 * `YYYY` respectively, or a full date whose finer parts are ignored.
 */
function startOfKnownPeriod(value: string, precision: "month" | "year"): MonthIndex {
  const partial = precision === "year" ? /^\d{4}$/ : /^\d{4}-\d{2}$/;
  const full = partial.test(value) ? `${value}${precision === "year" ? "-01-01" : "-01"}` : value;
  const month = monthIndexOf(parseDate(full));
  return precision === "year" ? month - (month % 12) : month;
}
