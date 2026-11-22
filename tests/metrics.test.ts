import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockProvider } from '../src/server/services/providers/mock/index.ts'
import { IrbankClient } from '../src/server/services/providers/irbank/client.ts'
import { IrbankProvider } from '../src/server/services/providers/irbank/index.ts'
import { ProviderError } from '../src/server/services/providers/types.ts'
import { collect, type Collected } from '../src/server/services/analysis/collect.ts'
import { buildSnapshot } from '../src/server/services/analysis/snapshot.ts'
import { buildUserInput } from '../src/server/services/analysis/prompt.ts'

const mock = new MockProvider()
const base = () => collect(mock, '7203')
const get = (s: ReturnType<typeof buildSnapshot>, id: string) => s.evidence.find((e) => e.id === id)

test('API値を再計算しない: ROE・ROA・利益率・成長率・自己資本比率・配当性向・DOE・FCF は origin=api で、値はAPIの値そのもの', async () => {
  const c = await base()
  const s = buildSnapshot(c)
  const fy = c.indicators!.at(-1)!
  const k = `fin.${fy.fiscalYear.replace('/', '-')}`
  const expect: [string, number | null][] = [
    ['roe', fy.roePct], ['roa', fy.roaPct], ['op_margin', fy.operatingMarginPct], ['net_margin', fy.netMarginPct],
    ['equity_ratio', fy.equityRatioPct], ['payout', fy.payoutRatioPct], ['sales_growth', fy.salesGrowthPct],
  ]
  for (const [id, v] of expect) {
    const e = get(s, `${k}.${id}`)!
    assert.equal(e.origin, 'api', id)
    assert.equal(e.value, v, id)
    assert.ok(e.endpoint?.startsWith('GET /indicators'), id)
  }
  assert.equal(get(s, `${k}.fcf`)!.origin, 'api')
  assert.equal(get(s, `${k}.fcf`)!.value, c.financials.annual.at(-1)!.fcfApi)
  assert.equal(get(s, `${k}.doe`)!.origin, 'api')
  assert.equal(get(s, `${k}.fcf_simple`), undefined, 'APIのfcfがある時は簡易FCFを出さない')
  assert.equal(get(s, `${k}.payout_simple`), undefined)
  assert.equal(get(s, `${k}.doe_simple`), undefined)
})

test('API値が取得不可の場合のみ代替計算し、別IDと別定義で区別する(同一指標として扱わない)', async () => {
  const c = await base()
  for (const p of c.financials.annual) p.fcfApi = null
  c.indicators = c.indicators!.map((r) => ({ ...r, payoutRatioPct: null }))
  c.dividends = c.dividends!.map((d) => ({ ...d, doePct: null }))
  const s = buildSnapshot(c)
  const k = `fin.${c.financials.annual.at(-1)!.fiscalYear.replace('/', '-')}`
  assert.equal(get(s, `${k}.fcf`), undefined)
  const f = get(s, `${k}.fcf_simple`)!
  assert.equal(f.origin, 'calculated')
  assert.match(f.definition, /営業CF \+ 投資CF/)
  assert.equal(get(s, `${k}.payout_simple`)!.origin, 'calculated')
  assert.equal(get(s, `${k}.doe_simple`)!.origin, 'calculated')
})

test('/indicators が取得できない場合、ROE等を独自計算で補完せず null と不足情報にする', async () => {
  const c = await base()
  c.indicators = null
  const s = buildSnapshot(c)
  const k = `fin.${c.financials.annual.at(-1)!.fiscalYear.replace('/', '-')}`
  for (const id of ['roe', 'roa', 'op_margin', 'net_margin', 'equity_ratio', 'sales_growth'])
    assert.equal(get(s, `${k}.${id}`)!.value, null, id)
  assert.ok(s.missingData.some((m) => m.includes('/indicators')))
})

