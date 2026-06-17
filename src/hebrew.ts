/**
 * hebrew.ts
 * המרת תאריכים עבריים ופרשות לתאריך לועזי מדויק (ספריית @hebcal/core),
 * והוספתם כאירועי כל-יום ליומן. מחליף ניחוש של המודל בלוח עברי אמין.
 */

import { getAccessToken, resolveCalendarId } from './calendar'

const pad = (n: number) => String(n).padStart(2, '0')
const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`  // local, not UTC
const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')
const addDays = (ymd: string, n: number) => { const d = new Date(ymd + 'T12:00:00'); d.setDate(d.getDate() + n); return fmt(d) }
const heDate = (s: string) => s ? `${s.slice(8)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : '?'

// @hebcal/core is ESM-only; the project is CJS — load it lazily via dynamic import.
let _hebcal: typeof import('@hebcal/core') | undefined
async function hebcal() { return (_hebcal ??= await import('@hebcal/core')) }

export interface HebEvent {
  title: string
  parasha?: string                       // English transliteration, e.g. 'Noach', 'Ki Tisa'
  day?: number; month?: string           // Hebrew date, e.g. 29 / 'Elul'
  year: number                           // Hebrew year, e.g. 5787
  end_day?: number; end_month?: string; end_year?: number  // optional range end (Hebrew date)
}

async function toGregorian(parasha: string | undefined, day: number | undefined, month: string | undefined, year: number): Promise<string | null> {
  // Types cast to any: the runtime API is verified; hebcal's d.ts overloads
  // (e.g. HDate(day, monthName, year)) don't match the string-month call.
  const { HDate, HebrewCalendar } = (await hebcal()) as any
  if (parasha) {
    const evs = HebrewCalendar.calendar({ year, isHebrewYear: true, il: true, sedrot: true, noHolidays: true })
    const target = norm(parasha)
    for (const e of evs) {
      const desc = e.getDesc('en')
      if (!desc.startsWith('Parashat ')) continue
      // exact component match (so "Shlach" ≠ "Vayishlach"; handles "Tazria-Metzora")
      const parts = desc.replace('Parashat ', '').split('-').map(norm)
      if (parts.includes(target)) return fmt(e.getDate().greg())
    }
    return null
  }
  if (day && month) return fmt(new HDate(day, month, year).greg())
  return null
}

// Remember the last previewed set so an approval ("👍") can create it without the
// model having to re-list all events.
let lastPreview: { cal: string; rows: Array<{ title: string; start: string | null; end: string | null }> } | null = null

export async function hebrewEvents(opts: { calendarName?: string; create: boolean; events: HebEvent[] }): Promise<string> {
  const cal = opts.calendarName ?? lastPreview?.cal ?? 'משפחתי'
  let resolved = await Promise.all(opts.events.map(async ev => ({
    title: ev.title,
    start: await toGregorian(ev.parasha, ev.day, ev.month, ev.year),
    end: ev.end_day && ev.end_month ? await toGregorian(undefined, ev.end_day, ev.end_month, ev.end_year ?? ev.year) : null,
  })))

  // On create with no fresh events, fall back to the previewed set.
  if (opts.create && !resolved.some(r => r.start) && lastPreview) resolved = lastPreview.rows

  const lines = resolved.map(r => r.start
    ? `• ${r.title} — ${heDate(r.start)}${r.end ? ` עד ${heDate(r.end)}` : ''}`
    : `⚠️ ${r.title} — לא הצלחתי לחשב תאריך`)

  if (!opts.create) {
    lastPreview = { cal, rows: resolved.filter(r => r.start) }
    const ok = resolved.filter(r => r.start).length
    return `📋 לאישור (${ok} תאריכים) ליומן ${cal}:\n${lines.join('\n')}\n\nלהוסיף את כולם? 👍 לאישור`
  }

  const token = await getAccessToken()
  const calId = resolveCalendarId(cal)
  let added = 0
  for (const r of resolved) {
    if (!r.start) continue
    const body = {
      summary: r.title,
      start: { date: r.start },
      end: { date: addDays(r.end ?? r.start, 1) },  // Google all-day end is exclusive
      description: 'נוצר דרך רגב',
      reminders: { useDefault: false },
    }
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    )
    if (res.ok) added++
  }
  lastPreview = null  // consumed
  return `✅ נוספו ${added}/${resolved.length} אירועים ליומן ${cal}.`
}
