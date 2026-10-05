import { describe, expect, test } from 'bun:test';
import {
  articleBody, articlePublishInstruction, articleSlug, capabilitiesBrief, executableTypes, followUpTasks, normalizePlannedTasks,
  type AutopilotCaps,
} from './autopilot-actions';
import { taskResultMessage } from './autopilot';

const site: AutopilotCaps = { hasSite: true, connectedPlatforms: [], canEmailOwner: true };
const bare: AutopilotCaps = { hasSite: false, connectedPlatforms: [], canEmailOwner: false };

describe('normalizePlannedTasks', () => {
  test('type inconnu → édition du site (ou article sans site)', () => {
    expect(normalizePlannedTasks([{ type: 'think_hard', title: 'x' }], site)[0].type).toBe('edit_website');
    expect(normalizePlannedTasks([{ type: 'think_hard', title: 'x' }], bare)[0].type).toBe('create_article');
  });

  test('engage_comment supprimé, édition sans site → article, email sans envoi → supprimé', () => {
    const out = normalizePlannedTasks([
      { type: 'engage_comment', title: 'a' },
      { type: 'improve_app', title: 'b' },
      { type: 'send_email', title: 'c' },
    ], bare);
    expect(out.map((t) => t.type)).toEqual(['create_article']);
  });

  test('une seule tâche de réflexion par lot', () => {
    const out = normalizePlannedTasks([
      { type: 'adjust_strategy', title: 'a' },
      { type: 'analyze_metrics', title: 'b' },
      { type: 'edit_website', title: 'c' },
    ], site);
    expect(out.map((t) => t.type)).toEqual(['adjust_strategy', 'edit_website']);
  });

  test('post : bascule sur un réseau connecté', () => {
    const out = normalizePlannedTasks([{ type: 'create_post', platform: 'reddit', title: 'p' }],
      { ...site, connectedPlatforms: ['twitter'] });
    expect(out[0].platform).toBe('twitter');
    expect(out[0].draftOnly).toBeUndefined();
  });

  test('post sans réseau connecté : 1 brouillon max, le reste devient article', () => {
    const out = normalizePlannedTasks([
      { type: 'create_post', title: 'p1' },
      { type: 'create_post', title: 'p2', platform: 'reddit' },
    ], site);
    expect(out[0]).toMatchObject({ type: 'create_post', platform: 'instagram', draftOnly: true });
    expect(out[1].type).toBe('create_article');
    const noSite = normalizePlannedTasks([{ type: 'create_post' }, { type: 'create_post' }], bare);
    expect(noSite.length).toBe(1);
  });

  test('agent attribué, 6 tâches max, entrées invalides ignorées', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ type: 'edit_website', title: `t${i}`, agent: 'robot' }));
    const out = normalizePlannedTasks([null, 'x', ...many], site);
    expect(out.length).toBe(6);
    expect(out[0].agent).toBe('content');
    expect(normalizePlannedTasks('nope', site)).toEqual([]);
    expect(normalizePlannedTasks([{ type: 'create_post' }], site)[0].agent).toBe('marketing');
  });
});

describe('capabilitiesBrief / executableTypes', () => {
  test('dit ce qui est réellement possible', () => {
    const b = capabilitiesBrief(site);
    expect(b).toContain('REALLY edits the live website');
    expect(b).toContain('publishes it on the website');
    expect(b).toContain('ready-to-publish draft');
    expect(b).toContain('FORBIDDEN');
    const nb = capabilitiesBrief({ ...bare, connectedPlatforms: ['twitter'] });
    expect(nb).toContain('NO editable website');
    expect(nb).toContain('REALLY publishes on: twitter');
    expect(nb).not.toContain('send_email');
    expect(executableTypes(bare)).not.toContain('edit_website');
    expect(executableTypes(site)).toContain('send_email');
  });
});

describe('articlePublishInstruction', () => {
  test('contient le texte complet, le titre et la route /blog', () => {
    const txt = articlePublishInstruction({ title: 'Guide du hoodie', content: '# Intro\n\nPremier paragraphe.\n\nDeuxième.', metaDescription: 'Meta' });
    expect(txt).toContain('/blog');
    expect(txt).toContain('TITRE : Guide du hoodie');
    expect(txt).toContain('Premier paragraphe.\n\nDeuxième.');
    expect(txt).toContain('MÉTA DESCRIPTION : Meta');
    expect(txt).toContain('SLUG : guide-du-hoodie');
    expect(txt).toContain('src/lib/blog.ts');
    expect(txt).toContain('AUCUNE API');
    expect(txt).toContain('GARDE les anciens');
    expect(articlePublishInstruction({ title: 't', content: 'c' }, '2026-10-01')).toContain('DATE : 2026-10-01');
    expect(articlePublishInstruction({ title: 't', content: 'c' })).not.toContain('MÉTA DESCRIPTION');
  });

  test('articleSlug', () => {
    expect(articleSlug('Comment bien choisir sa paire de chaussures ?')).toBe('comment-bien-choisir-sa-paire-de-chaussures');
    expect(articleSlug('Été & hiver : quel hoodie ?')).toBe('ete-hiver-quel-hoodie');
    expect(articleSlug('!!!')).toBe('article');
    const long = articleSlug('Comment choisir ses chaussures pour débuter : 7 conseils simples pour trouver la bonne paire');
    expect(long.length).toBeLessThanOrEqual(70);
    expect(long).toBe('comment-choisir-ses-chaussures-pour-debuter-7-conseils-simples-pour');
  });

  test('articleBody retire le H1 répété et les séparateurs', () => {
    expect(articleBody('# Titre\n\nIntro.\n\n---\n\n## 1. Point\n\n- a\n- b')).toBe('Intro.\n\n## 1. Point\n\n- a\n- b');
    expect(articleBody('Pas de titre.\n\n***\n\nSuite.')).toBe('Pas de titre.\n\nSuite.');
  });
});

describe('followUpTasks', () => {
  test('ne garde que des actions (jamais de réflexion), 2 max', () => {
    const out = followUpTasks([
      { type: 'adjust_strategy', title: 'a' },
      { type: 'edit_website', title: 'b' },
      { type: 'create_article', title: 'c' },
      { type: 'create_article', title: 'd' },
    ], site);
    expect(out.map((t) => t.title)).toEqual(['b', 'c']);
    expect(followUpTasks(undefined, site)).toEqual([]);
  });
});

describe('taskResultMessage — livrables concrets', () => {
  test('post en brouillon : le texte est montré', () => {
    const m = taskResultMessage({ type: 'create_post', title: 'P', status: 'completed' },
      { drafted: true, platform: 'instagram', content: 'Nouveau drop ce soir', hashtags: ['streetwear'], reason: 'clés manquantes' });
    expect(m).toContain('brouillon');
    expect(m).toContain('Nouveau drop ce soir');
    expect(m).toContain('#streetwear');
  });
  test('article publié sur le site', () => {
    const m = taskResultMessage({ type: 'create_article', title: 'A', status: 'completed' }, { title: 'Guide', onSite: true, words: 800 });
    expect(m).toContain('publié sur ton site');
    expect(m).toContain('800 mots');
  });
  test('réflexion → actions ajoutées au planning', () => {
    const m = taskResultMessage({ type: 'adjust_strategy', title: 'S', status: 'completed' },
      { assessment: 'ok', followUps: ['Ajouter une bannière offre'] });
    expect(m).toContain("J'ai ajouté ces actions");
    expect(m).toContain('Ajouter une bannière offre');
  });
});