test('最新株価ベース(val.*)は算出・実績・株価基準日つき。過去推移(hist.*)はAPI・決算期末基準で別ID', async () => {
  const c = await base()
  const s = buildSnapshot(c)
  const per = get(s, 'val.per')!
  assert.equal(per.origin, 'calculated')
  assert.equal(per.basis, 'actual')
  assert.equal(per.priceAsOf, s.priceAsOf)
  const close = get(s, 'price.close')!.value as number
  const eps = get(s, 'val.eps')!.value as number
  assert.equal(per.value, close / eps)
  const h = s.evidence.filter((e) => e.id.startsWith('hist.'))
  assert.equal(h.length, 15) // 5期 × (PER, PBR, 配当利回り)
  assert.ok(h.every((e) => e.origin === 'api' && e.asOf && /^\d{4}\/\d{2}$/.test(e.asOf) && e.priceAsOf === null))
  // 予想(basis=forecast)は決算短信由来・予想ベース算出のみ。実績の値を予想として出さない
  for (const e of s.evidence.filter((x) => x.basis === 'forecast')) assert.ok(e.origin === 'disclosure' || e.id.startsWith('val.') || e.id.startsWith('ref.'), e.id)
})

test('全evidenceに取得元・基準日の種類・定義・出典がある。IDは一意', async () => {
  for (const code of ['7203', '9998', '8306', '285A']) {
    const s = buildSnapshot(await collect(mock, code))
    assert.equal(new Set(s.evidence.map((e) => e.id)).size, s.evidence.length, code)
    for (const e of s.evidence) {
      assert.ok(['api', 'calculated', 'disclosure'].includes(e.origin), `${code} ${e.id}`)
      assert.ok(e.definition.length > 0, `${code} ${e.id} definition`)
      assert.ok(e.sourceLabel.length > 0, `${code} ${e.id} sourceLabel`)
    }
    // 上限判定は実際にAIへ送る圧縮後の入力で行う(全文はDB・画面にだけ残す)
    assert.ok(buildUserInput(s, 'mid_long', 1e6).length < 45000, `${code}: AI入力サイズ`)
  }
})

test('金融機関: ネットキャッシュ・キャッシュ調整後PER・FCF(API/簡易)・参考net_debtを出さない', async () => {
  const s = buildSnapshot(await collect(mock, '8306'))
  for (const e of s.evidence) {
    assert.ok(!/net_cash|cash_adjusted|\.fcf|api_net_debt/.test(e.id), e.id)
  }
})

test('API純有利子負債は参考値として別IDで、独自計算ネットキャッシュと混ぜない', async () => {
  const s = buildSnapshot(await base())
  assert.equal(get(s, 'ref.api_net_debt')!.origin, 'api')
  assert.equal(get(s, 'val.net_cash')!.origin, 'calculated')
  assert.match(get(s, 'val.net_cash')!.definition, /net_debt とは定義が異なりうる/)
})

test('信用倍率: APIのmargin_ratioを優先し、無ければ算出(売り残0は null と理由)', async () => {
  const c = await base()
  const last = c.weekly!.at(-1)!
  last.marginRatio = 3.21
  let m = get(buildSnapshot(c), 'sd.margin_ratio')!
  assert.deepEqual([m.origin, m.value], ['api', 3.21])
  last.marginRatio = null
  last.buyBalance = 100
  last.sellBalance = 50
  m = get(buildSnapshot(c), 'sd.margin_ratio')!
  assert.deepEqual([m.origin, m.value], ['calculated', 2])
  last.sellBalance = 0
  m = get(buildSnapshot(c), 'sd.margin_ratio')!
  assert.equal(m.value, null)
  assert.match(m.definition, /売り残が0/)
})

test('AI入力JSONに origin・定義・基準日が含まれる', async () => {
  const s = buildSnapshot(await base())
  const j = JSON.parse(buildUserInput(s, 'mid_long', 1e6))
  const e = j.evidence.find((x: { id: string }) => x.id === 'val.per')
  for (const k of ['origin', 'asOf', 'definition', 'basis']) assert.ok(k in e, k)
  assert.ok(!('priceAsOf' in e), '株価基準日がasOfと同じなら重複させない')
  assert.ok(!('sourceLabel' in e) && !('endpoint' in e), 'AI入力には出典・参照先を含めない(sourcesに集約)')
})

