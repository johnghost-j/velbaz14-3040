import { describe, expect, test } from "bun:test";
import { isImageSwapRequest, pickImageKey, orderedKeysForPage, imageAttachments, prepareUserImage } from "./image-swap";

const files = [
  { path: "src/App.tsx", content: `import Home from "./pages/Home";\n<Route path="/" element={<Home />} />` },
  { path: "src/pages/Home.tsx", content: `import Hero from "../components/Hero";\nconst map = { a: IMAGES.stride_one };\nexport default function Home(){ return (<div><Hero /><img src={IMAGES.pulse_runner}/><img src={IMAGES.team_photo}/></div>); }` },
  { path: "src/components/Hero.tsx", content: `export default function Hero(){ return (<img src={IMAGES.hero}/>); }` },
  { path: "src/lib/images.ts", content: `const RAW: Record<string, string> = {\n "hero": "x", "pulse_runner": "y", "stride_one": "z", "team_photo": "w" };` },
];
const keys = new Set(["hero", "pulse_runner", "stride_one", "team_photo"]);

describe("image-swap", () => {
  test("détecte un remplacement (même avec fautes)", () => {
    expect(isImageSwapRequest("met cette image a la place de la prelier image du site")).toBe(true);
    expect(isImageSwapRequest("remplace la photo de l'équipe")).toBe(true);
    expect(isImageSwapRequest("génère une image comme celle-ci")).toBe(false);
    expect(isImageSwapRequest("change le titre")).toBe(false);
  });
  test("ordre d'affichage : composants dépliés, données en fin", () => {
    expect(orderedKeysForPage("src/pages/Home.tsx", files)).toEqual(["hero", "pulse_runner", "team_photo", "stride_one"]);
  });
  test("choix de la clé", () => {
    expect(pickImageKey("met cette image a la place de la premiere image", files, keys)?.key).toBe("hero");
    expect(pickImageKey("remplace la deuxième image", files, keys)?.key).toBe("pulse_runner");
    expect(pickImageKey("mets ma photo à la place de team photo", files, keys)?.key).toBe("team_photo");
    expect(pickImageKey("mets cette photo", files, keys)).toBeNull();
  });
  test("pièces jointes : seulement les images en data URI", () => {
    expect(imageAttachments([{ data: "data:image/png;base64,AAA" }, { data: "data:application/pdf;base64,AAA" }, null]).length).toBe(1);
    expect(imageAttachments(undefined)).toEqual([]);
  });
  test("compression en WebP", async () => {
    const sharp = (await import("sharp")).default;
    const png = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#123456" } }).png().toBuffer();
    const out = await prepareUserImage({ data: `data:image/png;base64,${png.toString("base64")}` });
    expect(out.startsWith("data:image/webp;base64,")).toBe(true);
    const meta = await sharp(Buffer.from(out.split(",")[1], "base64")).metadata();
    expect(meta.width).toBe(2000);
  });
});
