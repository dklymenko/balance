# Privacy

Balance is a local-first personal finance application. In local mode, your
accounts, transactions, categories, tags, settings, encryption keys, and
backups stay in the Balance profile on your Mac.

Encryption at rest is optional and off by default, so a new profile stores its
ledger and its snapshots unencrypted until you turn encryption on. Balance
offers this after you have set up your accounts, and Settings > Encryption can
turn it on at any time. Normal local setup does not use your macOS Keychain.
Explicitly enabling Encryption or App Lock, or signing in to an explicitly
configured private Cloud service, does. Once encryption is on, Balance uses the
Keychain to wrap and unlock the database key; App Lock uses it to seal its
password verifier. Balance refuses to open an encrypted ledger if the key
cannot be unwrapped rather than falling back to unencrypted data.

Turning encryption on protects the ledger from that point forward. It does not
retroactively erase data written while the profile was unencrypted: Balance
replaces its own unencrypted snapshots, but disk blocks freed along the way, and
any copy already taken by Time Machine or another backup tool, remain outside
its control. If that matters to you, turn encryption on before entering real
data, or start a fresh profile and import an archive into it.

Balance does not include analytics, advertising, behavioral tracking, or crash
reporting. Normal local use does not contact a hosted service.

Balance Cloud is not publicly available. A source checkout starts in
local-only mode and contains no configured cloud endpoint. The optional sync
code remains available for explicitly configured private deployments.

The following actions use the network only when you explicitly request them:

- Check for Updates contacts GitHub for version metadata. It does not download,
  install, or execute repository changes.
- Amazon order import opens Amazon in an isolated browser session and imports
  only the order data shown for the date range you selected. Its dedicated
  session persists on this Mac so you do not need to sign in on every launch.
  Cookie values are encrypted using macOS Keychain-backed protection and are
  never synced to Balance Cloud. Settings > Amazon sign-in can remove the
  session's cookies, site storage, authentication cache, and browser cache.
  Direct development launches keep the session in memory rather than writing
  cookies without the packaged application's encryption protection.
- Optional cloud sync contacts only the Balance sync service that a maintainer
  explicitly configures, and only after cloud mode is enabled and signed in.

Amazon and GitHub process their own service data under their respective terms.
Balance does not send your ledger to either service.

App data and local snapshots are stored under:

```text
~/Library/Application Support/balance-desktop/
```

Removing that directory permanently removes the local profile. Before doing so,
quit Balance and keep any archive or backup you want to retain.

Privacy questions may be sent to balance.app.support@gmail.com. Do not include
account numbers, transaction exports, database files, passwords, or encryption
keys in email.
