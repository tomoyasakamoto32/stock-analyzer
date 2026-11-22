import type { AppConfig, Env } from '../../env.ts'
import type { AnalysisOutput, InvestmentStyle, RunSummary, Usage } from '../../../shared/types.ts'
import { MockProvider } from '../providers/mock/index.ts'
import { IrbankProvider } from '../providers/irbank/index.ts'
import { ProviderError, type MarketDataProvider } from '../providers/types.ts'
import { collect } from './collect.ts'
import { buildSnapshot, CALCULATOR_VERSION } from './snapshot.ts'
import { buildUserInput, PROMPT_VERSION } from './prompt.ts'
import { SCHEMA_VERSION } from './schema.ts'
import { callOpenAI, type AiResult } from './openai.ts'
import { mockAnalysis } from './mock-ai.ts'
import { checkOutput } from './output-check.ts'
import { estimateCost } from './cost.ts'
import { AnalysisError } from './errors.ts'
import { callResearch, researchInput, researchToEvidence } from './web-research.ts'
import { MAX_PDF_BYTES, summarizeTanshinPdf, tanshinToEvidence } from './tanshin-pdf.ts'
import { jstDate } from '../../util/time.ts'
import * as runs from '../../db/repositories/runs.ts'

export function makeProvider(env: Env, cfg: AppConfig): MarketDataProvider {
  if (cfg.dataSource === 'irbank') {
    if (!env.IRBANK_API_KEY) throw new AnalysisError('config_error', 'DATA_SOURCE=irbank ですが IRBANK_API_KEY が未設定です')
    return new IrbankProvider(env.IRBANK_API_KEY)
  }
  return new MockProvider()
}

export type StartResult =
  | { kind: 'existing'; run: RunSummary }
  | { kind: 'rejected'; code: 'daily_limit' | 'monthly_cost_limit'; message: string }
  | { kind: 'created'; id: string }

/** 上限チェックと run 作成(一意制約で二重課金を防ぐ)。 */
export async function startRun(
  db: D1Database,
  cfg: AppConfig,
  p: { key: string; code: string; style: InvestmentStyle },
): Promise<StartResult> {
  await runs.markStaleRuns(db)
  const existing = await runs.findByKey(db, p.key)
  if (existing) return { kind: 'existing', run: existing }

  if ((await runs.countToday(db)) >= cfg.dailyLimit) {
    return { kind: 'rejected', code: 'daily_limit', message: `本日の分析回数の上限(${cfg.dailyLimit}回)に達しました` }
  }
  if (cfg.monthlyCostLimitUsd != null && (await runs.monthCostUsd(db)) >= cfg.monthlyCostLimitUsd) {
    return { kind: 'rejected', code: 'monthly_cost_limit', message: `今月の推定費用が上限(${cfg.monthlyCostLimitUsd} USD)に達しました` }
  }
  const id = crypto.randomUUID()
  const created = await runs.insertRun(db, { id, key: p.key, code: p.code, style: p.style, dataSource: cfg.dataSource, aiMode: cfg.aiMode })
  if (!created) {
    // 同時リクエストで先に作られた
    const again = await runs.findByKey(db, p.key)
    if (again) return { kind: 'existing', run: again }
  }
  return { kind: 'created', id }
}

