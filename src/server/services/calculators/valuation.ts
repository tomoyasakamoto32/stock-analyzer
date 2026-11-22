export const TARGET_YIELDS_PCT = [3, 3.5, 4, 4.5, 5] as const

/** 株価 ÷ EPS。EPS が null/0 以下なら null。 */
export function per(price: number | null, eps: number | null): number | null {
  if (price == null || eps == null || !(eps > 0)) return null
  return price / eps
}
export function pbr(price: number | null, bps: number | null): number | null {
  if (price == null || bps == null || !(bps > 0)) return null
  return price / bps
}
export function dividendYieldPct(dps: number | null, price: number | null): number | null {
  if (dps == null || price == null || !(price > 0)) return null
  return (dps / price) * 100
}
/** 年間DPS ÷ 目標利回り(小数)。DPS が正でなければ null。 */
export function yieldPrices(dps: number | null) {
  return TARGET_YIELDS_PCT.map((t) => ({
    targetYieldPct: t,
    price: dps != null && dps > 0 ? dps / (t / 100) : null,
  }))
}
export function netCash(cash: number | null, debt: number | null): number | null {
  if (cash == null || debt == null) return null
  return cash - debt
}
export function netCashRatioPct(nc: number | null, marketCap: number | null): number | null {
  if (nc == null || marketCap == null || !(marketCap > 0)) return null
  return (nc / marketCap) * 100
}
/** (時価総額 − ネットキャッシュ) ÷ 年間純利益。純利益が非正、またはEV非正なら null。 */
export function cashAdjustedPer(marketCap: number | null, nc: number | null, netIncome: number | null): number | null {
  if (marketCap == null || nc == null || netIncome == null || !(netIncome > 0)) return null
  const ev = marketCap - nc
  return ev > 0 ? ev / netIncome : null
}
export function payoutRatioPct(dps: number | null, eps: number | null): number | null {
  if (dps == null || eps == null || !(eps > 0)) return null
  return (dps / eps) * 100
}
export function range(values: readonly (number | null)[]): { min: number; max: number; avg: number } | null {
  const v = values.filter((x): x is number => x != null && Number.isFinite(x))
  if (v.length === 0) return null
  return { min: Math.min(...v), max: Math.max(...v), avg: v.reduce((a, b) => a + b, 0) / v.length }
}
