// ─── Application d'un correctif : instantané, écriture, vérification, retour ─
//
// Le seul endroit du système qui écrit dans le code source de Velbaz.
// Séquence non négociable, dans cet ordre :
//
//   instantané → écriture → typecheck → tests → contrôle HTTP réel
//        └────────── si UNE étape échoue : restauration de l'instantané ──────┘
//
// L'instantané vit HORS du dépôt (~/.velbaz-selfheal) : il ne peut donc pas
// être emporté par le correctif lui-même, ni faire réagir `bun run lint`.
//
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { REPO_ROOT, type PatchEdit } from './guard';

const WEB_DIR = path.join(REPO_ROOT, 'packages/web');
const SNAPSHOT_ROOT = '/home/user/.velbaz-selfheal/snapshots';
const STEP_TIMEOUT_MS = 180_000;

export interface StepResult {
  ok: boolean;
  durationMs: number;
  output: string;
}

export interface Verification {
  typecheck: StepResult;
  tests: StepResult;
  http: StepResult;
  ok: boolean;
}

export interface ApplyOutcome {
  applied: boolean;
  rolledBack: boolean;
  reason: string | null;
  verification: Verification | null;
  filesTouched: string[];
}

// ── Exécution d'une commande, sortie plafonnée ──────────────────────────────

function run(cmd: string, args: string[], cwd: string, timeoutMs = STEP_TIMEOUT_MS): Promise<StepResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(cmd, args, { cwd, env: { ...process.env } });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* déjà mort */ }
      resolve({ ok: false, durationMs: Date.now() - started, output: `${out}\n[délai dépassé après ${timeoutMs} ms]`.slice(-8000) });
    }, timeoutMs);
    const push = (b: Buffer) => { if (out.length < 40_000) out += b.toString(); };
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, durationMs: Date.now() - started, output: `échec de lancement : ${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, durationMs: Date.now() - started, output: out.slice(-8000) });
    });
  });
}

// ── Instantané / restauration ───────────────────────────────────────────────

/** Copie les fichiers visés dans ~/.velbaz-selfheal/snapshots/<attemptId>/. */
export async function snapshot(attemptId: string, files: string[]): Promise<string> {
  const dir = path.join(SNAPSHOT_ROOT, attemptId);
  for (const rel of files) {
    const src = path.join(REPO_ROOT, rel);
    const dest = path.join(dir, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await cp(src, dest);
  }
  return dir;
}

/** Remet les fichiers de l'instantané en place. Ne doit jamais échouer à moitié. */
export async function restore(attemptId: string, files: string[]): Promise<void> {
  const dir = path.join(SNAPSHOT_ROOT, attemptId);
  const errors: string[] = [];
  for (const rel of files) {
    try {
      const saved = await readFile(path.join(dir, rel), 'utf8');
      await writeFile(path.join(REPO_ROOT, rel), saved, 'utf8');
    } catch (e: any) {
      errors.push(`${rel}: ${e?.message || e}`);
    }
  }
  if (errors.length) {
    // Situation la plus grave possible : le code est patché et non restaurable.
    // On hurle dans les journaux, l'instantané reste sur disque pour la main.
    console.error(`[selfheal] RESTAURATION INCOMPLÈTE (${dir}) : ${errors.join(' | ')}`);
    throw new Error(`restauration incomplète : ${errors.join(' | ')}`);
  }
}

// ── Écriture du correctif ───────────────────────────────────────────────────

/**
 * Remplacement littéral, une occurrence EXACTE et UNIQUE par édition.
 * Pas de diff flou, pas de regex : si le texte n'est pas trouvé tel quel, ou
 * qu'il apparaît deux fois, on refuse — on ne devine pas où patcher.
 */
export async function applyEdits(edits: PatchEdit[]): Promise<{ ok: true } | { ok: false; reason: string }> {
  // Phase 1 : tout valider en mémoire avant d'écrire quoi que ce soit.
  const planned: { abs: string; content: string }[] = [];
  const byFile = new Map<string, string>();

  for (const e of edits) {
    const abs = path.join(REPO_ROOT, e.file);
    let content = byFile.get(e.file);
    if (content === undefined) {
      try { content = await readFile(abs, 'utf8'); }
      catch (err: any) { return { ok: false, reason: `lecture impossible de ${e.file} : ${err?.message}` }; }
    }
    if (!e.old) return { ok: false, reason: `édition sans texte d'origine (${e.file})` };
    const first = content.indexOf(e.old);
    if (first === -1) return { ok: false, reason: `texte d'origine introuvable dans ${e.file}` };
    if (content.indexOf(e.old, first + 1) !== -1) {
      return { ok: false, reason: `texte d'origine ambigu (plusieurs occurrences) dans ${e.file}` };
    }
    content = content.slice(0, first) + e.new + content.slice(first + e.old.length);
    byFile.set(e.file, content);
  }

  for (const [file, content] of byFile) {
    planned.push({ abs: path.join(REPO_ROOT, file), content });
  }

  // Phase 2 : écriture.
  for (const p of planned) await writeFile(p.abs, p.content, 'utf8');
  return { ok: true };
}

// ── Vérification ────────────────────────────────────────────────────────────

/**
 * Trois preuves indépendantes que le correctif n'a rien cassé :
 *   1. le code compile encore (tsc sur tout src/api) ;
 *   2. la suite de tests passe (elle sert de garde-fou de régression) ;
 *   3. le serveur répond vraiment en HTTP (Vite a rechargé sans exploser).
 *
 * `bun test` est utilisé, pas `bun run test` : le dépôt écrit ses tests avec
 * `bun:test`, que le script vitest du package.json ne sait pas importer.
 */
