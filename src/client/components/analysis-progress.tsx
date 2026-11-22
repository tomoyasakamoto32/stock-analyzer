import { useEffect, useState } from 'hono/jsx'

/** 経過時間と、切断しても結果が保存される旨を表示する */
export function AnalysisProgress(props: { phase: 'running' | 'recovering' }) {
  const [sec, setSec] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setSec((s) => s + 1), 1000)
    return () => clearInterval(t)
  }, [])
  return (
    <div class="progress" role="status" aria-live="polite">
      <span class="spinner" aria-hidden="true" />
      <span>
        {props.phase === 'running' ? '分析中…' : '接続が途切れました。実行状況を確認しています…'} 経過 {sec} 秒
      </span>
      <p class="muted small">通常は数十秒〜数分かかります。完了するとレポートへ移動します。</p>
    </div>
  )
}
