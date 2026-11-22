import { INVESTMENT_STYLES, type InvestmentStyle } from './types.ts'

/** 銘柄コードを trim/uppercase して 4桁英数字を検証する。不正なら null。 */
export function normalizeStockCode(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const code = input.trim().toUpperCase()
  return /^[0-9A-Z]{4}$/.test(code) ? code : null
}

export function parseInvestmentStyle(input: unknown): InvestmentStyle | null {
  return typeof input === 'string' && (INVESTMENT_STYLES as readonly string[]).includes(input)
    ? (input as InvestmentStyle)
    : null
}

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
}
