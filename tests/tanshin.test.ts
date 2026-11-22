import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IrbankClient } from '../src/server/services/providers/irbank/client.ts'
import { IrbankProvider } from '../src/server/services/providers/irbank/index.ts'
import { ProviderError } from '../src/server/services/providers/types.ts'
import { MAX_PDF_BYTES, checkPdf, summarizeTanshinPdf, tanshinToEvidence, toBase64, validateTanshinSummary } from '../src/server/services/analysis/tanshin-pdf.ts'
import { AnalysisError } from '../src/server/services/analysis/errors.ts'
import { buildUserInput } from '../src/server/services/analysis/prompt.ts'
import { MockProvider } from '../src/server/services/providers/mock/index.ts'
import { collect } from '../src/server/services/analysis/collect.ts'
import { buildSnapshot } from '../src/server/services/analysis/snapshot.ts'

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 1, 2, 3]) // "%PDF-1.7\n..."
const URL_OK = 'https://api.irbank.net/api/market-files/v1/tdnet/20261109569418.pdf'

function client(res: () => Response, seen: { url?: string; auth?: string | null; accept?: string | null } = {}) {
  const f = (async (url: string, init?: RequestInit) => {
    seen.url = url
    const h = new Headers(init?.headers)
    seen.auth = h.get('authorization')
    seen.accept = h.get('accept')
    return res()
  }) as unknown as typeof fetch
  return new IrbankClient('irbk_key', f, async () => {})
}

test('PDF取得: キー付きで取得しバイト列を返す。取得先はIRBANKのファイル配信URLに限定(キーを他ホストへ送らない)', async () => {
  const seen: { url?: string; auth?: string | null; accept?: string | null } = {}
  const c = client(() => new Response(PDF, { status: 200 }), seen)
  const b = await c.getBinary(URL_OK, 1000)
  assert.deepEqual([...b], [...PDF])
  assert.equal(seen.auth, 'Bearer irbk_key')
  assert.equal(seen.accept, 'application/pdf')
  for (const bad of ['https://evil.example/x.pdf', 'http://api.irbank.net/api/market-files/v1/x.pdf', 'https://api.irbank.net/v1/securities/7203', 'https://api.irbank.net.evil.example/api/market-files/x']) {
    seen.url = undefined
    await assert.rejects(c.getBinary(bad, 1000), (e: ProviderError) => e.code === 'bad_request', bad)
    assert.equal(seen.url, undefined, '許可されないURLには一切リクエストしない')
  }
})

test('PDF取得: サイズ上限超過・404・401を失敗として扱う', async () => {
  await assert.rejects(client(() => new Response(new Uint8Array(100), { status: 200 })).getBinary(URL_OK, 50), (e: ProviderError) => e.code === 'invalid_response')
  await assert.rejects(client(() => new Response('', { status: 404 })).getBinary(URL_OK, 50), (e: ProviderError) => e.code === 'not_found')
  await assert.rejects(client(() => new Response('', { status: 401 })).getBinary(URL_OK, 50), (e: ProviderError) => e.code === 'unauthorized')
})

test('getForecast: 決算短信の pdf_url を保持する(無ければ null)', async () => {
  const f = (async (url: string) => {
    const path = new URL(url).pathname.replace('/v1', '')
    if (path === '/securities/5803/disclosures') {
      return new Response(JSON.stringify({ disclosures: [{ doc_id: 'T', source: 'tdnet', title: '2027年３月期 第２四半期決算短信〔日本基準〕（連結）', disclosed_at: '2026-11-10T05:00:00.000Z', pdf_url: URL_OK }], attribution: {} }), { status: 200 })
    }
    return new Response(JSON.stringify({ xbrl_facts: [], attribution: {} }), { status: 200 })
  }) as unknown as typeof fetch
  const p = new IrbankProvider('k', new IrbankClient('k', f, async () => {}))
  assert.equal((await p.getForecast('5803')).data.pdfUrl, URL_OK)
})

