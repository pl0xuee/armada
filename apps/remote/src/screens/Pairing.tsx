import { useEffect, useRef, useState, type ReactNode } from "react";
import { AppMark, Icon, type IconName } from "@/components/Icon";
import { Button } from "@/components/ui";
import { parsePasted } from "@/lib/auth";
import {
  pairWithCode,
  pairWithToken,
  retryConnect,
  unpair,
} from "@/lib/controller";
import { cn } from "@/lib/cn";
import { isIOS, isStandalone } from "@/lib/platform";
import { confirmAction } from "@/lib/confirm";
import { useStore } from "@/lib/store";

function Frame({ children }: { children: ReactNode }) {
  return (
    <main className="relative flex min-h-dvh flex-col items-center overflow-hidden px-safe pt-[calc(var(--safe-top)+44px)] pb-[calc(var(--safe-bottom)+28px)]">
      {/* Soft ice-blue glow behind the mark. */}
      <div
        className="pointer-events-none absolute -top-40 left-1/2 h-[420px] w-[620px] -translate-x-1/2 rounded-full opacity-60"
        style={{
          background:
            "radial-gradient(closest-side, color-mix(in srgb, var(--accent) 16%, transparent), transparent)",
        }}
        aria-hidden
      />
      <div className="animate-enter relative flex w-full max-w-[400px] flex-1 flex-col">
        {children}
      </div>
    </main>
  );
}

function Mark() {
  return (
    <span className="mx-auto inline-flex h-[72px] w-[72px] items-center justify-center rounded-[22px] border border-line-strong bg-gradient-to-b from-raised to-panel shadow-[0_20px_50px_-20px_color-mix(in_srgb,var(--accent)_55%,transparent)] edge-strong">
      <AppMark size={38} />
    </span>
  );
}

function Step({
  n,
  icon,
  children,
}: {
  n: number;
  icon: IconName;
  children: ReactNode;
}) {
  return (
    <li className="flex items-center gap-3.5 py-3">
      <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-line bg-raised text-accent edge">
        <Icon name={icon} size={20} />
      </span>
      <span className="min-w-0 flex-1 text-[15px] leading-snug text-fg">
        <span className="mr-1.5 text-steel tabular">{n}.</span>
        {children}
      </span>
    </li>
  );
}

function Callout({
  tone,
  icon,
  title,
  children,
}: {
  tone: "warn" | "err";
  icon: IconName;
  title: string;
  children?: ReactNode;
}) {
  const color = tone === "warn" ? "var(--warn)" : "var(--err)";
  return (
    <div
      role="alert"
      className="mt-6 flex items-start gap-3 rounded-2xl border p-3.5"
      style={{
        borderColor: `color-mix(in srgb, ${color} 35%, var(--border))`,
        background: `color-mix(in srgb, ${color} 8%, var(--bg-1))`,
      }}
    >
      <Icon name={icon} size={20} className="mt-px shrink-0" />
      <div className="min-w-0">
        <p className="text-[14.5px] font-semibold text-fg">{title}</p>
        {children && (
          <p className="mt-0.5 text-[13.5px] leading-snug text-muted">
            {children}
          </p>
        )}
      </div>
    </div>
  );
}

