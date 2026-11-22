import type { Bar } from '../../calculators/technical.ts'
import type { FinancialPeriod } from '../../calculators/financial.ts'
import type { JsfDay, JsfReverse, WeeklyMargin } from '../../calculators/supply-demand.ts'
import {
  ProviderError,
  type Dataset,
  type DividendRow,
  type FinancialSet,
  type ForecastSet,
  type IndicatorRow,
  type MarketDataProvider,
  type NarrativeDoc,
  type NarrativeSet,
  type SegmentRow,
  type SecurityInfo,
  type ShareholderRow,
  type ValuationRow,
} from '../types.ts'
import { IrbankClient } from './client.ts'
import { isRevisionNoticeTitle, isTanshinTitle, parseForecastFacts } from './forecast.ts'
import { excerpt, htmlToText, isIrHeadline, periodicKind } from './narrative.ts'
import { asArr, asRec, assertUnit, fieldDefs, fieldUnits, numOrNull, sourceLabel, str, strOrNull, toPercent, type Rec } from './guards.ts'

const MAX_PRICE_PAGES = 4

function meta(dataset: string, body: Rec, asOf: string | null) {
  return { dataset, sourceLabel: sourceLabel(body), fetchedAt: new Date().toISOString(), asOf }
}

export class IrbankProvider implements MarketDataProvider {
  readonly name = 'irbank' as const
  private client: IrbankClient
  constructor(apiKey: string, client?: IrbankClient) {
    this.client = client ?? new IrbankClient(apiKey)
  }
  get requestCount() {
    return this.client.requests
  }

  async listSecurities(cursor?: string) {
    const b = asRec(await this.client.get('/securities', { limit: 500, cursor }), 'securities')
    const rows = asArr(b.securities, 'securities[]')
      .map((r) => asRec(r, 'securities[] item'))
      .map((x) => ({ code: str(x.code, 'code'), name: str(x.name, 'name'), market: strOrNull(x.market), industry: strOrNull(x.industry) }))
    return { rows, nextCursor: strOrNull(b.next_cursor) }
  }

  async getSecurity(code: string): Promise<Dataset<SecurityInfo>> {
    const b = asRec(await this.client.get(`/securities/${encodeURIComponent(code)}`), 'securities/{code}')
    const data: SecurityInfo = {
      code: str(b.code, 'code'),
      name: str(b.name, 'name'),
      market: strOrNull(b.market),
      industry: strOrNull(b.industry),
      edinetCode: strOrNull(b.edinet_code),
      issuedShares: numOrNull(b.issued_shares, 'issued_shares'),
      fiscalYearEndMonth: numOrNull(b.fiscal_year_end_month, 'fiscal_year_end_month'),
    }
    if (b.listing_status != null && b.listing_status !== 'listed') {
      throw new ProviderError('not_found', `銘柄は上場状態ではありません(${String(b.listing_status)})`)
    }
    return { data, meta: meta('security', b, null) }
  }

  async getPrices(code: string, fromDate: string): Promise<Dataset<Bar[]>> {
    const bars: Bar[] = []
    let cursor: string | undefined
    let last: Rec = {}
    for (let page = 0; page < MAX_PRICE_PAGES; page++) {
      const b = asRec(
        await this.client.get(`/securities/${encodeURIComponent(code)}/prices`, { from: fromDate, limit: 500, cursor }),
        'prices',
      )
      last = b
      const units = fieldUnits(b)
      assertUnit(units, 'close', 'jpy')
      assertUnit(units, 'volume', 'shares')
      for (const r of asArr(b.prices, 'prices[]')) {
        const x = asRec(r, 'prices[] item')
        bars.push({
          date: str(x.date, 'prices.date'),
          open: numOrNull(x.open, 'open'),
          high: numOrNull(x.high, 'high'),
          low: numOrNull(x.low, 'low'),
          close: numOrNull(x.close, 'close'),
          adjClose: numOrNull(x.adj_close, 'adj_close'),
          volume: numOrNull(x.volume, 'volume'),
        })
      }
      cursor = strOrNull(b.next_cursor) ?? undefined
      if (!cursor) break
    }
    bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    // 重複日除去
    const uniq = bars.filter((b, i) => i === 0 || b.date !== bars[i - 1]!.date)
    return { data: uniq, meta: meta('prices', last, uniq.at(-1)?.date ?? null) }
  }

