import { useEffect, useState } from 'hono/jsx'

/**
 * 観点切替タブ。本文はサーバーがHTMLとして出力済みで、ここでは表示/非表示だけを切り替える
 * (本文を二重に描画しない)。JSが無効でも全観点が表示される。
 */
export function ReportTabs(props: { panels: string[]; labels: string[] }) {
  const [active, setActive] = useState(props.panels[0] ?? '')

  useEffect(() => {
    for (const id of props.panels) {
      const el = document.getElementById(`panel-${id}`)
      if (el) el.hidden = id !== active
    }
  }, [active])

  function onKeyDown(e: KeyboardEvent, i: number) {
    const n = props.panels.length
    let next = i
    if (e.key === 'ArrowRight') next = (i + 1) % n
    else if (e.key === 'ArrowLeft') next = (i - 1 + n) % n
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = n - 1
    else return
    e.preventDefault()
    setActive(props.panels[next]!)
    document.getElementById(`tab-${props.panels[next]}`)?.focus()
  }

  return (
    <nav aria-label="分析観点">
      <div role="tablist" class="tabs">
        {props.panels.map((id, i) => (
          <button
            type="button"
            role="tab"
            id={`tab-${id}`}
            aria-selected={id === active ? "true" : "false"}
            aria-controls={`panel-${id}`}
            tabIndex={id === active ? 0 : -1}
            class={id === active ? 'tab active' : 'tab'}
            onClick={() => setActive(id)}
            onKeyDown={(e: KeyboardEvent) => onKeyDown(e, i)}
          >
            {props.labels[i]}
          </button>
        ))}
      </div>
    </nav>
  )
}
