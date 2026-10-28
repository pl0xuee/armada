import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "@/lib/api";
import { PROVIDERS } from "@/lib/providers";
import type { Account } from "@/lib/types";
import { errorMessage } from "@/lib/utils";
import { useApp } from "@/store/app";
import { ColorSwatches } from "./ColorSwatches";

/** Rename / recolor an account. */
export function EditAccountPopover({ account, children }: { account: Account; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(account.name);
  // Not blocking, just a heads-up: two "Personal" Claude accounts are hard to tell apart.
  const duplicate = useApp((s) =>
    s.accounts.some(
      (a) =>
        a.id !== account.id &&
        a.provider === account.provider &&
        a.name.trim().toLowerCase() === name.trim().toLowerCase() &&
        name.trim() !== "",
    ),
  );
  const [color, setColor] = useState(account.color);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(account.name);
      setColor(account.color);
    }
  }, [open, account.name, account.color]);

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const updated = await api.updateAccount(account.id, name.trim(), color);
      useApp.getState().upsertAccount(updated);
      setOpen(false);
    } catch (e) {
      toast.error("Couldn't update account", { description: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="end" className="w-[280px] p-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Label htmlFor={`acc-name-${account.id}`}>Name</Label>
          <Input
            id={`acc-name-${account.id}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            maxLength={40}
            aria-describedby={duplicate ? `acc-name-dup-${account.id}` : undefined}
          />
          {duplicate && (
            <p id={`acc-name-dup-${account.id}`} className="mt-1.5 text-[11.5px] text-warn">
              Another {PROVIDERS[account.provider].short} account is already called “{name.trim()}”. A distinct name
              makes them easier to tell apart.
            </p>
          )}
          <Label className="mt-4">Color</Label>
          <ColorSwatches value={color} onChange={setColor} className="grid w-fit grid-cols-5" />
          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit" disabled={saving || !name.trim()}>
              Save
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
