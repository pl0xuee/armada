import { Eye, EyeOff, KeyRound, LogIn, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ProviderMark } from "@/components/ProviderGlyph";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { startLogin } from "@/lib/actions";
import { api } from "@/lib/api";
import { ACCOUNT_COLORS, PROVIDER_ORDER, PROVIDERS, type BuiltinProvider } from "@/lib/providers";
import type { AuthKind } from "@/lib/types";
import { cn, errorMessage } from "@/lib/utils";
import { useApp } from "@/store/app";
import { ColorSwatches } from "./ColorSwatches";
import { onRadioGroupKeyDown } from "../ui/radioKeys";

const SUBSCRIPTION: Record<BuiltinProvider, string> = {
  claude: "Claude Pro or Max",
  codex: "ChatGPT Plus, Pro or Team",
  grok: "SuperGrok or X Premium+",
};

const KEY_HINT: Record<BuiltinProvider, { env: string; placeholder: string }> = {
  claude: { env: "ANTHROPIC_API_KEY", placeholder: "sk-ant-…" },
  codex: { env: "OPENAI_API_KEY", placeholder: "sk-proj-…" },
  grok: { env: "XAI_API_KEY", placeholder: "xai-…" },
};

export function AddAccountDialog({
  open,
  onOpenChange,
  defaultProvider = "claude",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultProvider?: BuiltinProvider;
}) {
  const accounts = useApp((s) => s.accounts);
  const [provider, setProvider] = useState<BuiltinProvider>(defaultProvider);
  const [name, setName] = useState("");
  const [color, setColor] = useState(ACCOUNT_COLORS[0]);
  const [auth, setAuth] = useState<Exclude<AuthKind, "default">>("oauth");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setProvider(defaultProvider);
    setName("");
    setAuth("oauth");
    setApiKey("");
    setShowKey(false);
    // Pick a color not yet used, if possible.
    const used = new Set(accounts.map((a) => a.color.toLowerCase()));
    setColor(ACCOUNT_COLORS.find((c) => !used.has(c.toLowerCase())) ?? ACCOUNT_COLORS[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultProvider]);

  const existing = accounts.filter((a) => a.provider === provider).length;
  const placeholder = existing === 0 ? "Personal" : existing === 1 ? "Work" : `Account ${existing + 1}`;
  const finalName = name.trim() || placeholder;
  const valid = auth === "oauth" || apiKey.trim().length >= 8;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const acc = await api.createAccount({
        provider,
        name: finalName,
        color,
        authKind: auth,
        apiKey: auth === "api_key" ? apiKey.trim() : null,
      });
      useApp.getState().upsertAccount(acc);
      onOpenChange(false);
      if (auth === "oauth") {
        await startLogin(acc);
      } else {
        toast.success(`Added “${acc.name}”`, { description: "API key stored in your OS keychain." });
      }
    } catch (e) {
      toast.error("Couldn't add account", { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Add account"
        description="Each account gets its own isolated profile, so you can stay signed in to several at once."
        className="w-[min(520px,calc(100vw-32px))]"
      >
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <DialogBody className="space-y-5">
            <div>
              <Label>Provider</Label>
              <Segmented
                aria-label="Provider"
                className="w-full"
                value={provider}
                onChange={setProvider}
                options={PROVIDER_ORDER.map((p) => ({
                  value: p,
                  label: (
                    <>
                      <span style={{ color: PROVIDERS[p].colorVar }}>
                        <ProviderMark provider={p} size={14} />
                      </span>
                      {PROVIDERS[p].short}
                    </>
                  ),
                }))}
              />
            </div>

            <div>
              <Label htmlFor="add-acc-name">Name</Label>
              <Input
                id="add-acc-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={placeholder}
                maxLength={40}
                autoFocus
              />
            </div>

            <div>
              <Label>Color</Label>
              <ColorSwatches value={color} onChange={setColor} />
            </div>

            <div>
              <Label>Sign-in method</Label>
              <div
                className="grid grid-cols-2 gap-2"
                role="radiogroup"
                aria-label="Sign-in method"
                onKeyDown={onRadioGroupKeyDown}
              >
                <AuthOption
                  active={auth === "oauth"}
                  onClick={() => setAuth("oauth")}
                  icon={<LogIn />}
                  title="Subscription"
                  description={SUBSCRIPTION[provider]}
                />
                <AuthOption
                  active={auth === "api_key"}
                  onClick={() => setAuth("api_key")}
                  icon={<KeyRound />}
                  title="API key"
                  description="Billed per token"
                />
              </div>
            </div>

            {auth === "api_key" ? (
              <div>
                <Label htmlFor="add-acc-key">{KEY_HINT[provider].env}</Label>
                <div className="relative">
                  <Input
                    id="add-acc-key"
                    type={showKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={KEY_HINT[provider].placeholder}
                    autoComplete="off"
                    className="pr-10 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((s) => !s)}
                    aria-label={showKey ? "Hide key" : "Show key"}
                    className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-steel hover:bg-raised hover:text-fg"
                  >
                    {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <p className="mt-2 flex items-center gap-1.5 text-[11.5px] text-steel">
                  <ShieldCheck className="h-3.5 w-3.5 text-ok" />
                  Stored in your OS keychain, only injected into this account's agents.
                </p>
              </div>
            ) : (
              <p className="rounded-lg border border-line bg-base/50 px-3 py-2.5 text-[12px] leading-relaxed text-muted">
                After you click <span className="text-fg">Add & sign in</span>, {PROVIDERS[provider].tagline}'s own
                login runs in a terminal and opens your browser. Armada never sees your password or tokens.
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={!valid || busy}>
              {auth === "oauth" ? (
                <>
                  <LogIn /> Add & sign in
                </>
              ) : (
                "Add account"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AuthOption({
  active,
  onClick,
  icon,
  title,
  description,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      className={cn(
        "flex items-start gap-2.5 rounded-xl border p-3 text-left transition-[border-color,background-color,transform] duration-150 active:scale-[0.98] [&_svg]:mt-0.5 [&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0",
        active
          ? "border-accent/60 bg-accent/[0.07] shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_12%,transparent)] [&_svg]:text-accent"
          : "border-line bg-base/40 hover:border-line-strong [&_svg]:text-steel",
      )}
    >
      {icon}
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-fg">{title}</span>
        <span className="block text-[11.5px] text-muted">{description}</span>
      </span>
    </button>
  );
}
