import { describe, expect, it } from "vitest";
import {
  type ScheduleDuty,
  defaultLandingDay,
  firstDueDate,
  nextDueAfterSkip,
  nextDueDate,
  rolledDueDate,
} from "../src/schedule";

// Made-up duties. Weekday reference: 2026-11-21 is a Saturday.
const acFilterFixed: ScheduleDuty = { cadence: "semiannual", anchorMode: "fixed", cadenceMonths: [4, 10] };
const acFilterAfter: ScheduleDuty = { cadence: "semiannual", anchorMode: "after_completion" };
const gutterQuarterlyFixed: ScheduleDuty = { cadence: "quarterly", anchorMode: "fixed", cadenceMonths: [2, 5, 8, 11] };
const gutterQuarterlyAfter: ScheduleDuty = { cadence: "quarterly", anchorMode: "after_completion" };
const binsWeeklyAfter: ScheduleDuty = { cadence: "weekly", anchorMode: "after_completion" };
const binsWeeklyFixed: ScheduleDuty = { cadence: "weekly", anchorMode: "fixed" };
const plantsMonthlyAfter: ScheduleDuty = { cadence: "monthly", anchorMode: "after_completion" };
const plantsMonthlyFixed: ScheduleDuty = { cadence: "monthly", anchorMode: "fixed" };
const chimneyYearlyAfter: ScheduleDuty = { cadence: "yearly", anchorMode: "after_completion" };
const chimneyYearlyFixed: ScheduleDuty = { cadence: "yearly", anchorMode: "fixed", cadenceMonths: [3] };

describe("defaultLandingDay", () => {
  it("weekly: the first Saturday on or after the reference date", () => {
    expect(defaultLandingDay("weekly", "2026-11-18")).toBe("2026-11-21"); // Wed → Sat
    expect(defaultLandingDay("weekly", "2026-11-21")).toBe("2026-11-21"); // Sat stays
    expect(defaultLandingDay("weekly", "2026-11-22")).toBe("2026-11-28"); // Sun → next Sat
  });

  it("weekly duty with no recorded day lands on the next Saturday", () => {
    expect(defaultLandingDay("weekly", "2026-11-23")).toBe("2026-11-28");
  });

  it("other cadences: the first Saturday of the reference month", () => {
    expect(defaultLandingDay("monthly", "2026-11-21")).toBe("2026-11-07");
    expect(defaultLandingDay("quarterly", "2027-05-20")).toBe("2027-05-01"); // month starts on a Saturday
    expect(defaultLandingDay("semiannual", "2027-04-30")).toBe("2027-04-03");
    expect(defaultLandingDay("yearly", "2026-12-31")).toBe("2026-12-05");
  });

  it("refuses a malformed or impossible date", () => {
    expect(() => defaultLandingDay("weekly", "2026-02-30")).toThrow(/date/);
    expect(() => defaultLandingDay("weekly", "2026-1-5")).toThrow(/date/);
  });
});

describe("rolledDueDate", () => {
  it("moves a past due date to today", () => {
    expect(rolledDueDate("2026-11-20", "2026-11-21")).toBe("2026-11-21");
  });

  it("keeps a due date of today or later", () => {
    expect(rolledDueDate("2026-11-21", "2026-11-21")).toBe("2026-11-21");
    expect(rolledDueDate("2026-12-01", "2026-11-21")).toBe("2026-12-01");
  });

  it("a weekly task overdue by 8 days is dated today (one task, not a second)", () => {
    expect(rolledDueDate("2026-11-13", "2026-11-21")).toBe("2026-11-21");
  });

  it("works across a year boundary", () => {
    expect(rolledDueDate("2026-12-30", "2027-01-02")).toBe("2027-01-02");
  });
});

describe("nextDueDate, after completion", () => {
  it("weekly: completion plus 7 days", () => {
    expect(nextDueDate(binsWeeklyAfter, "2026-11-18", "2026-11-14")).toBe("2026-11-25");
  });

  it("monthly done January 31 → February 28, or 29 in a leap year", () => {
    expect(nextDueDate(plantsMonthlyAfter, "2026-01-31", "2026-01-03")).toBe("2026-02-28");
    expect(nextDueDate(plantsMonthlyAfter, "2028-01-31", "2028-01-01")).toBe("2028-02-29");
    expect(nextDueDate(plantsMonthlyAfter, "2026-03-31", "2026-03-07")).toBe("2026-04-30");
  });

  it("quarterly done August 9 → November 9", () => {
    expect(nextDueDate(gutterQuarterlyAfter, "2026-08-09", "2026-08-01")).toBe("2026-11-09");
    expect(nextDueDate(gutterQuarterlyAfter, "2026-11-30", "2026-11-07")).toBe("2027-02-28");
  });

  it("AC filter, six-month cadence, done December 3 → June 3", () => {
    expect(nextDueDate(acFilterAfter, "2026-12-03", "2026-10-03")).toBe("2027-06-03");
  });

  it("yearly done February 29 → February 28 the next year", () => {
    expect(nextDueDate(chimneyYearlyAfter, "2028-02-29", "2028-02-05")).toBe("2029-02-28");
  });

  it("ignores the slot date", () => {
    expect(nextDueDate(plantsMonthlyAfter, "2026-11-10", "2026-08-01")).toBe("2026-12-10");
  });
});

