import { describe, it, expect } from "vitest";
import { parsePendingAmazonText } from "../../lib/amazonPending";

describe("parsePendingAmazonText", () => {
  it("parses a bank paste with mixed date formats and merchant noise", () => {
    const text = `Date
Description
Amount
Action
Jan 5, 2026
Amazon Marketplace, Amazon.com

Amazon Marketplace
Amazon.com
$12.34
01/05/2026
Amazon Marketplace, Amazon.com

Amazon Marketplace
Amazon.com
$56.78
Jan 4, 2026
Amazon.com

Amazon.com
$90.12`;
    expect(parsePendingAmazonText(text)).toEqual([
      { date: "2026-01-05", amount: 12.34 },
      { date: "2026-01-05", amount: 56.78 },
      { date: "2026-01-04", amount: 90.12 },
    ]);
  });

  it("carries the day header date across rows until the next date line", () => {
    const text = `Mar 3, 2026
Amazon.com
$11.11
03/03/2026
Amazon.com
$22.22
03/03/2026
Amazon.com
$33.33`;
    expect(parsePendingAmazonText(text)).toEqual([
      { date: "2026-03-03", amount: 11.11 },
      { date: "2026-03-03", amount: 22.22 },
      { date: "2026-03-03", amount: 33.33 },
    ]);
  });

  it("ignores the column-header block and any amount before a date", () => {
    const text = `Date
Description
Amount
$77.77
Feb 1, 2026
Amazon.com
$5.55`;
    // $77.77 appears before any date line → dropped.
    expect(parsePendingAmazonText(text)).toEqual([
      { date: "2026-02-01", amount: 5.55 },
    ]);
  });

  it("handles full month names and thousands separators", () => {
    const text = `February 12, 2026
Amazon.com
$2,000.00`;
    expect(parsePendingAmazonText(text)).toEqual([
      { date: "2026-02-12", amount: 2000.0 },
    ]);
  });

  it("returns [] for empty or noise-only input", () => {
    expect(parsePendingAmazonText("")).toEqual([]);
    expect(parsePendingAmazonText("Amazon Marketplace, Amazon.com\nAmazon.com")).toEqual([]);
  });

  it("ignores impossible dates and amounts outside the supported ledger range", () => {
    const huge = "9".repeat(400);
    expect(parsePendingAmazonText(`Feb 31, 2026\nAmazon.com\n$12.34`)).toEqual([]);
    expect(parsePendingAmazonText(`13/01/2026\nAmazon.com\n$12.34`)).toEqual([]);
    expect(parsePendingAmazonText(`Jan 1, 2026\nAmazon.com\n$0.00\n$${huge}.00`)).toEqual([]);
  });
});
