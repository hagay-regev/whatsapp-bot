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
  // clients is a global/org table — no per-user ownership column.
  const { data } = await db.from('clients').select('id, name').order('name')
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

interface WorkOrder { id: string; order_number: number; title?: string; description?: string; status?: string; estimated_hours?: number; actual_hours?: number }

async function findWorkOrder(clientId: string, order: string): Promise<{ wo?: WorkOrder; all: WorkOrder[] }> {
  const { data } = await db.from('work_orders')
    .select('id, order_number, title, description, status, estimated_hours, actual_hours')
    .eq('client_id', clientId).order('order_number', { ascending: false })
  const all = (data ?? []) as WorkOrder[]
  const o = order.trim().replace(/^#/, '')
  const num = Number(o)
  let wo = !isNaN(num) && o !== '' ? all.find(w => w.order_number === num) : undefined
  if (!wo) { const on = o.toLowerCase(); wo = all.find(w => (w.title ?? '').toLowerCase().includes(on) || (w.description ?? '').toLowerCase().includes(on)) }
  return { wo, all }
}

const woLabel = (w: WorkOrder) => `#${w.order_number}${w.title || w.description ? ` ${w.title || w.description}` : ''}`

export async function logHours(opts: {
  client_name: string; hours: number; type?: string; description?: string; date?: string; start_time?: string; order?: string
}): Promise<string> {
  if (!opts.hours || opts.hours <= 0) return '❌ כמה שעות?'
  const clients = await getClients()
  const matched = matchClient(clients, opts.client_name)
  if (!matched) return `❌ לא מצאתי לקוח בשם "${opts.client_name}". לקוחות:\n${clients.slice(0, 10).map(c => `• ${c.name}`).join('\n')}`

  // Optional: associate the entry with a specific work order (הזמנה).
  let workOrderId: string | null = null
  let orderLine = ''
  if (opts.order) {
    const { wo, all } = await findWorkOrder(matched.id, opts.order)
    if (!wo) return `❌ לא מצאתי הזמנה "${opts.order}" אצל ${matched.name}.\nהזמנות זמינות:\n${all.length ? all.map(woLabel).map(s => `• ${s}`).join('\n') : 'אין הזמנות ללקוח זה.'}`
    workOrderId = wo.id
    orderLine = `\n📦 ${woLabel(wo)}`
  }

  const uid = await ownerId()
  const date = opts.date ?? ilToday()
  // entries tied to an order are order-implementation by default
  const type = opts.type ?? (workOrderId ? 'order_implementation' : 'maintenance')
  const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`
  const startMin = (opts.start_time ? Number(opts.start_time.split(':')[0]) || 8 : 8) * 60
  const endMin = startMin + Math.round(opts.hours * 60)

  // Idempotency guard: the model sometimes double-fires log_hours (it retries
  // when the first tool call is slow to return), creating an identical entry.
  // Block an identical insert made in the last few minutes — same client, date,
  // hours, type and description.
  const sinceIso = new Date(Date.now() - 5 * 60_000).toISOString()
  const { data: dup } = await db.from('time_entries')
    .select('id')
    .eq('user_id', uid).eq('client_id', matched.id).eq('date', date)
    .eq('start_time', fmt(startMin)).eq('end_time', fmt(endMin))
    .eq('type', type).eq('description', opts.description ?? '')
    .gte('created_at', sinceIso).limit(1)
  if (dup && dup.length) {
    return `ℹ️ הדיווח כבר נשמר זה עתה (${matched.name}, ${opts.hours}h${opts.description ? ` — ${opts.description}` : ''}) — לא הוספתי כפילות.`
  }

  const { error } = await db.from('time_entries').insert({
    date, client_id: matched.id, user_id: uid, work_order_id: workOrderId,
    start_time: fmt(startMin), end_time: fmt(endMin),
    travel_hours: 0, type, description: opts.description ?? '',
    is_billable: type !== 'maintenance', notes: 'נוצר דרך רגב',
  })
  if (error) return `❌ שגיאה בשמירה: ${error.message}`

  return `✅ דיווח נשמר!\n🏢 ${matched.name}\n🕐 ${opts.hours}h — ${TYPE_LABEL[type] ?? type}\n📅 ${date}${orderLine}${opts.description ? `\n📝 ${opts.description}` : ''}`
}

const WO_STATUS: Record<string, string> = { open: 'פתוחה', in_progress: 'בעבודה', completed: 'הושלמה', cancelled: 'בוטלה', on_hold: 'בהמתנה' }

export async function listOrders(client_name: string): Promise<string> {
  const matched = matchClient(await getClients(), client_name)
  if (!matched) return `❌ לא מצאתי לקוח בשם "${client_name}".`
  const { data } = await db.from('work_orders')
    .select('order_number, title, description, status, estimated_hours, actual_hours')
    .eq('client_id', matched.id).order('order_number', { ascending: false }).limit(25)
  const rows = (data ?? []) as WorkOrder[]
  if (!rows.length) return `📦 אין הזמנות ל${matched.name}.`
  return `📦 הזמנות — ${matched.name}:\n${rows.map(o => {
    const hrs = o.estimated_hours ? ` · ${o.actual_hours ?? 0}/${o.estimated_hours}ש'` : ''
    return `• #${o.order_number} ${o.title || o.description || ''} (${WO_STATUS[o.status ?? ''] ?? o.status ?? ''})${hrs}`
  }).join('\n')}`
}

export async function queryHours(opts: {
  period?: 'today' | 'week' | 'month'; date_from?: string; date_to?: string; list?: boolean; client_name?: string; unhandled?: boolean
} = {}): Promise<string> {
  const uid = await ownerId()
  const today = ilToday()
  // "unhandled" reports default to a detailed list over a wide window.
  const list = opts.list ?? opts.unhandled ?? false

  // Resolve client filter (so "last entries for <client>" works regardless of how
  // deep they are in the monthly list).
  let clientId: string | undefined
  if (opts.client_name) {
    const m = matchClient(await getClients(), opts.client_name)
    if (!m) return `❌ לא מצאתי לקוח בשם "${opts.client_name}".`
    clientId = m.id
  }

  // Reports not yet closed in the monthly billing cycle ("שלא טופלו").
  if (opts.unhandled) {
    let q = db.from('time_entries')
      .select('date, work_hours, start_time, end_time, type, is_billable, description, clients(name)')
      .eq('user_id', uid).eq('monthly_cycle_done', false)
    if (clientId) q = q.eq('client_id', clientId)
    const { data } = await q.order('date', { ascending: false }).limit(clientId ? 50 : 30)
    const rows = (data ?? []) as Array<{ date: string; work_hours: number; start_time?: string | null; end_time?: string | null; type: string; is_billable: boolean; description: string; clients?: { name?: string } | null }>
    const clientLbl = opts.client_name ? ` — ${opts.client_name}` : ''
    if (!rows.length) return `✅ אין דיווחים שלא טופלו${clientLbl}.`
    const d = (s: string) => `${s.slice(8)}/${s.slice(5, 7)}/${s.slice(0, 4)}`
    const hm = (t?: string | null) => t ? t.slice(0, 5) : ''
    const span = (r: { start_time?: string | null; end_time?: string | null }) =>
      r.start_time && r.end_time ? ` (${hm(r.start_time)}–${hm(r.end_time)})` : ''
    const totalH = rows.reduce((sm, r) => sm + Number(r.work_hours ?? 0), 0)
    const lines = rows.map(r => `• ${d(r.date)}${span(r)} | ${r.clients?.name ?? '—'} | ${Number(r.work_hours).toFixed(1)}h${r.is_billable ? ' 💰' : ''}${r.description ? ` — ${r.description.slice(0, 35)}` : ''}`)
    return `🗂 דיווחים שלא טופלו${clientLbl} (${rows.length}, ${totalH.toFixed(1)}h):\n\n${lines.join('\n')}`
  }

  // Explicit date range (model-driven) takes priority over period presets.
  let from: string, to: string, label: string
  if (opts.date_from) {
    from = opts.date_from
    to = opts.date_to ?? opts.date_from
    label = from === to ? from : `${from} עד ${to}`
  } else if (opts.period) {
    to = today
    // Work week is Sunday–Saturday (Israeli week).
    if (opts.period === 'week') from = addDays(today, -ilDow(today))
    else if (opts.period === 'month') from = today.slice(0, 7) + '-01'
    else from = today
    label = ({ today: 'היום', week: 'השבוע', month: 'החודש' } as Record<string, string>)[opts.period]
  } else if (clientId) {
    // Client given without a period — search wide (12 months) to find their entries.
    from = addDays(today, -365); to = today; label = '12 חודשים אחרונים'
  } else {
    from = today; to = today; label = 'היום'
  }

  const clientLabel = opts.client_name ? ` — ${opts.client_name}` : ''

  if (list) {
    let q = db.from('time_entries')
      .select('date, work_hours, start_time, end_time, type, is_billable, description, clients(name)')
      .eq('user_id', uid).gte('date', from).lte('date', to)
    if (clientId) q = q.eq('client_id', clientId)
    const { data } = await q.order('date', { ascending: false }).limit(clientId ? 20 : 10)
    const rows = (data ?? []) as Array<{ date: string; work_hours: number; start_time?: string | null; end_time?: string | null; type?: string; is_billable?: boolean; description: string; clients?: { name?: string } | null }>
    if (!rows.length) return `📋 אין דיווחים (${label}${clientLabel}).`
    const d = (s: string) => `${s.slice(8)}/${s.slice(5, 7)}/${s.slice(0, 4)}`  // DD/MM/YYYY — full + unambiguous
    const hm = (t?: string | null) => t ? t.slice(0, 5) : ''
    const span = (r: { start_time?: string | null; end_time?: string | null }) =>
      r.start_time && r.end_time ? ` (${hm(r.start_time)}–${hm(r.end_time)})` : ''
    // Show the entry type so "what's billable?" is answered from data, not guessed.
    const kind = (r: { type?: string; is_billable?: boolean }) =>
      r.is_billable ? '💰 בתשלום' : (TYPE_LABEL[r.type ?? ''] ?? 'תחזוקה')
    return `📋 דיווחים (${label}${clientLabel}) — מהחדש לישן:\n${rows.map(r => `• ${d(r.date)}${span(r)} | ${r.clients?.name ?? '—'} | ${Number(r.work_hours).toFixed(1)}h | ${kind(r)}${r.description ? ` — ${r.description.slice(0, 30)}` : ''}`).join('\n')}`
  }

  let sq = db.from('time_entries')
    .select('work_hours, travel_hours, clients(name)')
    .eq('user_id', uid).gte('date', from).lte('date', to)
  if (clientId) sq = sq.eq('client_id', clientId)
  const { data } = await sq
  const rows = (data ?? []) as Array<{ work_hours: number; travel_hours: number; clients?: { name?: string } | null }>
  const work = rows.reduce((s, r) => s + Number(r.work_hours ?? 0), 0)
  const travel = rows.reduce((s, r) => s + Number(r.travel_hours ?? 0), 0)
  const byClient = new Map<string, number>()
  for (const r of rows) byClient.set(r.clients?.name ?? '—', (byClient.get(r.clients?.name ?? '—') ?? 0) + Number(r.work_hours ?? 0))
  const top = Array.from(byClient.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, h]) => `  • ${n}: ${h.toFixed(1)}h`).join('\n')
  return `📊 סיכום שעות — ${label}${clientLabel}\n⏱ עבודה: ${work.toFixed(1)}h${travel > 0 ? `\n🚗 נסיעות: ${travel.toFixed(1)}h` : ''}\n📋 ${rows.length} דיווחים${top ? `\n\nלפי לקוח:\n${top}` : ''}`
}

// ── Billing ───────────────────────────────────────────────────────────────────

export async function queryBilling(opts: { client_name?: string; status?: 'unpaid' | 'paid' | 'all' }): Promise<string> {
  const status = opts.status ?? 'unpaid'

  let matched: Client | undefined
  if (opts.client_name) {
    matched = matchClient(await getClients(), opts.client_name)
    if (!matched) return `❌ לא מצאתי לקוח בשם "${opts.client_name}".`
  }

  const fetchRows = async (st: 'unpaid' | 'paid' | 'all') => {
    let q = db.from('billing_entries').select('id, total_with_vat, expected_payment_date, is_paid, invoice_created, period, clients(name)')
    if (st === 'unpaid') q = q.eq('is_paid', false).eq('invoice_created', true)
    else if (st === 'paid') q = q.eq('is_paid', true)
    if (matched) q = q.eq('client_id', matched.id)
    const { data, error } = await q.order('expected_payment_date', { ascending: true }).limit(20)
    if (error) throw new Error(error.message)
    return (data ?? []) as Array<{ total_with_vat: number; expected_payment_date: string | null; period?: string; is_paid?: boolean; clients: { name?: string } | null }>
  }

  let rows: Awaited<ReturnType<typeof fetchRows>>
  try { rows = await fetchRows(status) } catch (e) { return `❌ שגיאה: ${(e as Error).message}` }

  if (!rows.length) {
    // For a specific client an "is there anything?" question shouldn't stop at
    // "no open invoices" — surface their closed/paid charges so we don't wrongly
    // claim the client has nothing when they actually have a paid charge.
    if (matched && status === 'unpaid') {
      let all: typeof rows
      try { all = await fetchRows('all') } catch { all = [] }
      if (all.length) {
        const lines = all.map(r => `• ${r.period ?? ''} — ₪${Math.round(r.total_with_vat).toLocaleString()} ${r.is_paid ? '✅ שולם' : '⏳ פתוח'}`)
        return `אין חשבוניות *פתוחות* ל${matched.name}, אבל יש חיובים:\n\n${lines.join('\n')}`
      }
      return `✅ אין חיובים בכלל ל${matched.name}.`
    }
    return `✅ אין חשבוניות פתוחות${opts.client_name ? ' ל' + opts.client_name : ''}.`
  }

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
