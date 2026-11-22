import type { MiddlewareHandler } from 'hono'
import type { Env } from '../env.ts'
import { verifyAccessJwt } from './access-jwt.ts'

const isLocalHost = (host: string) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)

/** 全ルート(静的アセット含む)に適用。設定不備は fail-closed(503)。 */
export const requireAccess: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const env = c.env
  const url = new URL(c.req.url)

  // ローカル開発専用の迂回。localhost 以外では無効。
  if (env.DEV_AUTH_BYPASS?.trim().toLowerCase() === 'true' && isLocalHost(url.host)) {
    return next()
  }
  if (!env.CLOUDFLARE_ACCESS_TEAM_DOMAIN || !env.CLOUDFLARE_ACCESS_AUD) {
    return c.json({ error: { code: 'auth_not_configured', message: '認証設定が未完了です' } }, 503)
  }
  const result = await verifyAccessJwt(
    c.req.header('Cf-Access-Jwt-Assertion'),
    { teamDomain: env.CLOUDFLARE_ACCESS_TEAM_DOMAIN, aud: env.CLOUDFLARE_ACCESS_AUD, ownerEmail: env.OWNER_EMAIL },
  )
  if (!result.ok) {
    // 理由はログのみ。応答には詳細を出さない。
    console.warn('access denied', result.reason)
    return c.json({ error: { code: 'unauthorized', message: '認証が必要です' } }, 401)
  }
  return next()
}
