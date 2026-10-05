import { ArrowRight, Check, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const STORAGE_KEY = "velbaz_waitlist_email";

type Result = { status: "joined" | "already"; position: number };

function getRef(): string | null {
  try {
    const url = new URL(window.location.href);
    return url.searchParams.get("ref") || url.searchParams.get("utm_source") || null;
  } catch {
    return null;
  }
}

export function WaitlistForm({ compact = false }: { compact?: boolean }) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [pending, setPending] = useState(false);
  const focusTracked = useRef(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as { email: string; position: number };
        if (parsed?.email) {
          setEmail(parsed.email);
          setResult({ status: "already", position: parsed.position });
        }
      }
    } catch {
      // ignore unreadable storage
    }
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = email.trim().toLowerCase();
    if (!EMAIL_RE.test(value)) {
      setError("Entrez une adresse e-mail valide.");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/waitlist/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: value, ref: getRef(), referrer: document.referrer || null }),
      });
      const data = await res.json();
      if (!res.ok || data.status === "error") {
        setError(data.error || "Une erreur est survenue. Réessayez dans un instant.");
        setPending(false);
        return;
      }
      setResult(data);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ email: value, position: data.position }));
      } catch {
        // ignore unwritable storage
      }
    } catch {
      setError("Une erreur est survenue. Réessayez dans un instant.");
    }
    setPending(false);
  };

  if (result) {
    return (
      <div
        className={`pop w-full ${compact ? "max-w-md" : "max-w-lg"} rounded-[20px] border border-wl-line bg-wl-surface/85 p-5 text-left shadow-[0_18px_50px_-30px_rgba(18,18,18,0.35)] backdrop-blur-md`}
      >
        <div className="flex items-start gap-3.5">
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-wl-fg">
            <Check className="size-3.5 text-wl-bg" strokeWidth={2.6} />
          </span>
          <div className="min-w-0">
            <p className="text-[15px] font-medium text-wl-fg">
              {result.status === "joined" ? "Vous êtes sur la liste." : "Vous êtes déjà sur la liste."}
            </p>
            <p className="label-mono mt-1.5 truncate">
              {email} · n° {result.position}
            </p>
            <p className="mt-3 text-[13.5px] leading-relaxed text-wl-muted">
              Vous recevrez un e-mail, une seule fois, le jour où Velbaz ouvre. Pas de newsletter, rien d'autre.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate className={`w-full ${compact ? "max-w-md" : "max-w-lg"}`}>
      <div
        className={`group flex items-center gap-1.5 rounded-full border bg-wl-surface/90 p-1.5 shadow-[0_14px_40px_-28px_rgba(18,18,18,0.45)] backdrop-blur-md transition-colors ${
          error ? "border-wl-danger/45" : "border-wl-line focus-within:border-wl-line-strong"
        }`}
      >
        <input
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          placeholder="vous@entreprise.com"
          aria-label="Adresse e-mail"
          value={email}
          disabled={pending}
          onFocus={() => {
            focusTracked.current = true;
          }}
          onChange={(event) => {
            setEmail(event.target.value);
            if (error) setError(null);
          }}
          className="min-w-0 flex-1 bg-transparent px-4 py-2 text-[15px] text-wl-fg outline-none placeholder:text-wl-subtle disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={pending}
          className="inline-flex shrink-0 items-center gap-2 rounded-full bg-wl-fg px-4 py-2.5 text-[14px] font-medium text-wl-bg transition-all hover:bg-[#2b2b2b] disabled:cursor-not-allowed disabled:opacity-70 sm:px-5"
        >
          {pending ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              <span className="hidden sm:inline">Inscription</span>
            </>
          ) : (
            <>
              <span>Rejoindre la liste</span>
              <ArrowRight className="size-4" />
            </>
          )}
        </button>
      </div>
      <p className={`mt-3 min-h-5 text-center text-[13px] ${error ? "text-wl-danger" : "text-wl-subtle"}`}>
        {error ?? "Gratuit. Un e-mail à l'ouverture — rien d'autre."}
      </p>
    </form>
  );
}
