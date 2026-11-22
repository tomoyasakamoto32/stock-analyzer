import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockProvider } from '../src/server/services/providers/mock/index.ts'
import { collect } from '../src/server/services/analysis/collect.ts'
import { buildSnapshot } from '../src/server/services/analysis/snapshot.ts'
import { mockAnalysis } from '../src/server/services/analysis/mock-ai.ts'
import { checkOutput } from '../src/server/services/analysis/output-check.ts'
import { buildUserInput } from '../src/server/services/analysis/prompt.ts'
import { estimateCost } from '../src/server/services/analysis/cost.ts'
import { AnalysisError } from '../src/server/services/analysis/errors.ts'
import { ProviderError, type MarketDataProvider } from '../src/server/services/providers/types.ts'
import { normalizeStockCode } from '../src/shared/validate.ts'
import type { AnalysisOutput } from '../src/shared/types.ts'

const provider = new MockProvider()
async function snap(code: string) {
  return buildSnapshot(await collect(provider, code))
}
const val = (s: Awaited<ReturnType<typeof snap>>, id: string) => s.evidence.find((e) => e.id === id)

test('銘柄コード: trim/uppercase と4桁英数字検証', () => {
  assert.equal(normalizeStockCode(' 285a '), '285A')
  assert.equal(normalizeStockCode('7203'), '7203')
  for (const bad of ['', '123', '12345', '72-3', '７２０３', null, 7203]) assert.equal(normalizeStockCode(bad), null)
})

test('一般事業会社: 主要指標が揃い、利回り別株価はサーバー計算', async () => {
  const s = await snap('7203')
  assert.equal(s.isFinancialInstitution, false)
  assert.notEqual(val(s, 'val.per')?.value, null)
  assert.notEqual(val(s, 'val.net_cash'), undefined)
  assert.notEqual(val(s, 'tech.sma200')?.value, null)
  assert.equal(s.yieldPrices.length, 5)
  const dps = val(s, 'val.dps')!.value as number
  assert.equal(s.yieldPrices[0]!.price, dps / 0.03)
  assert.equal(val(s, 'val.per_forecast')!.basis, 'forecast') // 会社予想ベースは別ID
  assert.ok(s.evidence.every((e) => e.id && e.sourceLabel && e.definition && e.origin))
})

test('赤字企業: PER・配当性向は null で、理由が不足情報に出る', async () => {
  const s = await snap('9998')
  assert.equal(val(s, 'val.per')?.value, null)
  assert.ok(s.missingData.some((m) => m.includes('最新PER')))
})

test('金融機関: 有利子負債・ネットキャッシュ・FCFは非適用で、制約を明示', async () => {
  const s = await snap('8306')
  assert.equal(s.isFinancialInstitution, true)
  assert.equal(val(s, 'val.net_cash'), undefined)
  assert.equal(val(s, 'val.cash_adjusted_per'), undefined)
  assert.ok(![...s.evidence].some((e) => e.id.endsWith('.fcf') || e.id.endsWith('.net_cash')))
  assert.ok(s.missingData.some((m) => m.includes('金融機関')))
})

test('英数字コード・売り残0: 信用倍率は null で理由付き', async () => {
  const s = await snap('285A')
  assert.equal(s.stock.code, '285A')
  const r = val(s, 'sd.margin_ratio')!
  assert.equal(r.value, null)
  assert.match(r.definition, /売り残が0/)
  assert.equal(r.origin, 'calculated') // APIにmargin_ratioが無いため算出した
})

test('必須データ不足は失敗扱い(存在しない銘柄・日足不足・年次財務なし)', async () => {
  await assert.rejects(collect(provider, '0000'), (e: AnalysisError) => e.code === 'stock_not_found')
  const short: MarketDataProvider = Object.assign(Object.create(provider) as MarketDataProvider, {
    getPrices: async () => ({ data: [], meta: { dataset: 'prices', sourceLabel: 'x', fetchedAt: '', asOf: null } }),
  })
  await assert.rejects(collect(short, '7203'), (e: AnalysisError) => e.code === 'insufficient_data')
  const noFin: MarketDataProvider = Object.assign(Object.create(provider) as MarketDataProvider, {
    getFinancials: async () => ({ data: { annual: [], latestQuarter: null }, meta: { dataset: 'financials', sourceLabel: 'x', fetchedAt: '', asOf: null } }),
  })
  await assert.rejects(collect(noFin, '7203'), (e: AnalysisError) => e.code === 'insufficient_data')
})

