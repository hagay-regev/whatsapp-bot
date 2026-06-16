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
  try {
    const raw = fs.readFileSync(USAGE_PATH, 'utf-8').trim()
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}
// Atomic + synchronous: write to a temp file then rename, so concurrent
// writers never see (or leave) a blank/torn file. Sync keeps each
// read-modify-write call atomic within the single-threaded bot process.
function save(s: Store) {
  const tmp = `${USAGE_PATH}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(s))
  fs.renameSync(tmp, USAGE_PATH)
}

const ilDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date())
const addDays = (d: string, n: number) => {
  const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n)
  return t.toISOString().slice(0, 10)
}

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

function dayUsd(d: Day | undefined): number {
  if (!d) return 0
  return cost('sonnet', d.sonnet) + cost('haiku', d.haiku)
}

function sumDays(s: Store, keys: string[]): Day {
  const tot = emptyDay()
  for (const k of keys) {
    const d = s[k]; if (!d) continue
    for (const m of ['sonnet', 'haiku'] as const)
      for (const f of ['in', 'cacheRead', 'cacheWrite', 'out'] as const) tot[m][f] += d[m][f]
  }
  return tot
}

export function getUsageReport(period: 'today' | 'week' | 'month' = 'today'): string {
  const s = load()
  const today = ilDay()

  // ── Daily summary (today) ──
  if (period === 'today') {
    const tot = sumDays(s, [today])
    const usd = dayUsd(s[today])
    const sTok = totalTokens(tot.sonnet), hTok = totalTokens(tot.haiku)
    if (sTok + hTok === 0) return `📊 צריכת רגב — היום\nעדיין אין צריכה.`
    const cachePct = tot.sonnet.in + tot.sonnet.cacheRead > 0
      ? Math.round(100 * tot.sonnet.cacheRead / (tot.sonnet.in + tot.sonnet.cacheRead)) : 0
    return `📊 צריכת רגב — היום\n` +
      `💵 עלות מוערכת: $${usd.toFixed(3)} (≈ ₪${(usd * 3.7).toFixed(2)})\n` +
      `🧠 מוח (Sonnet): ${sTok.toLocaleString()} טוקנים | ${cachePct}% מה-cache\n` +
      `⚡ שער קבוצות (Haiku): ${hTok.toLocaleString()} טוקנים`
  }

  // ── Bar chart (week / month) ──
  const keys: string[] = []
  if (period === 'week') {
    for (let i = 6; i >= 0; i--) keys.push(addDays(today, -i))
  } else {
    let d = today.slice(0, 7) + '-01'
    while (d <= today) { keys.push(d); d = addDays(d, 1) }
  }

  const costs = keys.map(k => dayUsd(s[k]))
  const total = costs.reduce((a, b) => a + b, 0)
  if (total === 0) return `📊 צריכת רגב — ${period === 'week' ? 'השבוע' : 'החודש'}\nעדיין אין צריכה.`

  const max = Math.max(...costs)
  const W = 10
  const DOW = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש']
  const lines = keys.map((k, i) => {
    const c = costs[i]
    const len = c > 0 ? Math.max(1, Math.round((W * c) / max)) : 0
    const bar = '█'.repeat(len) + '░'.repeat(W - len)
    const dow = period === 'week' ? DOW[new Date(k + 'T12:00:00Z').getUTCDay()] + ' ' : ''
    return `${dow}${k.slice(5)} ${bar} $${c.toFixed(2)}`
  })

  const label = period === 'week' ? 'השבוע (7 ימים)' : 'החודש'
  return `📊 צריכת רגב — ${label}\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n💵 סה"כ: $${total.toFixed(2)} (≈ ₪${(total * 3.7).toFixed(2)})`
}
