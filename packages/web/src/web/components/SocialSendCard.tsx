"use client";

/* ─────────────────────────────────────────────────────────────────────────
 * SOCIAL SEND CARD — envoi d'un message sur un réseau social DEPUIS LE CHAT.
 *
 * [2026-09-16] Demande de l'utilisateur :
 *   « je die dans le tchat "envoie un message" → l'IA peut utiliser le system
 *     pour envoyer, mais si la personne n'était pas connectée, l'IA dit
 *     "connecte-toi" et ça met une pop-up dans le chat qui ressemble à 100 %
 *     à mon image (mais pas Google) ; j'appuie sur Connecter, et après l'IA a
 *     tout accès et peut tout faire. »
 *
 * L'IA émet donc dans sa réponse :
 *   [SOCIAL_SEND]{"platforms":["twitter"],"text":"le message à publier"}[/SOCIAL_SEND]
 * et CE composant fait le vrai travail :
 *   1. il demande au SERVEUR quels réseaux sont liés (source de vérité) ;
 *   2. réseau non lié → carte « Connecter » (maquette de l'image : pastille
 *      d'icône, titre, sous-titre, bouton pilule clair à droite) ;
 *   3. clic sur « Connecter » → vrai OAuth (/social/connect, popup, vérif
 *      serveur), exactement comme le panneau des réseaux sociaux ;
 *   4. dès que c'est lié → le message part tout seul via le système existant
 *      (POST /social/generate), sans rien redemander à l'utilisateur.
 *
 * IDEMPOTENCE : le bloc reste dans l'historique du chat. Un rechargement de
 * page ne doit PAS republier. Le résultat de chaque envoi est mémorisé dans
 * localStorage sous une signature (projet + plateforme + texte) et réaffiché
 * tel quel au lieu d'être rejoué.
 *
 * [2026-09-16] Quand l'utilisateur « passe » la question du texte, le serveur
 * émet un bloc SANS texte (l'IA l'écrit elle-même) plus un identifiant :
 *   [SOCIAL_SEND]{"platforms":["twitter"],"text":"","id":"a1b2c3d4"}[/SOCIAL_SEND]
 * La signature de mémo utilise alors cet `id` et non le hash du texte : deux
 * envois « écris-le toi-même » vers la même plateforme auraient sinon la même
 * clé (hash("")) et le second rejouerait le résultat du premier.
 * ───────────────────────────────────────────────────────────────────────── */

import { useEffect, useRef, useState } from 'react';
import { getAuthToken } from '../lib/token';
import { normalizePlatform, platformMeta, useAvailablePlatforms } from '../lib/social-platforms';

export interface SocialSendData {
  /** Plateformes visées ("twitter", "discord", "reddit", "instagram"). */
  platforms?: string[];
  /** Compat : une seule plateforme. */
  platform?: string;
  /** Message voulu par l'utilisateur. */
  text?: string;
  message?: string;
  /** Identifiant d'envoi émis par le serveur quand le texte est vide (message
      écrit par l'IA). Sans lui, deux envois « écris-le toi-même » vers la même
      plateforme partagent la même clé de mémo (company+platform+hash("")) et
      le second rejouerait le résultat du premier au lieu de publier. */
  id?: string;
}

type Phase =
  | 'checking'      // on interroge le serveur
  | 'need-connect'  // réseau non lié → carte « Connecter »
  | 'connecting'    // OAuth en cours
  | 'sending'       // publication en cours
  | 'sent'          // publié
  | 'error';        // échec (connexion ou publication)

const SENT_KEY = (companyId: string, platform: string, text: string, id?: string) =>
  `velbaz:social-send:${companyId}:${platform}:${id ? `id-${id}` : hash(text)}`;

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

function readMemo(key: string): { published: boolean; url?: string; error?: string } | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function writeMemo(key: string, v: { published: boolean; url?: string; error?: string }) {
  try { localStorage.setItem(key, JSON.stringify({ ...v, at: Date.now() })); } catch { /* quota */ }
}

/** Connexions actives côté serveur (jamais l'état local : lui mentait). */
async function fetchConnected(companyId: string): Promise<Set<string>> {
  const tok = getAuthToken();
  const res = await fetch(`/api/companies/${companyId}/social/connections`, {
    headers: tok ? { Authorization: `Bearer ${tok}` } : {},
  });
  if (!res.ok) return new Set();
  const data = await res.json() as any;
  const list: any[] = Array.isArray(data) ? data : (data.connections ?? []);
  return new Set(list.filter(c => c?.platform && c.isActive).map(c => c.platform as string));
}

