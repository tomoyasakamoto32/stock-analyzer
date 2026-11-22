import type { MiddlewareHandler } from 'hono'
import type { Env } from '../env.ts'
import { accessConfigProblem, bypassAllowed, verifyAccessJwt } from './access-jwt.ts'

/** 全ルート(静的アセット含む)に適用。設定不備は fail-closed(503)。 */
export const requireAccess: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const env = c.env
  const url = new URL(c.req.url)

  // ローカル開発専用の迂回。localhost 以外では無効。
  if (bypassAllowed(env.DEV_AUTH_BYPASS, url.host)) return next()
  const problem = accessConfigProblem({ teamDomain: env.CLOUDFLARE_ACCESS_TEAM_DOMAIN!, aud: env.CLOUDFLARE_ACCESS_AUD!, ownerEmail: env.OWNER_EMAIL })
  if (problem) {
    console.warn('auth not configured:', problem) // 詳細はログのみ。応答には出さない
    return c.json({ error: { code: 'auth_not_configured', message: '認証設定が未完了です' } }, 503)
  }
  const result = await verifyAccessJwt(
    c.req.header('Cf-Access-Jwt-Assertion'),
    { teamDomain: env.CLOUDFLARE_ACCESS_TEAM_DOMAIN!, aud: env.CLOUDFLARE_ACCESS_AUD!, ownerEmail: env.OWNER_EMAIL },
  )
  if (!result.ok) {
    // 理由はログのみ。応答には詳細を出さない。
    console.warn('access denied', result.reason)
    return c.json({ error: { code: 'unauthorized', message: '認証が必要です' } }, 401)
  }
  return next()
}