export async function verify(): Promise<Verification> {
  const typecheck = await run('./node_modules/.bin/tsc', ['-p', 'tsconfig.api.json', '--noEmit'], WEB_DIR);
  if (!typecheck.ok) {
    const skipped: StepResult = { ok: false, durationMs: 0, output: 'non exécuté (typecheck en échec)' };
    return { typecheck, tests: skipped, http: skipped, ok: false };
  }

  const tests = await run('bun', ['--env-file=../../.env', 'test'], WEB_DIR);
  if (!tests.ok) {
    const skipped: StepResult = { ok: false, durationMs: 0, output: 'non exécuté (tests en échec)' };
    return { typecheck, tests, http: skipped, ok: false };
  }

  const http = await httpProbe();
  return { typecheck, tests, http, ok: typecheck.ok && tests.ok && http.ok };
}

/**
 * Le serveur répond-il encore ? Vite recharge le module patché à chaud : si le
 * correctif produit une erreur à l'évaluation, c'est ici qu'on la voit — ce
 * qu'aucun typecheck ni test unitaire ne peut attraper.
 */
export async function httpProbe(attempts = 12): Promise<StepResult> {
  const started = Date.now();
  // Le serveur Vite n'écoute que sur la loopback IPv6 ([::1]) : `127.0.0.1`
  // échoue silencieusement et ferait passer une annulation pour un plantage.
  const port = process.env.PORT || '4200';
  const url = `http://localhost:${port}/api/health`;
  let last = '';
  for (let i = 0; i < attempts; i++) {
    // Laisser à Vite le temps d'invalider et de réévaluer le module patché.
    await new Promise(r => setTimeout(r, i === 0 ? 2000 : 3000));
    // `curl` en sous-processus, et non `fetch` : quand cette vérification tourne
    // DANS le serveur lui-même, le dispatcher undici global installé par
    // index.ts (cache DNS + keep-alive) fait échouer l'appel vers la loopback —
    // un correctif parfaitement valide se faisait annuler à cause de ça.
    // Un vrai processus client teste aussi exactement ce qu'un visiteur voit.
    const r = await run('curl', ['-s', '-m', '8', '-o', '/dev/stdout', '-w', '\n%{http_code}', url], WEB_DIR, 12_000);
    const lines = r.output.trim().split('\n');
    const code = lines.pop()?.trim() || '000';
    const body = lines.join('\n').slice(0, 500);
    if (code.startsWith('2')) {
      return { ok: true, durationMs: Date.now() - started, output: `HTTP ${code} ${url} → ${body}` };
    }
    last = code === '000' ? `aucune réponse (curl : ${r.output.trim().slice(0, 200) || 'connexion refusée'})` : `HTTP ${code} → ${body}`;
  }
  return { ok: false, durationMs: Date.now() - started, output: `serveur muet après ${attempts} essais : ${last}` };
}

// ── Enchaînement complet ────────────────────────────────────────────────────

/**
 * Instantané → écriture → vérification → conservation ou restauration.
 * Ne lève pas : renvoie toujours un verdict exploitable.
 */
export async function applyWithRollback(attemptId: string, edits: PatchEdit[]): Promise<ApplyOutcome> {
  const files = [...new Set(edits.map(e => e.file))];

  try {
    await snapshot(attemptId, files);
  } catch (e: any) {
    return { applied: false, rolledBack: false, reason: `instantané impossible : ${e?.message || e}`, verification: null, filesTouched: files };
  }

  const written = await applyEdits(edits);
  if (!written.ok) {
    return { applied: false, rolledBack: false, reason: written.reason, verification: null, filesTouched: files };
  }

  let verification: Verification | null = null;
  try {
    verification = await verify();
  } catch (e: any) {
    verification = null;
  }

  if (!verification || !verification.ok) {
    const failed = !verification ? 'vérification impossible'
      : !verification.typecheck.ok ? 'typecheck en échec'
      : !verification.tests.ok ? 'tests en échec'
      : 'serveur ne répond plus';
    try {
      await restore(attemptId, files);
      // Le serveur doit revenir : on le confirme au lieu de le supposer.
      const back = await httpProbe(5);
      return {
        applied: false, rolledBack: true,
        reason: back.ok ? `${failed} → correctif annulé, serveur rétabli`
                        : `${failed} → correctif annulé, MAIS le serveur ne répond pas (${back.output})`,
        verification, filesTouched: files,
      };
    } catch (e: any) {
      return {
        applied: false, rolledBack: false,
        reason: `${failed} → ÉCHEC DE L'ANNULATION : ${e?.message || e} — instantané conservé dans ${path.join(SNAPSHOT_ROOT, attemptId)}`,
        verification, filesTouched: files,
      };
    }
  }

  return { applied: true, rolledBack: false, reason: null, verification, filesTouched: files };
}

/** Extrait de fichier autour d'une ligne, pour le prompt de diagnostic. */
export async function readContext(file: string, line: number | null, radius = 60): Promise<string> {
  const abs = path.join(REPO_ROOT, file);
  const content = await readFile(abs, 'utf8');
  const lines = content.split('\n');
  if (line === null) return lines.slice(0, radius * 2).map((l, i) => `${i + 1}: ${l}`).join('\n');
  const from = Math.max(0, line - 1 - radius);
  const to = Math.min(lines.length, line + radius);
  return lines.slice(from, to).map((l, i) => `${from + i + 1}: ${l}`).join('\n');
}