test('PDFの検査: 空・大きすぎ・PDFでないものを拒否', () => {
  assert.doesNotThrow(() => checkPdf(PDF))
  for (const bad of [new Uint8Array(0), new Uint8Array(MAX_PDF_BYTES + 1), new TextEncoder().encode('<html>not pdf</html>')]) assert.throws(() => checkPdf(bad), (e: AnalysisError) => e.code === 'pdf_invalid')
})

test('base64: 大きなバイト列でも正しく変換する', () => {
  const big = new Uint8Array(100_000).map((_, i) => i % 251)
  assert.deepEqual([...new Uint8Array(Buffer.from(toBase64(big), 'base64'))], [...big])
})

const summaryJson = { performance: '売上高は前年同期比55.2%増。情報通信が牽引。', outlook: '通期は増収増益を見込む。', revisions: '営業利益予想を4,290億円に修正、配当予想を80円に引き上げ。', financialPosition: '総資産は増加。', notFound: [] as string[] }

test('決算短信の要約: input_file(PDF)・store:false・strict json_schema で呼び、要約を返す', async () => {
  let sent: Record<string, unknown> = {}
  const f = (async (_u: string, init: RequestInit) => {
    sent = JSON.parse(init.body as string)
    return new Response(
      JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(summaryJson) }] }], usage: { input_tokens: 9000, output_tokens: 400 } }),
      { status: 200 },
    )
  }) as unknown as typeof fetch
  const r = await summarizeTanshinPdf({ apiKey: 'k', model: 'm', pdf: PDF, filename: 'T.pdf', maxOutputTokens: 100 }, f)
  const content = (sent.input as { content: { type: string; filename?: string; file_data?: string }[] }[])[0]!.content
  assert.equal(content[0]!.type, 'input_file')
  assert.equal(content[0]!.filename, 'T.pdf')
  assert.ok(content[0]!.file_data!.startsWith('data:application/pdf;base64,'))
  assert.equal(sent.store, false)
  assert.equal(sent.tools, undefined, 'PDF要約ではWeb検索を使わない')
  assert.equal((sent.text as { format: { strict: boolean } }).format.strict, true)
  assert.equal(r.summary.revisions.includes('4,290億円'), true)
  assert.deepEqual(r.usage, { inputTokens: 9000, outputTokens: 400 })
})

test('決算短信の要約: PDFでない入力は送信前に拒否 / HTTPエラー・拒否・不正JSONは失敗', async () => {
  let called = false
  const spy = (async () => ((called = true), new Response('{}', { status: 200 }))) as unknown as typeof fetch
  await assert.rejects(summarizeTanshinPdf({ apiKey: 'k', model: 'm', pdf: new TextEncoder().encode('<html>'), filename: 'x.pdf', maxOutputTokens: 1 }, spy), AnalysisError)
  assert.equal(called, false, '不正なファイルはAIに送らない')
  const code = async (status: number, b: unknown) => {
    const f = (async () => new Response(JSON.stringify(b), { status })) as unknown as typeof fetch
    try {
      await summarizeTanshinPdf({ apiKey: 'k', model: 'm', pdf: PDF, filename: 'x.pdf', maxOutputTokens: 1 }, f)
      return 'ok'
    } catch (e) {
      return (e as AnalysisError).code
    }
  }
  assert.equal(await code(400, { error: { message: 'bad file' } }), 'ai_bad_request')
  assert.equal(await code(429, {}), 'ai_rate_limited')
  assert.equal(await code(200, { status: 'incomplete', output: [] }), 'ai_truncated')
  assert.equal(await code(200, { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'x' }] }] }), 'ai_refusal')
  assert.equal(await code(200, { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'nope' }] }] }), 'invalid_ai_output')
})

test('要約の検証: 型違いを拒否し、長い項目は切り詰める', () => {
  assert.throws(() => validateTanshinSummary({ ...summaryJson, outlook: 1 }), AnalysisError)
  assert.throws(() => validateTanshinSummary(null), AnalysisError)
  assert.ok(validateTanshinSummary({ ...summaryJson, performance: 'あ'.repeat(900) }).performance.length <= 501)
})