// ---- IRBANK 応答の単位変換 ----
function providerWith(routes: Record<string, unknown>) {
  const f = (async (url: string) => {
    const hit = routes[new URL(url).pathname.replace('/v1', '')]
    return hit === undefined ? new Response('{}', { status: 404 }) : new Response(JSON.stringify(hit), { status: 200 })
  }) as unknown as typeof fetch
  return new IrbankProvider('k', new IrbankClient('k', f, async () => {}))
}
const ind = (extra: Record<string, unknown>, fields: object[]) => ({
  fields,
  periods: [{ fiscal_year: '2025/03', ...extra }],
})

test('/indicators: percent はそのまま・ratio は×100・単位不明は null(桁を誤らない)', async () => {
  const p = providerWith({
    '/indicators': ind(
      { roe_computed: 12.3, roa: 0.045, payout_ratio: 0.35, operating_margin: 8.1, equity_ratio_computed: 77.6, net_debt: -1000, sales_growth: 5 },
      [
        { key: 'roe_computed', unit: 'percent', label: 'ROE(計算値)', note: '当期純利益/平均自己資本' },
        { key: 'roa', unit: 'ratio' },
        { key: 'payout_ratio', unit: 'ratio' },
        { key: 'operating_margin', unit: 'percent' },
        { key: 'equity_ratio_computed', unit: 'percent' },
        { key: 'net_debt', unit: 'jpy' },
        // sales_growth は単位情報なし → null
      ],
    ),
  })
  const r = await p.getIndicators('7203')
  const x = r.data[0]!
  assert.equal(x.roePct, 12.3)
  assert.equal(x.roeKey, 'roe_computed')
  assert.ok(Math.abs(x.roaPct! - 4.5) < 1e-9)
  assert.ok(Math.abs(x.payoutRatioPct! - 35) < 1e-9)
  assert.equal(x.operatingMarginPct, 8.1)
  assert.equal(x.equityRatioPct, 77.6)
  assert.equal(x.salesGrowthPct, null)
  assert.equal(x.netDebt, -1000)
  assert.match(r.defs!.roe_computed!, /平均自己資本/)
})

test('/indicators: roe_computed が無ければ報告値 roe を採用し採用キーを記録 / net_debt の単位違いは失敗', async () => {
  const p = providerWith({ '/indicators': ind({ roe: 9 }, [{ key: 'roe', unit: 'percent' }]) })
  const x = (await p.getIndicators('7203')).data[0]!
  assert.deepEqual([x.roePct, x.roeKey], [9, 'roe'])
  const bad = providerWith({ '/indicators': ind({ net_debt: 1 }, [{ key: 'net_debt', unit: 'million_jpy' }]) })
  await assert.rejects(bad.getIndicators('7203'), (e: ProviderError) => e.code === 'invalid_response')
})

test('/valuations: 配当利回りは unit に従い % へ正規化、/dividends の doe も同様', async () => {
  const p = providerWith({
    '/valuations': {
      fields: [{ key: 'dividend_yield_adjusted', unit: 'ratio' }, { key: 'market_cap', unit: 'jpy' }, { key: 'per', unit: 'times' }],
      history: [{ fiscal_year: '2025/03', per: 12, pbr_adjusted: 1.1, dividend_yield_adjusted: 0.031, market_cap: 5e11 }],
      per_5y_avg: 11,
    },
    '/dividends': {
      fields: [{ key: 'doe', unit: 'percent' }],
      records: [{ fiscal_year: 2025, annual_dps_adjusted: 50, doe: 3.2 }],
    },
  })
  const v = (await p.getValuations('7203')).data
  assert.ok(Math.abs(v.history[0]!.dividendYieldPct! - 3.1) < 1e-9)
  assert.equal(v.history[0]!.pbr, 1.1)
  const d = (await p.getDividends('E1')).data
  assert.equal(d[0]!.doePct, 3.2)
})

