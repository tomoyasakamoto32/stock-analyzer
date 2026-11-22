import type { DocRef, Overall, PriceRange, Section, Snapshot, Usage, YieldPrice } from '../../../shared/types.ts'

type R = Record<string, unknown>
const isR = (v: unknown): v is R => typeof v === 'object' && v !== null && !Array.isArray(v)

function parse(json: string | null | undefined): unknown {
  if (!json) return null
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

const SECTION_ARRAYS = ['findings', 'bullishFactors', 'bearishFactors', 'risks', 'catalysts', 'missingData'] as const

/** D1 から読み出した JSON の最小限の形状検証。壊れていれば null。 */
export function parseSection(json: string | undefined): Section | null {
  const v = parse(json)
  if (!isR(v) || typeof v.summary !== 'string' || typeof v.outlook !== 'string') return null
  for (const k of SECTION_ARRAYS) if (!Array.isArray(v[k])) return null
  return v as unknown as Section
}

/** 旧形式(単一の entry)も読めるようにする。entries が無ければ空配列。 */
export function parseOverall(json: string | undefined): (Overall & { entry?: PriceRange | null; serverCalc?: { yieldPrices?: YieldPrice[]; yieldPricesForecast?: YieldPrice[] } }) | null {
  const v = parse(json)
  if (!isR(v) || typeof v.summary !== 'string' || typeof v.stance !== 'string') return null
  for (const k of ['scenarios', 'risks', 'contradictions', 'missingData'] as const) if (!Array.isArray(v[k])) return null
  if (!Array.isArray(v.entries)) v.entries = []
  return v as unknown as Overall & { entry?: PriceRange | null; serverCalc?: { yieldPrices?: YieldPrice[]; yieldPricesForecast?: YieldPrice[] } }
}

export function parseSnapshot(json: string | null): Snapshot | null {
  const v = parse(json)
  if (!isR(v) || !Array.isArray(v.evidence) || !isR(v.stock)) return null
  return v as unknown as Snapshot
}

export function parseUsage(json: string | null): Usage | null {
  const v = parse(json)
  return isR(v) ? (v as unknown as Usage) : null
}

export function parseStringArray(json: string | null): string[] {
  const v = parse(json)
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

export function parseSources(json: string | null): { dataset: string; sourceLabel: string; asOf: string | null }[] {
  const v = parse(json)
  if (!isR(v) || !Array.isArray(v.sources)) return []
  return v.sources.filter(isR).map((s) => ({
    dataset: String(s.dataset ?? ''),
    sourceLabel: String(s.sourceLabel ?? ''),
    asOf: typeof s.asOf === 'string' ? s.asOf : null,
  }))
}

/** 保存済みの「分析に使った開示書類」。形が不正な要素は捨てる。 */
export function parseDocuments(json: string | null): DocRef[] {
  const v = parse(json)
  if (!isR(v) || !Array.isArray(v.documents)) return []
  return v.documents
    .filter(isR)
    .filter((d) => typeof d.docId === 'string' && typeof d.title === 'string' && typeof d.disclosedAt === 'string')
    .map((d) => ({
      docId: d.docId as string,
      source: d.source === 'edinet' ? ('edinet' as const) : ('tdnet' as const),
      title: d.title as string,
      disclosedAt: d.disclosedAt as string,
      roles: Array.isArray(d.roles) ? d.roles.filter((x): x is string => typeof x === 'string') : [],
      pdfUrl: typeof d.pdfUrl === 'string' ? d.pdfUrl : null,
      sourceUrl: typeof d.sourceUrl === 'string' ? d.sourceUrl : null,
    }))
}
