// `--sample-data[=starter|extended]` on the command line, for people who
// install from source and want to explore Balance before entering real data:
//
//   npm run start -- --sample-data            three years of history
//   npm run start -- --sample-data=starter    about three months
//
// The shell asks the embedded server to seed once it is up, through the same
// POST /api/data/sample the onboarding checklist and Settings use. The server
// refuses a ledger that already has accounts, so the flag can never mix demo
// rows into real books and is harmless if left on a later launch.

export type SampleDatasetName = "starter" | "extended";

export type SampleDataFlag =
  | { dataset: SampleDatasetName }
  | { error: string };

const FLAG = "--sample-data";
// The bare flag means the 3-year dataset: someone asking for sample data on
// the command line wants the full picture; the UI keeps starter as default.
const DEFAULT_DATASET: SampleDatasetName = "extended";

export function parseSampleDataFlag(argv: readonly string[]): SampleDataFlag | null {
  for (const arg of argv) {
    if (arg === FLAG) return { dataset: DEFAULT_DATASET };
    if (arg.startsWith(`${FLAG}=`)) {
      const value = arg.slice(FLAG.length + 1);
      if (value === "starter" || value === "extended") return { dataset: value };
      return { error: `Unknown sample dataset "${value}". Use --sample-data, --sample-data=extended, or --sample-data=starter.` };
    }
  }
  return null;
}

export type SampleDataOutcome =
  | { status: "seeded"; dataset: SampleDatasetName; accounts: number; transactions: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) =>
  Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>;

export async function requestSampleData(
  origin: string,
  localAuthToken: string,
  dataset: SampleDatasetName,
  fetchImpl: FetchLike = fetch,
): Promise<SampleDataOutcome> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(new URL("/api/data/sample", origin).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${localAuthToken}` },
      body: JSON.stringify({ dataset }),
    });
  } catch (err) {
    return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
  const body = (await res.json().catch(() => ({}))) as { error?: unknown; accounts?: unknown; transactions?: unknown };
  if (res.ok) {
    return {
      status: "seeded",
      dataset,
      accounts: typeof body.accounts === "number" ? body.accounts : 0,
      transactions: typeof body.transactions === "number" ? body.transactions : 0,
    };
  }
  const reason = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
  // 400 from a valid dataset name means the ledger already has data.
  return res.status === 400 ? { status: "skipped", reason } : { status: "failed", reason };
}
