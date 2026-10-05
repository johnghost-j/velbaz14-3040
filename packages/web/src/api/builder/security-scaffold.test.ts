import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SECURITY_LIB, SERVER_UPLOADS, ensureSecurityMounted, hardenGeneratedCode } from "./security-scaffold";

// Les fichiers générés sont des chaînes : on les écrit à côté (pour que `hono`
// se résolve depuis le dépôt) puis on les importe pour de vrai.
const here = import.meta.dir;
const upFile = join(here, ".sec-tmp-uploads.ts");
const libFile = join(here, ".sec-tmp-security.ts");
writeFileSync(upFile, SERVER_UPLOADS);
writeFileSync(libFile, SECURITY_LIB);
const work = mkdtempSync(join(tmpdir(), "vz-up-"));
const prevCwd = process.cwd();
afterAll(() => {
  process.chdir(prevCwd);
  rmSync(upFile, { force: true });
  rmSync(libFile, { force: true });
  rmSync(work, { recursive: true, force: true });
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 1, 2, 3, 4]);
const enc = (s: string) => new TextEncoder().encode(s);
const concat = (a: Uint8Array, b: Uint8Array) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };

async function post(app: any, bytes: Uint8Array, name: string, type: string) {
  const form = new FormData();
  form.append("file", new File([bytes], name, { type }));
  return app.request("/upload", { method: "POST", body: form });
}

describe("upload sécurisé des apps générées", () => {
  test("accepte une vraie image, refuse php/jsp/html/svg, polyglottes et faux types", async () => {
    process.chdir(work);
    const mod: any = await import(upFile);
    const app = mod.uploadRoute;

    const ok = await post(app, PNG, "photo.png", "image/png");
    expect(ok.status).toBe(201);
    const body = await ok.json();
    expect(body.path).toMatch(/^\/files\/[0-9a-f-]{36}\.png$/);

    expect((await post(app, enc("<?php system($_GET['c']); ?>"), "shell.php", "application/x-php")).status).toBe(415);
    expect((await post(app, PNG, "shell.php.png", "image/png")).status).toBe(415);
    expect((await post(app, enc("<% out.println(1); %>"), "x.jsp", "")).status).toBe(415);
    expect((await post(app, enc("<svg onload=alert(1)>"), "x.svg", "image/svg+xml")).status).toBe(415);
    expect((await post(app, enc("<html><script>alert(1)</script>"), "x.png", "image/png")).status).toBe(415);
    // Image valide en tête + code PHP caché (polyglotte)
    expect((await post(app, concat(PNG, enc("<?php echo 1; ?>")), "x.png", "image/png")).status).toBe(415);
    // Type annoncé ≠ contenu réel
    expect((await post(app, PNG, "x.pdf", "application/pdf")).status).toBe(415);
    // Trop lourd
    const big = new Uint8Array(5 * 1024 * 1024 + 10); big.set(PNG);
    expect((await post(app, big, "big.png", "image/png")).status).toBe(413);

    const got = await app.request(body.path);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(got.headers.get("content-security-policy")).toContain("sandbox");
    expect((await app.request("/files/..%2F..%2Fetc%2Fpasswd")).status).toBe(404);
    expect((await app.request("/files/abc.php")).status).toBe(404);
  });
});

describe("helpers anti-XSS", () => {
  test("safeUrl / safeJson / escapeHtml", async () => {
    const lib: any = await import(libFile);
    expect(lib.safeUrl("javascript:alert(1)")).toBe("#");
    expect(lib.safeUrl(" JaVa\tScript:alert(1)")).toBe("#");
    expect(lib.safeUrl("data:text/html,<script>")).toBe("#");
    expect(lib.safeUrl("https://ok.com/x")).toBe("https://ok.com/x");
    expect(lib.safeUrl("/produits/1")).toBe("/produits/1");
    expect(lib.safeUrl("mailto:a@b.c")).toBe("mailto:a@b.c");
    expect(lib.safeJson({ a: "</script><script>alert(1)</script>" })).not.toContain("</script>");
    expect(JSON.parse(lib.safeJson({ a: "</script>" })).a).toBe("</script>");
    expect(lib.escapeHtml('<img src=x onerror="a">')).toBe("&lt;img src=x onerror=&quot;a&quot;&gt;");
    // Sans DOM : repli sur l'échappement complet
    expect(lib.sanitizeHtml("<img src=x onerror=alert(1)>")).not.toContain("<img");
  });

  test("hardenGeneratedCode enveloppe le HTML dynamique, laisse le statique", () => {
    const src = `import React from "react";
import { data } from "../lib/api";

export default function Post({ post }: any) {
  return (
    <div>
      <article className="prose" dangerouslySetInnerHTML={{ __html: post.body }} />
      <p dangerouslySetInnerHTML={{ __html: "<b>statique</b>" }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify({ name: post.title }) }} />
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <div dangerouslySetInnerHTML={{ __html: \`<i>\${post.name}</i>\` }} />
    </div>
  );
}
`;
    const out = hardenGeneratedCode("src/pages/Post.tsx", src);
    expect(out).toContain("__html: __vzSanitizeHtml(post.body)");
    expect(out).toContain('__html: "<b>statique</b>"');
    expect(out).toContain("__html: __vzSafeJson(JSON.stringify({ name: post.title }))");
    expect(out).toContain("__html: css");
    expect(out).toContain("__vzSanitizeHtml(`<i>${post.name}</i>`)");
    expect(out).toContain('import { sanitizeHtml as __vzSanitizeHtml, safeJson as __vzSafeJson } from "../lib/security";');
    // idempotent
    expect(hardenGeneratedCode("src/pages/Post.tsx", out)).toBe(out);
    // chemins
    expect(hardenGeneratedCode("src/components/ui/Rich.tsx", `const A = (p: any) => <div dangerouslySetInnerHTML={{ __html: p.h }} />;`))
      .toContain('from "../../lib/security"');
    expect(hardenGeneratedCode("server/x.ts", "dangerouslySetInnerHTML={{ __html: a }}")).toBe("dangerouslySetInnerHTML={{ __html: a }}");
  });

  test("ensureSecurityMounted branche l'upload dans un ancien server/index.ts (idempotent)", () => {
    const old = `import { Hono } from "hono";
import { cors } from "hono/cors";
import { dataRoute } from "./data";

const app = new Hono().basePath("/api");

app.use("*", cors());

app.route("/", dataRoute);

export default app;
`;
    const out = ensureSecurityMounted(old);
    expect(out).toContain('import { uploadRoute } from "./uploads";');
    expect(out).toContain('app.route("/", uploadRoute);');
    expect(out).toContain("X-Content-Type-Options");
    expect(out.indexOf('app.route("/", uploadRoute)')).toBeLessThan(out.indexOf("export default app"));
    expect(ensureSecurityMounted(out)).toBe(out);
  });
});
