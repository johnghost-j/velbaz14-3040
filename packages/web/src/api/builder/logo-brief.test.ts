import { describe, expect, it } from "bun:test";
import {
  LOGO_HARD_RULES,
  LOGO_STYLES,
  MAX_BRIEF_ATTEMPTS,
  MAX_LOGO_ATTEMPTS,
  REDESIGN_AFTER,
  brandInitial,
  buildLogoPrompt,
  detectSector,
  foldText,
  generateBrandLogo,
  hasKey,
  hexLuminance,
  industryDesignLanguage,
  logoBriefPrompts,
  logoSignals,
  logoPerceptionPrompt,
  logoRelevancePrompts,
  briefDrawsInitial,
  parseLogoBrief,
  parseLogoPerception,
  parseLogoRelevance,
  perceptionProblems,
  pickLogoStyle,
  reviewLogo,
  type LogoBrief,
  type LogoDeps,
} from "./logo-brief";
import { ensureSubjectLock } from "../idea-subject";

const shoe = () => logoSignals({ name: "PasStride", idea: ensureSubjectLock("crée une marque de chaussures de running"), industry: "Retail" });

const brief = (over: Partial<LogoBrief> = {}): LogoBrief => ({
  kind: "symbol",
  subject: "sneaker silhouette in profile",
  concept: "A bold side-profile running shoe.",
  link: "Le symbole montre la chaussure vendue.",
  palette: ["#111111", "#E63946"],
  ...over,
});

const perception = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ seen: "a black sneaker", letters: [], words: false, flat: true, cluttered: false, trades: ["shoe store"], ...over });
const relevance = (related: boolean, reason = "ok") => JSON.stringify({ related, reason });

describe("foldText / hasKey : mots entiers, sans accents", () => {
  it("retire accents et ponctuation", () => {
    expect(foldText("Vêtements d'été — Café!")).toBe(" vetements d ete cafe ");
  });
  it("ne matche plus un fragment au milieu d'un mot", () => {
    expect(hasKey(foldText("une carte de fidélité"), "car")).toBe(false);
    expect(hasKey(foldText("un nouveau modèle"), "mode")).toBe(false);
    expect(hasKey(foldText("une voiture de sport"), "car")).toBe(false);
    expect(hasKey(foldText("je vends des cars"), "car")).toBe(false);
    expect(hasKey(foldText("je vends des cars"), "cars")).toBe(true);
  });
  it("un * final est un préfixe de mot", () => {
    expect(hasKey(foldText("des chaussures"), "chaussur*")).toBe(true);
    expect(hasKey(foldText("sac a main"), "sac a main")).toBe(true);
  });
});

describe("detectSector : ce que la marque vend, avant le libellé d'industrie", () => {
  it.each([
    ["marque de chaussures", "footwear"],
    ["une mark de chausure", "footwear"],
    ["marque de baskets", "footwear"],
    ["cret une mark de pentalon", "trousers"],
    ["marque de jeans en denim", "trousers"],
    ["restaurant italien", "food"],
    ["boulangerie artisanale", "bakery"],
    ["marque de cosmétiques naturels", "beauty"],
    ["un logiciel SaaS d'email", "tech"],
    ["concession de voitures", "automotive"],
    ["je vends des bougies parfumées", "candles"],
  ])("%s → %s", (text, id) => {
    expect(detectSector([text])?.id).toBe(id);
  });

  it("chaussures de sport = chaussure, pas sport", () => {
    expect(detectSector(["marque de chaussures de sport"])?.id).toBe("footwear");
  });

  it("une marque de chaussures classée « Technology » reste une marque de chaussures", () => {
    const s = logoSignals({ name: "Paselle", idea: ensureSubjectLock("je veux une marque de chaussure"), industry: "Technology" });
    expect(s.sector?.id).toBe("footwear");
    expect(industryDesignLanguage("Technology", "je veux une marque de chaussure")).toContain("Chaussure");
  });

  it("« auto-entrepreneur » n'est pas de l'automobile, « fait maison » n'est pas de l'immobilier", () => {
    expect(detectSector(["je suis auto-entrepreneur"])?.id).not.toBe("automotive");
    expect(detectSector(["confitures fait maison"])?.id).not.toBe("realestate");
  });

  it("aucun mot connu → null, et un guide générique", () => {
    expect(detectSector(["xyz"])).toBeNull();
    expect(industryDesignLanguage("", "xyz")).toContain("STRICTEMENT");
  });
});

