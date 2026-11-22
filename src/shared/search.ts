/**
 * 銘柄名の検索用キー。全角半角・英大小文字・カタカナ/ひらがな・空白や記号の差を吸収する。
 * 例: "フジクラ" / "ふじくら" / "ﾌｼﾞｸﾗ" はいずれも同じキーになる。
 */
export function searchKey(input: string): string {
  const nfkc = input.normalize('NFKC').toLowerCase()
  let out = ''
  for (const ch of nfkc) {
    const cp = ch.codePointAt(0)!
    // カタカナ(ァ〜ヶ)をひらがなへ
    if (cp >= 0x30a1 && cp <= 0x30f6) out += String.fromCodePoint(cp - 0x60)
    else if (/[\s・･\-‐－–—'’"“”()（）[\]【】「」『』,，.．、。/／&＆]/.test(ch)) continue
    else out += ch
  }
  return out
}

export type Suggestion = { code: string; name: string; market: string | null; industry: string | null }

/** 入力欄の内容と選択状態から、分析する銘柄コードを決める。決められなければ null と理由。 */
export function resolveCode(
  text: string,
  selected: Suggestion | null,
  suggestions: readonly Suggestion[],
): { code: string | null; reason: string | null } {
  const t = text.trim()
  const direct = t.toUpperCase()
  if (/^[0-9A-Z]{4}$/.test(direct)) return { code: direct, reason: null }
  if (selected && (t === selected.name || t === `${selected.code} ${selected.name}`)) return { code: selected.code, reason: null }
  if (suggestions.length === 1) return { code: suggestions[0]!.code, reason: null }
  const key = searchKey(t)
  const exact = suggestions.filter((s) => searchKey(s.name) === key)
  if (exact.length === 1) return { code: exact[0]!.code, reason: null }
  if (t === '') return { code: null, reason: '銘柄コードまたは銘柄名を入力してください' }
  return { code: null, reason: suggestions.length === 0 ? '該当する銘柄が見つかりません。4桁のコードで入力するか、銘柄一覧で銘柄マスタを更新してください' : '候補から銘柄を選択してください' }
}

export const esc = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`)

/**
 * D1 の LIKE パターンは 50 バイトまで(超えると "LIKE or GLOB pattern too complex")。
 * 前後の % を付けても収まるよう、エスケープ後のバイト数が上限に収まる長さで切る(日本語は1文字3バイト)。
 */
const LIKE_BODY_MAX_BYTES = 46
export function likeSafe(s: string): string {
  const enc = new TextEncoder()
  let out = ''
  let bytes = 0
  for (const ch of s) {
    const piece = esc(ch)
    const n = enc.encode(piece).length
    if (bytes + n > LIKE_BODY_MAX_BYTES) break
    out += piece
    bytes += n
  }
  return out
}

