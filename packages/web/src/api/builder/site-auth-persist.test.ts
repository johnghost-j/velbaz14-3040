// [2026-10-03] Régression « sur mon site généré je me connecte, j'actualise →
// déconnecté / il ne se souvient plus de moi ».
//  1. Le jeton de session est rangé sous une clé PROPRE au site (tous les sites
//     partagent l'origine de l'aperçu Velbaz → un autre site l'effaçait).
//  2. Une réécriture complète du projet garde `.data` (comptes + sessions).
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { namespaceSiteAuthKey, SITE_AUTH_KEY_EXPR } from "./site-auth-key";
import { clearProjectDirKeepingData } from "./runner";
import { buildScaffold } from "./scaffold";
import { SECURITY_LIB } from "./security-scaffold";

const LEGACY = /localStorage\.(getItem|setItem|removeItem)\(\s*["']auth_token["']/;

describe("clé de session propre au site", () => {
  test("ancien auth.tsx (en base) → clé par site, idempotent", () => {
    const old = `function getToken() { return localStorage.getItem("auth_token") || ""; }
function setToken(t: string) { t ? localStorage.setItem("auth_token", t) : localStorage.removeItem('auth_token'); }`;
    const once = namespaceSiteAuthKey("src/lib/auth.tsx", old);
    expect(once).not.toMatch(LEGACY);
    expect(once.split(SITE_AUTH_KEY_EXPR).length - 1).toBe(3);
    expect(namespaceSiteAuthKey("src/lib/auth.tsx", once)).toBe(once);
  });

  test("code écrit par l'IA dans une page est aussi corrigé", () => {
    const page = `const t = localStorage.getItem( 'auth_token' ); fetch("/x", { headers: { Authorization: "Bearer " + t } });`;
    expect(namespaceSiteAuthKey("src/pages/Orders.tsx", page)).not.toMatch(LEGACY);
  });

  test("hors front (serveur, JSON) : intact", () => {
    const s = `localStorage.getItem("auth_token")`;
    expect(namespaceSiteAuthKey("server/auth.ts", s)).toBe(s);
    expect(namespaceSiteAuthKey("package.json", s)).toBe(s);
  });

  test("les nouveaux sites n'utilisent plus la clé partagée", () => {
    const files = buildScaffold({
      companyName: "Atelier", slug: "atelier", primaryColor: "#111111", accentColor: "#222222",
      font: "Inter", idea: "Boutique", lang: "fr",
    } as any);
    const front = files.filter((f) => f.path.startsWith("src/") && typeof f.content === "string");
    const auth = front.find((f) => f.path === "src/lib/auth.tsx")!;
    const api = front.find((f) => f.path === "src/lib/api.ts")!;
    expect(auth.content).toContain(SITE_AUTH_KEY_EXPR);
    expect(api.content).toContain(SITE_AUTH_KEY_EXPR);
    for (const f of front) expect(f.content).not.toMatch(LEGACY);
    expect(SECURITY_LIB).toContain(SITE_AUTH_KEY_EXPR);
    expect(SECURITY_LIB).not.toMatch(LEGACY);
  });
});

describe("réécriture complète du projet", () => {
  test("garde .data (comptes, sessions, données, envois) et efface le reste", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vz-site-"));
    try {
      await mkdir(join(dir, ".data/uploads"), { recursive: true });
      const auth = JSON.stringify({ users: [{ id: "u1", email: "a@b.c" }], sessions: { tok: "u1" } });
      await writeFile(join(dir, ".data/auth.json"), auth);
      await writeFile(join(dir, ".data/uploads/x.png"), "png");
      await mkdir(join(dir, "src/pages"), { recursive: true });
      await writeFile(join(dir, "src/pages/Old.tsx"), "old");
      await mkdir(join(dir, "node_modules/vite"), { recursive: true });
      await writeFile(join(dir, "package.json"), "{}");

      await clearProjectDirKeepingData(dir);

      expect(await readdir(dir)).toEqual([".data"]);
      expect(await readFile(join(dir, ".data/auth.json"), "utf8")).toBe(auth);
      expect(existsSync(join(dir, ".data/uploads/x.png"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("dossier absent : créé vide", async () => {
    const dir = join(tmpdir(), `vz-site-new-${Date.now()}`);
    try {
      await clearProjectDirKeepingData(dir);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("writeFilesToDisk n'efface plus le dossier entier", async () => {
    const src = await readFile(join(import.meta.dir, "runner.ts"), "utf8");
    const body = src.slice(src.indexOf("export async function writeFilesToDisk"), src.indexOf("export async function writeFilesIncremental"));
    expect(body).toContain("clearProjectDirKeepingData(dir)");
    expect(body).not.toMatch(/\brm\(\s*dir\b/);
  });
});