describe("logoSignals", () => {
  it("initiale réelle, sans accent", () => {
    expect(brandInitial("Paséo")).toBe("P");
    expect(brandInitial("Éclat")).toBe("E");
    expect(brandInitial("  ")).toBe("");
    expect(brandInitial("Le Fournil de Max")).toBe("F");
    expect(brandInitial("L'Atelier Rouge")).toBe("A");
    expect(brandInitial("The North Face")).toBe("N");
    expect(brandInitial("Le")).toBe("L");
    expect(brandInitial("Chez Lulu")).toBe("C");
  });
  it("retire le verrou de sujet et lit l'objet vendu", () => {
    const s = shoe();
    expect(s.initial).toBe("P");
    expect(s.userText).not.toContain("VERROUILLÉ");
    expect(s.soldObject).toContain("sneakers");
    expect(s.sector?.id).toBe("footwear");
  });
  it("palette imposée : couleurs trop claires écartées", () => {
    const s = logoSignals({ name: "X", idea: "x", industry: "", palette: ["#F4F1EA", "#1F3A5F", "ffffff"] });
    expect(s.palette).toEqual(["#1F3A5F"]);
  });
  it("hexLuminance", () => {
    expect(hexLuminance("#000000")).toBe(0);
    expect(hexLuminance("#FFFFFF")).toBeCloseTo(1);
  });
});

describe("prompt du brief", () => {
  it("donne l'initiale réelle, l'objet vendu, les symboles du métier et les interdits", () => {
    const { user } = logoBriefPrompts(shoe());
    expect(user).toContain("Initiale réelle de la marque : P");
    expect(user).toContain("sneakers");
    expect(user).toContain("shoe or sneaker silhouette");
    expect(user).toContain("Une lettre autre que « P »");
    expect(user).toContain("forme abstraite générique");
    expect(user).not.toContain("null");
  });
  it("la direction de l'utilisateur est prioritaire", () => {
    const s = logoSignals({ name: "Lulu", idea: "restaurant", industry: "Food", direction: "un renard orange" });
    expect(logoBriefPrompts(s).user).toContain("un renard orange");
  });
});

describe("parseLogoBrief", () => {
  const s = shoe();
  it("accepte un brief complet, avec ou sans bloc ```", () => {
    const r = parseLogoBrief('```json\n{"kind":"symbol","subject":"sneaker","concept":"a shoe","link":"logique","palette":["#111111","e63946"]}\n```', s);
    expect(r.error).toBe("");
    expect(r.brief?.palette).toEqual(["#111111", "#E63946"]);
  });
  it("écarte une couleur claire proposée", () => {
    const r = parseLogoBrief('{"kind":"monogram","subject":"P shoe","concept":"c","link":"l","palette":["#111111","#F4F1EA"]}', s);
    expect(r.brief?.palette).toEqual(["#111111"]);
  });
  it.each([
    ["pas de JSON", "rien"],
    ["kind inconnu", '{"kind":"logo","subject":"a","concept":"b","link":"c","palette":["#111111"]}'],
    ["concept manquant", '{"kind":"symbol","subject":"a","link":"c","palette":["#111111"]}'],
    ["palette que du blanc", '{"kind":"symbol","subject":"a","concept":"b","link":"c","palette":["#FFFFFF"]}'],
  ])("refuse : %s", (_label, raw) => {
    const r = parseLogoBrief(raw, s);
    expect(r.brief).toBeNull();
    expect(r.error).not.toBe("");
  });
  it("la palette imposée l'emporte sur celle du brief", () => {
    const s2 = logoSignals({ name: "PasStride", idea: "chaussures", industry: "", palette: ["#0A3D62"] });
    const r = parseLogoBrief('{"kind":"symbol","subject":"a","concept":"b","link":"c","palette":["#111111"]}', s2);
    expect(r.brief?.palette).toEqual(["#0A3D62"]);
  });
});

