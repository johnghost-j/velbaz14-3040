import { describe, expect, it, beforeAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STUB_MARKER, STUB_BANNER, isStubSource, isLegacyStubSource, isStubFile, isAuditableSourcePath } from './stub-marker';

// [2026-09-25] BUG : « l'aperçu sort la version squelette et pas le vrai site ».
// L'aperçu en direct pose des pages SQUELETTE sur le disque pour démarrer Vite
// en quelques secondes, puis le vrai code les écrase. Quand cette réécriture
// n'atteint pas le disque (reprise de build, process Vite survivant à un
// redémarrage, écriture finale perdue), le squelette reste servi pour toujours :
// la base contenait le vrai site, l'aperçu public montrait des rectangles
// pulsants. Ces tests verrouillent la détection + l'auto-réparation.

const REAL_PAGE = `import { useState } from "react";
export default function Showroom() {
  const [q, setQ] = useState("");
  return <div className="animate-pulse-none">Vrai contenu du showroom SkyLift</div>;
}
`;

const LEGACY_STUB_PAGE = `export default function Showroom() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-16">
      <span className="text-sm font-medium text-gray-500">Construction de « Showroom »…</span>
      <div className="animate-pulse">
        <div className="h-10 w-1/3 rounded-xl bg-gray-100 dark:bg-gray-800 mb-6" />
      </div>
    </div>
  );
}
`;

const LEGACY_STUB_HEADER = `import { Link } from "react-router-dom";

export default function Header() {
  return (
    <header className="sticky top-0">
      <Link to="/">SkyLift</Link>
      <div className="h-9 w-24 rounded-full bg-gray-100 dark:bg-gray-800 animate-pulse" />
    </header>
  );
}
`;

const LEGACY_STUB_FOOTER = `export default function Footer() {
  return (
    <footer className="border-t border-gray-100 dark:border-gray-800 mt-16">
      <div className="mx-auto max-w-7xl px-4 py-10 text-sm text-gray-400">© 2026 SkyLift</div>
    </footer>
  );
}
`;

describe('marqueur de squelette', () => {
  it('le bandeau porte le marqueur', () => {
    expect(STUB_BANNER).toContain(STUB_MARKER);
  });

  it('reconnaît un fichier marqué et laisse passer le vrai code', () => {
    expect(isStubSource(`${STUB_BANNER}\n${REAL_PAGE}`)).toBe(true);
    expect(isStubSource(REAL_PAGE)).toBe(false);
    expect(isStubSource('')).toBe(false);
    expect(isStubSource(null)).toBe(false);
  });

  it('reconnaît les squelettes des projets construits AVANT le marqueur', () => {
    expect(isLegacyStubSource('src/pages/Showroom.tsx', LEGACY_STUB_PAGE)).toBe(true);
    expect(isLegacyStubSource('src/components/Header.tsx', LEGACY_STUB_HEADER)).toBe(true);
    expect(isLegacyStubSource('src/components/Footer.tsx', LEGACY_STUB_FOOTER)).toBe(true);
  });

  it('ne confond jamais une vraie page/en-tête/pied avec un squelette', () => {
    expect(isLegacyStubSource('src/pages/Showroom.tsx', REAL_PAGE)).toBe(false);
    // Une vraie en-tête générée : longue, avec navigation et logo réels.
    const realHeader = `import { Link } from "react-router-dom";\n${'// contenu réel\n'.repeat(200)}`;
    expect(isStubFile('src/components/Header.tsx', realHeader)).toBe(false);
    const realFooter = `import { Link } from "react-router-dom";\nexport default function Footer(){return <footer className="border-t border-gray-100"><Link to="/terms">CGU</Link></footer>;}`;
    expect(isStubFile('src/components/Footer.tsx', realFooter)).toBe(false);
  });

  it("n'audite que les pages et composants de l'app générée", () => {
    expect(isAuditableSourcePath('src/pages/Showroom.tsx')).toBe(true);
    expect(isAuditableSourcePath('src/components/Header.tsx')).toBe(true);
    expect(isAuditableSourcePath('src/lib/images.ts')).toBe(false);
    expect(isAuditableSourcePath('package.json')).toBe(false);
  });
});

