/**
 * The model that classifies brands. OpenAI-compatible chat completions.
 *
 * One provider, swappable by environment: OPENAI_BASE_URL points anywhere that speaks the
 * same protocol, which is most of them. Nothing above this file knows which model answered.
 *
 * FAIL OPEN, ALWAYS. Every entry point returns null rather than throwing when the key is
 * missing, the service is down, or the response is malformed. An import that dies because
 * a third party is having an outage is a worse product than one that quietly carries on.
 */

const BASE_URL = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
const MODEL = process.env.OPENAI_MODEL ?? 'gpt-5-nano';
const API_KEY = process.env.OPENAI_API_KEY ?? '';

export const aiConfigured = (): boolean => Boolean(API_KEY);
export const aiModel = (): string => MODEL;

interface ChatResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  error?: { message?: string };
}

export interface AiCall<T> {
  value: T;
  usage: { inputTokens: number; outputTokens: number; reasoningTokens: number };
}

/**
 * Newer OpenAI models renamed the output cap and refuse the old name outright. Older ones
 * and most compatible providers only understand the old one, so the parameter is chosen
 * per model rather than guessed once.
 */
function tokenLimitField(model: string): 'max_completion_tokens' | 'max_tokens' {
  return /^(gpt-5|gpt-4\.1|o\d)/i.test(model) ? 'max_completion_tokens' : 'max_tokens';
}

/**
 * One JSON-mode completion. Returns null on any failure — see the header.
 *
 * `maxTokens` is a ceiling on everything the model emits, INCLUDING the reasoning it does
 * before writing. A cap that looks generous for the answer alone can still be swallowed
 * whole by reasoning, which shows up as truncated JSON rather than as an error, so the
 * budget is deliberately far above what the answer needs.
 */
export async function chatJSON<T>(opts: {
  system: string;
  user: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** Internal: set on the retry so a truncation loop cannot recurse forever. */
  attempt?: number;
}): Promise<AiCall<T> | null> {
  if (!API_KEY) return null;

  const attempt = opts.attempt ?? 1;
  const budget = opts.maxTokens ?? 16000;

  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
        response_format: { type: 'json_object' },
        [tokenLimitField(MODEL)]: budget,
        // Temperature is deliberately NOT sent. The reasoning models accept only their
        // default and reject any explicit value, and the default is right here anyway.
        stream: false,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[llm] HTTP ${res.status}: ${body.slice(0, 300)}`);
      return null;
    }

    const data = (await res.json()) as ChatResponse;
    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    const finish = choice?.finish_reason;

    const truncated = finish === 'length' || !content;
    if (truncated && attempt < 2) {
      console.warn(`[llm] truncated (finish_reason=${finish}); retrying with ${budget * 3} tokens`);
      return chatJSON<T>({ ...opts, maxTokens: budget * 3, attempt: attempt + 1 });
    }
    if (!content) {
      console.warn(`[llm] no content (finish_reason=${finish})`);
      return null;
    }

    let parsed: T;
    try {
      parsed = JSON.parse(content) as T;
    } catch (error) {
      if (attempt < 2) {
        console.warn(`[llm] unparseable JSON; retrying with ${budget * 3} tokens`);
        return chatJSON<T>({ ...opts, maxTokens: budget * 3, attempt: attempt + 1 });
      }
      console.warn(`[llm] unparseable JSON: ${error instanceof Error ? error.message : error}`);
      return null;
    }

    return {
      value: parsed,
      usage: {
        inputTokens: Number(data.usage?.prompt_tokens ?? 0),
        outputTokens: Number(data.usage?.completion_tokens ?? 0),
        reasoningTokens: Number(data.usage?.completion_tokens_details?.reasoning_tokens ?? 0),
      },
    };
  } catch (error) {
    console.warn(`[llm] ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
