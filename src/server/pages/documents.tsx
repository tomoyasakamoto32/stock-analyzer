import type { DocRef } from '../../shared/types.ts'
import { formatJst } from '../util/time.ts'

const KIND = (d: DocRef) => (d.source === 'tdnet' ? '適時開示(決算短信)' : /^有価証券報告書/.test(d.title) ? '有価証券報告書' : /^半期報告書/.test(d.title) ? '半期報告書' : /^四半期報告書/.test(d.title) ? '四半期報告書' : '報告書')
const httpsOnly = (u: string | null) => (u && u.startsWith('https://') ? u : null)

/**
 * 分析に使った開示書類。PDFはアプリの中継ルート(/documents/:docId/pdf)経由で開く
 * (取得元のURLはAPIキーが必要で、ブラウザからは直接開けない)。
 */
export function DocumentList(props: { docs: DocRef[]; heading?: string }) {
  if (props.docs.length === 0) return null
  return (
    <section class="card">
      <h2>{props.heading ?? '分析に使った開示書類'}</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>種別</th>
              <th>文書名</th>
              <th>開示日</th>
              <th>使った内容</th>
              <th>確認</th>
            </tr>
          </thead>
          <tbody>
            {props.docs.map((d) => (
              <tr>
                <td>{KIND(d)}</td>
                <td>{d.title}</td>
                <td>{formatJst(d.disclosedAt).slice(0, 10)}</td>
                <td class="small">{d.roles.join(' / ')}</td>
                <td class="small">
                  {d.pdfUrl ? (
                    <a href={`/documents/${encodeURIComponent(d.docId)}/pdf`} target="_blank" rel="noopener">
                      PDFを開く
                    </a>
                  ) : (
                    <span class="muted">PDFなし</span>
                  )}
                  {httpsOnly(d.sourceUrl) && (
                    <>
                      {' / '}
                      <a href={httpsOnly(d.sourceUrl)!} target="_blank" rel="noopener noreferrer nofollow">
                        原本
                      </a>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p class="muted small">PDFはデータ提供元から取得して表示します(開くたびに提供元へのリクエストを1回使います)。開示の原文と、AIの要約・引用を見比べて確認してください。</p>
    </section>
  )
}
