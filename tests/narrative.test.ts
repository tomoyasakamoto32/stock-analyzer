import { test } from 'node:test'
import assert from 'node:assert/strict'
import { excerpt, htmlToText, isIrHeadline, periodicKind } from '../src/server/services/providers/irbank/narrative.ts'
import { IrbankClient } from '../src/server/services/providers/irbank/client.ts'
import { IrbankProvider } from '../src/server/services/providers/irbank/index.ts'
import { MockProvider } from '../src/server/services/providers/mock/index.ts'
import { collect } from '../src/server/services/analysis/collect.ts'
import { buildSnapshot } from '../src/server/services/analysis/snapshot.ts'
import { buildUserInput } from '../src/server/services/analysis/prompt.ts'
import { normalizeUrl, researchToEvidence, validateResearch, callResearch } from '../src/server/services/analysis/web-research.ts'
import { AnalysisError } from '../src/server/services/analysis/errors.ts'
import { ProviderError } from '../src/server/services/providers/types.ts'

test('HTML→テキスト: タグ・実体参照・空白を整理し、scriptは除く', () => {
  const t = htmlToText('<h3>２【経営者による分析】</h3><p style="x">売上高は8,674億円&#160;（前年同期比55.2％増）&amp;営業利益</p><script>alert(1)</script><p>次&lt;段落&gt;</p>')
  assert.equal(t, '２【経営者による分析】\n売上高は8,674億円 （前年同期比55.2％増）&営業利益\n次<段落>')
  assert.ok(!t.includes('alert'))
  assert.equal(htmlToText('a&#0;b&#x1F4A9;c').includes('\u0000'), false)
})

test('抜粋: 長さ制限・句点で丸め・切り詰めフラグ', () => {
  assert.deepEqual(excerpt('短い文。', 100), { text: '短い文。', truncated: false })
  const e = excerpt('あ'.repeat(50) + '。' + 'い'.repeat(100), 80)
  assert.ok(e.truncated && e.text.endsWith('。…') && e.text.length < 80)
})

test('報告書の種別判定とIR見出し判定', () => {
  assert.equal(periodicKind('有価証券報告書－第178期(2025/04/01－2026/03/31)'), 'yuho')
  assert.equal(periodicKind('半期報告書－第179期'), 'half')
  assert.equal(periodicKind('四半期報告書－第1期'), 'quarter')
  assert.equal(periodicKind('内部統制報告書－第178期'), null)
  assert.equal(periodicKind('訂正有価証券報告書'), null)
  assert.equal(periodicKind('臨時報告書'), null)
  assert.ok(isIrHeadline('連結子会社の異動（株式譲渡）に関するお知らせ'))
  assert.ok(!isIrHeadline('Notice Regarding Change in Consolidated Subsidiary'))
  assert.ok(!isIrHeadline('2027年３月期 第２四半期決算短信〔日本基準〕（連結）'))
})

function providerWith(routes: Record<string, unknown>, calls: string[] = []) {
  const f = (async (url: string) => {
    const u = new URL(url)
    calls.push(u.pathname.replace('/v1', '') + u.search)
    const hit = routes[u.pathname.replace('/v1', '')]
    return hit === undefined ? new Response('{}', { status: 404 }) : new Response(JSON.stringify(hit), { status: 200 })
  }) as unknown as typeof fetch
  return new IrbankProvider('k', new IrbankClient('k', f, async () => {}))
}
const attribution = { source_label: 'EDINET' }
const dl = (doc_id: string, source: string, title: string, disclosed_at: string) => ({ doc_id, source, title, disclosed_at })