  async getFinancials(code: string, _edinet: string | null): Promise<Dataset<FinancialSet>> {
    const [annualBody, quarterBody] = await Promise.all([
      this.client.get('/financials', { security_code: code, period: 'annual', years: 6 }),
      this.client.get('/financials', { security_code: code, period: 'quarterly', years: 2 }).catch(() => null),
    ])
    const b = asRec(annualBody, 'financials')
    const units = fieldUnits(b)
    for (const k of ['sales', 'operating_profit', 'net_income', 'total_assets', 'net_assets', 'operating_cf', 'investing_cf', 'fcf'])
      assertUnit(units, k, 'jpy')
    for (const k of ['eps', 'bps']) assertUnit(units, k, 'jpy_per_share')
    const n = (x: Rec, k: string) => numOrNull(x[k], k)
    const annual: FinancialPeriod[] = asArr(b.periods, 'periods')
      .map((r) => asRec(r, 'periods[] item'))
      .map((x) => ({
        fiscalYear: str(x.fiscal_year, 'fiscal_year'),
        sales: n(x, 'sales'),
        operatingProfit: n(x, 'operating_profit'),
        netIncome: n(x, 'net_income'),
        totalAssets: n(x, 'total_assets'),
        netAssets: n(x, 'net_assets'),
        nonControllingInterests: n(x, 'non_controlling_interests'),
        cash: n(x, 'cash_and_equivalents') ?? n(x, 'cash_and_deposits_bs'),
        interestBearingDebt: n(x, 'interest_bearing_debt'),
        operatingCf: n(x, 'operating_cf'),
        investingCf: n(x, 'investing_cf'),
        financingCf: n(x, 'financing_cf'),
        totalDividends: n(x, 'total_dividends'),
        dps: n(x, 'dps'),
        eps: n(x, 'eps'),
        // 注意: /financials の eps_adjusted は既知の未反映問題があるため eps_computed_adjusted を使う
        epsAdjusted: n(x, 'eps_computed_adjusted'),
        bpsAdjusted: n(x, 'bps_computed_adjusted') ?? n(x, 'bps_adjusted'),
        dpsAdjusted: n(x, 'dps_adjusted'),
        sharesOutstanding: n(x, 'shares_outstanding'),
        fcfApi: n(x, 'fcf'),
      }))
      .sort((a, c) => (a.fiscalYear < c.fiscalYear ? -1 : 1))

    let latestQuarter: FinancialSet['latestQuarter'] = null
    if (quarterBody) {
      const qb = asRec(quarterBody, 'financials(quarterly)')
      const qs = asArr(qb.periods, 'periods')
        .map((r) => asRec(r, 'quarter item'))
        .filter((x) => typeof x.quarter === 'string' && /^Q[1-4]$/.test(x.quarter as string))
        .sort((a, c) => `${a.fiscal_year}${a.quarter}` < `${c.fiscal_year}${c.quarter}` ? -1 : 1)
      const q = qs.at(-1)
      if (q)
        latestQuarter = {
          fiscalYear: str(q.fiscal_year, 'fiscal_year'),
          quarter: q.quarter as string,
          sales: n(q, 'sales'),
          operatingProfit: n(q, 'operating_profit'),
          netIncome: n(q, 'net_income'),
        }
    }
    return { data: { annual, latestQuarter }, meta: meta('financials', b, annual.at(-1)?.fiscalYear ?? null), defs: fieldDefs(b) }
  }

