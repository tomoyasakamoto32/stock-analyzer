// PoC: IRBANK実データの収集→指標計算までをローカルで確認する(AI送信・DB保存なし)。
//   IRBANK_API_KEY=irbk_key_... node scripts/poc.mjs 7203
// 実レスポンスの形状・単位・取得リクエスト数・CPU時間(目安)を確認する用途。出力は標準出力のみ。
import { IrbankProvider } from '../src/server/services/providers/irbank/index.ts'
import { collect } from '../src/server/services/analysis/collect.ts'
import { buildSnapshot } from '../src/server/services/analysis/snapshot.ts'

const code = (process.argv[2] ?? '').trim().toUpperCase()
const key = process.env.IRBANK_API_KEY
if (!/^[0-9A-Z]{4}$/.test(code) || !key) {
  console.error('使い方: IRBANK_API_KEY=... node scripts/poc.mjs <4桁コード>')
  process.exit(1)
}
const provider = new IrbankProvider(key)
const t0 = performance.now()
const cpu0 = process.cpuUsage()
const collected = await collect(provider, code)
const t1 = performance.now()
const cpu1 = process.cpuUsage()
const snap = buildSnapshot(collected)
const cpu2 = process.cpuUsage(cpu1)
const cpuCollect = process.cpuUsage(cpu0)

console.log(`銘柄: ${snap.stock.code} ${snap.stock.name} (${snap.stock.market} / ${snap.stock.sector})`)
console.log(`日足: ${collected.bars.length}件 (最新 ${snap.priceAsOf}) / 年次財務: ${collected.financials.annual.length}期`)
console.log(`IRBANKリクエスト数: ${provider.requestCount} (Free: 200/日, 60/分)`)
console.log(`経過 ${(t1 - t0).toFixed(0)}ms / 収集CPU ${((cpuCollect.user + cpuCollect.system) / 1000).toFixed(1)}ms / 指標計算CPU ${((cpu2.user + cpu2.system) / 1000).toFixed(1)}ms (Node計測。Workers実測とは別)`)
console.log('出典:', [...new Set(snap.sources.map((s) => s.sourceLabel))].join(' / '))
console.log('\n不足情報:')
for (const m of snap.missingData) console.log(' -', m)
console.log('\n主要指標:')
for (const e of snap.evidence.filter((e) => /^(price\.close|mcap|fc\.|seg\.|ir\.|val\.|tech\.(sma|rsi|macd)|sd\.)/.test(e.id)))
  console.log(` ${e.id.padEnd(26)} ${String(e.value).padEnd(22)} ${e.unit} (${e.asOf ?? '-'})`)
console.log('\nAPI側の項目定義(fields[].note。独自計算との定義差を確認する):')
for (const [k, v] of Object.entries(collected.defs)) if (/(roe|roa|margin|equity_ratio|payout|fcf|doe|net_debt|dividend_yield|^valuations\.per$)/.test(k)) console.log(` ${k}: ${v}`)
console.log('\n取得元の内訳(api/calculated):', Object.entries(snap.evidence.reduce((a, e) => ((a[e.origin] = (a[e.origin] ?? 0) + 1), a), {})).map(([k, n]) => `${k}=${n}`).join(' '))
console.log(`\nevidence ${snap.evidence.length}件 / AI入力JSON ${JSON.stringify(snap.evidence).length}文字`)
