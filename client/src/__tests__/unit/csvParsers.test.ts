import { describe, it, expect } from "vitest";
import { parseFormatACsv, parseFormatBCsv } from "../../lib/csvParsers.js";

// ─── Format A ────────────────────────────────────────────────────────────────

const FORMAT_A_CC_HEADER = "Transaction Date,Post Date,Description,Category,Type,Amount,Memo";

function formatACcCsv(rows: string[]): string {
  return [FORMAT_A_CC_HEADER, ...rows].join("\n");
}

const FORMAT_A_CHECKING_HEADER = "Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #";

function formatACheckCsv(rows: string[]): string {
  return [FORMAT_A_CHECKING_HEADER, ...rows].join("\n");
}

describe("parseFormatACsv -- credit card layout", () => {
  it("parses negative Amount as debit", () => {
    const rows = parseFormatACsv(formatACcCsv(["01/15/2025,01/17/2025,TRADER JOE,Food,Sale,-45.67,"]));
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("debit");
    expect(rows[0].amount).toBe("45.67");
  });

  it("parses positive Amount as credit", () => {
    const rows = parseFormatACsv(formatACcCsv(["01/15/2025,01/17/2025,PAYMENT,,Payment,200.00,"]));
    expect(rows[0].type).toBe("credit");
    expect(rows[0].amount).toBe("200");
  });

  it("converts MM/DD/YYYY to YYYY-MM-DD", () => {
    const rows = parseFormatACsv(formatACcCsv(["03/05/2025,03/07/2025,TEST,,Sale,-10,"]));
    expect(rows[0].date).toBe("2025-03-05");
  });

  it("filters rows with non-numeric Amount", () => {
    const rows = parseFormatACsv(formatACcCsv(["01/15/2025,01/17/2025,BAD,,,-,"]));
    expect(rows).toHaveLength(0);
  });

  it("returns empty array for empty CSV", () => {
    expect(parseFormatACsv("")).toHaveLength(0);
  });

  it("returns empty array for header-only CSV", () => {
    expect(parseFormatACsv(FORMAT_A_CC_HEADER)).toHaveLength(0);
  });

  it("handles quoted fields with embedded commas", () => {
    const rows = parseFormatACsv(formatACcCsv([`01/15/2025,01/17/2025,"Smith, John",Food,Sale,-25.00,`]));
    expect(rows[0].description).toBe("Smith, John");
    expect(rows[0].amount).toBe("25");
  });
});

describe("parseFormatACsv -- checking layout", () => {
  it("parses CREDIT detail as credit type", () => {
    const rows = parseFormatACsv(formatACheckCsv(["CREDIT,01/15/2025,Payroll,1500.00,ACH_CREDIT,2000,,"]));
    expect(rows[0].type).toBe("credit");
    expect(rows[0].amount).toBe("1500");
  });

  it("parses non-CREDIT detail as debit", () => {
    const rows = parseFormatACsv(formatACheckCsv(["DBIT,01/15/2025,WHOLESALE,-50.00,ACH_DEBIT,1950,,"]));
    expect(rows[0].type).toBe("debit");
    expect(rows[0].amount).toBe("50");
  });

  it("uses Posting Date not Transaction Date", () => {
    const rows = parseFormatACsv(formatACheckCsv(["CREDIT,03/10/2025,Test,100,ACH,,"]));
    expect(rows[0].date).toBe("2025-03-10");
  });
});

// ─── Format B ────────────────────────────────────────────────────────────────

const FORMAT_B_HEADER = `"Date","Transaction","Name","Memo","Amount"`;

function formatBCsv(rows: string[]): string {
  return [FORMAT_B_HEADER, ...rows].join("\n");
}

describe("parseFormatBCsv", () => {
  it("parses CREDIT transaction as credit type", () => {
    const rows = parseFormatBCsv(formatBCsv([`"2025-04-20","CREDIT","PAYMENT MADE","","123.45"`]));
    expect(rows[0].type).toBe("credit");
    expect(rows[0].amount).toBe("123.45");
  });

  it("parses DEBIT transaction as debit type", () => {
    const rows = parseFormatBCsv(formatBCsv([`"2025-04-16","DEBIT","WAREHOUSE","","-123.45"`]));
    expect(rows[0].type).toBe("debit");
    expect(rows[0].amount).toBe("123.45");
  });

  it("filters rows with Amount=N/A", () => {
    const rows = parseFormatBCsv(formatBCsv([`"2025-04-16","DEBIT","UNKNOWN","","N/A"`]));
    expect(rows).toHaveLength(0);
  });

  it("filters rows with Amount=0.00", () => {
    const rows = parseFormatBCsv(formatBCsv([`"2025-04-16","DEBIT","ZERO","","0.00"`]));
    expect(rows).toHaveLength(0);
  });

  it("collapses multiple whitespace in description", () => {
    const rows = parseFormatBCsv(formatBCsv([`"2025-04-16","DEBIT","TRADER  JOE   S","","-50.00"`]));
    expect(rows[0].description).toBe("TRADER JOE S");
  });

  it("passes date through as-is", () => {
    const rows = parseFormatBCsv(formatBCsv([`"2025-04-16","DEBIT","TEST","","-10.00"`]));
    expect(rows[0].date).toBe("2025-04-16");
  });

  it("filters impossible dates and partially numeric amounts", () => {
    expect(parseFormatBCsv(formatBCsv([`"2025-02-31","DEBIT","BAD DATE","","10"`]))).toHaveLength(0);
    expect(parseFormatBCsv(formatBCsv([`"2025-04-16","DEBIT","BAD AMOUNT","","10oops"`]))).toHaveLength(0);
  });
});
