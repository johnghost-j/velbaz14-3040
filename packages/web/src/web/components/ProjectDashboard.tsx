// ─── Dashboard du projet (bouton « Dashboard » de la barre du site) ──────────
//
// [2026-09-13] Demande de l'utilisateur : « je veux pas que la barre à droite
// choisisse si c'est Preview ou Code ; je veux que Preview, Code et le reste
// pour le site soient dans le Dashboard (le bouton Dashboard de la barre du
// site en haut, pas celui du chat). »
//
// Le bouton « Dashboard » de PreviewTopBar ouvre donc CE panneau, qui rassemble
// tout ce qui concerne le site :
//
//   ┌──────────────┬──────────────────────────────────────────┐
//   │ Aperçu       │                                          │
//   │ Code         │   contenu de la section choisie          │
//   │ Commandes    │                                          │
//   │ Appareil     │                                          │
//   │ Équipe       │                                          │
//   └──────────────┴──────────────────────────────────────────┘
//
// « Aperçu » n'est pas une section : il RESSORT du dashboard et rend la main à
// l'aperçu du site (c'est l'autre moitié du sélecteur Preview/Dashboard de la
// barre du haut).
//
// La colonne de navigation vit DANS la zone de contenu : ce n'est pas une
// deuxième barre d'outils. La barre du haut (PreviewTopBar) reste la seule
// barre, conformément à sa maquette.
//
// Le contenu de la section active est fourni par l'appelant (`children`) : les
// panneaux lourds (Code, Commandes) ne sont ainsi montés que quand on les
// regarde vraiment.

import type { ReactNode } from 'react';

export type DashSection = 'code' | 'orders' | 'devices' | 'team';

function IconEye() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 12s3.6-6.5 9.5-6.5S21.5 12 21.5 12s-3.6 6.5-9.5 6.5S2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="2.6" />
    </svg>
  );
}
function IconCode() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
    </svg>
  );
}
function IconBag() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 8h15l-1.2 11a2 2 0 0 1-2 1.8H7.7a2 2 0 0 1-2-1.8L4.5 8Z" /><path d="M9 8V6a3 3 0 0 1 6 0v2" />
    </svg>
  );
}
function IconDevices() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="4.5" width="12" height="9.5" rx="1.8" /><path d="M6 18h5" /><rect x="16.5" y="9" width="5" height="10.5" rx="1.6" />
    </svg>
  );
}
export function IconSocial() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="18" cy="5.5" r="2.6" /><circle cx="6" cy="12" r="2.6" /><circle cx="18" cy="18.5" r="2.6" />
      <path d="M8.3 10.7 15.7 6.8M8.3 13.3l7.4 3.9" />
    </svg>
  );
}
function IconTeam() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="8.5" r="3.2" /><path d="M2.8 19.5a6.4 6.4 0 0 1 12.4 0" /><path d="M16.2 5.9a3.2 3.2 0 0 1 0 5.4M17.6 19.5a6.5 6.5 0 0 0-1.4-4" />
    </svg>
  );
}

