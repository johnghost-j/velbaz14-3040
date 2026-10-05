import { describe, it, expect } from 'bun:test';
import {
  hexToHsl,
  isDarkBackground,
  isAiSignaturePalette,
  userAskedForAiColors,
  deAiPalette,
  analyzeAiSmell,
  buildAntiAiSmellInstruction,
  HUMAN_PALETTES,
  AI_SMELL_RULES,
  stripAiColors,
} from './anti-ai-smell';

// Extrait FIDÈLE d'une page réellement produite par le pipeline (projet
// "PixelNova", src/pages/Showroom.tsx lu en base). C'est le cas réel qui a
// motivé ce module: la page passait la QA fonctionnelle et la densité, tout en
// cumulant les signatures IA ci-dessous.
// Vérifié sur le fichier réel: palette #7C3AED/#06B6D4 en dur, titre en
// bg-clip-text, <Sparkles /> décoratif, badge pilule majuscules, halo
// `0 0 80px rgba(124,58,237,.15)`, 5 sections toutes centrées au même py-24,
// 11 `rounded-full`, et le CTA « Prêt à composer votre machine ? ».
// NB: ce projet-là n'inventait PAS de statistiques ; les faux chiffres sont
// testés à part, sur FAKE_PROOF_PAGE, pour ne pas prêter au fichier réel un
// défaut qu'il n'avait pas.
const REAL_GENERATED_PAGE = `import { useState, useEffect } from "react";
import { Cpu, Battery, Wrench, ArrowRight, Sparkles } from "lucide-react";

export default function Showroom() {
  const [activeFilter, setActiveFilter] = useState("all");
  return (
    <div className="bg-[#0B0A14] text-[#EDE9FA] min-h-screen">
      <section className="relative min-h-[92vh] flex flex-col items-center justify-center text-center px-6 py-24">
        <div aria-hidden className="absolute inset-0" style={{ backgroundImage: "radial-gradient(60% 60% at 15% 10%, rgba(124,58,237,0.18) 0%, transparent 60%)" }} />
        <span className="inline-flex items-center gap-2 text-xs font-semibold tracking-widest uppercase text-[#7C3AED] border border-[#7C3AED]/30 bg-[#7C3AED]/10 px-4 py-1.5 rounded-full mb-8">
          <Sparkles size={12} />
          Showroom 2026
        </span>
        <h1 className="font-bold tracking-[-0.03em]">
          L'ordinateur pensé{" "}
          <span className="text-transparent bg-clip-text" style={{ backgroundImage: "linear-gradient(135deg, #7C3AED 0%, #06B6D4 100%)" }}>
            pour vous.
          </span>
        </h1>
        <div className="relative mx-auto max-w-2xl rounded-2xl overflow-hidden" style={{ boxShadow: "0 0 80px rgba(124,58,237,0.15)" }}>
          <img src="/hero.png" alt="PixelNova" className="w-full object-cover hover:scale-105" />
        </div>
      </section>
      <section className="px-6 py-24 text-center">
        <h2 className="font-bold">
          Nos modèles
        </h2>
        <p>
          Chaque ligne est taillée pour un usage précis. Quel est le vôtre ?
        </p>
      </section>
      <section className="px-6 py-24 text-center">
        <button className="inline-flex items-center gap-2 px-5 py-2 rounded-full text-sm font-medium border focus:ring-2 focus:ring-violet-500/60">
          Tous
        </button>
        <div className="grid grid-cols-3 gap-6">
          <div className="rounded-2xl border border-white/8 hover:scale-105">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-cyan-400/30 bg-cyan-400/10 text-cyan-400">
              En stock
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-violet-400/30 bg-violet-400/10 text-violet-400">
              Sur commande
            </span>
            <button className="inline-flex items-center gap-1.5 bg-[#7C3AED] text-white px-4 py-2 rounded-full hover:scale-105">
              Configurer
            </button>
          </div>
        </div>
      </section>
      <section className="px-6 py-24 text-center">
        <p>
          Aucun modèle pour ce filtre pour l'instant.
        </p>
      </section>
      <section className="px-6 py-24 text-center">
        <h2>
          Prêt à composer votre machine ?
        </h2>
        <p>
          Choisissez votre modèle de base, personnalisez chaque spec, réservez un essai en showroom.
        </p>
        <button className="inline-flex items-center gap-2 bg-[#7C3AED] text-white font-semibold px-8 py-3 rounded-full transition-all duration-200">
          Démarrer la config
        </button>
        <a className="inline-flex items-center gap-2 border border-[#2A2640] text-[#EDE9FA] font-medium px-8 py-3 rounded-full transition-all duration-200">
          Réserver un essai
        </a>
      </section>
    </div>
  );
}`;