  async getValuations(code: string) {
    const b = asRec(await this.client.get('/valuations', { security_code: code, years: 6 }), 'valuations')
    const units = fieldUnits(b)
    assertUnit(units, 'market_cap', 'jpy')
    assertUnit(units, 'per', 'times')
    const history: ValuationRow[] = asArr(b.history, 'history')
      .map((r) => asRec(r, 'history item'))
      .map((x) => ({
        fiscalYear: str(x.fiscal_year, 'fiscal_year'),
        per: numOrNull(x.per, 'per'),
        perHigh: numOrNull(x.per_high, 'per_high'),
        perLow: numOrNull(x.per_low, 'per_low'),
        // 分割調整後を優先(決算期をまたぐ比較用)。無ければ報告基準
        pbr: numOrNull(x.pbr_adjusted, 'pbr_adjusted') ?? numOrNull(x.pbr_reported, 'pbr_reported'),
        dividendYieldPct:
          toPercent(numOrNull(x.dividend_yield_adjusted, 'dividend_yield_adjusted'), 'dividend_yield_adjusted', units) ??
          toPercent(numOrNull(x.dividend_yield_reported, 'dividend_yield_reported'), 'dividend_yield_reported', units),
        marketCap: numOrNull(x.market_cap, 'market_cap'),
      }))
      .sort((a, c) => (a.fiscalYear < c.fiscalYear ? -1 : 1))
    return {
      data: { history, per5yAvg: numOrNull(b.per_5y_avg, 'per_5y_avg') },
      meta: meta('valuations', b, history.at(-1)?.fiscalYear ?? null),
      defs: fieldDefs(b),
    }
  }

  /**
   * 最新の決算短信(TDnet)のXBRLファクトから通期の会社予想(EPS・DPS等)を取得する。
   * 2リクエスト(開示一覧 + 文書)。短信が見つからない・ファクトが無い場合は values=null と理由を返す。
   */
  async getForecast(code: string): Promise<Dataset<ForecastSet>> {
    const list = asRec(await this.client.get(`/securities/${encodeURIComponent(code)}/disclosures`, { limit: 100 }), 'disclosures')
    const items = asArr(list.disclosures, 'disclosures[]').map((r) => asRec(r, 'disclosures[] item'))
    // 開示日時の新しい順。最新の決算短信を選び、それより新しい予想修正の開示を警告用に拾う
    const idx = items.findIndex((d) => d.source === 'tdnet' && typeof d.title === 'string' && isTanshinTitle(d.title))
    const empty = (reason: string): Dataset<ForecastSet> => ({
      data: { values: null, reason, docId: null, pdfUrl: null, sourceUrl: null, title: null, disclosedAt: null, laterRevisions: [] },
      meta: meta('forecast', list, null),
    })
    if (idx < 0) return empty('直近100件の開示に決算短信が見つかりません')
    const t = items[idx]!
    const docId = str(t.doc_id, 'doc_id')
    const title = str(t.title, 'title')
    const disclosedAt = str(t.disclosed_at, 'disclosed_at')
    // 短信と同時刻以前の修正開示は短信に反映済みのため、短信より後(厳密に新しい)ものだけを警告対象にする
    const later = items
      .filter(
        (d) =>
          d.source === 'tdnet' &&
          typeof d.title === 'string' &&
          isRevisionNoticeTitle(d.title) &&
          typeof d.disclosed_at === 'string' &&
          Date.parse(d.disclosed_at) > Date.parse(disclosedAt),
      )
      .map((d) => ({ title: d.title as string, disclosedAt: d.disclosed_at as string }))
    const doc = asRec(await this.client.get(`/disclosures/${encodeURIComponent(docId)}`, { include: 'xbrl_facts' }), 'disclosure')
    const values = parseForecastFacts(doc.xbrl_facts)
    const has = values.eps != null || values.dps != null
    return {
      data: {
        values: has ? values : null,
        reason: has ? null : `決算短信「${title}」に会社予想(EPS・DPS)のXBRLファクトが見つかりません(予想の開示なし、または未対応の会計基準)`,
        docId,
        pdfUrl: typeof t.pdf_url === 'string' ? t.pdf_url : null,
        sourceUrl: typeof t.source_url === 'string' ? t.source_url : null,
        title,
        disclosedAt,
        laterRevisions: later,
      },
      meta: { ...meta('forecast', doc, null), asOf: disclosedAt.slice(0, 10) },
    }
  }

