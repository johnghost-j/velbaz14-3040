import { describe, expect, test } from "bun:test";
import {
  detectProductAddRequest, extractConcept, previewBelongsToProduct, previewFeedback, previewReplyKind, splitPreviewFeedback,
} from "./product-intent";

describe("« ajoute un produit » dans le chat", () => {
  test.each([
    "ajoute moi un produit",
    "ajoute-moi un produit",
    "ajoute un vrai produit disponible sur printify",
    "ajotue run vrai produit disponible sur printify",
    "tu peux m'ajouter un nouveau produit ?",
    "rajoute 2 produits",
    "crée un produit printify",
    "cree un produit",
    "add a product",
    "mets un produit sur le site",
  ])("détecte : %s", (msg) => {
    expect(detectProductAddRequest(msg)).not.toBeNull();
  });

  test.each([
    "ajoute une photo au produit",
    "ajoute un bouton sur la page produit",
    "crée la page produit",
    "supprime le produit",
    "enlève ce produit du site",
    "pourquoi tu as ajouté ce produit ?",
    "change la couleur du header",
    "ajoute une section avis",
    "ajoute un produit page",
    "[APERÇU VALIDÉ] Parfait, continue.",
  ])("ignore : %s", (msg) => {
    expect(detectProductAddRequest(msg)).toBeNull();
  });

  test("lit le type Printify demandé et Printify cité", () => {
    expect(detectProductAddRequest("ajoute un produit t-shirt")?.podType).toBe("t-shirt");
    expect(detectProductAddRequest("ajoute un produit : un mug")?.podType).toBe("mug");
    const p = detectProductAddRequest("ajoute un vrai produit disponible sur printify");
    expect(p?.printifyMentioned).toBe(true);
    // « printify » ne doit pas être lu comme « print » (poster).
    expect(p?.podType).toBeNull();
  });

  test("un type nommé sans le mot « produit » compte s'il y a un contexte de vente", () => {
    expect(detectProductAddRequest("ajoute un hoodie printify")?.podType).toBe("hoodie");
    expect(detectProductAddRequest("mets une casquette dans la boutique")?.podType).toBe("cap");
    // Sans contexte de vente : édition de page, pas un produit.
    expect(detectProductAddRequest("ajoute un mug dans la photo du header")).toBeNull();
  });

  // Bug réel 2026-10-03 : « ajoute un mug avec un loup minimaliste » partait en
  // édition de code et l'IA écrivait un mug inventé dans catalog.ts.
  test.each([
    ["ajoute un mug avec un loup minimaliste", "mug"],
    ["rajoute 2 t-shirts noirs", "t-shirt"],
    ["ajoute-moi une casquette", "cap"],
    ["ajoute un sweat à capuche avec notre logo", "hoodie"],
    ["cree un tapis de souris gaming", "mouse pad"],
    ["ajoute un tote bag", "tote bag"],
    ["mets une coque de téléphone", "phone case"],
    ["ajoute un nouveau hoodie", "hoodie"],
  ])("type en complément direct du verbe : %s", (msg, type) => {
    expect(detectProductAddRequest(msg)?.podType).toBe(type);
  });

  test.each([
    "ajoute un top 10 des meilleures ventes",
    "ajoute un case study",
    "ajoute un logo top",
    "ajoute un journal des commandes",
    "ajoute une photo de mug dans le hero",
    "change le mug en bleu",
    "ajoute un footer avec un mug",
  ])("pas un ajout de produit : %s", (msg) => {
    expect(detectProductAddRequest(msg)).toBeNull();
  });

  test("concept du design", () => {
    expect(extractConcept("ajoute un t-shirt avec un loup qui hurle")).toBe("loup qui hurle");
    expect(extractConcept("ajoute un mug avec notre logo sur le site")).toBe("notre logo");
    expect(extractConcept("ajoute un produit")).toBe("");
  });
});

describe("réponses au pop-up d'aperçu", () => {
  test("type de réponse", () => {
    expect(previewReplyKind("[APERÇU VALIDÉ] Parfait, continue.")).toBe("approve");
    expect(previewReplyKind("[APERÇU À MODIFIER] plus foncé")).toBe("modify");
    expect(previewReplyKind("ajoute un produit")).toBeNull();
    expect(previewFeedback("[APERÇU À MODIFIER]  plus foncé ")).toBe("plus foncé");
  });

  test("n'appartient au produit que si le dernier message est son aperçu", () => {
    const cand = { imageUrl: "https://images-api.printify.com/mockup/abc.png" };
    expect(previewBelongsToProduct(cand, `Voici…\n[POPUP]{"imageUrl":"${cand.imageUrl}"}[/POPUP]`)).toBe(true);
    // Un pop-up logo plus récent → ce n'est pas la réponse au produit.
    expect(previewBelongsToProduct(cand, `[POPUP]{"imageUrl":"https://cdn/logo.png"}[/POPUP]`)).toBe(false);
    expect(previewBelongsToProduct(null, "x")).toBe(false);
    expect(previewBelongsToProduct(cand, null)).toBe(false);
  });
});

describe("retour « Modifier » : dessin vs produit", () => {
  test.each([
    ["un mug classique 11oz, le loup plus simple", "le loup plus simple", "mug classique 11oz"],
    ["le loup plus grand et en noir", "le loup plus grand, en noir", ""],
    ["plutôt un hoodie", "", "hoodie"],
    ["un mug blanc 15oz", "", "mug blanc 15oz"],
    ["ajoute des montagnes derrière", "ajoute des montagnes derrière", ""],
  ])("%s", (fb, art, spec) => {
    const r = splitPreviewFeedback(fb);
    expect(r.art).toBe(art);
    expect(r.spec).toBe(spec);
  });
});
