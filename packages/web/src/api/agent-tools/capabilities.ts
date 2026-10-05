// ─── Capacités de la plateforme branchées sur les outils de l'agent ──────────
// Certaines capacités (génération d'image, facturation en tokens) vivent dans
// src/api/index.ts. Les importer d'ici créerait une dépendance circulaire
// (index → orchestrator → loop → tools → index). index.ts les ENREGISTRE donc
// au démarrage, comme le fait déjà autopilot (registre sur globalThis, qui
// survit aux rechargements à chaud de Vite).
//
// Une capacité absente n'est jamais simulée : l'outil répond « indisponible ».

export interface AgentCapabilities {
  /** Génère une image (base64) à partir d'une description. null = échec. */
  generateImage?: (prompt: string) => Promise<{ data: string; mimeType: string } | null>;
  /** Débite le coût d'une génération d'image. ok=false → solde insuffisant. */
  chargeImage?: (userId: string, companyId?: string) => Promise<{ ok: boolean; balance?: number; error?: string }>;
}

const G = globalThis as any;

export function registerAgentCapabilities(caps: AgentCapabilities): void {
  G.__velbaz_agent_caps = { ...G.__velbaz_agent_caps, ...caps };
}

export function agentCapabilities(): AgentCapabilities {
  return (G.__velbaz_agent_caps || {}) as AgentCapabilities;
}
