import { Hono } from 'hono'
import type { Env } from './env.ts'
import { loadConfig } from './env.ts'
import { requireAccess } from './middleware/auth.ts'
import { analyses } from './routes/analyses.ts'
import { stocks } from './routes/stocks.ts'
import { masterStatus } from './db/repositories/securities.ts'
import * as runs from './db/repositories/runs.ts'
import { Dashboard, type RunInsight } from './pages/dashboard.tsx'
import { ReportsPage, StocksPage } from './pages/lists.tsx'
import { StockDetail } from './pages/stock-detail.tsx'
import { ReportDetail, type ReportData } from './pages/report-detail.tsx'
import { SECTION_TYPES } from '../shared/types.ts'
import { isUuid, normalizeStockCode } from '../shared/validate.ts'
import { parseDocuments, parseOverall, parseSection, parseSnapshot, parseSources, parseStringArray, parseUsage } from './services/analysis/stored.ts'
import { IrbankClient } from './services/providers/irbank/client.ts'
import { Layout } from './components/layout.tsx'

const app = new Hono<{ Bindings: Env }>()

const PAGE_SIZE = 20

/** 一覧表示用に、runごとの結論・適正株価の目安を取り出す(総評JSONのみ読む) */
async function insightsOf(db: D1Database, runIds: string[]): Promise<Map<string, RunInsight>> {
  const out = new Map<string, RunInsight>()
  for (const [id, json] of await runs.overallsByRunIds(db, runIds)) {
    const o = parseOverall(json)
    if (o) out.set(id, { stance: o.stance, fairLow: o.fairValue?.low ?? null, fairHigh: o.fairValue?.high ?? null })
  }
  return out
}
async function namesOf(db: D1Database, codes: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  for (const code of new Set(codes)) {
    const s = await runs.getStock(db, code)
    if (s) names.set(code, s.name)
  }
  return names
}
const validBefore = (v: string | undefined) => (v && !Number.isNaN(Date.parse(v)) ? v : undefined)

// セキュリティヘッダー(全応答)
app.use('*', async (c, next) => {
  await next()
  const h = c.res.headers
  // PDF配信は、ブラウザ内蔵のPDFビューアを妨げないよう最小のCSPにする(スクリプトを含まない応答)
  h.set(
    'Content-Security-Policy',
    new URL(c.req.url).pathname.startsWith('/documents/')
      ? "frame-ancestors 'none'"
      : "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  )
  h.set('X-Content-Type-Options', 'nosniff')
  h.set('Referrer-Policy', 'same-origin')
  h.set('X-Frame-Options', 'DENY')
  h.set('Cache-Control', 'no-store')
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
})

// 認証: 静的アセット・API・ページのすべてが対象(run_worker_first により Worker を必ず経由する)
app.use('*', requireAccess)

app.get('/assets/*', async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw)
  return new Response(res.body, res) // ヘッダーを変更可能にする
})

/**
 * 分析に使った開示書類(PDF)の中継。取得元のURLはAPIキーが必要でブラウザから直接開けないため、
 * Worker がキーを付けて取得して返す(キーはブラウザに出ない)。保存済みの分析で使った文書IDのみ対象。
 */
