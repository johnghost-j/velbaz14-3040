import { describe, expect, it } from 'bun:test';
import {
  detectOfferLevel,
  ensureSubjectLock,
  extractAiQuestions,
  extractSubjectPhrase,
  hasSubjectLock,
  normalizeIdea,
  QUESTIONS_START,
  stripAiTurns,
} from './idea-subject';

describe('stripAiTurns', () => {
  it('retire les tours de parole de l’IA (source de la méta-confusion)', () => {
    const transcript = [
      'User: crée-moi une marque de vêtements',
      'AI: Super 🚀 je vais créer ta marque de vêtements pour toi !',
      'AI: Je m’occupe de lancer la marque et de fabriquer les collections.',
      'User: style streetwear, hoodies, 60-120 €, Belgique',
    ].join('\n');
    const out = stripAiTurns(transcript);
    expect(out).toContain('crée-moi une marque de vêtements');
    expect(out).toContain('streetwear');
    expect(out).not.toContain('je vais créer ta marque');
    expect(out).not.toContain('fabriquer les collections');
  });

  it('retire aussi les lignes de continuation d’un message IA multi-lignes', () => {
    const transcript = [
      'User: je veux une marque de bijoux',
      'AI: Voici mon plan :',
      '1. créer des marques de bijoux pour des clients',
      '2. vendre du branding',
      'User: ok',
    ].join('\n');
    const out = stripAiTurns(transcript);
    expect(out).not.toContain('pour des clients');
    expect(out).not.toContain('vendre du branding');
    expect(out).toContain('marque de bijoux');
  });

  it('laisse un message simple intact', () => {
    expect(stripAiTurns('une marque de vêtements')).toBe('une marque de vêtements');
  });

  it('garde les blocs neutres ajoutés par le client (plan validé)', () => {
    const t = 'User: une marque de vêtements\nAI: ok\n\n[PLAN VALIDÉ] Accueil, Boutique, Produit';
    const out = stripAiTurns(t);
    expect(out).toContain('[PLAN VALIDÉ] Accueil, Boutique, Produit');
    expect(out).not.toMatch(/^AI:/m);
  });
});

describe('extractSubjectPhrase', () => {
  it('extrait le sujet d’une demande de création', () => {
    expect(extractSubjectPhrase('crée-moi une marque de vêtements')).toBe('marque de vêtements');
    expect(extractSubjectPhrase('je veux lancer une boutique de sneakers')).toContain('sneakers');
  });

  it('coupe la partie « qui s’appelle X »', () => {
    expect(extractSubjectPhrase('crée une marque de vêtements qui s’appelle Noïr')).toBe('marque de vêtements');
  });
});

describe('detectOfferLevel', () => {
  const firstParty = [
    'crée-moi une marque de vêtements',
    'je veux lancer ma marque de vêtements',
    'une marque de vêtements streetwear haut de gamme',
    'build me a clothing brand',
    'je veux ouvrir mon restaurant italien',
    'une marque de vêtements au design minimaliste et au branding soigné',
  ];
  for (const t of firstParty) {
    it(`first_party: « ${t} »`, () => expect(detectOfferLevel(t)).toBe('first_party'));
  }

  const provider = [
    'je veux créer une agence qui crée des marques de vêtements',
    'un studio qui fabrique des collections pour d’autres marques',
    'une plateforme qui aide les créateurs à lancer leur marque',
    'a service that helps other businesses launch clothing brands',
    'un cabinet de consulting en image de marque',
  ];
  for (const t of provider) {
    it(`service_provider: « ${t} »`, () => expect(detectOfferLevel(t)).toBe('service_provider'));
  }

  it('le transcript pollué par l’IA ne fait pas basculer le niveau', () => {
    const transcript = [
      'User: crée-moi une marque de vêtements',
      'AI: je crée des marques de vêtements pour les entreprises et j’aide les créateurs !',
      'User: streetwear, unisexe',
    ].join('\n');
    expect(detectOfferLevel(stripAiTurns(transcript))).toBe('first_party');
  });
});

