import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IrbankClient } from '../src/server/services/providers/irbank/client.ts'
import { IrbankProvider } from '../src/server/services/providers/irbank/index.ts'
import { ProviderError } from '../src/server/services/providers/types.ts'

type Step = { status: number; body?: unknown; headers?: Record<string, string> }
function scripted(steps: Step[]) {
  const calls: { url: string; auth: string | null }[] = []
  let i = 0
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, auth: new Headers(init?.headers).get('authorization') })
    const s = steps[Math.min(i++, steps.length - 1)]!
    return new Response(JSON.stringify(s.body ?? {}), { status: s.status, headers: s.headers })
  }) as unknown as typeof fetch
  return { f, calls }
}
const noSleep = async () => {}

test('Bearer認証ヘッダーとクエリが付く', async () => {
  const { f, calls } = scripted([{ status: 200, body: { ok: 1 } }])
  const c = new IrbankClient('irbk_key_test', f, noSleep)
  await c.get('/securities/7203/prices', { from: '2026-01-01', limit: 500 })
  assert.equal(calls[0]!.auth, 'Bearer irbk_key_test')
  assert.match(calls[0]!.url, /^https:\/\/api\.irbank\.net\/v1\/securities\/7203\/prices\?from=2026-01-01&limit=500$/)
})

test('401/403/404/400 は再試行しない', async () => {
  for (const [status, code] of [[401, 'unauthorized'], [403, 'forbidden'], [404, 'not_found'], [400, 'bad_request']] as const) {
    const { f, calls } = scripted([{ status }])
    const c = new IrbankClient('k', f, noSleep)
    await assert.rejects(c.get('/x'), (e: ProviderError) => e.code === code)
    assert.equal(calls.length, 1, String(status))
  }
})

test('429 は Retry-After を尊重して再試行し、成功すれば返す', async () => {
  const waits: number[] = []
  const { f, calls } = scripted([{ status: 429, headers: { 'retry-after': '2' } }, { status: 200, body: { ok: true } }])
  const c = new IrbankClient('k', f, async (ms) => void waits.push(ms))
  assert.deepEqual(await c.get('/x'), { ok: true })
  assert.equal(calls.length, 2)
  assert.deepEqual(waits, [2000])
})

test('429 で待機が長すぎる場合は待たずに失敗(日次上限など)', async () => {
  const { f, calls } = scripted([{ status: 429, headers: { 'retry-after': '3600' } }])
  const c = new IrbankClient('k', f, noSleep)
  await assert.rejects(c.get('/x'), (e: ProviderError) => e.code === 'rate_limited')
  assert.equal(calls.length, 1)
})

test('5xx は上限付きで再試行し、尽きたら unavailable', async () => {
  const { f, calls } = scripted([{ status: 503 }])
  const c = new IrbankClient('k', f, noSleep)
  await assert.rejects(c.get('/x'), (e: ProviderError) => e.code === 'unavailable')
  assert.equal(calls.length, 3) // 初回 + 2回
})

test('同一実行内の同一URLは重複取得しない', async () => {
  const { f, calls } = scripted([{ status: 200, body: { a: 1 } }])
  const c = new IrbankClient('k', f, noSleep)
  await Promise.all([c.get('/x', { a: 1 }), c.get('/x', { a: 1 })])
  assert.equal(calls.length, 1)
})

const sec = { code: '7203', name: 'テスト', market: 'Prime', industry: '輸送用機器', edinet_code: 'E02144', listing_status: 'listed', issued_shares: 1000, fiscal_year_end_month: 3, attribution: { source_label: 'EDINET' } }

function providerWith(routes: Record<string, unknown>) {
  const f = (async (url: string) => {
    const path = new URL(url).pathname.replace('/v1', '')
    const hit = routes[path]
    if (hit === undefined) return new Response('{}', { status: 404 })
    return new Response(JSON.stringify(hit), { status: 200 })
  }) as unknown as typeof fetch
  return new IrbankProvider('k', new IrbankClient('k', f, noSleep))
}

