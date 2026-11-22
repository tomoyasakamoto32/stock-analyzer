import { Layout } from '../components/layout.tsx'
import { StringList } from '../components/ui.tsx'
import { KeyMetrics, YieldTable } from './report-detail.tsx'
import type { Snapshot } from '../../shared/types.ts'

/** AI分析なし・DB保存なしで、取得した主要データと利回り別株価だけを表示する。 */
export function DataOnlyPage(props: { snapshot: Snapshot; mock: boolean }) {
  const s = props.snapshot
  const close = s.evidence.find((e) => e.id === 'price.close')
  const closePrice = typeof close?.value === 'number' ? close.value : null
  return (
    <Layout title={`${s.stock.code} ${s.stock.name} 主要データ`}>
      <p class="small">
        <a href={`/stocks/${s.stock.code}`}>← {s.stock.code} の銘柄ページ</a>
      </p>
      <h1>
        {s.stock.code} {s.stock.name}
      </h1>
      <p class="muted">{[s.stock.market, s.stock.sector].filter(Boolean).join(' / ')}</p>
      <p class="notice">
        主要データだけの表示です(AI分析なし・結果は保存されません)。ページを開くたびにデータ提供元へ最新データを取りに行きます。
        {props.mock ? ' これは架空のモックデータです。投資判断に使用しないでください。' : ''}
      </p>
      <KeyMetrics snapshot={s} />
      <section class="card">
        <YieldTable actual={s.yieldPrices} forecast={s.yieldPricesForecast ?? []} close={closePrice} />
      </section>
      {s.missingData.length > 0 && (
        <section class="card">
          <h2>取得できなかった・未評価の項目</h2>
          <StringList items={s.missingData} />
        </section>
      )}
      <p class="small">
        <a href={`/stocks/${s.stock.code}`}>AI分析を実行する・履歴を見る →</a>
      </p>
    </Layout>
  )
}
