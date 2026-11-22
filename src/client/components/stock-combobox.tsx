import { useEffect, useRef, useState } from 'hono/jsx'
import type { Suggestion } from '../../shared/search.ts'

type Props = {
  text: string
  disabled: boolean
  onText: (t: string) => void
  onSelect: (s: Suggestion) => void
  onSuggestions: (list: Suggestion[]) => void
}

const DEBOUNCE_MS = 200

/**
 * 銘柄名・コードのオートコンプリート(ARIA combobox)。候補は自アプリのAPI(/api/stocks/search)から取得する。
 * キー操作: ↑↓で選択、Enterで確定、Escで閉じる。日本語入力の変換中(IME)のEnterは確定に使わない。
 */
export function StockCombobox(props: Props) {
  const [items, setItems] = useState<Suggestion[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [masterReady, setMasterReady] = useState(true)
  const seq = useRef(0)
  const listId = 'stock-suggestions'

  useEffect(() => {
    const q = props.text.trim()
    if (q === '') {
      setItems([])
      props.onSuggestions([])
      setOpen(false)
      return
    }
    const my = ++seq.current
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/stocks/search?q=${encodeURIComponent(q)}`)
        if (!res.ok || my !== seq.current) return
        const body = (await res.json()) as { suggestions: Suggestion[]; masterReady: boolean }
        if (my !== seq.current) return // より新しい入力の結果だけ採用する
        setItems(body.suggestions)
        props.onSuggestions(body.suggestions)
        setMasterReady(body.masterReady)
        setActive(-1)
        setOpen(body.suggestions.length > 0)
      } catch {
        // 候補が出せなくても、4桁コードの直接入力は使える
      }
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [props.text])

  function choose(s: Suggestion) {
    seq.current++ // 選択後に遅れて届く候補で上書きしない
    props.onSelect(s)
    setOpen(false)
    setItems([])
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.isComposing) return
    if (e.key === 'ArrowDown' && items.length > 0) {
      e.preventDefault()
      setOpen(true)
      setActive((a) => (a + 1) % items.length)
    } else if (e.key === 'ArrowUp' && items.length > 0) {
      e.preventDefault()
      setOpen(true)
      setActive((a) => (a <= 0 ? items.length - 1 : a - 1))
    } else if (e.key === 'Enter' && open && active >= 0) {
      e.preventDefault() // フォーム送信ではなく候補の確定にする
      choose(items[active]!)
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div class="combobox">
      <input
        type="text"
        name="code"
        value={props.text}
        disabled={props.disabled}
        autocomplete="off"
        placeholder="7203 または トヨタ"
        role="combobox"
        aria-expanded={open ? 'true' : 'false'}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        onInput={(e) => props.onText((e.target as HTMLInputElement).value)}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onFocus={() => items.length > 0 && setOpen(true)}
      />
      {open && (
        <ul id={listId} role="listbox" class="suggestions">
          {items.map((s, i) => (
            <li
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active ? 'true' : 'false'}
              class={i === active ? 'active' : ''}
              onMouseDown={(e: MouseEvent) => {
                e.preventDefault() // 入力欄のblurより先に確定する
                choose(s)
              }}
            >
              <strong>{s.code}</strong> {s.name}
              <span class="muted small"> {[s.market, s.industry].filter(Boolean).join(' / ')}</span>
            </li>
          ))}
        </ul>
      )}
      {!masterReady && props.text.trim() !== '' && (
        <p class="muted small">
          銘柄マスタが未取得のため、分析済みの銘柄だけが候補に出ます。4桁コードは直接入力できます。<a href="/stocks">銘柄一覧</a>で銘柄マスタを更新すると、銘柄名から候補を選べます。
        </p>
      )}
    </div>
  )
}
