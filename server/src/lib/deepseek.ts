/**
 * DeepSeek, for the parts of brand classification that are language rather than
 * arithmetic.
 *
 * WHAT THIS IS FOR, AND WHAT IT IS DELIBERATELY NOT FOR.
 *
 * Reading "Nke Air Jordn 1 Retro Hi OG sz10 mens DS" and knowing the brand is Nike is a
 * language problem, and code lost that fight badly enough to be worth paying for. Deciding
 * whether a brand's value is CONSISTENT is an arithmetic problem over a couple of hundred
 * numbers, and a model asked to eyeball that will produce a confident wrong answer. So the
 * model is given the statistics already computed and asked to interpret them; it is never
 * asked to derive them.
 *
 * FAIL OPEN, ALWAYS. Every entry point returns null rather than throwing when the key is
 * missing, the service is down, or the response is malformed. An import that dies because
 * a third party is having an outage is a worse product than one that quietly falls back to
 * the statistical scorer, which works on its own and always did.
 */

const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
/**
 * A NON-REASONING model on purpose.
 *
 * The reasoning variants spend completion tokens thinking before they write, and on a
 * batch this size they spend ALL of them: measured on 151 listings, deepseek-v4-flash
 * used its entire 8,000-token budget on reasoning and emitted nothing at all, then the
 * retry at 24,000 timed out. deepseek-chat answers the same prompt in ~29s using ~4,400
 * tokens, because every token goes to the answer.
 *
 * Classification here is a reading task, not a puzzle — the judgement criteria are spelled
 * out in the prompt, so there is nothing for extended reasoning to add.
 */
const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat';
const API_KEY = process.env.DEEPSEEK_API_KEY ?? '';

export const aiConfigured = (): boolean => Boolean(API_KEY);

interface ChatResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface AiCall<T> {
  value: T;
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * One JSON-mode completion. Returns null on any failure — see the header.
 *
 * `maxTokens` is generous on purpose: the flash models spend completion tokens on
 * internal reasoning before emitting JSON, and a tight cap gets eaten by that and returns
 * empty content with finish_reason "length".
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
  const budget = opts.maxTokens ?? 4000;

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
        max_tokens: budget,
        // Classification should be reproducible: the same listings on Tuesday must not
        // produce a different brand book than they did on Monday.
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });

    if (!res.ok) {
      console.warn(`[deepseek] HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      return null;
    }

    const data = (await res.json()) as ChatResponse;
    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    const finish = choice?.finish_reason;

    /* These models spend completion tokens on internal reasoning BEFORE emitting the
       JSON, so a budget that looked generous can leave the answer half-written. The
       symptom is a parse error on truncated JSON, which is indistinguishable from a bad
       model until you look at finish_reason — so retry once with room rather than
       reporting a failure that was really a budget. */
    const truncated = finish === 'length' || !content;
    if (truncated && attempt < 2) {
      console.warn(`[deepseek] truncated (finish_reason=${finish}); retrying with ${budget * 3} tokens`);
      return chatJSON<T>({ ...opts, maxTokens: budget * 3, attempt: attempt + 1 });
    }
    if (!content) {
      console.warn(`[deepseek] no content (finish_reason=${finish})`);
      return null;
    }

    let parsed: T;
    try {
      parsed = JSON.parse(content) as T;
    } catch (error) {
      if (attempt < 2) {
        console.warn(`[deepseek] unparseable JSON; retrying with ${budget * 3} tokens`);
        return chatJSON<T>({ ...opts, maxTokens: budget * 3, attempt: attempt + 1 });
      }
      console.warn(`[deepseek] unparseable JSON: ${error instanceof Error ? error.message : error}`);
      return null;
    }

    return {
      value: parsed,
      usage: {
        inputTokens: Number(data.usage?.prompt_tokens ?? 0),
        outputTokens: Number(data.usage?.completion_tokens ?? 0),
      },
    };
  } catch (error) {
    console.warn(`[deepseek] ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
