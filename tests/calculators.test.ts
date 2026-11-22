import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeTechnical, emaSeries, macd, rsiWilder, sma, weeklyCloses, type Bar } from '../src/server/services/calculators/technical.ts'
import {
  cashAdjustedPer,
  dividendYieldPct,
  netCash,
  netCashRatioPct,
  payoutRatioPct,
  pbr,
  per,
  yieldPrices,
} from '../src/server/services/calculators/valuation.ts'
import { computeFinancialRows, isFinancialSector, type FinancialPeriod } from '../src/server/services/calculators/financial.ts'
import { buyBalanceDays, marginRatio } from '../src/server/services/calculators/supply-demand.ts'

const close = (a: number | null, b: number, eps = 0.05) => {
  assert.ok(a != null && Math.abs(a - b) <= eps, `${a} は ${b} の近傍でない`)
}

// StockChartsのWilder RSI参考データ(最終値 37.77)
const RSI_SAMPLE = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64,
  46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57, 43.42, 42.66, 43.13,
]

test('SMA: 件数不足は null', () => {
  assert.equal(sma([1, 2, 3], 5), null)
  assert.equal(sma([1, 2, 3, 4, 5], 5), 3)
  assert.equal(sma([1, 2, 3, 4, 5, 6], 5), 4)
})

test('RSI(Wilder): 参考値と一致 / 履歴不足は null / 一方向は100', () => {
  close(rsiWilder(RSI_SAMPLE.slice(0, 15)), 70.53, 0.1)
  close(rsiWilder(RSI_SAMPLE), 37.77, 0.1)
  assert.equal(rsiWilder(RSI_SAMPLE.slice(0, 14)), null)
  assert.equal(rsiWilder(Array.from({ length: 30 }, (_, i) => i + 1)), 100)
  assert.equal(rsiWilder(Array.from({ length: 30 }, () => 5)), 50)
})

test('MACD: 履歴不足は null / 定数列は0 / 上昇列は正', () => {
  assert.equal(macd(Array.from({ length: 33 }, (_, i) => i)).macd, null) // EMA26 + シグナル9 に足りない
  const flat = macd(Array.from({ length: 60 }, () => 100))
  close(flat.macd, 0, 1e-9)
  close(flat.hist, 0, 1e-9)
  const up = macd(Array.from({ length: 80 }, (_, i) => 100 + i))
  assert.ok(up.macd! > 0)
  assert.equal(emaSeries([1, 2], 3).length, 0)
})

function bars(n: number, f: (i: number) => number, volume = 1000): Bar[] {
  // 平日のみ(休場日は埋めない)
  const out: Bar[] = []
  let d = new Date(Date.UTC(2025, 0, 6)) // 月曜
  while (out.length < n) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) {
      const p = f(out.length)
      out.push({ date: d.toISOString().slice(0, 10), open: p, high: p + 1, low: p - 1, close: p, adjClose: p, volume })
    }
    d = new Date(d.getTime() + 86400000)
  }
  return out
}

test('テクニカル: 十分な履歴では全指標が出る', () => {
  const t = computeTechnical(bars(260, (i) => 100 + i * 0.2 + Math.sin(i / 5) * 3))
  for (const k of ['sma5', 'sma25', 'sma75', 'sma200', 'rsi14', 'macd', 'macdSignal', 'volumeAvg20', 'high60', 'low60', 'weeklySma13', 'weeklySma26'] as const) {
    assert.notEqual(t[k], null, k)
  }
  assert.equal(t.volumeRatio, 1)
})

test('テクニカル: 履歴不足の指標は null で、休場日を補完しない', () => {
  const t = computeTechnical(bars(40, (i) => 100 + i))
  assert.equal(t.sma200, null)
  assert.equal(t.sma75, null)
  assert.notEqual(t.sma25, null)
  assert.equal(t.high60, null)
  assert.equal(t.barCount, 40)
})

test('テクニカル: 調整後終値で計算する(分割で未調整終値が不連続でも影響しない)', () => {
  const b = bars(30, () => 100)
  for (let i = 15; i < 30; i++) b[i]!.close = 50 // 未調整は分割後に半値
  const t = computeTechnical(b)
  assert.equal(t.sma25, 100)
})

test('週足終値は週ごとの最終取引日', () => {
  const b = bars(10, (i) => i + 1) // 2週間
  assert.deepEqual(weeklyCloses(b), [5, 10])
})