export default function ProjectDashboard({
  section,
  onSection,
  onPreview,
  onSocial,
  showDevices,
  showOrders,
  isMobile,
  children,
}: {
  section: DashSection;
  onSection: (s: DashSection) => void;
  /** Ressort du dashboard vers l'aperçu du site. */
  onPreview: () => void;
  /**
   * [2026-09-16] Demande : « je veux que pour aller dans la page des
   * plateformes sociales depuis le dashboard et pas depuis un bouton next ».
   * L'ancien bouton flottant « Next » est supprimé : c'est CETTE entrée du
   * dashboard qui ouvre les réseaux sociaux (comme « Aperçu », elle ressort
   * du dashboard, d'où la flèche).
   */
  onSocial?: () => void;
  /** Bascule Web/Téléphone : seulement pour un projet qui a les deux. */
  showDevices: boolean;
  /**
   * [2026-09-25] « Commandes » n'existe que si le site propose vraiment
   * quelque chose de commandable/achetable, ou si une commande est déjà
   * tombée — et ça peut basculer à n'importe quel moment du projet (l'appelant
   * sonde /companies/:id/orders/availability, cf. lib/orders-availability).
   * Non fourni = comportement historique (onglet affiché).
   */
  showOrders?: boolean;
  /**
   * [2026-09-20] Demande : sur téléphone, pas de barre latérale gauche avec
   * les boutons — les boutons vont EN HAUT (Aperçu / Réseaux sociaux, ce qui
   * fait sortir du dashboard) ET EN BAS (Code / Commandes / Appareil / Équipe,
   * les sections, comme une barre d'onglets d'app mobile), le contenu prend
   * toute la place entre les deux.
   */
  isMobile?: boolean;
  children: ReactNode;
}) {
  const items: { id: DashSection; label: string; icon: ReactNode }[] = [
    { id: 'code', label: 'Code', icon: <IconCode /> },
    // Section ouverte = on la garde toujours listée (jamais un onglet retiré
    // sous les doigts de l'utilisateur pendant qu'il le consulte).
    ...(showOrders === false && section !== 'orders'
      ? []
      : [{ id: 'orders' as DashSection, label: 'Commandes', icon: <IconBag /> }]),
    // [2026-10-02] Plus d'onglet « Prix » : le prix parfait est appliqué
    // automatiquement côté serveur (api/smart-pricing-service.ts).
    ...(showDevices ? [{ id: 'devices' as DashSection, label: 'Appareil', icon: <IconDevices /> }] : []),
    { id: 'team', label: 'Équipe', icon: <IconTeam /> },
  ];

  if (isMobile) {
    return (
      <div className="pdash pdash-mobile">
        {/* [2026-09-20] Plus de barre du haut ici : le bouton « Réseaux
            sociaux » vit maintenant dans la barre du haut du rectangle
            (PreviewTopBar), juste à côté du segment Preview | Dashboard. */}
        <div className="pdash-body">{children}</div>
        <nav className="pdash-bottombar">
          {items.map(it => (
            <button
              key={it.id}
              type="button"
              className="pdash-item pdash-bottom-item"
              data-on={section === it.id}
              onClick={() => onSection(it.id)}
            >
              <span className="pdash-ico">{it.icon}</span>
              <span>{it.label}</span>
            </button>
          ))}
        </nav>
      </div>
    );
  }

  return (
    <div className="pdash">
      <nav className="pdash-nav">
        <button type="button" className="pdash-item" onClick={onPreview} title="Revenir à l'aperçu du site">
          <span className="pdash-ico"><IconEye /></span>
          <span>Aperçu</span>
          <svg className="pdash-out" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 6 15 12 9 18" />
          </svg>
        </button>
        <div className="pdash-sep" />
        {items.map(it => (
          <button
            key={it.id}
            type="button"
            className="pdash-item"
            data-on={section === it.id}
            onClick={() => onSection(it.id)}
          >
            <span className="pdash-ico">{it.icon}</span>
            <span>{it.label}</span>
          </button>
        ))}
        {onSocial && (
          <>
            <div className="pdash-sep" />
            <button
              type="button"
              className="pdash-item"
              onClick={onSocial}
              title="Connecter et gérer les réseaux sociaux du projet"
            >
              <span className="pdash-ico"><IconSocial /></span>
              <span>Réseaux sociaux</span>
              <svg className="pdash-out" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 6 15 12 9 18" />
              </svg>
            </button>
          </>
        )}
      </nav>
      <div className="pdash-body">{children}</div>
    </div>
  );
}

/** Carte d'une section légère du dashboard (Appareil, Équipe). */
export function DashCard({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="pdash-card">
      <div className="pdash-card-title">{title}</div>
      {hint && <div className="pdash-card-hint">{hint}</div>}
      <div style={{ marginTop: 12 }}>{children}</div>
    </div>
  );
}
