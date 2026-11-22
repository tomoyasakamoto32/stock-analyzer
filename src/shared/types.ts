export const SECTION_TYPES = ['fundamental', 'technical', 'supply_demand', 'financial'] as const
export type SectionType = (typeof SECTION_TYPES)[number]
export type ReportKind = SectionType | 'overall'
export const REPORT_KINDS: readonly ReportKind[] = [...SECTION_TYPES, 'overall']

export const SECTION_LABELS: Record<ReportKind, string> = {
  fundamental: 'ファンダメンタル',
  technical: 'テクニカル',
  supply_demand: '需給',
  financial: '財務',
  overall: '総評',
}

export const INVESTMENT_STYLES = ['swing', 'mid_long', 'high_dividend'] as const
export type InvestmentStyle = (typeof INVESTMENT_STYLES)[number]
export const STYLE_LABELS: Record<InvestmentStyle, string> = {
  swing: 'スイング',
  mid_long: '中長期',
  high_dividend: '高配当',
}

export type RunStatus = 'collecting' | 'analyzing' | 'completed' | 'failed'

// ---- AI 出力契約 (仕様 5.3) ----
export type Finding = { text: string; evidenceIds: string[] }
export type Outlook = 'positive' | 'neutral' | 'negative' | 'insufficient_data'
export type Section = {
  type: SectionType
  outlook: Outlook
  summary: string
  findings: Finding[]
  bullishFactors: Finding[]
  bearishFactors: Finding[]
  risks: Finding[]
  catalysts: Finding[]
  missingData: string[]
}
export type PriceRange = { low: number; high: number; rationale: string; evidenceIds: string[] }
/** 分割エントリーの1段階。配分(allocationPct)は全段階で合計100(参考。資金量・許容損失はユーザーが決める) */
export type EntryTier = PriceRange & { allocationPct: number }
export const MAX_ENTRY_TIERS = 4
export type Stance = 'consider' | 'wait' | 'avoid' | 'insufficient_data'
export type Scenario = {
  name: 'bull' | 'base' | 'bear'
  conditions: string
  outlook: string
  evidenceIds: string[]
}
export type Overall = {
  summary: string
  stance: Stance
  fairValue: PriceRange | null
  /** 分割エントリー候補。浅い(高い)順で価格帯は重ならない。材料が無ければ空配列 */
  entries: EntryTier[]
  takeProfit: PriceRange | null
  stopLoss: PriceRange | null
  scenarios: Scenario[]
  risks: Finding[]
  contradictions: string[]
  missingData: string[]
}
export type AnalysisOutput = { sections: Section[]; overall: Overall }

// ---- 入力スナップショット ----
/** 指標の取得元: api=IRBANKの計算済み値 / calculated=本アプリで算出 / disclosure=開示書類 / web=Web検索(外部情報・未検証) */
export type MetricOrigin = 'api' | 'calculated' | 'disclosure' | 'web'

/**
 * AIに渡す数値と画面表示の単位。api と calculated は定義が異なりうるため、同名でも別IDで扱う。
 */
export type Evidence = {
  id: string
  category: SectionType | 'common'
  label: string
  /** 取得できない・算出不可は null(0とは区別する) */
  value: number | string | null
  unit: string
  origin: MetricOrigin
  /** 指標の基準日: 株価ベースなら株価基準日(YYYY-MM-DD)、決算期ベースなら決算期(YYYY/MM)、週次なら公表基準日 */
  asOf: string | null
  /** 定義・算出式・API側の項目説明(fields[].note)・注意点 */
  definition: string
  /** 実績/予想。区別しない指標は null */
  basis: 'actual' | 'forecast' | null
  /** 会計期間(決算期ベースの指標) */
  period: string | null
  /** 株価に依存する指標の株価基準日 */
  priceAsOf: string | null
  /** 出典表示(attribution.source_label) */
  sourceLabel: string
  /** 元データの参照先(エンドポイントとフィールド) */
  endpoint: string | null
}

export type SourceMeta = { dataset: string; sourceLabel: string; fetchedAt: string; asOf: string | null }

/** 分析に使った開示書類(確認用)。pdfUrl は取得専用(ブラウザへは渡さず、アプリの中継ルート経由で開く) */
export type DocRef = {
  docId: string
  source: 'tdnet' | 'edinet'
  title: string
  /** 開示日時(ISO, UTC) */
  disclosedAt: string
  /** 何に使ったか(例: 決算短信(会社予想・要約)、経営者による分析) */
  roles: string[]
  pdfUrl: string | null
  /** 原本へのリンク(提供されている場合のみ) */
  sourceUrl: string | null
}

export type YieldPrice = { targetYieldPct: number; price: number | null }

export type Snapshot = {
  stock: { code: string; name: string; market: string | null; sector: string | null }
  generatedAt: string
  priceAsOf: string | null
  isFinancialInstitution: boolean
  evidence: Evidence[]
  /** サーバー計算値(AI出力で上書きしない) */
  yieldPrices: YieldPrice[]
  /** 分析に使った開示書類 */
  documents?: DocRef[]
  /** 会社予想DPS基準の利回り別株価(予想を取得できた場合のみ) */
  yieldPricesForecast?: YieldPrice[]
  missingData: string[]
  sources: SourceMeta[]
}

export type Usage = {
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  reasoningTokens: number | null
  priceTableVersion: string | null
  costBasis: string
  /** Web検索(リサーチ)を実行した場合の内訳。ツール利用料は推定費用に含まない */
  /** 決算短信PDFのAI要約 */
  tanshin?: { used: boolean; inputTokens: number | null; outputTokens: number | null; error: string | null }
  research?: {
    used: boolean
    searchCalls: number | null
    inputTokens: number | null
    outputTokens: number | null
    items: number
    error: string | null
  }
}

// ---- API ----
export type RunSummary = {
  id: string
  stockCode: string
  status: RunStatus
  investmentStyle: InvestmentStyle
  requestedAt: string
  completedAt: string | null
  model: string | null
  aiMode: string | null
  dataSource: string | null
  estimatedCostUsd: number | null
  errorCode: string | null
  errorMessage: string | null
}

export type CreateAnalysisRequest = { code: string; style: InvestmentStyle; webSearch?: boolean }
export type ApiError = { error: { code: string; message: string } }
