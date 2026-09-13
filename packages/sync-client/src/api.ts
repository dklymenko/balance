// HTTP client for the /api/sync surface plus enrollment import. Token and
// fetch are injected: the desktop shell supplies safeStorage-backed session
// credentials and global fetch; tests supply an in-memory fake. Every response passes through the
// core wire validators before anything touches the local DB.
import {
  validatePullResponse,
  validatePushResponse,
  validateSnapshotResponse,
  type PullResponse,
  type PushOp,
  type PushResponse,
  type SnapshotResponse,
} from "@balance/core";
import type { BalanceArchive } from "@balance/core";

export class SyncApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export interface SyncApiOptions {
  baseUrl: string; // e.g. https://balance.example.com
  getToken: () => Promise<string | null>;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

const MAX_RESPONSE_BYTES = 10_000_000;

function isCursor(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

async function readResponseText(res: Response): Promise<string> {
  const declaredLength = res.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    throw new SyncApiError("sync response is too large", 502);
  }
  if (!res.body) {
    const text = await res.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
      throw new SyncApiError("sync response is too large", 502);
    }
    return text;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new SyncApiError("sync response is too large", 502);
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join("");
}

export class SyncApi {
  private baseUrl: string;
  private getToken: () => Promise<string | null>;
  private fetchFn: typeof fetch;
  private timeoutMs: number;

  constructor(opts: SyncApiOptions) {
    const parsed = new URL(opts.baseUrl);
    const loopbackHttp = parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
    if (
      (parsed.protocol !== "https:" && !loopbackHttp) || parsed.username || parsed.password ||
      parsed.pathname !== "/" || parsed.search || parsed.hash
    ) {
      throw new Error("Cloud endpoint must be an HTTPS origin without credentials, a path, query, or fragment (HTTP is allowed only for loopback development)");
    }
    this.baseUrl = parsed.origin;
    this.getToken = opts.getToken;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private async request(path: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
    const token = await this.getToken();
    if (!token) throw new SyncApiError("not signed in", 401);
    if (token.length > 65_536) throw new SyncApiError("invalid sign-in token", 401);
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await readResponseText(res);
    let parsed: unknown;
    try { parsed = text ? JSON.parse(text) : null; }
    catch { parsed = null; }
    if (!res.ok) {
      const detail = typeof (parsed as { error?: unknown } | null)?.error === "string"
        ? (parsed as { error: string }).error
        : "";
      throw new SyncApiError(detail || `sync request failed (${res.status})`, res.status);
    }
    if (parsed === null) throw new SyncApiError("sync response was not valid JSON", 502);
    return parsed;
  }

  async push(clientId: string, baseCursor: number, ops: PushOp[]): Promise<PushResponse> {
    if (!isCursor(baseCursor)) throw new SyncApiError("base cursor must be a non-negative integer", 400);
    const raw = await this.request("/api/sync/push", {
      method: "POST",
      body: { client_id: clientId, base_cursor: baseCursor, ops },
    });
    return validatePushResponse(raw);
  }

  async pull(cursor: number, limit = 500): Promise<PullResponse> {
    if (!isCursor(cursor)) throw new SyncApiError("pull cursor must be a non-negative integer", 400);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new SyncApiError("pull limit must be an integer between 1 and 1000", 400);
    }
    const raw = await this.request(`/api/sync/pull?cursor=${cursor}&limit=${limit}`);
    return validatePullResponse(raw);
  }

  async snapshot(txAfter?: number): Promise<SnapshotResponse> {
    if (txAfter !== undefined && !isCursor(txAfter)) {
      throw new SyncApiError("snapshot cursor must be a non-negative integer", 400);
    }
    const raw = await this.request(`/api/sync/snapshot${txAfter != null ? `?tx_after=${txAfter}` : ""}`);
    return validateSnapshotResponse(raw);
  }

  // Enrollment bootstrap: uuid-extended Archive v1 into an empty household.
  async importArchive(archive: BalanceArchive): Promise<{ cursor: number }> {
    const raw = (await this.request("/api/sync/import", { method: "POST", body: archive })) as Record<string, unknown>;
    if (typeof raw?.cursor !== "number" || !isCursor(raw.cursor)) {
      throw new SyncApiError("import response cursor must be a non-negative integer", 502);
    }
    return { cursor: raw.cursor };
  }

  async activity(before?: number, limit = 50): Promise<unknown> {
    if (before !== undefined && !isCursor(before)) {
      throw new SyncApiError("activity cursor must be a non-negative integer", 400);
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new SyncApiError("activity limit must be an integer between 1 and 1000", 400);
    }
    return this.request(`/api/sync/activity?limit=${limit}${before != null ? `&before=${before}` : ""}`);
  }
}
