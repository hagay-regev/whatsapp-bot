/**
 * calendar.ts
 * Google Calendar integration for רגב.
 * אירועים שרגב יוצר מסומנים ב-✦ בשם.
 */

const BOT_MARK = '✦'  // אימוג'י קטן לאירועים שרגב יצר

// ── Auth ──────────────────────────────────────────────────────────────────────

export async function getAccessToken(): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN!,
      grant_type:    'refresh_token',
    }),
  })
  const data = await res.json() as { access_token?: string; error?: string }
  if (!res.ok) throw new Error(`Google token error: ${JSON.stringify(data)}`)
  return data.access_token!
}

// ── Calendar ID resolution ────────────────────────────────────────────────────

export function resolveCalendarId(name?: string): string {
  const personal = process.env.GOOGLE_CALENDAR_PERSONAL ?? 'primary'
  const family   = process.env.GOOGLE_CALENDAR_FAMILY   ?? personal
  const work     = process.env.GOOGLE_CALENDAR_WORK     ?? personal

  if (!name) return personal
  const n = name.toLowerCase()
  if (n.includes('משפח') || n.includes('family'))                           return family
  if (n.includes('עבוד') || n.includes('work') || n.includes('regev'))     return work
  if (n.includes('אישי') || n.includes('personal'))                         return personal
  return personal
}

// ── Create event ──────────────────────────────────────────────────────────────

export async function createEvent(opts: {
  title: string
  datetime: string          // YYYY-MM-DDTHH:MM:00
  end_datetime?: string
  all_day?: boolean
  description?: string
  calendarName?: string
  attendees?: string[]
}): Promise<string> {
  const { title, datetime, end_datetime, all_day, description, calendarName, attendees } = opts
  const [datePart, timePart] = datetime.split('T')
  if (!datePart) return `❌ פורמט תאריך לא תקין: ${datetime}`

  const token      = await getAccessToken()
  const calendarId = resolveCalendarId(calendarName)

  let start: Record<string, string>
  let end: Record<string, string>

  if (all_day || !timePart) {
    const nextDay = new Date(datePart + 'T00:00:00Z')
    nextDay.setUTCDate(nextDay.getUTCDate() + 1)
    start = { date: datePart }
    end   = { date: nextDay.toISOString().slice(0, 10) }
  } else {
    let endDt: string
    if (end_datetime) {
      endDt = end_datetime.includes('T') ? end_datetime : `${datePart}T${end_datetime.slice(0, 5)}:00`
    } else {
      const [hh, mm] = timePart.split(':').map(Number)
      const total    = hh * 60 + mm + 60
      endDt = `${datePart}T${String(Math.floor(total / 60) % 24).padStart(2,'0')}:${String(total % 60).padStart(2,'0')}:00`
    }
    start = { dateTime: datetime,  timeZone: 'Asia/Jerusalem' }
    end   = { dateTime: endDt,     timeZone: 'Asia/Jerusalem' }
  }

  const event: Record<string, unknown> = {
    summary:     `${title} ${BOT_MARK}`,
    description: description ?? 'נוצר דרך רגב',
    start, end,
    reminders: { useDefault: false, overrides: all_day ? [] : [{ method: 'popup', minutes: 30 }] },
  }
  if (attendees?.length) event.attendees = attendees.map(email => ({ email }))

  const res  = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(event) },
  )
  const data = await res.json() as { error?: unknown }
  if (!res.ok) throw new Error(JSON.stringify(data.error).slice(0, 150))

  const dateStr  = datePart.slice(5).replace('-', '/')
  const timeStr  = timePart ? timePart.slice(0, 5) : 'כל היום'
  const calLabel = calendarName ? ` (${calendarName})` : ''
  return `📅 נוסף ביומן${calLabel}:\n*${title}*\n${dateStr} ⏰ ${timeStr}`
}

// ── Get schedule ──────────────────────────────────────────────────────────────

