export type FinancialPeriod = {
  fiscalYear: string // "2025/03"
  sales: number | null
  operatingProfit: number | null
  netIncome: number | null
  totalAssets: number | null
  netAssets: number | null
  nonControllingInterests: number | null
  cash: number | null
  interestBearingDebt: number | null
  operatingCf: number | null
  investingCf: number | null
  financingCf: number | null
  totalDividends: number | null
  dps: number | null
  eps: number | null
  /** 最新株数基準の調整後1株指標(株価との比較用) */
  epsAdjusted: number | null
  bpsAdjusted: number | null
  dpsAdjusted: number | null
  sharesOutstanding: number | null
  /** /financials の fcf(定義はAPI準拠。営業CF+投資CFとは限らない) */
  fcfApi: number | null
}

/**
 * 独自計算が必要な財務指標のみ(ROE・ROA・利益率・成長率・自己資本比率はAPI値を使うためここでは計算しない)。
 * 金融機関では有利子負債・ネットキャッシュ・FCF(簡易)を非適用(null)にする。
 */
export type FinancialRow = {
  fiscalYear: string
  /** 自己資本 = 純資産 − 非支配株主持分 */
  equity: number | null
  netCash: number | null
  /** 簡易FCF = 営業CF + 投資CF。APIのfcfが無い場合の代替 */
  fcfSimple: number | null
  /** 配当性向(%) = DPS ÷ EPS ×100。APIの値が無い場合の代替。EPSが0以下ならnull */
  payoutRatioPct: number | null
  /** DOE(%) = 配当総額 ÷ 期首期末平均自己資本 ×100。APIの値が無い場合の代替 */
  doePct: number | null
}

/** 自己資本 = 純資産 − 非支配株主持分(純資産が null なら null。持分が null の場合は 0 とみなす)。 */
export function equityOf(p: FinancialPeriod): number | null {
  if (p.netAssets == null) return null
  return p.netAssets - (p.nonControllingInterests ?? 0)
}
function avg(a: number | null, b: number | null): number | null {
  if (a == null || b == null) return null
  return (a + b) / 2
}

/** periods は決算期昇順。 */
export function computeFinancialRows(periods: readonly FinancialPeriod[], isFinancial: boolean): FinancialRow[] {
  return periods.map((p, i) => {
    const prev = i > 0 ? periods[i - 1]! : null
    const equity = equityOf(p)
    const avgEquity = avg(equity, prev ? equityOf(prev) : null)
    return {
      fiscalYear: p.fiscalYear,
      equity,
      netCash: isFinancial || p.cash == null || p.interestBearingDebt == null ? null : p.cash - p.interestBearingDebt,
      fcfSimple: isFinancial || p.operatingCf == null || p.investingCf == null ? null : p.operatingCf + p.investingCf,
      payoutRatioPct: p.dps != null && p.eps != null && p.eps > 0 ? (p.dps / p.eps) * 100 : null,
      // 期首の自己資本が取れない最初の期は null(期末値で代用しない)
      doePct: p.totalDividends != null && avgEquity != null && avgEquity > 0 ? (p.totalDividends / avgEquity) * 100 : null,
    }
  })
}

const FINANCIAL_SECTORS = ['銀行業', '保険業', '証券、商品先物取引業', 'その他金融業']
export function isFinancialSector(sector: string | null): boolean {
  return sector != null && FINANCIAL_SECTORS.some((s) => sector.includes(s))
}
