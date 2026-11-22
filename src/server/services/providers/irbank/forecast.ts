import type { ForecastValues } from '../types.ts'
import { isRec } from './guards.ts'

/**
 * 決算短信(TDnet)のXBRLファクトから通期の会社予想を取り出す。
 * 要素名・コンテキスト名は実レスポンス(J-GAAP・IFRSの決算短信)で確認したもののみを対象とし、
 * 未確認の要素(米国基準など)は推測せず null にする。
 *   - 第1〜3四半期の短信: CurrentYearDuration_*_ForecastMember
 *   - 本決算の短信:       NextYearDuration_*_ForecastMember
 */
const EPS_ELEMENTS = ['NetIncomePerShare', 'BasicEarningsPerShareIFRS']
const SALES_ELEMENTS = ['NetSales', 'OperatingRevenuesIFRS']
const OP_ELEMENTS = ['OperatingIncome', 'OperatingIncomeIFRS']
const NI_ELEMENTS = ['ProfitAttributableToOwnersOfParent', 'ProfitAttributableToOwnersOfParentIFRS']
const SCOPE_CTX = /^(CurrentYear|NextYear)Duration_(Consolidated|NonConsolidated)Member_ForecastMember$/
const DPS_CTX = /^(CurrentYear|NextYear)Duration_AnnualMember_NonConsolidatedMember_ForecastMember$/

type Fact = { element: string; context: string; value: number; unit: string | null }

function toFacts(raw: unknown): Fact[] {
  if (!Array.isArray(raw)) return []
  const out: Fact[] = []
  for (const f of raw) {
    if (!isRec(f) || typeof f.element_name !== 'string' || typeof f.context !== 'string') continue
    // 実レスポンスでは1株指標は数値、金額は文字列("1768000000000")で返る。数値形式の文字列のみ受け付ける
    const value =
      typeof f.value === 'number' ? f.value : typeof f.value === 'string' && /^-?\d+(\.\d+)?$/.test(f.value) ? Number(f.value) : NaN
    if (!Number.isFinite(value)) continue
    out.push({ element: f.element_name, context: f.context, value, unit: typeof f.unit === 'string' ? f.unit : null })
  }
  return out
}

export function parseForecastFacts(raw: unknown): ForecastValues {
  const facts = toFacts(raw)
  const pick = (elements: string[], ctx: RegExp, unit: string, scope?: string) => {
    for (const f of facts) {
      if (!elements.includes(f.element) || !ctx.test(f.context) || f.unit !== unit) continue
      if (scope && !f.context.includes(`Duration_${scope}Member`)) continue
      return f
    }
    return null
  }
  // 連結を優先し、連結が無ければ個別
  const eps = pick(EPS_ELEMENTS, SCOPE_CTX, 'JPYPerShares', 'Consolidated') ?? pick(EPS_ELEMENTS, SCOPE_CTX, 'JPYPerShares', 'NonConsolidated')
  const scope = eps?.context.includes('Duration_NonConsolidatedMember') ? 'NonConsolidated' : 'Consolidated'
  const dps = pick(['DividendPerShare'], DPS_CTX, 'JPYPerShares')
  const sales = pick(SALES_ELEMENTS, SCOPE_CTX, 'JPY', scope)
  const op = pick(OP_ELEMENTS, SCOPE_CTX, 'JPY', scope)
  const ni = pick(NI_ELEMENTS, SCOPE_CTX, 'JPY', scope)
  const anyCtx = eps ?? dps ?? sales ?? op ?? ni
  return {
    fiscalYearScope: anyCtx ? (anyCtx.context.startsWith('NextYear') ? 'NextYear' : 'CurrentYear') : null,
    scope: eps ? (scope === 'Consolidated' ? 'consolidated' : 'non_consolidated') : null,
    eps: eps?.value ?? null,
    epsElement: eps?.element ?? null,
    dps: dps?.value ?? null,
    sales: sales?.value ?? null,
    operatingProfit: op?.value ?? null,
    netIncome: ni?.value ?? null,
  }
}

const REVISION_TITLE = /(業績予想|配当予想|予想値?).*(修正|変更)|(修正|変更).*(業績予想|配当予想)/

export function isTanshinTitle(title: string): boolean {
  return /決算短信/.test(title) && !/訂正/.test(title)
}
export function isRevisionNoticeTitle(title: string): boolean {
  return REVISION_TITLE.test(title) && !/決算短信/.test(title)
}
