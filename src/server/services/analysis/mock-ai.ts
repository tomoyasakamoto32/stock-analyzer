import { fmtEvidenceValue } from '../../util/format.ts'
import type { AnalysisOutput, Evidence, Finding, Outlook, Section, SectionType, Snapshot } from '../../../shared/types.ts'
import type { AiResult } from './openai.ts'

/**
 * 外部送信を行わない決定論的なダミー分析。
 * 実際のAI品質の検証には使えない(配線・保存・表示・検証ロジックの確認用)。
 */
export function mockAnalysis(snapshot: Snapshot): AiResult & { output: AnalysisOutput } {
  const byId = new Map(snapshot.evidence.map((e) => [e.id, e]))
  const val = (id: string) => {
    const v = byId.get(id)?.value
    return typeof v === 'number' ? v : null
  }
  const f = (text: string, ...ids: string[]): Finding => ({ text, evidenceIds: ids.filter((i) => byId.has(i)) })
  const fmt = (n: number | null, d = 1) => (n == null ? '算出不可' : n.toFixed(d))
  const ofCat = (c: SectionType): Evidence[] => snapshot.evidence.filter((e) => e.category === c)

  const rsi = val('tech.rsi14')
  const close = val('tech.sma5') != null ? val('price.close') : val('price.close')
  const sma25 = val('tech.sma25')
  const techOutlook: Outlook = rsi == null || sma25 == null || close == null ? 'insufficient_data' : close > sma25 ? 'positive' : 'negative'
  const per = val('val.per')
  const yld = val('val.dividend_yield')

  const sec = (type: SectionType, outlook: Outlook, summary: string, findings: Finding[], missing: string[] = []): Section => ({
    type,
    outlook,
    summary: `[モック] ${summary}`,
    findings,
    bullishFactors: [f('[モック] 強気材料のダミー', ofCat(type)[0]?.id ?? 'price.close')],
    bearishFactors: [f('[モック] 弱気材料のダミー', ofCat(type)[1]?.id ?? 'price.close')],
    risks: [f('[モック] リスクのダミー', ofCat(type)[0]?.id ?? 'price.close')],
    catalysts: [],
    missingData: missing,
  })

  const sections: Section[] = [
    sec('fundamental', per == null ? 'insufficient_data' : 'neutral', `実績PER ${fmt(per)}倍、配当利回り ${fmt(yld, 2)}%。`, [f(`実績PER ${fmt(per)}倍`, 'val.per'), f(`PBR ${fmt(val('val.pbr'), 2)}倍`, 'val.pbr')], ['業績予想(未取得)']),
    sec('technical', techOutlook, `RSI(14) ${fmt(rsi)}、25日線との位置で判定。`, [f(`RSI ${fmt(rsi)}`, 'tech.rsi14'), f(`25日線乖離 ${fmt(val('tech.deviation25'))}%`, 'tech.deviation25')]),
    sec('supply_demand', byId.has('sd.margin_ratio') ? 'neutral' : 'insufficient_data', `信用倍率 ${fmt(val('sd.margin_ratio'))}倍。`, [f(`信用倍率 ${fmt(val('sd.margin_ratio'))}倍`, 'sd.margin_ratio')], ['機関空売り(未取得)']),
    sec('financial', 'neutral', '直近期の利益率・自己資本比率を確認。', evidenceFirst(snapshot, 'financial', f), snapshot.isFinancialInstitution ? ['金融機関のため一部指標は非適用'] : []),
  ]

  const dps = val('val.dps')
  const price = val('price.close')
  const range = (lo: number | null, hi: number | null, why: string) =>
    lo != null && hi != null && lo > 0 && hi > 0 ? { low: Math.min(lo, hi), high: Math.max(lo, hi), rationale: `[モック] ${why}`, evidenceIds: ['price.close'] } : null
  const pre = val('ref.value_per_fc.avg') != null ? 'ref.value_per_fc' : 'ref.value_per_act'
  const fairRange = range(val(`${pre}.min`) != null && val(`${pre}.avg`) != null ? Math.min(val(`${pre}.min`)!, val(`${pre}.avg`)!) : null, val(`${pre}.avg`), `過去5期末PERの最小〜平均 × EPSのダミー目安(${pre})`)
  if (fairRange) fairRange.evidenceIds = [`${pre}.min`, `${pre}.avg`]
  const output: AnalysisOutput = {
    sections,
    overall: {
      summary: '[モック] これは外部AIを呼び出さないダミー総評です。数値の解釈は行っていません。',
      stance: 'wait',
      fairValue: fairRange,
      entries: mockTiers(price),
      takeProfit: range(val('tech.high20'), val('tech.high60'), '直近20〜60日高値付近(ダミー)'),
      stopLoss: range(price != null ? price * 0.88 : null, price != null ? price * 0.9 : null, 'ダミーの損切り水準'),
      scenarios: (['bull', 'base', 'bear'] as const).map((name) => ({ name, conditions: `[モック] ${name} 条件`, outlook: '[モック] 見通し', evidenceIds: ['price.close'] })),
      risks: [f('[モック] 市場全体の下落リスク', 'price.close')],
      contradictions: dps == null ? [] : ['[モック] 短期テクニカルと中長期配当利回りの見方が分かれる可能性'],
      missingData: ['機関空売り・最新IR・業績予想は未取得'],
    },
  }
  return { output, json: output, model: 'mock', usage: { inputTokens: null, outputTokens: null, totalTokens: null, reasoningTokens: null } }
}

function mockTiers(price: number | null) {
  if (price == null || !(price > 0)) return []
  const t = (hiPct: number, loPct: number, alloc: number, why: string) => ({
    low: Math.round(price * loPct), high: Math.round(price * hiPct), allocationPct: alloc, rationale: `[モック] ${why}`, evidenceIds: ['price.close'],
  })
  return [t(0.98, 0.95, 30, '終値の2〜5%下(ダミー・打診)'), t(0.94, 0.9, 40, '終値の6〜10%下(ダミー・本命)'), t(0.89, 0.85, 30, '終値の11〜15%下(ダミー・深め)')]
}

function evidenceFirst(s: Snapshot, c: SectionType, f: (t: string, ...ids: string[]) => Finding): Finding[] {
  return s.evidence.filter((e) => e.category === c && e.value != null).slice(0, 3).map((e) => f(`${e.label}: ${fmtEvidenceValue(e.value, e.unit)}`, e.id))
}
