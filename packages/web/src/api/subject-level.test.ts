// Régression du bug « méta-confusion » : l'utilisateur demande UNE MARQUE de
// vêtements, Velbaz créait une entreprise qui CRÉE des marques de vêtements
// (agence/studio) — un cran d'abstraction au-dessus de la demande.
//
// Cause : le client envoyait tout le transcript (y compris les phrases de l'IA
// « je vais créer ta marque pour toi ») dans `companies.idea`, lu ensuite par
// une cinquantaine de prompts. Ce fichier verrouille le comportement attendu
// sur des transcripts RÉELS, bout en bout des fonctions de décision.
import { describe, expect, it } from 'bun:test';
import {
  detectOfferLevel,
  normalizeIdea,
  stripAiTurns,
} from './idea-subject';
import { detectBusinessKind, hasIdeaSubstance } from './agents/orchestrator';
import { findIndustryPlaybook } from './agents/industry-playbooks';

// Transcript tel que `triggerBuild` le reconstruisait côté client.
const TRANSCRIPT_POLLUE = [
  "User: crée-moi une marque de vêtements",
  "AI: Avec plaisir ! Je vais créer ta marque de vêtements pour toi, de A à Z.",
  "AI: Je m'occupe de créer l'identité, la boutique et les collections.",
  "User: France, style streetwear, cible 18-30 ans, prix moyen 60€",
  "AI: Parfait, je lance la création de ta marque.",
  "[PLAN VALIDÉ] Boutique en ligne + 5 pages",
].join('\n');

describe('bug méta-confusion — marque vs agence de marques', () => {
  it("retire les phrases de l'IA du transcript de build", () => {
    const userOnly = stripAiTurns(TRANSCRIPT_POLLUE);
    expect(userOnly).toContain('marque de vêtements');
    expect(userOnly).toContain('streetwear');
    expect(userOnly).toContain('[PLAN VALIDÉ]');
    expect(userOnly.toLowerCase()).not.toContain('je vais créer ta marque');
    expect(userOnly.toLowerCase()).not.toContain('je lance la création');
  });

  it('classe la demande en first_party malgré la pollution', () => {
    expect(detectOfferLevel(TRANSCRIPT_POLLUE)).toBe('first_party');
    expect(detectOfferLevel(stripAiTurns(TRANSCRIPT_POLLUE))).toBe('first_party');
  });

  it("produit une idée verrouillée qui interdit l'agence", () => {
    const { idea, level, subject } = normalizeIdea(TRANSCRIPT_POLLUE);
    expect(level).toBe('first_party');
    expect(subject).toContain('marque de vêtements');
    expect(idea).toContain('VERROUILLÉ');
    expect(idea).toMatch(/N'EST PAS une agence/i);
    expect(idea.toLowerCase()).not.toContain('je vais créer ta marque');
  });

  it("ne classe pas le projet comme 'agency' dans l'orchestrateur", () => {
    const { idea } = normalizeIdea(TRANSCRIPT_POLLUE);
    expect(detectBusinessKind(TRANSCRIPT_POLLUE)).not.toBe('agency');
    expect(detectBusinessKind(idea)).not.toBe('agency');
  });

  it('garde une idée « substantielle » après verrouillage', () => {
    const { idea } = normalizeIdea(TRANSCRIPT_POLLUE);
    expect(hasIdeaSubstance(idea)).toBe(true);
  });

  it('choisit un playbook mode, pas un playbook agence/SaaS', () => {
    const { idea } = normalizeIdea(TRANSCRIPT_POLLUE);
    const pbBrut = findIndustryPlaybook('crée-moi une marque de vêtements streetwear');
    const pbVerrou = findIndustryPlaybook(idea);
    // Le bloc de verrou (qui nomme « agence », « SaaS » pour les INTERDIRE) ne
    // doit pas détourner la détection de secteur.
    expect(pbVerrou?.id).toBe(pbBrut?.id);
  });
});

describe('cas inverse — une vraie agence reste une agence', () => {
  const AGENCE = "je veux une agence qui crée des marques de vêtements pour mes clients";

  it('détecte un prestataire', () => {
    expect(detectOfferLevel(AGENCE)).toBe('service_provider');
  });

  it("annonce PRESTATAIRE dans le verrou", () => {
    const { idea, level } = normalizeIdea(AGENCE);
    expect(level).toBe('service_provider');
    expect(idea).toMatch(/PRESTATAIRE/i);
  });

  it("reste classé 'agency' côté orchestrateur", () => {
    expect(detectBusinessKind(AGENCE)).toBe('agency');
    expect(detectBusinessKind(normalizeIdea(AGENCE).idea)).toBe('agency');
  });
});

describe('autres montées d\'abstraction interdites', () => {
  const cas = [
    'crée-moi un restaurant italien à Lyon',
    'je veux lancer une app de fitness',
    'fais-moi une marque de bijoux artisanaux',
    'crée une salle de sport à Marseille',
    'I want to create a coffee brand',
    'build me a skincare brand',
  ];
  for (const c of cas) {
    it(`« ${c} » → first_party`, () => {
      const { level, idea } = normalizeIdea(c);
      expect(level).toBe('first_party');
      expect(detectBusinessKind(idea)).not.toBe('agency');
    });
  }
});