/** 収集→計算→AI→検証→保存。失敗は failed として記録し、成功扱いにしない。 */
export async function executeRun(
  env: Env,
  cfg: AppConfig,
  id: string,
  code: string,
  style: InvestmentStyle,
  opts: { webSearch?: boolean } = {},
): Promise<void> {
  const db = env.DB
  try {
    // 実データは、外部AI送信が許可・設定済みの場合のみ処理する(利用条件未確認のまま保存しない)
    if (cfg.dataSource === 'irbank' && cfg.aiMode !== 'real') {
      throw new AnalysisError(
        'consent_required',
        'IRBANK実データの処理には ALLOW_EXTERNAL_AI_DATA=true と OPENAI_API_KEY/OPENAI_MODEL の設定が必要です。利用条件の確認が済むまでは DATA_SOURCE=mock を使用してください',
      )
    }
    const provider = makeProvider(env, cfg)
    const collected = await collect(provider, code)
    const snapshot = buildSnapshot(collected)

    await runs.setStatus(db, id, 'analyzing')

    // 決算短信PDFをAIで要約して、今期の業績の理由・予想の前提・修正理由を分析に加える(別のAI呼び出し)。失敗しても続行。
    let tanshin: Usage['tanshin'] | undefined
    let tanshinTokens = { inputTokens: null as number | null, outputTokens: null as number | null }
    const fcDoc = collected.forecast
    if (cfg.tanshinPdfEnabled) {
      if (fcDoc?.docId && fcDoc.pdfUrl && fcDoc.title) {
        try {
          const pdf = await provider.getDocumentPdf(fcDoc.pdfUrl, MAX_PDF_BYTES)
          if (!pdf) throw new AnalysisError('pdf_unavailable', '決算短信PDFを取得できません')
          const r = await summarizeTanshinPdf({ apiKey: env.OPENAI_API_KEY!, model: env.OPENAI_MODEL!, pdf, filename: `${fcDoc.docId}.pdf`, maxOutputTokens: cfg.maxOutputTokens })
          snapshot.evidence.push(
            tanshinToEvidence(r.summary, { title: fcDoc.title, disclosedJst: fcDoc.disclosedAt ? jstDate(new Date(fcDoc.disclosedAt)) : null }, snapshot.sources.find((s) => s.dataset === 'forecast')?.sourceLabel ?? 'JPX TDnet'),
          )
          tanshinTokens = r.usage
          tanshin = { used: true, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, error: null }
        } catch (e) {
          const msg = e instanceof AnalysisError || e instanceof ProviderError ? e.message : '決算短信PDFの要約に失敗しました'
          tanshin = { used: true, inputTokens: null, outputTokens: null, error: msg }
          snapshot.missingData.push(`決算短信の本文(PDF)の要約: 取得・要約できませんでした(${msg})`)
        }
      } else {
        snapshot.missingData.push('決算短信の本文(PDF)の要約: 対象の決算短信またはPDFが見つかりません')
      }
    }

    // 任意: Web検索で業界動向・最新ニュースを調べる(別のAI呼び出し)。失敗しても分析は続行し、不足情報に残す。
    let research: Usage['research'] | undefined
    let researchTokens = { inputTokens: null as number | null, outputTokens: null as number | null }
    if (opts.webSearch && cfg.webSearchEnabled) {
      try {
        const r = await callResearch({
          apiKey: env.OPENAI_API_KEY!,
          model: env.OPENAI_MODEL!,
          input: researchInput(snapshot.stock, jstDate()),
          maxOutputTokens: cfg.maxOutputTokens,
        })
        snapshot.evidence.push(...researchToEvidence(r.items))
        researchTokens = r.usage
        research = { used: true, searchCalls: r.searchCalls, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, items: r.items.length, error: null }
        if (r.items.length === 0) snapshot.missingData.push(`Web検索で業界動向・ニュースを確認できませんでした${r.notFound.length ? `(${r.notFound.join(' / ')})` : ''}`)
        if (r.dropped > 0) snapshot.missingData.push(`Web検索の結果のうち${r.dropped}件は、出典URLを検証できないため採用していません`)
      } catch (e) {
        const msg = e instanceof AnalysisError ? e.message : 'Web検索に失敗しました'
        research = { used: true, searchCalls: null, inputTokens: null, outputTokens: null, items: 0, error: msg }
        snapshot.missingData.push(`業界動向・最新ニュース: Web検索に失敗したため未確認(${msg})`)
      }
    } else {
      snapshot.missingData.push('業界動向・最新ニュース: Web検索を実施していないため未確認')
    }

    const evidenceIds = new Set(snapshot.evidence.map((e) => e.id))
    const input = buildUserInput(snapshot, style, cfg.maxInputChars)
    let ai: AiResult
    if (cfg.aiMode === 'real') {
      ai = await callOpenAI({ apiKey: env.OPENAI_API_KEY!, model: env.OPENAI_MODEL!, input, maxOutputTokens: cfg.maxOutputTokens })
    } else {
      ai = mockAnalysis(snapshot)
    }
    const output: AnalysisOutput = checkOutput(ai.json, evidenceIds)
    const sum = (a: number | null, b: number | null) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0))
    const { usage, costUsd } = estimateCost(
      {
        ...ai.usage,
        inputTokens: sum(sum(ai.usage.inputTokens, researchTokens.inputTokens), tanshinTokens.inputTokens),
        outputTokens: sum(sum(ai.usage.outputTokens, researchTokens.outputTokens), tanshinTokens.outputTokens),
        totalTokens: sum(
          sum(ai.usage.totalTokens, sum(researchTokens.inputTokens, researchTokens.outputTokens)),
          sum(tanshinTokens.inputTokens, tanshinTokens.outputTokens),
        ),
      },
      cfg,
    )
    if (tanshin) usage.tanshin = tanshin
    if (research) {
      usage.research = research
      usage.costBasis += '。Web検索ツールの利用料(検索回数分)は推定費用に含まれません'
    }

    await runs.completeRun(db, {
      id,
      code,
      stock: { name: snapshot.stock.name, market: snapshot.stock.market, sector: snapshot.stock.sector },
      model: ai.model,
      promptVersion: PROMPT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      calculatorVersion: CALCULATOR_VERSION,
      snapshot,
      persistSnapshot: cfg.persistSnapshot || cfg.dataSource === 'mock',
      sources: snapshot.sources,
      usage,
      costUsd,
      output,
    })
  } catch (e) {
    const ae = e instanceof AnalysisError ? e : new AnalysisError('internal_error', '予期しないエラーが発生しました')
    if (!(e instanceof AnalysisError)) console.error('analysis failed', (e as Error)?.message)
    await runs.failRun(db, id, ae.code, ae.message)
  }
}
