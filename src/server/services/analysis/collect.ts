import { AnalysisError } from './errors.ts'
import { pool } from '../providers/irbank/client.ts'
import {
  ProviderError,
  type Dataset,
  type DividendRow,
  type FinancialSet,
  type ForecastSet,
  type IndicatorRow,
  type MarketDataProvider,
  type NarrativeSet,
  type SegmentRow,
  type SecurityInfo,
  type ShareholderRow,
  type ValuationRow,
} from '../providers/types.ts'
import type { Bar } from '../calculators/technical.ts'
import type { JsfDay, JsfReverse, WeeklyMargin } from '../calculators/supply-demand.ts'
import type { SourceMeta } from '../../../shared/types.ts'
import { addDays, jstDate } from '../../util/time.ts'

export type Collected = {
  security: SecurityInfo
  bars: Bar[]
  financials: FinancialSet
  indicators: IndicatorRow[] | null
  /** 決算短信の会社予想(取得失敗時は null) */
  forecast: ForecastSet | null
  /** セグメント別業績(通期・単独四半期)。取得できなければ null */
  segmentsAnnual: SegmentRow[] | null
  segmentsQuarter: SegmentRow[] | null
  /** 開示書類の文章抜粋・最近のIR見出し */
  narratives: NarrativeSet | null
  valuations: { history: ValuationRow[]; per5yAvg: number | null } | null
  dividends: DividendRow[] | null
  weekly: WeeklyMargin[] | null
  jsf: { days: JsfDay[]; reverse: JsfReverse[] } | null
  shareholders: ShareholderRow[] | null
  sources: SourceMeta[]
  /** `${dataset}.${key}` → API側の項目定義 */
  defs: Record<string, string>
  /** 任意データの取得失敗理由 */
  missing: string[]
}

const MIN_BARS = 30
const PRICE_LOOKBACK_DAYS = 380 // 200日MAに必要な件数(約200営業日)を十分に上回る

function reason(e: unknown): string {
  return e instanceof ProviderError ? `${e.message}` : e instanceof Error ? e.message : '不明なエラー'
}

/**
 * light=true は「データのみ表示」用。AIへ渡さない主要データの表示に不要な項目
 * (セグメント・開示文書の本文・大株主・日証金)を取得しない(IRBANKのリクエストを節約する)。
 */
export async function collect(provider: MarketDataProvider, code: string, opts: { light?: boolean } = {}): Promise<Collected> {
  const skip = <T,>(): Promise<Dataset<T>> => Promise.resolve(null as unknown as Dataset<T>)
  const light = opts.light === true
  const sources: SourceMeta[] = []
  const missing: string[] = []
  const defs: Record<string, string> = {}
  const keep = <T>(d: Dataset<T>): T => {
    sources.push(d.meta)
    for (const [k, v] of Object.entries(d.defs ?? {})) defs[`${d.meta.dataset}.${k}`] = v
    return d.data
  }

  let security: SecurityInfo
  try {
    security = keep(await provider.getSecurity(code))
  } catch (e) {
    if (e instanceof ProviderError && e.code === 'not_found') throw new AnalysisError('stock_not_found', `銘柄コード ${code} が見つかりません`)
    throw toAnalysisError(e, '銘柄情報')
  }

  const from = addDays(jstDate(), -PRICE_LOOKBACK_DAYS)
  const settled = await pool<Dataset<unknown>>(
    [
      () => provider.getPrices(code, from),
      () => provider.getFinancials(code, security.edinetCode),
      () => provider.getValuations(code),
      () => (security.edinetCode ? provider.getDividends(security.edinetCode) : Promise.reject(new Error('EDINETコード不明'))),
      () => provider.getWeeklyMargin(code),
      () => (light ? skip() : provider.getJsfMargin(code)),
      () => (light ? skip() : security.edinetCode ? provider.getShareholders(security.edinetCode) : Promise.reject(new Error('EDINETコード不明'))),
      () => provider.getIndicators(code),
      () => provider.getForecast(code),
      () => (light ? skip() : security.edinetCode ? provider.getSegments(security.edinetCode, 'annual') : Promise.reject(new Error('EDINETコード不明'))),
      () => (light ? skip() : security.edinetCode ? provider.getSegments(security.edinetCode, 'quarter') : Promise.reject(new Error('EDINETコード不明'))),
      () => (light ? skip() : provider.getNarratives(code)),
    ],
    3,
  )
  const at = <T>(i: number) => settled[i] as PromiseSettledResult<Dataset<T>>
  const pricesR = at<Bar[]>(0)
  const finR = at<FinancialSet>(1)
  const valR = at<{ history: ValuationRow[]; per5yAvg: number | null }>(2)
  const divR = at<DividendRow[]>(3)
  const weeklyR = at<WeeklyMargin[]>(4)
  const jsfR = at<{ days: JsfDay[]; reverse: JsfReverse[] }>(5)
  const shR = at<ShareholderRow[]>(6)
  const indR = at<IndicatorRow[]>(7)
  const fcR = at<ForecastSet>(8)
  const segAR = at<SegmentRow[]>(9)
  const segQR = at<SegmentRow[]>(10)
  const narR = at<NarrativeSet>(11)

  // 必須: 日足・年次財務。不足は失敗扱い。
  if (pricesR.status === 'rejected') throw toAnalysisError(pricesR.reason, '日足')
  if (finR.status === 'rejected') throw toAnalysisError(finR.reason, '財務')
  const bars = keep(pricesR.value)
  const financials = keep(finR.value)
  if (bars.length < MIN_BARS) throw new AnalysisError('insufficient_data', `日足が不足しています(${bars.length}件 < ${MIN_BARS}件)`)
  if (financials.annual.length === 0) throw new AnalysisError('insufficient_data', '年次財務データがありません')
  if (bars.length < 200) missing.push(`日足が${bars.length}件のためSMA200は算出不可`)

  const opt = <T>(r: PromiseSettledResult<Dataset<T>>, label: string): T | null => {
    if (r.status === 'fulfilled') return r.value ? keep(r.value) : null // null は取得を省略した項目(軽量モード)
    missing.push(`${label}: 取得できませんでした(${reason(r.reason)})`)
    return null
  }
  const valuations = opt(valR, '過去バリュエーション')
  const dividends = opt(divR, '配当実績')
  const weekly = opt(weeklyR, '週次信用残')
  const jsf = opt(jsfR, '日証金貸借残・逆日歩')
  const shareholders = opt(shR, '大量保有報告(大株主)')
  const indicators = opt(indR, '計算済み財務指標(ROE・ROA・利益率等)')
  const forecast = opt(fcR, '会社予想(決算短信)')
  const segmentsAnnual = opt(segAR, 'セグメント別業績(通期)')
  const segmentsQuarter = opt(segQR, 'セグメント別業績(単独四半期)')
  const narratives = opt(narR, '開示書類の文章・最近のIR')

  return { security, bars, financials, indicators, forecast, segmentsAnnual, segmentsQuarter, narratives, valuations, dividends, weekly, jsf, shareholders, sources, defs, missing }
}

function toAnalysisError(e: unknown, what: string): AnalysisError {
  if (e instanceof AnalysisError) return e
  if (e instanceof ProviderError) {
    const map: Record<string, string> = {
      unauthorized: 'provider_unauthorized',
      forbidden: 'provider_forbidden',
      rate_limited: 'provider_rate_limited',
      not_found: 'insufficient_data',
    }
    return new AnalysisError(map[e.code] ?? 'provider_error', `${what}の取得に失敗: ${e.message}`)
  }
  return new AnalysisError('provider_error', `${what}の取得に失敗`)
}
