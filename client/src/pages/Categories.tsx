import { useEffect, useState } from "react";
import { Check, ChevronsUpDown, ChevronRight, ChevronDown, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { tagColor } from "@/components/TagPicker";
import PageContainer from "@/components/PageContainer";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

interface Category {
  id: number;
  name: string;
  parent_id: number | null;
  kind?: "income" | "expense" | "both";
}

interface TagItem {
  id: number;
  name: string;
}

interface CategoryTree {
  parent: Category;
  children: Category[];
}

async function responseError(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => ({} as { error?: string }));
  return typeof body.error === "string" && body.error ? body.error : fallback;
}

// A category can apply to Expense, Income, or both. Two toggle chips: at least
// one must stay selected; both selected stores kind = "both".
function KindToggle({ cat, onSetKind }: {
  cat: Category;
  onSetKind: (c: Category, kind: "expense" | "income" | "both") => void;
}) {
  const isExpense = cat.kind === "expense" || cat.kind === "both" || !cat.kind;
  const isIncome = cat.kind === "income" || cat.kind === "both";
  function set(nextExpense: boolean, nextIncome: boolean) {
    if (!nextExpense && !nextIncome) return; // one must remain
    onSetKind(cat, nextExpense && nextIncome ? "both" : nextIncome ? "income" : "expense");
  }
  const chip = (on: boolean, activeCls: string) =>
    cn("text-[11px] rounded-full px-2 py-0.5 border transition-colors shrink-0",
      on ? activeCls : "text-muted-foreground border-border hover:bg-muted");
  return (
    <div className="flex items-center gap-1 shrink-0">
      <button type="button" onClick={() => set(!isExpense, isIncome)} title="Usable on expenses"
        className={chip(isExpense, "bg-red-100 text-red-700 border-red-200")}>
        Expense
      </button>
      <button type="button" onClick={() => set(isExpense, !isIncome)} title="Usable on income"
        className={chip(isIncome, "bg-green-100 text-green-700 border-green-200")}>
        Income
      </button>
    </div>
  );
}

const BATCH_PLACEHOLDER = `Food & Dining
  Groceries
  Restaurants
  Coffee & Tea
  Fast Food
Housing
  Rent
  Utilities
  Internet & Phone
Transportation
  Gas
  Parking
  Uber & Lyft
Shopping
  Clothing
  Electronics
  Online
Healthcare
  Insurance
  Pharmacy
  Doctor
Entertainment
  Streaming
  Events
  Hobbies
Travel
  Flights
  Hotels
  Activities
Income
  Salary
  RSU Vest
  Interest`;

