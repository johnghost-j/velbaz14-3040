import { streamText, stepCountIs } from 'ai';
import { gateway } from './src/api/agent/gateway';
import { buildAgentTools } from './src/api/agent-tools/tools';
import { toolsInstructions } from './src/api/agent-tools/tools';

const PROMPT = "c'est quoi le meilleur moyen de vendre des vélos en ligne ?";
const models = ['openai/gpt-5.4-nano','anthropic/claude-haiku-4.5','xai/grok-4.1-fast-non-reasoning'];
const tools = buildAgentTools({ sessionId: 'bench', log: [] });
const sysTools = `Tu es Velbaz AI. Réponds en 2-3 phrases, dans la langue de l'user.${await toolsInstructions(false)}`;
const sysPlain = `Tu es Velbaz AI. Réponds en 2-3 phrases max, dans la langue de l'user.`;

async function ttft(model: string, withTools: boolean) {
  const t = Date.now();
  try {
    const res = streamText({
      model: gateway(model),
      system: withTools ? sysTools : sysPlain,
      messages: [{ role: 'user', content: PROMPT }],
      ...(withTools ? { tools: tools as any, stopWhen: stepCountIs(12) } : {}),
      maxOutputTokens: 150, maxRetries: 0, abortSignal: AbortSignal.timeout(30000),
    });
    for await (const p of res.fullStream as AsyncIterable<any>) {
      if (p?.type === 'text-delta' && (p.text || p.textDelta)) return Date.now() - t;
      if (p?.type === 'tool-call') return `TOOL@${Date.now() - t}ms`;
    }
    return -1;
  } catch (e: any) { return `ERR ${String(e?.message).slice(0,50)}`; }
}

console.log(`prompt avec outils: ${sysTools.length} chars | sans: ${sysPlain.length}`);
for (const m of models) {
  const wt = await ttft(m, true);
  const nt = await ttft(m, false);
  console.log(`${m.padEnd(34)} outils=${String(wt).padEnd(14)} sansOutils=${nt}`);
}
