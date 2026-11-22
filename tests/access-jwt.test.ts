import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { clearCertCache, normalizeTeamDomain, verifyAccessJwt } from '../src/server/middleware/access-jwt.ts'

const TEAM = 'myteam.cloudflareaccess.com'
const AUD = 'aud-123'
const NOW = 1_800_000_000

const b64u = (b: ArrayBuffer | Uint8Array | string) => {
  const bytes = typeof b === 'string' ? new TextEncoder().encode(b) : new Uint8Array(b)
  return Buffer.from(bytes).toString('base64url')
}

async function makeKey() {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey & { kid?: string }
  return { pair, jwk }
}

async function sign(priv: CryptoKey, payload: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', kid: 'k1' }) {
  const h = b64u(JSON.stringify(header))
  const p = b64u(JSON.stringify(payload))
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', priv, new TextEncoder().encode(`${h}.${p}`))
  return `${h}.${p}.${b64u(sig)}`
}

const good = { iss: `https://${TEAM}`, aud: [AUD], exp: NOW + 600, nbf: NOW - 10, email: 'owner@example.com' }
const cfg = { teamDomain: TEAM, aud: AUD, ownerEmail: 'owner@example.com' }

let keys: Awaited<ReturnType<typeof makeKey>>
let other: Awaited<ReturnType<typeof makeKey>>
let calls = 0
const fetchImpl = (async () => {
  calls++
  return new Response(JSON.stringify({ keys: [{ ...keys.jwk, kid: 'k1' }] }), { status: 200 })
}) as unknown as typeof fetch

beforeEach(async () => {
  clearCertCache()
  calls = 0
  keys = keys ?? (await makeKey())
  other = other ?? (await makeKey())
})

test('正しいJWTは通る', async () => {
  const t = await sign(keys.pair.privateKey, good)
  const r = await verifyAccessJwt(t, cfg, { fetchImpl, nowSec: NOW })
  assert.deepEqual(r, { ok: true, email: 'owner@example.com' })
})

test('トークンなし・形式不正は拒否', async () => {
  assert.deepEqual(await verifyAccessJwt(undefined, cfg, { fetchImpl, nowSec: NOW }), { ok: false, reason: 'missing_token' })
  assert.equal((await verifyAccessJwt('a.b', cfg, { fetchImpl, nowSec: NOW })).ok, false)
  assert.equal((await verifyAccessJwt('a.b.c', cfg, { fetchImpl, nowSec: NOW })).ok, false)
})

test('署名不正(別の鍵で署名)は拒否', async () => {
  const t = await sign(other.pair.privateKey, good)
  assert.deepEqual(await verifyAccessJwt(t, cfg, { fetchImpl, nowSec: NOW }), { ok: false, reason: 'bad_signature' })
})

test('改ざんされたペイロードは拒否', async () => {
  const t = await sign(keys.pair.privateKey, good)
  const [h, , s] = t.split('.') as [string, string, string]
  const forged = `${h}.${b64u(JSON.stringify({ ...good, email: 'attacker@example.com' }))}.${s}`
  assert.equal((await verifyAccessJwt(forged, { ...cfg, ownerEmail: undefined }, { fetchImpl, nowSec: NOW })).ok, false)
})

test('alg=none / HS256 は拒否', async () => {
  const none = `${b64u(JSON.stringify({ alg: 'none' }))}.${b64u(JSON.stringify(good))}.`
  assert.deepEqual(await verifyAccessJwt(none, cfg, { fetchImpl, nowSec: NOW }), { ok: false, reason: 'bad_alg' })
  const hs = `${b64u(JSON.stringify({ alg: 'HS256', kid: 'k1' }))}.${b64u(JSON.stringify(good))}.x`
  assert.deepEqual(await verifyAccessJwt(hs, cfg, { fetchImpl, nowSec: NOW }), { ok: false, reason: 'bad_alg' })
})

test('期限切れ・audience・issuer・本人以外は拒否', async () => {
  const k = keys.pair.privateKey
  assert.deepEqual(await verifyAccessJwt(await sign(k, { ...good, exp: NOW - 1 }), cfg, { fetchImpl, nowSec: NOW }), { ok: false, reason: 'expired' })
  assert.deepEqual(await verifyAccessJwt(await sign(k, { ...good, aud: ['other'] }), cfg, { fetchImpl, nowSec: NOW }), { ok: false, reason: 'bad_audience' })
  assert.deepEqual(await verifyAccessJwt(await sign(k, { ...good, iss: 'https://evil.example.com' }), cfg, { fetchImpl, nowSec: NOW }), { ok: false, reason: 'bad_issuer' })
  assert.deepEqual(await verifyAccessJwt(await sign(k, { ...good, email: 'someone@example.com' }), cfg, { fetchImpl, nowSec: NOW }), { ok: false, reason: 'not_owner' })
  assert.deepEqual(await verifyAccessJwt(await sign(k, { ...good, nbf: NOW + 3600 }), cfg, { fetchImpl, nowSec: NOW }), { ok: false, reason: 'not_yet_valid' })
})

test('公開鍵は取得結果をキャッシュする / 取得失敗は fail-closed', async () => {
  const t = await sign(keys.pair.privateKey, good)
  await verifyAccessJwt(t, cfg, { fetchImpl, nowSec: NOW })
  await verifyAccessJwt(t, cfg, { fetchImpl, nowSec: NOW })
  assert.equal(calls, 1)
  clearCertCache()
  const failing = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch
  assert.deepEqual(await verifyAccessJwt(t, cfg, { fetchImpl: failing, nowSec: NOW }), { ok: false, reason: 'certs_unavailable' })
})

test('チームドメインの正規化', () => {
  assert.equal(normalizeTeamDomain('myteam'), 'myteam.cloudflareaccess.com')
  assert.equal(normalizeTeamDomain('https://myteam.cloudflareaccess.com/'), 'myteam.cloudflareaccess.com')
})