test('銘柄詳細のマッピングと上場状態チェック', async () => {
  const p = providerWith({ '/securities/7203': sec })
  const r = await p.getSecurity('7203')
  assert.equal(r.data.edinetCode, 'E02144')
  assert.equal(r.meta.sourceLabel, 'EDINET')
  const delisted = providerWith({ '/securities/7203': { ...sec, listing_status: 'delisted' } })
  await assert.rejects(delisted.getSecurity('7203'), (e: ProviderError) => e.code === 'not_found')
})

test('日足: 新しい順を昇順に直し、nullと0を区別する', async () => {
  const p = providerWith({
    '/securities/7203/prices': {
      fields: [{ key: 'close', unit: 'jpy' }, { key: 'volume', unit: 'shares' }],
      prices: [
        { date: '2026-01-06', open: 1, high: 2, low: 1, close: 2, adj_close: 2, volume: 0 },
        { date: '2026-01-05', open: 1, high: 2, low: 1, close: 1, adj_close: null, volume: 10 },
      ],
    },
  })
  const r = await p.getPrices('7203', '2026-01-01')
  assert.deepEqual(r.data.map((b) => b.date), ['2026-01-05', '2026-01-06'])
  assert.equal(r.data[0]!.adjClose, null)
  assert.equal(r.data[1]!.volume, 0)
})

test('単位が想定と違う場合は失敗(円と百万円の取り違え防止)', async () => {
  const p = providerWith({
    '/securities/7203/prices': { fields: [{ key: 'close', unit: 'million_jpy' }], prices: [] },
  })
  await assert.rejects(p.getPrices('7203', '2026-01-01'), (e: ProviderError) => e.code === 'invalid_response')
})

test('数値フィールドが文字列なら不正応答', async () => {
  const p = providerWith({ '/securities/7203/prices': { prices: [{ date: '2026-01-05', close: '100', volume: 1 }] } })
  await assert.rejects(p.getPrices('7203', '2026-01-01'), (e: ProviderError) => e.code === 'invalid_response')
})

test('財務: 単位検証・昇順化・四半期の最新取得', async () => {
  const period = (fy: string, extra: Record<string, unknown> = {}) => ({ fiscal_year: fy, sales: 100, operating_profit: 10, net_income: 5, total_assets: 200, net_assets: 100, operating_cf: 8, investing_cf: -3, ...extra })
  const p = providerWith({
    '/financials': {
      fields: [{ key: 'sales', unit: 'jpy' }, { key: 'eps', unit: 'jpy_per_share' }],
      periods: [period('2025/03', { eps_computed_adjusted: 12.5, cash_and_deposits_bs: 7 }), period('2024/03')],
    },
  })
  const r = await p.getFinancials('7203', 'E02144')
  assert.deepEqual(r.data.annual.map((x) => x.fiscalYear), ['2024/03', '2025/03'])
  assert.equal(r.data.annual[1]!.epsAdjusted, 12.5)
  assert.equal(r.data.annual[1]!.cash, 7)
  assert.equal(r.data.annual[0]!.cash, null)
  const bad = providerWith({ '/financials': { fields: [{ key: 'sales', unit: 'million_jpy' }], periods: [] } })
  await assert.rejects(bad.getFinancials('7203', null), (e: ProviderError) => e.code === 'invalid_response')
})

test('既定の fetch は this を変えずに呼ばれる(Workers の Illegal invocation 回避)', async () => {
  const orig = globalThis.fetch
  let thisOk = false
  globalThis.fetch = function (this: unknown) {
    thisOk = this === undefined || this === globalThis
    if (!thisOk) throw new TypeError('Illegal invocation')
    return Promise.resolve(new Response('{"ok":true}', { status: 200 }))
  } as unknown as typeof fetch
  try {
    const c = new IrbankClient('k') // 既定の fetch を使う
    assert.deepEqual(await c.get('/x'), { ok: true })
    assert.ok(thisOk)
  } finally {
    globalThis.fetch = orig
  }
})
