/**
 * Rond de profil du compte.
 *
 * [2026-09-19] Avant, tous les ronds affichaient l'initiale du prénom. Ils
 * affichent maintenant la VRAIE photo du compte (envoyée par l'utilisateur,
 * photo Google, ou Gravatar détecté depuis l'e-mail), avec l'initiale en repli.
 *
 * Source unique : tout rond de profil de l'app passe par ce composant, pour
 * qu'une seule correction suffise partout.
 *
 * Usage :
 *   <UserAvatar user={user} size={26} />
 *   <UserAvatar user={user} size={56} ringColor="var(--surface-1)" showVerified />
 */
import { useEffect, useState } from 'react';
import { VerifiedBadge } from './verified-badge';
import { isAdminUser } from '../../lib/auth';

export interface AvatarUser {
  name?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  role?: string | null;
}

/** Initiales de repli : deux lettres si le nom complet est connu, sinon une. */
export function avatarInitials(user: AvatarUser | null | undefined): string {
  const src = (user?.name || '').trim() || (user?.email || '').trim();
  if (!src) return 'U';
  const parts = src.replace(/@.*$/, '').split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0]?.[0] || 'U').toUpperCase();
}

export function UserAvatar({
  user,
  size = 32,
  className = '',
  showVerified = false,
  ringColor = 'var(--surface-1)',
  badgeSize,
}: {
  user: AvatarUser | null | undefined;
  size?: number;
  className?: string;
  /** Affiche la pastille « Verified » si le compte est admin. */
  showVerified?: boolean;
  /** Couleur du fond derrière la pastille (doit matcher le conteneur). */
  ringColor?: string;
  badgeSize?: number;
}) {
  const url = user?.avatarUrl || '';
  // Une URL distante peut tomber (photo Google supprimée, Gravatar indisponible) :
  // dans ce cas on repasse à l'initiale au lieu d'afficher un carré cassé.
  const [broken, setBroken] = useState(false);
  useEffect(() => { setBroken(false); }, [url]);

  const showPhoto = !!url && !broken;
  const circle = (
    <div
      className="rounded-full overflow-hidden flex items-center justify-center shrink-0 font-semibold"
      style={{
        width: size,
        height: size,
        // Pas de fond teal derrière une photo : il déborderait en liseré.
        background: showPhoto ? 'var(--surface-3)' : 'var(--teal)',
        color: 'var(--text-inverse)',
        fontSize: Math.max(9, Math.round(size * 0.42)),
        lineHeight: 1,
      }}
    >
      {showPhoto ? (
        <img
          src={url}
          alt={user?.name || 'Photo de profil'}
          width={size}
          height={size}
          className="w-full h-full object-cover"
          referrerPolicy="no-referrer"   // requis par lh3.googleusercontent.com
          loading="lazy"
          decoding="async"
          onError={() => setBroken(true)}
          draggable={false}
        />
      ) : (
        avatarInitials(user)
      )}
    </div>
  );

  if (!showVerified) return <div className={`relative shrink-0 ${className}`}>{circle}</div>;

  return (
    <div className={`relative shrink-0 ${className}`}>
      {circle}
      {isAdminUser(user as any) && (
        <span style={{ position: 'absolute', top: -3, right: -3, lineHeight: 0 }}>
          <VerifiedBadge size={badgeSize ?? Math.max(12, Math.round(size * 0.36))} ringColor={ringColor} />
        </span>
      )}
    </div>
  );
}