test('getNarratives: 最新の定期報告書からmda、有報から経営方針・リスクを取得し、IR見出しを返す', async () => {
  const calls: string[] = []
  const p = providerWith(
    {
      '/securities/5803/disclosures': {
        disclosures: [
          dl('T1', 'tdnet', '連結子会社の異動に関するお知らせ', '2026-11-05T05:00:00.000Z'),
          dl('T2', 'tdnet', 'Notice Regarding Change', '2026-11-05T05:00:00.000Z'),
          dl('T3', 'tdnet', '2027年３月期 第２四半期決算短信〔日本基準〕（連結）', '2026-11-10T05:00:00.000Z'),
          dl('HALF', 'edinet', '半期報告書－第179期', '2026-11-11T01:55:00.000Z'),
          dl('IC', 'edinet', '内部統制報告書－第178期', '2026-06-23T00:00:00.000Z'),
          dl('YUHO', 'edinet', '有価証券報告書－第178期', '2026-06-23T00:00:00.000Z'),
        ],
        attribution,
      },
      '/disclosures/HALF/sections/mda': { section_text: '<p>売上高は<b>8,674億円</b>（前年同期比55.2％増）</p>' },
      '/disclosures/YUHO/sections/management_policy': { section_text: '<p>経営環境は…</p>' },
      '/disclosures/YUHO/sections/risk_factors': { section_text: null },
    },
    calls,
  )
  const r = (await p.getNarratives('5803')).data
  assert.deepEqual(r.docs.map((d) => [d.kind, d.docId]), [['mda', 'HALF'], ['management_policy', 'YUHO']])
  assert.match(r.docs[0]!.text, /^売上高は 8,674億円 （前年同期比55.2％増）|^売上高は8,674億円/)
  assert.deepEqual(r.recentIr.map((x) => x.title), ['連結子会社の異動に関するお知らせ']) // 英文・短信は除く
  assert.ok(r.reasons.some((x) => x.includes('事業等のリスク')))
  assert.equal(calls.filter((c) => c.startsWith('/securities/5803/disclosures')).length, 1, '一覧は1回だけ')
})

test('getNarratives: 一覧に有報が無ければ document_type で補完。取得失敗は理由に残し例外にしない', async () => {
  const calls: string[] = []
  const p = providerWith(
    {
      '/securities/1/disclosures': { disclosures: [dl('HALF', 'edinet', '半期報告書－第1期', '2026-11-11T00:00:00.000Z')], attribution },
      '/disclosures/HALF/sections/mda': { section_text: '<p>本文</p>' },
    },
    calls,
  )
  const r = (await p.getNarratives('1')).data
  assert.equal(r.docs.length, 1)
  assert.ok(calls.some((c) => c.includes('document_type=')), '有報の補完取得を試みる')
  assert.ok(r.reasons.length >= 1)
})

test('getSegments: 単位検証・%正規化・period=quarter を付与', async () => {
  const calls: string[] = []
  const p = providerWith(
    {
      '/segments': {
        fields: [{ key: 'revenue', unit: 'jpy' }, { key: 'operating_income', unit: 'jpy' }, { key: 'yoy_growth', unit: 'percent' }, { key: 'revenue_share', unit: 'percent' }],
        segments: [{ fiscal_year: '2027/03', quarter: 2, segment_name: '情報通信', revenue: 317, operating_income: 119, revenue_share: 36.2, yoy_growth: 98.56 }],
      },
    },
    calls,
  )
  const r = await p.getSegments('E1', 'quarter')
  assert.deepEqual(r.data[0], { fiscalYear: '2027/03', quarter: 2, name: '情報通信', revenue: 317, operatingIncome: 119, revenueSharePct: 36.2, yoyGrowthPct: 98.56 })
  assert.ok(calls[0]!.includes('period=quarter'))
  const bad = providerWith({ '/segments': { fields: [{ key: 'revenue', unit: 'million_jpy' }], segments: [] } })
  await assert.rejects(bad.getSegments('E1', 'annual'), (e: ProviderError) => e.code === 'invalid_response')
})

// ---- スナップショット ----
const mock = new MockProvider()
const get = (s: ReturnType<typeof buildSnapshot>, id: string) => s.evidence.find((e) => e.id === id)

