/** Cloudflare Access の JWT(Cf-Access-Jwt-Assertion)を署名・iss・aud・exp・nbf まで検証する。 */

export type JwtConfig = { teamDomain: string; aud: string; ownerEmail?: string }
export type JwtResult = { ok: true; email: string | null } | { ok: false; reason: string }

type Jwk = JsonWebKey & { kid?: string }
type Certs = { keys: Jwk[] }

const CERTS_TTL_MS = 60 * 60 * 1000
const certCache = new Map<string, { at: number; certs: Certs }>()

export function normalizeTeamDomain(raw: string): string {
  const d = raw.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
  return d.includes('.') ? d : `${d}.cloudflareaccess.com`
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')
  const bin = atob(b64)
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
function parseJson<T>(b64url: string): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(b64url))) as T
  } catch {
    return null
  }
}

async function getCerts(teamDomain: string, fetchImpl: typeof fetch, force = false): Promise<Certs> {
  const hit = certCache.get(teamDomain)
  if (!force && hit && Date.now() - hit.at < CERTS_TTL_MS) return hit.certs
  const res = await fetchImpl(`https://${teamDomain}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`certs fetch failed: ${res.status}`)
  const certs = (await res.json()) as Certs
  if (!Array.isArray(certs.keys)) throw new Error('certs malformed')
  certCache.set(teamDomain, { at: Date.now(), certs })
  return certs
}

export function clearCertCache() {
  certCache.clear()
}

export async function verifyAccessJwt(
  token: string | undefined | null,
  cfg: JwtConfig,
  opts: { fetchImpl?: typeof fetch; nowSec?: number } = {},
): Promise<JwtResult> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000)
  if (!token) return { ok: false, reason: 'missing_token' }
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed' }
  const [h, p, s] = parts as [string, string, string]
  const header = parseJson<{ alg?: string; kid?: string }>(h)
  const payload = parseJson<{ iss?: string; aud?: string | string[]; exp?: number; nbf?: number; iat?: number; email?: string }>(p)
  if (!header || !payload) return { ok: false, reason: 'malformed' }
  if (header.alg !== 'RS256') return { ok: false, reason: 'bad_alg' }

  const teamDomain = normalizeTeamDomain(cfg.teamDomain)
  let certs: Certs
  try {
    certs = await getCerts(teamDomain, fetchImpl)
    if (header.kid && !certs.keys.some((k) => k.kid === header.kid)) certs = await getCerts(teamDomain, fetchImpl, true) // 鍵ローテーション
  } catch {
    return { ok: false, reason: 'certs_unavailable' }
  }
  const jwk = certs.keys.find((k) => k.kid === header.kid)
  if (!jwk) return { ok: false, reason: 'unknown_kid' }

  let valid = false
  try {
    const sig = b64urlToBytes(s)
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
    valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, new TextEncoder().encode(`${h}.${p}`))
  } catch {
    return { ok: false, reason: 'bad_key' }
  }
  if (!valid) return { ok: false, reason: 'bad_signature' }

  if (payload.iss !== `https://${teamDomain}`) return { ok: false, reason: 'bad_issuer' }
  const auds = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : []
  if (!auds.includes(cfg.aud)) return { ok: false, reason: 'bad_audience' }
  if (typeof payload.exp !== 'number' || payload.exp <= now) return { ok: false, reason: 'expired' }
  if (typeof payload.nbf === 'number' && payload.nbf > now + 60) return { ok: false, reason: 'not_yet_valid' }

  const email = typeof payload.email === 'string' ? payload.email : null
  if (cfg.ownerEmail && (email ?? '').toLowerCase() !== cfg.ownerEmail.trim().toLowerCase()) {
    return { ok: false, reason: 'not_owner' }
  }
  return { ok: true, email }
}
