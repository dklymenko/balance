import { Router } from "express";
import { and, eq } from "drizzle-orm";
import type { DrizzleDB } from "../db/types.js";
import { runTransaction } from "../db/tx.js";
import { categories } from "../db/schema.js";
import { recordChange } from "../lib/ledgerHooks.js";
import { parsePositiveId, sendError } from "../lib/validation.js";

export function createCategoriesRouter(db: DrizzleDB) {
const router = Router();

const CATEGORY_KINDS = new Set(["income", "expense", "both"]);
const validName = (name: unknown): name is string =>
  typeof name === "string" && name.trim().length > 0 && name.length <= 200;

// Parents must exist and be top-level so the category tree remains acyclic and
// at most two levels deep.
async function canUseAsParent(exec: DrizzleDB, categoryId: number | null | undefined, childId?: number): Promise<boolean> {
  if (categoryId == null) return true; // null = top-level, always allowed
  if (!Number.isInteger(categoryId) || categoryId <= 0 || categoryId === childId) return false;
  const [row] = await exec.select({ id: categories.id, parent_id: categories.parent_id }).from(categories)
    .where(and(eq(categories.id, categoryId)));
  return !!row && row.parent_id === null;
}

// GET /api/categories -- flat list, client builds the tree
router.get("/", async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(categories)
      .where(undefined)
      .orderBy(categories.name);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch categories" });
  }
});

// POST /api/categories -- single create
router.post("/", async (req, res) => {
  try {
    const { name, parent_id, kind } = req.body as { name: string; parent_id?: number | null; kind?: "income" | "expense" | "both" };
    if (!validName(name)) return res.status(400).json({ error: "name must be between 1 and 200 characters" });
    if (kind !== undefined && !CATEGORY_KINDS.has(kind)) return res.status(400).json({ error: "invalid category kind" });
    const row = await runTransaction(db, async (tx) => {
      if (!(await canUseAsParent(tx, parent_id))) {
        throw Object.assign(new Error("parent must be a top-level category"), { status: 400 });
      }
      const [inserted] = await tx
        .insert(categories)
        .values({ name: name.trim(), parent_id: parent_id ?? null, ...(kind && { kind }) })
        .returning();
      recordChange({ entity: "category", entityUuid: inserted.uuid, op: "upsert" });
      return inserted;
    });
    res.status(201).json(row);
  } catch (err) {
    sendError(res, err, "Failed to create category");
  }
});

// POST /api/categories/batch -- indented text format
// Lines with no leading whitespace = parent categories
// Lines with leading whitespace = sub-categories of the previous parent
router.post("/batch", async (req, res) => {
  try {
    const { text } = req.body as { text: string };
    if (typeof text !== "string" || !text.trim() || text.length > 50_000) return res.status(400).json({ error: "text is required and must be at most 50000 characters" });

    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length > 1_000 || lines.some((line) => !validName(line.trim()))) {
      return res.status(400).json({ error: "batch must contain at most 1000 category names of 200 characters each" });
    }

    // One SELECT up front instead of one per line, and one transaction so a
    // failing line never commits half a tree. `known` mirrors what's in the DB
    // plus what this batch has inserted so far, preserving the original
    // dedupe semantics (parents match by name; children by name+parent).
    let created = 0;
    await runTransaction(db, async (tx) => {
      const known = await tx
        .select({ id: categories.id, name: categories.name, parent_id: categories.parent_id })
        .from(categories)
        .where(undefined)
        .orderBy(categories.id);

      let currentParentId: number | null = null;
      for (const line of lines) {
        const isChild = /^\s/.test(line);
        const name = line.trim();
        if (!name) continue;

        if (!isChild) {
          const existing = known.find((c) => c.name === name && c.parent_id === null);
          if (existing) {
            currentParentId = existing.id;
          } else {
            const [row] = await tx
              .insert(categories)
              .values({  name, parent_id: null })
              .returning();
            known.push({ id: row.id, name: row.name, parent_id: row.parent_id });
            currentParentId = row.id;
            recordChange({ entity: "category", entityUuid: row.uuid, op: "upsert" });
            created++;
          }
        } else {
          if (currentParentId === null) continue; // orphan line, skip
          const parentId = currentParentId;
          const alreadyUnderParent = known.some((c) => c.name === name && c.parent_id === parentId);
          if (!alreadyUnderParent) {
            const [row] = await tx
              .insert(categories)
              .values({  name, parent_id: parentId })
              .returning();
            known.push({ id: row.id, name: row.name, parent_id: row.parent_id });
            recordChange({ entity: "category", entityUuid: row.uuid, op: "upsert" });
            created++;
          }
        }
      }
    });

    res.json({ created });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to batch create categories" });
  }
});

// PATCH /api/categories/:id
router.patch("/:id", async (req, res) => {
  try {
    const id = parsePositiveId(req.params.id);
    if (id === null) return res.status(400).json({ error: "id must be a positive integer" });
    const { name, parent_id, kind } = req.body as { name?: string; parent_id?: number | null; kind?: "income" | "expense" | "both" };
    if (name !== undefined && !validName(name)) return res.status(400).json({ error: "name must be between 1 and 200 characters" });
    if (kind !== undefined && !CATEGORY_KINDS.has(kind)) return res.status(400).json({ error: "invalid category kind" });
    const row = await runTransaction(db, async (tx) => {
      const [current] = await tx.select({ id: categories.id }).from(categories)
        .where(and(eq(categories.id, id)));
      if (!current) throw Object.assign(new Error("Category not found"), { status: 404 });
      if (parent_id !== undefined && !(await canUseAsParent(tx, parent_id, id))) {
        throw Object.assign(new Error("parent must be a different top-level category"), { status: 400 });
      }
      if (parent_id != null) {
        const [child] = await tx.select({ id: categories.id }).from(categories)
          .where(and(eq(categories.parent_id, id))).limit(1);
        if (child) {
          throw Object.assign(new Error("a category with sub-categories cannot become a sub-category"), { status: 400 });
        }
      }
      const [updated] = await tx
        .update(categories)
        .set({ ...(name !== undefined && { name: name.trim() }), ...(parent_id !== undefined && { parent_id }), ...(kind !== undefined && { kind }) })
        .where(and(eq(categories.id, id)))
        .returning();
      if (updated) recordChange({ entity: "category", entityUuid: updated.uuid, op: "upsert" });
      return updated;
    });
    res.json(row);
  } catch (err) {
    sendError(res, err, "Failed to update category");
  }
});

// DELETE /api/categories/:id
// Deletes the category; children get parent_id = null (schema: onDelete set null)
router.delete("/:id", async (req, res) => {
  try {
    const id = parsePositiveId(req.params.id);
    if (id === null) return res.status(400).json({ error: "id must be a positive integer" });
    const deleted = await runTransaction(db, async (tx) => {
      const rows = await tx.delete(categories)
        .where(and(eq(categories.id, id)))
        .returning({ id: categories.id, uuid: categories.uuid });
      if (rows.length > 0) recordChange({ entity: "category", entityUuid: rows[0].uuid, op: "delete" });
      return rows;
    });
    if (deleted.length === 0) return res.status(404).json({ error: "Category not found" });
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete category" });
  }
});

  return router;
}

export default createCategoriesRouter;