describe("briefDrawsInitial : un « symbol » qui dessine l'initiale est un monogramme", () => {
  it.each([
    ["envelope with M fold", "M", true],
    ["the flap lines forming a clear M in the center", "M", true],
    ["a lowercase-style monogram of the brand", "F", true],
    ["A flat geometric envelope", "A", false],
    ["the letter A as a roof", "A", true],
    ["a simple fork with pasta", "C", false],
    ["sneaker silhouette in profile", "P", false],
    ["Mini envelope", "M", false],
  ])("%s (%s) → %s", (text, initial, expected) => {
    expect(briefDrawsInitial(text, initial)).toBe(expected);
  });
  it("parseLogoBrief corrige kind=symbol → monogram", () => {
    const s = logoSignals({ name: "MailFlow", idea: "logiciel d'email marketing", industry: "" });
    const raw = '{"kind":"symbol","subject":"envelope with M fold","concept":"An envelope whose flap forms an M.","link":"logique","palette":["#2563EB"]}';
    expect(parseLogoBrief(raw, s).brief?.kind).toBe("monogram");
  });
});

describe("style et prompt image", () => {
  const s = shoe();
  it("un symbole ne tire jamais le style lettermark", () => {
    for (const name of ["A", "B", "C", "D", "E", "F", "G", "H", "Zed", "PasStride"]) {
      const st = pickLogoStyle(brief(), { ...s, name });
      expect(st).not.toBe(LOGO_STYLES[2]);
    }
  });
  it("un monogramme nomme LA lettre de la marque", () => {
    const st = pickLogoStyle(brief({ kind: "monogram", subject: "P with shoe" }), s);
    expect(st).toContain('single letter "P"');
  });
  it("le prompt contient le sujet, le lien métier, les règles dures, et l'exception lettre seulement en monogramme", () => {
    const p = buildLogoPrompt(brief(), s);
    expect(p).toContain("THE MARK DEPICTS: sneaker silhouette in profile");
    expect(p).toContain("selling pair of sneakers");
    expect(p).toContain(LOGO_HARD_RULES);
    expect(p).not.toContain("ONLY exception");
    const m = buildLogoPrompt(brief({ kind: "monogram" }), s);
    expect(m).toContain('single letter "P"');
  });
  it("le motif du rejet précédent est transmis", () => {
    expect(buildLogoPrompt(brief(), s, "it contains the letter R")).toContain("REJECTED because: it contains the letter R");
  });
});

describe("relecture en deux temps", () => {
  const s = shoe();
  const p = (over: Record<string, unknown> = {}) => parseLogoPerception(perception(over));

  it("le prompt de perception ne dit rien de la marque ni du sujet voulu", () => {
    const prompt = logoPerceptionPrompt();
    expect(prompt).not.toContain("PasStride");
    expect(prompt.toLowerCase()).not.toContain("sneaker");
    expect(prompt).toContain("NOTHING about the brand");
  });
  it("parseLogoPerception : lettres en majuscules, une par entrée, champs absents = false", () => {
    const r = parseLogoPerception('```json\n{"seen":"a shoe","letters":["p","PR",""]}\n```');
    expect(r.letters).toEqual(["P"]);
    expect(r.flat).toBe(false);
    expect(r.trades).toEqual([]);
  });
  it("aucun défaut sur un symbole plat sans lettre", () => {
    expect(perceptionProblems(p(), brief(), s)).toEqual([]);
  });
  it("refuse un R pour une marque en P (monogramme)", () => {
    const r = perceptionProblems(p({ letters: ["R"] }), brief({ kind: "monogram" }), s);
    expect(r.join(" ")).toContain("R");
    expect(r.join(" ")).toContain('"P" is not readable');
  });
  it("accepte le P d'un monogramme PasStride", () => {
    expect(perceptionProblems(p({ letters: ["p"] }), brief({ kind: "monogram" }), s)).toEqual([]);
  });
  it("refuse une lettre dans un symbole", () => {
    expect(perceptionProblems(p({ letters: ["P"] }), brief(), s)).toHaveLength(1);
  });
  it.each([
    ["pas plat", { flat: false }],
    ["texte écrit", { words: true }],
    ["fouillis", { cluttered: true }],
  ])("refuse : %s", (_l, over) => {
    expect(perceptionProblems(p(over), brief(), s)).toHaveLength(1);
  });
  it("le jugement de pertinence reçoit ce qui a été VU, jamais l'intention du designer", () => {
    const { user } = logoRelevancePrompts(p({ seen: "a green ball of yarn" }), s);
    expect(user).toContain("a green ball of yarn");
    expect(user).not.toContain("sneaker silhouette");
    expect(user).toContain("PasStride");
  });
  it("parseLogoRelevance : related absent = false ; illisible = jette", () => {
    expect(parseLogoRelevance('{"reason":"?"}').related).toBe(false);
    expect(parseLogoRelevance('{"related":true,"reason":"ok"}').related).toBe(true);
    expect(() => parseLogoRelevance("pas de json")).toThrow();
  });

  const run = (perc: string, rel: string) => {
    let textCalls = 0;
    const deps = {
      review: async () => perc,
      callText: async () => { textCalls++; return rel; },
    };
    return reviewLogo({ data: "", mimeType: "image/png" }, brief(), s, deps).then((r) => ({ r, textCalls }));
  };
  it("reviewLogo : défaut visuel → rejet sans appel de pertinence", async () => {
    const { r, textCalls } = await run(perception({ words: true }), relevance(true));
    expect(r.ok).toBe(false);
    expect(textCalls).toBe(0);
  });
  it("reviewLogo : pelote de laine pour un restaurant → rejet « no logical link »", async () => {
    const { r, textCalls } = await run(perception({ seen: "green ball of yarn" }), relevance(false, "yarn is not food"));
    expect(textCalls).toBe(1);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("no logical link");
    expect(r.seen).toBe("green ball of yarn");
  });
  it("reviewLogo : propre et lié → accepté", async () => {
    const { r } = await run(perception(), relevance(true));
    expect(r.ok).toBe(true);
  });
  it("reviewLogo : perception illisible → jette (l'essai est compté raté)", async () => {
    await expect(run("pas de json", relevance(true))).rejects.toThrow();
  });
});

