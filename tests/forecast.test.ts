import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseForecastFacts, isTanshinTitle, isRevisionNoticeTitle } from '../src/server/services/providers/irbank/forecast.ts'
import { shareBasisUnchanged } from '../src/server/services/calculators/forecast.ts'
import { IrbankClient } from '../src/server/services/providers/irbank/client.ts'
import { IrbankProvider } from '../src/server/services/providers/irbank/index.ts'
import { MockProvider } from '../src/server/services/providers/mock/index.ts'
import { collect } from '../src/server/services/analysis/collect.ts'
import { buildSnapshot } from '../src/server/services/analysis/snapshot.ts'
import type { Bar } from '../src/server/services/calculators/technical.ts'

const f = (element_name: string, context: string, value: unknown, unit: string | null) => ({ element_name, context, period: null, value, unit })

// 実際の決算短信(J-GAAP 第2四半期)のファクトの形(株探との比較で確認した値)
const JGAAP = [
  f('NetIncomePerShare', 'CurrentAccumulatedQ2Duration_ConsolidatedMember_ResultMember', 108.87, 'JPYPerShares'),
  f('NetIncomePerShare', 'CurrentYearDuration_ConsolidatedMember_ForecastMember', 196.86, 'JPYPerShares'),
  f('NetSales', 'CurrentYearDuration_ConsolidatedMember_ForecastMember', 1768000000000, 'JPY'),
  f('OperatingIncome', 'CurrentYearDuration_ConsolidatedMember_ForecastMember', 429000000000, 'JPY'),
  f('ProfitAttributableToOwnersOfParent', 'CurrentYearDuration_ConsolidatedMember_ForecastMember', 326000000000, 'JPY'),
  f('DividendPerShare', 'CurrentYearDuration_AnnualMember_NonConsolidatedMember_ForecastMember', 80, 'JPYPerShares'),
  f('DividendPerShare', 'CurrentYearDuration_YearEndMember_NonConsolidatedMember_ForecastMember', 40, 'JPYPerShares'),
  f('DividendPerShare', 'PriorYearDuration_AnnualMember_NonConsolidatedMember_ResultMember', 225, 'JPYPerShares'),
]

test('決算短信XBRL(J-GAAP): 通期の予想EPS・年間DPSを実績/年度末配当と取り違えず取り出す', () => {
  const v = parseForecastFacts(JGAAP)
  assert.equal(v.eps, 196.86)
  assert.equal(v.epsElement, 'NetIncomePerShare')
  assert.equal(v.dps, 80) // 年度末(40)・前期実績(225)ではない
  assert.equal(v.sales, 1768000000000)
  assert.equal(v.operatingProfit, 429000000000)
  assert.equal(v.netIncome, 326000000000)
  assert.equal(v.fiscalYearScope, 'CurrentYear')
  assert.equal(v.scope, 'consolidated')
})

test('金額が文字列で返る実レスポンスの形でも取り出せる(数値形式以外の文字列は無視)', () => {
  const v = parseForecastFacts([
    f('NetSales', 'CurrentYearDuration_ConsolidatedMember_ForecastMember', '1768000000000', 'JPY'),
    f('OperatingIncome', 'CurrentYearDuration_ConsolidatedMember_ForecastMember', '429000000000', 'JPY'),
    f('ProfitAttributableToOwnersOfParent', 'CurrentYearDuration_ConsolidatedMember_ForecastMember', 'N/A', 'JPY'),
    f('NetIncomePerShare', 'CurrentYearDuration_ConsolidatedMember_ForecastMember', 196.86, 'JPYPerShares'),
  ])
  assert.deepEqual([v.sales, v.operatingProfit, v.netIncome], [1768000000000, 429000000000, null])
})

test('決算短信XBRL(IFRS・本決算の翌期予想)', () => {
  const v = parseForecastFacts([
    f('BasicEarningsPerShareIFRS', 'NextYearDuration_ConsolidatedMember_ForecastMember', 251.25, 'JPYPerShares'),
    f('ProfitAttributableToOwnersOfParentIFRS', 'NextYearDuration_ConsolidatedMember_ForecastMember', 3000000000000, 'JPY'),
    f('OperatingRevenuesIFRS', 'NextYearDuration_ConsolidatedMember_ForecastMember', 51000000000000, 'JPY'),
    f('DividendPerShare', 'NextYearDuration_AnnualMember_NonConsolidatedMember_ForecastMember', 100, 'JPYPerShares'),
    f('DividendPerShare', 'NextYearDuration_SecondQuarterMember_NonConsolidatedMember_ForecastMember', 50, 'JPYPerShares'),
  ])
  assert.deepEqual([v.eps, v.dps, v.fiscalYearScope, v.epsElement], [251.25, 100, 'NextYear', 'BasicEarningsPerShareIFRS'])
  assert.equal(v.netIncome, 3000000000000)
})