test('任意データの取得失敗は不足情報として残し、分析は続行', async () => {
  const flaky: MarketDataProvider = Object.assign(Object.create(provider) as MarketDataProvider, {
    getWeeklyMargin: async () => {
      throw new ProviderError('rate_limited', '429')
    },
  })
  const c = await collect(flaky, '7203')
  assert.ok(c.missing.some((m) => m.includes('週次信用残')))
  const s = buildSnapshot(c)
  assert.equal(val(s, 'sd.margin_ratio'), undefined)
})

test('プロバイダの認証失敗(401)は成功扱いにならない', async () => {
  const unauth: MarketDataProvider = Object.assign(Object.create(provider) as MarketDataProvider, {
    getPrices: async () => {
      throw new ProviderError('unauthorized', '401')
    },
  })
  await assert.rejects(collect(unauth, '7203'), (e: AnalysisError) => e.code === 'provider_unauthorized')
})

test('モック分析は出力契約の検証を通る', async () => {
  for (const code of ['7203', '9998', '8306', '285A']) {
    const s = await snap(code)
    const ids = new Set(s.evidence.map((e) => e.id))
    const out = checkOutput(mockAnalysis(s).json, ids)
    assert.equal(out.sections.length, 4)
  }
})

async function validOutput(): Promise<{ out: AnalysisOutput; ids: Set<string> }> {
  const s = await snap('7203')
  const m = mockAnalysis(s)
  return { out: structuredClone(m.output), ids: new Set(s.evidence.map((e) => e.id)) }
}

test('出力検証: 存在しない evidence ID を拒否', async () => {
  const { out, ids } = await validOutput()
  out.sections[0]!.findings.push({ text: 'x', evidenceIds: ['no.such.id'] })
  assert.throws(() => checkOutput(out, ids), (e: AnalysisError) => e.code === 'invalid_ai_output' && /no\.such\.id/.test(e.message))
})

test('出力検証: 観点の欠落・重複を拒否', async () => {
  const a = await validOutput()
  a.out.sections.pop()
  assert.throws(() => checkOutput(a.out, a.ids), /欠落/)
  const b = await validOutput()
  b.out.sections[1]!.type = 'fundamental'
  assert.throws(() => checkOutput(b.out, b.ids), /重複/)
})

test('出力検証: 価格レンジ(適正株価)の順序・正値・型を拒否', async () => {
  const mk = async (r: unknown) => {
    const x = await validOutput()
    ;(x.out.overall as unknown as Record<string, unknown>).fairValue = r
    return x
  }
  for (const bad of [
    { low: 200, high: 100, rationale: 'r', evidenceIds: [] },
    { low: -1, high: 100, rationale: 'r', evidenceIds: [] },
    { low: 0, high: 100, rationale: 'r', evidenceIds: [] },
    { low: '1', high: 100, rationale: 'r', evidenceIds: [] },
    { low: NaN, high: 100, rationale: 'r', evidenceIds: [] },
  ]) {
    const x = await mk(bad)
    assert.throws(() => checkOutput(x.out, x.ids), AnalysisError)
  }
  const ok = await mk({ low: 100, high: 100, rationale: 'r', evidenceIds: ['price.close'] })
  assert.doesNotThrow(() => checkOutput(ok.out, ok.ids))
})

const tier = (low: number, high: number, allocationPct: number) => ({ low, high, allocationPct, rationale: 'r', evidenceIds: ['price.close'] })
async function withEntries(entries: unknown) {
  const x = await validOutput()
  ;(x.out.overall as unknown as Record<string, unknown>).entries = entries
  return x
}