export function Pairing() {
  const reason = useStore((s) => s.unpairedReason);
  const standalone = isStandalone();
  const [pasteOpen, setPasteOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (pasteOpen) inputRef.current?.focus();
  }, [pasteOpen]);

  const submit = async () => {
    const parsed = parsePasted(value);
    if (parsed.kind === "invalid") {
      setError("That doesn't look like an Armada pairing link.");
      return;
    }
    setError(null);
    if (parsed.kind === "link") {
      // Only private/loopback addresses are followed silently; anything else could be a look-alike.
      if (!parsed.trusted) {
        const ok = await confirmAction({
          title: "Open a link to another address?",
          body: `${parsed.host} isn't a private network address. Only continue if it is your own computer, for example over Tailscale.`,
          confirmLabel: "Open link",
          destructive: true,
        });
        if (!ok) return;
      }
      location.assign(parsed.url);
    } else if (parsed.kind === "pair") void pairWithCode(parsed.code);
    else void pairWithToken(parsed.token);
  };

  return (
    <Frame>
      <Mark />
      <h1 className="mt-6 text-center text-[26px] leading-tight font-semibold tracking-[-0.02em] text-fg">
        Pair with Armada
      </h1>
      <p className="mx-auto mt-2 max-w-[330px] text-center text-[15px] leading-relaxed text-muted">
        Watch your agents, approve requests and send prompts from your phone.
      </p>

      {reason === "revoked" && (
        <Callout tone="warn" icon="unlink" title="This device was unpaired">
          Its access was revoked or expired. Scan a new QR code from Armada's
          Settings to reconnect.
        </Callout>
      )}
      {reason === "share_expired" && (
        <Callout
          tone="warn"
          icon="unlink"
          title="This share link is no longer valid"
        >
          This share link has expired or was turned off. Ask for a new link.
        </Callout>
      )}
      {reason === "invalid_link" && (
        <Callout
          tone="err"
          icon="alertCircle"
          title="That pairing link didn't work"
        >
          Pairing codes work once and expire after 5 minutes. Show a fresh QR
          code in Armada and scan it again.
        </Callout>
      )}

      <ol
        className="mt-7 divide-y divide-line/70 rounded-2xl border border-line bg-panel px-4 edge"
        aria-label="How to pair"
      >
        <Step n={1} icon="laptop">
          Open <span className="font-semibold">Armada</span> on your computer
        </Step>
        <Step n={2} icon="cog">
          Go to <span className="font-semibold">Settings</span>
          <Icon
            name="chevronRight"
            size={14}
            strokeWidth={2.4}
            className="mx-0.5 inline-block align-[-2px] text-steel"
          />
          <span className="font-semibold">Remote</span>
        </Step>
        <Step n={3} icon="qr">
          Scan the QR code with your phone's camera
        </Step>
      </ol>

      {standalone && (
        <Callout tone="warn" icon="info" title="Pair this Home Screen app">
          {isIOS()
            ? "On iPhone the Home Screen app keeps its own storage, separate from Safari. Copy the pairing link in Armada (Settings → Remote) and paste it below once."
            : "Copy the pairing link in Armada (Settings → Remote) and paste it below."}
        </Callout>
      )}

      <div className="mt-5">
        {pasteOpen || standalone ? (
          <form
            className="animate-fade space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <label
              htmlFor="pair-link"
              className="block text-[13px] font-medium text-muted"
            >
              Paste the pairing link
            </label>
            <input
              id="pair-link"
              ref={inputRef}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
              placeholder="http://192.168.1.20:47821/#pair=…"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={!!error}
              aria-describedby={error ? "pair-error" : undefined}
              className={cn(
                "block h-12 w-full rounded-xl border bg-card px-3.5 font-mono text-[16px] text-fg outline-none placeholder:text-steel focus:border-accent/60",
                error ? "border-err/60" : "border-line-strong",
              )}
            />
            {error && (
              <p id="pair-error" className="text-[13px] text-err">
                {error}
              </p>
            )}
            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="w-full"
              disabled={!value.trim()}
            >
              Connect
            </Button>
          </form>
        ) : (
          <Button
            variant="secondary"
            size="lg"
            icon="link"
            className="w-full"
            onClick={() => setPasteOpen(true)}
          >
            Paste a pairing link instead
          </Button>
        )}
      </div>

      <p className="mx-auto mt-auto max-w-[340px] pt-8 text-center text-[12.5px] leading-relaxed text-steel">
        <Icon
          name="shield"
          size={14}
          className="mr-1.5 inline-block align-[-2px]"
        />
        Pairing links work once and expire after 5 minutes. Only pair with a
        computer you own.
      </p>
    </Frame>
  );
}

