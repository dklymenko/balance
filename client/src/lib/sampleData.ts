import { apiFetch } from "@/lib/api";

// The two synthetic demo datasets the server can seed into an empty ledger:
// "starter" is about three months, "extended" is three years of history for
// trying year-over-year reports.
export type SampleDataset = "starter" | "extended";

export type SampleLoadResult =
  | { ok: true; transactions: number }
  | { ok: false; status: number; error: string };

export async function loadSampleData(dataset: SampleDataset): Promise<SampleLoadResult> {
  try {
    const res = await apiFetch("/api/data/sample", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dataset }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; transactions?: number };
    if (!res.ok) return { ok: false, status: res.status, error: body.error ?? "Could not load sample data." };
    return { ok: true, transactions: body.transactions ?? 0 };
  } catch {
    return { ok: false, status: 0, error: "Could not load sample data." };
  }
}
