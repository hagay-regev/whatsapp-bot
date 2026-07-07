/**
 * index.ts
 * WhatsApp Personal Agent — main entry point.
 *
 * WAHA should be configured to POST inbound messages to:
 *   http://your-server:3001/webhook
 */

import 'dotenv/config'
import express from 'express'
import fs from 'fs'
import path from 'path'
import { config } from './config'
import { parseGatewayPayload, sendMessage } from './whatsapp'
import { runAgent, shouldRespondInGroup } from './agent'
import { transcribeVoice, describeImage } from './voice'
import { detectInventedReply, flagBug, isBugFlag, bugNote, isFeatureRequest, featureText } from './buglog'
import { hasEntriesForDate } from './billing'
import { pollBugLoop, applyOwnerDecision } from './bugloop'

const app = express()
// Images arrive base64-encoded inside the JSON payload (a photo is ~150KB+),
// which blows past body-parser's 100KB default and gets rejected with
// PayloadTooLargeError before the handler runs. Raise the limit generously.
app.use(express.json({ limit: '25mb' }))

// ── Conversation history (per chat, persisted to disk) ────────────────────────
export interface ChatEntry { sender: string; body: string; ts: Date }
const HISTORY_PATH = path.join(__dirname, '..', 'chat-history.json')
const HISTORY_LIMIT = 40

function loadHistory(): Map<string, ChatEntry[]> {
  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8')) as Record<string, Array<ChatEntry & { ts: string }>>
    return new Map(Object.entries(raw).map(([k, v]) => [k, v.map(e => ({ ...e, ts: new Date(e.ts) }))]))
  } catch {
    return new Map()
  }
}

const chatHistory = loadHistory()

