import type { Collected } from './collect.ts'
import type { Evidence, MetricOrigin, SectionType, Snapshot } from '../../../shared/types.ts'
import { computeTechnical } from '../calculators/technical.ts'
import {
  cashAdjustedPer,
  dividendYieldPct,
  netCashRatioPct,
  pbr,
  per,
  range,
  yieldPrices,
} from '../calculators/valuation.ts'
import { computeFinancialRows, isFinancialSector, type FinancialPeriod } from '../calculators/financial.ts'
import { buyBalanceDays, marginRatio } from '../calculators/supply-demand.ts'
import { shareBasisUnchanged } from '../calculators/forecast.ts'
import { jstDate } from '../../util/time.ts'
import { nowIso } from '../../util/time.ts'

/** 指標の取得方針を変更したら上げる(保存済みレポートとの差異を追えるようにする) */
export const CALCULATOR_VERSION = 'calc-5'

type Cat = SectionType | 'common'
type Opts = {
  origin: MetricOrigin
  asOf?: string | null
  definition: string
  basis?: 'actual' | 'forecast' | null
  period?: string | null
  priceAsOf?: string | null
  endpoint?: string | null
  dataset?: string
}

/** 決算期 "2025/03" → 配当実績の年度 2025 */
const fyYear = (fy: string) => Number(fy.slice(0, 4))

