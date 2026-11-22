import type { Bar } from './technical.ts'

/**
 * 決算短信の1株予想(EPS/DPS)は、開示時点の株数基準。開示後に株式分割・併合があると、
 * 現在の終値と比べて桁がずれる。日足の adj_close ÷ close(分割調整係数)が開示日から変わっていないか確認する。
 */
export function shareBasisUnchanged(barsAsc: readonly Bar[], disclosedJstDate: string): { ok: boolean; reason: string | null } {
  const ratio = (b: Bar) => (b.adjClose != null && b.close != null && b.close > 0 && b.adjClose > 0 ? b.adjClose / b.close : null)
  const last = barsAsc.at(-1)
  const lastRatio = last ? ratio(last) : null
  if (!last || lastRatio == null) return { ok: false, reason: '株価の調整係数を確認できないため、1株予想の株数基準を検証できません' }
  let at: Bar | null = null
  for (const b of barsAsc) {
    if (b.date <= disclosedJstDate) at = b
    else break
  }
  const atRatio = at ? ratio(at) : null
  if (!at || atRatio == null) return { ok: false, reason: `決算短信の開示日(${disclosedJstDate})が取得済みの日足の範囲外のため、1株予想の株数基準を検証できません` }
  if (Math.abs(lastRatio / atRatio - 1) > 1e-3) {
    return { ok: false, reason: `決算短信の開示後(${disclosedJstDate}以降)に株式分割・併合があり、1株予想の株数基準が現在の株価と異なります` }
  }
  return { ok: true, reason: null }
}
