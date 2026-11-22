import type { AnalysisOutput, InvestmentStyle, ReportKind, RunStatus, RunSummary, Snapshot, SourceMeta, Usage } from '../../../shared/types.ts'
import { REPORT_KINDS } from '../../../shared/types.ts'
import { jstDate, jstDayStartUtc, jstMonth, nowIso, addDays } from '../../util/time.ts'

type RunRow = {
  id: string
  stock_code: string
  status: RunStatus
  investment_style: InvestmentStyle
  requested_at: string
  completed_at: string | null
  model: string | null
  ai_mode: string | null
  data_source: string | null
  estimated_cost_usd: number | null
  error_code: string | null
  error_message: string | null
}

const RUN_COLS =
  'id, stock_code, status, investment_style, requested_at, completed_at, model, ai_mode, data_source, estimated_cost_usd, error_code, error_message'

export function toSummary(r: RunRow): RunSummary {
  return {
    id: r.id,
    stockCode: r.stock_code,
    status: r.status,
    investmentStyle: r.investment_style,
    requestedAt: r.requested_at,
    completedAt: r.completed_at,
    model: r.model,
    aiMode: r.ai_mode,
    dataSource: r.data_source,
    estimatedCostUsd: r.estimated_cost_usd,
    errorCode: r.error_code,
    errorMessage: r.error_message,
  }
}

/** この時間を超えて collecting/analyzing のままの実行は切断されたとみなし failed にする */
export const STALE_MINUTES = 10

export async function markStaleRuns(db: D1Database): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_MINUTES * 60_000).toISOString()
  await db
    .prepare(
      `UPDATE analysis_runs SET status='failed', completed_at=?1, error_code='interrupted',
         error_message='実行が中断されました(接続断または時間切れ)。再分析してください'
       WHERE status IN ('collecting','analyzing') AND requested_at < ?2`,
    )
    .bind(nowIso(), cutoff)
    .run()
}

export async function findByKey(db: D1Database, key: string): Promise<RunSummary | null> {
  const r = await db.prepare(`SELECT ${RUN_COLS} FROM analysis_runs WHERE idempotency_key = ?1`).bind(key).first<RunRow>()
  return r ? toSummary(r) : null
}

