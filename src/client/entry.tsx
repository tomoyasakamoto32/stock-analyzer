import { render } from 'hono/jsx/dom'
import { AnalysisControls } from './components/analysis-controls.tsx'
import { ReportTabs } from './components/report-tabs.tsx'
import { MasterRefresh } from './components/master-refresh.tsx'
import { parseInvestmentStyle } from '../shared/validate.ts'

// SSR済みDOMへのhydrationはせず、専用コンテナの中身を置き換えて描画する。
const controls = document.getElementById('analysis-controls')
if (controls) {
  controls.textContent = ''
  render(<AnalysisControls fixedCode={controls.dataset.code} defaultStyle={parseInvestmentStyle(controls.dataset.style) ?? undefined} webSearchAvailable={controls.dataset.webSearch === '1'} />, controls)
}

const tabs = document.getElementById('report-tabs-root')
if (tabs) {
  const panels = (tabs.dataset.panels ?? '').split(',').filter(Boolean)
  const labels = (tabs.dataset.labels ?? '').split(',')
  if (panels.length) render(<ReportTabs panels={panels} labels={labels} />, tabs)
}

const refresh = document.getElementById('master-refresh')
if (refresh) {
  refresh.textContent = ''
  render(<MasterRefresh />, refresh)
}
