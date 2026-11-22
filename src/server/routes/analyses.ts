import { Hono } from 'hono'
import type { Env } from '../env.ts'
import { loadConfig } from '../env.ts'
import { isUuid, normalizeStockCode, parseInvestmentStyle } from '../../shared/validate.ts'
import { executeRun, startRun } from '../services/analysis/orchestrate.ts'
import * as runs from '../db/repositories/runs.ts'
import { parseOverall, parseSection } from '../services/analysis/stored.ts'
import { SECTION_TYPES } from '../../shared/types.ts'

const err = (code: string, message: string) => ({ error: { code, message } })
const MAX_BODY_BYTES = 2048

export const analyses = new Hono<{ Bindings: Env }>()

/** CSRF対策: 変更系は同一オリジン + JSON のみ許可 */
analyses.use('*', async (c, next) => {
  if (c.req.method === 'POST') {
    const origin = c.req.header('Origin')
    const url = new URL(c.req.url)
    if (origin && origin !== url.origin) return c.json(err('forbidden_origin', '不正なオリジンです'), 403)
    const site = c.req.header('Sec-Fetch-Site')
    if (site && !['same-origin', 'none'].includes(site)) return c.json(err('forbidden_origin', '不正なリクエスト元です'), 403)
    if (!(c.req.header('Content-Type') ?? '').toLowerCase().startsWith('application/json')) {
      return c.json(err('unsupported_media_type', 'Content-Type は application/json にしてください'), 415)
    }
  }
  return next()
})

analyses.post('/', async (c) => {
  const cfg = loadConfig(c.env)
  const key = c.req.header('Idempotency-Key')
  if (!isUuid(key)) return c.json(err('invalid_idempotency_key', 'Idempotency-Key(UUID)が必要です'), 400)

  const text = await c.req.text()
  if (text.length > MAX_BODY_BYTES) return c.json(err('payload_too_large', 'リクエストが大きすぎます'), 413)
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return c.json(err('invalid_json', 'JSONが不正です'), 400)
  }
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const code = normalizeStockCode(b.code)
  const style = parseInvestmentStyle(b.style)
  const webSearch = b.webSearch === true
  if (!code) return c.json(err('invalid_code', '銘柄コードは4桁の英数字で指定してください'), 400)
  if (!style) return c.json(err('invalid_style', '投資スタイルが不正です'), 400)

  if (webSearch && !cfg.webSearchEnabled) {
    return c.json(err('web_search_disabled', 'Web検索は無効です(ALLOW_WEB_SEARCH=true かつ実AIモードの時のみ利用できます)'), 400)
  }

  const started = await startRun(c.env.DB, cfg, { key, code, style })
  if (started.kind === 'rejected') return c.json(err(started.code, started.message), 429)
  if (started.kind === 'existing') {
    // 重複リクエスト: 新たなAI課金は発生させず、既存runの状態を返す
    return c.json({ run: started.run, duplicate: true }, 200)
  }
  await executeRun(c.env, cfg, started.id, code, style, { webSearch })
  const full = await runs.getRun(c.env.DB, started.id)
  return c.json({ run: full?.summary ?? null })
})

analyses.get('/:id', async (c) => {
  const id = c.req.param('id')
  if (!isUuid(id)) return c.json(err('invalid_id', 'IDが不正です'), 400)
  await runs.markStaleRuns(c.env.DB)
  const r = await runs.getRun(c.env.DB, id)
  if (!r) return c.json(err('not_found', '分析が見つかりません'), 404)
  const reports = r.summary.status === 'completed' ? await runs.getReports(c.env.DB, id) : {}
  const sections = SECTION_TYPES.map((t) => parseSection(reports[t])).filter((s) => s !== null)
  return c.json({ run: r.summary, sections, overall: parseOverall(reports.overall) })
})

analyses.get('/', async (c) => {
  const codeRaw = c.req.query('code')
  const code = codeRaw ? normalizeStockCode(codeRaw) : undefined
  if (codeRaw && !code) return c.json(err('invalid_code', '銘柄コードが不正です'), 400)
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 20) || 20, 1), 100)
  const before = c.req.query('before')
  if (before && Number.isNaN(Date.parse(before))) return c.json(err('invalid_before', 'before が不正です'), 400)
  const list = await runs.listRuns(c.env.DB, { code: code ?? undefined, limit: limit + 1, before: before || undefined })
  const page = list.slice(0, limit)
  return c.json({ runs: page, nextBefore: list.length > limit ? page.at(-1)?.requestedAt : null })
})