test('AI入力の圧縮: 長いAPI定義文は切り詰め、全文は evidence に残る。実データ規模でも上限に収まる', async () => {
  const s = buildSnapshot(await base())
  const long = 'N'.repeat(600)
  for (const e of s.evidence.filter((x) => x.id.startsWith('hist.'))) e.definition = long // 実PoCで見たAPI注記の長さを再現
  const full = JSON.stringify(s.evidence).length
  const input = buildUserInput(s, 'mid_long', 60000)
  assert.ok(input.length < full * 0.6, `圧縮後 ${input.length} / 圧縮前 ${full}`)
  const j = JSON.parse(input)
  assert.ok(j.evidence.every((e: { definition: string }) => e.definition.length <= 141))
  assert.equal(s.evidence.find((x) => x.id.startsWith('hist.'))!.definition.length, 600)
})

test('価格レンジの参考値: 過去5期末PER/PBRの最小・平均・最大 × 1株指標を、基準(実績/予想)別IDでサーバー計算', async () => {
  const c = await base()
  const s = buildSnapshot(c)
  const h = c.valuations!.history.slice(-5)
  const pers = h.map((x) => x.per!).filter((x) => x > 0)
  const eps = get(s, 'val.eps')!.value as number
  const epsFc = get(s, 'fc.eps')!.value as number
  assert.equal(get(s, 'ref.value_per_act.min')!.value, eps * Math.min(...pers))
  assert.equal(get(s, 'ref.value_per_act.max')!.value, eps * Math.max(...pers))
  assert.equal(get(s, 'ref.value_per_fc.avg')!.value, epsFc * (pers.reduce((a, b) => a + b, 0) / pers.length))
  assert.equal(get(s, 'ref.value_per_fc.avg')!.basis, 'forecast')
  assert.equal(get(s, 'ref.value_per_act.avg')!.basis, 'actual')
  const bps = get(s, 'val.bps')!.value as number
  assert.equal(get(s, 'ref.value_pbr.min')!.value, bps * Math.min(...h.map((x) => x.pbr!)))
  assert.match(get(s, 'ref.value_per_act.min')!.definition, /目標株価ではない/)
})

test('参考値: 赤字(EPS<=0)・会社予想なし・分割後は該当する基準の参考株価を null/出さない(代用しない)', async () => {
  const loss = buildSnapshot(await collect(mock, '9998'))
  assert.equal(get(loss, 'ref.value_per_act.avg')!.value, null)
  assert.equal(get(loss, 'ref.value_per_fc.avg'), undefined)
  const c = await base()
  c.forecast = null
  assert.equal(get(buildSnapshot(c), 'ref.value_per_fc.avg'), undefined)
})

test('プロンプト: 価格レンジの作り方と stance の基準を指示し、全null・wait固定にならないようにしている', async () => {
  const { SYSTEM_PROMPT } = await import('../src/server/services/analysis/prompt.ts')
  for (const k of ['ref.value_per_fc', 'ref.value_per_act', 'ref.value_pbr', 'tech.low60', 'consider(検討可)', 'wait を既定にしない', '1つでもあれば null にせず'])
    assert.ok(SYSTEM_PROMPT.includes(k), k)
})