  async getDocumentPdf(url: string, maxBytes: number): Promise<Uint8Array | null> {
    return this.client.getBinary(url, maxBytes)
  }

  /** セグメント別業績。period=quarter は単独四半期(前年同期比つき)。 */
  async getSegments(edinetCode: string, period: 'annual' | 'quarter'): Promise<Dataset<SegmentRow[]>> {
    const b = asRec(
      await this.client.get('/segments', { edinet_code: edinetCode, ...(period === 'quarter' ? { period: 'quarter' } : {}) }),
      'segments',
    )
    const units = fieldUnits(b)
    assertUnit(units, 'revenue', 'jpy')
    assertUnit(units, 'operating_income', 'jpy')
    const rows: SegmentRow[] = asArr(b.segments, 'segments[]')
      .map((r) => asRec(r, 'segments[] item'))
      .map((x) => ({
        fiscalYear: str(x.fiscal_year, 'fiscal_year'),
        quarter: numOrNull(x.quarter, 'quarter'),
        name: str(x.segment_name, 'segment_name'),
        revenue: numOrNull(x.revenue, 'revenue'),
        operatingIncome: numOrNull(x.operating_income, 'operating_income'),
        revenueSharePct: toPercent(numOrNull(x.revenue_share, 'revenue_share'), 'revenue_share', units),
        yoyGrowthPct: toPercent(numOrNull(x.yoy_growth, 'yoy_growth'), 'yoy_growth', units),
      }))
    return { data: rows, meta: meta(`segments_${period}`, b, rows[0]?.fiscalYear ?? null), defs: fieldDefs(b) }
  }

