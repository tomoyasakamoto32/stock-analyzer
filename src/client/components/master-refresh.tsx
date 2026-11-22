import { useState } from 'hono/jsx'

type Page = { fetched: number; nextCursor: string | null; total: number }
const MAX_PAGES = 30 // 無限ループ防止(全上場銘柄は約9ページ)

/** 銘柄マスタを1ページずつ取り込む(各リクエストで IRBANK へ1回)。 */
export function MasterRefresh() {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function run() {
    setBusy(true)
    setError(null)
    let cursor: string | null = null
    let total = 0
    try {
      for (let i = 0; i < MAX_PAGES; i++) {
        const res: Response = await fetch('/api/stocks/master/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cursor ? { cursor } : {}),
        })
        if (!res.ok) {
          const b = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
          throw new Error(b?.error?.message ?? `更新に失敗しました(HTTP ${res.status})`)
        }
        const page = (await res.json()) as Page
        total = page.total
        setMsg(`取り込み中… ${page.total} 銘柄(${i + 1}ページ目)`)
        cursor = page.nextCursor
        if (!cursor) break
      }
      setMsg(`更新しました(${total} 銘柄)`)
      setTimeout(() => location.reload(), 800)
    } catch (e) {
      setError(e instanceof Error ? e.message : '不明なエラー')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="controls">
      <button type="button" disabled={busy} onClick={run}>
        銘柄マスタを更新
      </button>
      {msg && <span role="status">{msg}</span>}
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