/** Paired, but the server is unreachable / refusing us for now. */
export function Blocked() {
  const reason = useStore((s) => s.blockedReason);
  const message = useStore((s) => s.blockedMessage);
  const [retrying, setRetrying] = useState(false);

  // Keep trying quietly while the computer is asleep / the network is down.
  useEffect(() => {
    if (reason !== "unreachable" && reason !== "unavailable") return;
    const retry = () => {
      if (document.visibilityState === "visible") void retryConnect();
    };
    const id = setInterval(retry, 8_000);
    window.addEventListener("online", retry);
    document.addEventListener("visibilitychange", retry);
    return () => {
      clearInterval(id);
      window.removeEventListener("online", retry);
      document.removeEventListener("visibilitychange", retry);
    };
  }, [reason]);

  const rate = reason === "rate_limited";
  const unreachable = reason === "unreachable";
  const unavailable = reason === "unavailable";
  return (
    <Frame>
      <span
        className={cn(
          "mx-auto inline-flex h-[72px] w-[72px] items-center justify-center rounded-[22px] border edge-strong",
          rate
            ? "border-warn/30 bg-warn/10 text-warn"
            : unreachable
              ? "border-line-strong bg-raised text-steel"
              : "border-err/30 bg-err/10 text-err",
        )}
      >
        <Icon
          name={rate ? "clock" : unreachable ? "wifiOff" : "alertCircle"}
          size={32}
          strokeWidth={1.6}
        />
      </span>
      <h1 className="mt-6 text-center text-[24px] leading-tight font-semibold tracking-[-0.02em] text-fg">
        {rate
          ? "Too many attempts"
          : unreachable
            ? "Can't reach Armada"
            : unavailable
              ? "Remote access is off"
              : reason === "misdirected"
                ? "Use Armada's link"
                : "Something went wrong"}
      </h1>
      <p className="mx-auto mt-2 max-w-[330px] text-center text-[15px] leading-relaxed text-muted">
        {rate
          ? (message ?? "Try again in a few minutes.")
          : unreachable
            ? "Your phone couldn't connect to Armada on your computer."
            : unavailable
              ? `${message ?? "Armada isn't accepting connections."} Turn it on in Settings → Remote; this page reconnects by itself.`
              : message}
      </p>

      {unreachable && (
        <ul className="mt-7 space-y-3 rounded-2xl border border-line bg-panel p-4 text-[14px] text-fg edge">
          {[
            "Armada is open and your computer is awake",
            "Remote access is on in Settings → Remote",
            "Your phone is on the same network as your computer",
          ].map((t) => (
            <li key={t} className="flex items-start gap-2.5">
              <Icon
                name="check"
                size={17}
                className="mt-0.5 shrink-0 text-steel"
              />
              {t}
            </li>
          ))}
          <li className="flex items-start gap-2.5 border-t border-line/70 pt-3 text-muted">
            <Icon name="qr" size={17} className="mt-0.5 shrink-0 text-steel" />
            If your computer's network address changed (new Wi-Fi, router
            restart), scan the QR code in Armada again.
          </li>
        </ul>
      )}

      <div className="mt-7 space-y-2">
        <Button
          variant="primary"
          size="lg"
          icon="refresh"
          className="w-full"
          loading={retrying}
          onClick={async () => {
            setRetrying(true);
            await retryConnect();
            setRetrying(false);
          }}
        >
          Try again
        </Button>
        <Button
          variant="ghost"
          size="lg"
          className="w-full"
          onClick={async () => {
            const ok = await confirmAction({
              title: "Pair a different computer?",
              body: "This forgets the current pairing. You'll need to scan a QR code again.",
              confirmLabel: "Forget pairing",
              destructive: true,
            });
            if (ok) unpair();
          }}
        >
          Pair a different computer
        </Button>
      </div>
      {(unreachable || unavailable) && (
        <p className="mt-4 text-center text-[12.5px] text-steel">
          Retrying automatically…
        </p>
      )}
    </Frame>
  );
}

export function Boot() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 700);
    return () => clearTimeout(t);
  }, []);
  return (
    <main
      className="flex min-h-dvh flex-col items-center justify-center gap-5"
      aria-busy="true"
    >
      <span className="animate-breathe">
        <AppMark size={44} />
      </span>
      <p
        className={cn(
          "text-[14px] text-muted transition-opacity duration-200",
          slow ? "opacity-100" : "opacity-0",
        )}
        role="status"
      >
        Connecting to Armada…
      </p>
    </main>
  );
}
