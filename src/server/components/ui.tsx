import type { Child } from 'hono/jsx'
import type { Finding, Outlook, RunStatus } from '../../shared/types.ts'

export const OUTLOOK_LABEL: Record<Outlook, string> = {
  positive: '強気寄り',
  neutral: '中立',
  negative: '弱気寄り',
  insufficient_data: 'データ不足',
}

export const STATUS_LABEL: Record<RunStatus, string> = {
  collecting: 'データ収集中',
  analyzing: 'AI分析中',
  completed: '完了',
  failed: '失敗',
}

export const STANCE_LABEL: Record<string, string> = {
  consider: '検討可',
  wait: '様子見',
  avoid: '見送り',
  insufficient_data: '判断材料不足',
}

export function Badge(props: { kind: string; children?: Child }) {
  return <span class={`badge badge-${props.kind}`}>{props.children}</span>
}

export function FindingList(props: { items: Finding[]; empty?: string }) {
  if (props.items.length === 0) return <p class="muted">{props.empty ?? '該当なし'}</p>
  return (
    <ul class="findings">
      {props.items.map((f) => (
        <li>
          {f.text}
          {f.evidenceIds.length > 0 && (
            <span class="evidence-tags">
              {f.evidenceIds.map((id) => (
                <code class="ev-tag">{id}</code>
              ))}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

export function StringList(props: { items: string[]; empty?: string }) {
  if (props.items.length === 0) return <p class="muted">{props.empty ?? '該当なし'}</p>
  return (
    <ul>
      {props.items.map((t) => (
        <li>{t}</li>
      ))}
    </ul>
  )
}