// Fixture SYNTHÉTIQUE (assumée comme telle): bloc de preuve sociale inventée,
// tel que les générateurs en produisent quand rien ne le leur interdit. Sert
// uniquement à couvrir FAKE_PROOF.
const FAKE_PROOF_PAGE = `export default function Landing() {
  return (
    <section className="px-6 py-20">
      <div className="grid grid-cols-4 gap-6">
        <div><strong>10 000+ clients</strong></div>
        <div><strong>98% de satisfaction</strong></div>
        <div><strong>4,9/5</strong><span>★★★★★</span></div>
        <div><strong>2 500+ utilisateurs</strong></div>
      </div>
    </section>
  );
}`;

// Page équivalente en contenu/fonction, mais écrite comme un studio l'écrirait.
const HUMAN_LOOKING_PAGE = `import { useState, useEffect } from "react";
import { Truck, Wrench, Clock } from "lucide-react";
import { data } from "../lib/api";

export default function Showroom() {
  const [machines, setMachines] = useState([]);
  useEffect(() => { data.list("computers").then(setMachines); }, []);
  return (
    <div className="bg-[#0B0D0E] text-[#E9EDEF] min-h-screen">
      <section className="grid lg:grid-cols-12 gap-10 px-6 py-32 max-w-7xl mx-auto">
        <div className="lg:col-span-5">
          <p className="text-sm text-[#8A949B]">Atelier d'assemblage, Liège — ouvert depuis 2014</p>
          <h1 className="text-[#E9EDEF] font-semibold tracking-tight leading-[1.05] text-5xl">
            Des machines assemblées à la commande, réparables au tournevis.
          </h1>
          <p className="text-[#8A949B] leading-relaxed">
            Chaque configuration part de l'atelier avec son schéma de démontage et dix ans de pièces garanties.
          </p>
          <a href="/configurateur" className="inline-flex items-center gap-2 rounded-lg bg-[#E8552D] px-6 py-3 text-white">
            Composer ma configuration
          </a>
        </div>
        <div className="lg:col-span-7">
          <img src="/atelier.jpg" alt="Poste d'assemblage" className="w-full rounded-lg border border-[#242A2E]" />
        </div>
      </section>
      <section className="px-6 py-20 border-t border-[#242A2E]">
        <h2 className="text-[#E9EDEF] font-semibold">Ce que comprend l'assemblage</h2>
        <ul className="grid md:grid-cols-3 gap-6 text-[#8A949B]">
          <li><Wrench size={18} /> Tests de charge 48 h avant expédition</li>
          <li><Truck size={18} /> Livraison en Belgique sous 5 jours ouvrables</li>
          <li><Clock size={18} /> Pièces détachées garanties dix ans</li>
        </ul>
      </section>
      <section className="px-6 py-40 max-w-3xl">
        <h2 className="text-[#E9EDEF] font-semibold">Délais par type de configuration</h2>
        <p className="text-[#8A949B]">Station 3D : 7 jours. Portable bureautique : 3 jours. Serveur sur mesure : devis sous 48 h.</p>
      </section>
    </div>
  );
}`;

describe('hexToHsl', () => {
  it('convertit les hex valides', () => {
    expect(hexToHsl('#FFFFFF')).toEqual({ h: 0, s: 0, l: 100 });
    expect(hexToHsl('#000000')).toEqual({ h: 0, s: 0, l: 0 });
    const violet = hexToHsl('#7C3AED')!;
    expect(violet.h).toBeGreaterThan(255);
    expect(violet.h).toBeLessThan(275);
  });

  it('accepte la forme courte et rejette le reste sans planter', () => {
    expect(hexToHsl('#fff')).toEqual({ h: 0, s: 0, l: 100 });
    expect(hexToHsl('rgb(0,0,0)')).toBeNull();
    expect(hexToHsl('')).toBeNull();
    expect(hexToHsl(undefined)).toBeNull();
    expect(hexToHsl(null)).toBeNull();
  });
});

