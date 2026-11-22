import type { SourceMeta } from '../../../shared/types.ts'
import type { Bar } from '../calculators/technical.ts'
import type { FinancialPeriod } from '../calculators/financial.ts'
import type { JsfDay, JsfReverse, WeeklyMargin } from '../calculators/supply-demand.ts'

export type SecurityInfo = {
  code: string
  name: string
  market: string | null
  industry: string | null
  edinetCode: string | null
  issuedShares: number | null
  fiscalYearEndMonth: number | null
}

export type ValuationRow = {
  fiscalYear: string
  /** 以下は決算期末の株価基準(日次の最新値ではない) */
  per: number | null
  perHigh: number | null
  perLow: number | null
  pbr: number | null
  dividendYieldPct: number | null
  marketCap: number | null
}
export type DividendRow = { fiscalYear: number; annualDps: number | null; doePct: number | null }

/** /indicators の決算期ごとの計算済み指標(単位は % に正規化済み) */
export type IndicatorRow = {
  fiscalYear: string
  roePct: number | null
  /** ROEの採用元キー(roe_computed 優先、無ければ roe) */
  roeKey: 'roe_computed' | 'roe' | null
  roaPct: number | null
  operatingMarginPct: number | null
  netMarginPct: number | null
  equityRatioPct: number | null
  payoutRatioPct: number | null
  salesGrowthPct: number | null
  operatingIncomeGrowthPct: number | null
  netIncomeGrowthPct: number | null
  /** API定義の net_debt(円)。ネットキャッシュとは定義が異なりうるため参考値 */
  netDebt: number | null
}
export type ShareholderRow = { holderName: string; holdingRatioPct: number | null; previousRatioPct: number | null }

/** 決算短信XBRLから取り出した通期の会社予想(開示時点の株数基準)。値が無い項目は null */
export type ForecastValues = {
  fiscalYearScope: 'CurrentYear' | 'NextYear' | null
  scope: 'consolidated' | 'non_consolidated' | null
  eps: number | null
  epsElement: string | null
  dps: number | null
  sales: number | null
  operatingProfit: number | null
  netIncome: number | null
}
export type ForecastSet = {
  /** 取得できた場合の予想。取得できない場合は null で、理由は reason */
  values: ForecastValues | null
  reason: string | null
  docId: string | null
  /** 決算短信PDFのURL(IRBANKのファイル配信)。無ければ null */
  pdfUrl: string | null
  sourceUrl: string | null
  title: string | null
  /** 開示日時(ISO, UTC) */
  disclosedAt: string | null
  /** 決算短信の後に出た予想修正等の開示(予想値には未反映) */
  laterRevisions: { title: string; disclosedAt: string }[]
}

export type SegmentRow = {
  fiscalYear: string
  /** 通期は null、四半期(単独)は 1〜4 */
  quarter: number | null
  name: string
  revenue: number | null
  operatingIncome: number | null
  revenueSharePct: number | null
  yoyGrowthPct: number | null
}

/** 開示書類から取り出した文章(HTMLを除去し、長さを制限した抜粋) */
export type NarrativeDoc = {
  kind: 'mda' | 'management_policy' | 'risk_factors'
  docId: string
  docTitle: string
  /** 開示日時(ISO, UTC) */
  disclosedAt: string
  text: string
  pdfUrl: string | null
  sourceUrl: string | null
  /** 抜粋で切り詰めたか */
  truncated: boolean
}
export type NarrativeSet = {
  docs: NarrativeDoc[]
  /** 適時開示(TDnet)の最近の見出し。内容は未取得 */
  recentIr: { title: string; disclosedAt: string }[]
  /** 取得できなかった項目の理由 */
  reasons: string[]
}

/** defs: 項目キー → API側の定義(label・unit・note)。画面とAI入力の定義欄に使う */
export type Dataset<T> = { data: T; meta: SourceMeta; defs?: Record<string, string> }

export type FinancialSet = {
  annual: FinancialPeriod[] // 昇順
  /** 最新の四半期(単独)。取得できなければ null */
  latestQuarter: { fiscalYear: string; quarter: string; sales: number | null; operatingProfit: number | null; netIncome: number | null } | null
}

export type SecurityListRow = { code: string; name: string; market: string | null; industry: string | null }

/** 分析サービスはこのインターフェースのみに依存する */
export interface MarketDataProvider {
  readonly name: 'irbank' | 'mock'
  /** 上場銘柄の一覧(銘柄マスタ用)。cursor は前回の nextCursor。1ページ最大500件 */
  listSecurities(cursor?: string): Promise<{ rows: SecurityListRow[]; nextCursor: string | null }>
  getSecurity(code: string): Promise<Dataset<SecurityInfo>>
  /** 昇順で返す */
  getPrices(code: string, fromDate: string): Promise<Dataset<Bar[]>>
  getFinancials(code: string, edinetCode: string | null): Promise<Dataset<FinancialSet>>
  /** セグメント別業績。period 'annual' は通期、'quarter' は単独四半期 */
  getSegments(edinetCode: string, period: 'annual' | 'quarter'): Promise<Dataset<SegmentRow[]>>
  /** 有報・半期/四半期報告書の本文抜粋と、最近の適時開示の見出し */
  getNarratives(code: string): Promise<Dataset<NarrativeSet>>
  /** 決算短信PDFなどのバイナリを取得する(モックは null)。サイズ上限を超えると失敗 */
  getDocumentPdf(url: string, maxBytes: number): Promise<Uint8Array | null>
  /** 最新の決算短信から会社予想を取得する。取得できない場合も例外にせず reason を返す */
  getForecast(code: string): Promise<Dataset<ForecastSet>>
  getIndicators(code: string): Promise<Dataset<IndicatorRow[]>>
  getValuations(code: string): Promise<Dataset<{ history: ValuationRow[]; per5yAvg: number | null }>>
  getDividends(edinetCode: string): Promise<Dataset<DividendRow[]>>
  getWeeklyMargin(code: string): Promise<Dataset<WeeklyMargin[]>>
  getJsfMargin(code: string): Promise<Dataset<{ days: JsfDay[]; reverse: JsfReverse[] }>>
  getShareholders(edinetCode: string): Promise<Dataset<ShareholderRow[]>>
}

export type ProviderErrorCode = 'unauthorized' | 'forbidden' | 'not_found' | 'rate_limited' | 'unavailable' | 'invalid_response' | 'bad_request'

export class ProviderError extends Error {
  code: ProviderErrorCode
  status?: number
  constructor(code: ProviderErrorCode, message: string, status?: number) {
    super(message)
    this.code = code
    this.status = status
  }
}