test('予想が無い・未対応の要素・単位違い・非数値は null(推測しない)', () => {
  const none = parseForecastFacts([f('NetIncomePerShare', 'CurrentAccumulatedQ2Duration_ConsolidatedMember_ResultMember', 10, 'JPYPerShares')])
  assert.deepEqual([none.eps, none.dps, none.fiscalYearScope], [null, null, null])
  assert.equal(parseForecastFacts([f('EarningsPerShareUSGAAP', 'CurrentYearDuration_ConsolidatedMember_ForecastMember', 5, 'JPYPerShares')]).eps, null)
  assert.equal(parseForecastFacts([f('NetIncomePerShare', 'CurrentYearDuration_ConsolidatedMember_ForecastMember', 5, 'USD')]).eps, null)
  assert.equal(parseForecastFacts([f('NetIncomePerShare', 'CurrentYearDuration_ConsolidatedMember_ForecastMember', 'N/A', 'JPYPerShares')]).eps, null)
  assert.equal(parseForecastFacts(null).eps, null)
  assert.equal(parseForecastFacts([f('DividendPerShare', 'CurrentYearDuration_YearEndMember_NonConsolidatedMember_ForecastMember', 40, 'JPYPerShares')]).dps, null, '年度末配当のみでは年間DPSにしない')
})

test('連結が無ければ個別予想を使う', () => {
  const v = parseForecastFacts([f('NetIncomePerShare', 'CurrentYearDuration_NonConsolidatedMember_ForecastMember', 33, 'JPYPerShares')])
  assert.deepEqual([v.eps, v.scope], [33, 'non_consolidated'])
})

test('開示タイトルの判定', () => {
  assert.ok(isTanshinTitle('2027年３月期 第２四半期（中間期）決算短信〔日本基準〕（連結）'))
  assert.ok(isTanshinTitle('2026年3月期 決算短信〔IFRS〕（連結)'))
  assert.ok(!isTanshinTitle('[Summary] Consolidated Financial Results for the Six Months Ended September 30, 2026'))
  assert.ok(!isTanshinTitle('2026年3月期 決算短信の一部訂正について'))
  assert.ok(isRevisionNoticeTitle('2027年３月期通期連結業績予想の修正及び剰余金の配当（中間配当）並びに期末配当予想の修正に関するお知らせ'))
  assert.ok(!isRevisionNoticeTitle('2027年3月期 第１四半期決算短信〔日本基準〕（連結）'))
  assert.ok(!isRevisionNoticeTitle('連結子会社の異動（株式譲渡）に関するお知らせ'))
})

function bars(spec: [string, number, number][]): Bar[] {
  return spec.map(([date, close, adj]) => ({ date, open: close, high: close, low: close, close, adjClose: adj, volume: 1 }))
}

test('分割ガード: 開示後に分割があれば1株予想を使わない / 無ければ使える / 検証不能は使わない', () => {
  const ok = bars([['2026-11-05', 100, 100], ['2026-11-10', 100, 100], ['2026-11-20', 100, 100]])
  assert.equal(shareBasisUnchanged(ok, '2026-11-10').ok, true)
  // 開示後に 1:2 分割(終値は半値、adj/close が変わる)
  const split = bars([['2026-11-05', 100, 50], ['2026-11-10', 100, 50], ['2026-11-20', 50, 50]])
  const r = shareBasisUnchanged(split, '2026-11-10')
  assert.equal(r.ok, false)
  assert.match(r.reason!, /分割・併合/)
  // 分割が開示より前なら基準は揃っている
  const before = bars([['2026-11-01', 100, 50], ['2026-11-10', 50, 50], ['2026-11-20', 50, 50]])
  assert.equal(shareBasisUnchanged(before, '2026-11-10').ok, true)
  // 開示日が日足範囲より前
  assert.equal(shareBasisUnchanged(ok, '2025-01-01').ok, false)
  assert.equal(shareBasisUnchanged([], '2026-11-10').ok, false)
})

// ---- プロバイダ(開示一覧 + 文書) ----
function providerWith(routes: Record<string, unknown>) {
  const f2 = (async (url: string) => {
    const hit = routes[new URL(url).pathname.replace('/v1', '')]
    return hit === undefined ? new Response('{}', { status: 404 }) : new Response(JSON.stringify(hit), { status: 200 })
  }) as unknown as typeof fetch
  return new IrbankProvider('k', new IrbankClient('k', f2, async () => {}))
}
const attribution = { source_label: 'JPX TDnet' }

