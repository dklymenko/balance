# Security

## Supported versions

Security fixes are provided for the latest tagged source version of Balance.
Update your checkout, run `npm ci` and `npm run verify`, then reproduce the
problem on that version before reporting it when practical.

## Reporting a vulnerability

Send a concise private report to balance.app.support@gmail.com with the subject
`Balance security report`. Include the affected version, macOS version,
reproduction steps, impact, and any safe proof of concept.

Do not attach real financial data, a Balance database, an exported archive,
passwords, encryption keys, access tokens, or personal account identifiers.
Synthetic test data is welcome.

Please allow reasonable time to investigate and publish a fix before public
disclosure. You will receive an acknowledgment and a follow-up when the impact
and remediation are understood.

## Security boundaries

Balance protects local data with application-layer controls including an
authenticated loopback API, sandboxed renderer processes, restricted
navigation, optional at-rest database encryption, and an optional App Lock.

At-rest encryption is opt-in and off until the user enables it, so a default
install stores its ledger and local snapshots unencrypted. Reports that a fresh
profile is unencrypted describe intended behaviour. Reports that an *enabled*
encryption setting fails to protect the ledger, or silently falls back to
unencrypted data, are security issues and we want to hear about them.

These controls do not protect against an attacker who already controls your
macOS account or the operating system. Keep macOS updated, use FileVault, and
maintain an encrypted off-device backup.
