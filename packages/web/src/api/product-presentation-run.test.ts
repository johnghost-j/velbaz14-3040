import { describe, expect, test } from "bun:test";
import { downloadImage, parseImageDataUri } from "./product-presentation-run";

describe("téléchargement des vues de référence", () => {
  test("data-URI image décodée sans réseau", async () => {
    expect(parseImageDataUri("data:image/jpeg;base64,QUJD")).toEqual({ mimeType: "image/jpeg", data: "QUJD" });
    expect(parseImageDataUri("data:text/plain;base64,QUJD")).toBeNull();
    expect(await downloadImage("data:image/png;base64,QUJD", (() => { throw new Error("pas de réseau"); }) as any))
      .toEqual({ mimeType: "image/png", data: "QUJD" });
  });

  test("URL http : User-Agent navigateur envoyé (le CDN Printify renvoie 403 sinon)", async () => {
    let ua = "";
    const fake = (async (_u: string, init: any) => {
      ua = init.headers["User-Agent"];
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } });
    }) as any;
    const r = await downloadImage("https://images-api.printify.com/mockup/a.jpg", fake);
    expect(ua).toContain("Mozilla/5.0");
    expect(r).toEqual({ mimeType: "image/jpeg", data: Buffer.from([1, 2, 3]).toString("base64") });
  });

  test("réponse non-image ou en erreur → null", async () => {
    const html = (async () => new Response("<html>", { headers: { "content-type": "text/html" } })) as any;
    const forbidden = (async () => new Response("no", { status: 403 })) as any;
    expect(await downloadImage("https://x/a.jpg", html)).toBeNull();
    expect(await downloadImage("https://x/a.jpg", forbidden)).toBeNull();
    expect(await downloadImage("/relative.png")).toBeNull();
  });
});
