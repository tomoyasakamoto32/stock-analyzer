import { Layout } from '../components/layout.tsx'
import { Badge, STANCE_LABEL, STATUS_LABEL } from '../components/ui.tsx'
import { fmtNum } from '../util/format.ts'
import { STYLE_LABELS, type RunSummary } from '../../shared/types.ts'
import { formatJst } from '../util/time.ts'
import type { AppConfig } from '../env.ts'

export type RunInsight = { stance: string; fairLow: number | null; fairHigh: number | null }

export function RunsTable(props: { runs: RunSummary[]; names?: Map<string, string>; insights?: Map<string, RunInsight> }) {
  if (props.runs.length === 0) return <p class="muted">まだ分析履歴がありません。</p>
  return (
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>実行日時</th>
            <th>銘柄</th>
            <th>スタイル</th>
            <th>状態</th>
            {props.insights && <th>結論</th>}
            {props.insights && <th>適正株価の目安</th>}
            <th>AI</th>
          </tr>
        </thead>
        <tbody>
          {props.runs.map((r) => (
            <tr>
              <td>
                <a href={`/reports/${r.id}`}>{formatJst(r.requestedAt)}</a>
              </td>
              <td>
                <a href={`/stocks/${r.stockCode}`}>{r.stockCode}</a>
                {props.names?.get(r.stockCode) ? ` ${props.names.get(r.stockCode)}` : ''}
              </td>
              <td>{STYLE_LABELS[r.investmentStyle]}</td>
              <td>
                <Badge kind={r.status}>{STATUS_LABEL[r.status]}</Badge>
              </td>
              {props.insights && (
                <td>
                  {props.insights.get(r.id) ? (
                    <Badge kind={props.insights.get(r.id)!.stance}>{STANCE_LABEL[props.insights.get(r.id)!.stance] ?? props.insights.get(r.id)!.stance}</Badge>
                  ) : (
                    '—'
                  )}
                </td>
              )}
              {props.insights && (
                <td class="num">
                  {props.insights.get(r.id)?.fairLow != null
                    ? `${fmtNum(props.insights.get(r.id)!.fairLow, 0)}〜${fmtNum(props.insights.get(r.id)!.fairHigh, 0)}円`
                    : '—'}
                </td>
              )}
              <td>{r.aiMode === 'real' ? r.model : 'モック'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function ModeNotice(props: { cfg: AppConfig }) {
  const { cfg } = props
  if (cfg.dataSource === 'mock' || cfg.aiMode === 'mock') {
    return (
      <p class="notice">
        現在のモード: データ={cfg.dataSource === 'mock' ? 'モック(架空データ)' : 'IRBANK'} / AI={cfg.aiMode === 'mock' ? 'モック(外部送信なし)' : 'OpenAI'}。
        {cfg.dataSource === 'irbank' && cfg.aiMode === 'mock' ? ' 実データの分析にはAI送信の許可設定が必要です。' : ''}
      </p>
    )
  }
  return null
}

export function Dashboard(props: { runs: RunSummary[]; names: Map<string, string>; insights: Map<string, RunInsight>; cfg: AppConfig; todayCount: number }) {
  return (
    <Layout title="ホーム">
      <h1>銘柄を分析する</h1>
      <ModeNotice cfg={props.cfg} />
      <section class="card">
        <div id="analysis-controls" data-daily-limit={props.cfg.dailyLimit == null ? undefined : String(props.cfg.dailyLimit)} data-web-search={props.cfg.webSearchEnabled ? '1' : undefined}>
          <p class="muted">読み込み中…(JavaScriptが必要です)</p>
        </div>
        <p class="muted small">
          本日の実行: {props.todayCount}{props.cfg.dailyLimit == null ? '' : ` / ${props.cfg.dailyLimit}`} 回{props.cfg.dailyLimit == null ? '(回数の上限なし)' : ''}。1回の分析は数十秒〜数分かかります。完了までページを閉じないでください。
        </p>
      </section>
      <h2>最近のレポート</h2>
      <RunsTable runs={props.runs} names={props.names} insights={props.insights} />
      <p class="small">
        <a href="/reports">すべてのレポート履歴 →</a> / <a href="/stocks">分析した銘柄の一覧 →</a>
      </p>
    </Layout>
  )
}
