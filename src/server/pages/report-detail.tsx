import { Layout } from '../components/layout.tsx'
import { Badge, FindingList, OUTLOOK_LABEL, STANCE_LABEL, STATUS_LABEL, StringList } from '../components/ui.tsx'
import {
  SECTION_LABELS,
  SECTION_TYPES,
  STYLE_LABELS,
  type DocRef,
  type EntryTier,
  type Evidence,
  type Overall,
  type PriceRange,
  type RunSummary,
  type Section,
  type Snapshot,
  type Usage,
  type YieldPrice,
} from '../../shared/types.ts'
import { DocumentList } from './documents.tsx'
import { fmtEvidenceValue, fmtNum, fmtUsd } from '../util/format.ts'
import { formatJst } from '../util/time.ts'

export type ReportData = {
  run: RunSummary
  sections: Partial<Record<(typeof SECTION_TYPES)[number], Section | null>>
  overall: (Overall & { entry?: PriceRange | null; serverCalc?: { yieldPrices?: YieldPrice[]; yieldPricesForecast?: YieldPrice[] } }) | null
  snapshot: Snapshot | null
  usage: Usage | null
  missing: string[]
  sources: { dataset: string; sourceLabel: string; asOf: string | null }[]
  promptVersion: string | null
  schemaVersion: string | null
  calculatorVersion: string | null
  stockName: string | null
  webSearchAvailable: boolean
  documents: DocRef[]
}

function RangeRow(props: { label: string; r: PriceRange | null }) {
  return (
    <tr>
      <th>{props.label}</th>
      <td>
        {props.r ? (
          <>
            {fmtNum(props.r.low, 0)} 〜 {fmtNum(props.r.high, 0)} 円
            <div class="muted small">
              {props.r.rationale}
              {props.r.evidenceIds.map((id) => (
                <code class="ev-tag">{id}</code>
              ))}
            </div>
          </>
        ) : (
          <span class="muted">根拠不足のため提示なし</span>
        )}
      </td>
    </tr>
  )
}

/** 年間DPS ÷ 目標利回り の株価。YieldPrice は株価しか持たないため、DPS = 株価 × 利回り ÷ 100 で逆算して表示する。 */
function dpsOf(rows: YieldPrice[]): number | null {
  const r = rows.find((y) => y.price != null)
  return r && r.price != null ? Math.round(((r.price * r.targetYieldPct) / 100) * 100) / 100 : null
}

