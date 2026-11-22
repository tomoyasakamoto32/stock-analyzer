import { Layout } from '../components/layout.tsx'
import { Badge, STANCE_LABEL } from '../components/ui.tsx'
import { RunsTable, ModeNotice, type RunInsight } from './dashboard.tsx'
import type { DocRef, RunSummary } from '../../shared/types.ts'
import { DocumentList } from './documents.tsx'
import type { AppConfig } from '../env.ts'
import type { Overall } from '../../shared/types.ts'
import { formatJst } from '../util/time.ts'

export function StockDetail(props: {
  code: string
  stock: { name: string; market: string | null; sector: string | null; updated_at: string } | null
  runs: RunSummary[]
  insights: Map<string, RunInsight>
  documents: DocRef[]
  latestOverall: Overall | null
  latestRunId: string | null
  cfg: AppConfig
}) {
  const { stock } = props
  return (
    <Layout title={`${props.code} ${stock?.name ?? ''}`}>
      <h1>
        {props.code} {stock?.name ?? ''}
      </h1>
      {stock ? (
        <p class="muted">
          {stock.market ?? '市場不明'} / {stock.sector ?? '業種不明'}（更新: {formatJst(stock.updated_at)}）
        </p>
      ) : (
        <p class="muted">この銘柄の完了済み分析はまだありません。</p>
      )}
      <ModeNotice cfg={props.cfg} />
      <section class="card">
        <h2>再分析</h2>
        <div id="analysis-controls" data-code={props.code} data-daily-limit={props.cfg.dailyLimit == null ? undefined : String(props.cfg.dailyLimit)} data-web-search={props.cfg.webSearchEnabled ? '1' : undefined}>
          <p class="muted">読み込み中…(JavaScriptが必要です)</p>
        </div>
        <p class="muted small">再分析は新しいレポートとして保存されます(過去分は上書きされません)。</p>
      </section>
      {props.latestOverall && props.latestRunId && (
        <section class="card">
          <h2>最新レポートの総評</h2>
          <p>
            <Badge kind={props.latestOverall.stance}>{STANCE_LABEL[props.latestOverall.stance] ?? props.latestOverall.stance}</Badge>{' '}
            <a href={`/reports/${props.latestRunId}`}>レポートを開く</a>
          </p>
          <p>{props.latestOverall.summary}</p>
        </section>
      )}
      <DocumentList docs={props.documents} heading="最新レポートで使った開示書類" />
      <h2>分析履歴</h2>
      <RunsTable runs={props.runs} insights={props.insights} />
      {props.runs.length >= 30 && (
        <p class="small">
          <a href={`/reports?code=${props.code}`}>この銘柄の全履歴を見る →</a>
        </p>
      )}
    </Layout>
  )
}
