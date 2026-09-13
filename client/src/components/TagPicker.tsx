import { useState } from "react";
import { X, Tag as TagIcon, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";

interface Tag {
  id: number;
  name: string;
}

interface Props {
  allTags: Tag[];
  selectedIds: number[];
  onChange: (ids: number[]) => void;
  // Create a brand-new label inline. Returns the created tag (so it can be
  // selected immediately) or null on failure. When omitted, creation is hidden.
  onCreate?: (name: string) => Promise<Tag | null>;
  // In dense contexts (the transactions table) the chips must stay on ONE line
  // so a row with several labels doesn't grow taller than its neighbours.
  // Overflow is clipped; the full set is still editable by opening the row.
  singleLine?: boolean;
}

const COLORS = [
  "bg-blue-100 text-blue-700",
  "bg-green-100 text-green-700",
  "bg-purple-100 text-purple-700",
  "bg-orange-100 text-orange-700",
  "bg-pink-100 text-pink-700",
  "bg-teal-100 text-teal-700",
  "bg-yellow-100 text-yellow-700",
  "bg-red-100 text-red-700",
];

export function tagColor(id: number) {
  return COLORS[id % COLORS.length];
}

export default function TagPicker({ allTags, selectedIds, onChange, onCreate, singleLine }: Props) {
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  function toggle(id: number) {
    onChange(selectedIds.includes(id) ? selectedIds.filter(i => i !== id) : [...selectedIds, id]);
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name || !onCreate || creating) return;
    setCreateError(null);
    setCreating(true);
    try {
      const tag = await onCreate(name);
      if (tag) {
        onChange([...selectedIds, tag.id]);
        setNewName("");
      } else {
        setCreateError("Couldn't create the label. Please try again.");
      }
    } catch {
      setCreateError("Couldn't create the label. Please try again.");
    } finally {
      setCreating(false);
    }
  }

  const selected = allTags.filter(t => selectedIds.includes(t.id));
  const unselected = allTags.filter(t => !selectedIds.includes(t.id));

  return (
    <div className={cn("flex items-center gap-1", singleLine ? "flex-nowrap overflow-hidden" : "flex-wrap")}>
      {selected.map(t => (
        <span key={t.id}
          className={cn("inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-medium", singleLine && "shrink-0", tagColor(t.id))}>
          {t.name}
          <button type="button" aria-label={`Remove label ${t.name}`} onClick={e => { e.stopPropagation(); toggle(t.id); }} className="hover:opacity-70">
            <X className="w-3 h-3" />
          </button>
        </span>
      ))}

      {(allTags.length > 0 || onCreate) && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button type="button" aria-label="Add label" className="text-muted-foreground hover:text-foreground" title="Add label">
              <TagIcon className="w-3.5 h-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-52 p-1" align="start">
            {unselected.map(t => (
              <button type="button" key={t.id} onClick={() => { toggle(t.id); }}
                className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted flex items-center gap-2 rounded">
                <span className={`w-2 h-2 rounded-full ${tagColor(t.id).split(" ")[0]}`} />
                {t.name}
              </button>
            ))}
            {unselected.length === 0 && selected.length > 0 && !onCreate && (
              <p className="px-3 py-2 text-xs text-muted-foreground">All labels applied</p>
            )}
            {onCreate && (
              <div className={unselected.length > 0 ? "mt-1 border-t pt-1" : ""}>
                <div className="flex items-center gap-1 px-1 py-0.5">
                  <Input
                    value={newName}
                    onChange={(e) => { setNewName(e.target.value); setCreateError(null); }}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleCreate(); } }}
                    placeholder="New label…"
                    className="h-8 text-sm"
                  />
                  <button
                    type="button"
                    onClick={handleCreate}
                    disabled={!newName.trim() || creating}
                    aria-label="Create label"
                    className="shrink-0 rounded p-1.5 text-primary hover:bg-muted disabled:opacity-40"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
                {createError && <p role="alert" className="px-2 pb-1 text-xs text-destructive">{createError}</p>}
              </div>
            )}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
