import { Download, Plus, RefreshCw, ShieldCheck, UserPlus, Users } from "lucide-react";
import { useState } from "react";
import { AccountRow } from "@/components/accounts/AccountRow";
import { AddAccountDialog } from "@/components/accounts/AddAccountDialog";
import { ProviderGlyph } from "@/components/ProviderGlyph";
import { providerReady } from "@/components/settings/ProviderCard";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/misc";
import { toast } from "sonner";
import { startInstall } from "@/lib/actions";
import { api } from "@/lib/api";
import { HeaderAction, PageHeader } from "@/components/PageHeader";
import { PROVIDER_ORDER, PROVIDERS, type BuiltinProvider } from "@/lib/providers";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";

export function AccountsView() {
  const accounts = useApp((s) => s.accounts);
  const providers = useApp((s) => s.providers);
  const [addFor, setAddFor] = useState<BuiltinProvider | null>(null);
  const [checkingAll, setCheckingAll] = useState(false);

  const signedIn = accounts.filter((a) => a.status?.loggedIn).length;

  /** Check every account and report once (not one toast per account). */
  const checkAll = async () => {
    setCheckingAll(true);
    const results = await Promise.allSettled(accounts.map((a) => api.checkAccount(a.id)));
    setCheckingAll(false);
    const signedIn: string[] = [];
    const signedOut: string[] = [];
    const failed: string[] = [];
    results.forEach((r, i) => {
      const label = `${PROVIDERS[accounts[i].provider].short} · ${accounts[i].name}`;
      if (r.status === "rejected") return void failed.push(label);
      useApp.getState().upsertAccount(r.value);
      (r.value.status?.loggedIn ? signedIn : signedOut).push(label);
    });
    const parts = [
      signedOut.length ? `Needs sign-in: ${signedOut.join(", ")}` : null,
      failed.length ? `Couldn't check: ${failed.join(", ")}` : null,
    ].filter(Boolean);
    const title = `${signedIn.length} of ${accounts.length} signed in`;
    if (signedOut.length || failed.length) toast.warning(title, { description: parts.join(" · ") });
    else toast.success(`All ${accounts.length} accounts are signed in`);
  };

  return (
    <div className="@container flex h-full flex-col">
      <PageHeader
        icon={<Users />}
        title="Accounts"
        subtitle={
          <>
            <span className="tabular text-fg">{signedIn}</span> of <span className="tabular">{accounts.length}</span>{" "}
            accounts signed in · every account runs in its own isolated profile
          </>
        }
        right={
          <>
            <HeaderAction
              variant="ghost"
              icon={<RefreshCw className={cn(checkingAll && "animate-spin")} />}
              label="Check all"
              onClick={() => void checkAll()}
              disabled={checkingAll || accounts.length === 0}
            />
            <HeaderAction
              variant="primary"
              icon={<UserPlus />}
              label="Add account"
              onClick={() => setAddFor("claude")}
            />
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[880px] px-4 pb-10 pt-4 @2xl:px-6 @2xl:pb-16 @2xl:pt-6">
          <div className="space-y-4 @2xl:space-y-5">
            {PROVIDER_ORDER.map((p) => {
              const meta = PROVIDERS[p];
              // Local models run through the Codex CLI, so its install state is theirs.
              const info = providers.find((x) => x.provider === (p === "local" ? "codex" : p));
              const list = accounts
                .filter((a) => a.provider === p)
                .sort((a, b) => Number(b.isSystem) - Number(a.isSystem) || a.createdAt - b.createdAt);
              const ready = info ? providerReady(info) : false;
              return (
                <section
                  key={p}
                  className="relative overflow-hidden rounded-2xl border border-line bg-card edge"
                  aria-label={meta.name}
                >
                  <div
                    className="pointer-events-none absolute inset-x-0 top-0 h-px"
                    style={{
                      background: `linear-gradient(90deg, transparent, color-mix(in srgb, ${meta.colorVar} 55%, transparent), transparent)`,
                    }}
                    aria-hidden
                  />
                  <div
                    className="pointer-events-none absolute -right-20 -top-24 h-56 w-56 rounded-full opacity-[0.06] blur-3xl"
                    style={{ background: meta.colorVar }}
                    aria-hidden
                  />
                  <div className="relative flex items-center gap-3 border-b border-line px-4 py-3.5">
                    <ProviderGlyph provider={p} size="md" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h2 className="text-[14px] font-semibold tracking-tight">{meta.name}</h2>
                        <span className="text-[12px] text-steel">{meta.vendor}</span>
                      </div>
                      <p className="text-[12px] text-muted">
                        {p === "local"
                          ? info?.installed
                            ? "Ollama, LM Studio, llama.cpp or any OpenAI-compatible server · runs through the Codex CLI"
                            : "Runs through the Codex CLI, which is not installed"
                          : info?.installed
                            ? `${meta.tagline}${info.version ? ` v${info.version}` : ""}${
                                info.adapterRequired && !info.adapterInstalled ? " · ACP adapter needs an update" : ""
                              }`
                            : `${meta.tagline} is not installed`}
                      </p>
                    </div>
                    {info && !ready ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void startInstall(p === "local" ? "codex" : p)}
                      >
                        <Download /> {info.installed ? "Update" : "Install"}
                      </Button>
                    ) : (
                      <Badge tone="ok">
                        <ShieldCheck /> Ready
                      </Badge>
                    )}
                  </div>

                  <div className="relative divide-y divide-line">
                    {list.map((a) => (
                      <AccountRow key={a.id} account={a} />
                    ))}
                    {list.length === 0 && (
                      <div className="px-4 py-6 text-center text-[13px] text-muted">
                        {p === "local"
                          ? "No local model servers yet. Add Ollama or LM Studio to run models on your own hardware."
                          : `No ${meta.short} accounts yet.`}
                      </div>
                    )}
                  </div>
                  <div className="relative border-t border-line bg-panel/40 px-2 py-1.5">
                    <Button size="sm" variant="ghost" onClick={() => setAddFor(p)}>
                      <Plus /> {p === "local" ? "Add local model server" : `Add ${meta.short} account`}
                    </Button>
                  </div>
                </section>
              );
            })}
          </div>

          <p className="mx-auto mt-6 max-w-[560px] text-center text-[12px] leading-relaxed text-steel">
            Armada drives each vendor's official CLI. Subscriptions sign in through the vendor's own browser flow; API
            keys live in your OS keychain.
          </p>
        </div>

        <AddAccountDialog
          open={addFor !== null}
          onOpenChange={(o) => !o && setAddFor(null)}
          defaultProvider={addFor ?? "claude"}
        />
      </div>
    </div>
  );
}
