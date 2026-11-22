export function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return v.toLocaleString('ja-JP', { maximumFractionDigits: digits, minimumFractionDigits: 0 })
}

/** 円建て金額を 兆/億 で表示。 */
export function fmtYenBig(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a >= 1e12) return `${(v / 1e12).toLocaleString('ja-JP', { maximumFractionDigits: 2 })}兆円`
  if (a >= 1e8) return `${(v / 1e8).toLocaleString('ja-JP', { maximumFractionDigits: 1 })}億円`
  return `${v.toLocaleString('ja-JP', { maximumFractionDigits: 0 })}円`
}

export function fmtEvidenceValue(v: number | string | null, unit: string): string {
  if (v == null) return '—'
  if (typeof v === 'string') return v
  if (unit === '円' && Math.abs(v) >= 1e6) return fmtYenBig(v)
  if (unit === '円') return `${fmtNum(v, 1)}円`
  if (unit === '株') return `${fmtNum(v, 0)}株`
  return `${fmtNum(v, 2)}${unit}`
}

export function fmtUsd(v: number | null | undefined): string {
  return v == null ? '—' : `$${v.toFixed(v < 0.1 ? 4 : 3)}`
}