describe("generateBrandLogo", () => {
  it("le brief est repensé avant le dernier essai", () => {
    expect(REDESIGN_AFTER).toBeLessThan(MAX_LOGO_ATTEMPTS);
  });
  const goodBrief = '{"kind":"symbol","subject":"sneaker","concept":"a shoe","link":"logique","palette":["#111111"]}';
  const img = (n: number) => ({ data: Buffer.from(`img${n}`).toString("base64"), mimeType: "image/png" });
  const isRelevanceCall = (system: string) => system.includes("brand strategist");

  function deps(over: Partial<LogoDeps> & { reviews?: string[]; relevances?: string[]; cutoutOk?: boolean[]; briefText?: LogoDeps["callText"] } = {}) {
    const prompts: string[] = [];
    let c = 0;
    let n = 0;
    let r = 0;
    let q = 0;
    const d: LogoDeps = {
      callText: async (system, user, max) => {
        if (isRelevanceCall(system)) return over.relevances ? over.relevances[q++] : relevance(true);
        return over.briefText ? over.briefText(system, user, max) : goodBrief;
      },
      generateRaw: async (p) => { prompts.push(p); return img(++n); },
      review: async () => (over.reviews ? over.reviews[r++] : perception()),
      cutout: async (i) => {
        const ok = over.cutoutOk ? over.cutoutOk[c++] : true;
        return { image: { data: `cut-${i.data}`, mimeType: "image/png" }, ok, reason: ok ? "" : "aucun fond blanc détecté" };
      },
      ...over,
    };
    return { d, prompts };
  }
  const input = { name: "PasStride", idea: ensureSubjectLock("marque de chaussures"), industry: "Retail" };

  it("premier essai accepté → image détourée + brief", async () => {
    const { d, prompts } = deps();
    const res = await generateBrandLogo(input, d);
    expect(res.image).not.toBeNull();
    expect(res.brief?.subject).toBe("sneaker");
    expect(prompts).toHaveLength(1);
    expect(res.error).toBe("");
  });

  it("un rejet (lettre) relance avec le motif, le 2e essai est livré", async () => {
    const { d, prompts } = deps({ reviews: [perception({ letters: ["R"] }), perception()] });
    const res = await generateBrandLogo(input, d);
    expect(res.image?.data).toBe(`cut-${img(2).data}`);
    expect(prompts[1]).toContain("REJECTED because");
    expect(prompts[1]).toContain("R");
  });

  it("un rejet de pertinence relance aussi avec le motif", async () => {
    const { d, prompts } = deps({ relevances: [relevance(false, "looks like yarn"), relevance(true)] });
    const res = await generateBrandLogo(input, d);
    expect(res.image?.data).toBe(`cut-${img(2).data}`);
    expect(prompts[1]).toContain("looks like yarn");
  });

  it("fond impossible à détourer → essai rejeté sans relecture, motif renvoyé au modèle", async () => {
    let reviews = 0;
    const { d, prompts } = deps({ cutoutOk: [false, true] });
    const review = d.review;
    d.review = async (i, p) => { reviews++; return review(i, p); };
    const res = await generateBrandLogo(input, d);
    expect(reviews).toBe(1);
    expect(res.image?.data).toBe(`cut-${img(2).data}`);
    expect(prompts[1]).toContain("could not be removed");
  });

  it("l'image livrée est la version détourée", async () => {
    const { d } = deps();
    const res = await generateBrandLogo(input, d);
    expect(res.image?.data).toBe(`cut-${img(1).data}`);
  });

  it("2 rejets sur le même concept → brief repensé avec les motifs, le 3e essai l'utilise", async () => {
    const briefUsers: string[] = [];
    const second = '{"kind":"symbol","subject":"running shoe profile","concept":"a plain shoe","link":"logique","palette":["#111111"]}';
    const { d, prompts } = deps({
      relevances: [relevance(false, "reads as yarn"), relevance(false, "reads as a ribbon"), relevance(true)],
      briefText: async (_sys, user) => { briefUsers.push(user); return briefUsers.length === 1 ? goodBrief : second; },
    });
    const res = await generateBrandLogo(input, d);
    expect(briefUsers).toHaveLength(2);
    expect(briefUsers[0]).not.toContain("UN PREMIER CONCEPT");
    expect(briefUsers[1]).toContain("UN PREMIER CONCEPT A ÉCHOUÉ : « sneaker »");
    expect(briefUsers[1]).toContain("reads as yarn");
    expect(briefUsers[1]).toContain("reads as a ribbon");
    expect(prompts).toHaveLength(MAX_LOGO_ATTEMPTS);
    expect(prompts[2]).toContain("running shoe profile");
    expect(prompts[2]).not.toContain("REJECTED because");
    expect(res.brief?.subject).toBe("running shoe profile");
    expect(res.image).not.toBeNull();
  });

  it("brief repensé illisible → on garde le premier concept, sans planter", async () => {
    let calls = 0;
    const { d, prompts } = deps({
      relevances: Array(MAX_LOGO_ATTEMPTS).fill(relevance(false)),
      briefText: async () => (calls++ === 0 ? goodBrief : "pas de json"),
    });
    const res = await generateBrandLogo(input, d);
    expect(prompts).toHaveLength(MAX_LOGO_ATTEMPTS);
    expect(prompts[2]).toContain("sneaker");
    expect(res.image).toBeNull();
  });

  it("tous les essais rejetés → aucune image (jamais le logo rejeté)", async () => {
    const { d, prompts } = deps({ relevances: Array(MAX_LOGO_ATTEMPTS).fill(relevance(false)) });
    const res = await generateBrandLogo(input, d);
    expect(res.image).toBeNull();
    expect(prompts).toHaveLength(MAX_LOGO_ATTEMPTS);
    expect(res.error).toContain("aucun logo valide");
  });

  it("relecteur en panne → essai raté, pas d'image non relue", async () => {
    const { d } = deps({ review: async () => { throw new Error("gateway down"); } });
    const res = await generateBrandLogo(input, d);
    expect(res.image).toBeNull();
    expect(res.attempts.every((a) => a.error?.includes("gateway down"))).toBe(true);
  });

  it("brief illisible → réessayé, puis échec explicite sans générer d'image", async () => {
    let calls = 0;
    const { d, prompts } = deps({ briefText: async () => { calls++; return "pas de json"; } });
    const res = await generateBrandLogo(input, d);
    expect(calls).toBe(MAX_BRIEF_ATTEMPTS);
    expect(prompts).toHaveLength(0);
    expect(res.image).toBeNull();
    expect(res.error).toContain("brief");
  });

  it("brief en échec réseau puis valide → continue", async () => {
    let calls = 0;
    const { d } = deps({ briefText: async () => { if (calls++ === 0) throw new Error("ECONNRESET"); return goodBrief; } });
    const res = await generateBrandLogo(input, d);
    expect(res.image).not.toBeNull();
  });
});
