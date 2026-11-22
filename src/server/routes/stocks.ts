import { Hono } from 'hono'
import type { Env } from '../env.ts'
import { loadConfig } from '../env.ts'
import { makeProvider } from '../services/analysis/orchestrate.ts'
import * as master from '../db/repositories/securities.ts'
import { AnalysisError } from '../services/analysis/errors.ts'

const err = (code: string, message: string) => ({ error: { code, message } })

export const stocks = new Hono<{ Bindings: Env }>()

/** CSRF対策: 変更系は同一オリジン + JSON のみ許可(分析APIと同じ) */
stocks.use('*', async (c, next) => {
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

/** 銘柄名・コードの候補(オートコンプリート)。銘柄マスタ(D1)のみを検索し、IRBANKへはリクエストしない。 */
stocks.get('/search', async (c) => {
  const q = (c.req.query('q') ?? '').slice(0, 40)
  if (q.trim() === '') return c.json({ suggestions: [], masterReady: true })
  const status = await master.masterStatus(c.env.DB)
  const suggestions = status.count > 0 ? await master.searchMaster(c.env.DB, q) : await master.searchAnalyzed(c.env.DB, q)
  return c.json({ suggestions, masterReady: status.count > 0 })
})

stocks.get('/master', async (c) => c.json(await master.masterStatus(c.env.DB)))

const CURSOR = /^[A-Za-z0-9_\-=.+/]{1,1000}$/

/**
 * 銘柄マスタの更新(1ページ=最大500件ずつ。Workers のCPU制限のため、画面から next を繰り返し呼ぶ)。
 * 保存は ALLOW_PERSIST_SOURCE_DATA=true(またはモック)の時のみ。
 */
stocks.post('/master/refresh', async (c) => {
  const cfg = loadConfig(c.env)
  if (!cfg.persistSnapshot && cfg.dataSource !== 'mock') {
    return c.json(err('persist_not_allowed', '銘柄マスタの保存には ALLOW_PERSIST_SOURCE_DATA=true が必要です(利用条件の確認後に有効化してください)'), 403)
  }
  let cursor: string | undefined
  try {
    const body = JSON.parse((await c.req.text()) || '{}') as { cursor?: unknown }
    if (body.cursor != null) {
      if (typeof body.cursor !== 'string' || !CURSOR.test(body.cursor)) return c.json(err('invalid_cursor', 'cursor が不正です'), 400)
      cursor = body.cursor
    }
  } catch {
    return c.json(err('invalid_json', 'JSONが不正です'), 400)
  }
  try {
    const page = await makeProvider(c.env, cfg).listSecurities(cursor)
    await master.upsertMaster(c.env.DB, page.rows)
    const status = await master.masterStatus(c.env.DB)
    return c.json({ fetched: page.rows.length, nextCursor: page.nextCursor, total: status.count })
  } catch (e) {
    console.warn('master refresh failed', e instanceof Error ? e.message : 'unknown')
    return c.json(err(e instanceof AnalysisError ? e.code : 'refresh_failed', e instanceof Error ? e.message : '銘柄マスタを更新できませんでした'), 502)
  }
})