test('PER/PBR: 非正の分母は null', () => {
  assert.equal(per(1000, 0), null)
  assert.equal(per(1000, -5), null)
  assert.equal(per(1000, 50), 20)
  assert.equal(pbr(1000, 0), null)
  assert.equal(pbr(1000, 500), 2)
  assert.equal(per(null, 50), null)
})

test('配当利回り・利回り別株価', () => {
  assert.equal(dividendYieldPct(40, 1000), 4)
  assert.equal(dividendYieldPct(40, 0), null)
  const y = yieldPrices(60)
  assert.deepEqual(y.map((x) => x.targetYieldPct), [3, 3.5, 4, 4.5, 5])
  assert.equal(y[0]!.price, 2000)
  assert.equal(y[2]!.price, 1500)
  assert.ok(yieldPrices(0).every((x) => x.price === null))
  assert.ok(yieldPrices(null).every((x) => x.price === null))
})

test('ネットキャッシュ・調整後PER', () => {
  assert.equal(netCash(100, 30), 70)
  assert.equal(netCash(100, null), null)
  assert.equal(netCashRatioPct(70, 700), 10)
  assert.equal(netCashRatioPct(70, 0), null)
  assert.equal(cashAdjustedPer(1000, 200, 100), 8)
  assert.equal(cashAdjustedPer(1000, 200, -1), null)
  assert.equal(cashAdjustedPer(1000, 2000, 100), null) // EV非正
  assert.equal(payoutRatioPct(10, 0), null)
  assert.equal(payoutRatioPct(10, 40), 25)
})

function period(fy: string, over: Partial<FinancialPeriod> = {}): FinancialPeriod {
  return {
    fiscalYear: fy, sales: 1000, operatingProfit: 100, netIncome: 60, totalAssets: 2000, netAssets: 1000, nonControllingInterests: 100,
    cash: 300, interestBearingDebt: 100, operatingCf: 120, investingCf: -50, financingCf: -30, totalDividends: 20, dps: 2, eps: 6,
    epsAdjusted: 6, bpsAdjusted: 90, dpsAdjusted: 2, sharesOutstanding: 10, fcfApi: null, ...over,
  }
}

test('財務: 簡易FCF・配当性向・DOE(期首期末平均)・自己資本を独自計算し、ROE等は計算しない', () => {
  const rows = computeFinancialRows([period('2024/03'), period('2025/03', { totalDividends: 40 })], false)
  const r0 = rows[0]!
  const r1 = rows[1]!
  assert.equal(r0.equity, 900) // 1000 - 100
  assert.equal(r0.doePct, null) // 期首がないので平均が取れない(期末値で代用しない)
  assert.equal(r1.fcfSimple, 70)
  assert.equal(r1.netCash, 200)
  assert.equal(r1.payoutRatioPct, (2 / 6) * 100)
  close(r1.doePct, (40 / 900) * 100, 1e-9) // 平均自己資本 = (900+900)/2
  assert.equal('roePct' in r1, false) // ROE・ROA・利益率・成長率はAPI値を使う
})

test('財務: 赤字(EPS<=0)の配当性向は null / 必要項目が欠ければ null で0にしない', () => {
  const d = computeFinancialRows([period('2025/03', { eps: -1 })], false)[0]!
  assert.equal(d.payoutRatioPct, null)
  const m = computeFinancialRows([period('2025/03', { cash: null, operatingCf: null, netAssets: null })], false)[0]!
  assert.equal(m.netCash, null)
  assert.equal(m.fcfSimple, null)
  assert.equal(m.equity, null)
})

test('財務: 金融機関は有利子負債・ネットキャッシュ・FCFを非適用にする', () => {
  const r = computeFinancialRows([period('2025/03')], true)[0]!
  assert.equal(r.netCash, null)
  assert.equal(r.fcfSimple, null)
  assert.ok(isFinancialSector('銀行業'))
  assert.ok(isFinancialSector('保険業'))
  assert.ok(!isFinancialSector('電気機器'))
  assert.ok(!isFinancialSector(null))
})

test('需給: 売り残0は null と理由を返す', () => {
  assert.deepEqual(marginRatio(100, 0), { value: null, reason: '売り残が0のため算出不可' })
  assert.equal(marginRatio(100, 50).value, 2)
  assert.equal(marginRatio(null, 50).value, null)
  assert.equal(buyBalanceDays(1000, 100), 10)
  assert.equal(buyBalanceDays(1000, 0), null)
})