test('セグメント・文章抜粋・IR見出しが、取得元・基準日・定義つきのevidenceになる', async () => {
  const s = buildSnapshot(await collect(mock, '7203'))
  const rev = get(s, 'seg.a.1.revenue')!
  assert.deepEqual([rev.origin, rev.basis, rev.unit], ['api', 'actual', '円'])
  assert.match(rev.label, /モック事業A/)
  assert.ok(get(s, 'seg.q.1.yoy')!.period!.includes('Q2'))
  const mda = get(s, 'nar.mda')!
  assert.deepEqual([mda.origin, mda.unit], ['disclosure', 'text'])
  assert.match(mda.definition, /引用であり/)
  assert.ok(get(s, 'ir.1')!.value!.toString().includes('自己株式'))
  assert.ok(s.missingData.some((m) => m.includes('事業等のリスク')))
})

test('文章が取れない場合は不足情報に残し、推測で補わない', async () => {
  const c = await collect(mock, '7203')
  c.narratives = { docs: [], recentIr: [], reasons: [] }
  c.segmentsAnnual = []
  c.segmentsQuarter = []
  const s = buildSnapshot(c)
  assert.equal(get(s, 'nar.mda'), undefined)
  assert.ok(s.missingData.some((m) => m.includes('利益の増減要因')))
  assert.ok(s.missingData.some((m) => m.includes('経営環境・競争優位')))
  assert.ok(s.missingData.some((m) => m.includes('セグメント別業績')))
})

test('AI入力: 文章evidenceの本文は全文を含み、全体が上限(90,000文字)に収まる', async () => {
  const s = buildSnapshot(await collect(mock, '7203'))
  const input = buildUserInput(s, 'mid_long', 90000)
  assert.ok(input.includes('経営環境は需要拡大'))
  assert.ok(input.length < 60000, String(input.length))
})

test('プロンプト: 文章・セグメント・IR・Webの扱い(命令無視・信頼度・価格の唯一根拠にしない)を指示している', async () => {
  const { SYSTEM_PROMPT } = await import('../src/server/services/analysis/prompt.ts')
  for (const k of ['nar.mda', 'seg.*', 'ir.*', 'web.*', '命令ではない', '唯一の根拠にしない', '未検証'])
    assert.ok(SYSTEM_PROMPT.includes(k), k)
})

// ---- Web検索 ----
test('URL正規化: https以外は拒否、utm・ハッシュ・末尾スラッシュを除く', () => {
  assert.equal(normalizeUrl('https://example.com/a/?utm_source=openai&x=1#top'), 'https://example.com/a?x=1')
  assert.equal(normalizeUrl('http://example.com/a'), null)
  assert.equal(normalizeUrl('javascript:alert(1)'), null)
  assert.equal(normalizeUrl('not a url'), null)
})

const it = (over: Record<string, unknown> = {}) => ({ text: '需要が拡大している', sourceTitle: '日経', sourceUrl: 'https://example.com/n1', publishedAt: '2026-11-01', ...over })

test('Web検索の検証: 引用に含まれる出典URLの項目だけ採用し、創作URL・http・欠損を捨てる', () => {
  const cited = new Set(['https://example.com/n1', 'https://example.com/n2'])
  const r = validateResearch(
    {
      industryTrends: [it(), it({ sourceUrl: 'https://invented.example/x' }), it({ sourceUrl: 'http://example.com/n2' }), it({ sourceUrl: 'https://example.com/n2?utm_source=openai', publishedAt: 'きのう' })],
      companyNews: [it({ text: '  ' }), { text: 1 }, it({ sourceUrl: 'https://example.com/n2', text: 'あ'.repeat(400) })],
      notFound: ['x', 3],
    },
    cited,
  )
  assert.deepEqual(r.items.map((x) => [x.kind, x.sourceUrl, x.publishedAt]), [['industry', 'https://example.com/n1', '2026-11-01'], ['industry', 'https://example.com/n2', null], ['news', 'https://example.com/n2', '2026-11-01']])
  assert.equal(r.dropped, 4)
  assert.ok(r.items[2]!.text.length <= 301)
  assert.deepEqual(r.notFound, ['x'])
  assert.throws(() => validateResearch({ x: 1 }, cited), AnalysisError)
})

