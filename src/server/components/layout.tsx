import type { Child } from 'hono/jsx'

export function Layout(props: { title: string; children?: Child }) {
  return (
    <html lang="ja">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        <title>{props.title} | 日本株AI分析</title>
        <link rel="stylesheet" href="/assets/app.css" />
      </head>
      <body>
        <header class="site-header">
          <a href="/" class="brand">日本株AI分析</a>
          <nav class="site-nav" aria-label="サイト内移動">
            <a href="/">ホーム</a>
            <a href="/stocks">銘柄一覧</a>
            <a href="/reports">レポート履歴</a>
          </nav>
          <span class="muted">個人用・参考情報であり投資助言ではありません</span>
        </header>
        <main>{props.children}</main>
        <footer class="site-footer">
          <p>
            出典: 金融庁 EDINET / JPX TDnet / JPX 東京証券取引所 / 日本証券金融（加工: IRBANK）。各レポートにはレスポンスの attribution を表示しています。
          </p>
          <p>AIの出力は誤りを含む可能性があります。投資判断はご自身の責任で行ってください。</p>
        </footer>
        <script type="module" src="/assets/app.js"></script>
      </body>
    </html>
  )
}
