import { create } from 'zustand';
import { getAuthToken, setAuthToken, clearAuthToken } from './token';
import { api, onTokenUpdate } from './api';
import { getDeviceId } from './beta';
import { clearProjectsCache } from './sidebar';
import { rearmCreditsPopup } from './credits-popup';

interface User {
  id: string;
  email: string;
  name: string;
  plan: string;
  tokens: number;
  role?: string;
  /** Secondes unix — renvoyé par /auth/me, utilisé par la page Profil. */
  createdAt?: number | null;
  /** Photo de profil du compte (upload, Google ou Gravatar). Null → initiale. */
  avatarUrl?: string | null;
  /** 'upload' | 'google' | 'gravatar' — d'où vient la photo affichée. */
  avatarSource?: string | null;
}

// Admin allowlist (miroir du backend ADMIN_EMAILS). Money Maker = bêta privée admin.
const ADMIN_EMAILS = ['johnemadmansour1@gmail.com'];
export function isAdminUser(user: { email?: string | null; role?: string | null } | null | undefined): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.email && ADMIN_EMAILS.includes(user.email.toLowerCase())) return true;
  return false;
}

// ─── Cache local du compte ───────────────────────────────────────────────────
// [2026-09-17] Au chargement, tant que /auth/me n'avait pas répondu — et
// surtout s'il échouait — `user` restait null : l'interface affichait
// « Sign In » alors que la session était valide et que les projets, eux,
// s'affichaient depuis leur propre cache. On garde donc un instantané du
// compte : affiché tout de suite, puis confirmé (ou effacé) par le serveur.
const USER_CACHE_KEY = 'velbaz_user_cache';

function readUserCache(): User | null {
  try {
    const raw = localStorage.getItem(USER_CACHE_KEY);
    if (!raw) return null;
    const u = JSON.parse(raw);
    return u && typeof u.id === 'string' && typeof u.email === 'string' ? u as User : null;
  } catch { return null; }
}

function writeUserCache(user: User | null) {
  try {
    if (user) localStorage.setItem(USER_CACHE_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_CACHE_KEY);
  } catch { /* mode privé */ }
}

interface AuthStore {
  user: User | null;
  loading: boolean;
  /** Vrai quand la session affichée vient du cache et n'est pas encore confirmée. */
  unverified: boolean;
  setUser: (user: User | null) => void;
  updateTokens: (tokens: number) => void;
  /** Met à jour la photo de profil affichée partout (rond du menu, profil…). */
  setAvatar: (avatarUrl: string | null, avatarSource?: string | null) => void;
  /** Ouvre une session à partir d'un jeton déjà obtenu (retour Google). */
  adoptToken: (token: string) => Promise<{ error?: string }>;
  /** En échec, `retryAfter` (s) / `attemptsLeft` viennent du verrou anti-force-brute. */
  login: (email: string, password: string) => Promise<{ error?: string; retryAfter?: number; attemptsLeft?: number }>;
  register: (name: string, email: string, password: string) => Promise<{ error?: string }>;
  logout: () => Promise<void>;
  init: () => Promise<void>;
}

