import { likeSafe, searchKey, type Suggestion } from '../../../shared/search.ts'
import { nowIso } from '../../util/time.ts'

export type MasterRow = { code: string; name: string; market: string | null; industry: string | null }

/** 候補検索。コード完全一致 → コード前方一致 → 名前前方一致 → 名前部分一致 の順。 */
export async function searchMaster(db: D1Database, q: string, limit = 8): Promise<Suggestion[]> {
  const key = searchKey(q)
  const code = q.normalize('NFKC').trim().toUpperCase()
  if (key === '' && code === '') return []
  const codeLike = `${likeSafe(code)}%`
  const { results } = await db
    .prepare(
      `SELECT code, name, market, industry,
         CASE WHEN code = ?1 THEN 0 WHEN code LIKE ?2 ESCAPE '\\' THEN 1 WHEN name_key LIKE ?3 ESCAPE '\\' THEN 2 ELSE 3 END AS rank
       FROM securities_master
       WHERE code LIKE ?2 ESCAPE '\\' OR name_key LIKE ?4 ESCAPE '\\'
       ORDER BY rank, code LIMIT ?5`,
    )
    .bind(code, codeLike, `${likeSafe(key)}%`, `%${likeSafe(key)}%`, limit)
    .all<Suggestion>()
  return results.map((r) => ({ code: r.code, name: r.name, market: r.market, industry: r.industry }))
}

/** マスタが空の時の代替: すでに分析した銘柄から名前・コードで探す。 */
export async function searchAnalyzed(db: D1Database, q: string, limit = 8): Promise<Suggestion[]> {
  const t = q.normalize('NFKC').trim()
  if (t === '') return []
  const { results } = await db
    .prepare(`SELECT code, name, market, sector AS industry FROM stocks WHERE code LIKE ?1 ESCAPE '\\' OR name LIKE ?2 ESCAPE '\\' ORDER BY updated_at DESC LIMIT ?3`)
    .bind(`${likeSafe(t.toUpperCase())}%`, `%${likeSafe(t)}%`, limit)
    .all<Suggestion>()
  return results
}

export async function masterStatus(db: D1Database): Promise<{ count: number; updatedAt: string | null }> {
  const r = await db.prepare(`SELECT COUNT(*) AS n, MAX(updated_at) AS u FROM securities_master`).first<{ n: number; u: string | null }>()
  return { count: r?.n ?? 0, updatedAt: r?.u ?? null }
}

const CHUNK = 15 // D1 は1文あたりのバインド数が最大100のため、6列 × 15行 = 90

/** 1ページ分をまとめて登録(既存は更新)。 */
export async function upsertMaster(db: D1Database, rows: readonly MasterRow[]): Promise<void> {
  if (rows.length === 0) return
  const now = nowIso()
  const stmts: D1PreparedStatement[] = []
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK)
    const values = part.map((_, j) => `(?${j * 6 + 1},?${j * 6 + 2},?${j * 6 + 3},?${j * 6 + 4},?${j * 6 + 5},?${j * 6 + 6})`).join(',')
    const binds = part.flatMap((r) => [r.code, r.name, searchKey(r.name), r.market, r.industry, now])
    stmts.push(
      db
        .prepare(
          `INSERT INTO securities_master (code, name, name_key, market, industry, updated_at) VALUES ${values}
           ON CONFLICT(code) DO UPDATE SET name=excluded.name, name_key=excluded.name_key, market=excluded.market, industry=excluded.industry, updated_at=excluded.updated_at`,
        )
        .bind(...binds),
    )
  }
  await db.batch(stmts)
}