export default function Categories() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);

  // Add single form state
  const [newName, setNewName] = useState("");
  const [newParentId, setNewParentId] = useState<string>("none");
  const [newKind, setNewKind] = useState<"income" | "expense" | "both">("expense");
  const [parentOpen, setParentOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Tags state
  const [tagItems, setTagItems] = useState<TagItem[]>([]);
  const [newTag, setNewTag] = useState("");
  const [savingTag, setSavingTag] = useState(false);

  async function loadTags() {
    try {
      const response = await fetch("/api/tags");
      if (!response.ok) throw new Error("Couldn't load labels.");
      const data = await response.json();
      if (!Array.isArray(data)) throw new Error("Couldn't load labels.");
      setTagItems(data);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Couldn't load labels.");
    }
  }

  useEffect(() => { void loadTags(); }, []);

  async function handleAddTag(e: React.FormEvent) {
    e.preventDefault();
    if (!newTag.trim()) return;
    setActionError(null);
    setSavingTag(true);
    try {
      const response = await fetch("/api/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newTag.trim() }),
      });
      if (!response.ok) throw new Error(await responseError(response, "Couldn't add the label."));
      setNewTag("");
      await loadTags();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Couldn't add the label.");
    } finally {
      setSavingTag(false);
    }
  }

  async function handleDeleteTag(id: number) {
    if (!confirm("Delete this label? It will be removed from all transactions.")) return;
    setActionError(null);
    try {
      const response = await fetch(`/api/tags/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await responseError(response, "Couldn't delete the label."));
      await loadTags();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Couldn't delete the label.");
    }
  }

  // Batch state
  const [batchText, setBatchText] = useState(BATCH_PLACEHOLDER);
  const [batchResult, setBatchResult] = useState<string | null>(null);
  const [batching, setBatching] = useState(false);
  const [loading, setLoading] = useState(true);
  // Parent categories are collapsed by default; expand to reveal subcategories.
  const [expandedCats, setExpandedCats] = useState<Set<number>>(new Set());

  function toggleCat(id: number) {
    setExpandedCats((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function load() {
    try {
      const response = await fetch("/api/categories");
      if (!response.ok) throw new Error("Couldn't load categories.");
      const data = await response.json();
      if (!Array.isArray(data)) throw new Error("Couldn't load categories.");
      setCategories(data);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Couldn't load categories.");
    }
  }

  useEffect(() => { load().finally(() => setLoading(false)); }, []);

  // Build tree: parents with their children
  const parents = categories.filter((c) => c.parent_id === null);
  const tree: CategoryTree[] = parents.map((p) => ({
    parent: p,
    children: categories.filter((c) => c.parent_id === p.id),
  }));

  // Orphaned children (parent was deleted)
  const orphans = categories.filter(
    (c) => c.parent_id !== null && !parents.find((p) => p.id === c.parent_id)
  );

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setActionError(null);
    setSaving(true);
    try {
      const response = await fetch("/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName,
          parent_id: newParentId === "none" ? null : Number(newParentId),
          kind: newKind,
        }),
      });
      if (!response.ok) throw new Error(await responseError(response, "Couldn't add the category."));
      setAddOpen(false);
      setNewName("");
      setNewParentId("none");
      setNewKind("expense");
      await load();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Couldn't add the category.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: number) {
    if (!confirm("Delete this category? Sub-categories will become top-level.")) return;
    setActionError(null);
    try {
      const response = await fetch(`/api/categories/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await responseError(response, "Couldn't delete the category."));
      await load();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Couldn't delete the category.");
    }
  }

  async function handleSetKind(cat: Category, kind: "expense" | "income" | "both") {
    setActionError(null);
    try {
      const response = await fetch(`/api/categories/${cat.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      if (!response.ok) throw new Error(await responseError(response, "Couldn't update the category."));
      await load();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Couldn't update the category.");
    }
  }

  async function handleBatch(e: React.FormEvent) {
    e.preventDefault();
    setBatching(true);
    setBatchResult(null);
    try {
      const res = await fetch("/api/categories/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: batchText }),
      });
      const json = await res.json().catch(() => ({})) as { created?: number; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Couldn't import categories.");
      setBatchResult(`Created ${json.created ?? 0} categories`);
      await load();
    } catch (cause) {
      setBatchResult(`Error: ${cause instanceof Error ? cause.message : "Couldn't import categories."}`);
    } finally {
      setBatching(false);
    }
  }

  return (
    <PageContainer className="py-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Categories</h1>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => { setBatchResult(null); setBatchOpen(true); }}>
              Batch Import
            </Button>
            <Button size="sm" onClick={() => { setActionError(null); setNewName(""); setNewParentId("none"); setNewKind("expense"); setParentOpen(false); setAddOpen(true); }}>
              <Plus className="w-4 h-4 mr-1" /> Add
            </Button>
          </div>
      </div>

      {actionError && !addOpen && (
        <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          {actionError}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-3 lg:items-start">
        {/* Category tree */}
        <div className="rounded-lg border divide-y self-start lg:col-span-2">
          {loading ? (
            <p className="text-center text-muted-foreground py-12 text-sm">Loading…</p>
          ) : tree.length === 0 && orphans.length === 0 ? (
            <p className="text-center text-muted-foreground py-12 text-sm">
              No categories yet. Use Batch Import to create them all at once.
            </p>
          ) : null}
          {tree.map(({ parent, children }) => (
            <div key={parent.id}>
              {/* Parent row -- click to expand/collapse its subcategories */}
              <div className="flex items-center justify-between px-4 py-3 group">
                <button
                  type="button"
                  onClick={() => children.length > 0 && toggleCat(parent.id)}
                  className={cn("flex min-w-0 items-center gap-2 text-left", children.length === 0 && "cursor-default")}
                >
                  {children.length > 0 ? (
                    expandedCats.has(parent.id)
                      ? <ChevronDown className="w-4 h-4 shrink-0 text-muted-foreground" />
                      : <ChevronRight className="w-4 h-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <span className="w-4 shrink-0" />
                  )}
                  <span className="truncate text-sm font-medium">{parent.name}</span>
                  {children.length > 0 && (
                    <span className="text-xs text-muted-foreground">({children.length})</span>
                  )}
                </button>
                <div className="flex items-center gap-1">
                  <KindToggle cat={parent} onSetKind={handleSetKind} />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete category ${parent.name}`}
                    className="h-7 w-7 text-red-500 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => handleDelete(parent.id)}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
              {/* Children -- hidden until the parent is expanded */}
              {expandedCats.has(parent.id) && children.map((child) => (
                <div key={child.id} className="flex items-center justify-between px-4 py-2.5 bg-muted/30 group">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    {/* Non-navigating indent marker (a chevron here read as "drill in"). */}
                    <span aria-hidden className="text-xs opacity-60">↳</span>
                    {child.name}
                  </div>
                  <div className="flex items-center gap-1">
                    <KindToggle cat={child} onSetKind={handleSetKind} />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete category ${child.name}`}
                      className="h-7 w-7 text-red-500 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => handleDelete(child.id)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ))}
          {orphans.map((o) => (
            <div key={o.id} className="flex items-center justify-between px-4 py-2.5 group">
              <span className="text-sm text-muted-foreground italic">{o.name} (uncategorized)</span>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Delete category ${o.name}`}
                className="h-7 w-7 text-red-500 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={() => handleDelete(o.id)}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
          ))}
        </div>

        {/* Labels section */}
        <div className="space-y-4">
        <h2 className="text-lg font-semibold tracking-tight">Labels</h2>
        <form onSubmit={handleAddTag} className="flex gap-2">
          <Input
            value={newTag}
            onChange={(e) => setNewTag(e.target.value)}
            placeholder="New label (e.g. Europe2024)"
            className="max-w-xs"
          />
          <Button type="submit" size="sm" disabled={savingTag || !newTag.trim()}>
            <Plus className="w-4 h-4 mr-1" /> Add
          </Button>
        </form>
        <div className="flex flex-wrap gap-2">
          {tagItems.length === 0 && (
            <p className="text-sm text-muted-foreground">No labels yet.</p>
          )}
          {tagItems.map((t) => (
            <span
              key={t.id}
              className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm font-medium ${tagColor(t.id)}`}
            >
              {t.name}
              <button
                type="button"
                onClick={() => handleDeleteTag(t.id)}
                aria-label={`Delete label ${t.name}`}
                className="hover:opacity-70 ml-1"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
        </div>
      </div>

      {/* Add single category dialog */}
      <Dialog open={addOpen} onOpenChange={(v) => { if (!v) { setAddOpen(false); setActionError(null); } }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Add Category</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleAdd} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="cat-name">Name</Label>
              <Input
                id="cat-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Groceries"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label>Parent (optional)</Label>
              <Popover open={parentOpen} onOpenChange={setParentOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    role="combobox"
                    aria-label="Parent (optional)"
                    className="w-full justify-between font-normal"
                  >
                    <span className={cn(newParentId === "none" && "text-muted-foreground")}>
                      {newParentId === "none"
                        ? "Top-level"
                        : parents.find(p => String(p.id) === newParentId)?.name}
                    </span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  className="p-0"
                  style={{ width: "var(--radix-popover-trigger-width)" }}
                  align="start"
                >
                  <Command>
                    <CommandInput placeholder="Search parent categories…" />
                    <CommandList>
                      <CommandEmpty>No category found.</CommandEmpty>
                      <CommandGroup>
                        <CommandItem
                          value="none"
                          onSelect={() => { setNewParentId("none"); setParentOpen(false); }}
                        >
                          <Check className={cn("mr-2 h-4 w-4", newParentId === "none" ? "opacity-100" : "opacity-0")} />
                          Top-level
                        </CommandItem>
                        {parents.map(p => (
                          <CommandItem
                            key={p.id}
                            value={p.name}
                            onSelect={() => { setNewParentId(String(p.id)); setParentOpen(false); }}
                          >
                            <Check className={cn("mr-2 h-4 w-4", newParentId === String(p.id) ? "opacity-100" : "opacity-0")} />
                            {p.name}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
            <div className="space-y-1.5">
              <Label>Kind</Label>
              {/* Pick one or both. Both selected = "both" (usable on expense and income). */}
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={newKind === "expense" || newKind === "both" ? "default" : "outline"}
                  onClick={() => setNewKind(newKind === "income" ? "both" : newKind === "both" ? "income" : "expense")}
                >
                  Expense
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={newKind === "income" || newKind === "both" ? "default" : "outline"}
                  onClick={() => setNewKind(newKind === "expense" ? "both" : newKind === "both" ? "expense" : "income")}
                >
                  Income
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {newKind === "both"
                  ? "Usable on both expense and income transactions."
                  : newKind === "income"
                    ? "Income categories are used on money-in transactions."
                    : "Expense categories are used on money-out transactions."}
              </p>
            </div>
            {actionError && (
              <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
                {actionError}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Batch import dialog */}
      <Dialog open={batchOpen} onOpenChange={(v) => !v && setBatchOpen(false)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Batch Import Categories</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleBatch} className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Top-level categories are flush left. Sub-categories are indented with spaces or a tab.
              Existing categories are skipped.
            </p>
            <textarea
              className="w-full h-72 rounded-md border bg-background px-3 py-2 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-ring"
              value={batchText}
              onChange={(e) => setBatchText(e.target.value)}
              spellCheck={false}
            />
            {batchResult && (
              <p className={`text-sm ${batchResult.startsWith("Error") ? "text-red-500" : "text-green-600"}`}>
                {batchResult}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setBatchOpen(false)}>Close</Button>
              <Button type="submit" disabled={batching}>
                {batching ? "Importing…" : "Import"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </PageContainer>
  );
}