test('getForecast: 最新の決算短信を選び、それ以降の予想修正開示を警告用に返す', async () => {
  const p = providerWith({
    '/securities/5803/disclosures': {
      disclosures: [
        { doc_id: 'REV2', source: 'tdnet', title: '2027年３月期通期連結業績予想の修正に関するお知らせ', disclosed_at: '2026-12-01T05:00:00.000Z' },
        { doc_id: 'REV1', source: 'tdnet', title: '2027年３月期通期連結業績予想の修正に関するお知らせ', disclosed_at: '2026-11-10T05:00:00.000Z' }, // 短信と同時刻=反映済み
        { doc_id: 'T2', source: 'tdnet', title: '2027年３月期 第２四半期（中間期）決算短信〔日本基準〕（連結）', disclosed_at: '2026-11-10T05:00:00.000Z' },
        { doc_id: 'EN', source: 'tdnet', title: '[Summary] Consolidated Financial Results', disclosed_at: '2026-11-10T05:00:00.000Z' },
        { doc_id: 'T1', source: 'tdnet', title: '2027年３月期 第１四半期決算短信〔日本基準〕（連結）', disclosed_at: '2026-08-07T05:00:00.000Z' },
      ],
      attribution,
    },
    '/disclosures/T2': { xbrl_facts: JGAAP, attribution },
  })
  const r = (await p.getForecast('5803')).data
  assert.equal(r.docId, 'T2')
  assert.equal(r.values!.eps, 196.86)
  assert.equal(r.laterRevisions.length, 1, '短信と同時刻の修正開示は警告しない')
  assert.match(r.laterRevisions[0]!.disclosedAt, /^2026-12-01/)
  assert.match(r.laterRevisions[0]!.title, /修正/)
})

test('getForecast: 短信が無い/予想ファクトが無い場合は values=null と理由', async () => {
  const none = providerWith({ '/securities/5803/disclosures': { disclosures: [{ doc_id: 'X', source: 'edinet', title: '有価証券報告書', disclosed_at: '2026-06-01T00:00:00.000Z' }], attribution } })
  const a = (await none.getForecast('5803')).data
  assert.equal(a.values, null)
  assert.match(a.reason!, /決算短信が見つかりません/)
  const noFacts = providerWith({
    '/securities/5803/disclosures': { disclosures: [{ doc_id: 'T', source: 'tdnet', title: '2026年3月期 決算短信〔日本基準〕（連結）', disclosed_at: '2026-05-08T05:00:00.000Z' }], attribution },
    '/disclosures/T': { xbrl_facts: [], attribution },
  })
  const b = (await noFacts.getForecast('5803')).data
  assert.equal(b.values, null)
  assert.match(b.reason!, /XBRLファクトが見つかりません/)
})

// ---- スナップショット ----
const get = (s: ReturnType<typeof buildSnapshot>, id: string) => s.evidence.find((e) => e.id === id)

test('予想PER・予想配当利回り: 終値と会社予想から算出し、実績ベースとは別ID。基準は予想・取得元は開示', async () => {
  const c = await collect(new MockProvider(), '7203')
  const s = buildSnapshot(c)
  const close = get(s, 'price.close')!.value as number
  const eps = get(s, 'fc.eps')!
  const dps = get(s, 'fc.dps')!
  assert.deepEqual([eps.origin, eps.basis], ['disclosure', 'forecast'])
  assert.equal(get(s, 'val.per_forecast')!.value, close / (eps.value as number))
  assert.equal(get(s, 'val.dividend_yield_forecast')!.value, ((dps.value as number) / close) * 100)
  assert.notEqual(get(s, 'val.per_forecast')!.value, get(s, 'val.per')!.value)
  assert.equal(get(s, 'val.per')!.basis, 'actual')
  assert.equal(s.yieldPricesForecast!.length, 5)
  assert.equal(s.yieldPricesForecast![0]!.price, (dps.value as number) / 0.03)
  assert.match(eps.definition, /決算短信/)
})

test('会社予想: 分割・取得失敗・予想なしは null で、実績値で代用しない', async () => {
  // 開示後に分割
  const c1 = await collect(new MockProvider(), '7203')
  const n = c1.bars.length
  for (let i = n - 5; i < n; i++) c1.bars[i]!.adjClose = c1.bars[i]!.close! / 2 // 直近5日だけ調整係数が変わった=開示(10日前)後に分割
  const s1 = buildSnapshot(c1)
  assert.equal(get(s1, 'val.per_forecast'), undefined)
  assert.equal(get(s1, 'fc.eps'), undefined)
  assert.ok(s1.missingData.some((m) => m.includes('株式分割・併合')))
  assert.ok(get(s1, 'val.per')!.value != null, '実績PERは影響を受けない')
  // 取得失敗
  const c2 = await collect(new MockProvider(), '7203')
  c2.forecast = null
  const s2 = buildSnapshot(c2)
  assert.equal(get(s2, 'val.per_forecast'), undefined)
  assert.ok(s2.missingData.some((m) => m.includes('予想PER') && m.includes('実績値で代用していない')))
  // 赤字(会社予想なし)
  const s3 = buildSnapshot(await collect(new MockProvider(), '9998'))
  assert.equal(get(s3, 'val.per_forecast'), undefined)
  assert.ok(s3.missingData.some((m) => m.includes('会社予想')))
})

test('短信後の予想修正開示は警告として不足情報に残す', async () => {
  const c = await collect(new MockProvider(), '7203')
  c.forecast!.laterRevisions = [{ title: '通期業績予想の修正に関するお知らせ', disclosedAt: '2026-11-21T05:00:00.000Z' }]
  const s = buildSnapshot(c)
  assert.ok(s.missingData.some((m) => m.includes('反映していない') && m.includes('業績予想の修正')))
})
