// ─── Growth Engine providers (demo-first) ───────────────────────────────────
// No key = demo mode: record the action, show a simulated result, make zero paid
// network calls. Once keys are present, the same functions switch to real APIs.
import { getSecret } from './secret-store';

export type GrowthChannelStatus = 'demo' | 'sent' | 'completed' | 'failed' | 'skipped';

export interface GrowthProviderResult {
  ok: boolean;
  status: GrowthChannelStatus;
  provider: string;
  id?: string;
  mediaUrl?: string;
  transcript?: string;
  error?: string;
}

// Panel admin (API Keys, chiffré) puis repli process.env — cf. getSecret().
const env = (key: string) => getSecret(key) || '';

// SMS = Bland.ai (même compte que les appels). Exige un numéro Bland
// (BLAND_FROM) : l'API /v1/sms/send refuse un envoi sans agent_number.
// Plan Agent Phone : US/Canada uniquement, 20 SMS/h, 100 SMS/jour.
export function isSmsConfigured() {
  return !!(env('BLAND_API_KEY') && env('BLAND_FROM'));
}

export function isCallConfigured() {
  return !!env('BLAND_API_KEY');
}

export async function sendSms(input: { to?: string | null; body: string }): Promise<GrowthProviderResult> {
  if (!input.to) return { ok: false, status: 'skipped', provider: 'bland-sms', error: 'Missing phone number' };
  if (!isSmsConfigured()) {
    return { ok: true, status: 'demo', provider: 'bland-sms-demo', id: `demo_sms_${Date.now()}` };
  }
  try {
    const res = await fetch('https://api.bland.ai/v1/sms/send', {
      method: 'POST',
      headers: { Authorization: env('BLAND_API_KEY'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_number: input.to, agent_number: env('BLAND_FROM'), agent_message: input.body }),
    });
    const data: any = await res.json().catch(() => ({}));
    const apiErr = Array.isArray(data?.errors) && data.errors.length
      ? data.errors.map((e: any) => e?.message || e?.error || e?.code || String(e)).join('; ')
      : '';
    if (!res.ok || apiErr) {
      return { ok: false, status: 'failed', provider: 'bland-sms', error: apiErr || data?.message || `Bland SMS ${res.status}` };
    }
    return { ok: true, status: 'sent', provider: 'bland-sms', id: data?.data?.message_id || data?.data?.conversation_id };
  } catch (e: any) {
    return { ok: false, status: 'failed', provider: 'bland-sms', error: String(e?.message || e) };
  }
}

export async function placeCall(input: { to?: string | null; script: string; voice?: string }): Promise<GrowthProviderResult> {
  if (!input.to) return { ok: false, status: 'skipped', provider: 'bland-ai', error: 'Missing phone number' };
  if (!isCallConfigured()) {
    return {
      ok: true,
      status: 'demo',
      provider: 'bland-demo',
      id: `demo_call_${Date.now()}`,
      transcript: `DEMO CALL\nAI: ${input.script.slice(0, 220)}\nProspect: Sounds interesting, send me details by email.`,
    };
  }
  try {
    const body: Record<string, unknown> = { phone_number: input.to, task: input.script, voice: input.voice || 'maya', wait_for_greeting: true };
    if (env('BLAND_FROM')) body.from = env('BLAND_FROM');
    const res = await fetch('https://api.bland.ai/v1/calls', {
      method: 'POST',
      headers: { Authorization: env('BLAND_API_KEY'), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: 'failed', provider: 'bland-ai', error: data?.message || data?.error || `Bland ${res.status}` };
    return { ok: true, status: 'sent', provider: 'bland-ai', id: data.call_id || data.id };
  } catch (e: any) {
    return { ok: false, status: 'failed', provider: 'bland-ai', error: String(e?.message || e) };
  }
}