export async function getSchedule(opts: {
  date?: string
  date_end?: string
  search?: string
  calendarName?: string
}): Promise<string> {
  const token   = await getAccessToken()
  const today   = new Date().toISOString().slice(0, 10)
  const search  = opts.search?.toLowerCase() ?? ''
  const shift = (ymd: string, n: number) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
  // Name search without an explicit date → scan a wide window (6 months back → ~13 months ahead).
  const date    = opts.date ?? (search ? shift(today, -180) : today)
  const dateEnd = opts.date_end ?? (opts.date ? opts.date : (search ? shift(today, 400) : today))

  const personal = process.env.GOOGLE_CALENDAR_PERSONAL ?? 'primary'
  const family   = process.env.GOOGLE_CALENDAR_FAMILY   ?? personal
  const work     = process.env.GOOGLE_CALENDAR_WORK     ?? personal

  let calIds: string[]
  const cn = (opts.calendarName ?? '').toLowerCase()
  if (cn.includes('משפח') || cn.includes('family'))       calIds = [family]
  else if (cn.includes('עבוד') || cn.includes('work'))    calIds = [work]
  else if (cn.includes('אישי') || cn.includes('personal')) calIds = [personal]
  else calIds = Array.from(new Set([personal, family, work]))

  const timeMin = `${date}T00:00:00+03:00`
  const timeMax = `${dateEnd}T23:59:59+03:00`

  type GEvent = { summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } }
  const all: Array<GEvent & { calId: string }> = []

  for (const calId of calIds) {
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`)
    url.searchParams.set('timeMin', timeMin)
    url.searchParams.set('timeMax', timeMax)
    url.searchParams.set('singleEvents', 'true')
    url.searchParams.set('orderBy', 'startTime')
    url.searchParams.set('maxResults', search ? '100' : '20')
    if (search) url.searchParams.set('q', search)

    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) continue
    const data = await res.json() as { items?: GEvent[] }
    for (const e of data.items ?? []) all.push({ ...e, calId })
  }

  const filtered = search
    ? all.filter(e => (e.summary ?? '').toLowerCase().includes(search))
    : all

  if (filtered.length === 0) {
    if (search) return `📅 לא מצאתי אירועים עם "${opts.search}" ביומן.`
    const label = date === today ? 'היום' : date.slice(5).replace('-', '/')
    return `📅 אין אירועים ${label}.`
  }

  const lines = filtered.map(e => {
    const dt = e.start?.dateTime
    const d  = e.start?.date
    const time = dt ? dt.split('T')[1]?.slice(0, 5) : 'כל היום'
    const ds = (dt ?? d ?? '').slice(0, 10)
    // include the year on name-searches (results may span years); otherwise just DD/MM
    const dateStr = search ? `${ds.slice(8)}/${ds.slice(5, 7)}/${ds.slice(0, 4)}` : ds.slice(5).replace('-', '/')
    return `• ${dateStr} ${time} — ${e.summary ?? '(ללא שם)'}`
  })

  if (search) return `📅 ${filtered.length} אירועים עם "${opts.search}":\n${lines.join('\n')}`

  const label = date === dateEnd
    ? (date === today ? 'היום' : date.slice(5).replace('-', '/'))
    : `${date.slice(5).replace('-','/')}–${dateEnd.slice(5).replace('-','/')}`

  return `📅 לוח זמנים ${label}:\n${lines.join('\n')}`
}

// ── Update event ──────────────────────────────────────────────────────────────

export async function updateEvent(params: {
  search: string
  new_title?: string
  new_datetime?: string
  new_end_datetime?: string
  new_calendar?: string
  all_day?: boolean
}): Promise<string> {
  const token    = await getAccessToken()
  const personal = process.env.GOOGLE_CALENDAR_PERSONAL ?? 'primary'
  const family   = process.env.GOOGLE_CALENDAR_FAMILY   ?? personal
  const work     = process.env.GOOGLE_CALENDAR_WORK     ?? personal
  const allCals  = Array.from(new Set([personal, family, work]))

  const now     = new Date()
  const timeMin = new Date(now.getTime() - 7 * 86400000).toISOString()
  const timeMax = new Date(now.getTime() + 365 * 86400000).toISOString()

  type CalEvent = { id: string; summary: string; calendarId: string; start?: { dateTime?: string; date?: string } }
  let found: CalEvent | null = null

  for (const calId of allCals) {
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`)
    url.searchParams.set('timeMin', timeMin); url.searchParams.set('timeMax', timeMax)
    url.searchParams.set('singleEvents', 'true'); url.searchParams.set('q', params.search); url.searchParams.set('maxResults', '10')
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) continue
    const data = await res.json() as { items?: Array<{ id: string; summary?: string; start?: { dateTime?: string; date?: string } }> }
    const match = (data.items ?? []).find(e => (e.summary ?? '').toLowerCase().includes(params.search.toLowerCase()))
    if (match) { found = { id: match.id, summary: match.summary ?? '', calendarId: calId, start: match.start }; break }
  }

  if (!found) return `❌ לא מצאתי אירוע עם "${params.search}".`

  // Move to different calendar
  if (params.new_calendar) {
    const destCalId = resolveCalendarId(params.new_calendar)
    if (destCalId === found.calendarId) return `ℹ️ האירוע כבר נמצא ביומן זה.`
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(found.calendarId)}/events/${found.id}/move?destination=${encodeURIComponent(destCalId)}`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
    )
    if (!res.ok) throw new Error(`Move error: ${res.status}`)
    return `✅ "${found.summary}" הועבר ליומן ${params.new_calendar}.`
  }

  const patch: Record<string, unknown> = {}
  if (params.new_title) patch.summary = `${params.new_title} ${BOT_MARK}`
  if (params.new_datetime) {
    const origDate = ((found.start?.dateTime ?? '').split('T')[0]) ?? ''
    const startStr = params.new_datetime.includes('T') ? params.new_datetime : `${origDate}T${params.new_datetime.slice(0,5)}:00`
    patch.start = { dateTime: startStr, timeZone: 'Asia/Jerusalem' }
    const endStr = params.new_end_datetime
      ? (params.new_end_datetime.includes('T') ? params.new_end_datetime : `${origDate}T${params.new_end_datetime.slice(0,5)}:00`)
      : (() => { const [d,t] = startStr.split('T'); const [h,m] = (t??'').split(':').map(Number); const e = h*60+m+60; return `${d}T${String(Math.floor(e/60)).padStart(2,'0')}:${String(e%60).padStart(2,'0')}:00` })()
    patch.end = { dateTime: endStr, timeZone: 'Asia/Jerusalem' }
  }

  if (Object.keys(patch).length === 0) return '❌ לא הבנתי מה לשנות.'

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(found.calendarId)}/events/${found.id}`,
    { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(patch) },
  )
  if (!res.ok) throw new Error(`Patch error: ${res.status}`)
  return `✅ "${found.summary}" עודכן!`
}

