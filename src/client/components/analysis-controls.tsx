import { useRef, useState } from 'hono/jsx'
import { INVESTMENT_STYLES, STYLE_LABELS, type ApiError, type InvestmentStyle, type RunSummary } from '../../shared/types.ts'
import { resolveCode, type Suggestion } from '../../shared/search.ts'
import { StockCombobox } from './stock-combobox.tsx'
import { AnalysisProgress } from './analysis-progress.tsx'

type Phase = 'idle' | 'running' | 'recovering'
type CreateResponse = { run: RunSummary | null; duplicate?: boolean }

const POLL_MS = 3000
const POLL_MAX = 200 // 約10分

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function AnalysisControls(props: { fixedCode?: string; defaultStyle?: InvestmentStyle; webSearchAvailable?: boolean }) {
  const [text, setText] = useState(props.fixedCode ?? '')
  const [selected, setSelected] = useState<Suggestion | null>(null)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [style, setStyle] = useState<InvestmentStyle>(props.defaultStyle ?? 'mid_long')
  const [webSearch, setWebSearch] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  // 再分析のたびに新しいキーを発行する。同一キーの再送は二重課金されない(サーバー側で一意制約)。
  const keyRef = useRef<string | null>(null)

  async function post(normalized: string, key: string): Promise<Response> {
    return fetch('/api/analyses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ code: normalized, style, ...(props.webSearchAvailable && webSearch ? { webSearch: true } : {}) }),
    })
  }

  async function pollUntilDone(id: string): Promise<RunSummary | null> {
    for (let i = 0; i < POLL_MAX; i++) {
      await sleep(POLL_MS)
      try {
        const res = await fetch(`/api/analyses/${id}`)
        if (!res.ok) continue
        const body = (await res.json()) as { run: RunSummary }
        if (body.run.status === 'completed' || body.run.status === 'failed') return body.run
      } catch {
        // 一時的な通信失敗は継続
      }
    }
    return null
  }

  async function submit(e: Event) {
    e.preventDefault()
    if (phase !== 'idle') return
    // 銘柄名の入力でも、選択した候補・一意に絞れた候補から銘柄コードを決める
    const { code: normalized, reason } = props.fixedCode ? { code: props.fixedCode, reason: null } : resolveCode(text, selected, suggestions)
    if (!normalized) {
      setError(reason ?? '銘柄を特定できません')
      return
    }
    setError(null)
    setPhase('running')
    const key = (keyRef.current = crypto.randomUUID())
    try {
      let res: Response | null = null
      try {
        res = await post(normalized, key)
      } catch {
        // HTTP切断: 同じキーで再送して既存runを取得する(新たなAI課金は発生しない)
        setPhase('recovering')
        for (let i = 0; i < 5 && !res; i++) {
          await sleep(2000)
          try {
            res = await post(normalized, key)
          } catch {
            res = null
          }
        }
      }
      if (!res) throw new Error('サーバーに接続できませんでした。しばらくしてから再度お試しください')
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as ApiError | null
        throw new Error(body?.error.message ?? `エラーが発生しました(HTTP ${res.status})`)
      }
      const body = (await res.json()) as CreateResponse
      let run = body.run
      if (!run) throw new Error('応答が不正です')
      if (run.status === 'collecting' || run.status === 'analyzing') {
        setPhase('recovering')
        run = (await pollUntilDone(run.id)) ?? run
      }
      // 完了・失敗いずれもレポートページで結果/エラーを表示する
      location.href = `/reports/${run.id}`
    } catch (err) {
      setError(err instanceof Error ? err.message : '不明なエラー')
      setPhase('idle')
    }
  }

  // AI分析なしで主要データだけを見る(選択した銘柄・入力した銘柄コードで /data/:code へ移動)
  function showDataOnly() {
    const { code: normalized, reason } = props.fixedCode ? { code: props.fixedCode, reason: null } : resolveCode(text, selected, suggestions)
    if (!normalized) {
      setError(reason ?? '銘柄を特定できません')
      return
    }
    location.href = `/data/${normalized}`
  }

  const busy = phase !== 'idle'
  return (
    <form onSubmit={submit} class="controls" aria-busy={busy}>
      <label class="grow">
        銘柄コードまたは銘柄名
        {props.fixedCode ? (
          <input type="text" name="code" value={props.fixedCode} disabled />
        ) : (
          <StockCombobox
            text={text}
            disabled={busy}
            onText={(t) => {
              setText(t)
              setSelected(null)
            }}
            onSelect={(s) => {
              setSelected(s)
              setText(`${s.code} ${s.name}`)
            }}
            onSuggestions={setSuggestions}
          />
        )}
      </label>
      <label>
        投資スタイル
        <select name="style" disabled={busy} onChange={(e) => setStyle((e.target as HTMLSelectElement).value as InvestmentStyle)}>
          {INVESTMENT_STYLES.map((s) => (
            <option value={s} selected={s === style}>
              {STYLE_LABELS[s]}
            </option>
          ))}
        </select>
      </label>
      {props.webSearchAvailable && (
        <label class="check">
          <input type="checkbox" checked={webSearch} disabled={busy} onChange={(e) => setWebSearch((e.target as HTMLInputElement).checked)} />
          Web検索で業界動向・最新ニュースも調べる(外部情報・追加費用・時間が増えます)
        </label>
      )}
      <button type="submit" disabled={busy}>
        {props.fixedCode ? '再分析する' : '分析を開始'}
      </button>
      <button type="button" class="secondary" disabled={busy} onClick={showDataOnly}>
        データのみ表示(AI分析なし)
      </button>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      {busy && <AnalysisProgress phase={phase === 'recovering' ? 'recovering' : 'running'} />}
    </form>
  )
}