test('出力検証(分割エントリー): 複数段階・配分合計100・高い順で非重複なら通る。空配列も可', async () => {
  const ok = await withEntries([tier(2200, 2250, 20), tier(1950, 2000, 30), tier(1750, 1800, 30), tier(1550, 1600, 20)])
  const out = checkOutput(ok.out, ok.ids)
  assert.equal(out.overall.entries.length, 4)
  assert.equal(out.overall.entries.reduce((a, t) => a + t.allocationPct, 0), 100)
  const touching = await withEntries([tier(2000, 2100, 50), tier(1900, 2000, 50)]) // 接する
  assert.doesNotThrow(() => checkOutput(touching.out, touching.ids))
  const none = await withEntries([])
  assert.deepEqual(checkOutput(none.out, none.ids).overall.entries, [])
})

test('出力検証(分割エントリー): 配分合計≠100・順序違反・重複・段階数超過・不正値・存在しないevidenceを拒否', async () => {
  const cases: [string, unknown][] = [
    ['合計が100でない', [tier(2200, 2250, 20), tier(1950, 2000, 30)]],
    ['安い順', [tier(1950, 2000, 50), tier(2200, 2250, 50)]],
    ['重なっている', [tier(2000, 2200, 50), tier(1900, 2100, 50)]],
    ['5段階', [tier(2200, 2250, 20), tier(2100, 2150, 20), tier(2000, 2050, 20), tier(1900, 1950, 20), tier(1800, 1850, 20)]],
    ['配分が0', [tier(2200, 2250, 0), tier(1950, 2000, 100)]],
    ['配分が負', [tier(2200, 2250, -10), tier(1950, 2000, 110)]],
    ['low>high', [tier(2250, 2200, 100)]],
    ['価格が負', [tier(-5, 2200, 100)]],
    ['配列でない', { low: 1 }],
    ['nullを含む', [null]],
  ]
  for (const [name, entries] of cases) {
    const x = await withEntries(entries)
    assert.throws(() => checkOutput(x.out, x.ids), AnalysisError, name)
  }
  const bad = await withEntries([{ ...tier(2200, 2250, 100), evidenceIds: ['no.such.id'] }])
  assert.throws(() => checkOutput(bad.out, bad.ids), /no\.such\.id/)
})

test('出力検証: 形式不正(null・文字列・不明な列挙値)を拒否', async () => {
  const { out, ids } = await validOutput()
  for (const bad of [null, 'text', [], {}, { sections: [], overall: {} }]) assert.throws(() => checkOutput(bad, ids), AnalysisError)
  const o2 = structuredClone(out)
  ;(o2.overall as unknown as Record<string, unknown>).stance = 'buy_now'
  assert.throws(() => checkOutput(o2, ids), /stance/)
  const o3 = structuredClone(out)
  ;(o3.sections[0] as unknown as Record<string, unknown>).outlook = 'moon'
  assert.throws(() => checkOutput(o3, ids), /outlook/)
})

test('AI入力サイズ上限を超えると失敗', async () => {
  const s = await snap('7203')
  assert.doesNotThrow(() => buildUserInput(s, 'swing', 1_000_000))
  assert.throws(() => buildUserInput(s, 'swing', 100), (e: AnalysisError) => e.code === 'input_too_large')
})

test('費用推定: 単価未設定なら null、設定時は算出し根拠を保持', () => {
  const u = { inputTokens: 1000, outputTokens: 500, totalTokens: 1500, reasoningTokens: 0 }
  const none = estimateCost(u, { priceInputPerMtok: null, priceOutputPerMtok: null, priceTableVersion: null })
  assert.equal(none.costUsd, null)
  const some = estimateCost(u, { priceInputPerMtok: 2, priceOutputPerMtok: 8, priceTableVersion: 'v1' })
  assert.equal(some.costUsd, (1000 * 2 + 500 * 8) / 1e6)
  assert.equal(some.usage.priceTableVersion, 'v1')
})
