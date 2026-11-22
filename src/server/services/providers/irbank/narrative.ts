/** 開示書類(HTML)の本文を、AI入力・表示用のプレーンテキスト抜粋にする。 */

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

export function htmlToText(html: string): string {
  let t = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|tr|li|table)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  t = t.replace(/&#(\d+);/g, (_, n: string) => safeChar(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeChar(parseInt(h, 16)))
  t = t.replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
  return t
    .replace(/[ \t 　]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}
function safeChar(cp: number): string {
  if (!Number.isFinite(cp) || cp < 32 || cp > 0x10ffff) return ' '
  return String.fromCodePoint(cp)
}

/** 先頭から maxChars まで。文の区切り(。)で切れるときは区切りまで戻す。 */
export function excerpt(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  const cut = text.slice(0, maxChars)
  const end = cut.lastIndexOf('。')
  return { text: (end > maxChars * 0.6 ? cut.slice(0, end + 1) : cut) + '…', truncated: true }
}

/** 定期報告書(訂正・内部統制報告書・臨時報告書は除く) */
export function periodicKind(title: string): 'yuho' | 'half' | 'quarter' | null {
  if (/訂正/.test(title)) return null
  if (/^有価証券報告書/.test(title)) return 'yuho'
  if (/^半期報告書/.test(title)) return 'half'
  if (/^四半期報告書/.test(title)) return 'quarter'
  return null
}

const CJK = /[぀-ヿ㐀-鿿]/
/** 最近のIR見出しに使う適時開示か(英文の重複開示・決算短信本体は除く) */
export function isIrHeadline(title: string): boolean {
  return CJK.test(title) && !/決算短信/.test(title)
}
