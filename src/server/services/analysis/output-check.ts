import { MAX_ENTRY_TIERS, SECTION_TYPES, type AnalysisOutput, type EntryTier, type Finding, type Overall, type PriceRange, type Section } from '../../../shared/types.ts'
import { AnalysisError } from './errors.ts'

type R = Record<string, unknown>
const isR = (v: unknown): v is R => typeof v === 'object' && v !== null && !Array.isArray(v)
function fail(msg: string): never {
  throw new AnalysisError('invalid_ai_output', `AI出力の検証に失敗: ${msg}`)
}
const OUTLOOKS = ['positive', 'neutral', 'negative', 'insufficient_data']
const STANCES = ['consider', 'wait', 'avoid', 'insufficient_data']
const SCENARIOS = ['bull', 'base', 'bear']

function strOf(v: unknown, path: string): string {
  return typeof v === 'string' ? v : fail(`${path} が文字列でない`)
}
function strArr(v: unknown, path: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) fail(`${path} が文字列配列でない`)
  return v as string[]
}
function evIds(v: unknown, path: string, known: ReadonlySet<string>): string[] {
  const ids = strArr(v, path)
  for (const id of ids) if (!known.has(id)) fail(`${path} に存在しない evidence ID "${id}"`)
  return ids
}
function findings(v: unknown, path: string, known: ReadonlySet<string>): Finding[] {
  if (!Array.isArray(v)) fail(`${path} が配列でない`)
  return v.map((x, i) => {
    if (!isR(x)) fail(`${path}[${i}] がオブジェクトでない`)
    return { text: strOf(x.text, `${path}[${i}].text`), evidenceIds: evIds(x.evidenceIds, `${path}[${i}].evidenceIds`, known) }
  })
}
function priceRange(v: unknown, path: string, known: ReadonlySet<string>): PriceRange | null {
  if (v === null) return null
  if (!isR(v)) return fail(`${path} がオブジェクトまたは null でない`)
  const { low, high } = v
  if (typeof low !== 'number' || typeof high !== 'number' || !Number.isFinite(low) || !Number.isFinite(high)) fail(`${path} の low/high が数値でない`)
  if (!(low > 0) || !(high > 0)) fail(`${path} の low/high が正値でない`)
  if (low > high) fail(`${path} の low が high を超えている`)
  return { low, high, rationale: strOf(v.rationale, `${path}.rationale`), evidenceIds: evIds(v.evidenceIds, `${path}.evidenceIds`, known) }
}

/** 分割エントリー: 1〜4段階、浅い(高い)順で重ならない、配分は正で合計100。 */
function entryTiers(v: unknown, path: string, known: ReadonlySet<string>): EntryTier[] {
  if (!Array.isArray(v)) return fail(`${path} が配列でない`)
  if (v.length > MAX_ENTRY_TIERS) fail(`${path} が${MAX_ENTRY_TIERS}段階を超えている`)
  const tiers = v.map((x, i) => {
    const r = priceRange(x, `${path}[${i}]`, known)
    if (!r) return fail(`${path}[${i}] が null`)
    const a = (x as Record<string, unknown>).allocationPct
    if (typeof a !== 'number' || !Number.isFinite(a) || !(a > 0) || a > 100) fail(`${path}[${i}].allocationPct が 0〜100 の正の数でない`)
    return { ...r, allocationPct: a }
  })
  for (let i = 1; i < tiers.length; i++) {
    // 浅い(高い)順で、隣り合う価格帯が重ならない(接するのは可)
    if (tiers[i]!.high > tiers[i - 1]!.low) fail(`${path} の価格帯が高い順・非重複になっていない(${i})`)
  }
  if (tiers.length > 0) {
    const sum = tiers.reduce((a, t) => a + t.allocationPct, 0)
    if (Math.abs(sum - 100) > 0.5) fail(`${path} の配分の合計が100でない(${sum})`)
  }
  return tiers
}

/** 4観点の重複・欠落、evidence ID の実在、価格レンジの順序・正値を検証する。 */
export function checkOutput(raw: unknown, knownEvidenceIds: ReadonlySet<string>): AnalysisOutput {
  if (!isR(raw)) fail('ルートがオブジェクトでない')
  if (!Array.isArray(raw.sections)) fail('sections が配列でない')
  const seen = new Set<string>()
  const sections: Section[] = raw.sections.map((s, i) => {
    if (!isR(s)) fail(`sections[${i}] がオブジェクトでない`)
    const type = s.type
    if (typeof type !== 'string' || !(SECTION_TYPES as readonly string[]).includes(type)) fail(`sections[${i}].type が不正`)
    if (seen.has(type)) fail(`観点 ${type} が重複`)
    seen.add(type)
    if (typeof s.outlook !== 'string' || !OUTLOOKS.includes(s.outlook)) fail(`sections[${i}].outlook が不正`)
    const p = `sections[${i}]`
    return {
      type: type as Section['type'],
      outlook: s.outlook as Section['outlook'],
      summary: strOf(s.summary, `${p}.summary`),
      findings: findings(s.findings, `${p}.findings`, knownEvidenceIds),
      bullishFactors: findings(s.bullishFactors, `${p}.bullishFactors`, knownEvidenceIds),
      bearishFactors: findings(s.bearishFactors, `${p}.bearishFactors`, knownEvidenceIds),
      risks: findings(s.risks, `${p}.risks`, knownEvidenceIds),
      catalysts: findings(s.catalysts, `${p}.catalysts`, knownEvidenceIds),
      missingData: strArr(s.missingData, `${p}.missingData`),
    }
  })
  for (const t of SECTION_TYPES) if (!seen.has(t)) fail(`観点 ${t} が欠落`)

  const o = raw.overall
  if (!isR(o)) fail('overall がオブジェクトでない')
  if (typeof o.stance !== 'string' || !STANCES.includes(o.stance)) fail('overall.stance が不正')
  if (!Array.isArray(o.scenarios)) fail('overall.scenarios が配列でない')
  const scenarios = o.scenarios.map((x, i) => {
    if (!isR(x)) fail(`overall.scenarios[${i}] がオブジェクトでない`)
    if (typeof x.name !== 'string' || !SCENARIOS.includes(x.name)) fail(`overall.scenarios[${i}].name が不正`)
    return {
      name: x.name as 'bull' | 'base' | 'bear',
      conditions: strOf(x.conditions, `overall.scenarios[${i}].conditions`),
      outlook: strOf(x.outlook, `overall.scenarios[${i}].outlook`),
      evidenceIds: evIds(x.evidenceIds, `overall.scenarios[${i}].evidenceIds`, knownEvidenceIds),
    }
  })
  const overall: Overall = {
    summary: strOf(o.summary, 'overall.summary'),
    stance: o.stance as Overall['stance'],
    fairValue: priceRange(o.fairValue, 'overall.fairValue', knownEvidenceIds),
    entries: entryTiers(o.entries, 'overall.entries', knownEvidenceIds),
    takeProfit: priceRange(o.takeProfit, 'overall.takeProfit', knownEvidenceIds),
    stopLoss: priceRange(o.stopLoss, 'overall.stopLoss', knownEvidenceIds),
    scenarios,
    risks: findings(o.risks, 'overall.risks', knownEvidenceIds),
    contradictions: strArr(o.contradictions, 'overall.contradictions'),
    missingData: strArr(o.missingData, 'overall.missingData'),
  }
  return { sections, overall }
}
