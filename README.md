# Balance

**Know exactly where your money is spent.**

Balance is a local-first budgeting app for macOS, built around privacy and data
safety. In its default local-only mode, your ledger stays on your Mac and is
backed up automatically, and you can [encrypt it at rest](#encrypt-your-ledger)
whenever you choose to. No account or hosted service is required, and Balance
contains no telemetry.

Most people's finances are scattered across a checking account, two or three
credit cards, a brokerage account, a 401(k), an HSA, and a pile of vesting RSUs.
No single screen adds all of that up. Bank statements tell you a charge happened
but not what it was for, and the categories they assign are usually wrong.
Answering "how much did we actually spend on food last month" turns into an
afternoon with a spreadsheet.

Balance keeps one accurate ledger of everything you own and owe, learns how you
categorize your spending, and turns it into reports that answer real questions.

## What you get

### Visibility across all accounts at once

Cash, checking, savings, credit cards, brokerage, 401(k) and Roth, HSA,
property, and other non-liquid assets all live in the same ledger. Balance keeps
a running net-worth total and breaks it down by how quickly you could actually
reach the money: liquid, invested, or locked.

Accounts can be held in different currencies, each with its own exchange rate
to USD. Balance converts them to USD for net-worth and reporting totals. The
currency setting controls the default for new accounts; existing accounts keep
their own currency.

### Where the money actually goes

Two-level categories let you budget at the level you think in: Food broken into
Groceries and Restaurants; Rent, Car, Travel, and whatever else matters to
you. Tags cut across those categories for things like a specific trip, a home
project, or expenses you expect to be reimbursed.

Balance learns from your own ledger. When a familiar merchant shows up, it
suggests the category you used for that merchant last time. That learning is
built from your ledger alone; Balance does not send it to an analytics or
machine-learning service.

Transfers between your own accounts are recorded as linked pairs, so moving
money never shows up as income or spending and your balances always reconcile.

### Amazon charges that make sense

A line reading `AMAZON.COM*2K4LN` for $128.43 is unusable for budgeting. Balance
opens Amazon in a window on your own Mac, reads your order history, and matches
those charges to the actual orders, including the items in them. You can see
that the charge was the kids' shoes, and categorize it properly.

The matching handles the awkward parts: split shipments, deferred billing, and
orders that bill days after you place them. You sign in directly on Amazon's
site in a dedicated desktop window. Balance never reads your password or sends
your Amazon session data to a Balance service or another third party. That
dedicated sign-in session lasts only until you quit Balance, so Amazon cookies
are not kept on disk between app runs.

### Reports that answer real questions

- **Spend by category**, as a collapsible tree sorted by size, with each
  category's share of the total
- **Spend over time**, month by month, filtered to whichever accounts and
  categories you care about
- **Income versus spend**, with savings, and month-over-month or year-over-year
  comparisons
- **Spend by day**, for finding the weeks that actually did the damage
- **Recurring charges**, detected automatically, so subscriptions you forgot
  about become visible

Every report honors account- and transaction-level exclusions. Report filters
can narrow the accounts in view, and Spend Over Time can also focus on selected
categories, which helps keep reimbursements and one-off items from distorting
the shape of your spending.

### RSUs tracked as the asset

Record vested equity by ticker and share count, set the current price, and
Balance includes its market value in your net worth. This release tracks current
holdings; it does not model grant schedules, future vesting, tax lots, or
withholding.

### Bring your history with you

- **Bank and credit card CSV exports.** Two common statement layouts are
  recognized directly.
- **An existing ledger from another budgeting tool.** Import its CSV export and
  map its accounts and categories onto yours.
- **A Balance ledger archive.** Versioned JSON export and import, so your ledger stays
  portable and you are never locked in.

Statement CSV imports are safe to retry. Re-running the same file skips rows
that match the same account, date, type, amount, and description. Review the
preview before importing: changed dates or descriptions are treated as distinct
transactions.

## Privacy and data safety

Balance is built for data you would not want anyone else holding:

- Encryption at rest is optional and off until you turn it on. See
  [Encrypt your ledger](#encrypt-your-ledger) below.
- Local use requires no account and no hosted service.
- Balance contains no analytics or crash-reporting code and sends no telemetry.
- In local-only mode, network access occurs only when you explicitly check for
  updates or import Amazon orders. Optional private Cloud sync contacts only a
  service endpoint explicitly configured by the maintainer.
- The embedded API listens on a random loopback port and requires a token
  generated fresh each launch.
- The interface runs sandboxed, with context isolation, no Node.js integration,
  and a restrictive Content Security Policy.
- Optional App Lock puts the whole app behind a password or Touch ID.

Balance takes a daily snapshot and keeps the 14 most recent ones locally.
Snapshots match the ledger they came from: unencrypted until you turn on
encryption, encrypted afterwards, alongside a wrapped-key recovery copy. Those
snapshots live on the same Mac, so they are not a substitute for an off-device
backup. Export an archive from time to time and keep it somewhere you control.

### Encrypt your ledger

Once you have added an account and some transactions, Balance offers to encrypt
the ledger. You can also turn it on at any time from **Settings > Encryption**.

When you accept:

1. **macOS asks for permission** to store a key in your Keychain. Once
   encryption is on, Balance uses the Keychain to unlock the database key at
   launch. Choose **Always Allow** to minimize repeat prompts. An unsigned
   source-built version may ask again after a rebuild because macOS can treat
   the rebuilt binary as a different app.
2. Balance encrypts `balance.db` in place and restarts its local server.
3. Existing unencrypted snapshots are replaced with an encrypted one.

Running from source, the prompt names **Electron** rather than Balance, because
the binary you launched is the generic Electron runtime from `node_modules`. A
signed, packaged build shows the application's own name.

Encryption protects the ledger file: without the key, a copy of `balance.db` is
unreadable. It is not a defence against someone who already controls your macOS
account while you are logged in. **If you lose the Keychain entry and have not
set an App Lock password, the ledger cannot be recovered.** Keep an exported
archive if you want a copy you can always read. Turning encryption back off is
not supported; export an archive and start a fresh profile instead.

See [PRIVACY.md](./PRIVACY.md) for data-handling details and
[SECURITY.md](./SECURITY.md) for private vulnerability reporting.

## Build and run on macOS

Balance is distributed as source code. Clone it, install the locked
dependencies, verify the project, and launch:

```bash
git clone https://github.com/dklymenko/balance.git
cd balance
npm ci
npm run verify
npm run start
```

Requirements: an Apple silicon Mac, Node.js 24.x, npm 11.x, and Apple Command
Line Tools. No signing certificate, hosted service, or developer account is
needed. See [INSTALL.md](./INSTALL.md) for data location, backups,
troubleshooting, and optional local packaging.

On first run, choose **Keep it on this Mac**. Balance Cloud is not publicly
available. A source checkout starts in local-only mode with no configured Cloud
endpoint.

## Development

The repository is one npm workspace containing everything needed to build, test,
and run the app:

```bash
npm run verify       # hygiene, lint, typecheck, tests, and production build
npm run audit:all    # registry-backed audit of runtime and development tools
npm run start        # build and launch the desktop app
npm run dev          # optional browser-only development mode
npm run dist         # optional unsigned DMG and ZIP for your own Mac
```

| Path | Purpose |
|---|---|
| `client` | React interface |
| `server` | Local Express API, SQLite schema, migrations, and reports |
| `desktop` | Electron shell, encryption, backups, packaging, and native integrations |
| `packages/core` | Shared money, balance, archive, and sync contracts |
| `packages/sync-client` | Optional replica synchronization engine |

No package is fetched from another source repository. Third-party JavaScript
dependencies come from the npm registry and are locked by `package-lock.json`.
Production package licenses and notices are generated into
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

The repository ignores database files, environment files, CSV imports, local
settings, build artifacts, and internal working notes. The packaged-app
verification step fails the build if any of those, or unsafe macOS permissions,
end up inside an application bundle.

## Contributions

Issues and security reports are welcome. Code contributions are not currently
accepted. Please report vulnerabilities privately as described in
[SECURITY.md](./SECURITY.md).

## License

Balance is source-available under the
[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0).
Personal and other noncommercial use is permitted. Commercial use requires a
separate license from the author. See [LICENSE](./LICENSE) and
[LICENSING.md](./LICENSING.md).

Balance was researched, designed, and engineered by Dmytro Klymenko, sole author
of Balance's original application code. Third-party components remain copyright
their respective owners.