describe("nextDueDate, fixed schedule", () => {
  it("AC filter, April/October, October slot done December 3 → April 3", () => {
    expect(nextDueDate(acFilterFixed, "2026-12-03", "2026-10-03")).toBe("2027-04-03");
  });

  it("AC filter, October slot done on time → April, on the completion day", () => {
    expect(nextDueDate(acFilterFixed, "2026-10-05", "2026-10-03")).toBe("2027-04-05");
  });

  it("AC filter, October slot done the following May → October (April has passed)", () => {
    expect(nextDueDate(acFilterFixed, "2027-05-03", "2026-10-03")).toBe("2027-10-03");
  });

  it("AC filter, October slot done early on September 28 → April (no second October)", () => {
    expect(nextDueDate(acFilterFixed, "2026-09-28", "2026-10-03")).toBe("2027-04-28");
  });

  it("accepts named months in any order", () => {
    const unsorted: ScheduleDuty = { ...acFilterFixed, cadenceMonths: [10, 4] };
    expect(nextDueDate(unsorted, "2026-12-03", "2026-10-03")).toBe("2027-04-03");
  });

  it("quarterly done August 9 → November 9", () => {
    expect(nextDueDate(gutterQuarterlyFixed, "2026-08-09", "2026-08-01")).toBe("2026-11-09");
  });

  it("quarterly August slot done in November → February (the November slot is covered)", () => {
    expect(nextDueDate(gutterQuarterlyFixed, "2026-11-15", "2026-08-01")).toBe("2027-02-15");
  });

  it("clamps the completion day to the target month's last day, including Feb 29", () => {
    expect(nextDueDate(gutterQuarterlyFixed, "2026-11-30", "2026-11-07")).toBe("2027-02-28");
    expect(nextDueDate(gutterQuarterlyFixed, "2027-11-30", "2027-11-06")).toBe("2028-02-29");
  });

  it("monthly: every month is named", () => {
    expect(nextDueDate(plantsMonthlyFixed, "2026-11-20", "2026-11-07")).toBe("2026-12-20");
    expect(nextDueDate(plantsMonthlyFixed, "2026-01-31", "2026-01-03")).toBe("2026-02-28");
    // November slot done in January → February, since January is covered
    expect(nextDueDate(plantsMonthlyFixed, "2027-01-05", "2026-11-07")).toBe("2027-02-05");
  });

  it("yearly: the same month next year, or the year after if done late", () => {
    expect(nextDueDate(chimneyYearlyFixed, "2026-03-10", "2026-03-07")).toBe("2027-03-10");
    expect(nextDueDate(chimneyYearlyFixed, "2027-04-01", "2026-03-07")).toBe("2028-03-01");
  });

  it("weekly: keeps the slot's weekday, first slot after the later of slot and completion", () => {
    expect(nextDueDate(binsWeeklyFixed, "2026-11-21", "2026-11-21")).toBe("2026-11-28"); // on time
    expect(nextDueDate(binsWeeklyFixed, "2026-11-18", "2026-11-21")).toBe("2026-11-28"); // early
    expect(nextDueDate(binsWeeklyFixed, "2026-11-23", "2026-11-21")).toBe("2026-11-28"); // 2 days late
    expect(nextDueDate(binsWeeklyFixed, "2026-11-30", "2026-11-21")).toBe("2026-12-05"); // 9 days late
  });

  it("refuses missing or invalid named months", () => {
    const none: ScheduleDuty = { cadence: "quarterly", anchorMode: "fixed" };
    const wrongCount: ScheduleDuty = { cadence: "semiannual", anchorMode: "fixed", cadenceMonths: [4] };
    const badMonth: ScheduleDuty = { cadence: "yearly", anchorMode: "fixed", cadenceMonths: [13] };
    const repeated: ScheduleDuty = { cadence: "semiannual", anchorMode: "fixed", cadenceMonths: [4, 4] };
    for (const duty of [none, wrongCount, badMonth, repeated]) {
      expect(() => nextDueDate(duty, "2026-11-21", "2026-11-21")).toThrow(/months/);
    }
  });

  it("refuses an invalid completion date", () => {
    expect(() => nextDueDate(acFilterFixed, "2026-13-01", "2026-10-03")).toThrow(/date/);
  });
});

