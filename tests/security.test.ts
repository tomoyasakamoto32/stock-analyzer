import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accessConfigProblem, bypassAllowed, clearCertCache, verifyAccessJwt } from '../src/server/middleware/access-jwt.ts'
import { costLimitProblem } from '../src/server/services/analysis/cost.ts'
import { declaredBodyTooLarge } from '../src/shared/validate.ts'
import { IrbankClient } from '../src/server/services/providers/irbank/client.ts'
import { ProviderError } from '../src/server/services/providers/types.ts'

test('Access設定: TEAM_DOMAIN・AUD・OWNER_EMAIL がそろわなければ fail-closed(OWNER_EMAILも必須)', () => {
  assert.equal(accessConfigProblem({ teamDomain: 't', aud: 'a', ownerEmail: 'me@example.com' }), null)
  assert.match(accessConfigProblem({ teamDomain: 't', aud: 'a' })!, /OWNER_EMAIL/)
  assert.match(accessConfigProblem({ teamDomain: 't', aud: 'a', ownerEmail: '  ' })!, /OWNER_EMAIL/)
  assert.match(accessConfigProblem({ aud: 'a', ownerEmail: 'x@example.com' })!, /TEAM_DOMAIN/)
  assert.match(accessConfigProblem({ teamDomain: 't', ownerEmail: 'x@example.com' })!, /AUD/)
})

test('認証迂回: フラグが true かつ localhost の時だけ有効。他のホスト(偽装含む)では無効', () => {
  for (const host of ['localhost:8787', 'localhost', '127.0.0.1:8787', '[::1]:8787']) assert.equal(bypassAllowed('true', host), true, host)
  for (const host of ['stock.example.com', 'myapp.workers.dev', 'localhost.evil.example', '127.0.0.1.evil.example', 'evil.example:8787', 'localhost@evil.example', '']) assert.equal(bypassAllowed('true', host), false, host)
  for (const flag of [undefined, '', 'false', '1', 'yes']) assert.equal(bypassAllowed(flag, 'localhost:8787'), false, String(flag))
  assert.equal(bypassAllowed(' TRUE ', 'localhost'), true)
})

test('月間費用の上限: 単価が未設定だと上限が効かないため拒否する(設定が揃っていれば通す)', () => {
  const ok = { monthlyCostLimitUsd: 10, priceInputPerMtok: 1, priceOutputPerMtok: 4 }
  assert.equal(costLimitProblem(ok), null)
  assert.equal(costLimitProblem({ monthlyCostLimitUsd: null, priceInputPerMtok: null, priceOutputPerMtok: null }), null, '上限なしなら単価は不要')
  assert.match(costLimitProblem({ ...ok, priceInputPerMtok: null })!, /OPENAI_PRICE/)
  assert.match(costLimitProblem({ ...ok, priceOutputPerMtok: null })!, /上限が効かない/)
  assert.equal(costLimitProblem({ monthlyCostLimitUsd: 0, priceInputPerMtok: 1, priceOutputPerMtok: 1 }), null)
})

test('ボディサイズ: 宣言サイズが上限超なら本文を読む前に拒否。ヘッダーなし・不正は後段の検査に任せる', () => {
  assert.equal(declaredBodyTooLarge('3000', 2048), true)
  assert.equal(declaredBodyTooLarge('2048', 2048), false)
  assert.equal(declaredBodyTooLarge('100', 2048), false)
  for (const v of [undefined, null, '', 'abc', 'NaN']) assert.equal(declaredBodyTooLarge(v, 2048), false)
  assert.equal(declaredBodyTooLarge('999999999999', 2048), true)
})

test('IRBANKリクエスト: リダイレクトを自動追従せず(APIキーを他所へ送らない)、3xxは失敗として扱う', async () => {
  const seen: RequestInit[] = []
  const f = (async (_u: string, init: RequestInit) => {
    seen.push(init)
    return new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } })
  }) as unknown as typeof fetch
  const c = new IrbankClient('irbk_key', f, async () => {})
  await assert.rejects(c.get('/securities/7203'), (e: ProviderError) => e.code === 'unavailable')
  assert.equal(seen.length, 1, 'リダイレクト先へは再リクエストしない')
  assert.equal(seen[0]!.redirect, 'manual')
  await assert.rejects(c.getBinary('https://api.irbank.net/api/market-files/v1/x.pdf', 10), ProviderError)
  assert.equal(seen.at(-1)!.redirect, 'manual')
})

// ---- 偽のkidによる鍵の再取得を抑える ----
const b64u = (b: ArrayBuffer | Uint8Array | string) => Buffer.from(typeof b === 'string' ? new TextEncoder().encode(b) : new Uint8Array(b)).toString('base64url')

test('未知のkidのトークンを大量に送られても、Accessの鍵の再取得は一定間隔に1回まで', async () => {
  clearCertCache()
  const pair = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey & { kid?: string }
  let fetches = 0
  const fetchImpl = (async () => {
    fetches++
    return new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'real' }] }), { status: 200 })
  }) as unknown as typeof fetch
  const NOW = 1_800_000_000
  const forged = (kid: string) => {
    const h = b64u(JSON.stringify({ alg: 'RS256', kid }))
    const p = b64u(JSON.stringify({ iss: 'https://t.cloudflareaccess.com', aud: ['a'], exp: NOW + 600, email: 'x@example.com' }))
    return `${h}.${p}.${b64u('sig')}`
  }
  const cfg = { teamDomain: 't.cloudflareaccess.com', aud: 'a', ownerEmail: 'x@example.com' }
  for (let i = 0; i < 20; i++) {
    const r = await verifyAccessJwt(forged(`random-${i}`), cfg, { fetchImpl, nowSec: NOW })
    assert.deepEqual(r, { ok: false, reason: 'unknown_kid' })
  }
  assert.ok(fetches <= 2, `鍵の取得は初回+強制再取得1回まで(実際: ${fetches})`)
  clearCertCache()
})

import { parseDailyLimit } from '../src/server/services/analysis/cost.ts'

test('1日の実行回数の上限: 数値は上限あり、unlimited・0・空は無制限、不正値は安全側(上限あり)', () => {
  assert.equal(parseDailyLimit('5'), 5)
  assert.equal(parseDailyLimit(' 12 '), 12)
  assert.equal(parseDailyLimit('3.9'), 3)
  for (const v of ['unlimited', 'UNLIMITED', 'none', 'off', '0', '', '  ']) assert.equal(parseDailyLimit(v), null, `"${v}"`)
  assert.equal(parseDailyLimit(undefined), null, '未指定の既定は無制限(wrangler.jsonc の既定値も unlimited)')
  assert.equal(parseDailyLimit(undefined, 5), 5)
  for (const v of ['abc', '-1', 'NaN']) assert.equal(parseDailyLimit(v), 5, `不正値 "${v}" は上限ありに倒す`)
})