test('nar.tanshin: AI要約であることと、構造化値を優先する旨を定義に明記し、AI入力に含まれる', async () => {
  const ev = tanshinToEvidence({ ...summaryJson, notFound: ['配当の修正理由'] }, { title: '2027年３月期 第２四半期決算短信', disclosedJst: '2026-11-10' }, 'JPX TDnet')
  assert.deepEqual([ev.id, ev.origin, ev.unit, ev.asOf], ['nar.tanshin', 'disclosure', 'text', '2026-11-10'])
  assert.match(ev.definition, /AIが要約したもの/)
  assert.match(ev.definition, /構造化された指標.*優先/)
  assert.match(ev.definition, /PDFに記載なし: 配当の修正理由/)
  assert.match(String(ev.value), /【経営成績】.*【通期見通し】.*【予想・配当の修正】.*【財政状態】/s)
  const s = buildSnapshot(await collect(new MockProvider(), '7203'))
  s.evidence.push(ev)
  assert.ok(buildUserInput(s, 'mid_long', 1e6).includes('営業利益予想を4,290億円に修正'))
})

test('プロンプト: nar.tanshin の扱い(AI要約・数値は構造化値を優先)を指示している', async () => {
  const { SYSTEM_PROMPT } = await import('../src/server/services/analysis/prompt.ts')
  assert.ok(SYSTEM_PROMPT.includes('nar.tanshin'))
  assert.ok(SYSTEM_PROMPT.includes('構造化された値を優先'))
})

// ---- 分析に使った開示書類(確認用) ----
import { parseDocuments } from '../src/server/services/analysis/stored.ts'

test('分析に使った開示書類: 決算短信と報告書を、使った内容つきで文書ID単位にまとめる', async () => {
  const c = await collect(new MockProvider(), '7203')
  c.forecast!.docId = 'T1'
  c.forecast!.pdfUrl = URL_OK
  c.narratives!.docs.push({ kind: 'management_policy', docId: 'T1X', docTitle: 'x', disclosedAt: '2026-06-01T00:00:00.000Z', text: 't', truncated: false, pdfUrl: null, sourceUrl: null })
  const docs = buildSnapshot(c).documents!
  const t = docs.find((d) => d.docId === 'T1')!
  assert.deepEqual([t.source, t.pdfUrl], ['tdnet', URL_OK])
  assert.match(t.roles.join(), /決算短信の要約/)
  const mda = docs.find((d) => d.docId === 'MOCK-HALF')!
  assert.deepEqual([mda.source, mda.roles], ['edinet', ['経営者による分析(業績要因)']])
  // 同じ文書を複数の用途で使った場合は1行にまとめ、用途を併記する
  c.narratives!.docs.push({ kind: 'risk_factors', docId: 'MOCK-HALF', docTitle: 'モック半期報告書', disclosedAt: '2026-11-01T00:00:00.000Z', text: 't', truncated: false, pdfUrl: null, sourceUrl: null })
  const merged = buildSnapshot(c).documents!.filter((d) => d.docId === 'MOCK-HALF')
  assert.equal(merged.length, 1)
  assert.deepEqual(merged[0]!.roles, ['経営者による分析(業績要因)', '事業等のリスク'])
})

test('保存済み開示書類の読み出し: 不正な要素は捨て、無ければ空配列', () => {
  assert.deepEqual(parseDocuments(null), [])
  assert.deepEqual(parseDocuments('not json'), [])
  assert.deepEqual(parseDocuments(JSON.stringify({ sources: [] })), [])
  const r = parseDocuments(
    JSON.stringify({ documents: [{ docId: 'A1', source: 'edinet', title: 't', disclosedAt: '2026-01-01T00:00:00.000Z', roles: ['x', 1], pdfUrl: 3, sourceUrl: 'https://e.example/' }, { docId: 5 }, null] }),
  )
  assert.equal(r.length, 1)
  assert.deepEqual([r[0]!.roles, r[0]!.pdfUrl, r[0]!.sourceUrl], [['x'], null, 'https://e.example/'])
})
