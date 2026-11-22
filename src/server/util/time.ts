const JST_OFFSET_MS = 9 * 3600 * 1000

export function nowIso(): string {
  return new Date().toISOString()
}
/** JST の日付 (YYYY-MM-DD) */
export function jstDate(d: Date = new Date()): string {
  return new Date(d.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10)
}
export function jstMonth(d: Date = new Date()): string {
  return jstDate(d).slice(0, 7)
}
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}
/** JST の日付 00:00 を UTC ISO で返す(日次集計用) */
export function jstDayStartUtc(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00+09:00`)).toISOString()
}
/** 表示用: ISO(UTC) → "YYYY-MM-DD HH:mm JST" */
export function formatJst(iso: string | null): string {
  if (!iso) return '-'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '-'
  return new Date(t + JST_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 16) + ' JST'
}
