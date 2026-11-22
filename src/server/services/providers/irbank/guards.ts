import { ProviderError } from '../types.ts'

export type Rec = Record<string, unknown>

export function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
export function bad(what: string): never {
  throw new ProviderError('invalid_response', `IRBANK応答の形式が不正: ${what}`)
}
export function asRec(v: unknown, what: string): Rec {
  return isRec(v) ? v : bad(what)
}
export function asArr(v: unknown, what: string): unknown[] {
  return Array.isArray(v) ? v : bad(what)
}
/** 数値または null。文字列や NaN は不正として扱う(欠損 null と 0 を区別する)。 */
export function numOrNull(v: unknown, what: string): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number' && Number.isFinite(v)) return v
  return bad(`${what} が数値でない`)
}
export function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}
export function str(v: unknown, what: string): string {
  return typeof v === 'string' ? v : bad(what)
}

export type FieldUnits = Map<string, string>
/** fields[] から key→unit を作る */
export function fieldUnits(body: Rec): FieldUnits {
  const m: FieldUnits = new Map()
  if (Array.isArray(body.fields)) {
    for (const f of body.fields) if (isRec(f) && typeof f.key === 'string' && typeof f.unit === 'string') m.set(f.key, f.unit)
  }
  return m
}
/** 単位が想定と違えば失敗させる(円と百万円の取り違え防止)。key が無ければ検査しない。 */
export function assertUnit(units: FieldUnits, key: string, expected: string): void {
  const u = units.get(key)
  if (u !== undefined && u !== expected) {
    throw new ProviderError('invalid_response', `単位不一致: ${key} は ${expected} を想定したが ${u}`)
  }
}
export function sourceLabel(body: Rec): string {
  const a = body.attribution
  return isRec(a) && typeof a.source_label === 'string' ? a.source_label : 'IRBANK'
}

/** fields[] から key → "ラベル[単位] 説明" を作る(API側の定義を画面・AI入力に引き継ぐ) */
export function fieldDefs(body: Rec): Record<string, string> {
  const out: Record<string, string> = {}
  if (Array.isArray(body.fields)) {
    for (const f of body.fields) {
      if (!isRec(f) || typeof f.key !== 'string') continue
      const label = typeof f.label === 'string' ? f.label : f.key
      const unit = typeof f.unit === 'string' ? `[${f.unit}]` : ''
      const note = typeof f.note === 'string' && f.note ? ` ${f.note}` : ''
      out[f.key] = `${label}${unit}${note}`
    }
  }
  return out
}

/**
 * 比率系の値を % に正規化する。unit が percent ならそのまま、ratio なら ×100。
 * 単位が不明/想定外の場合は誤った桁にしないよう null を返す。
 */
export function toPercent(v: number | null, key: string, units: FieldUnits): number | null {
  if (v == null) return null
  const u = units.get(key)
  if (u === 'percent') return v
  if (u === 'ratio') return v * 100
  return null
}
