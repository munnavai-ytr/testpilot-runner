import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { config, redactSecrets } from './config';
import { QaAgent, requestRunStop } from './agent';
import { validateSsrfUrl } from './security';
import type { RunCredentials, TestMode } from './types';

const FALLBACK_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-2.5-flash'];
const SKIP_WORDS = ['lite', 'image', 'tts', 'live', 'audio', 'embedding', 'imagen', 'robotics', 'computer-use', 'native', 'exp', '8b', 'learnlm'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WIPE = { encrypted_gemini_key: null, encrypted_credentials: null };

function decryptText(payload: string, secret: string): string {
  const raw = Buffer.from(payload, 'base64');
  if (raw.length < 12 + 16 + 1) throw new Error('bad payload');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const data = raw.subarray(12, raw.length - 16);
  const key = crypto.createHash('sha256').update(secret, 'utf8').digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

type Ping = 'ok' | 'missing' | 'bad_key' | 'quota' | 'error';

async function pingModel(model: string, apiKey: string): Promise<Ping> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'ping' }] }],
          generationConfig: { maxOutputTokens: 16 },
        }),
      },
    );
    if (res.ok) return 'ok';
    if (res.status === 404) return 'missing';
    if (res.status === 401 || res.status === 403) return 'bad_key';
    if (res.status === 429) return 'quota';
    if (res.status === 400) {
      const text = await res.text().catch(() => '');
      return /api key/i.test(text) ? 'bad_key' : 'error';
    }
    return 'error';
  } catch {
    return 'error';
  }
}

async function listBestModels(apiKey: string): Promise<string[]> {
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
      headers: { 'x-goog-api-key': apiKey },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> };
    const found: Array<{ id: string; version: number; preview: number }> = [];
    for (const m of body.models || []) {
      const id = String(m.name || '').replace(/^models\//, '');
      if (!id.startsWith('gemini-') || !id.includes('flash')) continue;
      if (SKIP_WORDS.some((w) => id.includes(w))) continue;
      if (!(m.supportedGenerationMethods || []).includes('generateContent')) continue;
      const v = id.match(/^gemini-(\d+(?:\.\d+)?)/);
      found.push({ id, version: v ? parseFloat(v[1]) : 0, preview: id.includes('preview') ? 1 : 0 });
    }
    found.sort((a, b) => b.version - a.version || a.preview - b.preview);
    return found.slice(0, 4).map((f) => f.id);
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const runId = (process.env.RUN_ID || '').trim();
  const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const secret = process.env.ENCRYPTION_SECRET || '';

  if (!UUID_RE.test(runId)) {
    console.error('RUN_ID is missing or invalid.');
    process.exit(1);
  }
  if (!supabaseUrl || !serviceKey) {
    console.error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing.');
    process.exit(1);
  }
  if (secret.length < 32) {
    console.error('ENCRYPTION_SECRET is missing or too short.');
    process.exit(1);
  }

  const db = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const fail = async (code: string, message: string): Promise<void> => {
    await db
      .from('runs')
      .update({ status: 'failed', error: { code, message }, ...WIPE })
      .eq('id', runId);
  };

  const { data: claimed, error: claimError } = await db
    .from('runs')
    .update({ status: 'running' })
    .eq('id', runId)
    .eq('status', 'queued')
    .select('id,url,command,mode,gemini_model,encrypted_gemini_key,encrypted_credentials')
    .maybeSingle();

  if (claimError) {
    console.error('Could not claim the run:', redactSecrets(claimError.message));
    process.exit(1);
  }
  const row = claimed as unknown as Record<string, unknown> | null;
  if (!row) {
    console.log('This run is not waiting (already started, stopped or missing). Nothing to do.');
    return;
  }

  await db.from('runs').update(WIPE).eq('id', runId);

  let geminiKey = '';
  let credentials: RunCredentials | null = null;
  try {
    geminiKey = decryptText(String(row.encrypted_gemini_key || ''), secret);
    if (row.encrypted_credentials) {
      credentials = JSON.parse(decryptText(String(row.encrypted_credentials), secret)) as RunCredentials;
    }
  } catch {
    await fail('server_error', 'The secure key could not be read. The server settings may be wrong.');
    return;
  }

  const url = String(row.url || '');
  const check = await validateSsrfUrl(url);
  if (!check.valid) {
    await fail('invalid_url', 'This URL cannot be tested. Use a public https address.');
    return;
  }

  const picked = String(row.gemini_model || '').trim();
  const strict = picked !== '' && picked.toLowerCase() !== 'auto';
  let candidates: string[];
  if (strict) {
    candidates = [picked];
  } else {
    const listed = await listBestModels(geminiKey);
    candidates = [...listed, ...FALLBACK_MODELS.filter((m) => !listed.includes(m))];
  }
  let chosen = '';
  const outcomes: Ping[] = [];
  for (const model of candidates) {
    const result = await pingModel(model, geminiKey);
    outcomes.push(result);
    if (result === 'ok') {
      chosen = model;
      break;
    }
  }
  if (!chosen) {
    if (outcomes.includes('quota')) {
      await fail('gemini_quota_exceeded', 'Your Gemini free quota is used up. Wait a while or use another key.');
    } else if (outcomes.includes('bad_key')) {
      await fail('invalid_gemini_key', 'Your Gemini API key was rejected. Check it in Settings.');
    } else if (strict) {
      await fail('model_unavailable', 'The selected model is not available for this key. Choose Auto or another model.');
    } else {
      await fail('model_unavailable', 'No supported Gemini model could be used with this key. Try again later.');
    }
    return;
  }
  config.geminiModel = chosen;
  console.log('Using Gemini model:', chosen);

  const stopTimer = setInterval(async () => {
    try {
      const { data } = await db.from('runs').select('stop_requested').eq('id', runId).maybeSingle();
      const flag = data as unknown as { stop_requested?: boolean } | null;
      if (flag && flag.stop_requested === true) requestRunStop(runId);
    } catch {
      // ignore, will check again
    }
  }, 5000);

  const mode: TestMode = ['smoke', 'user_flow', 'full_qa'].includes(String(row.mode))
    ? (String(row.mode) as TestMode)
    : 'smoke';

  try {
    const agent = new QaAgent({
      runId,
      url,
      command: String(row.command || ''),
      mode,
      credentials,
      geminiKey,
    });
    await agent.execute();
  } finally {
    clearInterval(stopTimer);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('Run failed unexpectedly:', redactSecrets(String(err)));
    process.exit(1);
  });