export function YieldTable(props: { actual: YieldPrice[]; forecast: YieldPrice[]; close: number | null }) {
  const { actual, forecast, close } = props
  if (actual.length === 0 && forecast.length === 0) return null
  const targets = (forecast.length > 0 ? forecast : actual).map((y) => y.targetYieldPct)
  const find = (rows: YieldPrice[], t: number) => rows.find((y) => y.targetYieldPct === t)?.price ?? null
  const dpsF = dpsOf(forecast)
  const dpsA = dpsOf(actual)
  const diff = (p: number | null) => (p == null || !close ? '—' : `${p >= close ? '+' : ''}${(((p - close) / close) * 100).toFixed(1)}%`)
  const cell = (p: number | null) => (
    <>
      <td class="num strong">{p == null ? '—' : `${fmtNum(p, 0)}円`}</td>
      <td class="num muted">{diff(p)}</td>
    </>
  )
  const curYield = (dps: number | null) => (dps != null && close ? `現在株価での利回り ${((dps / close) * 100).toFixed(2)}%` : '')
  return (
    <>
      <h3>利回り別株価(この株価で買うと配当利回りが何%になるか)</h3>
      <div class="table-wrap">
        <table class="yield-table">
          <thead>
            <tr>
              <th rowspan={2}>目標利回り</th>
              {forecast.length > 0 && <th colspan={2}>会社予想DPS {dpsF != null ? `${fmtNum(dpsF, 1)}円` : ''}</th>}
              {actual.length > 0 && <th colspan={2}>実績DPS {dpsA != null ? `${fmtNum(dpsA, 1)}円` : ''}</th>}
            </tr>
            <tr>
              {forecast.length > 0 && (
                <>
                  <th>株価</th>
                  <th>現在株価比</th>
                </>
              )}
              {actual.length > 0 && (
                <>
                  <th>株価</th>
                  <th>現在株価比</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {targets.map((t) => (
              <tr>
                <th class="num">{t}%</th>
                {forecast.length > 0 && cell(find(forecast, t))}
                {actual.length > 0 && cell(find(actual, t))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p class="muted small">
        株価 = 年間DPS ÷ 目標利回り(例: 予想DPS {dpsF != null ? `${fmtNum(dpsF, 1)}円` : '—'} ÷ 4% = {find(forecast, 4) != null ? `${fmtNum(find(forecast, 4), 0)}円` : '—'})。現在株価: {close ? `${fmtNum(close, 0)}円` : '—'}
        {dpsF != null ? `(予想DPSベース ${curYield(dpsF)})` : ''}
        {dpsA != null ? `(実績DPSベース ${curYield(dpsA)})` : ''}。会社予想DPSは最新の決算短信の通期予想、実績DPSは直近決算期の実績。DPSが取得できない/0以下の場合は表示されません。
      </p>
    </>
  )
}

function EntryTable(props: { tiers: EntryTier[]; close: number | null }) {
  if (props.tiers.length === 0) return <p class="muted">根拠となる指標が不足しているため、エントリー候補は提示されていません。</p>
  const diff = (p: number) => (props.close ? `${(((p - props.close) / props.close) * 100).toFixed(1)}%` : '—')
  return (
    <>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>段階</th>
              <th>価格帯</th>
              <th>現在株価比</th>
              <th>配分</th>
              <th>根拠</th>
            </tr>
          </thead>
          <tbody>
            {props.tiers.map((t, i) => (
              <tr>
                <td>{i + 1}</td>
                <td class="num">
                  {fmtNum(t.low, 0)} 〜 {fmtNum(t.high, 0)} 円
                </td>
                <td class="num">
                  {diff(t.high)} 〜 {diff(t.low)}
                </td>
                <td class="num">{fmtNum(t.allocationPct, 0)}%</td>
                <td class="small">
                  {t.rationale}
                  {t.evidenceIds.map((id) => (
                    <code class="ev-tag">{id}</code>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p class="muted small">
        配分は候補全体を100%とした比率の目安で、実際の資金量・許容損失はご自身で決めてください。現在株価: {props.close ? `${fmtNum(props.close, 0)}円` : '—'}。
      </p>
    </>
  )
}

function SectionPanel(props: { type: (typeof SECTION_TYPES)[number]; s: Section | null }) {
  const { s, type } = props
  return (
    <section id={`panel-${type}`} role="tabpanel" aria-labelledby={`tab-${type}`} class="panel" data-panel={type}>
      <h3>{SECTION_LABELS[type]}</h3>
      {!s ? (
        <p class="muted">保存データを読み込めませんでした。</p>
      ) : (
        <>
          <p>
            <Badge kind={s.outlook}>{OUTLOOK_LABEL[s.outlook] ?? s.outlook}</Badge>
          </p>
          <p>{s.summary}</p>
          <h4>主な所見</h4>
          <FindingList items={s.findings} />
          <div class="two-col">
            <div>
              <h4>強気材料</h4>
              <FindingList items={s.bullishFactors} />
            </div>
            <div>
              <h4>弱気材料</h4>
              <FindingList items={s.bearishFactors} />
            </div>
          </div>
          <h4>リスク</h4>
          <FindingList items={s.risks} />
          <h4>触媒</h4>
          <FindingList items={s.catalysts} />
          <h4>不足情報</h4>
          <StringList items={s.missingData} />
        </>
      )}
    </section>
  )
}

type MetricSpec = { id: string; label: string; alt?: string }

function MetricCell(props: { e: Evidence | undefined; label: string }) {
  const { e } = props
  const when = e ? [e.asOf, e.basis === 'actual' ? '実績' : e.basis === 'forecast' ? '予想' : null].filter(Boolean).join(' ') : ''
  return (
    <div class="metric" title={e?.definition ?? ''}>
      <div class="metric-label">{props.label}</div>
      <div class={e?.value == null ? 'metric-value na' : 'metric-value'}>{e ? fmtEvidenceValue(e.value, e.unit) : '—'}</div>
      <div class="metric-meta">
        {e ? `${ORIGIN_LABEL[e.origin] ?? e.origin}${when ? ` / ${when}` : ''}` : '取得なし'}
      </div>
    </div>
  )
}

/** 分析に使った主要データ。レポートの信憑性を判断できるよう最上部に出す */
export function KeyMetrics(props: { snapshot: Snapshot }) {
  const ev = new Map(props.snapshot.evidence.map((e) => [e.id, e]))
  const period = ev.get('val.eps')?.period ?? null
  const k = period ? `fin.${period.replace('/', '-')}` : null
  const pick = (specs: MetricSpec[]) =>
    specs.map((m) => <MetricCell label={m.label} e={ev.get(m.id) ?? (m.alt ? ev.get(m.alt) : undefined)} />)
  const f = (id: string) => (k ? `${k}.${id}` : `fin.none.${id}`)
  return (
    <section class="card key-metrics" aria-label="分析に使用した主要データ">
      <h2>分析に使用した主要データ</h2>
      <p class="muted small">
        株価基準日: {props.snapshot.priceAsOf ?? '—'}。取得元は「API=IRBANKの計算済み値 / 算出=本アプリでの計算」。項目にカーソルを合わせると定義を表示します。
      </p>
      <h3>株価・バリュエーション(最新株価ベース・実績)</h3>
      <div class="metrics">
        {pick([
          { id: 'price.close', label: '終値' },
          { id: 'mcap', label: '時価総額' },
          { id: 'val.per_forecast', label: 'PER(会社予想)' },
          { id: 'val.per', label: 'PER(実績)' },
          { id: 'val.pbr', label: 'PBR' },
          { id: 'val.dividend_yield_forecast', label: '配当利回り(会社予想)' },
          { id: 'val.dividend_yield', label: '配当利回り(実績)' },
          { id: 'fc.eps', label: 'EPS(会社予想)' },
          { id: 'fc.dps', label: '年間DPS(会社予想)' },
          { id: 'val.eps', label: 'EPS(実績)' },
          { id: 'val.bps', label: 'BPS' },
          { id: 'val.dps', label: '年間DPS(実績)' },
        ])}
      </div>
      <p class="muted small">
        会社予想は最新の決算短信(XBRL)の通期予想で、開示時点の株数基準・開示後の修正は反映していない場合があります。取得できない場合は「—」で、実績では代用しません。
        PBRは直近の決算期末のBPS基準のため、直近四半期のBPSを使う他サービスの値とは差が出ます。
      </p>
      <h3>過去5期末PER(決算期末株価基準)</h3>
      <div class="metrics">
        {pick([
          { id: 'val.per_5y_min', label: '最小' },
          { id: 'val.per_5y_avg', label: '平均' },
          { id: 'val.per_5y_max', label: '最大' },
        ])}
      </div>
      <h3>業績・財務{period ? `(${period}期)` : ''}</h3>
      <div class="metrics">
        {pick([
          { id: f('sales'), label: '売上高' },
          { id: f('operating_profit'), label: '営業利益' },
          { id: f('net_income'), label: '純利益' },
          { id: f('op_margin'), label: '営業利益率' },
          { id: f('roe'), label: 'ROE' },
          { id: f('roa'), label: 'ROA' },
          { id: f('equity_ratio'), label: '自己資本比率' },
          { id: f('payout'), label: '配当性向', alt: f('payout_simple') },
          { id: f('doe'), label: 'DOE', alt: f('doe_simple') },
          { id: f('fcf'), label: 'FCF', alt: f('fcf_simple') },
          { id: 'val.net_cash', label: 'ネットキャッシュ' },
        ])}
      </div>
      <h3>需給・テクニカル</h3>
      <div class="metrics">
        {pick([
          { id: 'sd.margin_ratio', label: '信用倍率' },
          { id: 'sd.buy', label: '信用買い残' },
          { id: 'sd.sell', label: '信用売り残' },
          { id: 'tech.rsi14', label: 'RSI(14)' },
          { id: 'tech.sma25', label: 'SMA25' },
          { id: 'tech.sma75', label: 'SMA75' },
          { id: 'tech.sma200', label: 'SMA200' },
          { id: 'tech.deviation25', label: '25日線乖離' },
        ])}
      </div>
    </section>
  )
}

const ORIGIN_LABEL: Record<string, string> = { api: 'API', calculated: '算出', disclosure: '開示' }

/** 文章系(開示書類の抜粋・Web検索)は表ではなく別枠で表示する */
const isTextEvidence = (e: Evidence) => e.id.startsWith('nar.') || e.id.startsWith('web.')

function SourceTexts(props: { items: Evidence[]; researchUsed: boolean; researchError: string | null }) {
  const nar = props.items.filter((e) => e.id.startsWith('nar.'))
  const ir = props.items.filter((e) => e.id.startsWith('ir.'))
  const web = props.items.filter((e) => e.id.startsWith('web.'))
  const safe = (u: string | null) => (u && u.startsWith('https://') ? u : null)
  if (nar.length === 0 && ir.length === 0 && web.length === 0 && !props.researchUsed) return null
  return (
    <section class="card">
      <h2>参照した文章・外部情報</h2>
      {nar.length > 0 && (
        <>
          <h3>開示書類の抜粋(引用)</h3>
          {nar.map((e) => (
            <details>
              <summary>
                {e.label} <span class="muted small">({e.asOf ?? '—'})</span>
              </summary>
              <p class="small muted">{e.definition}</p>
              <pre class="excerpt">{String(e.value ?? '')}</pre>
            </details>
          ))}
        </>
      )}
      {ir.length > 0 && (
        <>
          <h3>最近の適時開示(見出しのみ)</h3>
          <ul class="small">
            {ir.map((e) => (
              <li>
                {e.asOf ?? '—'} {String(e.value ?? '')}
              </li>
            ))}
          </ul>
        </>
      )}
      {(web.length > 0 || props.researchUsed) && (
        <>
          <h3>Web検索の結果(外部情報・未検証)</h3>
          <p class="notice small">
            AIがWeb検索で集めた情報です。内容の正確性は検証されていません。出典を確認してください。価格レンジや結論の唯一の根拠にはしていません。
          </p>
          {props.researchError && <p class="error small">Web検索に失敗しました: {props.researchError}</p>}
          {web.length === 0 && !props.researchError && <p class="muted small">該当する情報は確認できませんでした。</p>}
          <ul>
            {web.map((e) => (
              <li>
                <span class="badge">{e.id.startsWith('web.industry') ? '業界動向' : 'ニュース'}</span> {String(e.value ?? '')}
                <div class="muted small">
                  {e.asOf ?? '日付不明'} /{' '}
                  {safe(e.endpoint) ? (
                    <a href={safe(e.endpoint)!} rel="noopener noreferrer nofollow" target="_blank">
                      {e.sourceLabel}
                    </a>
                  ) : (
                    e.sourceLabel
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

function EvidenceTable(props: { items: Evidence[] }) {
  return (
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>項目</th>
            <th>値</th>
            <th>取得元</th>
            <th>基準日・期間</th>
            <th>定義・出典</th>
          </tr>
        </thead>
        <tbody>
          {props.items.map((e) => (
            <tr>
              <td>
                <code>{e.id}</code>
              </td>
              <td>{e.label}</td>
              <td class="num">{fmtEvidenceValue(e.value, e.unit)}</td>
              <td>{ORIGIN_LABEL[e.origin] ?? e.origin}</td>
              <td class="small">
                {e.asOf ?? '—'}
                {e.basis ? `(${e.basis === 'actual' ? '実績' : '予想'})` : ''}
                {e.priceAsOf && e.priceAsOf !== e.asOf ? ` / 株価 ${e.priceAsOf}` : ''}
              </td>
              <td class="small">
                {e.definition}
                <div class="muted">
                  {e.sourceLabel}
                  {e.endpoint ? ` / ${e.endpoint}` : ''}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function ReportDetail({ d }: { d: ReportData }) {
  const { run, overall, snapshot } = d
  const title = `${run.stockCode} ${d.stockName ?? ''} レポート`
  const running = run.status === 'collecting' || run.status === 'analyzing'
  const yp = overall?.serverCalc?.yieldPrices ?? snapshot?.yieldPrices ?? []
  const closePrice = typeof snapshot?.evidence.find((e) => e.id === 'price.close')?.value === 'number' ? (snapshot!.evidence.find((e) => e.id === 'price.close')!.value as number) : null
  // 旧形式(単一の entry)のレポートも1段階として表示する
  const entryTiers: EntryTier[] =
    overall && overall.entries.length > 0 ? overall.entries : overall?.entry ? [{ ...overall.entry, allocationPct: 100 }] : []
  const ypf = overall?.serverCalc?.yieldPricesForecast ?? snapshot?.yieldPricesForecast ?? []
  return (
    <Layout title={title}>
      {running && <meta http-equiv="refresh" content="5" />}
      <p class="small">
        <a href={`/stocks/${run.stockCode}`}>← {run.stockCode} の履歴</a>
      </p>
      <h1>
        {run.stockCode} {d.stockName ?? ''}
      </h1>
      <p class="meta">
        <Badge kind={run.status}>{STATUS_LABEL[run.status]}</Badge> スタイル: {STYLE_LABELS[run.investmentStyle]} / 実行: {formatJst(run.requestedAt)}
        {snapshot?.priceAsOf ? ` / 株価基準日: ${snapshot.priceAsOf}` : ''}
      </p>
      {(run.dataSource === 'mock' || run.aiMode === 'mock') && (
        <p class="notice">
          このレポートは{run.dataSource === 'mock' ? '架空のモックデータ' : ''}
          {run.dataSource === 'mock' && run.aiMode === 'mock' ? '・' : ''}
          {run.aiMode === 'mock' ? '外部AIを使わないダミー分析' : ''}で作成されています。投資判断に使用しないでください。
        </p>
      )}

      {running && <p class="notice">分析を実行中です。ページは自動更新されます。</p>}
      {run.status === 'failed' && (
        <p class="error" role="alert">
          分析に失敗しました: {run.errorMessage ?? '不明なエラー'}（{run.errorCode ?? 'unknown'}）
        </p>
      )}
      {run.status === 'failed' && (
        <section class="card">
          <h2>再分析</h2>
          <div id="analysis-controls" data-code={run.stockCode} data-style={run.investmentStyle} data-web-search={d.webSearchAvailable ? '1' : undefined}>
            <p class="muted">読み込み中…</p>
          </div>
        </section>
      )}

      {run.status === 'completed' && snapshot && <KeyMetrics snapshot={snapshot} />}
      {run.status === 'completed' && !snapshot && (
        <p class="notice">
          この分析で取得したデータはDBに保存されていないため、主要データを表示できません(保存は環境変数 ALLOW_PERSIST_SOURCE_DATA=true の時のみ。IRBANKの利用条件の確認後に有効化してください)。有効化後に再分析すると表示されます。
        </p>
      )}

      {run.status === 'completed' && overall && (
        <>
          <section class="card">
            <h2>総評</h2>
            <p>
              <Badge kind={overall.stance}>{STANCE_LABEL[overall.stance] ?? overall.stance}</Badge>
            </p>
            <p>{overall.summary}</p>
            <h3>参考シナリオ(条件付き・保証なし)</h3>
            <table class="kv">
              <tbody>
                <RangeRow label="適正株価の目安" r={overall.fairValue} />
                <RangeRow label="利確候補" r={overall.takeProfit} />
                <RangeRow label="損切り候補" r={overall.stopLoss} />
              </tbody>
            </table>
            <h3>分割エントリー候補(参考・条件付き)</h3>
            <EntryTable tiers={entryTiers} close={closePrice} />
            <YieldTable actual={yp} forecast={ypf} close={closePrice} />
            <h3>シナリオ</h3>
            {overall.scenarios.map((sc) => (
              <div class="scenario">
                <strong>{sc.name === 'bull' ? '強気' : sc.name === 'base' ? '基本' : '弱気'}</strong>: {sc.conditions}
                <div>{sc.outlook}</div>
              </div>
            ))}
            <h3>観点間の矛盾・短期/長期の違い</h3>
            <StringList items={overall.contradictions} empty="特記なし" />
            <h3>主要リスク</h3>
            <FindingList items={overall.risks} />
            <h3>不足情報</h3>
            <StringList items={[...new Set([...overall.missingData, ...d.missing])]} empty="特記なし" />
          </section>

          <h2>観点別</h2>
          <div id="report-tabs-root" data-panels={SECTION_TYPES.join(',')} data-labels={SECTION_TYPES.map((t) => SECTION_LABELS[t]).join(',')} />
          {SECTION_TYPES.map((t) => (
            <SectionPanel type={t} s={d.sections[t] ?? null} />
          ))}

          {snapshot && <SourceTexts items={snapshot.evidence} researchUsed={d.usage?.research?.used === true} researchError={d.usage?.research?.error ?? null} />}

          <h2>根拠データ・基準日</h2>
          {snapshot ? (
            <details>
              <summary>主要指標と evidence 一覧({snapshot.evidence.length}件)</summary>
              <EvidenceTable items={snapshot.evidence.filter((e) => !isTextEvidence(e))} />
            </details>
          ) : (
            <p class="muted">利用条件の確認が済むまで、元データ(スナップショット)はDBに保存していません。出典メタデータのみ保持しています。</p>
          )}
          <h3>データ出典</h3>
          <ul class="small">
            {d.sources.map((s) => (
              <li>
                {s.dataset}: {s.sourceLabel}（基準: {s.asOf ?? '—'}）
              </li>
            ))}
          </ul>

          <DocumentList docs={d.documents} />

          <h2>実行情報</h2>
          <table class="kv small">
            <tbody>
              <tr>
                <th>モデル</th>
                <td>{run.aiMode === 'real' ? run.model : 'モック(外部送信なし)'}</td>
              </tr>
              <tr>
                <th>トークン</th>
                <td>
                  入力 {d.usage?.inputTokens ?? '—'} / 出力 {d.usage?.outputTokens ?? '—'} / 合計 {d.usage?.totalTokens ?? '—'} / reasoning {d.usage?.reasoningTokens ?? '—'}
                </td>
              </tr>
              <tr>
                <th>決算短信PDFの要約</th>
                <td>{d.usage?.tanshin?.used ? (d.usage.tanshin.error ? `失敗(${d.usage.tanshin.error})` : `使用(入力 ${d.usage.tanshin.inputTokens ?? '—'} / 出力 ${d.usage.tanshin.outputTokens ?? '—'} トークン)`) : '未使用'}</td>
              </tr>
              <tr>
                <th>Web検索</th>
                <td>
                  {d.usage?.research?.used
                    ? `使用(検索 ${d.usage.research.searchCalls ?? '—'}回 / 採用 ${d.usage.research.items}件)${d.usage.research.error ? ' / 失敗' : ''}`
                    : '未使用'}
                </td>
              </tr>
              <tr>
                <th>推定費用</th>
                <td>
                  {fmtUsd(run.estimatedCostUsd)} <span class="muted">{d.usage?.costBasis ?? ''}（推定値であり実請求額とは異なる場合があります）</span>
                </td>
              </tr>
              <tr>
                <th>バージョン</th>
                <td>
                  prompt {d.promptVersion ?? '—'} / schema {d.schemaVersion ?? '—'} / calc {d.calculatorVersion ?? '—'}
                </td>
              </tr>
            </tbody>
          </table>
        </>
      )}
    </Layout>
  )
}
