import { parseDailyLimit } from './services/analysis/cost.ts'

export interface Env {
  DB: D1Database
  ASSETS: Fetcher
  IRBANK_API_KEY?: string
  OPENAI_API_KEY?: string
  OPENAI_MODEL?: string
  CLOUDFLARE_ACCESS_TEAM_DOMAIN?: string
  CLOUDFLARE_ACCESS_AUD?: string
  OWNER_EMAIL?: string
  DATA_SOURCE?: string
  ALLOW_EXTERNAL_AI_DATA?: string
  ALLOW_PERSIST_SOURCE_DATA?: string
  ALLOW_WEB_SEARCH?: string
  ENABLE_TANSHIN_PDF?: string
  DEV_AUTH_BYPASS?: string
  DAILY_ANALYSIS_LIMIT?: string
  MONTHLY_COST_LIMIT_USD?: string
  OPENAI_MAX_OUTPUT_TOKENS?: string
  MAX_INPUT_CHARS?: string
  OPENAI_PRICE_INPUT_PER_MTOK?: string
  OPENAI_PRICE_OUTPUT_PER_MTOK?: string
  PRICE_TABLE_VERSION?: string
}

export type AppConfig = {
  dataSource: 'irbank' | 'mock'
  /** real: OpenAI へ送信 / mock: 外部送信なしのダミー分析 */
  aiMode: 'real' | 'mock'
  persistSnapshot: boolean
  /** Web検索(OpenAIのweb_searchツール)を使えるか。実AIモードかつ ALLOW_WEB_SEARCH=true の時のみ */
  webSearchEnabled: boolean
  /** 決算短信PDFをAIで要約して分析に加える。実AIモードで、ENABLE_TANSHIN_PDF=false でなければ有効 */
  tanshinPdfEnabled: boolean
  /** 1日の実行回数の上限。null は無制限(OpenAI側の利用上限などで管理する場合) */
  dailyLimit: number | null
  monthlyCostLimitUsd: number | null
  maxOutputTokens: number
  maxInputChars: number
  priceInputPerMtok: number | null
  priceOutputPerMtok: number | null
  priceTableVersion: string | null
}

const bool = (v: string | undefined) => v?.trim().toLowerCase() === 'true'
function num(v: string | undefined): number | null {
  if (v == null || v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

export function loadConfig(env: Env): AppConfig {
  const dataSource = env.DATA_SOURCE === 'irbank' ? 'irbank' : 'mock'
  // 外部送信は ALLOW_EXTERNAL_AI_DATA=true かつ キー・モデル設定済みの時のみ
  const aiMode = bool(env.ALLOW_EXTERNAL_AI_DATA) && !!env.OPENAI_API_KEY && !!env.OPENAI_MODEL ? 'real' : 'mock'
  return {
    dataSource,
    aiMode,
    persistSnapshot: bool(env.ALLOW_PERSIST_SOURCE_DATA),
    webSearchEnabled: aiMode === 'real' && bool(env.ALLOW_WEB_SEARCH),
    tanshinPdfEnabled: aiMode === 'real' && env.ENABLE_TANSHIN_PDF?.trim().toLowerCase() !== 'false',
    dailyLimit: parseDailyLimit(env.DAILY_ANALYSIS_LIMIT),
    monthlyCostLimitUsd: num(env.MONTHLY_COST_LIMIT_USD),
    maxOutputTokens: num(env.OPENAI_MAX_OUTPUT_TOKENS) ?? 8000,
    maxInputChars: num(env.MAX_INPUT_CHARS) ?? 90000,
    priceInputPerMtok: num(env.OPENAI_PRICE_INPUT_PER_MTOK),
    priceOutputPerMtok: num(env.OPENAI_PRICE_OUTPUT_PER_MTOK),
    priceTableVersion: env.PRICE_TABLE_VERSION?.trim() || null,
  }
}
