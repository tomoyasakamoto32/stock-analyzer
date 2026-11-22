import { ProviderError } from '../types.ts'

const BASE = 'https://api.irbank.net/v1'
const TIMEOUT_MS = 15000
const MAX_RETRIES = 2
const MAX_BACKOFF_MS = 8000

export type FetchLike = typeof fetch
export type Sleep = (ms: number) => Promise<void>

/** 429 は Retry-After を尊重し上限付き、5xx は指数バックオフ。400/401/403/404 は再試行しない。 */
export class IrbankClient {
  private requestCount = 0
  private inflight = new Map<string, Promise<unknown>>()
  private apiKey: string
  private fetchImpl: FetchLike
  private sleep: Sleep
  // Workers の fetch は this が違うと Illegal invocation になるため、必ずラップして素の関数として呼ぶ
  constructor(apiKey: string, fetchImpl: FetchLike = (input, init) => fetch(input, init), sleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
    this.apiKey = apiKey
    this.fetchImpl = fetchImpl
    this.sleep = sleep
  }

  get requests(): number {
    return this.requestCount
  }

  /** 同一実行内の同一URLは重複取得しない */
  get<T = unknown>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(BASE + path)
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v))
    const key = url.toString()
    let p = this.inflight.get(key)
    if (!p) {
      p = this.request(key)
      this.inflight.set(key, p)
    }
    return p as Promise<T>
  }

  /**
   * 開示書類のPDF等を取得する。APIキーを付けて送るため、送信先はIRBANKのファイル配信URLに限定する
   * (一覧のレスポンスにあるURLでも、想定外のホストへキーを送らない)。
   */
  async getBinary(url: string, maxBytes: number): Promise<Uint8Array> {
    if (!url.startsWith('https://api.irbank.net/api/market-files/')) {
      throw new ProviderError('bad_request', '許可されていないファイルURLです')
    }
    const buf = await this.request(url, 'bytes')
    const bytes = buf as Uint8Array
    if (bytes.byteLength > maxBytes) throw new ProviderError('invalid_response', `ファイルが大きすぎます(${bytes.byteLength} > ${maxBytes} bytes)`)
    return bytes
  }

  private async request(url: string, mode: 'json' | 'bytes' = 'json'): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      this.requestCount++
      let res: Response
      try {
        res = await this.fetchImpl(url, {
          headers: { Authorization: `Bearer ${this.apiKey}`, Accept: mode === 'bytes' ? 'application/pdf' : 'application/json' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
      } catch (e) {
        if (attempt < MAX_RETRIES) {
          await this.sleep(Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS))
          continue
        }
        throw new ProviderError('unavailable', `IRBANKへの接続に失敗: ${(e as Error).name}: ${String((e as Error).message).slice(0, 120)}`)
      }
      if (res.ok) {
        if (mode === 'bytes') return new Uint8Array(await res.arrayBuffer())
        try {
          return await res.json()
        } catch {
          throw new ProviderError('invalid_response', 'IRBANK応答がJSONでない', res.status)
        }
      }
      const status = res.status
      if (status === 401) throw new ProviderError('unauthorized', 'IRBANK APIキーが無効です(401)', 401)
      if (status === 403) throw new ProviderError('forbidden', 'IRBANKの利用許可/規約同意が必要です(403)', 403)
      if (status === 404) throw new ProviderError('not_found', 'IRBANKに該当データがありません(404)', 404)
      if (status === 400) throw new ProviderError('bad_request', 'IRBANKへのリクエストが不正です(400)', 400)
      if (status === 429 || status >= 500) {
        if (attempt < MAX_RETRIES) {
          const ra = Number(res.headers.get('retry-after'))
          const wait = status === 429 && Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** attempt
          if (status === 429 && wait > MAX_BACKOFF_MS) {
            throw new ProviderError('rate_limited', `IRBANKのレート/日次上限(429)。${Math.ceil(wait / 1000)}秒後に再試行可`, 429)
          }
          await this.sleep(Math.min(wait, MAX_BACKOFF_MS))
          continue
        }
        throw new ProviderError(status === 429 ? 'rate_limited' : 'unavailable', `IRBANKエラー(${status})`, status)
      }
      throw new ProviderError('unavailable', `IRBANK予期しないステータス(${status})`, status)
    }
  }
}

/** 並列数を制限して実行する */
export async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length)
  let next = 0
  async function worker() {
    while (next < tasks.length) {
      const i = next++
      try {
        results[i] = { status: 'fulfilled', value: await tasks[i]!() }
      } catch (reason) {
        results[i] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
  return results
}