describe('normalizeIdea', () => {
  it('produit une idée verrouillée qui interdit l’agence', () => {
    const out = normalizeIdea('crée-moi une marque de vêtements streetwear');
    expect(out.level).toBe('first_party');
    expect(out.lang).toBe('fr');
    expect(hasSubjectLock(out.idea)).toBe(true);
    expect(out.idea).toContain("N'EST PAS une agence");
    expect(out.idea).toContain('crée-moi une marque de vêtements streetwear');
  });

  it('verrouille dans l’autre sens quand l’utilisateur veut vraiment une agence', () => {
    const out = normalizeIdea('je veux créer une agence qui crée des marques de vêtements');
    expect(out.level).toBe('service_provider');
    expect(out.idea).toContain('PRESTATAIRE');
  });

  it('est idempotent', () => {
    const once = normalizeIdea('crée-moi une marque de vêtements').idea;
    const twice = normalizeIdea(once).idea;
    expect(twice).toBe(once);
    expect(twice.match(/SUJET — VERROUILLÉ/g)?.length).toBe(1);
  });

  it('gère un transcript complet avec réponses au questionnaire', () => {
    const transcript = [
      'User: salut, crée-moi une marque de vêtements',
      'AI: 👋 Je vais construire une entreprise qui crée des marques de vêtements pour ses clients.',
      'User: Style: streetwear — Public: unisexe — Prix: 60-120 € — Pays: Belgique',
    ].join('\n');
    const out = normalizeIdea(transcript);
    expect(out.level).toBe('first_party');
    expect(out.userText).not.toContain('entreprise qui crée des marques');
    expect(out.idea).toContain('streetwear');
    expect(out.idea).toContain('Belgique');
  });

  it('anglais → verrou en anglais', () => {
    const out = normalizeIdea('build me a clothing brand for young men in the US');
    expect(out.lang).toBe('en');
    expect(out.idea).toContain('NOT an agency');
  });
});

describe('ensureSubjectLock', () => {
  it('ajoute le verrou sur une idée héritée', () => {
    expect(hasSubjectLock(ensureSubjectLock('une marque de vêtements'))).toBe(true);
  });
  it('ne double pas un verrou existant', () => {
    const locked = normalizeIdea('une marque de vêtements').idea;
    expect(ensureSubjectLock(locked)).toBe(locked);
  });
  it('laisse une chaîne vide telle quelle', () => {
    expect(ensureSubjectLock('')).toBe('');
  });
});

// ─── Contexte des questions du questionnaire ─────────────────────────────────
// `stripAiTurns` supprime tout ce que l'IA dit — y compris ses QUESTIONS. Or
// les réponses utilisateur y renvoient par numéro (« 1. streetwear »). On garde
// donc les seules lignes interrogatives, dans un bloc non-définissant.
const TRANSCRIPT_QUESTIONNAIRE = [
  'User: cret moi une mark de vêtement',
  'AI: Top — je vais créer ta marque de vêtements pour toi ! Dis-moi juste ces points :',
  'AI: 1. Quel style vises-tu (streetwear, minimaliste, luxe) ?',
  'AI: 2. Quelle fourchette de prix ?',
  'AI: 3. Quel pays de vente principal ?',
  'User: 1. streetwear  2. 40-90 €  3. Belgique',
].join('\n');

describe('extractAiQuestions', () => {
  it('récupère les questions de l’IA, pas ses affirmations', () => {
    const qs = extractAiQuestions(TRANSCRIPT_QUESTIONNAIRE);
    expect(qs.length).toBe(3);
    expect(qs.some(q => q.includes('style'))).toBe(true);
    expect(qs.some(q => q.includes('prix'))).toBe(true);
    expect(qs.join(' ')).not.toContain('je vais créer ta marque');
  });

  it('ignore les questions posées par l’utilisateur lui-même', () => {
    const qs = extractAiQuestions('User: tu peux me faire une marque de vêtements ?');
    expect(qs).toEqual([]);
  });

  it('dédoublonne les questions répétées', () => {
    const t = ['AI: Quel style vises-tu ?', 'AI: Quel style vises-tu ?'].join('\n');
    expect(extractAiQuestions(t).length).toBe(1);
  });
});

describe('normalizeIdea — bloc contexte-questions', () => {
  it('conserve les questions pour rendre les réponses numérotées lisibles', () => {
    const out = normalizeIdea(TRANSCRIPT_QUESTIONNAIRE);
    expect(out.idea).toContain(QUESTIONS_START);
    expect(out.idea).toContain('Quelle fourchette de prix');
    expect(out.idea).toContain('40-90');
  });

  it('n’y laisse AUCUNE affirmation méta de l’IA', () => {
    const out = normalizeIdea(TRANSCRIPT_QUESTIONNAIRE);
    expect(out.idea).not.toContain('je vais créer ta marque');
    expect(out.userText).not.toContain('je vais créer ta marque');
  });

  it('le sujet et le niveau restent calculés sur l’utilisateur seul', () => {
    const out = normalizeIdea(TRANSCRIPT_QUESTIONNAIRE);
    expect(out.level).toBe('first_party');
    expect(out.subject).toContain('mark');
    expect(out.idea).toContain('N\'EST PAS une agence');
  });

  it('reste idempotent : ré-appliquer ne réempile pas les blocs', () => {
    const once = normalizeIdea(TRANSCRIPT_QUESTIONNAIRE).idea;
    const twice = normalizeIdea(once).idea;
    expect(twice).toBe(once);
    expect(once.split(QUESTIONS_START).length - 1).toBe(1);
  });

  it('n’ajoute pas de bloc quand l’IA n’a posé aucune question', () => {
    const out = normalizeIdea('crée-moi une marque de vêtements streetwear');
    expect(out.idea).not.toContain(QUESTIONS_START);
  });
});

