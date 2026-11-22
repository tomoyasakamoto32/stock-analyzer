import type { Usage } from '../../../shared/types.ts'
import { AnalysisError } from './errors.ts'
import { OUTPUT_JSON_SCHEMA } from './schema.ts'
import { SYSTEM_PROMPT } from './prompt.ts'

const ENDPOINT = 'https://api.openai.com/v1/responses'
const TIMEOUT_MS = 170_000

export type AiResult = { json: unknown; usage: Pick<Usage, 'inputTokens' | 'outputTokens' | 'totalTokens' | 'reasoningTokens'>; model: string }

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const numOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** OpenAI Responses API(REST)。Web検索ツールは指定しない。store:false。 */
export async function callOpenAI(
  opts: { apiKey: string; model: string; input: string; maxOutputTokens: number },
  fetchImpl: typeof fetch = fetch,
): Promise<AiResult> {
  let res: Response
  try {
    res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        instructions: SYSTEM_PROMPT,
        input: opts.input,
        max_output_tokens: opts.maxOutputTokens,
        store: false,
        text: { format: { type: 'json_schema', name: 'stock_analysis', strict: true, schema: OUTPUT_JSON_SCHEMA } },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    throw new AnalysisError('ai_unavailable', `OpenAIへの接続に失敗(${(e as Error).name}: ${String((e as Error).message).slice(0, 120)})`)
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new AnalysisError('ai_invalid_response', `OpenAI応答がJSONでない(HTTP ${res.status})`)
  }
  if (!res.ok) {
    const msg = isRec(body) && isRec(body.error) && typeof body.error.message === 'string' ? body.error.message.slice(0, 200) : ''
    if (res.status === 401) throw new AnalysisError('ai_unauthorized', 'OpenAI APIキーが無効です(401)')
    if (res.status === 429) throw new AnalysisError('ai_rate_limited', 'OpenAIのレート制限または利用上限です(429)')
    if (res.status >= 500) throw new AnalysisError('ai_unavailable', `OpenAIサーバーエラー(${res.status})`)
    throw new AnalysisError('ai_bad_request', `OpenAIリクエスト不正(${res.status}): ${msg}`)
  }
  if (!isRec(body)) throw new AnalysisError('ai_invalid_response', 'OpenAI応答の形式が不正')

  if (body.status === 'incomplete') {
    const reason = isRec(body.incomplete_details) ? String(body.incomplete_details.reason ?? '') : ''
    throw new AnalysisError('ai_truncated', `AI出力が打ち切られました(${reason || 'incomplete'})。出力上限の引き上げを検討してください`)
  }
  if (body.status !== undefined && body.status !== 'completed') {
    throw new AnalysisError('ai_failed', `OpenAI応答が完了していません(status=${String(body.status)})`)
  }

  let text: string | null = null
  const output = Array.isArray(body.output) ? body.output : []
  for (const item of output) {
    if (!isRec(item) || item.type !== 'message' || !Array.isArray(item.content)) continue
    for (const c of item.content) {
      if (!isRec(c)) continue
      if (c.type === 'refusal') throw new AnalysisError('ai_refusal', 'AIが応答を拒否しました')
      if (c.type === 'output_text' && typeof c.text === 'string') text = (text ?? '') + c.text
    }
  }
  if (text == null) throw new AnalysisError('ai_invalid_response', 'OpenAI応答に出力テキストがありません')

  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new AnalysisError('invalid_ai_output', 'AI出力がJSONとして解析できません')
  }

  const u = isRec(body.usage) ? body.usage : {}
  const details = isRec(u.output_tokens_details) ? u.output_tokens_details : {}
  return {
    json,
    model: typeof body.model === 'string' ? body.model : opts.model,
    usage: {
      inputTokens: numOrNull(u.input_tokens),
      outputTokens: numOrNull(u.output_tokens),
      totalTokens: numOrNull(u.total_tokens),
      reasoningTokens: numOrNull(details.reasoning_tokens),
    },
  }
}