describe('isDarkBackground', () => {
  it('distingue les fonds sombres des fonds clairs', () => {
    expect(isDarkBackground('#0B0A14')).toBe(true);
    expect(isDarkBackground('#FAF7F2')).toBe(false);
    expect(isDarkBackground(undefined)).toBe(false);
  });
});

describe('isAiSignaturePalette', () => {
  it('détecte le dégradé violet→cyan (la signature n°1)', () => {
    const v = isAiSignaturePalette({ primary: '#7C3AED', accent: '#06B6D4' });
    expect(v.hit).toBe(true);
    expect(v.reasons[0]).toContain('violet→cyan');
  });

  it('détecte un simple accent violet/indigo', () => {
    expect(isAiSignaturePalette({ primary: '#111827', accent: '#6366F1' }).hit).toBe(true);
    expect(isAiSignaturePalette({ primary: '#111827', accent: '#8B5CF6' }).hit).toBe(true);
  });

  it("laisse passer une palette singulière", () => {
    expect(isAiSignaturePalette({ primary: '#17140F', accent: '#B4531F' }).hit).toBe(false);
    expect(isAiSignaturePalette({ primary: '#10192B', accent: '#1F4E79' }).hit).toBe(false);
    expect(isAiSignaturePalette({ primary: '#E9EDEF', accent: '#E8552D' }).hit).toBe(false);
  });

  it('ne plante pas sans couleurs', () => {
    expect(isAiSignaturePalette(undefined).hit).toBe(false);
    expect(isAiSignaturePalette({}).hit).toBe(false);
  });
});

describe('deAiPalette', () => {
  it('remplace la palette violet→cyan par une palette humaine du même ton', () => {
    const design = {
      colors: { primary: '#7C3AED', accent: '#06B6D4', background: '#0B0A14', surface: '#13111F', text: '#EDE9FA', muted: '#6E6A8A', border: '#2A2640' },
      designNotes: 'Futuriste.',
    };
    const out = deAiPalette(design, { companyName: 'PixelNova', industry: 'informatique', idea: 'ordinateurs configurables et réparables' });
    expect(out.changed).toBe(true);
    expect(out.palette!.tone).toBe('dark');                       // tonalité préservée
    expect(isAiSignaturePalette(out.design.colors).hit).toBe(false);
    expect(out.design.designNotes).toContain(out.palette!.name);
    expect(out.reason).toContain('violet');
  });

  it("choisit une palette cohérente avec le secteur", () => {
    const dark = { colors: { primary: '#8B5CF6', accent: '#22D3EE', background: '#0B0A14' } };
    const tech = deAiPalette(dark, { companyName: 'PixelNova', industry: 'informatique', idea: 'assemblage d ordinateurs' });
    expect(tech.palette!.sectors.some((s) => 'informatique assemblage d ordinateurs'.includes(s))).toBe(true);

    const light = { colors: { primary: '#6366F1', accent: '#6366F1', background: '#FFFFFF' } };
    const food = deAiPalette(light, { companyName: 'Verger Dupont', industry: 'alimentaire', idea: 'jus bio pressés à froid' });
    expect(food.palette!.tone).toBe('light');
    expect(food.palette!.sectors.some((s) => 'alimentaire jus bio'.includes(s))).toBe(true);
  });

  it('est déterministe: deux builds du même projet donnent la même palette', () => {
    const design = { colors: { primary: '#7C3AED', accent: '#06B6D4', background: '#0B0A14' } };
    const a = deAiPalette(design, { companyName: 'Acme', idea: 'idée' });
    const b = deAiPalette(design, { companyName: 'Acme', idea: 'idée' });
    expect(a.palette!.name).toBe(b.palette!.name);
  });

  it("ne touche à rien si l'utilisateur a demandé du violet", () => {
    const design = { colors: { primary: '#7C3AED', accent: '#06B6D4', background: '#0B0A14' } };
    const out = deAiPalette(design, { companyName: 'Acme', idea: 'un site violet et cyan pour ma marque' });
    expect(out.changed).toBe(false);
    expect(out.design.colors!.accent).toBe('#06B6D4');
  });

  it('ne touche à rien si la palette est déjà singulière', () => {
    const design = { colors: { primary: '#17140F', accent: '#B4531F', background: '#FAF7F2' } };
    const out = deAiPalette(design, { companyName: 'Acme' });
    expect(out.changed).toBe(false);
    expect(out.design).toBe(design);
  });

  it('ne plante pas sur un design vide', () => {
    expect(deAiPalette({}, {}).changed).toBe(false);
  });

  it("toutes les palettes de remplacement sont elles-mêmes propres", () => {
    for (const p of HUMAN_PALETTES) {
      expect(isAiSignaturePalette(p.colors).hit).toBe(false);
      for (const [k, v] of Object.entries(p.colors)) {
        expect(hexToHsl(v), `${p.name}.${k}`).not.toBeNull();
      }
      expect(isDarkBackground(p.colors.background)).toBe(p.tone === 'dark');
    }
    expect(HUMAN_PALETTES.filter((p) => p.tone === 'light').length).toBeGreaterThanOrEqual(3);
    expect(HUMAN_PALETTES.filter((p) => p.tone === 'dark').length).toBeGreaterThanOrEqual(3);
  });
});