/* ─── Une ligne = une plateforme ────────────────────────────────────────── */

function PlatformSendRow({ companyId, platform, text, sendId }: { companyId: string; platform: string; text: string; sendId?: string }) {
  const meta = platformMeta(platform);
  const memoKey = SENT_KEY(companyId, platform, text, sendId);

  const [phase, setPhase] = useState<Phase>('checking');
  const [detail, setDetail] = useState<string>('');
  /** Message brut du serveur (souvent en anglais) : gardé en info-bulle, pas
      affiché tel quel — la carte parle français. */
  const [rawDetail, setRawDetail] = useState<string>('');
  const [url, setUrl] = useState<string | undefined>();
  /** Un seul envoi par montage, quoi qu'il arrive (React 18 monte 2× en dev). */
  const sendingRef = useRef(false);
  /** Le serveur affirme que ce compte EST lié (vu au montage, ou juste après
      un clic sur « Connecter »). Si la publication répond quand même
      « connecte-toi », on ne renvoie pas l'utilisateur sur le même bouton en
      boucle : on affiche la vraie raison du refus. */
  const knownLinkedRef = useRef(false);

  /** Publie via le système existant (pipeline de contenu + publication). */
  const publish = async () => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setPhase('sending');
    try {
      const tok = getAuthToken();
      const res = await fetch(`/api/companies/${companyId}/social/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
        body: JSON.stringify({ platform, ...(text.trim() ? { prompt: text.trim() } : {}) }),
      });
      const data = await res.json().catch(() => null) as any;
      if (!res.ok) {
        // Le serveur sait dire « pas connecté » : on rebascule sur la carte.
        if (data?.type === 'connection_required') {
          sendingRef.current = false;
          if (knownLinkedRef.current) {
            // Compte lié côté serveur mais l'envoi refuse : inutile de
            // reproposer « Connecter » — on dit ce qui bloque vraiment.
            setRawDetail(data?.error || '');
            setDetail("Compte lié, mais l'envoi a été refusé — reconnecte le compte pour renouveler l'accès.");
            setPhase('error');
            return;
          }
          setPhase('need-connect');
          return;
        }
        throw new Error(data?.error || `Le serveur a répondu ${res.status}`);
      }
      if (data?.published === true) {
        setUrl(data.platformPostUrl);
        setDetail(data.content || text);
        setPhase('sent');
        writeMemo(memoKey, { published: true, url: data.platformPostUrl });
        return;
      }
      const err = data?.publishError || data?.error || "Aucune publication n'a été envoyée";
      setDetail(err);
      setPhase('error');
      writeMemo(memoKey, { published: false, error: err });
    } catch (e: any) {
      const err = e?.message || 'Erreur réseau';
      setDetail(err);
      setPhase('error');
      // Mémorisé aussi : une requête coupée peut avoir publié quand même.
      // Un rechargement ne doit donc PAS relancer l'envoi tout seul ;
      // « Réessayer » efface la mémo si l'utilisateur le veut vraiment.
      writeMemo(memoKey, { published: false, error: err });
    } finally {
      sendingRef.current = false;
    }
  };

  /** OAuth réel, calqué sur SocialConnectPanel (popup + vérification serveur). */
  const connect = async () => {
    if (phase === 'connecting') return;
    setPhase('connecting');
    setDetail('');
    try {
      const tok = getAuthToken();
      const res = await fetch(`/api/companies/${companyId}/social/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
        // L'origine réelle du navigateur : le proxy réécrit Host/Origin, c'est
        // le seul moyen fiable de faire revenir la popup OAuth ici.
        body: JSON.stringify({ platform, origin: window.location.origin }),
      });
      if (!res.ok) throw new Error(`Connexion impossible (${res.status})`);
      const data = await res.json() as any;

      if (!data.demo && data.authUrl) {
        const w = window.open(data.authUrl, `oauth_${platform}`, 'width=600,height=700,left=200,top=100');
        if (!w) throw new Error('Popup bloquée par le navigateur — autorise les fenêtres surgissantes puis réessaie');
        let oauthError: string | null = null;
        const outcome = await new Promise<'success' | 'error' | 'closed' | 'timeout'>((resolve) => {
          const cleanup = () => {
            window.removeEventListener('message', onMsg);
            clearInterval(iv);
            clearTimeout(to);
          };
          const onMsg = (ev: MessageEvent) => {
            if (ev.data?.platform && ev.data.platform !== platform) return;
            if (ev.data?.type === 'oauth-success') { cleanup(); resolve('success'); }
            else if (ev.data?.type === 'oauth-error') { oauthError = ev.data.error || null; cleanup(); resolve('error'); }
          };
          window.addEventListener('message', onMsg);
          const iv = setInterval(() => { if (w.closed) { cleanup(); setTimeout(() => resolve('closed'), 400); } }, 500);
          const to = setTimeout(() => { cleanup(); resolve('timeout'); }, 120000);
        });
        // On ne suppose JAMAIS le succès : le serveur confirme.
        const linked = await fetchConnected(companyId);
        if (!linked.has(platform)) {
          throw new Error(
            oauthError
            || (outcome === 'timeout' ? 'Délai dépassé — la connexion n\'a pas abouti'
              : outcome === 'closed' ? 'Fenêtre fermée avant la fin de la connexion'
              : 'La connexion a échoué'),
          );
        }
      }
      // Lié → l'IA a « tout accès » : le message part immédiatement.
      knownLinkedRef.current = true;
      await publish();
    } catch (e: any) {
      setDetail(e?.message || 'Connexion impossible');
      setPhase('error');
    }
  };

  // Au montage : résultat déjà mémorisé → on le réaffiche ; sinon on regarde
  // si le réseau est lié, et on publie tout seul si oui.
  useEffect(() => {
    let alive = true;
    const memo = readMemo(memoKey);
    if (memo) {
      if (memo.published) { setUrl(memo.url); setPhase('sent'); }
      else { setDetail(memo.error || 'Échec de la publication'); setPhase('error'); }
      return;
    }
    (async () => {
      try {
        const linked = await fetchConnected(companyId);
        if (!alive) return;
        if (linked.has(platform)) { knownLinkedRef.current = true; await publish(); }
        else setPhase('need-connect');
      } catch {
        if (alive) setPhase('need-connect');
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, platform, memoKey]);

  const subtitle =
    phase === 'need-connect' ? `Connecte ce compte pour que l'IA puisse envoyer ton message.`
    : phase === 'connecting' ? 'Connexion en cours — termine dans la fenêtre qui vient de s\'ouvrir.'
    : phase === 'sending' ? 'Envoi du message…'
    : phase === 'sent' ? 'Message envoyé.'
    : phase === 'error' ? detail
    : 'Vérification de la connexion…';

  return (
    <div className="ssend-card">
      <span className="ssend-ico" style={{ background: meta.color, color: meta.fg }}>{meta.icon}</span>
      <div className="ssend-txt">
        <div className="ssend-title">{meta.name}</div>
        <div className="ssend-sub" data-err={phase === 'error'} title={rawDetail || undefined}>{subtitle}</div>
      </div>

      {(phase === 'need-connect' || phase === 'connecting') && (
        <button type="button" className="ssend-btn" onClick={connect} disabled={phase === 'connecting'}>
          {phase === 'connecting' ? 'Connexion…' : 'Connecter'}
        </button>
      )}
      {phase === 'checking' && <span className="ssend-state">…</span>}
      {phase === 'sending' && <span className="ssend-state">Envoi…</span>}
      {phase === 'sent' && (
        url
          ? <a className="ssend-btn" href={url} target="_blank" rel="noreferrer">Voir le post</a>
          : <span className="ssend-state" data-ok="true">Envoyé</span>
      )}
      {phase === 'error' && (
        <button type="button" className="ssend-btn" onClick={() => { try { localStorage.removeItem(memoKey); } catch {} setPhase('need-connect'); }}>
          Réessayer
        </button>
      )}
    </div>
  );
}

export default function SocialSendCard({ data, companyId }: { data: SocialSendData; companyId?: string | null }) {
  // Une plateforme masquée (Reddit sans clés API) n'a jamais de carte d'envoi.
  const available = useAvailablePlatforms();
  const wanted = (data.platforms && data.platforms.length ? data.platforms : [data.platform || ''])
    .map(p => normalizePlatform(p))
    .filter((p): p is string => !!p && available.has(p));
  const platforms = Array.from(new Set(wanted));
  const text = (data.text || data.message || '').toString();
  const sendId = data.id ? String(data.id) : undefined;

  if (!companyId || platforms.length === 0) return null;

  return (
    <div style={{ margin: '8px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {platforms.map(p => (
        <PlatformSendRow key={sendId ? `${sendId}:${p}` : p} companyId={companyId} platform={p} text={text} sendId={sendId} />
      ))}
    </div>
  );
}
