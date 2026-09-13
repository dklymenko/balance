CREATE TABLE `sync_conflicts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity` text NOT NULL,
	`entity_uuid` text NOT NULL,
	`reason` text NOT NULL,
	`detail` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_outbox` (
	`op_id` text PRIMARY KEY NOT NULL,
	`entity` text NOT NULL,
	`entity_uuid` text NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text
);
--> statement-breakpoint
CREATE TABLE `sync_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
-- Hand-tuned from generated migration output: SQLite cannot ADD a NOT NULL column to
-- a populated table without a constant default. The '' default never appears
-- in practice -- the app generates uuids in JS at insert time ($defaultFn) and
-- the backfills below stamp every existing row before the unique indexes go on.
ALTER TABLE `account_adjustments` ADD `uuid` text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `accounts` ADD `uuid` text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `categories` ADD `uuid` text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `tags` ADD `uuid` text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `transactions` ADD `uuid` text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `transactions` ADD `transfer_direction` text;--> statement-breakpoint
-- uuid v4 backfill for pre-existing rows (randomblob-based, version and
-- variant bits set).
UPDATE `accounts` SET uuid = lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))) WHERE uuid = '';--> statement-breakpoint
UPDATE `categories` SET uuid = lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))) WHERE uuid = '';--> statement-breakpoint
UPDATE `tags` SET uuid = lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))) WHERE uuid = '';--> statement-breakpoint
UPDATE `transactions` SET uuid = lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))) WHERE uuid = '';--> statement-breakpoint
UPDATE `account_adjustments` SET uuid = lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))) WHERE uuid = '';--> statement-breakpoint
-- transfer_direction backfill: pair legs by group id, lower id = 'out'.
-- Groups without exactly two legs stay NULL and contribute 0 (lone-leg
-- behavior). The same rule is enforced by the application schema.
UPDATE `transactions` SET transfer_direction = CASE WHEN id = (
    SELECT MIN(t2.id) FROM `transactions` t2 WHERE t2.transfer_group_id = `transactions`.transfer_group_id
  ) THEN 'out' ELSE 'in' END
  WHERE type = 'transfer' AND transfer_group_id IS NOT NULL AND transfer_direction IS NULL
  AND (SELECT COUNT(*) FROM `transactions` t3 WHERE t3.transfer_group_id = `transactions`.transfer_group_id) = 2;--> statement-breakpoint
-- Frozen-delta model: wherever the canonical recompute (transaction
-- contributions + adjustment deltas) disagrees with the stored balance
-- (opening balances were bare column writes; transfers predating direction),
-- freeze the difference into one synthetic adjustment so the CURRENT stored
-- balance is reproduced exactly. Idempotent: after the first run the
-- recompute equals the stored balance.
INSERT INTO `account_adjustments` (uuid, account_id, old_balance, new_balance, reason)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))),
  x.id, x.computed, x.balance, 'Opening balance (sync migration)'
FROM (
  SELECT a.id AS id, a.balance AS balance,
    (COALESCE((SELECT SUM(CASE
        WHEN t.type = 'credit' THEN t.amount_fx
        WHEN t.type = 'debit' THEN -t.amount_fx
        WHEN t.transfer_direction = 'out' THEN -t.amount_fx
        WHEN t.transfer_direction = 'in' THEN t.amount_fx
        ELSE 0 END) FROM `transactions` t WHERE t.account_id = a.id), 0)
     + COALESCE((SELECT SUM(j.new_balance - j.old_balance)
        FROM `account_adjustments` j WHERE j.account_id = a.id), 0)) AS computed
  FROM `accounts` a
) x
WHERE x.computed <> x.balance;--> statement-breakpoint
CREATE UNIQUE INDEX `account_adjustments_uuid_unique` ON `account_adjustments` (`uuid`);--> statement-breakpoint
CREATE INDEX `account_adjustments_account_idx` ON `account_adjustments` (`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_uuid_unique` ON `accounts` (`uuid`);--> statement-breakpoint
CREATE UNIQUE INDEX `categories_uuid_unique` ON `categories` (`uuid`);--> statement-breakpoint
CREATE UNIQUE INDEX `tags_uuid_unique` ON `tags` (`uuid`);--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_uuid_unique` ON `transactions` (`uuid`);--> statement-breakpoint
CREATE INDEX `transactions_account_idx` ON `transactions` (`account_id`);
