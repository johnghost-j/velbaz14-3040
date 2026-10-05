// ─── Relecture visuelle d'un logo généré ────────────────────────────────────
// Branché dans `generateBrandLogo` (logo-brief.ts) via `LogoDeps.review`.
// Gemini 3 Flash en premier : sur les logos réels en base (2026-10-04), c'est
// lui qui a vu « un escarpin formant les lettres R et P » là où GPT-5.4 mini ne
// voyait qu'un « monogramme abstrait ». Claude ne sert que si Gemini est en
// panne côté passerelle ; si les deux échouent, l'erreur remonte (l'essai est
// compté comme raté, jamais accepté sans relecture).

import { generateText } from "ai";
import { gateway } from "../agent/gateway";
import type { RawImage } from "./logo-image";

export const LOGO_REVIEW_MODELS = ["google/gemini-3-flash", "anthropic/claude-sonnet-4.6"];
const REVIEW_TIMEOUT_MS = 60_000;

export async function reviewLogoWithVision(img: RawImage, prompt: string): Promise<string> {
  const errors: string[] = [];
  for (const model of LOGO_REVIEW_MODELS) {
    try {
      const { text } = await generateText({
        model: gateway(model),
        // Gemini consomme des tokens de raisonnement : un petit budget rend "".
        maxOutputTokens: 4000,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(REVIEW_TIMEOUT_MS),
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image", image: Buffer.from(img.data, "base64"), mediaType: img.mimeType || "image/png" },
          ],
        }],
      });
      if (text.trim()) return text;
      errors.push(`${model} : réponse vide`);
    } catch (e) {
      errors.push(`${model} : ${(e as Error)?.message || e}`);
    }
    console.error(`[logo-review] ${errors[errors.length - 1]}`);
  }
  throw new Error(errors.join(" | "));
}
