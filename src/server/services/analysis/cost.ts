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
