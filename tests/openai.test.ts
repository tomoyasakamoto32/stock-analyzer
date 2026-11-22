import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callOpenAI } from '../src/server/services/analysis/openai.ts'
import { AnalysisError } from '../src/server/services/analysis/errors.ts'

const opts = { apiKey: 'sk-test', model: 'm', input: '{}', maxOutputTokens: 100 }
const respond = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
const text = (t: string, extra: Record<string, unknown> = {}) => ({
  status: 'completed',
  model: 'm-2026',
  output: [{ type: 'message', content: [{ type: 'output_text', text: t }] }],
  usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30, output_tokens_details: { reasoning_tokens: 5 } },
  ...extra,
})

test('リクエスト: Web検索ツールなし・store:false・strict json_schema', async () => {
  let sent: Record<string, unknown> = {}
  let auth = ''
  const f = (async (_u: string, init: RequestInit) => {
    sent = JSON.parse(init.body as string)
    auth = new Headers(init.headers).get('authorization') ?? ''
    return new Response(JSON.stringify(text('{"a":1}')), { status: 200 })
  }) as unknown as typeof fetch
  const r = await callOpenAI(opts, f)
  assert.equal(sent.store, false)
  assert.equal(sent.tools, undefined)
  assert.equal(sent.max_output_tokens, 100)
  assert.equal((sent.text as { format: { type: string; strict: boolean } }).format.type, 'json_schema')
  assert.equal((sent.text as { format: { strict: boolean } }).format.strict, true)
  assert.equal(auth, 'Bearer sk-test')
  assert.deepEqual(r.json, { a: 1 })
  assert.deepEqual(r.usage, { inputTokens: 10, outputTokens: 20, totalTokens: 30, reasoningTokens: 5 })
  assert.equal(r.model, 'm-2026')
})

test('拒否・打ち切り・不正JSON・HTTPエラーは失敗として扱う', async () => {
  const code = async (f: typeof fetch) => {
    try {
      await callOpenAI(opts, f)
      return 'ok'
    } catch (e) {
      return (e as AnalysisError).code
    }
  }
  assert.equal(await code(respond(200, { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] })), 'ai_refusal')
  assert.equal(await code(respond(200, { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] })), 'ai_truncated')
  assert.equal(await code(respond(200, text('not json'))), 'invalid_ai_output')
  assert.equal(await code(respond(200, { status: 'completed', output: [] })), 'ai_invalid_response')
  assert.equal(await code(respond(401, { error: { message: 'bad key' } })), 'ai_unauthorized')
  assert.equal(await code(respond(429, {})), 'ai_rate_limited')
  assert.equal(await code(respond(503, {})), 'ai_unavailable')
  assert.equal(await code(respond(400, { error: { message: 'x' } })), 'ai_bad_request')
  assert.equal(await code((async () => { throw new TypeError('net') }) as unknown as typeof fetch), 'ai_unavailable')
})