  /**
   * 開示書類の文章(経営者による分析・経営方針/経営環境・事業等のリスク)と最近のIR見出しを取得する。
   * 一覧は getForecast と同一URLのため重複取得されない。本文は section 単位で取得(最大3リクエスト)。
   */
  async getNarratives(code: string): Promise<Dataset<NarrativeSet>> {
    const list = asRec(await this.client.get(`/securities/${encodeURIComponent(code)}/disclosures`, { limit: 100 }), 'disclosures')
    const items = asArr(list.disclosures, 'disclosures[]').map((r) => asRec(r, 'disclosures[] item'))
    const reasons: string[] = []
    const title = (d: Rec) => (typeof d.title === 'string' ? d.title : '')
    const recentIr = items
      .filter((d) => d.source === 'tdnet' && isIrHeadline(title(d)) && typeof d.disclosed_at === 'string')
      .slice(0, 10)
      .map((d) => ({ title: title(d), disclosedAt: d.disclosed_at as string }))
    const periodic = items.filter((d) => d.source === 'edinet' && periodicKind(title(d)) != null && typeof d.doc_id === 'string')
    const latest = periodic[0]
    let yuho = periodic.find((d) => periodicKind(title(d)) === 'yuho')
    if (!yuho) {
      try {
        const y = asRec(
          await this.client.get(`/securities/${encodeURIComponent(code)}/disclosures`, { document_type: '有価証券報告書', limit: 1 }),
          'disclosures(yuho)',
        )
        const first = asArr(y.disclosures, 'disclosures[]').map((r) => asRec(r, 'item'))[0]
        if (first && typeof first.doc_id === 'string') yuho = first
      } catch {
        // 取得できなければ下で理由を残す
      }
    }
    const fetchSection = async (d: Rec | undefined, section: NarrativeDoc['kind'], max: number, label: string): Promise<NarrativeDoc | null> => {
      if (!d) {
        reasons.push(`${label}: 該当する報告書が見つかりません`)
        return null
      }
      try {
        const r = asRec(await this.client.get(`/disclosures/${encodeURIComponent(str(d.doc_id, 'doc_id'))}/sections/${section}`), 'section')
        const html = typeof r.section_text === 'string' ? r.section_text : null
        if (!html) {
          reasons.push(`${label}: 報告書に該当セクション(${section})がありません`)
          return null
        }
        const e = excerpt(htmlToText(html), max)
        return {
          kind: section, docId: str(d.doc_id, 'doc_id'), docTitle: title(d), disclosedAt: typeof d.disclosed_at === 'string' ? d.disclosed_at : '',
          text: e.text, truncated: e.truncated,
          pdfUrl: typeof d.pdf_url === 'string' ? d.pdf_url : null,
          sourceUrl: typeof d.source_url === 'string' ? d.source_url : null,
        }
      } catch (e) {
        reasons.push(`${label}: 取得できませんでした(${e instanceof Error ? e.message : '不明'})`)
        return null
      }
    }
    const got = await Promise.all([
      fetchSection(latest, 'mda', 3000, '経営者による分析(業績要因)'),
      fetchSection(yuho, 'management_policy', 3000, '経営方針・経営環境・課題'),
      fetchSection(yuho, 'risk_factors', 2000, '事業等のリスク'),
    ])
    const docs = got.filter((x): x is NarrativeDoc => x != null)
    return {
      data: { docs, recentIr, reasons },
      meta: meta('narratives', list, (latest?.disclosed_at as string | undefined)?.slice(0, 10) ?? null),
    }
  }

  async getIndicators(code: string): Promise<Dataset<IndicatorRow[]>> {
    const b = asRec(await this.client.get('/indicators', { security_code: code, years: 6 }), 'indicators')
    const units = fieldUnits(b)
    assertUnit(units, 'net_debt', 'jpy')
    const pc = (x: Rec, key: string) => toPercent(numOrNull(x[key], key), key, units)
    const rows: IndicatorRow[] = asArr(b.periods, 'periods')
      .map((r) => asRec(r, 'periods[] item'))
      .map((x) => {
        const roeComputed = pc(x, 'roe_computed')
        const roeReported = roeComputed == null ? pc(x, 'roe') : null
        return {
          fiscalYear: str(x.fiscal_year, 'fiscal_year'),
          roePct: roeComputed ?? roeReported,
          roeKey: roeComputed != null ? ('roe_computed' as const) : roeReported != null ? ('roe' as const) : null,
          roaPct: pc(x, 'roa'),
          operatingMarginPct: pc(x, 'operating_margin'),
          netMarginPct: pc(x, 'net_margin'),
          // 報告値(ratio)ではなく計算値(percent)を使う。ドキュメントの推奨に従う
          equityRatioPct: pc(x, 'equity_ratio_computed'),
          payoutRatioPct: pc(x, 'payout_ratio'),
          salesGrowthPct: pc(x, 'sales_growth'),
          operatingIncomeGrowthPct: pc(x, 'operating_income_growth'),
          netIncomeGrowthPct: pc(x, 'net_income_growth'),
          netDebt: numOrNull(x.net_debt, 'net_debt'),
        }
      })
      .sort((a, c) => (a.fiscalYear < c.fiscalYear ? -1 : 1))
    return { data: rows, meta: meta('indicators', b, rows.at(-1)?.fiscalYear ?? null), defs: fieldDefs(b) }
  }