export const useAuth = create<AuthStore>((set) => ({
  user: null,
  loading: true,
  unverified: false,

  setUser: (user) => { writeUserCache(user); set({ user, unverified: false }); },
  updateTokens: (tokens) => set((s) => s.user ? { user: { ...s.user, tokens } } : {}),

  setAvatar: (avatarUrl, avatarSource) => set((s) => {
    if (!s.user) return {};
    // `null` est une valeur volontaire (photo retirée) : seul `undefined`
    // signifie « ne touche pas à la source ».
    const source = avatarSource === undefined ? (s.user.avatarSource ?? null) : avatarSource;
    const user = { ...s.user, avatarUrl, avatarSource: source };
    writeUserCache(user); // la photo doit survivre au rechargement de la page
    return { user };
  }),

  // Retour de la connexion Google : le jeton arrive dans le fragment d'URL.
  // On l'enregistre puis on confirme la session pour récupérer le compte réel
  // (dont sa photo de profil Google).
  adoptToken: async (token) => {
    if (!token) return { error: 'Jeton manquant' };
    setAuthToken(token);
    try {
      const res = await api.auth.session();
      if (res.user) {
        writeUserCache(res.user);
        set({ user: res.user, unverified: false, loading: false });
        return {};
      }
      if (res.unauthorized) { clearAuthToken(); writeUserCache(null); return { error: 'Session refusée, réessaie.' }; }
      return { error: 'Connexion momentanément indisponible, réessaie.' };
    } catch (e: any) {
      return { error: e?.message || 'Network error' };
    }
  },

  login: async (email, password) => {
    try {
      const res = await api.auth.login({ email, password });
      if (res.error) return { error: res.error, retryAfter: res.retryAfter, attemptsLeft: res.attemptsLeft };
      if (res.token) {
        setAuthToken(res.token);
        writeUserCache(res.user);
        set({ user: res.user, unverified: false });
      }
      return {};
    } catch (e: any) {
      return { error: e.message || 'Network error' };
    }
  },

  register: async (name, email, password) => {
    try {
      const res = await api.auth.register({ name, email, password, deviceId: getDeviceId() });
      if (res.error) return { error: res.error };
      if (res.token) {
        setAuthToken(res.token);
        writeUserCache(res.user);
        set({ user: res.user, unverified: false });
      }
      return {};
    } catch (e: any) {
      return { error: e.message || 'Network error' };
    }
  },

  logout: async () => {
    try { await api.auth.logout(); } catch {}
    clearAuthToken();
    // L'historique de gauche vit dans localStorage : sans ce nettoyage, les
    // projets du compte quitté restaient affichés après la déconnexion.
    try { clearProjectsCache(); } catch {}
    writeUserCache(null);
    set({ user: null, unverified: false });
  },

  init: async () => {
    const token = getAuthToken();
    if (!token) {
      // Pas de token : rien à confirmer, et le cache ne doit pas survivre.
      writeUserCache(null);
      set({ user: null, unverified: false, loading: false });
      return;
    }
    // Affichage immédiat du dernier compte connu : plus d'écran « Sign In »
    // pendant (ou après) l'aller-retour de vérification.
    const cached = readUserCache();
    if (cached) set({ user: cached, unverified: true, loading: false });
    await confirmSession();
  },
}));

// ─── Confirmation de session (tolérante aux pannes) ─────────────────────────
// Un 401/403 est la SEULE raison d'effacer la session. Réseau coupé, 5xx,
// base indisponible : on garde le token et l'utilisateur affiché, et on
// réessaie en arrière-plan avec un délai croissant.
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let confirming = false;

export async function confirmSession(attempt = 0): Promise<void> {
  if (confirming) return;
  if (!getAuthToken()) return;
  confirming = true;
  let res: Awaited<ReturnType<typeof api.auth.session>>;
  try {
    res = await api.auth.session();
  } catch (e: any) {
    res = { unauthorized: false, transient: true };
  } finally {
    confirming = false;
  }

  if (res.user) {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    writeUserCache(res.user);
    useAuth.setState({ user: res.user, unverified: false, loading: false });
    return;
  }

  if (res.unauthorized) {
    // Verdict du serveur : la session est morte → on nettoie pour de bon.
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    clearAuthToken();
    writeUserCache(null);
    try { clearProjectsCache(); } catch {}
    useAuth.setState({ user: null, unverified: false, loading: false });
    return;
  }

  // Panne passagère : on ne déconnecte PAS.
  console.warn(`[auth] session non confirmée (panne passagère), essai ${attempt + 1}`);
  useAuth.setState((s) => ({ loading: false, unverified: !!s.user }));
  const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => { retryTimer = null; void confirmSession(attempt + 1); }, delay);
}

// Retour du réseau ou de l'onglet au premier plan : on retente tout de suite
// si la session n'a jamais pu être confirmée.
if (typeof window !== 'undefined') {
  const retryNow = () => {
    const { user, unverified } = useAuth.getState();
    if (!getAuthToken()) return;
    if (!user || unverified) {
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      void confirmSession();
    }
  };
  window.addEventListener('online', retryNow);
  window.addEventListener('focus', retryNow);
}

// ─── Pop-up « crédits épuisés » : réarmement ────────────────────────────────
// Dès qu'un solde strictement positif est observé — peu importe la page
// affichée, la pop-up peut très bien n'être montée nulle part — on efface le
// « déjà fermée ». Sans ça, un cycle recharge → ré-épuisement ne rallumait
// jamais la pop-up.
useAuth.subscribe((state) => {
  if (state.user && (state.user.tokens ?? 0) > 0) rearmCreditsPopup();
});

// ─── Auto-sync tokens from every API response ───────────────────────────────
onTokenUpdate((tokens) => {
  const { user } = useAuth.getState();
  if (user && user.tokens !== tokens) {
    useAuth.getState().updateTokens(tokens);
  }
});