function persistHistory() {
  // Atomic write (temp + rename) so concurrent messages can't corrupt/blank the file.
  try {
    const tmp = `${HISTORY_PATH}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(chatHistory)))
    fs.renameSync(tmp, HISTORY_PATH)
  } catch (err) {
    console.error('[history] persist failed:', (err as Error).message)
  }
}

function appendHistory(chatId: string, sender: string, body: string) {
  if (!chatHistory.has(chatId)) chatHistory.set(chatId, [])
  const hist = chatHistory.get(chatId)!
  hist.push({ sender, body, ts: new Date() })
  if (hist.length > HISTORY_LIMIT) hist.splice(0, hist.length - HISTORY_LIMIT)
  persistHistory()
}

export function getHistory(chatId: string): ChatEntry[] {
  return chatHistory.get(chatId) ?? []
}

// ── Rate limiter (prevent WhatsApp spam detection) ────────────────────────────
const lastReplyAt = new Map<string, number>()
const MIN_REPLY_INTERVAL_MS = 3000  // minimum 3s between replies per chat

// ── Third-party alerts: tell the owner when a NON-owner engages the bot, so Hagai
// always knows who talked to רגב and what they wanted. Throttled per sender. ──────
const lastThirdPartyAlert = new Map<string, number>()
const THIRD_PARTY_ALERT_MS = 10 * 60_000  // one heads-up per sender per 10 min

// ── Dedup (some gateways/WAHA deliver the same inbound message more than once,
// e.g. via duplicate webhook events with slightly different payload shapes —
// this can cause the SAME message to be processed twice with different results,
// such as both a successful reply AND the "owner-only" rejection) ─────────────
const recentMessages = new Map<string, number>()  // key: `${chatId}::${body}` -> ts
const DEDUP_WINDOW_MS = 10000  // ignore an identical message in the same chat within 10s

function isDuplicateMessage(chatId: string, body: string): boolean {
  const key = `${chatId}::${body}`
  const now = Date.now()
  const last = recentMessages.get(key)

  // periodic cleanup so the map doesn't grow forever
  if (recentMessages.size > 1000) {
    for (const [k, t] of recentMessages) {
      if (now - t > DEDUP_WINDOW_MS) recentMessages.delete(k)
    }
  }

  if (last !== undefined && now - last < DEDUP_WINDOW_MS) return true
  recentMessages.set(key, now)
  return false
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'whatsapp-personal-agent' })
})

// ── Inbound webhook from WAHA ─────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  // Validate secret (optional but recommended)
  if (config.webhookSecret) {
    const token = req.headers['x-webhook-secret'] ?? req.query.token
    if (token !== config.webhookSecret) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
  }

  // Acknowledge immediately so WAHA doesn't retry
  res.json({ ok: true })

  const payload = req.body as Record<string, unknown>

  // Only handle incoming messages
  const event = payload.event as string
  if (event && event !== 'message') return

  // Voice messages have no text body — transcribe first (Gemini), then treat
  // the transcript exactly like a typed message. Gateway attaches mediaData.
  const rawP = (payload.payload ?? payload) as Record<string, unknown>
  if (!String(rawP.body ?? '').trim() && (rawP.type === 'ptt' || rawP.type === 'audio')) {
    try {
      rawP.body = await transcribeVoice(rawP)
      console.log(`[voice] transcribed: ${String(rawP.body).slice(0, 80)}`)
    } catch (err) {
      console.error('[voice] failed:', (err as Error).message)
    }
  }

  // Images (private chats only — gateway attaches mediaData there): "read" via Gemini.
  if (rawP.type === 'image' && rawP.mediaData) {
    try {
      const desc = await describeImage(rawP)
      const caption = String(rawP.body ?? '').trim()
      rawP.body = caption ? `${caption}\n[תוכן התמונה: ${desc}]` : `[תמונה] ${desc}`
      console.log(`[image] described: ${desc.slice(0, 80)}`)
    } catch (err) {
      console.error('[image] failed:', (err as Error).message)
    }
  }

  // TEMP PROBE: capture @-mention structure + the bot's own number for group
  // messages, to wire up "respond when @-mentioned" (body has @<number>, not "רגב").
  if (String(rawP.from ?? '').includes('@g.us')) {
    const data = rawP._data as Record<string, unknown> | undefined
    const ment = data?.mentionedJidList
    if (Array.isArray(ment) && ment.length) {
      console.log(`[probe-mention] to=${JSON.stringify(rawP.to)} self=${JSON.stringify(data?.self ?? data?.id)} mentions=${JSON.stringify(ment)}`)
    }
  }

  const msg = parseGatewayPayload(payload, config.ownerPhone)
  if (!msg) return
  if (!msg.body.trim()) return

  // TEMP DEBUG: log every parsed inbound message before any filtering, so we
  // can see exactly what chatId/senderPhone/isFromOwner WhatsApp sends for
  // this chat (helps diagnose @lid vs @c.us routing issues).
  console.log(`[debug-in] chatId=${msg.chatId} senderPhone=${msg.senderPhone} isFromOwner=${msg.isFromOwner} isGroup=${msg.isGroup} body="${msg.body.slice(0, 30)}"`)

  // Skip duplicate deliveries of the same message (prevents double replies,
  // e.g. one correct reply + one "owner-only" rejection for the same message).
  // For private chats, WhatsApp sometimes delivers the SAME message twice
  // under different sender identifiers (e.g. <phone>@c.us and <lid>@lid),
  // which would have different chatIds — so for private chats dedup on the
  // message body alone (shared across all private chats), not the chatId.
  // Private dedup/history are keyed per-sender: the owner shares ONE bucket
  // (their msgs arrive under both @c.us and @lid); each non-owner gets their own.
  const privateKey = msg.isFromOwner ? 'private' : `dm:${msg.senderPhone}`
  const dedupKey = msg.isGroup ? msg.chatId : privateKey
  if (isDuplicateMessage(dedupKey, msg.body)) {
    console.log(`[dedup] skipping duplicate message in ${msg.chatId}: ${msg.body.slice(0, 50)}`)
    return
  }

  // Private chats: the owner (identified in parseGatewayPayload by phone or
  // config.ownerLid) gets full access. NON-owners are ANSWERED too, but walled
  // off — the agent gives them only request_owner_approval (no access to Hagai's
  // data), their OWN history thread, and NOT Hagai's private memory. Never treat
  // an @lid sender as the owner (that was a hole granting strangers full access).
  const historyKey = msg.isGroup ? msg.chatId : privateKey

  // In groups: always log to history, then let the model decide if רגב is being
  // addressed. Explicit name → respond immediately (cheap fast-path); otherwise
  // ask the lightweight gate (with history context) whether to chime in.
  if (msg.isGroup) {
    appendHistory(historyKey, msg.senderName, msg.body)
    const explicit = /רגב|regev/i.test(msg.body)
    // חגי מגיב באישור/דחייה קצרים (👍/👎/כן/לא) — תמיד תופסים, גם אם השער היה מהסס
    // (אישור בקשה, אישור יצירת אירועים וכו'). חגי כמעט אף פעם לא שולח 👍 סתם.
    const ownerConfirm = msg.isFromOwner &&
      /^\s*(👍|👎|כן|לא|אשר|בטל|מאשר|דחה|אוקיי|אישור)\s*$/.test(msg.body.trim())
    if (!explicit && !ownerConfirm && !(await shouldRespondInGroup(msg, getHistory(historyKey)))) return
  } else {
    // Bug loop (step 2): owner's 👍/👎 approves/rejects a pending fix.
    if (msg.isFromOwner) {
      const decision = applyOwnerDecision(msg.body)
      if (decision) { await sendMessage(msg.chatId, decision); return }
    }
    // Bug queue (step 1): owner flags the PREVIOUS bot reply with באג/🐛/👎.
    // Must run before we append this message to history (we want the last reply).
    if (msg.isFromOwner && isBugFlag(msg.body)) {
      const hist = getHistory('private')
      const back = [...hist].reverse().findIndex(h => h.sender === 'רגב')
      if (back === -1) { await sendMessage(msg.chatId, 'אין הודעה אחרונה של רגב לסמן 🤔'); return }
      const idx = hist.length - 1 - back
      const note = bugNote(msg.body)
      flagBug({
        reason: note ? `user_flag: ${note}` : 'user_flag',
        chatId: msg.chatId, isGroup: false,
        userText: idx > 0 ? hist[idx - 1].body : '', botReply: hist[idx].body,
      })
      await sendMessage(msg.chatId, '🐛 נרשם — הבאג נכנס לתור לטיפול.')
      return
    }
    // Dev inbox (step 1): owner requests a NEW feature with פיצ'ר/פיתוח <תיאור>.
    if (msg.isFromOwner && isFeatureRequest(msg.body)) {
      const text = featureText(msg.body)
      if (!text) { await sendMessage(msg.chatId, "מה הפיצ'ר? כתוב: פיצ'ר <תיאור מה לבנות>"); return }
      flagBug({ reason: 'feature', kind: 'feature', request: text, chatId: msg.chatId, isGroup: false, userText: text, botReply: '' })
      await sendMessage(msg.chatId, '🧩 פיצ׳ר נרשם — נכנס לתור לפיתוח.')
      return
    }
    // Log the incoming message under the right sender (owner = חגי; a non-owner
    // keeps their own name in their own thread — never mixed into Hagai's).
    appendHistory(historyKey, msg.isFromOwner ? 'חגי' : msg.senderName, msg.body)
  }

  // Rate limit: at least 3s between replies to same chat
  const now = Date.now()
  if (now - (lastReplyAt.get(msg.chatId) ?? 0) < MIN_REPLY_INTERVAL_MS) {
    console.log(`[rate-limit] skipping ${msg.chatId}`)
    return
  }
  lastReplyAt.set(msg.chatId, now)

  // Third-party alert: the bot is about to respond to a NON-owner — give Hagai a
  // private heads-up (who, where, what they said). Throttled per sender.
  if (!msg.isFromOwner) {
    const last = lastThirdPartyAlert.get(msg.senderPhone) ?? 0
    if (now - last > THIRD_PARTY_ALERT_MS) {
      lastThirdPartyAlert.set(msg.senderPhone, now)
      const where = msg.isGroup ? `בקבוצה "${msg.groupName ?? msg.chatId}"` : 'בפרטי'
      sendMessage(config.ownerPhone, `👤 *${msg.senderName}* פנה אליי ${where}:\n"${msg.body.slice(0, 250)}"`)
        .catch(err => console.error('[3rd-party-alert]', (err as Error).message))
    }
  }

  console.log(`[${new Date().toISOString()}] ${msg.isGroup ? '👥' : '💬'} ${msg.senderName}: ${msg.body}`)

  try {
    const history = getHistory(historyKey)
    const reply = await runAgent(msg, history)
    if (reply) {
      await sendMessage(msg.chatId, reply)
      appendHistory(historyKey, 'רגב', reply)
      console.log(`[reply] ${reply.slice(0, 80)}`)
      // Auto-detect (step 1): only on the owner's private chat — that's where the
      // tool bugs surface, and it avoids flagging legit "no access to YOUR data"
      // replies sent to non-owners in groups.
      if (!msg.isGroup && msg.isFromOwner) {
        const tag = detectInventedReply(reply)
        if (tag) flagBug({ reason: `auto:${tag}`, chatId: msg.chatId, isGroup: false, userText: msg.body, botReply: reply })
      }
    }
  } catch (err) {
    console.error('Agent error:', err)
    await sendMessage(msg.chatId, '⚠️ שגיאה פנימית, נסה שוב.')
  }
})

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(config.port, () => {
  console.log(`🤖 WhatsApp Personal Agent running on port ${config.port}`)
  console.log(`   Owner phone: ${config.ownerPhone}`)
  console.log(`   WAHA: ${config.wahaUrl}`)
})

// Bug loop (step 2): every 30s, push approval requests / done-notices to the owner.
setInterval(() => { pollBugLoop().catch(err => console.error('[bugloop]', err)) }, 30_000)

// End-of-day nudge: on a work day (Sun–Thu) at 19:00 Israel, if the owner logged
// no hours today, ask whether he forgot to report.
let lastHoursNudgeDay = ''
setInterval(() => {
  const now = new Date()
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(now)                                          // YYYY-MM-DD
  const hm  = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false }).format(now)  // HH:MM
  if (hm !== '19:00' || lastHoursNudgeDay === day) return
  lastHoursNudgeDay = day
  const dow = new Date(day + 'T12:00:00Z').getUTCDay()  // 0=Sun … 6=Sat
  if (dow === 5 || dow === 6) return                     // skip Fri/Sat (Israeli weekend)
  hasEntriesForDate(day)
    .then(has => { if (!has) return sendMessage(config.ownerPhone, 'היי 👋 לא ראיתי דיווחי שעות היום — שכחת לדווח? אם עבדת, שלח לי ואתעד.') })
    .catch(err => console.error('[hours-nudge]', (err as Error).message))
}, 60_000)