describe("nextDueAfterSkip", () => {
  it("weekly due October 10, rolled to October 12 and deleted → October 17", () => {
    expect(nextDueAfterSkip(binsWeeklyAfter, "2026-10-10")).toBe("2026-10-17");
    expect(nextDueAfterSkip(binsWeeklyFixed, "2026-10-10")).toBe("2026-10-17");
  });

  it("after completion: slot plus the cadence interval, clamped", () => {
    expect(nextDueAfterSkip(plantsMonthlyAfter, "2026-01-31")).toBe("2026-02-28");
    expect(nextDueAfterSkip(acFilterAfter, "2026-10-03")).toBe("2027-04-03");
    expect(nextDueAfterSkip(chimneyYearlyAfter, "2028-02-29")).toBe("2029-02-28");
  });

  it("fixed: the next named month after the slot, on the slot's day", () => {
    expect(nextDueAfterSkip(acFilterFixed, "2026-10-03")).toBe("2027-04-03");
    expect(nextDueAfterSkip(gutterQuarterlyFixed, "2026-11-07")).toBe("2027-02-07");
    expect(nextDueAfterSkip(gutterQuarterlyFixed, "2027-11-30")).toBe("2028-02-29");
  });
});

describe("firstDueDate", () => {
  const today = "2026-11-21";

  describe("unknown last-done date", () => {
    const unknown = (duty: ScheduleDuty): ScheduleDuty => ({
      ...duty,
      lastDoneDate: null,
      lastDonePrecision: "unknown",
    });

    it("weekly, either anchor mode: the next Saturday on or after today", () => {
      for (const duty of [binsWeeklyAfter, binsWeeklyFixed]) {
        expect(firstDueDate(unknown(duty), "2026-11-18"), duty.anchorMode).toBe("2026-11-21"); // Wed
        expect(firstDueDate(unknown(duty), "2026-11-21"), duty.anchorMode).toBe("2026-11-21"); // Sat
        expect(firstDueDate(unknown(duty), "2026-11-22"), duty.anchorMode).toBe("2026-11-28"); // Sun
      }
    });

    it("fixed April/October, today between the slots: first Saturday of April", () => {
      expect(firstDueDate(unknown(acFilterFixed), "2026-11-21")).toBe("2027-04-03");
    });

    it("fixed April/October, today in October: this October if its first Saturday is ahead", () => {
      expect(firstDueDate(unknown(acFilterFixed), "2026-10-01")).toBe("2026-10-03");
      expect(firstDueDate(unknown(acFilterFixed), "2026-10-03")).toBe("2026-10-03");
      expect(firstDueDate(unknown(acFilterFixed), "2026-10-05")).toBe("2027-04-03");
    });

    it("fixed monthly: this month's first Saturday if still ahead, else next month's", () => {
      expect(firstDueDate(unknown(plantsMonthlyFixed), "2026-11-02")).toBe("2026-11-07");
      expect(firstDueDate(unknown(plantsMonthlyFixed), "2026-11-07")).toBe("2026-11-07");
      expect(firstDueDate(unknown(plantsMonthlyFixed), "2026-11-21")).toBe("2026-12-05");
    });

    it("fixed quarterly and yearly: the first Saturday of the next named month", () => {
      expect(firstDueDate(unknown(gutterQuarterlyFixed), "2026-11-21")).toBe("2027-02-06");
      expect(firstDueDate(unknown(chimneyYearlyFixed), "2026-11-21")).toBe("2027-03-06");
    });

    it("after completion, month-based cadences: due today (nothing to count from)", () => {
      for (const duty of [gutterQuarterlyAfter, plantsMonthlyAfter, acFilterAfter, chimneyYearlyAfter]) {
        expect(firstDueDate(unknown(duty), today), duty.cadence).toBe(today);
      }
    });

    it("refuses a fixed duty with invalid named months", () => {
      const none: ScheduleDuty = { cadence: "quarterly", anchorMode: "fixed" };
      expect(() => firstDueDate(unknown(none), today)).toThrow(/months/);
    });

    it("no precision given counts as unknown", () => {
      expect(firstDueDate(binsWeeklyAfter, "2026-11-18")).toBe("2026-11-21");
      expect(firstDueDate(plantsMonthlyAfter, today)).toBe(today);
    });
  });

  it("day precision, after completion: last done plus the interval", () => {
    expect(firstDueDate({ ...binsWeeklyAfter, lastDoneDate: "2026-11-18", lastDonePrecision: "day" }, today)).toBe(
      "2026-11-25",
    );
    expect(
      firstDueDate({ ...gutterQuarterlyAfter, lastDoneDate: "2026-09-09", lastDonePrecision: "day" }, today),
    ).toBe("2026-12-09");
  });

  it("day precision, fixed: next named month, on the last-done day", () => {
    expect(firstDueDate({ ...acFilterFixed, lastDoneDate: "2026-10-03", lastDonePrecision: "day" }, today)).toBe(
      "2027-04-03",
    );
    expect(firstDueDate({ ...binsWeeklyFixed, lastDoneDate: "2026-11-20", lastDonePrecision: "day" }, today)).toBe(
      "2026-11-27",
    );
  });

  it("a first due date already past becomes today", () => {
    expect(firstDueDate({ ...plantsMonthlyAfter, lastDoneDate: "2026-10-01", lastDonePrecision: "day" }, today)).toBe(
      today,
    );
  });

  it("yearly last done July 2022 (month precision) is already overdue, so due today", () => {
    expect(firstDueDate({ ...chimneyYearlyAfter, lastDoneDate: "2022-07", lastDonePrecision: "month" }, today)).toBe(
      today,
    );
  });

  it("month precision lands on the default day of the due month", () => {
    expect(firstDueDate({ ...plantsMonthlyAfter, lastDoneDate: "2026-11", lastDonePrecision: "month" }, today)).toBe(
      "2026-12-05",
    );
    // the day part, if given, is ignored at month precision
    expect(
      firstDueDate({ ...plantsMonthlyAfter, lastDoneDate: "2026-11-15", lastDonePrecision: "month" }, today),
    ).toBe("2026-12-05");
    expect(
      firstDueDate({ ...gutterQuarterlyFixed, lastDoneDate: "2026-11", lastDonePrecision: "month" }, today),
    ).toBe("2027-02-06");
  });

  it("weekly at month precision: a week after the month's start, on a Saturday", () => {
    expect(
      firstDueDate({ ...binsWeeklyAfter, lastDoneDate: "2026-11", lastDonePrecision: "month" }, "2026-11-03"),
    ).toBe("2026-11-14");
  });

  it("yearly last done 2025 (year precision): counted from January 2025, so due January 2026, past, so today", () => {
    expect(firstDueDate({ ...chimneyYearlyAfter, lastDoneDate: "2025", lastDonePrecision: "year" }, today)).toBe(
      today,
    );
  });

  it("year precision counts from January of that year", () => {
    expect(firstDueDate({ ...chimneyYearlyAfter, lastDoneDate: "2026", lastDonePrecision: "year" }, today)).toBe(
      "2027-01-02",
    );
    // a full date at year precision still counts from January
    expect(
      firstDueDate({ ...chimneyYearlyAfter, lastDoneDate: "2026-07-15", lastDonePrecision: "year" }, today),
    ).toBe("2027-01-02");
    // fixed: the first named month after January
    expect(
      firstDueDate({ ...acFilterFixed, lastDoneDate: "2026", lastDonePrecision: "year" }, "2026-02-01"),
    ).toBe("2026-04-04");
  });

  it("refuses a known precision with no date, or a date that doesn't match", () => {
    expect(() => firstDueDate({ ...plantsMonthlyAfter, lastDoneDate: null, lastDonePrecision: "day" }, today)).toThrow(
      /last-done/,
    );
    expect(() =>
      firstDueDate({ ...plantsMonthlyAfter, lastDoneDate: "2026-11", lastDonePrecision: "day" }, today),
    ).toThrow(/date/);
    expect(() =>
      firstDueDate({ ...plantsMonthlyAfter, lastDoneDate: "20xx", lastDonePrecision: "year" }, today),
    ).toThrow(/date/);
    expect(() =>
      firstDueDate({ ...plantsMonthlyAfter, lastDoneDate: "2026", lastDonePrecision: "month" }, today),
    ).toThrow(/date/);
    expect(() =>
      firstDueDate({ ...plantsMonthlyAfter, lastDoneDate: "2026-13", lastDonePrecision: "month" }, today),
    ).toThrow(/date/);
  });

  it("refuses an invalid today", () => {
    expect(() => firstDueDate(binsWeeklyAfter, "2026-11-31")).toThrow(/date/);
  });
});