/** 一意制約で二重実行を防ぐ。既存キーなら created=false。 */
export async function insertRun(
  db: D1Database,
  p: { id: string; key: string; code: string; style: InvestmentStyle; dataSource: string; aiMode: string },
): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO analysis_runs (id, idempotency_key, stock_code, status, investment_style, requested_at, data_source, ai_mode)
       VALUES (?1, ?2, ?3, 'collecting', ?4, ?5, ?6, ?7)`,
    )
    .bind(p.id, p.key, p.code, p.style, nowIso(), p.dataSource, p.aiMode)
    .run()
  return (res.meta.changes ?? 0) > 0
}

export async function setStatus(db: D1Database, id: string, status: RunStatus): Promise<void> {
  await db.prepare(`UPDATE analysis_runs SET status=?2 WHERE id=?1`).bind(id, status).run()
}

export async function failRun(db: D1Database, id: string, code: string, message: string, extra?: { missing?: string[] }): Promise<void> {
  await db
    .prepare(
      `UPDATE analysis_runs SET status='failed', completed_at=?2, error_code=?3, error_message=?4, missing_data_json=COALESCE(?5, missing_data_json) WHERE id=?1`,
    )
    .bind(id, nowIso(), code, message.slice(0, 500), extra?.missing ? JSON.stringify(extra.missing) : null)
    .run()
}

export async function completeRun(
  db: D1Database,
  p: {
    id: string
    code: string
    stock: { name: string; market: string | null; sector: string | null }
    model: string
    promptVersion: string
    schemaVersion: string
    calculatorVersion: string
    snapshot: Snapshot
    persistSnapshot: boolean
    sources: SourceMeta[]
    usage: Usage
    costUsd: number | null
    output: AnalysisOutput
  },
): Promise<void> {
  const now = nowIso()
  const stmts: D1PreparedStatement[] = []
  stmts.push(
    db
      .prepare(
        `INSERT INTO stocks (code, name, market, sector, updated_at) VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(code) DO UPDATE SET name=excluded.name, market=excluded.market, sector=excluded.sector, updated_at=excluded.updated_at`,
      )
      .bind(p.code, p.stock.name, p.stock.market, p.stock.sector, now),
  )
  for (const kind of REPORT_KINDS) {
    const content = kind === 'overall' ? { ...p.output.overall, serverCalc: { yieldPrices: p.snapshot.yieldPrices, yieldPricesForecast: p.snapshot.yieldPricesForecast } } : p.output.sections.find((s) => s.type === kind)
    stmts.push(
      db
        .prepare(`INSERT INTO analysis_reports (id, run_id, kind, content_json, created_at) VALUES (?1,?2,?3,?4,?5)`)
        .bind(crypto.randomUUID(), p.id, kind, JSON.stringify(content), now),
    )
  }
  // 画面表示用の指標は evidence を含むため、保存許可がない場合は値を持たない最小メタのみ保存
  const snapshotJson = p.persistSnapshot ? JSON.stringify(p.snapshot) : null
  const metaOnly = { sources: p.sources, priceAsOf: p.snapshot.priceAsOf, evidenceCount: p.snapshot.evidence.length, documents: p.snapshot.documents ?? [] }
  stmts.push(
    db
      .prepare(
        `UPDATE analysis_runs SET status='completed', completed_at=?2, model=?3, prompt_version=?4, schema_version=?5, calculator_version=?6,
           snapshot_json=?7, source_metadata_json=?8, missing_data_json=?9, usage_json=?10, estimated_cost_usd=?11, error_code=NULL, error_message=NULL
         WHERE id=?1`,
      )
      .bind(
        p.id,
        now,
        p.model,
        p.promptVersion,
        p.schemaVersion,
        p.calculatorVersion,
        snapshotJson,
        JSON.stringify(metaOnly),
        JSON.stringify(p.snapshot.missingData),
        JSON.stringify(p.usage),
        p.costUsd,
      ),
  )
  await db.batch(stmts) // D1 batch はトランザクションとして実行される
}

export async function getRun(db: D1Database, id: string) {
  const r = await db
    .prepare(`SELECT ${RUN_COLS}, snapshot_json, source_metadata_json, missing_data_json, usage_json, prompt_version, schema_version, calculator_version FROM analysis_runs WHERE id=?1`)
    .bind(id)
    .first<RunRow & Record<string, string | null>>()
  if (!r) return null
  return {
    summary: toSummary(r),
    snapshotJson: r.snapshot_json ?? null,
    sourceMetadataJson: r.source_metadata_json ?? null,
    missingDataJson: r.missing_data_json ?? null,
    usageJson: r.usage_json ?? null,
    promptVersion: r.prompt_version ?? null,
    schemaVersion: r.schema_version ?? null,
    calculatorVersion: r.calculator_version ?? null,
  }
}

export async function getReports(db: D1Database, runId: string): Promise<Partial<Record<ReportKind, string>>> {
  const { results } = await db.prepare(`SELECT kind, content_json FROM analysis_reports WHERE run_id=?1`).bind(runId).all<{ kind: ReportKind; content_json: string }>()
  const out: Partial<Record<ReportKind, string>> = {}
  for (const r of results) out[r.kind] = r.content_json
  return out
}

export async function listRuns(db: D1Database, opts: { code?: string; limit: number; before?: string }): Promise<RunSummary[]> {
  const where: string[] = []
  const binds: unknown[] = []
  if (opts.code) { binds.push(opts.code); where.push(`stock_code = ?${binds.length}`) }
  if (opts.before) { binds.push(opts.before); where.push(`requested_at < ?${binds.length}`) }
  binds.push(opts.limit)
  const sql = `SELECT ${RUN_COLS} FROM analysis_runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY requested_at DESC LIMIT ?${binds.length}`
  const { results } = await db.prepare(sql).bind(...binds).all<RunRow>()
  return results.map(toSummary)
}

export async function countToday(db: D1Database): Promise<number> {
  const start = jstDayStartUtc(jstDate())
  const end = jstDayStartUtc(addDays(jstDate(), 1))
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM analysis_runs WHERE requested_at >= ?1 AND requested_at < ?2`).bind(start, end).first<{ n: number }>()
  return r?.n ?? 0
}

