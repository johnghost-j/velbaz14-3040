import { Plus } from "lucide-react";
import { useState } from "react";

const ITEMS = [
  {
    q: "Qu'est-ce que Velbaz, exactement ?",
    a: "Un seul endroit où vous décrivez une idée d'entreprise et obtenez la chose elle-même : marque, site, application, CRM, prospection et contenu — construits, connectés et opérationnels. Pas un chatbot qui vous refile une liste de tâches.",
  },
  {
    q: "Qu'est-ce que rejoindre la liste m'apporte ?",
    a: "Votre place dans la file. Quand Velbaz ouvre, les personnes sur cette liste reçoivent leur lien en premier, dans l'ordre d'inscription.",
  },
  {
    q: "Quand est-ce que ça ouvre ?",
    a: "Aucune date annoncée pour l'instant. La liste existe pour que vous l'appreniez de nous le premier jour, pas trois semaines trop tard.",
  },
  {
    q: "Est-ce que s'inscrire coûte quelque chose ?",
    a: "Non. L'inscription est gratuite, et il y aura un palier gratuit à l'ouverture, pour voir ce que fait Velbaz avant de payer quoi que ce soit.",
  },
  {
    q: "Qu'advient-il de mon adresse e-mail ?",
    a: "Elle est stockée pour vous envoyer votre lien, rien d'autre. Pas de revente, pas de partage, pas de liste de partenaires.",
  },
  {
    q: "Faut-il savoir coder ?",
    a: "Non. Tout est généré et modifiable en langage naturel. Si vous savez coder, vous pouvez aller plus loin — mais ce n'est jamais obligatoire.",
  },
] as const;

export function Faq() {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <div className="mx-auto w-full max-w-[680px] divide-y divide-wl-line border-y border-wl-line">
      {ITEMS.map((item, index) => {
        const isOpen = open === index;
        return (
          <div key={item.q}>
            <button
              type="button"
              onClick={() => setOpen(isOpen ? null : index)}
              aria-expanded={isOpen}
              className="flex w-full items-center justify-between gap-6 py-5 text-left transition-colors hover:text-wl-fg"
            >
              <span
                className={`text-[16.5px] transition-colors ${isOpen ? "text-wl-fg" : "text-wl-muted"}`}
              >
                {item.q}
              </span>
              <Plus
                className={`size-4 shrink-0 text-wl-subtle transition-transform duration-300 ${isOpen ? "rotate-45" : ""}`}
              />
            </button>
            <div
              className="grid transition-all duration-300 ease-out"
              style={{
                gridTemplateRows: isOpen ? "1fr" : "0fr",
                opacity: isOpen ? 1 : 0,
              }}
            >
              <div className="overflow-hidden">
                <p className="pb-6 pr-8 text-[15px] leading-relaxed text-wl-muted">{item.a}</p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
