// ─── Types partagés par les outils de l'agent ────────────────────────────────
// Volontairement autonome : aucun import de l'orchestrateur, pour éviter une
// dépendance circulaire (orchestrator → loop → tools → orchestrator).
// `AgentProgress` est structurellement identique à `ProgressStep` côté
// orchestrateur, donc les callbacks se branchent directement.

export interface AgentProgress {
  id: string;
  label: string;
  preview?: {
    kind: 'browse' | 'screenshot' | 'search' | 'code' | 'analyze';
    imageUrl?: string;
    url?: string;
    caption?: string;
  };
}

export interface ToolContext {
  /** Session de chat : isole le sandbox et le navigateur d'un utilisateur. */
  sessionId: string;
  /** Company en cours — sans elle, les outils fichiers/API sont désactivés. */
  companyId?: string;
  /** Retour temps réel dans le chat (même canal que les étapes existantes). */
  onProgress?: (step: AgentProgress) => void;
  /** Journal des outils réellement exécutés (pour l'affichage et les tests). */
  log?: ToolCall[];
  /** Utilisateur connecté (destinataire par défaut d'un email, payeur des crédits). */
  user?: AgentUser;
  /** Message tapé par l'utilisateur à ce tour : seule source de confiance pour
   *  une adresse email tierce (une page web lue par l'agent ne compte pas). */
  userMessage?: string;
}

export interface AgentUser {
  id: string;
  email?: string | null;
  name?: string | null;
}

export interface ToolCall {
  tool: string;
  input: any;
  ok: boolean;
  summary: string;
  ms: number;
}