  async getDividends(edinetCode: string): Promise<Dataset<DividendRow[]>> {
    const b = asRec(await this.client.get('/dividends', { edinet_code: edinetCode }), 'dividends')
    const units = fieldUnits(b)
    const rows = asArr(b.records, 'records')
      .map((r) => asRec(r, 'records item'))
      .map((x) => ({
        fiscalYear: numOrNull(x.fiscal_year, 'fiscal_year') ?? 0,
        annualDps: numOrNull(x.annual_dps_adjusted, 'annual_dps_adjusted'),
        doePct: toPercent(numOrNull(x.doe, 'doe'), 'doe', units),
      }))
      .sort((a, c) => a.fiscalYear - c.fiscalYear)
    return { data: rows, meta: meta('dividends', b, rows.at(-1)?.fiscalYear?.toString() ?? null), defs: fieldDefs(b) }
  }

  async getWeeklyMargin(code: string): Promise<Dataset<WeeklyMargin[]>> {
    const b = asRec(await this.client.get(`/securities/${encodeURIComponent(code)}/weekly-margin-balance`), 'weekly-margin')
    const weeks = asArr(b.weeks, 'weeks')
      .map((r) => asRec(r, 'weeks item'))
      .map((x) => ({
        reportDate: str(x.report_date, 'report_date'),
        buyBalance: numOrNull(x.buy_balance_total, 'buy_balance_total'),
        sellBalance: numOrNull(x.sell_balance_total, 'sell_balance_total'),
        marginRatio: numOrNull(x.margin_ratio, 'margin_ratio'),
        buyChange: numOrNull(x.buy_balance_change, 'buy_balance_change'),
        sellChange: numOrNull(x.sell_balance_change, 'sell_balance_change'),
      }))
      .sort((a, c) => (a.reportDate < c.reportDate ? -1 : 1))
    return { data: weeks.slice(-12), meta: meta('weekly_margin', b, weeks.at(-1)?.reportDate ?? null), defs: fieldDefs(b) }
  }

  async getJsfMargin(code: string) {
    const b = asRec(await this.client.get(`/securities/${encodeURIComponent(code)}/jsf-margin-daily`), 'jsf-margin-daily')
    const days: JsfDay[] = asArr(b.days, 'days')
      .map((r) => asRec(r, 'days item'))
      .map((x) => ({
        date: str(x.date, 'date'),
        loanBalance: numOrNull(x.loan_balance, 'loan_balance'),
        stockLoanBalance: numOrNull(x.stock_loan_balance, 'stock_loan_balance'),
        netBalance: numOrNull(x.net_balance, 'net_balance'),
        lendingRatio: numOrNull(x.lending_ratio, 'lending_ratio'),
      }))
    const reverse: JsfReverse[] = (Array.isArray(b.reverse) ? b.reverse : [])
      .map((r) => asRec(r, 'reverse item'))
      .map((x) => ({
        date: str(x.date, 'date'),
        feeTotal: numOrNull(x.fee_total, 'fee_total'),
        feeDays: numOrNull(x.fee_days, 'fee_days'),
      }))
    return { data: { days: days.slice(-20), reverse: reverse.slice(-20) }, meta: meta('jsf_margin', b, days.at(-1)?.date ?? null) }
  }

  async getShareholders(edinetCode: string): Promise<Dataset<ShareholderRow[]>> {
    const b = asRec(await this.client.get('/shareholders', { edinet_code: edinetCode }), 'shareholders')
    const fu = fieldUnits(b)
    assertUnit(fu, 'holding_ratio', 'percent')
    const rows = asArr(b.shareholders, 'shareholders')
      .map((r) => asRec(r, 'shareholders item'))
      .map((x) => ({
        holderName: str(x.holder_name, 'holder_name'),
        holdingRatioPct: numOrNull(x.holding_ratio, 'holding_ratio'),
        previousRatioPct: numOrNull(x.previous_ratio, 'previous_ratio'),
      }))
    return { data: rows.slice(0, 5), meta: meta('shareholders', b, null) }
  }
}
