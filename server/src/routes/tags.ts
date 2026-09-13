import { Router } from "express";
import { and, eq, inArray } from "drizzle-orm";
import type { DrizzleDB } from "../db/types.js";
import { runTransaction } from "../db/tx.js";
import { tags, transactionTags, transactions } from "../db/schema.js";
import { recordChange } from "../lib/ledgerHooks.js";
import { parsePositiveId, sendError } from "../lib/validation.js";

export function createTagsRouter(db: DrizzleDB) {
const router = Router();

router.get("/", async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(tags)
      .where(undefined)
      .orderBy(tags.name);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch tags" });
  }
});

router.post("/", async (req, res) => {
  try {
    const { name } = req.body as { name: string };
    if (typeof name !== "string" || name.trim().length === 0 || name.length > 100) {
      return res.status(400).json({ error: "name must be between 1 and 100 characters" });
    }
    const trimmedName = name.trim();
    const row = await runTransaction(db, async (tx) => {
      const [existing] = await tx.select({ id: tags.id }).from(tags).where(eq(tags.name, trimmedName));
      if (existing) throw Object.assign(new Error("A tag with this name already exists"), { status: 409 });
      const [inserted] = await tx.insert(tags).values({ name: trimmedName }).returning();
      recordChange({ entity: "tag", entityUuid: inserted.uuid, op: "upsert" });
      return inserted;
    });
    res.status(201).json(row);
  } catch (err) {
    if (err instanceof Error && (err as { status?: number }).status === 409) {
      return res.status(409).json({ error: err.message });
    }
    if (typeof err === "object" && err !== null && "code" in err && err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(409).json({ error: "A tag with this name already exists" });
    }
    console.error(err);
    res.status(500).json({ error: "Failed to create tag" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const id = parsePositiveId(req.params.id);
    if (id === null) return res.status(400).json({ error: "id must be a positive integer" });
    // transaction_tags cascade deletes automatically (schema: onDelete cascade)
    const deleted = await runTransaction(db, async (tx) => {
      const rows = await tx.delete(tags)
        .where(and(eq(tags.id, id)))
        .returning({ id: tags.id, uuid: tags.uuid });
      if (rows.length > 0) recordChange({ entity: "tag", entityUuid: rows[0].uuid, op: "delete" });
      return rows;
    });
    if (deleted.length === 0) return res.status(404).json({ error: "Tag not found" });
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete tag" });
  }
});

// PUT /api/tags/transaction/:txId -- replace all tags on a transaction
router.put("/transaction/:txId", async (req, res) => {
  try {
    const txId = parsePositiveId(req.params.txId);
    if (txId === null) return res.status(400).json({ error: "transaction id must be a positive integer" });
    const tagIds = (req.body as { tag_ids?: unknown })?.tag_ids;
    if (!Array.isArray(tagIds) || tagIds.length > 100 || !tagIds.every((id) => Number.isInteger(id) && id > 0)) {
      return res.status(400).json({ error: "tag_ids must be an array of at most 100 positive integers" });
    }
    const uniqueTagIds = [...new Set(tagIds as number[])];

    await runTransaction(db, async (ledgerTx) => {
      // Validate and replace under the same write lock. Otherwise a concurrent
      // transaction/tag deletion can land between these reads and the inserts,
      // turning a client error into a foreign-key failure or a stale success.
      const [transaction] = await ledgerTx
        .select({ id: transactions.id, uuid: transactions.uuid })
        .from(transactions)
        .where(and(eq(transactions.id, txId)));
      if (!transaction) throw Object.assign(new Error("Transaction not found"), { status: 404 });

      const ownTagIds = uniqueTagIds.length === 0 ? [] : (await ledgerTx
        .select({ id: tags.id })
        .from(tags)
        .where(and(inArray(tags.id, uniqueTagIds)))).map((tag) => tag.id);
      if (ownTagIds.length !== uniqueTagIds.length) {
        throw Object.assign(new Error("one or more tag_ids do not exist"), { status: 400 });
      }

      // Delete existing, then insert new -- simpler than diffing. Tag links
      // ride the transaction's sync record as tag_uuids.
      await ledgerTx.delete(transactionTags).where(eq(transactionTags.transaction_id, txId));
      if (ownTagIds.length > 0) {
        await ledgerTx.insert(transactionTags).values(
          ownTagIds.map((tid) => ({ transaction_id: txId, tag_id: tid }))
        );
      }
      recordChange({ entity: "transaction", entityUuid: transaction.uuid, op: "upsert" });
    });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err, "Failed to update transaction tags");
  }
});

  return router;
}

export default createTagsRouter;
