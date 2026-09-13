# Building and running Balance Desktop

Balance is distributed as source code and currently supports Apple silicon Macs
(M-series, arm64). You do not need an Apple Developer account or signing
certificate.

## Build from source

Install Apple Command Line Tools, Node.js 24.x, and npm 11.x, then run:

```bash
xcode-select --install
git clone https://github.com/dklymenko/balance.git
cd balance
npm ci
npm run verify
npm run start
```

`npm ci` installs the exact dependency graph in `package-lock.json` and builds
the native database modules for their separate Node test and Electron runtime
targets. `npm run verify` checks repository hygiene, lint, types, all tests, and
the production build before the app opens. `npm run audit:all` checks both the
runtime dependencies and the development tools that a source user executes.

## Update a source checkout

Quit Balance and inspect your working tree before updating. If you have no local
changes you need to preserve, update explicitly and rerun the same verification:

```bash
git status
git pull --ff-only
npm ci
npm run verify
npm run start
```

Balance may tell you that a newer tagged version exists, but it never changes
your checkout or runs Git or npm commands for you.

## Optional existing-ledger import

The experimental existing-ledger CSV importer needs a private map from the
source file's account labels to the account names you created in Balance. Copy
`server/budget-app-mapping.example.json` to
`server/data/budget-app-mapping.json`, edit the copy, and restart Balance. The
`server/data` directory is ignored by Git because the map may contain real
financial account names.

## First run and data location

Choose **Keep it on this Mac**. No user account is required.

Balance stores its profile here:

```text
~/Library/Application Support/balance-desktop/
```

Important files are:

- `balance.db`: the SQLite ledger
- `dbkey.json`: the wrapped database key, not the raw key. Created only once you
  turn on encryption
- `backups/`: the 14 most recent database snapshots, plus a wrapped-key recovery
  copy once encryption is on
- `config.json`: local application settings

Balance creates a daily snapshot and also backs up on quit. Use **Balance > Back
Up Now** before large imports or upgrades.

## Encryption is opt-in

A new profile stores its ledger unencrypted, so installing Balance never raises
a macOS Keychain prompt on its own. Keychain access follows an explicit action:
turning on Encryption or App Lock, or signing in to an explicitly configured
private Cloud service. Once you have added an account and some transactions,
Balance offers to encrypt the ledger; **Settings > Encryption** turns it on at
any time.

Accepting creates a key in your macOS Keychain. That is the permission prompt
you will see. Choosing **Always Allow** minimizes repeat prompts for the same
build. An unsigned source-built version may ask again after a rebuild because
macOS can treat the rebuilt binary as a different app. Balance then encrypts
`balance.db` in place, restarts its local server, and replaces the unencrypted
snapshots with an encrypted one. Running from source the prompt names
*Electron*, because that is the binary you launched; a signed, packaged build
shows the application's own name.

After encryption is on, the database and `dbkey.json` belong together. When
manually restoring a snapshot, restore the wrapped-key copy from the same
profile as well. Copying an encrypted database to another Mac generally requires
an App Lock password wrap created before the backup; the macOS Keychain wrap is
tied to the original user account. Losing every wrap means losing the ledger, so
export an archive if you want a copy you can always read.

## Optional local package

Run `npm run dist` if you want a DMG and ZIP for your own Mac. The artifacts are
written to `desktop/release/` and are unsigned unless you independently provide
Apple signing credentials. The package-verification step still checks that no
local databases, environment files, internal instructions, or unsafe Electron
settings entered the application bundle.

## Development server

For browser development only:

```bash
cp .env.example server/.env
npm run dev
```

Open `http://127.0.0.1:5273`. Development mode uses a separate server database
configured by `DATABASE_URL`; never point tests or development automation at a
real desktop profile.

## Troubleshooting

**Apple compiler or `gyp` errors:** install Apple Command Line Tools, then rerun
`npm ci`.

**`NODE_MODULE_VERSION` mismatch:** run `npm run abi`. Balance uses one SQLite
driver built for Node, so the test suite can run, and another built for
Electron, which opens the app's ledger. `npm ci` builds both, and
`npm run dist` restores both after packaging. `npm run abi:check` asserts the
split. Rerun `npm ci` if the repair command cannot restore it.

**The local server cannot start:** your data file is left in place. Save the
terminal output and open a security-safe issue that excludes database contents,
environment files, account names, transaction data, and tokens.

**A snapshot does not open:** if encryption is on, confirm that `balance.db` and
`dbkey.json` came from the same profile. Never delete the current profile until a
restored copy has been verified.

**Balance will not open its database:** once encryption is on, Balance stops
rather than continuing with unencrypted data when no key wrap can be unwrapped.
Restore `balance.db` and `dbkey.json` together from a matching backup, or use the
App Lock password if you set one.