describe('userAskedForAiColors', () => {
  it('reconnaît une demande explicite', () => {
    expect(userAskedForAiColors('je veux du violet')).toBe(true);
    expect(userAskedForAiColors('palette turquoise')).toBe(true);
    expect(userAskedForAiColors('un site sobre et élégant')).toBe(false);
    expect(userAskedForAiColors(undefined)).toBe(false);
  });
});

describe('analyzeAiSmell — page réellement générée par le pipeline', () => {
  const report = analyzeAiSmell('Showroom.tsx', REAL_GENERATED_PAGE);

  it('la déclare porteuse de la signature IA', () => {
    expect(report.smelly).toBe(true);
    expect(report.score).toBeLessThan(50);
  });

  it('nomme les défauts un par un', () => {
    const codes = report.issues.map((i) => i.code);
    expect(codes).toContain('AI_PALETTE');     // #7C3AED + #06B6D4 en dur
    expect(codes).toContain('GRADIENT_TEXT');  // bg-clip-text sur le H1
    expect(codes).toContain('AI_ICON');        // <Sparkles />
    expect(codes).toContain('AI_EYEBROW');     // badge pilule majuscules
    expect(codes).toContain('AI_GLOW');        // 0 0 80px rgba(124,58,237)
    expect(codes).toContain('AI_SYMMETRY');    // 4 sections, tout centré
    expect(codes).toContain('AI_COPY');        // « Prêt à composer votre machine ? »
    expect(codes).toContain('AI_PILLS');       // 7 rounded-full (11 dans le fichier complet)
  });

  it("ne lui invente pas de faux chiffres: ce projet-là n'en avait pas", () => {
    expect(report.issues.map((i) => i.code)).not.toContain('FAKE_PROOF');
  });

  it('repère les formules exactes du texte', () => {
    const copy = report.issues.find((i) => i.code === 'AI_COPY')!;
    expect(copy.message).toContain('Prêt à');
    expect(copy.count).toBeGreaterThanOrEqual(1);
  });

  // Le détecteur doit lire le texte tel que prettier le formate: contenu seul
  // sur sa ligne, entre `>` et `</`. C'est ce qui lui manquait au départ.
  it('lit le texte même quand le JSX est formaté sur plusieurs lignes', () => {
    const multiline = `<section className="py-20">
      <h2>
        Prêt à transformer votre entreprise ?
      </h2>
    </section>`;
    const codes = analyzeAiSmell('X.tsx', multiline).issues.map((i) => i.code);
    expect(codes).toContain('AI_COPY');
  });

  it("produit une instruction de correction exploitable", () => {
    const instr = buildAntiAiSmellInstruction(report);
    expect(instr).toContain(`${report.score}/100`);
    expect(instr).toContain('bg-clip-text');
    expect(instr).toContain('asymétrique');
    expect(instr).toContain('data.*');           // interdiction de casser le câblage
    expect(instr.split('\n').length).toBeGreaterThan(8);
    // Les défauts graves passent avant les mineurs.
    expect(instr.indexOf('[HIGH]')).toBeLessThan(instr.indexOf('[LOW]'));
  });
});