describe("auto-réparation du disque de l'aperçu", () => {
  let root = '';
  let runner: typeof import('./runner');

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'velbaz-apps-'));
    process.env.VELBAZ_APPS_ROOT = root; // lu au chargement du module
    runner = await import('./runner');
  });

  async function seedProject(companyId: string, pages: Record<string, string>) {
    const dir = join(root, companyId);
    await mkdir(join(dir, 'src', 'pages'), { recursive: true });
    await mkdir(join(dir, 'src', 'components'), { recursive: true });
    await writeFile(join(dir, 'package.json'), '{"name":"app"}');
    for (const [rel, content] of Object.entries(pages)) {
      await mkdir(join(dir, rel, '..'), { recursive: true });
      await writeFile(join(dir, rel), content);
    }
    return dir;
  }

  it('repère les squelettes restés sur le disque', async () => {
    const dir = await seedProject('c-list', {
      'src/pages/Showroom.tsx': LEGACY_STUB_PAGE,
      'src/pages/Contact.tsx': `${STUB_BANNER}\n${REAL_PAGE}`,
      'src/pages/Vraie.tsx': REAL_PAGE,
    });
    const stubs = await runner.listStubFilesOnDisk(dir);
    expect(stubs.sort()).toEqual(['src/pages/Contact.tsx', 'src/pages/Showroom.tsx']);
  });

  it('réécrit le vrai code depuis la base et relance le serveur', async () => {
    const companyId = 'c-heal';
    const dir = await seedProject(companyId, { 'src/pages/Showroom.tsx': LEGACY_STUB_PAGE });
    let restarted = 0;
    const healed = await runner.healStalePreviewDisk(
      companyId,
      async () => [{ path: 'src/pages/Showroom.tsx', content: REAL_PAGE }],
      { force: true, restart: async () => { restarted++; } },
    );
    expect(healed).toBe(true);
    expect(restarted).toBe(1);
    expect(await readFile(join(dir, 'src/pages/Showroom.tsx'), 'utf8')).toBe(REAL_PAGE);
    expect(await runner.listStubFilesOnDisk(dir)).toEqual([]);
  });

  it("ne touche à rien quand la base contient elle aussi le squelette (build en cours)", async () => {
    const companyId = 'c-building';
    const dir = await seedProject(companyId, { 'src/pages/Showroom.tsx': LEGACY_STUB_PAGE });
    let restarted = 0;
    const healed = await runner.healStalePreviewDisk(
      companyId,
      async () => [{ path: 'src/pages/Showroom.tsx', content: LEGACY_STUB_PAGE }],
      { force: true, restart: async () => { restarted++; } },
    );
    expect(healed).toBe(false);
    expect(restarted).toBe(0);
    expect(await readFile(join(dir, 'src/pages/Showroom.tsx'), 'utf8')).toBe(LEGACY_STUB_PAGE);
  });

  it('ne lit même pas la base quand le disque est sain', async () => {
    const companyId = 'c-ok';
    await seedProject(companyId, { 'src/pages/Showroom.tsx': REAL_PAGE });
    let dbReads = 0;
    const healed = await runner.healStalePreviewDisk(
      companyId,
      async () => { dbReads++; return [{ path: 'src/pages/Showroom.tsx', content: REAL_PAGE }]; },
      { force: true, restart: async () => {} },
    );
    expect(healed).toBe(false);
    expect(dbReads).toBe(0);
  });

  it('ignore un projet absent du disque (rien à réparer)', async () => {
    const healed = await runner.healStalePreviewDisk(
      'c-inconnu',
      async () => [{ path: 'src/pages/Showroom.tsx', content: REAL_PAGE }],
      { force: true, restart: async () => {} },
    );
    expect(healed).toBe(false);
  });

  it('throttle les audits hors mode forcé', async () => {
    const companyId = 'c-throttle';
    await seedProject(companyId, { 'src/pages/Showroom.tsx': LEGACY_STUB_PAGE });
    const getFiles = async () => [{ path: 'src/pages/Showroom.tsx', content: REAL_PAGE }];
    const first = await runner.healStalePreviewDisk(companyId, getFiles, { restart: async () => {} });
    const second = await runner.healStalePreviewDisk(companyId, getFiles, { restart: async () => {} });
    expect(first).toBe(true);
    expect(second).toBe(false); // deuxième appel dans la fenêtre de throttling
  });
});

describe('câblage du correctif (anti-régression)', () => {
  const engine = readFileSync(new URL('./engine.ts', import.meta.url), 'utf8');
  const routes = readFileSync(new URL('./routes.ts', import.meta.url), 'utf8');
  const api = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

  it('les trois squelettes du moteur portent le bandeau marqueur', () => {
    for (const fn of ['function STUB_HEADER', 'function STUB_FOOTER', 'function STUB_PAGE']) {
      const i = engine.indexOf(fn);
      expect(i).toBeGreaterThan(-1);
      expect(engine.slice(i, i + 600)).toContain('${STUB_BANNER}');
    }
  });

  it("le proxy d'aperçu audite le disque même quand le serveur est vivant", () => {
    const i = routes.indexOf('if (getRunningApp(companyId)) {');
    expect(i).toBeGreaterThan(-1);
    expect(routes.slice(i, i + 300)).toContain('healStalePreviewDisk(companyId');
  });

  it('le redémarrage explicite de l’aperçu force la réparation', () => {
    const i = routes.indexOf("builder.post(\"/companies/:id/preview/start\"");
    expect(i).toBeGreaterThan(-1);
    const block = routes.slice(i, i + 2000);
    expect(block).toContain('healStalePreviewDisk(companyId');
    expect(block).toContain('force: true');
  });

  it('la fin du build vérifie qu’aucun squelette ne reste sur le disque', () => {
    expect(api).toContain('listStubFilesOnDisk');
    const i = api.indexOf('let stubsLeft = await listStubFilesOnDisk(dir)');
    expect(i).toBeGreaterThan(-1);
    const block = api.slice(i, i + 1400);
    expect(block).toContain('writeFilesIncremental(companyId, filesWithMeta)');
    expect(block).toContain('writeFilesToDisk(companyId, filesWithMeta)');
  });

  it("le jeu d'amorçage réécrit une page restaurée qui est elle-même un squelette", () => {
    expect(engine).toContain('isStubSource(existing)');
  });
});
