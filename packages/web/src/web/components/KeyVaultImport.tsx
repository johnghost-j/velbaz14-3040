/**
 * COFFRE DE CLÉS API — IMPORT PAR FICHIER UNIQUE
 * ----------------------------------------------
 * L'admin remplit UN seul fichier hors-ligne, le dépose ici, puis le supprime
 * de son ordinateur. Toutes les clés partent chiffrées (AES-256-GCM) en base.
 *
 * Ce que ce composant garantit côté navigateur :
 *   • le fichier est lu en mémoire (FileReader) et n'est jamais téléversé
 *     comme fichier : seul son texte part dans le corps de la requête HTTPS ;
 *   • le contenu est effacé de l'état React dès que l'import est terminé ;
 *   • la phrase de passe n'est jamais stockée (ni state persistant, ni
 *     localStorage, ni autocomplete) — elle est vidée après usage ;
 *   • aucune valeur n'est jamais réaffichée : le serveur ne renvoie que les
 *     4 derniers caractères de chaque clé.
 *
 * Deux modes de chiffrement, choisis par l'admin :
 *   • SERVEUR  — les clés se réarment automatiquement à chaque redémarrage.
 *   • SCELLÉ   — chiffré avec une phrase de passe qui n'est stockée NULLE PART.
 *                Personne (ni un accès base, ni un accès serveur, ni un
 *                développeur, ni une IA) ne peut relire les clés sans elle.
 *                Contrepartie : après un redémarrage, il faut « Déverrouiller »
 *                une fois. Phrase perdue = clés définitivement illisibles.
 */

import { useEffect, useRef, useState } from 'react';
import { getAuthToken } from '../lib/token';

const MONO = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace";

