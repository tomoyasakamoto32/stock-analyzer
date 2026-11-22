import type { Bar } from '../../calculators/technical.ts'
import type { FinancialPeriod } from '../../calculators/financial.ts'
import { ProviderError, type Dataset, type ForecastSet, type IndicatorRow, type NarrativeSet, type SegmentRow, type MarketDataProvider, type SecurityInfo } from '../types.ts'
import { addDays, jstDate, nowIso } from '../../../util/time.ts'

/**
 * 外部送信・保存の許諾確認前に一連の機能を検証するための決定論的ダミーデータ。
 * 数値はすべて架空であり、実在企業の実績ではない。
 * 7xxx 等の任意コードは「一般事業会社」、9998=赤字企業、8306=金融機関、285A=英数字コード。
 */
type Profile = { name: string; market: string; industry: string; kind: 'general' | 'deficit' | 'bank' }

function profileOf(code: string): Profile {
  if (code === '9998') return { name: 'モック赤字工業', market: 'Growth', industry: '機械', kind: 'deficit' }
  if (code === '8306') return { name: 'モック銀行', market: 'Prime', industry: '銀行業', kind: 'bank' }
  if (code === '285A') return { name: 'モック英数字コード株式会社', market: 'Standard', industry: '情報・通信業', kind: 'general' }
  return { name: `モック製作所(${code})`, market: 'Prime', industry: '電気機器', kind: 'general' }
}

