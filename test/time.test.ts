import { describe, expect, it } from "vitest";
import { dateFromGoogleDue, householdDate, householdDateTime, toGoogleDue } from "../src/time";

// Chicago is UTC-6 in winter (CST) and UTC-5 in summer (CDT).
const TZ = "America/Chicago";

describe("householdDate", () => {
  it("uses the household's date, not the UTC date, late in the evening", () => {
    // 11:30 p.m. on Nov 14 in Chicago is already Nov 15 in UTC.
    expect(householdDate(TZ, new Date("2026-11-15T05:30:00Z"))).toBe("2026-11-14");
    expect(householdDate(TZ, new Date("2026-11-15T06:30:00Z"))).toBe("2026-11-15");
  });

  it("follows daylight saving time", () => {
    expect(householdDate(TZ, new Date("2026-07-01T04:30:00Z"))).toBe("2026-06-30");
    expect(householdDate(TZ, new Date("2026-07-01T05:30:00Z"))).toBe("2026-07-01");
  });

  it("refuses a time zone it doesn't recognise", () => {
    expect(() => householdDate("Not/AZone", new Date())).toThrow(/HOUSEHOLD_TZ/);
    expect(() => householdDate("", new Date())).toThrow(/HOUSEHOLD_TZ/);
  });
});

describe("householdDateTime", () => {
  it("formats an instant as the household's local date and time", () => {
    expect(householdDateTime(TZ, new Date("2026-11-15T05:30:00Z"))).toBe("2026-11-14 23:30");
    expect(householdDateTime(TZ, new Date("2026-11-15T06:05:00Z"))).toBe("2026-11-15 00:05");
  });
});

describe("Google due dates", () => {
  it("sends an all-day date as midnight UTC, which Google treats as date-only", () => {
    expect(toGoogleDue("2026-11-14")).toBe("2026-11-14T00:00:00.000Z");
  });

  it("reads the date back without shifting it", () => {
    expect(dateFromGoogleDue("2026-11-14T00:00:00.000Z")).toBe("2026-11-14");
  });
});
