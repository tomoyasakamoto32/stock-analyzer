export type WeeklyMargin = {
  reportDate: string
  buyBalance: number | null
  sellBalance: number | null
  /** APIが返す信用倍率(買い残合計÷売り残合計) */
  marginRatio: number | null
  buyChange: number | null
  sellChange: number | null
}
export type JsfDay = {
  date: string
  loanBalance: number | null
  stockLoanBalance: number | null
  netBalance: number | null
  lendingRatio: number | null
}
export type JsfReverse = { date: string; feeTotal: number | null; feeDays: number | null }

/** 信用倍率。売り残 0/null なら null と理由を返す。 */
export function marginRatio(buy: number | null, sell: number | null): { value: number | null; reason: string | null } {
  if (buy == null || sell == null) return { value: null, reason: '残高が取得できません' }
  if (sell === 0) return { value: null, reason: '売り残が0のため算出不可' }
  return { value: buy / sell, reason: null }
}
/** 買い残 ÷ 日次平均出来高(日数換算)。 */
export function buyBalanceDays(buy: number | null, avgVolume: number | null): number | null {
  if (buy == null || avgVolume == null || !(avgVolume > 0)) return null
  return buy / avgVolume
}
export function weekOverWeek(cur: number | null, prev: number | null): number | null {
  if (cur == null || prev == null) return null
  return cur - prev
}
