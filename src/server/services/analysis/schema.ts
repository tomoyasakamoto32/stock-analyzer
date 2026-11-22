import { SECTION_TYPES } from '../../../shared/types.ts'

export const SCHEMA_VERSION = 'output-2'

const str = { type: 'string' } as const
const strArr = { type: 'array', items: str } as const
const finding = {
  type: 'object',
  properties: { text: str, evidenceIds: strArr },
  required: ['text', 'evidenceIds'],
  additionalProperties: false,
} as const
const findings = { type: 'array', items: finding } as const
const priceRange = {
  anyOf: [
    {
      type: 'object',
      properties: { low: { type: 'number' }, high: { type: 'number' }, rationale: str, evidenceIds: strArr },
      required: ['low', 'high', 'rationale', 'evidenceIds'],
      additionalProperties: false,
    },
    { type: 'null' },
  ],
} as const

const entryTier = {
  type: 'object',
  properties: { low: { type: 'number' }, high: { type: 'number' }, allocationPct: { type: 'number' }, rationale: str, evidenceIds: strArr },
  required: ['low', 'high', 'allocationPct', 'rationale', 'evidenceIds'],
  additionalProperties: false,
} as const

const section = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: [...SECTION_TYPES] },
    outlook: { type: 'string', enum: ['positive', 'neutral', 'negative', 'insufficient_data'] },
    summary: str,
    findings,
    bullishFactors: findings,
    bearishFactors: findings,
    risks: findings,
    catalysts: findings,
    missingData: strArr,
  },
  required: ['type', 'outlook', 'summary', 'findings', 'bullishFactors', 'bearishFactors', 'risks', 'catalysts', 'missingData'],
  additionalProperties: false,
} as const

const scenario = {
  type: 'object',
  properties: { name: { type: 'string', enum: ['bull', 'base', 'bear'] }, conditions: str, outlook: str, evidenceIds: strArr },
  required: ['name', 'conditions', 'outlook', 'evidenceIds'],
  additionalProperties: false,
} as const

/** OpenAI Structured Outputs(strict)用。型定義(shared/types.ts)および output-check.ts と同期させること。 */
export const OUTPUT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    sections: { type: 'array', items: section },
    overall: {
      type: 'object',
      properties: {
        summary: str,
        stance: { type: 'string', enum: ['consider', 'wait', 'avoid', 'insufficient_data'] },
        fairValue: priceRange,
        entries: { type: 'array', items: entryTier },
        takeProfit: priceRange,
        stopLoss: priceRange,
        scenarios: { type: 'array', items: scenario },
        risks: findings,
        contradictions: strArr,
        missingData: strArr,
      },
      required: ['summary', 'stance', 'fairValue', 'entries', 'takeProfit', 'stopLoss', 'scenarios', 'risks', 'contradictions', 'missingData'],
      additionalProperties: false,
    },
  },
  required: ['sections', 'overall'],
  additionalProperties: false,
} as const