// ── Bulk rename (text replace in titles) ──────────────────────────────────────

export async function renameEvents(opts: { find: string; replace: string; calendarName?: string }): Promise<string> {
  const token    = await getAccessToken()
  const personal = process.env.GOOGLE_CALENDAR_PERSONAL ?? 'primary'
  const family   = process.env.GOOGLE_CALENDAR_FAMILY   ?? personal
  const work     = process.env.GOOGLE_CALENDAR_WORK     ?? personal
  const cn = (opts.calendarName ?? '').toLowerCase()
  const calIds = cn.includes('משפח') || cn.includes('family') ? [family]
    : cn.includes('עבוד') || cn.includes('work') ? [work]
    : cn.includes('אישי') || cn.includes('personal') ? [personal]
    : Array.from(new Set([personal, family, work]))

  const now     = new Date()
  const timeMin = new Date(now.getTime() - 180 * 86400000).toISOString()
  const timeMax = new Date(now.getTime() + 400 * 86400000).toISOString()

  // Forgiving match: tokens of `find` separated by any spaces/dashes — so
  // "אביה חופשה" matches "אביה - חופשה" and replaces it cleanly.
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const tokens = opts.find.trim().split(/\s+/).filter(t => t && t !== '-')
  const re = new RegExp(tokens.map(esc).join('[\\s\\-]*'), 'gi')
  const qTerm = [...tokens].sort((a, b) => b.length - a.length)[0] ?? opts.find

  let updated = 0
  for (const calId of calIds) {
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`)
    url.searchParams.set('timeMin', timeMin); url.searchParams.set('timeMax', timeMax)
    url.searchParams.set('singleEvents', 'true'); url.searchParams.set('q', qTerm); url.searchParams.set('maxResults', '100')
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) continue
    const data = await res.json() as { items?: Array<{ id: string; summary?: string }> }
    for (const e of data.items ?? []) {
      const title = e.summary ?? ''
      if (!re.test(title)) continue
      re.lastIndex = 0
      const newTitle = title.replace(re, opts.replace)
      if (newTitle === title) continue
      const p = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events/${e.id}`,
        { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ summary: newTitle }) },
      )
      if (p.ok) updated++
    }
  }

  if (updated === 0) return `❌ לא מצאתי אירועים שמכילים "${opts.find}".`
  return `✅ עודכנו ${updated} אירועים: "${opts.find}" → "${opts.replace}".`
}

// ── Delete event ──────────────────────────────────────────────────────────────

export async function deleteEvent(search: string): Promise<string> {
  const token    = await getAccessToken()
  const personal = process.env.GOOGLE_CALENDAR_PERSONAL ?? 'primary'
  const family   = process.env.GOOGLE_CALENDAR_FAMILY   ?? personal
  const work     = process.env.GOOGLE_CALENDAR_WORK     ?? personal
  const allCals  = Array.from(new Set([personal, family, work]))

  const now     = new Date()
  const timeMin = new Date(now.getTime() - 7 * 86400000).toISOString()
  const timeMax = new Date(now.getTime() + 365 * 86400000).toISOString()

  type CE = { id: string; summary: string; calendarId: string }
  const matches: CE[] = []

  for (const calId of allCals) {
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`)
    url.searchParams.set('timeMin', timeMin); url.searchParams.set('timeMax', timeMax)
    url.searchParams.set('singleEvents', 'true'); url.searchParams.set('q', search); url.searchParams.set('maxResults', '20')
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) continue
    const data = await res.json() as { items?: Array<{ id: string; summary?: string }> }
    for (const e of data.items ?? []) {
      if ((e.summary ?? '').toLowerCase().includes(search.toLowerCase())) matches.push({ id: e.id, summary: e.summary ?? '', calendarId: calId })
    }
  }

  if (matches.length === 0) return `❌ לא מצאתי אירוע עם "${search}".`

  const deleted: string[] = []
  for (const ev of matches) {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(ev.calendarId)}/events/${ev.id}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    )
    if (res.ok || res.status === 204 || res.status === 410) deleted.push(ev.summary)
  }

  if (deleted.length === 0) return `❌ לא הצלחתי למחוק.`
  if (deleted.length === 1) return `🗑️ "${deleted[0]}" נמחק!`
  return `🗑️ נמחקו ${deleted.length} אירועים:\n${deleted.map(s => `• ${s}`).join('\n')}`
}