describe('FAKE_PROOF (fixture synthétique)', () => {
  it('repère les chiffres, notes et étoiles inventés', () => {
    const report = analyzeAiSmell('Landing.tsx', FAKE_PROOF_PAGE);
    const proof = report.issues.find((i) => i.code === 'FAKE_PROOF');
    expect(proof).toBeTruthy();
    expect(proof!.count).toBeGreaterThanOrEqual(4);
    expect(report.smelly).toBe(true);
  });
});

describe('analyzeAiSmell — page écrite comme par un studio', () => {
  const report = analyzeAiSmell('Showroom.tsx', HUMAN_LOOKING_PAGE, {
    paletteHexes: ['#0B0D0E', '#E9EDEF', '#E8552D', '#8A949B', '#242A2E'],
  });

  it('la laisse passer', () => {
    expect(report.smelly).toBe(false);
    expect(report.score).toBeGreaterThanOrEqual(85);
  });

  it("ne signale ni palette, ni dégradé de titre, ni faux chiffres", () => {
    const codes = report.issues.map((i) => i.code);
    expect(codes).not.toContain('AI_PALETTE');
    expect(codes).not.toContain('GRADIENT_TEXT');
    expect(codes).not.toContain('FAKE_PROOF');
    expect(codes).not.toContain('AI_COPY');
    expect(codes).not.toContain('AI_SYMMETRY');
  });
});

describe('analyzeAiSmell — garde-fous', () => {
  it("n'accuse pas une marque dont le violet est le token officiel", () => {
    const code = `export default () => <div className="bg-[#7C3AED] text-[#06B6D4]"><button className="bg-[#7C3AED]">Réserver</button></div>;`;
    const withPalette = analyzeAiSmell('P.tsx', code, { paletteHexes: ['#7C3AED', '#06B6D4'] });
    expect(withPalette.issues.map((i) => i.code)).not.toContain('AI_PALETTE');
    const withoutPalette = analyzeAiSmell('P.tsx', code, { paletteHexes: ['#17140F', '#B4531F'] });
    expect(withoutPalette.issues.map((i) => i.code)).toContain('AI_PALETTE');
  });

  it('ne signale pas un emoji isolé, mais signale une interface en emoji', () => {
    const one = analyzeAiSmell('P.tsx', `export default () => <p>Livré 🚚 sous 48 h</p>;`);
    expect(one.issues.map((i) => i.code)).not.toContain('AI_EMOJI');
    const many = analyzeAiSmell('P.tsx', `export default () => <div><p>🚀 Rapide</p><p>✨ Beau</p><p>🎯 Précis</p><p>💡 Malin</p></div>;`);
    expect(many.issues.map((i) => i.code)).toContain('AI_EMOJI');
  });

  it('ne signale pas un seul hover:scale (zoom d’image légitime)', () => {
    const code = `export default () => <img src="/a.jpg" alt="a" className="hover:scale-105" />;`;
    expect(analyzeAiSmell('P.tsx', code).issues.map((i) => i.code)).not.toContain('AI_HOVER');
  });

  it('ignore ce qui est en commentaire', () => {
    const code = `// TODO: éviter bg-clip-text et Sparkles ici\nexport default () => <div>Assemblage à Liège</div>;`;
    const codes = analyzeAiSmell('P.tsx', code).issues.map((i) => i.code);
    expect(codes).not.toContain('GRADIENT_TEXT');
  });

  it('page vide = score parfait, aucun plantage', () => {
    const r = analyzeAiSmell('P.tsx', '');
    expect(r.score).toBe(100);
    expect(r.smelly).toBe(false);
    expect(r.issues).toEqual([]);
  });

  it('le score reste borné entre 0 et 100', () => {
    const awful = REAL_GENERATED_PAGE.repeat(4);
    const r = analyzeAiSmell('P.tsx', awful);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });
});

describe('AI_SMELL_RULES', () => {
  it('interdit nommément les clichés mesurés dans la vraie page générée', () => {
    for (const needle of ['violet', 'bg-clip-text', 'Sparkles', 'MAJUSCULES', 'Prêt à', 'Nos services', 'ASYMÉTRIQUE', 'jamais inventé']) {
      expect(AI_SMELL_RULES).toContain(needle);
    }
  });

  it("laisse la priorité à une demande explicite de l'utilisateur", () => {
    expect(AI_SMELL_RULES).toContain('sauf demande explicite');
  });
});

