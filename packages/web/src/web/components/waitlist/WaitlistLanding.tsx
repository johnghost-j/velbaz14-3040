/**
 * Real waitlist landing page, shown by <LaunchGate> whenever the gate is
 * closed. Ported from the standalone "Velbaz Waitlist" Runable project so
 * velbaz.com only ever needs to be ONE domain/project — this renders locally
 * instead of living on a separate deploy. Signups are stored in THIS
 * project's own DB (`waitlist_signups` table), never forwarded anywhere else.
 *
 * Scoped entirely under the `.velbaz-waitlist-landing` CSS class (see
 * styles.css) so its own `--wl-*` design tokens never touch the main app's
 * design system.
 */
import { Boxes, Globe, LineChart, Mic, Paperclip, Plus, Users } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { AnimatedCounter } from "../AnimatedCounter";
import { Faq } from "./Faq";
import { Tilt } from "./Tilt";
import { TypingText } from "./TypingText";
import { WaitlistForm } from "./WaitlistForm";
import { WaitlistLogo } from "./WaitlistLogo";
import { useReveal } from "../../hooks/waitlist/useReveal";

const CAPABILITIES = [
  {
    icon: Globe,
    eyebrow: "Velbaz construit",
    title: "Votre site et votre app, faits",
    body: "Décrivez l'activité une fois. Velbaz génère la marque, les pages, les textes et une application fonctionnelle autour — puis continue de les modifier en langage naturel.",
    mesh: "mesh-warm",
  },
  {
    icon: Users,
    eyebrow: "Velbaz vend",
    title: "Un pipeline qui se remplit seul",
    body: "CRM intégré, capture de leads et séquences de prospection qui s'écrivent et s'envoient elles-mêmes, puis rapportent ce qui a marché.",
    mesh: "mesh-cool",
  },
  {
    icon: LineChart,
    eyebrow: "Velbaz fait grandir",
    title: "Marketing en pilote automatique",
    body: "Posts, publicités et e-mails produits selon un calendrier, mesurés, puis réécrits selon ce qui convertit vraiment.",
    mesh: "mesh-sun",
  },
  {
    icon: Boxes,
    eyebrow: "Velbaz fait tourner",
    title: "Un opérateur, plusieurs agents",
    body: "Un essaim d'agents gère les tâches en parallèle — design, contenu, support, admin — pendant que vous restez le seul décisionnaire.",
    mesh: "mesh-warm",
  },
] as const;

const STEPS = [
  {
    title: "Dites ce que vous voulez construire",
    body: "Une ou deux phrases. La voix fonctionne aussi. Velbaz demande ce qui lui manque plutôt que de deviner.",
  },
  {
    title: "Il construit l'entreprise",
    body: "Nom, identité, site, app, tarifs, pages légales, CRM et premières campagnes — assemblés ensemble, pas comme des fichiers séparés.",
  },
  {
    title: "Vous validez, il lance",
    body: "Modifiez tout en le demandant. Publiez sur votre propre domaine en un clic et regardez les premiers vrais visiteurs arriver.",
  },
  {
    title: "Il continue de le faire tourner",
    body: "Leads répondus, contenu publié, chiffres rapportés. Vous pilotez ; les agents font les heures.",
  },
] as const;

const PROMPTS = [
  "Un abonnement de café de spécialité, à Bruxelles",
  "Un site de réservation pour une société de déménagement",
  "Une newsletter de niche sur le design industriel, avec des paliers payants",
  "Un club de padel avec adhésions et réservation de terrain",
];