function seedOf(code: string): number {
  let h = 2166136261
  for (const c of code) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return h >>> 0
}
function rng(seed: number) {
  let s = seed || 1
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const SHARES = 100_000_000

function mockPeriods(code: string, kind: Profile['kind']): FinancialPeriod[] {
  const r = rng(seedOf(code) ^ 0xabc)
  const years = [2020, 2021, 2022, 2023, 2024, 2025]
  let sales = 200_000_000_000 * (0.5 + r())
  let equity = 120_000_000_000
  return years.map((y, i) => {
    sales *= 1 + (r() - 0.35) * 0.15
    const margin = kind === 'deficit' ? (i >= 3 ? -0.03 - r() * 0.02 : 0.02) : 0.06 + r() * 0.04
    const op = sales * margin
    const ni = kind === 'deficit' && i >= 3 ? op * 1.1 : op * 0.68
    equity += ni * 0.6
    const bank = kind === 'bank'
    const eps = ni / SHARES
    const dps = ni > 0 ? Math.round(eps * 0.35 * 10) / 10 : 5
    return {
      fiscalYear: `${y}/03`,
      sales,
      operatingProfit: op,
      netIncome: ni,
      totalAssets: bank ? equity * 25 : equity * 2.1,
      netAssets: equity,
      nonControllingInterests: equity * 0.02,
      cash: bank ? equity * 4 : equity * 0.45,
      interestBearingDebt: bank ? equity * 6 : equity * 0.3,
      operatingCf: ni * 1.4,
      investingCf: -ni * 0.9,
      financingCf: -ni * 0.4,
      totalDividends: dps * SHARES,
      dps,
      eps,
      epsAdjusted: eps,
      bpsAdjusted: equity / SHARES,
      dpsAdjusted: dps,
      sharesOutstanding: SHARES,
      fcfApi: ni * 0.5,
    }
  })
}

export class MockProvider implements MarketDataProvider {
  readonly name = 'mock' as const

  private m(dataset: string, asOf: string | null) {
    return { dataset, sourceLabel: 'モックデータ(架空)', fetchedAt: nowIso(), asOf }
  }

  async listSecurities() {
    // モックの銘柄(すべて架空)。名前・コードの候補検索の動作確認用
    const rows = [
      ['7203', 'モック製作所(7203)', 'Prime', '電気機器'], ['8306', 'モック銀行', 'Prime', '銀行業'], ['9998', 'モック赤字工業', 'Growth', '機械'],
      ['285A', 'モック英数字コード株式会社', 'Standard', '情報・通信業'], ['6758', 'モック電機', 'Prime', '電気機器'], ['6501', 'モック重工', 'Prime', '機械'],
      ['5803', 'モックケーブル', 'Prime', '非鉄金属'], ['5802', 'モック電線工業', 'Prime', '非鉄金属'],
    ].map(([code, name, market, industry]) => ({ code: code!, name: name!, market: market!, industry: industry! }))
    return { rows, nextCursor: null }
  }

  async getSecurity(code: string): Promise<Dataset<SecurityInfo>> {
    if (code === '0000') throw new ProviderError('not_found', 'モック: 存在しない銘柄です')
    const p = profileOf(code)
    return {
      data: { code, name: p.name, market: p.market, industry: p.industry, edinetCode: `E9${code.replace(/\W/g, '0').padStart(4, '0')}`, issuedShares: SHARES, fiscalYearEndMonth: 3 },
      meta: this.m('security', null),
    }
  }

  async getPrices(code: string, fromDate: string): Promise<Dataset<Bar[]>> {
    const r = rng(seedOf(code))
    const today = jstDate()
    const bars: Bar[] = []
    let price = 800 + r() * 3000
    // 約 300 営業日分を昇順で生成し fromDate 以降に絞る
    let d = addDays(today, -440)
    while (d <= today) {
      const dow = new Date(`${d}T00:00:00Z`).getUTCDay()
      if (dow !== 0 && dow !== 6) {
        const open = price
        price = Math.max(50, price * (1 + (r() - 0.48) * 0.04))
        const high = Math.max(open, price) * (1 + r() * 0.01)
        const low = Math.min(open, price) * (1 - r() * 0.01)
        bars.push({ date: d, open, high, low, close: price, adjClose: price, volume: Math.round(300_000 + r() * 700_000) })
      }
      d = addDays(d, 1)
    }
    const out = bars.filter((b) => b.date >= fromDate)
    return { data: out, meta: this.m('prices', out.at(-1)?.date ?? null) }
  }

  async getFinancials(code: string) {
    const p = profileOf(code)
    const annual = mockPeriods(code, p.kind)
    const last = annual.at(-1)!
    return {
      data: {
        annual,
        latestQuarter: { fiscalYear: '2026/03', quarter: 'Q2', sales: last.sales! / 4, operatingProfit: last.operatingProfit! / 4, netIncome: last.netIncome! / 4 },
      },
      meta: this.m('financials', last.fiscalYear),
    }
  }

  async getValuations(code: string) {
    const r = rng(seedOf(code) ^ 7)
    const history = [2021, 2022, 2023, 2024, 2025].map((y) => {
      const per = 10 + r() * 10
      return { fiscalYear: `${y}/03`, per, perHigh: per * 1.2, perLow: per * 0.8, pbr: 0.8 + r(), dividendYieldPct: 1 + r() * 3, marketCap: 1e12 * (0.5 + r()) }
    })
    return {
      data: { history, per5yAvg: history.reduce((a, b) => a + b.per, 0) / history.length },
      meta: this.m('valuations', '2025/03'),
      defs: { per: 'PER[times] モック: 決算期末株価基準' },
    }
  }

  async getDocumentPdf(): Promise<Uint8Array | null> {
    return null
  }

  async getSegments(_edinetCode: string, period: 'annual' | 'quarter'): Promise<Dataset<SegmentRow[]>> {
    const q = period === 'quarter' ? 2 : null
    const rows: SegmentRow[] = [
      { fiscalYear: period === 'quarter' ? '2027/03' : '2026/03', quarter: q, name: 'モック事業A(架空)', revenue: 300e9, operatingIncome: 60e9, revenueSharePct: 60, yoyGrowthPct: 40 },
      { fiscalYear: period === 'quarter' ? '2027/03' : '2026/03', quarter: q, name: 'モック事業B(架空)', revenue: 200e9, operatingIncome: -5e9, revenueSharePct: 40, yoyGrowthPct: -3.5 },
    ]
    return { data: rows, meta: this.m(`segments_${period}`, rows[0]!.fiscalYear) }
  }

  async getNarratives(): Promise<Dataset<NarrativeSet>> {
    const at = `${addDays(jstDate(), -12)}T05:00:00.000Z`
    return {
      data: {
        docs: [
          { kind: 'mda', docId: 'MOCK-HALF', docTitle: 'モック半期報告書', disclosedAt: at, truncated: false, pdfUrl: null, sourceUrl: null, text: '当中間期の売上高は前年同期比で増加し、事業Aが増益を牽引しました。(モックの架空の文章です)' },
          { kind: 'management_policy', docId: 'MOCK-YUHO', docTitle: 'モック有価証券報告書', disclosedAt: at, truncated: false, pdfUrl: null, sourceUrl: null, text: '経営環境は需要拡大が続く一方、競争は激化しています。(モックの架空の文章です)' },
        ],
        recentIr: [{ title: 'モック: 自己株式取得に関するお知らせ', disclosedAt: at }],
        reasons: ['事業等のリスク: モックでは取得しません'],
      },
      meta: this.m('narratives', at.slice(0, 10)),
    }
  }

  async getForecast(code: string): Promise<Dataset<ForecastSet>> {
    const p = mockPeriods(code, profileOf(code).kind).at(-1)!
    const disclosed = `${addDays(jstDate(), -10)}T05:00:00.000Z`
    const loss = (p.eps ?? 0) <= 0
    return {
      data: {
        values: loss
          ? null
          : { fiscalYearScope: 'CurrentYear', scope: 'consolidated', eps: Math.round((p.eps ?? 0) * 1.2 * 100) / 100, epsElement: 'NetIncomePerShare', dps: Math.round((p.dps ?? 0) * 1.1 * 10) / 10, sales: (p.sales ?? 0) * 1.05, operatingProfit: (p.operatingProfit ?? 0) * 1.2, netIncome: (p.netIncome ?? 0) * 1.2 },
        reason: loss ? 'モック: 赤字のため会社予想なし' : null,
        docId: 'MOCK-TANSHIN',
        pdfUrl: null,
        sourceUrl: null,
        title: 'モック 第2四半期決算短信',
        disclosedAt: disclosed,
        laterRevisions: [],
      },
      meta: this.m('forecast', disclosed.slice(0, 10)),
    }
  }

  async getIndicators(code: string): Promise<Dataset<IndicatorRow[]>> {
    const { kind } = profileOf(code)
    const periods = mockPeriods(code, kind)
    const rows: IndicatorRow[] = periods.map((p, i) => {
      const prev = i > 0 ? periods[i - 1]! : null
      const equity = (p.netAssets ?? 0) - (p.nonControllingInterests ?? 0)
      const g = (a: number | null, b: number | null) => (a != null && b != null && b > 0 ? ((a - b) / b) * 100 : null)
      return {
        fiscalYear: p.fiscalYear,
        roePct: p.netIncome != null && equity > 0 ? (p.netIncome / equity) * 100 : null,
        roeKey: 'roe_computed' as const,
        roaPct: p.netIncome != null && p.totalAssets ? (p.netIncome / p.totalAssets) * 100 : null,
        operatingMarginPct: p.operatingProfit != null && p.sales ? (p.operatingProfit / p.sales) * 100 : null,
        netMarginPct: p.netIncome != null && p.sales ? (p.netIncome / p.sales) * 100 : null,
        equityRatioPct: p.totalAssets ? (equity / p.totalAssets) * 100 : null,
        payoutRatioPct: p.dps != null && p.eps != null && p.eps > 0 ? (p.dps / p.eps) * 100 : null,
        salesGrowthPct: g(p.sales, prev?.sales ?? null),
        operatingIncomeGrowthPct: g(p.operatingProfit, prev?.operatingProfit ?? null),
        netIncomeGrowthPct: g(p.netIncome, prev?.netIncome ?? null),
        netDebt: kind === 'bank' || p.interestBearingDebt == null || p.cash == null ? null : p.interestBearingDebt - p.cash,
      }
    })
    return {
      data: rows,
      meta: this.m('indicators', rows.at(-1)?.fiscalYear ?? null),
      defs: { roe_computed: 'ROE(計算値)[percent] モック', net_debt: '純有利子負債[jpy] モック' },
    }
  }

  async getDividends(edinetCode: string) {
    const rows = [2021, 2022, 2023, 2024, 2025].map((y, i) => ({ fiscalYear: y, annualDps: 20 + i * 2, doePct: 2.5 }))
    void edinetCode
    return { data: rows, meta: this.m('dividends', '2025') }
  }

  async getWeeklyMargin(code: string) {
    const r = rng(seedOf(code) ^ 11)
    const today = jstDate()
    const weeks = Array.from({ length: 12 }, (_, i) => {
      const buy = Math.round(2_000_000 + r() * 1_000_000)
      const sell = code === '285A' ? 0 : Math.round(500_000 + r() * 400_000)
      return {
        reportDate: addDays(today, -7 * (11 - i)),
        buyBalance: buy,
        sellBalance: sell,
        marginRatio: sell > 0 ? buy / sell : null,
        buyChange: Math.round((r() - 0.5) * 200_000),
        sellChange: Math.round((r() - 0.5) * 100_000),
      }
    })
    return { data: weeks, meta: this.m('weekly_margin', weeks.at(-1)!.reportDate) }
  }

  async getJsfMargin(code: string) {
    const r = rng(seedOf(code) ^ 13)
    const today = jstDate()
    const days = Array.from({ length: 20 }, (_, i) => {
      const loan = Math.round(1_000_000 + r() * 300_000)
      const stock = Math.round(400_000 + r() * 200_000)
      return { date: addDays(today, -(19 - i)), loanBalance: loan, stockLoanBalance: stock, netBalance: loan - stock, lendingRatio: loan / stock }
    })
    return { data: { days, reverse: [] }, meta: this.m('jsf_margin', days.at(-1)!.date) }
  }

  async getShareholders() {
    return {
      data: [{ holderName: 'モック資産運用(架空)', holdingRatioPct: 5.2, previousRatioPct: 4.9 }],
      meta: this.m('shareholders', null),
    }
  }
}