// ─── [2026-09-25] Sélecteur d'idées : « boutique choisie » ────────────────────
// Bug signalé : l'utilisateur dit « crée une entreprise », choisit une idée
// parmi les 5 propositions (une boutique) et le site construit est celui d'une
// ENTREPRISE QUI CRÉE DES ENTREPRISES. Cause : le sujet verrouillé était calculé
// sur « crée-moi une entreprise » (placeholder) + la question de l'IA recopiée
// dans la réponse, jamais sur l'option réellement choisie.
describe('sélecteur d’idées : l’option choisie devient le sujet', () => {
  const PICKER = [
    'User: crée moi une entreprise',
    'AI: Avec plaisir — mais avant de construire, il me faut savoir QUOI créer.',
    'AI: Quelle entreprise veux-tu créer ?',
    'User: Quelle entreprise veux-tu créer ?: Boutique en ligne de produits artisanaux locaux',
  ].join('\n');

  it('prend l’idée choisie, pas le placeholder « une entreprise »', () => {
    expect(extractSubjectPhrase(stripAiTurns(PICKER))).toBe('Boutique en ligne de produits artisanaux locaux');
  });

  it('ne déborde jamais d’une ligne sur l’autre (question recopiée)', () => {
    const subject = extractSubjectPhrase(stripAiTurns(PICKER));
    expect(subject).not.toContain('Quelle entreprise');
    expect(subject).not.toMatch(/^entreprise\b/i);
  });

  it('le verrou écrit en base parle de la boutique, pas d’une méta-entreprise', () => {
    const { idea, subject, level } = normalizeIdea(PICKER);
    expect(subject).toBe('Boutique en ligne de produits artisanaux locaux');
    expect(level).toBe('first_party');
    expect(idea).toContain('L\'entreprise à construire EST : « Boutique en ligne de produits artisanaux locaux »');
    expect(idea).not.toContain('EST : « entreprise');
  });

  it('marche aussi en anglais', () => {
    const t = [
      'User: create me a business',
      'AI: What business do you want to create?',
      'User: What business do you want to create?: Online shop for handmade ceramics',
    ].join('\n');
    expect(extractSubjectPhrase(stripAiTurns(t))).toBe('Online shop for handmade ceramics');
  });

  it('ignore l’option « J’ai déjà mon idée » et prend la description qui suit', () => {
    const t = [
      'User: fais moi un site',
      'AI: Quelle entreprise veux-tu créer ?',
      'User: Quelle entreprise veux-tu créer ?: J\'ai déjà mon idée — je la décris',
      'AI: Vas-y, décris-la.',
      'User: je veux une marque de bougies parfumées artisanales',
    ].join('\n');
    expect(extractSubjectPhrase(stripAiTurns(t))).toBe('marque de bougies parfumées artisanales');
  });

  it('garde l’idée choisie même après les réponses du questionnaire de découverte', () => {
    const t = [
      'User: crée une entreprise',
      'AI: Quelle entreprise veux-tu créer ?',
      'User: Quelle entreprise veux-tu créer ?: Boutique de plantes rares en ligne',
      'AI: Quelques questions avant de lancer.',
      'User: Quel est ton public ? : citadins 25-40 ans | Quel budget ? : 20-80€ | Où vends-tu ? : France',
    ].join('\n');
    expect(extractSubjectPhrase(stripAiTurns(t))).toBe('Boutique de plantes rares en ligne');
  });

  it('une question de l’IA recopiée dans la réponse ne bascule pas en prestataire', () => {
    const t = [
      'User: crée moi une boulangerie',
      'AI: ok',
      'User: Tu vends pour des clients professionnels ? : oui',
    ].join('\n');
    expect(detectOfferLevel(stripAiTurns(t))).toBe('first_party');
    expect(extractSubjectPhrase(stripAiTurns(t))).toBe('boulangerie');
  });

  it('une vraie phrase d’agence reste un prestataire', () => {
    const t = 'je veux lancer une agence qui crée des marques pour des clients';
    expect(detectOfferLevel(t)).toBe('service_provider');
  });

  it('sans aucune idée, le sujet ne devient pas une réponse méta', () => {
    const t = [
      'User: crée moi une entreprise',
      'AI: Quelle entreprise veux-tu créer ?',
      'User: Quelle entreprise veux-tu créer ?: je ne sais pas',
    ].join('\n');
    expect(extractSubjectPhrase(stripAiTurns(t))).toBe('entreprise');
  });
});
