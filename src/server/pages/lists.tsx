import { Layout } from '../components/layout.tsx'
import { Badge, STANCE_LABEL } from '../components/ui.tsx'
import { RunsTable, type RunInsight } from './dashboard.tsx'
import type { RunSummary } from '../../shared/types.ts'
import type { StockSummary } from '../db/repositories/runs.ts'
import { fmtNum } from '../util/format.ts'
import { formatJst } from '../util/time.ts'

export function ReportsPage(props: {
  runs: RunSummary[]
  names: Map<string, string>
  insights: Map<string, RunInsight>
  code: string | null
  nextBefore: string | null
}) {
  const q = (before: string) => `?${props.code ? `code=${encodeURIComponent(props.code)}&` : ''}before=${encodeURIComponent(before)}`
  return (
    <Layout title={props.code ? `${props.code} のレポート履歴` : 'レポート履歴'}>
      <h1>レポート履歴{props.code ? `: ${props.code}${props.names.get(props.code) ? ` ${props.names.get(props.code)}` : ''}` : ''}</h1>
      {props.code && (
        <p class="small">
          <a href={`/stocks/${props.code}`}>← {props.code} の銘柄ページ</a> / <a href="/reports">すべての銘柄</a>
        </p>
      )}
      <RunsTable runs={props.runs} names={props.names} insights={props.insights} />
      <div class="pager">
        {props.nextBefore && <a href={q(props.nextBefore)}>さらに古いレポート →</a>}
        {props.runs.length > 0 && !props.nextBefore && <span class="muted">これ以上古いレポートはありません</span>}
      </div>
    </Layout>
  )
}

export function StocksPage(props: {
  master: { count: number; updatedAt: string | null }
  canRefreshMaster: boolean
  stocks: StockSummary[]
  insights: Map<string, RunInsight & { runId: string }>
  nextBefore: string | null
}) {
  return (
    <Layout title="銘柄一覧">
      <h1>分析した銘柄</h1>
      <section class="card">
        <h2>銘柄マスタ(名前での候補検索用)</h2>
        <p class="small">
          {props.master.count > 0 ? `${props.master.count} 銘柄(最終更新 ${formatJst(props.master.updatedAt)})` : '未取得です。取り込むと、分析の入力欄で銘柄名から候補を選べます。'}
        </p>
        {props.canRefreshMaster ? (
          <div id="master-refresh">
            <p class="muted">読み込み中…(JavaScriptが必要です)</p>
          </div>
        ) : (
          <p class="muted small">銘柄マスタの保存は、環境変数 ALLOW_PERSIST_SOURCE_DATA=true(利用条件の確認後)の時に使えます。</p>
        )}
        <p class="muted small">全上場銘柄を約9リクエストで取り込みます(データ提供元の1日の上限を消費します)。以後の候補検索は提供元へ問い合わせません。</p>
      </section>
      <p class="muted small">最新の分析が新しい順です。結論と適正株価の目安は、各銘柄の完了済みの最新レポートのものです。</p>
      {props.stocks.length === 0 ? (
        <p class="muted">まだ分析した銘柄がありません。</p>
      ) : (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>銘柄</th>
                <th>最新の分析</th>
                <th>分析回数</th>
                <th>結論</th>
                <th>適正株価の目安</th>
              </tr>
            </thead>
            <tbody>
              {props.stocks.map((s) => {
                const ins = props.insights.get(s.code)
                return (
                  <tr>
                    <td>
                      <a href={`/stocks/${s.code}`}>{s.code}</a> {s.name ?? ''}
                    </td>
                    <td>{ins ? <a href={`/reports/${ins.runId}`}>{formatJst(s.lastRequestedAt)}</a> : formatJst(s.lastRequestedAt)}</td>
                    <td class="num">{s.runCount}</td>
                    <td>{ins ? <Badge kind={ins.stance}>{STANCE_LABEL[ins.stance] ?? ins.stance}</Badge> : '—'}</td>
                    <td class="num">{ins?.fairLow != null ? `${fmtNum(ins.fairLow, 0)}〜${fmtNum(ins.fairHigh, 0)}円` : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <div class="pager">{props.nextBefore && <a href={`?before=${encodeURIComponent(props.nextBefore)}`}>さらに古い銘柄 →</a>}</div>
    </Layout>
  )
}