export function buildSnapshot(c: Collected): Snapshot {
  const evidence: Evidence[] = []
  const missing = [...c.missing]
  const label = (dataset?: string) => (dataset ? (c.sources.find((s) => s.dataset === dataset)?.sourceLabel ?? 'IRBANK') : '本アプリでの算出')
  /** API側の項目定義(fields[].note)を定義欄に添える */
  const apiDef = (dataset: string, key: string, base: string) => {
    const d = c.defs[`${dataset}.${key}`]
    return d ? `${base} / API定義: ${d}` : base
  }
  const add = (id: string, category: Cat, name: string, value: number | string | null, unit: string, o: Opts) => {
    evidence.push({
      id,
      category,
      label: name,
      value,
      unit,
      origin: o.origin,
      asOf: o.asOf ?? null,
      definition: o.definition,
      basis: o.basis ?? null,
      period: o.period ?? null,
      priceAsOf: o.priceAsOf ?? null,
      sourceLabel: o.origin === 'calculated' && !o.dataset ? '本アプリでの算出' : label(o.dataset),
      endpoint: o.endpoint ?? null,
    })
  }

  const isFin = isFinancialSector(c.security.industry)
  const tech = computeTechnical(c.bars)
  const priceAsOf = tech.asOf
  const close = tech.close
  const periods = c.financials.annual
  const latest = periods.at(-1) as FinancialPeriod
  const rows = computeFinancialRows(periods, isFin)
  const latestRow = rows.at(-1)!
  const issued = c.security.issuedShares
  const calcRows = new Map(rows.map((r) => [r.fiscalYear, r]))

  // ============ 共通 ============
  const priceDef = { origin: 'api' as const, asOf: priceAsOf, priceAsOf, dataset: 'prices', endpoint: 'GET /securities/{code}/prices' }
  add('price.close', 'common', '終値(未調整)', close, '円', { ...priceDef, definition: '日足の終値(分割調整なし)。最新取引日' })
  add('price.adj_close', 'common', '調整後終値', tech.adjClose, '円', { ...priceDef, definition: '株式分割・併合を最新株数基準で遡及調整した終値(adj_close)' })
  const marketCap = close != null && issued != null ? close * issued : null
  add('mcap', 'common', '時価総額(最新株価ベース)', marketCap, '円', {
    origin: 'calculated', asOf: priceAsOf, priceAsOf, definition: '終値(未調整) × 発行済株式数(GET /securities/{code} の issued_shares)。決算期末基準の時価総額(/valuations)とは別物',
  })
  if (marketCap == null) missing.push('時価総額: 発行済株式数が取得できず算出不可')

  // ============ 最新株価ベースのバリュエーション(独自計算) ============
  // /valuations の PER・PBR・配当利回りは決算期末株価基準のため、最新の値は終値と実績1株指標から算出する。
  const eps = latest.epsAdjusted ?? (latest.netIncome != null && issued ? latest.netIncome / issued : null)
  const epsKey = latest.epsAdjusted != null ? 'eps_computed_adjusted' : '純利益 ÷ 発行済株式数'
  const bps = latest.bpsAdjusted ?? (latestRow.equity != null && issued ? latestRow.equity / issued : null)
  const dps = latest.dpsAdjusted ?? latest.dps
  const fin = { dataset: 'financials', period: latest.fiscalYear, basis: 'actual' as const, endpoint: 'GET /financials' }
  add('val.eps', 'fundamental', `実績EPS(${latest.fiscalYear})`, eps, '円/株', {
    ...fin, origin: latest.epsAdjusted != null ? 'api' : 'calculated', asOf: latest.fiscalYear,
    definition: apiDef('financials', 'eps_computed_adjusted', `最新株数基準の調整後EPS(採用: ${epsKey})`),
  })
  add('val.bps', 'fundamental', `BPS(${latest.fiscalYear})`, bps, '円/株', {
    ...fin, origin: latest.bpsAdjusted != null ? 'api' : 'calculated', asOf: latest.fiscalYear,
    definition: latest.bpsAdjusted != null ? '最新株数基準の調整後BPS(bps_computed_adjusted)' : '自己資本 ÷ 発行済株式数',
  })
  add('val.dps', 'fundamental', `年間DPS(${latest.fiscalYear})`, dps, '円/株', {
    ...fin, origin: 'api', asOf: latest.fiscalYear, definition: '実績の年間1株配当(dps_adjusted)。会社予想の配当は未取得',
  })
  const calcDef = (expr: string) => `${expr}。実績ベース(予想ではない)。EPS等は${latest.fiscalYear}期、株価は最新終値`
  const perV = per(close, eps)
  const pbrV = pbr(close, bps)
  const yld = dividendYieldPct(dps, close)
  const valBase = { origin: 'calculated' as const, asOf: priceAsOf, priceAsOf, basis: 'actual' as const, period: latest.fiscalYear }
  add('val.per', 'fundamental', '最新PER(実績EPS基準)', perV, '倍', { ...valBase, definition: calcDef('終値 ÷ 実績EPS。EPSが0以下ならnull') })
  add('val.pbr', 'fundamental', '最新PBR', pbrV, '倍', { ...valBase, definition: calcDef('終値 ÷ BPS。BPSが0以下ならnull') })
  add('val.dividend_yield', 'fundamental', '最新配当利回り(実績DPS基準)', yld, '%', { ...valBase, definition: calcDef('年間DPS ÷ 終値 ×100') })
  if (perV == null) missing.push('最新PER: 実績EPSが非正または取得不可のため算出不可')
  const yps = yieldPrices(dps)
  for (const y of yps)
    add(`val.yield_price.${y.targetYieldPct}`, 'fundamental', `利回り${y.targetYieldPct}%の株価`, y.price, '円', {
      origin: 'calculated', asOf: priceAsOf, basis: 'actual', period: latest.fiscalYear, definition: `実績年間DPS ÷ ${y.targetYieldPct}%(サーバー計算値。AI出力で上書きしない)`,
    })

  // ============ 会社予想(決算短信XBRL)ベース ============
  // IRBANKの計算済みAPIには予想値がないため、最新の決算短信のXBRLファクトから取得する(origin=disclosure)。
  let yieldPricesForecast: Snapshot['yieldPricesForecast']
  /** 会社予想EPS(使用可能な場合のみ。株数基準の検証済み)。価格レンジの参考値に使う */
  let forecastEps: number | null = null
  {
    const fc = c.forecast
    const v = fc?.values ?? null
    const disclosedJst = fc?.disclosedAt ? jstDate(new Date(fc.disclosedAt)) : null
    const guard = v && disclosedJst ? shareBasisUnchanged(c.bars, disclosedJst) : null
    const usable = !!v && !!disclosedJst && guard?.ok === true
    const scopeLabel = v?.scope === 'non_consolidated' ? '個別' : '連結'
    const periodLabel = v?.fiscalYearScope === 'NextYear' ? '翌期(本決算短信)' : '当期(四半期短信)'
    const doc = `決算短信「${fc?.title ?? ''}」(開示 ${disclosedJst ?? '—'})`
    const fo = { origin: 'disclosure' as const, asOf: disclosedJst, basis: 'forecast' as const, period: periodLabel, dataset: 'forecast', endpoint: 'GET /disclosures/{doc_id}?include=xbrl_facts' }
    if (!fc) {
      // 取得自体に失敗(理由は c.missing に記録済み)
    } else if (!v) {
      missing.push(`会社予想: ${fc.reason ?? '取得できませんでした'}`)
    } else if (!usable) {
      missing.push(`会社予想(1株予想)は使用しません: ${guard?.reason ?? '検証できません'}`)
    } else {
      forecastEps = v.eps
      add('fc.eps', 'fundamental', `会社予想EPS(${periodLabel})`, v.eps, '円/株', { ...fo, definition: `${doc}の通期${scopeLabel}予想(${v.epsElement})。開示時点の株数基準` })
      add('fc.dps', 'fundamental', `会社予想DPS(年間・${periodLabel})`, v.dps, '円/株', { ...fo, definition: `${doc}の通期予想の年間1株配当(DividendPerShare)。開示時点の株数基準` })
      const fcDef = (x: string) => `${doc}の通期${scopeLabel}予想(${x})`
      add('fc.sales', 'fundamental', `会社予想 売上高(${periodLabel})`, v.sales, '円', { ...fo, definition: fcDef('売上高') })
      add('fc.operating_profit', 'fundamental', `会社予想 営業利益(${periodLabel})`, v.operatingProfit, '円', { ...fo, definition: fcDef('営業利益') })
      add('fc.net_income', 'fundamental', `会社予想 純利益(${periodLabel})`, v.netIncome, '円', { ...fo, definition: fcDef('親会社株主帰属純利益') })
      const fb = { origin: 'calculated' as const, asOf: priceAsOf, priceAsOf, basis: 'forecast' as const, period: periodLabel }
      const perF = per(close, v.eps)
      const yldF = dividendYieldPct(v.dps, close)
      add('val.per_forecast', 'fundamental', '最新PER(会社予想EPS基準)', perF, '倍', {
        ...fb, definition: `最新終値 ÷ 会社予想EPS。予想EPSは${doc}。予想はその後の修正を反映していない場合がある。EPSが0以下ならnull`,
      })
      add('val.dividend_yield_forecast', 'fundamental', '最新配当利回り(会社予想DPS基準)', yldF, '%', {
        ...fb, definition: `会社予想の年間DPS ÷ 最新終値 ×100。予想DPSは${doc}`,
      })
      yieldPricesForecast = yieldPrices(v.dps)
      for (const y of yieldPricesForecast)
        add(`val.yield_price_fc.${y.targetYieldPct}`, 'fundamental', `利回り${y.targetYieldPct}%の株価(予想DPS基準)`, y.price, '円', {
          origin: 'calculated', asOf: priceAsOf, basis: 'forecast', period: periodLabel, definition: `会社予想の年間DPS ÷ ${y.targetYieldPct}%(サーバー計算値)`,
        })
      if (perF == null) missing.push('予想PER: 会社予想EPSが非正または未開示のため算出不可')
      if (v.dps == null) missing.push('予想配当利回り: 会社予想DPSが未開示(未定)のため算出不可')
      for (const r of fc.laterRevisions)
        missing.push(`会社予想は最新の決算短信時点のもの。その後の開示「${r.title}」(${jstDate(new Date(r.disclosedAt))})の内容は反映していない`)
    }
    if (!usable) missing.push('予想PER・予想配当利回り・会社予想EPS/DPS: 取得できないため null(実績値で代用していない)')
  }

  // ============ 価格レンジの参考値(サーバー計算。AIに掛け算させない) ============
  // 過去5期末のPER・PBR(API・決算期末基準)の最小/平均/最大 × 1株指標。目標株価ではなく評価水準の目安。
  if (c.valuations) {
    const h5 = c.valuations.history.slice(-5)
    const stat = (xs: (number | null)[]) => range(xs.filter((x): x is number => x != null && x > 0))
    const perS = stat(h5.map((x) => x.per))
    const pbrS = stat(h5.map((x) => x.pbr))
    const epsFc = forecastEps
    const fcUsable = epsFc != null
    const refBase = { origin: 'calculated' as const, asOf: priceAsOf, priceAsOf, dataset: 'valuations' }
    const put = (prefix: string, name: string, base: number | null, s5: ReturnType<typeof range>, mult: string, basis: 'actual' | 'forecast', basisLabel: string) => {
      for (const [k, jp] of [['min', '最小'], ['avg', '平均'], ['max', '最大']] as const) {
        add(`${prefix}.${k}`, 'fundamental', `${name}(過去5期末${mult}の${jp})`, base != null && base > 0 && s5 ? base * s5[k] : null, '円', {
          ...refBase, basis, definition: `${basisLabel} × 過去5期末${mult}の${jp}(決算期末基準)。評価水準の目安であり目標株価ではない。基準が実績と予想で異なる指標は別ID`,
        })
      }
    }
    put('ref.value_per_act', '参考株価・実績EPS基準', eps, perS, 'PER', 'actual', '実績EPS')
    if (fcUsable) put('ref.value_per_fc', '参考株価・会社予想EPS基準', epsFc, perS, 'PER', 'forecast', '会社予想EPS')
    put('ref.value_pbr', '参考株価・BPS基準', bps, pbrS, 'PBR', 'actual', 'BPS(直近決算期末)')
  }

  // 分割エントリーの価格材料: 目標PER倍率ごとの株価(予想EPSが使えれば予想基準、無ければ実績基準)。
  // 目標配当利回りごとの株価は val.yield_price_fc.* / val.yield_price.* を使う。
  {
    const useFc = forecastEps != null && forecastEps > 0
    const baseEps = useFc ? forecastEps : eps
    const curPer = close != null && baseEps != null && baseEps > 0 ? close / baseEps : null
    if (curPer != null && baseEps != null) {
      const hi = Math.ceil(curPer)
      const lo = Math.max(3, Math.floor(curPer * 0.55))
      const targets: number[] = []
      for (let n = hi; n >= lo && targets.length < 8; n--) targets.push(n)
      for (const n of targets)
        add(`ref.price_at_per_${useFc ? 'fc' : 'act'}.${n}`, 'fundamental', `PER${n}倍の株価(${useFc ? '会社予想' : '実績'}EPS基準)`, baseEps * n, '円', {
          origin: 'calculated', asOf: priceAsOf, priceAsOf, basis: useFc ? 'forecast' : 'actual', period: latest.fiscalYear,
          definition: `${useFc ? '会社予想' : '実績'}EPS × ${n}倍(サーバー計算)。分割エントリー候補の価格帯の材料であり、割安水準の保証ではない`,
        })
    }
  }

  // ネットキャッシュ系(独自計算)。金融機関は非適用。
  if (isFin) {
    missing.push('金融機関のため有利子負債・ネットキャッシュ・簡易FCF・キャッシュ調整後PERは非適用。評価はROE・PBR・配当等に限られる')
  } else {
    const nc = latestRow.netCash
    const ncDef = '現金及び現金同等物 − 有利子負債(interest_bearing_debt)。APIの net_debt とは定義が異なりうるため別指標として扱う。金融子会社を連結する企業では有利子負債に金融事業の債務が含まれ、事業実態より大幅なマイナスになりうる'
    add('val.net_cash', 'financial', 'ネットキャッシュ', nc, '円', { ...fin, origin: 'calculated', asOf: latest.fiscalYear, definition: ncDef })
    add('val.net_cash_ratio', 'financial', 'ネットキャッシュ比率', netCashRatioPct(nc, marketCap), '%', {
      origin: 'calculated', asOf: priceAsOf, priceAsOf, period: latest.fiscalYear, definition: 'ネットキャッシュ ÷ 時価総額(最新株価ベース) ×100',
    })
    add('val.cash_adjusted_per', 'fundamental', 'キャッシュ調整後PER', cashAdjustedPer(marketCap, nc, latest.netIncome), '倍', {
      origin: 'calculated', asOf: priceAsOf, priceAsOf, basis: 'actual', period: latest.fiscalYear, definition: '(時価総額 − ネットキャッシュ) ÷ 年間純利益。純利益が非正ならnull',
    })
    const nd = c.indicators?.at(-1)
    if (nd?.netDebt != null)
      add('ref.api_net_debt', 'financial', `参考: API純有利子負債(${nd.fiscalYear})`, nd.netDebt, '円', {
        origin: 'api', asOf: nd.fiscalYear, period: nd.fiscalYear, dataset: 'indicators', endpoint: 'GET /indicators#net_debt',
        definition: apiDef('indicators', 'net_debt', '参考値。上のネットキャッシュとは定義が異なりうるため混用しない'),
      })
  }

  // ============ 過去のバリュエーション推移(API・決算期末株価基準) ============
  if (c.valuations) {
    const h = c.valuations.history.slice(-5)
    const vBase = { origin: 'api' as const, dataset: 'valuations', basis: 'actual' as const, endpoint: 'GET /valuations' }
    for (const r of h) {
      const k = `hist.${r.fiscalYear.replace('/', '-')}`
      const o = { ...vBase, asOf: r.fiscalYear, period: r.fiscalYear }
      add(`${k}.per`, 'fundamental', `決算期末PER(${r.fiscalYear})`, r.per, '倍', { ...o, definition: apiDef('valuations', 'per', '決算期末株価基準。日次PERの最高/最低ではない') })
      add(`${k}.pbr`, 'fundamental', `決算期末PBR(${r.fiscalYear})`, r.pbr, '倍', { ...o, definition: apiDef('valuations', 'pbr_adjusted', '決算期末株価基準(分割調整後)') })
      add(`${k}.dividend_yield`, 'fundamental', `決算期末配当利回り(${r.fiscalYear})`, r.dividendYieldPct, '%', { ...o, definition: apiDef('valuations', 'dividend_yield_adjusted', '決算期末株価基準(分割調整後)') })
    }
    const r = range(h.map((x) => x.per))
    const rangeBase = { origin: 'calculated' as const, asOf: h.at(-1)?.fiscalYear ?? null, basis: 'actual' as const, dataset: 'valuations' }
    add('val.per_5y_min', 'fundamental', '過去5期末PER 最小', r?.min ?? null, '倍', { ...rangeBase, definition: '直近5期の決算期末PER(API)の最小。決算期末基準' })
    add('val.per_5y_max', 'fundamental', '過去5期末PER 最大', r?.max ?? null, '倍', { ...rangeBase, definition: '直近5期の決算期末PER(API)の最大。決算期末基準' })
    add('val.per_5y_avg', 'fundamental', '過去5期末PER 平均', c.valuations.per5yAvg ?? r?.avg ?? null, '倍', {
      ...rangeBase, origin: c.valuations.per5yAvg != null ? 'api' : 'calculated', endpoint: 'GET /valuations#per_5y_avg', definition: '直近5年PERの単純平均(per_5y_avg)。無ければ5期末PERの平均',
    })
  }
  if (c.dividends) {
    for (const d of c.dividends.slice(-5))
      add(`div.${d.fiscalYear}.dps`, 'fundamental', `年間DPS ${d.fiscalYear}年度(調整後)`, d.annualDps, '円/株', {
        origin: 'api', asOf: String(d.fiscalYear), period: String(d.fiscalYear), basis: 'actual', dataset: 'dividends', endpoint: 'GET /dividends#annual_dps_adjusted', definition: '実績の年間1株配当(分割調整後)',
      })
  }
  const q = c.financials.latestQuarter
  if (q) {
    const qa = `${q.fiscalYear} ${q.quarter}`
    const qo = { origin: 'api' as const, asOf: q.fiscalYear, period: qa, basis: 'actual' as const, dataset: 'financials', endpoint: 'GET /financials?period=quarterly', definition: '単独四半期(開示の累積値から差分化)' }
    add('q.sales', 'fundamental', `最新四半期 売上高(${qa} 単独)`, q.sales, '円', qo)
    add('q.operating_profit', 'fundamental', `最新四半期 営業利益(${qa} 単独)`, q.operatingProfit, '円', qo)
    add('q.net_income', 'fundamental', `最新四半期 純利益(${qa} 単独)`, q.netIncome, '円', qo)
  } else missing.push('最新四半期財務: 取得できませんでした')
  if (c.shareholders) {
    c.shareholders.forEach((s, i) => {
      add(`sh.${i + 1}`, 'supply_demand', `大量保有報告 ${s.holderName}`, s.holdingRatioPct, '%', {
        origin: 'api', dataset: 'shareholders', endpoint: 'GET /shareholders', definition: `前回比率: ${s.previousRatioPct ?? '不明'}%。保有者属性(アクティビスト等)は未確認`,
      })
    })
  }

  // ============ テクニカル(独自計算) ============
  const T = (id: string, name: string, v: number | null, unit: string, def: string) =>
    add(`tech.${id}`, 'technical', name, v, unit, { origin: 'calculated', asOf: priceAsOf, priceAsOf, dataset: 'prices', definition: def })
  T('sma5', 'SMA5', tech.sma5, '円', '調整後終値の5日単純移動平均'); T('sma25', 'SMA25', tech.sma25, '円', '調整後終値の25日単純移動平均')
  T('sma75', 'SMA75', tech.sma75, '円', '調整後終値の75日単純移動平均'); T('sma200', 'SMA200', tech.sma200, '円', '調整後終値の200日単純移動平均')
  T('rsi14', 'RSI(14) Wilder', tech.rsi14, '', 'Wilder方式14日RSI(調整後終値)')
  T('macd', 'MACD(12,26)', tech.macd, '円', 'EMA12 − EMA26(調整後終値)'); T('macd_signal', 'MACDシグナル(9)', tech.macdSignal, '円', 'MACDの9日EMA')
  T('macd_hist', 'MACDヒストグラム', tech.macdHist, '円', 'MACD − シグナル')
  T('volume', '出来高(直近)', tech.volume, '株', '直近取引日の出来高'); T('volume_avg20', '出来高20日平均', tech.volumeAvg20, '株', '直近20取引日の単純平均')
  T('volume_ratio', '出来高/20日平均', tech.volumeRatio, '倍', '直近出来高 ÷ 20日平均')
  T('high20', '直近20日高値', tech.high20, '円', '高値の最大(未調整)'); T('low20', '直近20日安値', tech.low20, '円', '安値の最小(未調整)')
  T('high60', '直近60日高値', tech.high60, '円', '高値の最大(未調整)'); T('low60', '直近60日安値', tech.low60, '円', '安値の最小(未調整)')
  T('weekly_sma13', '週足SMA13', tech.weeklySma13, '円', '週末調整後終値の13週単純平均'); T('weekly_sma26', '週足SMA26', tech.weeklySma26, '円', '週末調整後終値の26週単純平均')
  T('deviation25', '25日線乖離率', tech.deviation25Pct, '%', '(調整後終値 − SMA25) ÷ SMA25 ×100')
  if (tech.sma200 == null) missing.push('SMA200: 履歴不足のため算出不可')

  // ============ 需給 ============
  const w = c.weekly
  if (w && w.length) {
    const lw = w.at(-1)!
    const asOf = lw.reportDate
    const wk = { dataset: 'weekly_margin', asOf, endpoint: 'GET /securities/{code}/weekly-margin-balance' }
    add('sd.buy', 'supply_demand', '信用買い残(最新週)', lw.buyBalance, '株', { ...wk, origin: 'api', definition: apiDef('weekly_margin', 'buy_balance_total', '東証週次の買残合計(分割調整後)。公表日基準') })
    add('sd.sell', 'supply_demand', '信用売り残(最新週)', lw.sellBalance, '株', { ...wk, origin: 'api', definition: apiDef('weekly_margin', 'sell_balance_total', '東証週次の売残合計(分割調整後)') })
    add('sd.buy_change', 'supply_demand', '買い残 前週比', lw.buyChange, '株', { ...wk, origin: 'api', definition: '前週比(調整後系列から算出されたAPI値)' })
    add('sd.sell_change', 'supply_demand', '売り残 前週比', lw.sellChange, '株', { ...wk, origin: 'api', definition: '前週比(調整後系列から算出されたAPI値)' })
    // 信用倍率: APIの margin_ratio を優先。無ければ買い残÷売り残を算出(売り残0はnullと理由)
    const calcRatio = marginRatio(lw.buyBalance, lw.sellBalance)
    if (lw.marginRatio != null)
      add('sd.margin_ratio', 'supply_demand', '信用倍率', lw.marginRatio, '倍', { ...wk, origin: 'api', definition: apiDef('weekly_margin', 'margin_ratio', '買残合計 ÷ 売残合計(API値)') })
    else
      add('sd.margin_ratio', 'supply_demand', '信用倍率', calcRatio.value, '倍', { ...wk, origin: 'calculated', definition: calcRatio.reason ?? '買い残合計 ÷ 売り残合計(APIにmargin_ratioが無いため算出)' })
    add('sd.buy_days', 'supply_demand', '買い残の日数換算', buyBalanceDays(lw.buyBalance, tech.volumeAvg20), '日', {
      origin: 'calculated', asOf, dataset: 'weekly_margin', definition: '買い残 ÷ 出来高20日平均(分割をまたぐ直近では不正確になりうる)',
    })
    const first = w[0]!
    add('sd.buy_12w_change', 'supply_demand', `買い残 ${w.length}週間変化`, lw.buyBalance != null && first.buyBalance != null ? lw.buyBalance - first.buyBalance : null, '株', {
      origin: 'calculated', asOf, dataset: 'weekly_margin', definition: '最新週の買い残 − 取得期間の最初の週の買い残',
    })
  }
  if (c.jsf && c.jsf.days.length) {
    const ld = c.jsf.days.at(-1)!
    const jo = { origin: 'api' as const, asOf: ld.date, dataset: 'jsf_margin', endpoint: 'GET /securities/{code}/jsf-margin-daily' }
    add('sd.jsf_loan', 'supply_demand', '日証金 融資残', ld.loanBalance, '株', { ...jo, definition: '取引所公表値(分割調整なし)' })
    add('sd.jsf_stock', 'supply_demand', '日証金 貸株残', ld.stockLoanBalance, '株', { ...jo, definition: '取引所公表値(分割調整なし)' })
    add('sd.jsf_ratio', 'supply_demand', '日証金 貸借倍率', ld.lendingRatio, '倍', { ...jo, definition: '融資残 ÷ 貸株残(API値)' })
    const fee = c.jsf.reverse.reduce((a, r) => a + (r.feeTotal ?? 0), 0)
    add('sd.reverse_fee', 'supply_demand', '直近の逆日歩合計(1株あたり)', fee, '円', {
      origin: 'calculated', asOf: ld.date, dataset: 'jsf_margin', definition: c.jsf.reverse.length ? '取得期間内の逆日歩発生日の fee_total 合計' : '取得期間に逆日歩の発生なし',
    })
  }
  missing.push('機関空売り: 未取得のため未評価')

  // ============ 財務(直近5期) ============
  const ind = new Map((c.indicators ?? []).map((r) => [r.fiscalYear, r]))
  const divByYear = new Map((c.dividends ?? []).map((d) => [d.fiscalYear, d]))
  if (!c.indicators) missing.push('ROE・ROA・利益率・成長率・自己資本比率: 計算済み指標(/indicators)が取得できず算出不可(再計算はしていない)')
  for (const p of periods.slice(-5)) {
    const fy = p.fiscalYear
    const k = `fin.${fy.replace('/', '-')}`
    const calc = calcRows.get(fy)!
    const ir = ind.get(fy)
    const base = { asOf: fy, period: fy, basis: 'actual' as const }
    const fo = { ...base, origin: 'api' as const, dataset: 'financials', endpoint: 'GET /financials' }
    const io = { ...base, origin: 'api' as const, dataset: 'indicators' }
    const co = { ...base, origin: 'calculated' as const, dataset: 'financials' }
    const F = (id: string, name: string, v: number | null, unit: string, o: Opts) => add(`${k}.${id}`, 'financial', `${name}(${fy})`, v, unit, o)

    F('sales', '売上高', p.sales, '円', { ...fo, definition: '報告値(連結優先)' })
    F('operating_profit', '営業利益', p.operatingProfit, '円', { ...fo, definition: '報告値(連結優先)' })
    F('net_income', '純利益(親会社帰属)', p.netIncome, '円', { ...fo, definition: '報告値(連結優先)' })
    F('sales_growth', '売上高成長率', ir?.salesGrowthPct ?? null, '%', { ...io, endpoint: 'GET /indicators#sales_growth', definition: apiDef('indicators', 'sales_growth', 'API値') })
    F('op_growth', '営業利益成長率', ir?.operatingIncomeGrowthPct ?? null, '%', { ...io, endpoint: 'GET /indicators#operating_income_growth', definition: apiDef('indicators', 'operating_income_growth', 'API値') })
    F('ni_growth', '純利益成長率', ir?.netIncomeGrowthPct ?? null, '%', { ...io, endpoint: 'GET /indicators#net_income_growth', definition: apiDef('indicators', 'net_income_growth', 'API値') })
    F('op_margin', '営業利益率', ir?.operatingMarginPct ?? null, '%', { ...io, endpoint: 'GET /indicators#operating_margin', definition: apiDef('indicators', 'operating_margin', 'API値') })
    F('net_margin', '純利益率', ir?.netMarginPct ?? null, '%', { ...io, endpoint: 'GET /indicators#net_margin', definition: apiDef('indicators', 'net_margin', 'API値') })
    F('equity_ratio', '自己資本比率', ir?.equityRatioPct ?? null, '%', { ...io, endpoint: 'GET /indicators#equity_ratio_computed', definition: apiDef('indicators', 'equity_ratio_computed', '財務諸表からの計算値(API)') })
    F('roe', 'ROE', ir?.roePct ?? null, '%', {
      ...io, endpoint: `GET /indicators#${ir?.roeKey ?? 'roe_computed'}`, definition: apiDef('indicators', ir?.roeKey ?? 'roe_computed', `API値(採用キー: ${ir?.roeKey ?? '該当なし'}。roe_computed優先、無ければ報告値roe)`),
    })
    F('roa', 'ROA', ir?.roaPct ?? null, '%', { ...io, endpoint: 'GET /indicators#roa', definition: apiDef('indicators', 'roa', 'API値') })
    F('ocf', '営業CF', p.operatingCf, '円', { ...fo, definition: '報告値' })
    F('icf', '投資CF', p.investingCf, '円', { ...fo, definition: '報告値' })
    F('financing_cf', '財務CF', p.financingCf, '円', { ...fo, definition: '報告値' })
    if (!isFin) {
      F('cash', '現金及び現金同等物', p.cash, '円', { ...fo, definition: 'cash_and_equivalents(無ければ cash_and_deposits_bs)' })
      F('debt', '有利子負債', p.interestBearingDebt, '円', { ...fo, definition: 'interest_bearing_debt' })
      F('net_cash', 'ネットキャッシュ', calc.netCash, '円', { ...co, origin: 'calculated', definition: '現金及び現金同等物 − 有利子負債' })
      // FCF: APIの fcf を優先。取得不可の場合のみ簡易FCF(営業CF+投資CF)を別IDで出す
      if (p.fcfApi != null)
        F('fcf', 'FCF', p.fcfApi, '円', { ...fo, endpoint: 'GET /financials#fcf', definition: apiDef('financials', 'fcf', 'API値') })
      else
        F('fcf_simple', '簡易FCF', calc.fcfSimple, '円', { ...co, definition: '営業CF + 投資CF(APIのfcfが取得できないための代替。API値とは定義が異なる)' })
    }
    // 配当性向: APIの報告値を優先、無ければ DPS÷EPS
    if (ir?.payoutRatioPct != null)
      F('payout', '配当性向', ir.payoutRatioPct, '%', { ...io, endpoint: 'GET /indicators#payout_ratio', definition: apiDef('indicators', 'payout_ratio', '報告値(API)') })
    else
      F('payout_simple', '配当性向(算出)', calc.payoutRatioPct, '%', { ...co, definition: '年間DPS ÷ EPS ×100。赤字(EPS≦0)ならnull。APIの値が無いための代替' })
    // DOE: /dividends の doe を優先、無ければ 配当総額÷平均自己資本
    const dv = divByYear.get(fyYear(fy))
    if (dv?.doePct != null)
      F('doe', 'DOE', dv.doePct, '%', { ...base, origin: 'api', dataset: 'dividends', endpoint: 'GET /dividends#doe', definition: apiDef('dividends', 'doe', 'API値') })
    else
      F('doe_simple', 'DOE(算出)', calc.doePct, '%', { ...co, definition: '配当総額 ÷ 期首期末平均自己資本 ×100(APIのdoeが無いための代替。最初の期は期首が無くnull)' })
  }
  if (!isFin && latestRow.netCash == null) missing.push('有利子負債または現金が未取得のためネットキャッシュ関連は算出不可')

  // ============ セグメント別業績(利益急増の内訳) ============
  const topSegments = (rows: typeof c.segmentsAnnual, pick: (r: NonNullable<typeof c.segmentsAnnual>[number]) => boolean) => {
    const sel = (rows ?? []).filter(pick)
    if (sel.length === 0) return { rows: [] as NonNullable<typeof c.segmentsAnnual>, key: null as string | null }
    const key = sel.map((r) => `${r.fiscalYear}|${r.quarter ?? 0}`).sort().at(-1)!
    const latestRows = sel.filter((r) => `${r.fiscalYear}|${r.quarter ?? 0}` === key)
    return { rows: [...latestRows].sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0)).slice(0, 6), key }
  }
  const segDefs: [string, typeof c.segmentsAnnual, string, string, (q: number | null) => boolean][] = [
    ['a', c.segmentsAnnual, 'segments_annual', '通期', (q) => q == null],
    ['q', c.segmentsQuarter, 'segments_quarter', '単独四半期', (q) => q != null],
  ]
  for (const [tag, rows, dataset, scopeLabel, isScope] of segDefs) {
    const { rows: top } = topSegments(rows, (r) => isScope(r.quarter))
    top.forEach((r, i) => {
      const period = `${r.fiscalYear}${r.quarter != null ? ` Q${r.quarter}` : ''} ${scopeLabel}`
      const o = { origin: 'api' as const, asOf: r.fiscalYear, period, basis: 'actual' as const, dataset, endpoint: `GET /segments${tag === 'q' ? '?period=quarter' : ''}` }
      const nm = `セグメント「${r.name}」`
      add(`seg.${tag}.${i + 1}.revenue`, 'fundamental', `${nm}売上高(${period})`, r.revenue, '円', { ...o, definition: apiDef(dataset, 'revenue', 'セグメント別開示(連結)') })
      add(`seg.${tag}.${i + 1}.operating_income`, 'fundamental', `${nm}営業利益(${period})`, r.operatingIncome, '円', { ...o, definition: apiDef(dataset, 'operating_income', 'セグメント利益(開示の定義による)') })
      add(`seg.${tag}.${i + 1}.yoy`, 'fundamental', `${nm}売上高前年比(${period})`, r.yoyGrowthPct, '%', { ...o, definition: apiDef(dataset, 'yoy_growth', '売上高の前年(同期)比') })
    })
  }
  if (c.segmentsAnnual && !evidence.some((e) => e.id.startsWith('seg.'))) missing.push('セグメント別業績: 開示がない(単一セグメント等)ため内訳は確認できない')

  // ============ 開示書類の文章(業績要因・経営環境・リスク)と最近のIR ============
  if (c.narratives) {
    const dateOf = (iso: string) => (iso ? jstDate(new Date(iso)) : null)
    const NAR: Record<string, string> = { mda: '経営者による分析(業績要因)', management_policy: '経営方針・経営環境・対処すべき課題', risk_factors: '事業等のリスク' }
    for (const d of c.narratives.docs) {
      add(`nar.${d.kind}`, 'fundamental', `${NAR[d.kind]}の抜粋`, d.text, 'text', {
        origin: 'disclosure', asOf: dateOf(d.disclosedAt), dataset: 'narratives', endpoint: `GET /disclosures/${d.docId}/sections/${d.kind}`,
        definition: `${d.docTitle}(開示 ${dateOf(d.disclosedAt) ?? '—'})の「${NAR[d.kind]}」${d.truncated ? '冒頭の抜粋' : '全文'}。引用であり、本アプリ・AIの見解ではない`,
      })
    }
    c.narratives.recentIr.forEach((r, i) =>
      add(`ir.${i + 1}`, 'common', `最近の適時開示 ${i + 1}`, r.title, 'text', {
        origin: 'disclosure', asOf: dateOf(r.disclosedAt), dataset: 'narratives', endpoint: 'GET /securities/{code}/disclosures', definition: '適時開示(TDnet)の見出しのみ。本文の内容は未確認',
      }),
    )
    for (const r of c.narratives.reasons) missing.push(r)
    if (!c.narratives.docs.some((d) => d.kind === 'mda')) missing.push('利益の増減要因(経営者による分析)の文章を取得できていないため、内訳の説明は確認できない')
    if (!c.narratives.docs.some((d) => d.kind === 'management_policy')) missing.push('経営環境・競争優位に関する文章(有価証券報告書)を取得できていない')
  }

  // ============ 分析に使った開示書類(確認用) ============
  const docs = new Map<string, import('../../../shared/types.ts').DocRef>()
  const addDoc = (d: { docId: string; title: string; disclosedAt: string; pdfUrl: string | null; sourceUrl: string | null }, source: 'tdnet' | 'edinet', role: string) => {
    const cur = docs.get(d.docId)
    if (cur) {
      if (!cur.roles.includes(role)) cur.roles.push(role)
      return
    }
    docs.set(d.docId, { docId: d.docId, source, title: d.title, disclosedAt: d.disclosedAt, roles: [role], pdfUrl: d.pdfUrl, sourceUrl: d.sourceUrl })
  }
  if (c.forecast?.docId && c.forecast.title && c.forecast.disclosedAt) {
    addDoc({ docId: c.forecast.docId, title: c.forecast.title, disclosedAt: c.forecast.disclosedAt, pdfUrl: c.forecast.pdfUrl, sourceUrl: c.forecast.sourceUrl }, 'tdnet', '会社予想の取得元(XBRL)・決算短信の要約')
  }
  const NAR_ROLE: Record<string, string> = { mda: '経営者による分析(業績要因)', management_policy: '経営方針・経営環境・課題', risk_factors: '事業等のリスク' }
  for (const d of c.narratives?.docs ?? []) addDoc({ docId: d.docId, title: d.docTitle, disclosedAt: d.disclosedAt, pdfUrl: d.pdfUrl, sourceUrl: d.sourceUrl }, 'edinet', NAR_ROLE[d.kind] ?? d.kind)

  return {
    documents: [...docs.values()],
    stock: { code: c.security.code, name: c.security.name, market: c.security.market, sector: c.security.industry },
    generatedAt: nowIso(),
    priceAsOf,
    isFinancialInstitution: isFin,
    evidence,
    yieldPrices: yps,
    ...(yieldPricesForecast ? { yieldPricesForecast } : {}),
    missingData: [...new Set(missing)],
    sources: c.sources,
  }
}

