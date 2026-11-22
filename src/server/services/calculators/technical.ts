export type Bar = {
  date: string // YYYY-MM-DD
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  adjClose: number | null
  volume: number | null
}

export type TechnicalMetrics = {
  asOf: string | null
  barCount: number
  close: number | null
  adjClose: number | null
  sma5: number | null
  sma25: number | null
  sma75: number | null
  sma200: number | null
  rsi14: number | null
  macd: number | null
  macdSignal: number | null
  macdHist: number | null
  volume: number | null
  volumeAvg20: number | null
  volumeRatio: number | null
  high20: number | null
  low20: number | null
  high60: number | null
  low60: number | null
  weeklySma13: number | null
  weeklySma26: number | null
  weeklyCloses: number
  /** 25日線乖離率(%) */
  deviation25Pct: number | null
}

/** 末尾 n 件の単純平均。n 件に満たなければ null。 */
export function sma(values: readonly number[], n: number): number | null {
  if (n <= 0 || values.length < n) return null
  let s = 0
  for (let i = values.length - n; i < values.length; i++) s += values[i]!
  return s / n
}

/** EMA 系列(初期値は先頭 n 件の SMA)。n 件に満たなければ空。 */
export function emaSeries(values: readonly number[], n: number): number[] {
  if (values.length < n) return []
  const k = 2 / (n + 1)
  let prev = values.slice(0, n).reduce((a, b) => a + b, 0) / n
  const out = [prev]
  for (let i = n; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k)
    out.push(prev)
  }
  return out
}

/** Wilder 方式 RSI。n+1 件未満なら null。 */
export function rsiWilder(closes: readonly number[], n = 14): number | null {
  if (closes.length < n + 1) return null
  let gain = 0
  let loss = 0
  for (let i = 1; i <= n; i++) {
    const d = closes[i]! - closes[i - 1]!
    if (d >= 0) gain += d
    else loss -= d
  }
  let avgGain = gain / n
  let avgLoss = loss / n
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!
    avgGain = (avgGain * (n - 1) + (d > 0 ? d : 0)) / n
    avgLoss = (avgLoss * (n - 1) + (d < 0 ? -d : 0)) / n
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100
  return 100 - 100 / (1 + avgGain / avgLoss)
}

/** MACD(12,26,9)。EMA26 が成立し、かつシグナルが 9 件成立する場合のみ値を返す。 */
export function macd(closes: readonly number[], fast = 12, slow = 26, signalN = 9) {
  const empty = { macd: null, signal: null, hist: null } as const
  const ef = emaSeries(closes, fast)
  const es = emaSeries(closes, slow)
  if (es.length === 0) return empty
  // ef[i] は closes の index fast-1+i に対応、es[j] は slow-1+j。揃える。
  const offset = slow - fast
  const line: number[] = es.map((v, j) => ef[j + offset]! - v)
  const sig = emaSeries(line, signalN)
  if (sig.length === 0) return empty
  const m = line[line.length - 1]!
  const s = sig[sig.length - 1]!
  return { macd: m, signal: s, hist: m - s }
}

function maxOf(values: readonly number[], n: number): number | null {
  if (values.length < n) return null
  return Math.max(...values.slice(values.length - n))
}
function minOf(values: readonly number[], n: number): number | null {
  if (values.length < n) return null
  return Math.min(...values.slice(values.length - n))
}

/** 週(月曜始まり)キー。休場日は埋めず、取引のあった日のみ使う。 */
function weekKey(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const t = Date.UTC(y, m - 1, d)
  const dow = new Date(t).getUTCDay() // 0=Sun
  const mondayOffset = (dow + 6) % 7
  return new Date(t - mondayOffset * 86400000).toISOString().slice(0, 10)
}

export function weeklyCloses(bars: readonly Bar[]): number[] {
  const byWeek = new Map<string, number>()
  for (const b of bars) {
    if (b.adjClose == null) continue
    byWeek.set(weekKey(b.date), b.adjClose) // bars は昇順なので最後の値=週末終値
  }
  return [...byWeek.values()]
}

/** bars は日付昇順。調整後終値(adjClose)で指標を計算する。 */
export function computeTechnical(barsAsc: readonly Bar[]): TechnicalMetrics {
  const valid = barsAsc.filter((b) => b.adjClose != null)
  const closes = valid.map((b) => b.adjClose as number)
  const last = barsAsc[barsAsc.length - 1]
  const vols = barsAsc.map((b) => b.volume).filter((v): v is number => v != null)
  const volumeAvg20 = barsAsc.length >= 20 && vols.length >= 20 ? sma(vols.slice(-20), 20) : null
  const lastVol = last?.volume ?? null
  const m = macd(closes)
  const highs = barsAsc.map((b) => b.high ?? b.adjClose).filter((v): v is number => v != null)
  const lows = barsAsc.map((b) => b.low ?? b.adjClose).filter((v): v is number => v != null)
  const wc = weeklyCloses(valid)
  const sma25 = sma(closes, 25)
  const lastAdj = closes.length ? closes[closes.length - 1]! : null
  return {
    asOf: last?.date ?? null,
    barCount: barsAsc.length,
    close: last?.close ?? null,
    adjClose: lastAdj,
    sma5: sma(closes, 5),
    sma25,
    sma75: sma(closes, 75),
    sma200: sma(closes, 200),
    rsi14: rsiWilder(closes, 14),
    macd: m.macd,
    macdSignal: m.signal,
    macdHist: m.hist,
    volume: lastVol,
    volumeAvg20,
    volumeRatio: lastVol != null && volumeAvg20 != null && volumeAvg20 > 0 ? lastVol / volumeAvg20 : null,
    high20: maxOf(highs, 20),
    low20: minOf(lows, 20),
    high60: maxOf(highs, 60),
    low60: minOf(lows, 60),
    weeklySma13: sma(wc, 13),
    weeklySma26: sma(wc, 26),
    weeklyCloses: wc.length,
    deviation25Pct: lastAdj != null && sma25 != null && sma25 !== 0 ? ((lastAdj - sma25) / sma25) * 100 : null,
  }
}