export async function monthCostUsd(db: D1Database): Promise<number> {
  const start = jstDayStartUtc(jstMonth() + '-01')
  const r = await db.prepare(`SELECT COALESCE(SUM(estimated_cost_usd),0) AS c FROM analysis_runs WHERE requested_at >= ?1`).bind(start).first<{ c: number }>()
  return r?.c ?? 0
}

/** この文書IDが、保存済みの分析で使われたものか(中継ルートで任意の文書を取得させないための検査)。 */
export async function findStoredDocument(db: D1Database, docId: string): Promise<import('../../../shared/types.ts').DocRef | null> {
  if (!/^[0-9A-Za-z]{6,40}$/.test(docId)) return null
  const row = await db
    .prepare(`SELECT source_metadata_json FROM analysis_runs WHERE source_metadata_json LIKE ?1 ORDER BY requested_at DESC LIMIT 5`)
    .bind(`%"docId":"${docId}"%`)
    .all<{ source_metadata_json: string }>()
  for (const r of row.results) {
    try {
      const m = JSON.parse(r.source_metadata_json) as { documents?: import('../../../shared/types.ts').DocRef[] }
      const d = m.documents?.find((x) => x.docId === docId)
      if (d) return d
    } catch {
      // 壊れたメタデータは無視
    }
  }
  return null
}

export async function getStock(db: D1Database, code: string) {
  return db.prepare(`SELECT code, name, market, sector, updated_at FROM stocks WHERE code=?1`).bind(code).first<{ code: string; name: string; market: string | null; sector: string | null; updated_at: string }>()
}

export type StockSummary = { code: string; name: string | null; runCount: number; lastRequestedAt: string }

/** 分析した銘柄の一覧(最新の分析が新しい順)。before は前ページ最後の lastRequestedAt。 */
export async function listStockSummaries(db: D1Database, opts: { limit: number; before?: string }): Promise<StockSummary[]> {
  const binds: unknown[] = []
  let having = ''
  if (opts.before) {
    binds.push(opts.before)
    having = `HAVING MAX(r.requested_at) < ?${binds.length}`
  }
  binds.push(opts.limit)
  const { results } = await db
    .prepare(
      `SELECT r.stock_code AS code, s.name AS name, COUNT(*) AS run_count, MAX(r.requested_at) AS last_at
       FROM analysis_runs r LEFT JOIN stocks s ON s.code = r.stock_code
       GROUP BY r.stock_code ${having}
       ORDER BY last_at DESC LIMIT ?${binds.length}`,
    )
    .bind(...binds)
    .all<{ code: string; name: string | null; run_count: number; last_at: string }>()
  return results.map((x) => ({ code: x.code, name: x.name, runCount: x.run_count, lastRequestedAt: x.last_at }))
}

/** 銘柄ごとの、完了済みの最新 run の id。 */
export async function latestCompletedRunIds(db: D1Database, codes: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (codes.length === 0) return out
  const ph = codes.map((_, i) => `?${i + 1}`).join(',')
  const { results } = await db
    .prepare(`SELECT stock_code, id, MAX(requested_at) AS m FROM analysis_runs WHERE status='completed' AND stock_code IN (${ph}) GROUP BY stock_code`)
    .bind(...codes)
    .all<{ stock_code: string; id: string }>()
  for (const x of results) out.set(x.stock_code, x.id)
  return out
}

/** run ごとの総評(結論・適正株価)。一覧表示用に overall だけを取り出す。 */
export async function overallsByRunIds(db: D1Database, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (ids.length === 0) return out
  const ph = ids.map((_, i) => `?${i + 1}`).join(',')
  const { results } = await db
    .prepare(`SELECT run_id, content_json FROM analysis_reports WHERE kind='overall' AND run_id IN (${ph})`)
    .bind(...ids)
    .all<{ run_id: string; content_json: string }>()
  for (const x of results) out.set(x.run_id, x.content_json)
  return out
}