app.get('/documents/:docId/pdf', async (c) => {
  const doc = await runs.findStoredDocument(c.env.DB, c.req.param('docId'))
  if (!doc || !doc.pdfUrl) return c.text('Not Found', 404)
  if (!c.env.IRBANK_API_KEY) return c.text('PDFの取得にはIRBANK_API_KEYの設定が必要です', 503)
  try {
    const bytes = await new IrbankClient(c.env.IRBANK_API_KEY).getBinary(doc.pdfUrl, 8 * 1024 * 1024)
    return new Response(bytes, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${doc.docId}.pdf"`,
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (e) {
    console.warn('document fetch failed', e instanceof Error ? e.message : 'unknown')
    return c.text('PDFを取得できませんでした。時間をおいて再度お試しください', 502)
  }
})

app.get('/api/health', (c) => c.json({ ok: true }))
app.route('/api/analyses', analyses)
app.route('/api/stocks', stocks)
app.all('/api/*', (c) => c.json({ error: { code: 'not_found', message: 'Not Found' } }, 404))

app.get('/', async (c) => {
  const cfg = loadConfig(c.env)
  await runs.markStaleRuns(c.env.DB)
  const [list, today] = await Promise.all([runs.listRuns(c.env.DB, { limit: 10 }), runs.countToday(c.env.DB)])
  const names = await namesOf(c.env.DB, list.map((r) => r.stockCode))
  const insights = await insightsOf(c.env.DB, list.map((r) => r.id))
  return c.html(<Dashboard runs={list} names={names} insights={insights} cfg={cfg} todayCount={today} />)
})

app.get('/reports', async (c) => {
  await runs.markStaleRuns(c.env.DB)
  const codeRaw = c.req.query('code')
  const code = codeRaw ? normalizeStockCode(codeRaw) : null
  if (codeRaw && !code) return c.html(<NotFound />, 404)
  const rows = await runs.listRuns(c.env.DB, { code: code ?? undefined, limit: PAGE_SIZE + 1, before: validBefore(c.req.query('before')) })
  const page = rows.slice(0, PAGE_SIZE)
  const names = await namesOf(c.env.DB, page.map((r) => r.stockCode))
  const insights = await insightsOf(c.env.DB, page.map((r) => r.id))
  return c.html(<ReportsPage runs={page} names={names} insights={insights} code={code} nextBefore={rows.length > PAGE_SIZE ? (page.at(-1)?.requestedAt ?? null) : null} />)
})

app.get('/stocks', async (c) => {
  const rows = await runs.listStockSummaries(c.env.DB, { limit: PAGE_SIZE + 1, before: validBefore(c.req.query('before')) })
  const page = rows.slice(0, PAGE_SIZE)
  const latestIds = await runs.latestCompletedRunIds(c.env.DB, page.map((s) => s.code))
  const byRun = await insightsOf(c.env.DB, [...latestIds.values()])
  const insights = new Map<string, RunInsight & { runId: string }>()
  for (const [code, runId] of latestIds) {
    const i = byRun.get(runId)
    if (i) insights.set(code, { ...i, runId })
  }
  const cfg = loadConfig(c.env)
  const master = await masterStatus(c.env.DB)
  return c.html(<StocksPage master={master} canRefreshMaster={cfg.persistSnapshot || cfg.dataSource === 'mock'} stocks={page} insights={insights} nextBefore={rows.length > PAGE_SIZE ? (page.at(-1)?.lastRequestedAt ?? null) : null} />)
})

app.get('/stocks/:code', async (c) => {
  const code = normalizeStockCode(c.req.param('code'))
  if (!code) return c.html(<NotFound />, 404)
  const cfg = loadConfig(c.env)
  await runs.markStaleRuns(c.env.DB)
  const [list, stock] = await Promise.all([runs.listRuns(c.env.DB, { code, limit: 30 }), runs.getStock(c.env.DB, code)])
  const latest = list.find((r) => r.status === 'completed')
  const overall = latest ? parseOverall((await runs.getReports(c.env.DB, latest.id)).overall) : null
  const insights = await insightsOf(c.env.DB, list.map((r) => r.id))
  const latestRun = latest ? await runs.getRun(c.env.DB, latest.id) : null
  const documents = parseDocuments(latestRun?.sourceMetadataJson ?? null)
  return c.html(<StockDetail documents={documents} code={code} stock={stock} runs={list} insights={insights} latestOverall={overall} latestRunId={latest?.id ?? null} cfg={cfg} />)
})

app.get('/reports/:id', async (c) => {
  const id = c.req.param('id')
  if (!isUuid(id)) return c.html(<NotFound />, 404)
  await runs.markStaleRuns(c.env.DB)
  const r = await runs.getRun(c.env.DB, id)
  if (!r) return c.html(<NotFound />, 404)
  const reports = r.summary.status === 'completed' ? await runs.getReports(c.env.DB, id) : {}
  const stock = await runs.getStock(c.env.DB, r.summary.stockCode)
  const data: ReportData = {
    run: r.summary,
    sections: Object.fromEntries(SECTION_TYPES.map((t) => [t, parseSection(reports[t])])),
    overall: parseOverall(reports.overall),
    snapshot: parseSnapshot(r.snapshotJson),
    usage: parseUsage(r.usageJson),
    missing: parseStringArray(r.missingDataJson),
    sources: parseSources(r.sourceMetadataJson),
    promptVersion: r.promptVersion,
    schemaVersion: r.schemaVersion,
    calculatorVersion: r.calculatorVersion,
    stockName: stock?.name ?? null,
    documents: parseDocuments(r.sourceMetadataJson),
    webSearchAvailable: loadConfig(c.env).webSearchEnabled,
  }
  return c.html(<ReportDetail d={data} />)
})

function NotFound() {
  return (
    <Layout title="見つかりません">
      <h1>ページが見つかりません</h1>
      <p>
        <a href="/">ホームへ戻る</a>
      </p>
    </Layout>
  )
}

app.notFound((c) => c.html(<NotFound />, 404))
app.onError((err, c) => {
  console.error('unhandled', err.message)
  return c.json({ error: { code: 'internal_error', message: 'サーバーエラーが発生しました' } }, 500)
})

export default app