function vaultFetch(path: string, opts?: RequestInit) {
  const token = getAuthToken();
  return fetch(`/api/admin/vault${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...opts?.headers,
    },
  });
}

interface VaultStatus {
  sealedRows: number;
  serverRows: number;
  isUnlocked: boolean;
  unlockedAt: number | null;
  hasSealedBundle: boolean;
  envInjected: number;
  totalKnown: number;
}
interface KeyRow {
  name: string;
  group: 'secret' | 'env' | 'provider';
  isSet: boolean;
  last4: string | null;
  mode: 'server' | 'sealed' | null;
}
interface ImportResult {
  imported: Array<{ name: string; last4: string; target: string; mode: string }>;
  rejected: Array<{ name: string; reason: string }>;
  mode: string;
  needsRestartNote: boolean;
}
type CheckStatus = 'ok' | 'bad' | 'missing' | 'untestable' | 'error';
interface KeyCheck {
  name: string;
  label: string;
  status: CheckStatus;
  detail: string;
  live: boolean;
  last4: string | null;
  required: boolean;
}
interface VerifyReport {
  checkedAt: number;
  results: KeyCheck[];
  summary: Record<CheckStatus, number>;
}
type Scope = 'ok' | 'gateway' | 'hosting' | 'managed' | 'unknown';
interface Detected {
  name: string;
  last4: string;
  known: boolean;
  scope: Scope;
}
interface InspectReport {
  source: 'text' | 'pdf';
  pdfFields: number;
  detected: Detected[];
  hint: string | null;
  verify?: VerifyReport | null;
}

// Pourquoi une clé lue n'est pas prise : message court et actionnable.
const SCOPE_NOTE: Record<Scope, string> = {
  ok: '',
  gateway: 'clé IA — inutile, le gateway Runable s\'en charge',
  hosting: 'hébergement/domaine — inutile, Hostinger + Runable s\'en chargent',
  managed: 'gérée par Runable — ignorée',
  unknown: 'nom inconnu de Velbaz : vérifie l\'orthographe exacte',
};

// Couleur + pictogramme par statut de vérification.
const CHECK_UI: Record<CheckStatus, { color: string; icon: string; title: string }> = {
  ok: { color: '#52c41a', icon: '✔', title: 'VALIDES' },
  bad: { color: '#ff4d4f', icon: '✘', title: 'À CORRIGER' },
  error: { color: '#faad14', icon: '!', title: 'TEST IMPOSSIBLE' },
  missing: { color: '#595959', icon: '·', title: 'NON RENSEIGNÉES' },
  untestable: { color: '#40a9ff', icon: '?', title: 'NON TESTABLES' },
};

export default function KeyVaultImport({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [fileB64, setFileB64] = useState('');
  const [inspect, setInspect] = useState<InspectReport | null>(null);
  const [fileName, setFileName] = useState('');
  const [sealedMode, setSealedMode] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [passphrase2, setPassphrase2] = useState('');
  const [unlockPass, setUnlockPass] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err' | 'warn'; text: string } | null>(null);
  const [showKeys, setShowKeys] = useState(false);
  const [verify, setVerify] = useState<VerifyReport | null>(null);
  const [hideMissing, setHideMissing] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const r = await vaultFetch('');
      const data = await r.json();
      if (data?.error) { setMsg({ type: 'err', text: data.error }); return; }
      setStatus(data.status || null);
      setKeys(data.keys || []);
    } catch (e: any) {
      setMsg({ type: 'err', text: `Chargement impossible : ${e.message}` });
    }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  // ── Gabarit : téléchargé via fetch authentifié, puis Blob local ──
  const downloadTemplate = async () => {
    setBusy('template');
    try {
      const r = await vaultFetch('/template');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'VELBAZ-API-KEYS-A-REMPLIR.env';
      a.click();
      URL.revokeObjectURL(url);
      setMsg({ type: 'ok', text: 'Gabarit téléchargé. Remplis-le, reviens ici, dépose-le, puis supprime-le.' });
    } catch (e: any) {
      setMsg({ type: 'err', text: `Téléchargement impossible : ${e.message}` });
    }
    setBusy(null);
  };

  // Lit le fichier en BINAIRE : un PDF formulaire rempli n'est pas du texte,
  // le lire comme du texte donnait « aucune clé trouvée ». On détecte le PDF
  // et on l'envoie en base64 ; le serveur en extrait les champs remplis.
  const readFile = (f: File) => {
    if (f.size > 8_000_000) { setMsg({ type: 'err', text: 'Fichier trop volumineux (max 8 Mo).' }); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result as ArrayBuffer);
      const head = String.fromCharCode(...bytes.subarray(0, 8));
      setResult(null);
      setInspect(null);
      if (head.includes('%PDF')) {
        let bin = '';
        for (let i = 0; i < bytes.length; i += 8192) {
          bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
        }
        setFileB64(btoa(bin));
        setContent('');
        setFileName(f.name);
        setMsg({ type: 'warn', text: `${f.name} (PDF formulaire) chargé. Clique « Analyser » pour voir ce que le système a lu.` });
      } else {
        setFileB64('');
        setContent(new TextDecoder('utf-8').decode(bytes));
        setFileName(f.name);
        setMsg({ type: 'warn', text: `${f.name} chargé en mémoire. Rien n'est encore envoyé.` });
      }
    };
    reader.onerror = () => setMsg({ type: 'err', text: 'Lecture du fichier impossible.' });
    reader.readAsArrayBuffer(f);
  };

  /** Corps commun aux requêtes d'analyse et d'import. */
  const payloadBody = (extra: Record<string, unknown> = {}) =>
    JSON.stringify(fileB64 ? { fileB64, ...extra } : { content, ...extra });

  // ── Analyse : dit exactement ce que le système a trouvé, sans rien stocker ──
  const doInspect = async (withVerify: boolean) => {
    if (!content.trim() && !fileB64) { setMsg({ type: 'err', text: 'Dépose d\'abord un fichier.' }); return; }
    setBusy(withVerify ? 'inspect-verify' : 'inspect');
    setMsg({ type: 'warn', text: withVerify ? 'Lecture du fichier et test de chaque clé…' : 'Lecture du fichier…' });
    try {
      const r = await vaultFetch('/inspect', { method: 'POST', body: payloadBody(withVerify ? { verify: true } : {}) });
      const data = await r.json();
      if (data?.error) { setMsg({ type: 'err', text: data.error }); }
      else {
        setInspect(data as InspectReport);
        if (data.verify) setVerify(data.verify as VerifyReport);
        const n = (data.detected || []).length;
        const usable = (data.detected || []).filter((d: Detected) => d.known).length;
        setMsg(
          n === 0
            ? { type: 'err', text: `Aucune clé trouvée. ${data.hint || ''}` }
            : { type: 'ok', text: `${n} clé(s) lue(s) dans le fichier, dont ${usable} exploitable(s) par Velbaz.` },
        );
      }
    } catch (e: any) {
      setMsg({ type: 'err', text: `Analyse impossible : ${e.message}` });
    }
    setBusy(null);
  };

  const doImport = async () => {
    if (!content.trim() && !fileB64) { setMsg({ type: 'err', text: 'Aucun contenu à importer.' }); return; }
    if (sealedMode) {
      if (passphrase.length < 12) { setMsg({ type: 'err', text: 'Phrase de passe : 12 caractères minimum.' }); return; }
      if (passphrase !== passphrase2) { setMsg({ type: 'err', text: 'Les deux phrases de passe ne correspondent pas.' }); return; }
    }
    setBusy('import');
    setMsg(null);
    try {
      const r = await vaultFetch('/import', {
        method: 'POST',
        body: payloadBody(sealedMode ? { passphrase } : {}),
      });
      const data = await r.json();
      if (data?.error) {
        setMsg({ type: 'err', text: data.error });
      } else {
        setResult(data as ImportResult);
        if (!data.imported?.length) {
          // Cas « aucune clé trouvée » : on donne la cause exacte.
          setMsg({
            type: 'err',
            text: `Aucune clé importée. ${data.hint || ''}${
              data.source === 'pdf' ? ' (PDF reconnu)' : ''
            }`,
          });
        } else {
          setMsg({
            type: 'ok',
            text: `${data.imported.length} clé(s) importée(s) en mode ${data.mode === 'sealed' ? 'SCELLÉ' : 'SERVEUR'}${
              data.source === 'pdf' ? ' depuis le PDF' : ''
            }. Tu peux supprimer ton fichier.`,
          });
        }
        await load();
      }
    } catch (e: any) {
      setMsg({ type: 'err', text: `Import impossible : ${e.message}` });
    }
    // Purge immédiate du contenu sensible du state React.
    setContent('');
    setFileB64('');
    setFileName('');
    setPassphrase('');
    setPassphrase2('');
    if (fileRef.current) fileRef.current.value = '';
    setBusy(null);
  };

  // ── Vérification : chaque clé est testée auprès de son fournisseur ──
  const doVerify = async () => {
    setBusy('verify');
    setMsg({ type: 'warn', text: 'Test de chaque clé auprès de son fournisseur… (quelques secondes)' });
    try {
      const r = await vaultFetch('/verify', { method: 'POST', body: '{}' });
      const data = await r.json();
      if (data?.error) { setMsg({ type: 'err', text: data.error }); }
      else {
        setVerify(data as VerifyReport);
        const s = (data as VerifyReport).summary;
        setMsg({
          type: s.bad > 0 ? 'err' : 'ok',
          text: s.bad > 0
            ? `${s.bad} clé(s) à corriger, ${s.ok} valide(s). Détail ci-dessous.`
            : `Tout est bon : ${s.ok} clé(s) valide(s).`,
        });
      }
    } catch (e: any) {
      setMsg({ type: 'err', text: `Vérification impossible : ${e.message}` });
    }
    setBusy(null);
  };

  const doUnlock = async () => {
    if (!unlockPass) { setMsg({ type: 'err', text: 'Phrase de passe requise.' }); return; }
    setBusy('unlock');
    try {
      const r = await vaultFetch('/unlock', { method: 'POST', body: JSON.stringify({ passphrase: unlockPass }) });
      const data = await r.json();
      if (data?.error) setMsg({ type: 'err', text: data.error });
      else setMsg({ type: 'ok', text: `Coffre déverrouillé : ${data.restored} secret(s) + ${data.envRestored} variable(s) réarmés.` });
      await load();
    } catch (e: any) {
      setMsg({ type: 'err', text: `Déverrouillage impossible : ${e.message}` });
    }
    setUnlockPass('');
    setBusy(null);
  };

  const doLock = async () => {
    setBusy('lock');
    try {
      const r = await vaultFetch('/lock', { method: 'POST', body: '{}' });
      const data = await r.json();
      if (data?.error) setMsg({ type: 'err', text: data.error });
      else setMsg({ type: 'ok', text: `Verrouillé : ${data.cleared} valeur(s) purgée(s) de la mémoire.` });
      await load();
    } catch (e: any) {
      setMsg({ type: 'err', text: e.message });
    }
    setBusy(null);
  };

  const doWipe = async () => {
    const answer = window.prompt('Destruction DÉFINITIVE de toutes les clés du coffre.\nTape SUPPRIMER pour confirmer :');
    if (answer !== 'SUPPRIMER') { setMsg({ type: 'warn', text: 'Destruction annulée.' }); return; }
    setBusy('wipe');
    try {
      const r = await vaultFetch('/wipe', { method: 'POST', body: JSON.stringify({ confirm: 'SUPPRIMER' }) });
      const data = await r.json();
      if (data?.error) setMsg({ type: 'err', text: data.error });
      else setMsg({ type: 'ok', text: `${data.removed} entrée(s) détruite(s) définitivement.` });
      setResult(null);
      await load();
    } catch (e: any) {
      setMsg({ type: 'err', text: e.message });
    }
    setBusy(null);
  };

  // ── Styles (calqués sur le panneau clés existant) ──
  const input: React.CSSProperties = {
    width: '100%', background: '#0d0d14', border: '1px solid #222', borderRadius: 6,
    padding: '8px 10px', color: '#ddd', fontFamily: MONO, fontSize: 12, outline: 'none',
  };
  const card: React.CSSProperties = {
    padding: 12, background: '#0d0d14', border: '1px solid #16162a', borderRadius: 8, marginBottom: 14,
  };
  const sectionTitle: React.CSSProperties = {
    color: '#8c8c8c', fontSize: 11, fontFamily: MONO, margin: '18px 0 8px', letterSpacing: 1,
  };
  const btn = (color: string): React.CSSProperties => ({
    background: '#111', border: '1px solid #333', color, borderRadius: 6,
    padding: '6px 12px', fontSize: 11, cursor: 'pointer', fontFamily: MONO,
  });

  const setCount = keys.filter((k) => k.isSet).length;

  return (
    <div onClick={(e) => e.stopPropagation()} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)', zIndex: 10000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div style={{
        width: 'min(740px, 96vw)', maxHeight: '92vh', overflow: 'auto',
        background: '#0a0a10', border: '1px solid #1a1a2e', borderRadius: 12,
        boxShadow: '0 20px 60px rgba(0,0,0,0.6)', padding: 22,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <h2 style={{ margin: 0, color: '#b37feb', fontSize: 16, fontFamily: MONO }}>📦 Coffre de clés — Import par fichier</h2>
          <button onClick={onClose} style={{ ...btn('#888'), border: '1px solid #333', fontSize: 14, padding: '4px 10px' }}>✕</button>
        </div>
        <p style={{ color: '#666', fontSize: 11, margin: '0 0 14px', fontFamily: MONO, lineHeight: 1.6 }}>
          Un seul fichier à remplir. Le contenu n'est jamais écrit sur le disque du serveur, jamais journalisé,
          et aucune interface ne pourra le relire ensuite. Supprime ton fichier juste après l'import.
          <br />
          <span style={{ color: '#52c41a' }}>
            Rien à fournir pour l'IA (gateway Runable) ni pour l'hébergement et les domaines
            (Cloudflare, Namecheap, jetons de déploiement) : Hostinger + Runable s'en occupent.
          </span>
        </p>

        {loading ? (
          <div style={{ color: '#888', fontFamily: MONO, padding: 20 }}>Chargement…</div>
        ) : (
          <>
            {/* ── État du coffre ── */}
            <div style={{ ...card, display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center' }}>
              <div style={{ fontFamily: MONO, fontSize: 11, color: '#aaa' }}>
                <div style={{ color: '#666', fontSize: 10 }}>CLÉS RENSEIGNÉES</div>
                <div style={{ color: '#52c41a', fontSize: 16 }}>{setCount} <span style={{ color: '#444', fontSize: 11 }}>/ {keys.length}</span></div>
              </div>
              <div style={{ fontFamily: MONO, fontSize: 11, color: '#aaa' }}>
                <div style={{ color: '#666', fontSize: 10 }}>MODE SERVEUR</div>
                <div style={{ color: '#40a9ff', fontSize: 16 }}>{status?.serverRows ?? 0}</div>
              </div>
              <div style={{ fontFamily: MONO, fontSize: 11, color: '#aaa' }}>
                <div style={{ color: '#666', fontSize: 10 }}>MODE SCELLÉ</div>
                <div style={{ color: '#b37feb', fontSize: 16 }}>{status?.sealedRows ?? 0}</div>
              </div>
              {status?.hasSealedBundle && (
                <div style={{ fontFamily: MONO, fontSize: 11 }}>
                  <div style={{ color: '#666', fontSize: 10 }}>COFFRE SCELLÉ</div>
                  <div style={{ color: status.isUnlocked ? '#52c41a' : '#faad14', fontSize: 13 }}>
                    {status.isUnlocked ? '🔓 déverrouillé' : '🔒 verrouillé'}
                  </div>
                </div>
              )}
              <button onClick={downloadTemplate} disabled={busy === 'template'} style={{ ...btn('#b37feb'), marginLeft: 'auto' }}>
                {busy === 'template' ? '…' : '⬇ Télécharger le fichier à remplir'}
              </button>
            </div>

            {/* ── Dépôt du fichier ── */}
            <div style={sectionTitle}>── 1. DÉPOSE TON FICHIER REMPLI ──</div>
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) readFile(f); }}
              onClick={() => fileRef.current?.click()}
              style={{
                border: '1px dashed #2a2a44', borderRadius: 8, padding: 18, textAlign: 'center',
                cursor: 'pointer', background: content ? '#0e1f0e' : '#0d0d14', marginBottom: 10,
              }}
            >
              <div style={{ fontFamily: MONO, fontSize: 12, color: content || fileB64 ? '#52c41a' : '#888' }}>
                {content || fileB64
                  ? `✔ ${fileName || 'contenu collé'}${fileB64 ? ' (PDF formulaire)' : ''} — prêt à analyser`
                  : 'Clique ou glisse ici ton fichier .env, .txt — ou le PDF rempli'}
              </div>
              <div style={{ fontFamily: MONO, fontSize: 10, color: '#555', marginTop: 4 }}>
                Le PDF rempli est accepté : Velbaz lit directement les cases du formulaire.
              </div>
            </div>
            <input ref={fileRef} type="file" accept=".env,.txt,text/plain,.pdf,application/pdf" style={{ display: 'none' }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); }} />

            {/* ── Analyse avant import : « qu'est-ce que le système a lu ? » ── */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
              <button onClick={() => doInspect(false)} disabled={!!busy || (!content.trim() && !fileB64)} style={btn('#40a9ff')}>
                {busy === 'inspect' ? '…' : '👁 Analyser le fichier'}
              </button>
              <button onClick={() => doInspect(true)} disabled={!!busy || (!content.trim() && !fileB64)} style={btn('#b37feb')}>
                {busy === 'inspect-verify' ? 'Test en cours…' : '🔍 Analyser + tester les clés'}
              </button>
              <span style={{ fontFamily: MONO, fontSize: 10, color: '#555', alignSelf: 'center' }}>
                sans rien enregistrer
              </span>
            </div>

            {inspect && (
              <div style={card}>
                <div style={{ fontFamily: MONO, fontSize: 11, color: '#40a9ff', marginBottom: 8 }}>
                  FICHIER LU — {inspect.source === 'pdf' ? `PDF, ${inspect.pdfFields} case(s) remplie(s)` : 'texte'} ·{' '}
                  {inspect.detected.length} clé(s) détectée(s)
                </div>
                {inspect.hint && (
                  <div style={{
                    fontFamily: MONO, fontSize: 11, color: '#faad14', background: '#1f1a0e',
                    border: '1px solid #3a331e', borderRadius: 6, padding: '8px 10px', lineHeight: 1.6,
                  }}>
                    {inspect.hint}
                  </div>
                )}
                {inspect.detected.map((d) => (
                  <div key={d.name} style={{ display: 'flex', gap: 8, fontFamily: MONO, fontSize: 11, padding: '2px 0', flexWrap: 'wrap' }}>
                    <span style={{ color: d.known ? '#52c41a' : '#faad14' }}>{d.known ? '✔' : '⊘'}</span>
                    <span style={{ color: '#ddd' }}>{d.name}</span>
                    <span style={{ color: '#444', fontSize: 10 }}>····{d.last4}</span>
                    {!d.known && <span style={{ color: '#777', fontSize: 10 }}>{SCOPE_NOTE[d.scope]}</span>}
                  </div>
                ))}
              </div>
            )}
            <textarea
              value={content}
              onChange={(e) => { setContent(e.target.value); setFileName(''); setFileB64(''); setInspect(null); }}
              placeholder={'…ou colle directement le contenu ici :\nSTRIPE_SECRET_KEY=sk_live_…\nRESEND_API_KEY=re_…'}
              rows={5}
              spellCheck={false}
              style={{ ...input, resize: 'vertical', lineHeight: 1.5 }}
            />

            {/* ── Mode de chiffrement ── */}
            <div style={sectionTitle}>── 2. NIVEAU DE PROTECTION ──</div>
            <div style={card}>
              <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', marginBottom: 12 }}>
                <input type="radio" checked={!sealedMode} onChange={() => setSealedMode(false)} style={{ marginTop: 3 }} />
                <span style={{ fontFamily: MONO, fontSize: 12, color: '#ddd' }}>
                  Serveur <span style={{ color: '#40a9ff' }}>(recommandé au quotidien)</span>
                  <div style={{ color: '#666', fontSize: 10, marginTop: 3, lineHeight: 1.6 }}>
                    Chiffré AES-256-GCM avec la clé secrète du serveur. Les clés se réarment toutes seules
                    à chaque redémarrage : rien à refaire. Jamais relisibles depuis l'interface.
                  </div>
                </span>
              </label>
              <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
                <input type="radio" checked={sealedMode} onChange={() => setSealedMode(true)} style={{ marginTop: 3 }} />
                <span style={{ fontFamily: MONO, fontSize: 12, color: '#ddd' }}>
                  Scellé <span style={{ color: '#b37feb' }}>(zéro-connaissance)</span>
                  <div style={{ color: '#666', fontSize: 10, marginTop: 3, lineHeight: 1.6 }}>
                    Chiffré avec TA phrase de passe, qui n'est stockée nulle part — ni en base, ni dans un
                    fichier, ni en mémoire longue durée. Personne d'autre ne peut déchiffrer : ni un accès
                    base de données, ni un accès serveur, ni un développeur, ni une IA.
                    <br />
                    <span style={{ color: '#faad14' }}>
                      Contrepartie : après chaque redémarrage, il faut « Déverrouiller » une fois.
                      Phrase perdue = clés définitivement illisibles, personne ne peut les récupérer.
                    </span>
                  </div>
                </span>
              </label>
              {sealedMode && (
                <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
                  <input type="password" autoComplete="new-password" placeholder="Phrase de passe (12 caractères minimum)"
                    value={passphrase} onChange={(e) => setPassphrase(e.target.value)} style={input} />
                  <input type="password" autoComplete="new-password" placeholder="Répète la phrase de passe"
                    value={passphrase2} onChange={(e) => setPassphrase2(e.target.value)} style={input} />
                </div>
              )}
            </div>

            {/* ── Import ── */}
            <button onClick={doImport} disabled={busy === 'import' || (!content.trim() && !fileB64)} style={{
              width: '100%', background: busy === 'import' || (!content.trim() && !fileB64) ? '#333' : '#52c41a',
              border: 'none', color: busy === 'import' || (!content.trim() && !fileB64) ? '#888' : '#000',
              borderRadius: 8, padding: '11px', fontSize: 13, fontWeight: 700,
              cursor: busy === 'import' || (!content.trim() && !fileB64) ? 'default' : 'pointer', fontFamily: MONO,
            }}>
              {busy === 'import' ? 'Import en cours…' : '🔐 Importer dans le coffre'}
            </button>

            {msg && (
              <div style={{
                margin: '12px 0', padding: '9px 12px', borderRadius: 6, fontSize: 12, fontFamily: MONO, lineHeight: 1.6,
                color: msg.type === 'ok' ? '#52c41a' : msg.type === 'warn' ? '#faad14' : '#ff4d4f',
                background: msg.type === 'ok' ? '#0e1f0e' : msg.type === 'warn' ? '#1f1a0e' : '#1f0e0e',
                border: `1px solid ${msg.type === 'ok' ? '#1e3a1e' : msg.type === 'warn' ? '#3a331e' : '#3a1e1e'}`,
              }}>{msg.text}</div>
            )}

            {/* ── Résultat de l'import (jamais de valeur en clair) ── */}
            {result && (
              <div style={card}>
                <div style={{ fontFamily: MONO, fontSize: 11, color: '#52c41a', marginBottom: 8 }}>
                  ✔ IMPORTÉES — {result.imported.length}
                </div>
                {result.imported.map((i) => (
                  <div key={i.name} style={{ fontFamily: MONO, fontSize: 11, color: '#aaa', padding: '2px 0' }}>
                    {i.name} <span style={{ color: '#555' }}>····{i.last4}</span>{' '}
                    <span style={{ color: i.mode === 'sealed' ? '#b37feb' : '#40a9ff', fontSize: 10 }}>[{i.target} · {i.mode}]</span>
                  </div>
                ))}
                {result.rejected.length > 0 && (
                  <>
                    <div style={{ fontFamily: MONO, fontSize: 11, color: '#faad14', margin: '10px 0 6px' }}>
                      ⊘ IGNORÉES — {result.rejected.length}
                    </div>
                    {result.rejected.map((r) => (
                      <div key={r.name} style={{ fontFamily: MONO, fontSize: 10, color: '#777', padding: '1px 0' }}>
                        {r.name} — {r.reason}
                      </div>
                    ))}
                  </>
                )}
                {result.needsRestartNote && (
                  <div style={{ fontFamily: MONO, fontSize: 10, color: '#faad14', marginTop: 10, lineHeight: 1.6 }}>
                    Mode scellé : note ta phrase de passe dans ton gestionnaire de mots de passe.
                    Après un redémarrage du serveur, reviens ici et clique « Déverrouiller ».
                  </div>
                )}
              </div>
            )}

            {/* ── Vérification des clés ── */}
            <div style={sectionTitle}>── 3. VÉRIFIE QUE CE SONT LES BONNES CLÉS ──</div>
            <div style={card}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <button onClick={doVerify} disabled={busy === 'verify'} style={btn('#40a9ff')}>
                  {busy === 'verify' ? 'Test en cours…' : '🔍 Vérifier mes clés'}
                </button>
                {verify && (
                  <>
                    <span style={{ fontFamily: MONO, fontSize: 11, color: '#52c41a' }}>{verify.summary.ok} valides</span>
                    <span style={{ fontFamily: MONO, fontSize: 11, color: verify.summary.bad ? '#ff4d4f' : '#444' }}>
                      {verify.summary.bad} à corriger
                    </span>
                    <span style={{ fontFamily: MONO, fontSize: 11, color: '#666' }}>{verify.summary.missing} absentes</span>
                    <label style={{ fontFamily: MONO, fontSize: 10, color: '#666', marginLeft: 'auto', cursor: 'pointer' }}>
                      <input type="checkbox" checked={hideMissing} onChange={(e) => setHideMissing(e.target.checked)} />{' '}
                      masquer les non renseignées
                    </label>
                  </>
                )}
              </div>
              <div style={{ fontFamily: MONO, fontSize: 10, color: '#555', marginTop: 8, lineHeight: 1.6 }}>
                Velbaz appelle chaque service avec ta clé (lecture seule : « qui suis-je », jamais d'écriture)
                et te dit si elle est acceptée. Aucune valeur ne ressort : seuls les 4 derniers caractères.
              </div>

              {verify && (
                <div style={{ marginTop: 12, maxHeight: 320, overflow: 'auto' }}>
                  {(['bad', 'error', 'ok', 'untestable', 'missing'] as const).map((st) => {
                    if (st === 'missing' && hideMissing) return null;
                    const rows = verify.results.filter((r) => r.status === st);
                    if (!rows.length) return null;
                    const ui = CHECK_UI[st];
                    return (
                      <div key={st} style={{ marginBottom: 12 }}>
                        <div style={{ fontFamily: MONO, fontSize: 10, color: ui.color, marginBottom: 5, letterSpacing: 1 }}>
                          {ui.icon} {ui.title} — {rows.length}
                        </div>
                        {rows.map((r) => (
                          <div key={r.name} style={{
                            padding: '5px 8px', marginBottom: 3, borderRadius: 5,
                            background: '#0a0a12', borderLeft: `2px solid ${ui.color}`,
                          }}>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                              <span style={{ fontFamily: MONO, fontSize: 11, color: '#ddd' }}>{r.name}</span>
                              <span style={{ fontFamily: MONO, fontSize: 9, color: '#555' }}>{r.label}</span>
                              {r.last4 && <span style={{ fontFamily: MONO, fontSize: 9, color: '#444' }}>····{r.last4}</span>}
                              {r.live && <span style={{ fontFamily: MONO, fontSize: 9, color: '#40a9ff' }}>[testée en ligne]</span>}
                              {r.required && r.status === 'missing' && (
                                <span style={{ fontFamily: MONO, fontSize: 9, color: '#faad14' }}>[requise]</span>
                              )}
                            </div>
                            <div style={{ fontFamily: MONO, fontSize: 10, color: '#8c8c8c', marginTop: 2, lineHeight: 1.5 }}>
                              {r.detail}
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* ── Déverrouillage / verrouillage / destruction ── */}
            {status?.hasSealedBundle && (
              <>
                <div style={sectionTitle}>── COFFRE SCELLÉ ──</div>
                <div style={card}>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <input type="password" autoComplete="off" placeholder="Phrase de passe pour déverrouiller"
                      value={unlockPass} onChange={(e) => setUnlockPass(e.target.value)} style={{ ...input, flex: 1, minWidth: 200 }} />
                    <button onClick={doUnlock} disabled={busy === 'unlock'} style={btn('#52c41a')}>
                      {busy === 'unlock' ? '…' : '🔓 Déverrouiller'}
                    </button>
                    <button onClick={doLock} disabled={busy === 'lock'} style={btn('#faad14')}>
                      {busy === 'lock' ? '…' : '🔒 Verrouiller'}
                    </button>
                  </div>
                  <div style={{ fontFamily: MONO, fontSize: 10, color: '#555', marginTop: 8, lineHeight: 1.6 }}>
                    « Verrouiller » efface les clés de la mémoire du serveur sans les supprimer de la base :
                    elles redeviennent illisibles jusqu'au prochain déverrouillage.
                  </div>
                </div>
              </>
            )}

            {/* ── Inventaire write-only ── */}
            <div style={sectionTitle}>
              ── INVENTAIRE ──{' '}
              <button onClick={() => setShowKeys((v) => !v)} style={{ ...btn('#888'), fontSize: 10, padding: '2px 8px' }}>
                {showKeys ? 'masquer' : 'afficher'}
              </button>
            </div>
            {showKeys && (
              <div style={{ ...card, maxHeight: 240, overflow: 'auto' }}>
                {(['secret', 'env'] as const).map((g) => (
                  <div key={g} style={{ marginBottom: 10 }}>
                    <div style={{ fontFamily: MONO, fontSize: 10, color: '#666', marginBottom: 4 }}>
                      {g === 'secret' ? 'SECRETS & INTÉGRATIONS' : 'VARIABLES D’ENVIRONNEMENT'}
                    </div>
                    {keys.filter((k) => k.group === g).map((k) => (
                      <div key={`${g}-${k.name}`} style={{ display: 'flex', justifyContent: 'space-between', fontFamily: MONO, fontSize: 11, padding: '1px 0' }}>
                        <span style={{ color: k.isSet ? '#aaa' : '#555' }}>{k.name}</span>
                        <span style={{ color: k.isSet ? '#52c41a' : '#444' }}>
                          {k.isSet ? `•••• ${k.last4 || '····'}${k.mode ? ` (${k.mode})` : ''}` : 'non configurée'}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 14, borderTop: '1px solid #16162a', paddingTop: 12 }}>
              <button onClick={doWipe} disabled={busy === 'wipe'} style={btn('#ff7875')}>
                {busy === 'wipe' ? '…' : '🗑 Tout détruire'}
              </button>
              <button onClick={onClose} style={{ ...btn('#888'), marginLeft: 'auto', padding: '8px 20px', fontSize: 12 }}>Fermer</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
