import type { Usage } from '../../../shared/types.ts'
import type { AiResult } from './openai.ts'

/** 推定費用(USD)。単価が未設定なら null。実請求額とは差が出うる(推定)。 */
export function estimateCost(usage: AiResult['usage'], cfg: { priceInputPerMtok: number | null; priceOutputPerMtok: number | null; priceTableVersion: string | null }): {
  usage: Usage
  costUsd: number | null
} {
  const { priceInputPerMtok: pin, priceOutputPerMtok: pout } = cfg
  let costUsd: number | null = null
  let basis = '単価未設定のため推定費用なし'
  if (pin != null && pout != null && usage.inputTokens != null && usage.outputTokens != null) {
    costUsd = (usage.inputTokens * pin + usage.outputTokens * pout) / 1_000_000
    basis = `入力 ${pin} / 出力 ${pout} USD per 1M tokens(環境設定値)。reasoningトークンは出力に含まれる前提`
  }
  return { usage: { ...usage, priceTableVersion: cfg.priceTableVersion, costBasis: basis }, costUsd }
}

/**
 * 月間費用の上限を設定しているのに単価が未設定だと、推定費用が null のまま合計0になり、上限が一度も効かない。
 * そのまま実行すると費用が際限なく増えうるため、設定の不備として実行を拒否する。
 */
export function costLimitProblem(cfg: { monthlyCostLimitUsd: number | null; priceInputPerMtok: number | null; priceOutputPerMtok: number | null }): string | null {
  if (cfg.monthlyCostLimitUsd == null) return null
  if (cfg.priceInputPerMtok == null || cfg.priceOutputPerMtok == null) {
    return 'MONTHLY_COST_LIMIT_USD を設定している場合は、費用を計算できるよう OPENAI_PRICE_INPUT_PER_MTOK と OPENAI_PRICE_OUTPUT_PER_MTOK も設定してください(未設定だと上限が効かないため実行を止めています)'
  }
  return null
}

/**
 * 1日の実行回数の上限。数値(1以上)なら上限あり。`unlimited` / `none` / `off` / `0` / 空 は無制限(null)。
 * 未指定(undefined)の場合は既定値を返す。不正な値は安全側(上限あり)に倒して既定値にする。
 */
export function parseDailyLimit(v: string | undefined, fallback: number | null = null): number | null {
  if (v === undefined) return fallback
  const t = v.trim().toLowerCase()
  if (t === '' || t === 'unlimited' || t === 'none' || t === 'off') return null
  const n = Number(t)
  if (!Number.isFinite(n) || n < 0) return fallback ?? 5
  return n === 0 ? null : Math.floor(n)
}
