import { describe, expect, it } from "bun:test";
import { patchBrandFile, patchIndexHtml, siteAlreadyUsesLogo } from "./apply-logo";

// Une data URI réaliste (celles en base pèsent 40-60 Ko, la forme est la même).
const LOGO = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA==";

// Le favicon de secours réellement produit par `faviconHref` quand le logo
// n'était pas encore généré : rectangle de couleur + initiale, URL-encodé.
const FALLBACK =
  "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2064%2064%22%3E%3Crect%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%2214%22%20fill%3D%22%23111827%22%2F%3E%3C%2Fsvg%3E";

const INDEX = `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <title>AutoNova</title>
    <link rel="icon" href="${FALLBACK}" />
    <link rel="apple-touch-icon" href="${FALLBACK}" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link href="https://fonts.googleapis.com/css2?family=Inter&display=swap" rel="stylesheet" />
  </head>
  <body><div id="root"></div></body>
</html>
`;

describe("patchIndexHtml (favicon de l'onglet)", () => {
  // Le favicon n'est plus le logo brut : c'est sa version carrée (onglet +
  // icône iOS distincte), cf. favicon-square.ts.
  const FAV = { icon: "data:image/png;base64,SUNPTg==", appleTouch: "data:image/png;base64,QVBQTEU=" };

  it("remplace le favicon de secours par le favicon carré du logo", () => {
    const out = patchIndexHtml(INDEX, FAV);
    expect(out).toContain(`<link rel="icon" href="${FAV.icon}" />`);
    expect(out).toContain(`<link rel="apple-touch-icon" href="${FAV.appleTouch}" />`);
    expect(out).not.toContain(FALLBACK);
  });

  it("ne pose JAMAIS le logo brut dans l'onglet (il serait étiré)", () => {
    const out = patchIndexHtml(INDEX, FAV);
    expect(out).not.toContain(LOGO);
  });

  it("ne touche ni les preconnect ni la feuille de style des polices", () => {
    const out = patchIndexHtml(INDEX, FAV);
    expect(out).toContain(`<link rel="preconnect" href="https://fonts.googleapis.com" />`);
    expect(out).toContain(`href="https://fonts.googleapis.com/css2?family=Inter&display=swap" rel="stylesheet"`);
  });

  it("gère l'ordre inverse des attributs (href avant rel)", () => {
    const out = patchIndexHtml(`<head><link href="/vite.svg" rel="icon"></head>`, FAV);
    expect(out).toContain(`<link rel="icon" href="${FAV.icon}" />`);
    expect(out).not.toContain("/vite.svg");
  });

  it("insère le favicon quand le document n'en a aucun", () => {
    const out = patchIndexHtml(`<html>\n  <head>\n    <title>X</title>\n  </head>\n</html>`, FAV);
    expect(out).toContain(`<link rel="icon" href="${FAV.icon}" />`);
    expect(out).toContain(`<link rel="apple-touch-icon" href="${FAV.appleTouch}" />`);
    expect(out.indexOf("<title>")).toBeGreaterThan(out.indexOf(`rel="icon"`));
  });

  it("refuse une URL contenant un guillemet double plutôt que casser le HTML", () => {
    const evil = `x" onload="alert(1)`;
    expect(patchIndexHtml(INDEX, { icon: evil, appleTouch: FAV.appleTouch })).toBe(INDEX);
  });

  it("est idempotent", () => {
    const once = patchIndexHtml(INDEX, FAV);
    expect(patchIndexHtml(once, FAV)).toBe(once);
  });
});

describe("patchBrandFile (constante LOGO_URL)", () => {
  const BRAND = `export const COMPANY_NAME = "AutoNova";\nexport const LOGO_URL = "";\nexport const PRIMARY = "#111827";\n`;

  it("remplit un LOGO_URL vide sans toucher le reste", () => {
    const out = patchBrandFile(BRAND, LOGO);
    expect(out).toContain(`export const LOGO_URL = ${JSON.stringify(LOGO)};`);
    expect(out).toContain(`export const COMPANY_NAME = "AutoNova";`);
    expect(out).toContain(`export const PRIMARY = "#111827";`);
  });

  it("remplace un logo déjà présent", () => {
    const out = patchBrandFile(patchBrandFile(BRAND, "data:image/png;base64,AAA"), LOGO);
    expect(out).toContain(JSON.stringify(LOGO));
    expect(out).not.toContain("data:image/png;base64,AAA");
    expect(out.match(/export const LOGO_URL/g)?.length).toBe(1);
  });

  it("ajoute la constante si le fichier ne l'a pas", () => {
    const out = patchBrandFile(`export const COMPANY_NAME = "X";`, LOGO);
    expect(out).toContain(`export const LOGO_URL = ${JSON.stringify(LOGO)};`);
  });

  it("est idempotent", () => {
    const once = patchBrandFile(BRAND, LOGO);
    expect(patchBrandFile(once, LOGO)).toBe(once);
  });

  it("détecte un site déjà à jour", () => {
    expect(siteAlreadyUsesLogo(patchBrandFile(BRAND, LOGO), LOGO)).toBe(true);
    expect(siteAlreadyUsesLogo(BRAND, LOGO)).toBe(false);
  });
});
