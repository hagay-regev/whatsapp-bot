/**
 * billing.ts
 * חיבור רגב למסד הנתונים של אפליקציית התשלומים (אותו Supabase).
 * מחליף את הסוכן הנפרד שרץ על Gemini — כאן הכל כלים שרגב (Claude) מפעיל.
 *
 * דורש ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from '@supabase/supabase-js'
// ws has no bundled types; only used as the realtime transport on Node 20.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const WS = require('ws')
import { config } from './config'

// Node 20 has no native WebSocket; supabase-js realtime needs one supplied.
// We don't use realtime, but createClient initializes it regardless.
const db = createClient(config.supabaseUrl, config.supabaseKey, {
  auth: { persistSession: false },
  realtime: { transport: WS },
})

// ── Owner + clients resolution (cached) ───────────────────────────────────────

let ownerIdCache: string | null = null

async function ownerId(): Promise<string> {
  if (ownerIdCache) return ownerIdCache
  const phone = config.ownerPhone.replace(/\D/g, '')
  const candidates = [phone, '+' + phone, phone.slice(-9)]

  let row = (await db
    .from('notification_preferences')
    .select('user_id')
    .in('whatsapp_number', candidates)
    .limit(1)
    .maybeSingle()).data as { user_id: string } | null

  // Fallback: single enabled WhatsApp user in the system
  if (!row?.user_id) {
    const { data } = await db
      .from('notification_preferences')
      .select('user_id, whatsapp_number')
      .eq('is_whatsapp_enabled', true)
      .not('whatsapp_number', 'is', null)
    if (data?.length === 1) row = data[0] as { user_id: string }
  }

  if (!row?.user_id) throw new Error('לא מצאתי את המשתמש של חגי ב-notification_preferences')
  ownerIdCache = row.user_id
  return ownerIdCache
}

interface Client { id: string; name: string }
let clientsCache: { v: Client[]; t: number } | null = null

async function getClients(): Promise<Client[]> {
  if (clientsCache && Date.now() - clientsCache.t < 5 * 60_000) return clientsCache.v
  const uid = await ownerId()
  const { data } = await db.from('clients').select('id, name').eq('user_id', uid)
  clientsCache = { v: (data ?? []) as Client[], t: Date.now() }
  return clientsCache.v
}

// Dates must be computed in Israel time — the work day/week boundary is local,
// not UTC (otherwise late-evening entries land on the wrong day).
function ilToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date())
}
function ilDow(dateStr: string): number { // 0=Sunday ... 6=Saturday
  return new Date(dateStr + 'T12:00:00Z').getUTCDay()
}
function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function matchClient(clients: Client[], name: string): Client | undefined {
  const n = name.toLowerCase().trim()
  if (!n) return undefined
  return clients.find(c => c.name.toLowerCase().includes(n) || n.includes(c.name.toLowerCase()))
}

// ── Time entries ──────────────────────────────────────────────────────────────

const TYPE_LABEL: Record<string, string> = {
  maintenance: 'תחזוקה',
  paid_implementation: 'יישום בתשלום',
  order_implementation: 'יישום מהזמנה',
}

export async function logHours(opts: {
  client_name: string; hours: number; type?: string; description?: string; date?: string; start_time?: string
}): Promise<string> {
  if (!opts.hours || opts.hours <= 0) return '❌ כמה שעות?'
  const clients = await getClients()
  const matched = matchClient(clients, opts.client_name)
  if (!matched) return `❌ לא מצאתי לקוח בשם "${opts.client_name}". לקוחות:\n${clients.slice(0, 10).map(c => `• ${c.name}`).join('\n')}`

  const uid = await ownerId()
  const date = opts.date ?? ilToday()
  const type = opts.type ?? 'maintenance'
  const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`
  const startMin = (opts.start_time ? Number(opts.start_time.split(':')[0]) || 8 : 8) * 60
  const endMin = startMin + Math.round(opts.hours * 60)

  const { error } = await db.from('time_entries').insert({
    date, client_id: matched.id, user_id: uid,
    start_time: fmt(startMin), end_time: fmt(endMin),
    travel_hours: 0, type, description: opts.description ?? '',
    is_billable: type !== 'maintenance', notes: 'נוצר דרך רגב',
  })
  if (error) return `❌ שגיאה בשמירה: ${error.message}`

  return `✅ דיווח נשמר!\n🏢 ${matched.name}\n🕐 ${opts.hours}h — ${TYPE_LABEL[type] ?? type}\n📅 ${date}${opts.description ? `\n📝 ${opts.description}` : ''}`
}

export async function queryHours(opts: {
  period?: 'today' | 'week' | 'month'; date_from?: string; date_to?: string; list?: boolean
} = {}): Promise<string> {
  const uid = await ownerId()
  const today = ilToday()
  const list = opts.list ?? false

  // Explicit date range (model-driven) takes priority over period presets.
  let from: string, to: string, label: string
  if (opts.date_from) {
    from = opts.date_from
    to = opts.date_to ?? opts.date_from
    label = from === to ? from : `${from} עד ${to}`
  } else {
    const period = opts.period ?? 'today'
    to = today
    // Work week is Sunday–Saturday (Israeli week).
    if (period === 'week') from = addDays(today, -ilDow(today))
    else if (period === 'month') from = today.slice(0, 7) + '-01'
    else from = today
    label = ({ today: 'היום', week: 'השבוע', month: 'החודש' } as Record<string, string>)[period]
  }

  if (list) {
    const { data } = await db.from('time_entries')
      .select('date, work_hours, description, clients(name)')
      .eq('user_id', uid).gte('date', from).lte('date', to)
      .order('date', { ascending: false }).limit(10)
    const rows = (data ?? []) as Array<{ date: string; work_hours: number; description: string; clients?: { name?: string } | null }>
    if (!rows.length) return `📋 אין דיווחים (${label}).`
    return `📋 דיווחים (${label}):\n${rows.map(r => `• ${r.date.slice(5)} | ${r.clients?.name ?? '—'} | ${Number(r.work_hours).toFixed(1)}h${r.description ? ` — ${r.description.slice(0, 30)}` : ''}`).join('\n')}`
  }

  const { data } = await db.from('time_entries')
    .select('work_hours, travel_hours, clients(name)')
    .eq('user_id', uid).gte('date', from).lte('date', to)
  const rows = (data ?? []) as Array<{ work_hours: number; travel_hours: number; clients?: { name?: string } | null }>
  const work = rows.reduce((s, r) => s + Number(r.work_hours ?? 0), 0)
  const travel = rows.reduce((s, r) => s + Number(r.travel_hours ?? 0), 0)
  const byClient = new Map<string, number>()
  for (const r of rows) byClient.set(r.clients?.name ?? '—', (byClient.get(r.clients?.name ?? '—') ?? 0) + Number(r.work_hours ?? 0))
  const top = Array.from(byClient.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, h]) => `  • ${n}: ${h.toFixed(1)}h`).join('\n')
  return `📊 סיכום שעות — ${label}\n⏱ עבודה: ${work.toFixed(1)}h${travel > 0 ? `\n🚗 נסיעות: ${travel.toFixed(1)}h` : ''}\n📋 ${rows.length} דיווחים${top ? `\n\nלפי לקוח:\n${top}` : ''}`
}

// ── Billing ───────────────────────────────────────────────────────────────────

export async function queryBilling(opts: { client_name?: string; status?: 'unpaid' | 'paid' | 'all' }): Promise<string> {
  const status = opts.status ?? 'unpaid'
  let q = db.from('billing_entries').select('id, total_with_vat, expected_payment_date, is_paid, invoice_created, clients(name)')
  if (status === 'unpaid') q = q.eq('is_paid', false).eq('invoice_created', true)
  else if (status === 'paid') q = q.eq('is_paid', true)

  if (opts.client_name) {
    const matched = matchClient(await getClients(), opts.client_name)
    if (!matched) return `❌ לא מצאתי לקוח בשם "${opts.client_name}".`
    q = q.eq('client_id', matched.id)
  }

  const { data, error } = await q.order('expected_payment_date', { ascending: true }).limit(20)
  if (error) return `❌ שגיאה: ${error.message}`
  const rows = (data ?? []) as Array<{ total_with_vat: number; expected_payment_date: string | null; clients: { name?: string } | null }>
  if (!rows.length) return `✅ אין חשבוניות פתוחות${opts.client_name ? ' ל' + opts.client_name : ''}.`

  const total = rows.reduce((s, r) => s + (r.total_with_vat ?? 0), 0)
  const lines = rows.map(r => `• ${r.clients?.name ?? ''} — ₪${Math.round(r.total_with_vat).toLocaleString()}${r.expected_payment_date ? ` (עד ${r.expected_payment_date.slice(0, 10)})` : ''}`)
  return `${status === 'unpaid' ? '💰 חשבוניות לגבייה' : '📋 חשבוניות'} (${rows.length}):\n\n${lines.join('\n')}\n\n*סה"כ: ₪${Math.round(total).toLocaleString()}*`
}

export async function updateBilling(opts: {
  client_name: string; period?: string; is_paid?: boolean; invoice_created?: boolean; receipt_issued?: boolean
}): Promise<string> {
  if (!opts.client_name) return '❌ ציין שם לקוח.'
  const matched = matchClient(await getClients(), opts.client_name)
  if (!matched) return `❌ לא מצאתי לקוח בשם "${opts.client_name}".`

  const updates: Record<string, unknown> = {}
  if (opts.is_paid) { updates.is_paid = true; updates.actual_payment_date = new Date().toISOString().split('T')[0] }
  if (opts.invoice_created) updates.invoice_created = true
  if (opts.receipt_issued) updates.receipt_issued = true
  if (!Object.keys(updates).length) return '❌ לא ציינת מה לעדכן.'

  let q = db.from('billing_entries').select('id, period, total_with_vat')
    .eq('client_id', matched.id).eq('is_paid', false).order('expected_payment_date', { ascending: true })
  if (opts.period) q = q.ilike('period', `%${opts.period}%`)
  const { data } = await q.limit(5)
  const rows = (data ?? []) as Array<{ id: string; period: string; total_with_vat: number }>
  if (!rows.length) return `❌ לא מצאתי שורות פתוחות לגבייה עבור ${matched.name}.`

  for (const r of rows) await db.from('billing_entries').update({ ...updates, updated_at: new Date().toISOString() }).eq('id', r.id)
  const acts = [updates.is_paid && 'סומנה כשולמה ✅', updates.invoice_created && 'חשבונית אושרה 🧾', updates.receipt_issued && 'קבלה הונפקה 📄'].filter(Boolean)
  return `✅ *${matched.name}* — ${rows.map(r => `${r.period} ₪${Math.round(r.total_with_vat).toLocaleString()}`).join(', ')}\n${acts.join(' | ')}`
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

const PRIORITY_LABEL: Record<string, string> = { low: 'נמוכה', medium: 'בינונית', high: 'גבוהה', urgent: 'דחוף' }
const STATUS_LABEL: Record<string, string> = { open: 'פתוחה', in_progress: 'בעבודה', on_hold: 'בהמתנה', done: 'הושלמה', cancelled: 'בוטלה' }
const PRIO_ICON: Record<string, string> = { urgent: '🔴', high: '🟠', medium: '🟡', low: '⚪' }

function remindAtFrom(dueDate?: string, dueTime?: string, beforeMin?: number): string | null {
  if (!dueDate || beforeMin === undefined) return null
  const dt = new Date(`${dueDate}T${dueTime ?? '09:00'}:00+03:00`)
  dt.setMinutes(dt.getMinutes() - Number(beforeMin))
  return dt.toISOString()
}

export async function createTask(opts: {
  title: string; client_name?: string; priority?: string; category?: string; description?: string
  due_date?: string; due_time?: string; remind_before_minutes?: number
}): Promise<string> {
  if (!opts.title) return '❌ חסרה כותרת למשימה.'
  const uid = await ownerId()
  const clientId = opts.client_name ? matchClient(await getClients(), opts.client_name)?.id ?? null : null

  const { error } = await db.from('tasks').insert({
    title: opts.title, description: opts.description ?? null,
    priority: opts.priority ?? 'medium', category: opts.category ?? 'general',
    client_id: clientId, assigned_to: uid, created_by: uid,
    due_date: opts.due_date ?? null, due_time: opts.due_time ?? null,
    is_all_day: !opts.due_time, remind_at: remindAtFrom(opts.due_date, opts.due_time, opts.remind_before_minutes),
  })
  if (error) return `❌ שגיאה ביצירת משימה: ${error.message}`
  return `✅ משימה נוצרה!\n📌 ${opts.title}\n⚡ ${PRIORITY_LABEL[opts.priority ?? 'medium']}${opts.due_date ? `\n📅 ${opts.due_date}${opts.due_time ? ` ⏰ ${opts.due_time}` : ''}` : ''}`
}

export async function updateTask(opts: {
  search: string; status?: string; due_date?: string; due_time?: string; remind_before_minutes?: number
}): Promise<string> {
  const keywords = opts.search.trim().split(/\s+/).filter(w => w.length > 1)
  if (!keywords.length) return '❌ ציין את שם המשימה.'

  const { data } = await db.from('tasks')
    .select('id, title, status, due_date, due_time, clients(name)')
    .in('status', ['open', 'in_progress', 'on_hold']).limit(50)
  const all = (data ?? []) as Array<{ id: string; title: string; status: string; due_date?: string; due_time?: string; clients?: { name?: string } | null }>
  if (!all.length) return '❌ אין משימות פתוחות.'

  const scored = all.map(t => ({ t, n: keywords.filter(k => t.title.toLowerCase().includes(k.toLowerCase())).length }))
    .filter(s => s.n > 0).sort((a, b) => b.n - a.n)
  if (!scored.length) return `❌ לא נמצאה משימה עם "${opts.search}".`
  const tied = scored.filter(s => s.n === scored[0].n)
  if (tied.length > 1) return `🤔 כמה משימות תואמות:\n${tied.slice(0, 5).map((s, i) => `${i + 1}. ${s.t.title}${s.t.clients?.name ? ` (${s.t.clients.name})` : ''}`).join('\n')}\nתדייק איזו.`

  const task = scored[0].t
  const updates: Record<string, unknown> = {}
  if (opts.status) { updates.status = opts.status; if (opts.status === 'done') updates.completed_at = new Date().toISOString() }
  if (opts.due_date) updates.due_date = opts.due_date
  if (opts.due_time) { updates.due_time = opts.due_time; updates.is_all_day = false }
  if (opts.remind_before_minutes !== undefined) {
    const ra = remindAtFrom(opts.due_date ?? task.due_date, opts.due_time ?? task.due_time, opts.remind_before_minutes)
    if (ra) { updates.remind_at = ra; updates.reminded = false }
  }
  if (!Object.keys(updates).length) return `❌ לא הבנתי מה לשנות ב"${task.title}".`

  const { error } = await db.from('tasks').update(updates).eq('id', task.id)
  if (error) return `❌ שגיאה בעדכון: ${error.message}`
  return `✅ משימה עודכנה: ${task.title}${opts.status ? `\n📊 ${STATUS_LABEL[opts.status] ?? opts.status}` : ''}`
}

export async function listTasks(opts: { status?: string; client_name?: string }): Promise<string> {
  let q = db.from('tasks')
    .select('title, status, priority, category, due_date, due_time, remind_at, clients(name)')
    .order('priority', { ascending: true }).order('due_date', { ascending: true, nullsFirst: false }).limit(15)
  const status = opts.status ?? ''
  if (status && status !== 'all') q = q.eq('status', status)
  else q = q.in('status', ['open', 'in_progress', 'on_hold'])
  if (opts.client_name) {
    const matched = matchClient(await getClients(), opts.client_name)
    if (matched) q = q.eq('client_id', matched.id)
  }
  const { data } = await q
  const rows = (data ?? []) as Array<{ title: string; priority: string; due_date: string | null; due_time: string | null; remind_at: string | null; clients?: { name?: string } | null }>
  if (!rows.length) return '📋 אין משימות פתוחות.'
  return `📋 *משימות פתוחות (${rows.length}):*\n\n${rows.map(t => {
    const due = t.due_date ? ` 📅${t.due_date.slice(5)}` : ''
    const time = t.due_time ? ` ⏰${t.due_time.slice(0, 5)}` : ''
    return `${PRIO_ICON[t.priority] ?? '⚪'} ${t.title}\n   ${t.clients?.name ?? 'כללי'}${due}${time}${t.remind_at ? ' 🔔' : ''}`
  }).join('\n\n')}`
}
