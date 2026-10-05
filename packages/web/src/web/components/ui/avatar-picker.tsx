/**
 * Rond de profil cliquable : permet de choisir une photo depuis l'appareil.
 *
 * L'image est recadrée en carré et réduite à 256×256 dans le navigateur
 * (voir lib/avatar-file) avant l'envoi, pour ne jamais pousser un fichier
 * de 10 Mo dans la base.
 *
 * Priorité des sources (côté serveur) : photo envoyée ici > photo Google >
 * Gravatar détecté depuis l'e-mail > initiale du nom.
 */
import { useRef, useState } from 'react';
import { UserAvatar, type AvatarUser } from './user-avatar';
import { ACCEPTED_AVATAR_TYPES, checkAvatarFile, prepareAvatarFile } from '../../lib/avatar-file';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';

export function AvatarPicker({
  user,
  size = 56,
  ringColor = 'var(--surface-1)',
}: {
  user: AvatarUser | null | undefined;
  size?: number;
  ringColor?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const setAvatar = useAuth((s) => s.setAvatar);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const hasUpload = (user as any)?.avatarSource === 'upload';

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // permet de re-choisir le même fichier
    if (!file) return;

    setError('');
    const check = checkAvatarFile(file);
    if (!check.ok) { setError(check.error || 'Fichier refusé'); return; }

    setBusy(true);
    try {
      const prepared = await prepareAvatarFile(file);
      if (!prepared.ok || !prepared.dataUrl) {
        setError(prepared.error || "Impossible de lire l'image");
        return;
      }
      const res = await api.auth.uploadAvatar(prepared.dataUrl);
      if (res?.error) { setError(res.error); return; }
      setAvatar(res.avatarUrl ?? prepared.dataUrl, res.avatarSource ?? 'upload');
    } catch (err: any) {
      setError(err?.message || "L'envoi a échoué");
    } finally {
      setBusy(false);
    }
  }

  async function onRemove() {
    setError('');
    setBusy(true);
    try {
      const res = await api.auth.deleteAvatar();
      if (res?.error) { setError(res.error); return; }
      // Le serveur peut renvoyer une photo Google/Gravatar de repli.
      setAvatar(res?.avatarUrl ?? null, res?.avatarSource ?? null);
    } catch (err: any) {
      setError(err?.message || 'La suppression a échoué');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-4">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        title="Changer la photo de profil"
        className="relative group rounded-full shrink-0"
        style={{ lineHeight: 0, cursor: busy ? 'wait' : 'pointer' }}
      >
        <UserAvatar user={user} size={size} showVerified ringColor={ringColor} />
        {/* Voile « changer » au survol */}
        <span
          className="absolute inset-0 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ background: 'rgba(0,0,0,0.55)', color: '#fff', fontSize: Math.max(8, Math.round(size * 0.16)) }}
        >
          {busy ? '…' : 'Edit'}
        </span>
      </button>

      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors"
            style={{ border: '1px solid var(--border-default)', color: 'var(--text-muted)' }}
          >
            {busy ? 'Uploading…' : 'Upload photo'}
          </button>
          {hasUpload && (
            <button
              type="button"
              onClick={onRemove}
              disabled={busy}
              className="px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors"
              style={{ color: 'var(--text-dim)' }}
            >
              Remove
            </button>
          )}
        </div>
        <div className="text-[10px] mt-1.5" style={{ color: error ? 'var(--danger, #e5484d)' : 'var(--text-ghost)' }}>
          {error || 'PNG, JPG, WEBP or GIF — up to 12 MB'}
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_AVATAR_TYPES.join(',')}
        onChange={onPick}
        className="hidden"
      />
    </div>
  );
}
