/**
 * usage.ts
 * מעקב צריכת טוקנים/עלות של רגב, מצטבר לפי יום (שעון ישראל), נשמר לדיסק.
 * שאילתה דרך הכלי usage_report — "כמה צרכת היום/החודש?".
 */

import fs from 'fs'
import path from 'path'

const USAGE_PATH = path.join(__dirname, '..', 'usage.json')

interface Bucket { in: number; cacheRead: number; cacheWrite: number; out: number }
interface Day { sonnet: Bucket; haiku: Bucket }
type Store = Record<string, Day> // key: YYYY-MM-DD (Israel)

const emptyBucket = (): Bucket => ({ in: 0, cacheRead: 0, cacheWrite: 0, out: 0 })
const emptyDay = (): Day => ({ sonnet: emptyBucket(), haiku: emptyBucket() })

function load(): Store {
  try { return JSON.parse(fs.readFileSync(USAGE_PATH, 'utf-8')) } catch { return {} }
}
function save(s: Store) { fs.writeFile(USAGE_PATH, JSON.stringify(s), () => {}) }

const ilDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date())

interface ApiUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

export function recordUsage(model: 'sonnet' | 'haiku', u: ApiUsage) {
  const s = load()
  const day = ilDay()
  if (!s[day]) s[day] = emptyDay()
  const b = s[day][model]
  b.in        += u.input_tokens ?? 0
  b.out       += u.output_tokens ?? 0
  b.cacheRead += u.cache_read_input_tokens ?? 0
  b.cacheWrite+= u.cache_creation_input_tokens ?? 0
  save(s)
}

// מחיר לטוקן (USD), לפי תמחור Anthropic
const PRICE = {
  sonnet: { in: 3 / 1e6, out: 15 / 1e6, cacheRead: 0.30 / 1e6, cacheWrite: 3.75 / 1e6 },
  haiku:  { in: 1 / 1e6, out: 5 / 1e6,  cacheRead: 0.10 / 1e6, cacheWrite: 1.25 / 1e6 },
}
const cost = (model: 'sonnet' | 'haiku', b: Bucket) => {
  const p = PRICE[model]
  return b.in * p.in + b.out * p.out + b.cacheRead * p.cacheRead + b.cacheWrite * p.cacheWrite
}
const totalTokens = (b: Bucket) => b.in + b.cacheRead + b.cacheWrite + b.out

export function getUsageReport(period: 'today' | 'month' = 'today'): string {
  const s = load()
  const day = ilDay()
  const keys = period === 'month'
    ? Object.keys(s).filter(k => k.startsWith(day.slice(0, 7)))
    : [day]

  const tot = emptyDay()
  for (const k of keys) {
    const d = s[k]; if (!d) continue
    for (const m of ['sonnet', 'haiku'] as const)
      for (const f of ['in', 'cacheRead', 'cacheWrite', 'out'] as const) tot[m][f] += d[m][f]
  }

  const usd = cost('sonnet', tot.sonnet) + cost('haiku', tot.haiku)
  const label = period === 'month' ? 'החודש' : 'היום'
  const sTok = totalTokens(tot.sonnet)
  const hTok = totalTokens(tot.haiku)

  if (sTok + hTok === 0) return `📊 צריכת רגב — ${label}\nעדיין אין צריכה.`

  const cachePct = tot.sonnet.in + tot.sonnet.cacheRead > 0
    ? Math.round(100 * tot.sonnet.cacheRead / (tot.sonnet.in + tot.sonnet.cacheRead))
    : 0

  return `📊 צריכת רגב — ${label}\n` +
    `💵 עלות מוערכת: $${usd.toFixed(3)} (≈ ₪${(usd * 3.7).toFixed(2)})\n` +
    `🧠 מוח (Sonnet): ${sTok.toLocaleString()} טוקנים | ${cachePct}% מה-cache (חיסכון)\n` +
    `⚡ שער קבוצות (Haiku): ${hTok.toLocaleString()} טוקנים`
}