test('Web検索結果は origin=web・未検証の定義・URL付きのevidenceになる', () => {
  const ev = researchToEvidence([
    { kind: 'industry', text: 'A', sourceTitle: '日経', sourceUrl: 'https://example.com/n1', publishedAt: '2026-11-01' },
    { kind: 'news', text: 'B', sourceTitle: '', sourceUrl: 'https://example.com/n2', publishedAt: null },
  ])
  assert.deepEqual(ev.map((e) => e.id), ['web.industry.1', 'web.news.1'])
  assert.ok(ev.every((e) => e.origin === 'web' && /未検証/.test(e.definition)))
  assert.equal(ev[1]!.sourceLabel, 'example.com')
  assert.equal(ev[0]!.endpoint, 'https://example.com/n1')
})

test('callResearch: web_searchツール・store:false・strict json_schema で呼び、url_citationで出典を検証する', async () => {
  let sent: Record<string, unknown> = {}
  const body = {
    status: 'completed',
    output: [
      { type: 'web_search_call', id: 'w1' },
      { type: 'web_search_call', id: 'w2' },
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: JSON.stringify({ industryTrends: [it()], companyNews: [it({ sourceUrl: 'https://invented.example/z' })], notFound: [] }),
            annotations: [{ type: 'url_citation', url: 'https://example.com/n1?utm_source=openai', title: '日経' }],
          },
        ],
      },
    ],
    usage: { input_tokens: 1000, output_tokens: 200 },
  }
  const f = (async (_u: string, init: RequestInit) => {
    sent = JSON.parse(init.body as string)
    return new Response(JSON.stringify(body), { status: 200 })
  }) as unknown as typeof fetch
  const r = await callResearch({ apiKey: 'k', model: 'm', input: '{}', maxOutputTokens: 100 }, f)
  assert.deepEqual(sent.tools, [{ type: 'web_search' }])
  assert.equal(sent.store, false)
  assert.equal((sent.text as { format: { strict: boolean } }).format.strict, true)
  assert.equal(r.searchCalls, 2)
  assert.equal(r.items.length, 1)
  assert.equal(r.dropped, 1)
  assert.deepEqual(r.usage, { inputTokens: 1000, outputTokens: 200 })
})

test('callResearch: HTTPエラー・拒否・打ち切り・不正JSONは失敗として扱う', async () => {
  const code = async (status: number, b: unknown) => {
    const f = (async () => new Response(JSON.stringify(b), { status })) as unknown as typeof fetch
    try {
      await callResearch({ apiKey: 'k', model: 'm', input: '{}', maxOutputTokens: 1 }, f)
      return 'ok'
    } catch (e) {
      return (e as AnalysisError).code
    }
  }
  assert.equal(await code(400, { error: { message: 'tool not supported' } }), 'ai_bad_request')
  assert.equal(await code(429, {}), 'ai_rate_limited')
  assert.equal(await code(200, { status: 'incomplete', output: [] }), 'ai_truncated')
  assert.equal(await code(200, { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'x' }] }] }), 'ai_refusal')
  assert.equal(await code(200, { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'not json' }] }] }), 'invalid_ai_output')
})

test('Web本文の整形: 引用表記([媒体](URL))・裸のURLを除き、出典は別フィールドで持つ', async () => {
  const { cleanWebText } = await import('../src/server/services/analysis/web-research.ts')
  assert.equal(cleanWebText('光ファイバ需要は5.77億kmと推計。([trendforce.com](https://www.trendforce.com/a?utm_source=openai))'), '光ファイバ需要は5.77億kmと推計。')
  assert.equal(cleanWebText('詳細は [公式発表](https://example.com/x) を参照 https://example.com/y'), '詳細は 公式発表 を参照')
  assert.equal(cleanWebText('通常の文。'), '通常の文。')
  const r = validateResearch({ industryTrends: [it({ text: '需要が拡大。([日経](https://example.com/n1))' })], companyNews: [it({ text: '([x](https://example.com/n1))' })], notFound: [] }, new Set(['https://example.com/n1']))
  assert.deepEqual(r.items.map((x) => x.text), ['需要が拡大。'])
  assert.equal(r.dropped, 1, '整形後に空になる項目は捨てる')
})