test('エントリー価格の材料: 目標PER倍率ごとの株価をサーバー計算(予想EPSが使えれば予想基準、無ければ実績基準)', async () => {
  const s = buildSnapshot(await base())
  const per = get(s, 'val.per_forecast')!.value as number
  const eps = get(s, 'fc.eps')!.value as number
  const ladder = s.evidence.filter((e) => e.id.startsWith('ref.price_at_per_fc.'))
  assert.ok(ladder.length >= 2 && ladder.length <= 8)
  assert.ok(ladder.every((e) => e.basis === 'forecast' && e.origin === 'calculated'))
  for (const e of ladder) {
    const n = Number(e.id.split('.').at(-1))
    assert.equal(e.value, eps * n)
    assert.ok(n <= Math.ceil(per) && n >= 3)
  }
  assert.equal(s.evidence.filter((e) => e.id.startsWith('ref.price_at_per_act.')).length, 0, '予想基準があるときは実績基準の梯子を重ねない')
  // 会社予想が使えない場合は実績基準
  const c = await base()
  c.forecast = null
  const s2 = buildSnapshot(c)
  assert.equal(s2.evidence.filter((e) => e.id.startsWith('ref.price_at_per_fc.')).length, 0)
  assert.ok(s2.evidence.filter((e) => e.id.startsWith('ref.price_at_per_act.')).length >= 2)
  // 赤字(EPS<=0)は梯子を作らない
  const s3 = buildSnapshot(await collect(mock, '9998'))
  assert.equal(s3.evidence.filter((e) => e.id.startsWith('ref.price_at_per_')).length, 0)
})

test('プロンプト: 分割エントリー(段階・配分・利回り/PER根拠)を指示している', async () => {
  const { SYSTEM_PROMPT } = await import('../src/server/services/analysis/prompt.ts')
  for (const k of ['entries', 'allocationPct', '合計をちょうど100', 'ref.price_at_per_fc', 'val.yield_price_fc', '浅い(高い)順'])
    assert.ok(SYSTEM_PROMPT.includes(k), k)
})

test('データのみ表示(軽量取得): 不要な取得を省き、主要データと利回り別株価に必要な項目はそろう', async () => {
  const calls: string[] = []
  const spy = new Proxy(mock, {
    get(t, k, r) {
      const v = Reflect.get(t, k, r)
      return typeof v === 'function' && typeof k === 'string' && k.startsWith('get') ? (...a: unknown[]) => (calls.push(k), (v as (...x: unknown[]) => unknown).apply(t, a)) : v
    },
  })
  const c = await collect(spy, '7203', { light: true })
  for (const skipped of ['getSegments', 'getNarratives', 'getShareholders', 'getJsfMargin']) assert.ok(!calls.includes(skipped), `${skipped} は呼ばない`)
  for (const used of ['getSecurity', 'getPrices', 'getFinancials', 'getIndicators', 'getValuations', 'getDividends', 'getWeeklyMargin', 'getForecast']) assert.ok(calls.includes(used), `${used} は呼ぶ`)
  assert.deepEqual([c.segmentsAnnual, c.segmentsQuarter, c.narratives, c.jsf, c.shareholders], [null, null, null, null, null])
  assert.ok(!c.missing.some((m) => /セグメント|開示書類|日証金|大量保有/.test(m)), '省略した項目を「取得失敗」として扱わない')
  const s = buildSnapshot(c)
  // 主要データ(KeyMetrics)・利回り別株価に必要なevidenceがそろっている
  const k = `fin.${c.financials.annual.at(-1)!.fiscalYear.replace('/', '-')}`
  for (const id of ['price.close', 'mcap', 'val.per', 'val.per_forecast', 'val.pbr', 'val.dividend_yield', 'val.dividend_yield_forecast', 'val.eps', 'val.bps', 'val.dps', 'fc.eps', 'fc.dps', 'val.per_5y_avg', `${k}.sales`, `${k}.roe`, `${k}.equity_ratio`, 'sd.margin_ratio', 'tech.rsi14', 'tech.sma200'])
    assert.ok(get(s, id), id)
  assert.equal(s.yieldPrices.length, 5)
  assert.equal(s.yieldPricesForecast!.length, 5)
  assert.equal(s.evidence.filter((e) => e.id.startsWith('nar.') || e.id.startsWith('seg.')).length, 0)
  // 通常の取得(light なし)は全項目を呼ぶ
  calls.length = 0
  await collect(spy, '7203')
  for (const used of ['getSegments', 'getNarratives', 'getShareholders', 'getJsfMargin']) assert.ok(calls.includes(used), `${used}(通常)`)
})