function Reveal({ children, delay = 0, className = "" }: { children: ReactNode; delay?: number; className?: string }) {
  const { ref, shown } = useReveal<HTMLDivElement>();
  return (
    <div ref={ref} className={`reveal ${shown ? "is-in" : ""} ${className}`} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

function PromptMock({ live = false }: { live?: boolean }) {
  return (
    <div className="w-full rounded-[18px] border border-wl-line bg-wl-surface/95 p-4 text-left shadow-[0_28px_70px_-40px_rgba(18,18,18,0.5)] backdrop-blur-md sm:p-5">
      <div className="flex items-center gap-2">
        <span className="size-2 rounded-full bg-[#ff5f57]" />
        <span className="size-2 rounded-full bg-[#febc2e]" />
        <span className="size-2 rounded-full bg-[#28c840]" />
        <WaitlistLogo className="ml-2 h-[13px] w-4 text-wl-fg/70" />
        <span className="label-mono">velbaz — nouvelle entreprise</span>
      </div>
      <div className="mt-4 min-h-[52px] text-[15px] leading-relaxed text-wl-fg sm:text-[16px]">
        {live ? (
          <TypingText phrases={PROMPTS} />
        ) : (
          <>
            {PROMPTS[0]}
            <span className="caret ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[3px] bg-wl-fg" />
          </>
        )}
      </div>
      <div className="mt-4 flex items-center justify-between border-t border-wl-line pt-3">
        <Paperclip className="size-4 text-wl-subtle transition-transform duration-300 hover:-rotate-12" />
        <div className="flex items-center gap-2">
          {/* [2026-10-03] Plus de pastille « Velbaz Lite » : les comptes
              normaux n'ont qu'un modèle (Velbaz), aucun sélecteur. */}
          <span className="rounded-full border border-wl-line bg-wl-raised px-3 py-1 text-[12px] text-wl-muted transition-colors hover:text-wl-fg">
            Plan
          </span>
          <span className="group flex size-7 items-center justify-center rounded-full bg-wl-fg transition-transform duration-300 hover:scale-110">
            <Mic className="size-3.5 text-wl-bg" />
          </span>
        </div>
      </div>
    </div>
  );
}

export function WaitlistLanding() {
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [progress, setProgress] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/waitlist/stats")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) {
          setTotal(Number(data?.count) || 0);
          setLoaded(true);
        }
      })
      .catch(() => setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // `.velbaz-waitlist-landing` is itself `position: fixed` + `overflow-y:
    // auto` (it's the gate overlay covering the whole app), so it — not
    // `window` — is what actually scrolls. Track scroll on that element.
    const el = rootRef.current;
    if (!el) return;
    const onScroll = () => {
      const max = el.scrollHeight - el.clientHeight;
      setProgress(max > 0 ? Math.min(1, el.scrollTop / max) : 0);
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="velbaz-waitlist-landing" ref={rootRef}>
      <div className="relative min-h-dvh overflow-x-hidden bg-wl-bg">
        <div
          aria-hidden="true"
          className="fixed inset-x-0 top-0 z-[60] h-[2px] origin-left bg-gradient-to-r from-[#2b6cf6] via-[#ff7a4d] to-[#ff3f9a] transition-transform duration-150 ease-out"
          style={{ transform: `scaleX(${progress})` }}
        />

        {/* Kept OUTSIDE any `isolate` section: an isolated ancestor traps a
            fixed-position descendant inside its own stacking context, so
            later sections (painted after it in DOM order) end up covering
            it while scrolling. Living here, as a direct sibling of the
            scroll-progress bar, keeps it above everything at all times. */}
        <a
          href="/login"
          className="label-mono fixed right-4 top-4 z-[70] inline-flex items-center gap-1.5 rounded-full border border-wl-line bg-wl-surface/90 px-3 py-1.5 text-wl-fg shadow-[0_8px_24px_-12px_rgba(0,0,0,0.25)] backdrop-blur-md transition-all hover:border-wl-line-strong hover:bg-wl-surface hover:shadow-[0_10px_28px_-10px_rgba(0,0,0,0.32)] active:scale-[0.97] sm:right-6 sm:top-6 sm:px-4 sm:py-2"
        >
          Se connecter
        </a>

        {/* ---------- HERO ---------- */}
        <section className="relative isolate overflow-hidden px-6 pb-20 pt-8 sm:pb-28">
          <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
            <div className="bloom drift left-[-16%] top-[-20%] size-[44vw] bg-[#ffc98a] opacity-55" style={{ animationDelay: "0s" }} />
            <div className="bloom drift right-[-14%] top-[-12%] size-[40vw] bg-[#a9c6ff] opacity-50" style={{ animationDelay: "-4s" }} />
            <div className="bloom drift left-[8%] top-[46%] size-[34vw] bg-[#ffb6cf] opacity-38" style={{ animationDelay: "-9s" }} />
            <div className="bloom drift right-[6%] top-[52%] size-[30vw] bg-[#ffe98a] opacity-42" style={{ animationDelay: "-13s" }} />
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_58%_46%_at_50%_34%,#f9f8f6_0%,rgba(249,248,246,0.72)_46%,transparent_78%)]" />
            <div className="absolute inset-x-0 bottom-0 h-[42%] bg-gradient-to-b from-transparent to-wl-bg" />
          </div>

          <header className="rise relative mx-auto flex w-full max-w-[1120px] items-center justify-center pr-20 sm:pr-0">
            <div className="group inline-flex items-center gap-2">
              <WaitlistLogo reactive className="h-[26px] w-[32px] text-wl-fg transition-transform duration-300 group-hover:scale-[1.06]" />
              <span className="text-[19px] font-semibold tracking-[-0.03em] text-wl-fg">Velbaz</span>
            </div>
          </header>

          <div className="mx-auto mt-16 flex w-full max-w-[880px] flex-col items-center text-center sm:mt-24">
            <p className="rise label-mono inline-flex items-center gap-2" style={{ animationDelay: "60ms" }}>
              <span className="relative flex size-1.5">
                <span className="ping-soft absolute inset-0 rounded-full bg-wl-success" />
                <span className="relative size-1.5 rounded-full bg-wl-success" />
              </span>
              Liste d'attente — ouverte
            </p>

            <h1
              className="rise mt-5 select-none text-[clamp(2.6rem,7vw,4.5rem)] font-normal leading-[1.02] tracking-[-0.045em] text-wl-fg"
              style={{ animationDelay: "120ms" }}
            >
              Votre entreprise,
              <br />
              construite sous vos yeux
            </h1>
            <p className="rise mt-6 max-w-[38ch] text-[17px] leading-relaxed text-wl-muted sm:text-[18px]" style={{ animationDelay: "200ms" }}>
              Velbaz transforme une phrase en une entreprise qui fonctionne vraiment — site, app, CRM, prospection. Rejoignez la liste pour être averti le jour de l'ouverture.
            </p>

            <div className="rise mt-10 flex w-full flex-col items-center" style={{ animationDelay: "280ms" }}>
              <WaitlistForm />
            </div>

            {loaded && total > 0 && (
              <p className="pop mt-2 text-[13px] text-wl-subtle">
                <AnimatedCounter value={total} fontSize={13} className="text-wl-fg" />
                <span className="ml-1.5">déjà sur la liste</span>
              </p>
            )}
          </div>

          <div className="rise mx-auto mt-16 w-full max-w-[720px] sm:mt-20" style={{ animationDelay: "380ms" }}>
            <Tilt className="float-soft" max={5}>
              <div className="tilt-sheen relative rounded-[18px]">
                <PromptMock live />
              </div>
            </Tilt>
          </div>
        </section>

        {/* ---------- CE QUE FAIT VELBAZ ---------- */}
        <section className="px-6 pb-8 pt-16 sm:pt-24">
          <div className="mx-auto w-full max-w-[1120px]">
            <Reveal className="flex flex-col items-center text-center">
              <p className="label-mono">Ce que vous attendez</p>
              <h2 className="mt-4 text-[clamp(1.9rem,4.4vw,3rem)] font-normal leading-[1.08] tracking-[-0.035em] text-wl-fg">
                Quatre métiers, un opérateur
              </h2>
              <p className="mt-4 max-w-[44ch] text-[16.5px] leading-relaxed text-wl-muted">
                Pas un chatbot qui vous donne une liste de tâches. Le travail lui-même, fait et connecté.
              </p>
            </Reveal>

            <div className="mt-14 grid gap-6 sm:grid-cols-2">
              {CAPABILITIES.map((item, index) => (
                <Reveal key={item.title} delay={index * 90}>
                  <Tilt className="h-full" max={5}>
                    <article className={`${item.mesh} tilt-sheen relative h-full overflow-hidden rounded-[26px] p-[6px]`}>
                      <div className="h-full rounded-[21px] bg-wl-surface/92 p-6 backdrop-blur-sm sm:p-7">
                        <div className="flex items-center gap-2.5">
                          <item.icon className="size-[17px] text-wl-fg" strokeWidth={1.6} />
                          <span className="label-mono">{item.eyebrow}</span>
                        </div>
                        <h3 className="mt-5 text-[21px] font-normal leading-snug tracking-[-0.025em] text-wl-fg">{item.title}</h3>
                        <p className="mt-2.5 text-[14.5px] leading-relaxed text-wl-muted">{item.body}</p>
                      </div>
                    </article>
                  </Tilt>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ---------- COMMENT ÇA MARCHE ---------- */}
        <section className="px-6 pt-20 sm:pt-28">
          <div className="mx-auto w-full max-w-[1120px]">
            <Reveal className="flex flex-col items-center text-center">
              <p className="label-mono">Un premier aperçu</p>
              <h2 className="mt-4 text-[clamp(1.9rem,4.4vw,3rem)] font-normal leading-[1.08] tracking-[-0.035em] text-wl-fg">
                D'une phrase à une entreprise
              </h2>
              <p className="mt-4 max-w-[42ch] text-[16.5px] leading-relaxed text-wl-muted">
                C'est l'écran que la liste voit en premier — une seule case, et Velbaz s'occupe du reste.
              </p>
            </Reveal>

            <Reveal delay={120}>
              <div className="mesh-cool mt-14 overflow-hidden rounded-[30px] p-6 sm:p-12">
                <div className="mx-auto w-full max-w-[640px]">
                  <PromptMock live />
                </div>
              </div>
            </Reveal>

            <ol className="mt-12 grid gap-x-10 gap-y-9 sm:grid-cols-2 lg:grid-cols-4">
              {STEPS.map((step, index) => (
                <Reveal key={step.title} delay={index * 80}>
                  <li className="group list-none">
                    <span className="label-mono transition-colors group-hover:!text-wl-fg">
                      Étape {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="mt-3 block h-px w-full origin-left scale-x-[0.35] bg-wl-line-strong transition-transform duration-500 group-hover:scale-x-100" />
                    <h3 className="mt-3 text-[17px] font-medium leading-snug tracking-[-0.015em] text-wl-fg">{step.title}</h3>
                    <p className="mt-2 text-[14.5px] leading-relaxed text-wl-muted">{step.body}</p>
                  </li>
                </Reveal>
              ))}
            </ol>
          </div>
        </section>

        {/* ---------- FAQ ---------- */}
        <section className="px-6 pt-24 sm:pt-32">
          <div className="mx-auto w-full max-w-[1120px]">
            <Reveal className="flex flex-col items-center text-center">
              <p className="label-mono">Questions</p>
              <h2 className="mt-4 text-[clamp(1.9rem,4.4vw,3rem)] font-normal leading-[1.08] tracking-[-0.035em] text-wl-fg">
                Avant de rejoindre
              </h2>
            </Reveal>
            <Reveal delay={100} className="mt-12">
              <Faq />
            </Reveal>
          </div>
        </section>

        {/* ---------- CTA DE CLÔTURE ---------- */}
        <section className="relative isolate overflow-hidden px-6 pb-16 pt-28 sm:pt-36">
          <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
            <div className="bloom drift left-[2%] top-[6%] size-[32vw] bg-[#ffc98a] opacity-45" />
            <div className="bloom drift right-[0%] top-[0%] size-[30vw] bg-[#a9c6ff] opacity-40" style={{ animationDelay: "-7s" }} />
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_54%_50%_at_50%_42%,#f9f8f6_0%,rgba(249,248,246,0.6)_50%,transparent_80%)]" />
            <div className="absolute inset-x-0 bottom-0 h-[45%] bg-gradient-to-b from-transparent to-wl-bg" />
            <div className="absolute inset-x-0 top-0 h-[22%] bg-gradient-to-t from-transparent to-wl-bg" />
          </div>
          <Reveal className="mx-auto flex w-full max-w-[1120px] flex-col items-center text-center">
            <h2 className="max-w-[20ch] text-[clamp(2.1rem,5.2vw,3.4rem)] font-normal leading-[1.04] tracking-[-0.04em] text-wl-fg">
              Prenez votre place avant l'ouverture
            </h2>
            <div className="mt-9 flex w-full justify-center">
              <WaitlistForm compact />
            </div>
            {loaded && total > 0 && (
              <p className="mt-1 text-[13px] text-wl-subtle">
                <AnimatedCounter value={total} fontSize={13} className="text-wl-fg" />
                <span className="ml-1.5">déjà sur la liste</span>
              </p>
            )}
          </Reveal>
        </section>

        {/* ---------- FOOTER ---------- */}
        <footer className="relative overflow-hidden px-6 pt-16">
          <div className="mx-auto w-full max-w-[1120px]">
            <div className="flex flex-col items-center gap-1 text-center">
              <p className="label-mono">Conçu et construit par</p>
              <div className="mt-3 flex items-center justify-center gap-2.5">
                <WaitlistLogo className="h-[22px] w-[27px] text-wl-fg" />
                <p className="label-mono !text-wl-fg">Velbaz</p>
              </div>
            </div>

            <nav className="mt-8 flex flex-wrap items-center justify-center gap-x-7 gap-y-3">
              <a href="/legal/terms" className="wipe-link label-mono inline-flex items-center gap-1 transition-colors hover:!text-wl-fg">
                Conditions
              </a>
              <a href="/legal/privacy" className="wipe-link label-mono inline-flex items-center gap-1 transition-colors hover:!text-wl-fg">
                Confidentialité
              </a>
              <a href="/legal/cookies" className="wipe-link label-mono inline-flex items-center gap-1 transition-colors hover:!text-wl-fg">
                Cookies
              </a>
              <a href="/legal/refund" className="wipe-link label-mono inline-flex items-center gap-1 transition-colors hover:!text-wl-fg">
                Remboursements
              </a>
              <a href="/legal/acceptable-use" className="wipe-link label-mono inline-flex items-center gap-1 transition-colors hover:!text-wl-fg">
                Utilisation acceptable
              </a>
              <a href="/legal/legal-notice" className="wipe-link label-mono inline-flex items-center gap-1 transition-colors hover:!text-wl-fg">
                Mentions légales
              </a>
            </nav>

            <div className="mt-10 flex items-center justify-between border-t border-wl-line pt-6">
              <span className="label-mono">© {new Date().getFullYear()} Velbaz</span>
              <span className="label-mono group inline-flex items-center gap-1.5" title="Pas de date de lancement. Juste une liste, et vous dessus.">
                <Plus className="size-3 transition-transform duration-500 group-hover:rotate-90" />
                <span className="group-hover:hidden">Liste d'attente ouverte</span>
                <span className="hidden group-hover:inline">Pas encore de date. Honnête.</span>
              </span>
            </div>
          </div>

          <div className="rainbow-steps pointer-events-none mx-auto mt-10 h-[150px] w-full max-w-[1400px] sm:h-[210px]" aria-hidden="true" />
        </footer>
      </div>
    </div>
  );
}