describe('stripAiColors', () => {
  const PAL = { primary: '#1A1413', accent: '#B3261E', border: '#E4DED8' };

  it('remplace un hex violet codé en dur par la couleur de marque', () => {
    const r = stripAiColors('<div style={{ color: "#7C3AED" }} />', PAL);
    expect(r.replaced).toBe(1);
    expect(r.code).toContain('#B3261E');
    expect(r.code).not.toContain('#7C3AED');
  });

  it('remplace aussi le cyan de la paire violet/cyan', () => {
    const r = stripAiColors('const g = "linear-gradient(90deg,#7C3AED,#06B6D4)";', PAL);
    expect(r.replaced).toBe(2);
    expect(r.code).not.toContain('#06B6D4');
  });

  it('remplace les classes Tailwind violet/cyan en conservant utilitaire et opacité', () => {
    const r = stripAiColors('<p className="text-violet-500 bg-cyan-400/30 border-purple-600">x</p>', PAL);
    expect(r.replaced).toBe(3);
    expect(r.code).toContain('text-[#B3261E]');
    expect(r.code).toContain('bg-[#B3261E]/30');
    expect(r.code).toContain('border-[#B3261E]');
  });

  it('couvre les utilitaires de dégradé (from/via/to)', () => {
    const r = stripAiColors('className="bg-gradient-to-r from-violet-600 via-fuchsia-500 to-cyan-400"', PAL);
    expect(r.replaced).toBe(3);
    expect(r.code).not.toMatch(/(violet|fuchsia|cyan)-\d/);
  });

  it('respecte la palette: ne touche pas un violet qui EST la couleur de marque', () => {
    const brandViolet = { primary: '#2E1065', accent: '#7C3AED' };
    const r = stripAiColors('<div className="text-white" style={{ background: "#7C3AED" }} />', brandViolet);
    expect(r.replaced).toBe(0);
    expect(r.code).toContain('#7C3AED');
  });

  it('remplace les rgba() de halo en conservant l’alpha', () => {
    const r = stripAiColors('style={{ boxShadow: "0 0 80px rgba(124,58,237,0.15)" }}', PAL);
    expect(r.replaced).toBe(1);
    expect(r.code).toContain('rgba(179, 38, 30');
    expect(r.code).toContain('0.15');
    expect(r.code).not.toContain('124');
  });

  it('laisse intactes les couleurs neutres et non-signature', () => {
    const src = '<div className="bg-stone-100 text-emerald-700" style={{ color: "#1A1413", border: "1px solid rgba(0,0,0,0.08)" }} />';
    const r = stripAiColors(src, PAL);
    expect(r.replaced).toBe(0);
    expect(r.code).toBe(src);
  });

  it('est neutre sur du code déjà propre', () => {
    const r = stripAiColors(HUMAN_LOOKING_PAGE, PAL);
    expect(r.replaced).toBe(0);
    expect(r.code).toBe(HUMAN_LOOKING_PAGE);
  });

  it('ne fait rien sans couleur de remplacement valable', () => {
    const src = 'className="text-violet-500"';
    expect(stripAiColors(src, {}).replaced).toBe(0);
    expect(stripAiColors(src, { accent: 'rouge' }).code).toBe(src);
  });

  it('fait tomber AI_PALETTE sur la vraie page générée', () => {
    const before = analyzeAiSmell('src/pages/Showroom.tsx', REAL_GENERATED_PAGE, { paletteHexes: [PAL.accent, PAL.primary] });
    expect(before.issues.some((i) => i.code === 'AI_PALETTE')).toBe(true);
    const r = stripAiColors(REAL_GENERATED_PAGE, PAL);
    expect(r.replaced).toBeGreaterThan(3);
    const after = analyzeAiSmell('src/pages/Showroom.tsx', r.code, { paletteHexes: [PAL.accent, PAL.primary] });
    expect(after.issues.some((i) => i.code === 'AI_PALETTE')).toBe(false);
    expect(after.score).toBeGreaterThan(before.score);
  });
});
