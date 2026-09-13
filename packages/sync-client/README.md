# @balance/sync-client

Device-side sync engine for Balance replicas: outbox, single-flight execution,
last-write-wins application with cascade mirroring, and enrollment. It is
parameterized over the local Drizzle SQLite schema and built as part of this
workspace.

The desktop app only exercises this when a profile is enrolled in cloud mode,
which is not open to the public yet. See `cloudEnabled()` in
`desktop/src/main.ts` for how that is gated.

Run `npm test --workspace=@balance/sync-client` from the repository root. The
tests cover the transport contract and local state behavior without requiring
another checkout or an external service.
