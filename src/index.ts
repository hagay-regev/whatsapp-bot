/**
 * index.ts
 * WhatsApp Personal Agent — main entry point.
 *
 * WAHA should be configured to POST inbound messages to:
 *   http://your-server:3001/webhook
 */

import 'dotenv/config'
import express from 'express'
import { config } from './config'
import { parseGatewayPayload, sendMessage } from './whatsapp'
import { runAgent } from './agent'

const app = express()
app.use(express.json())

// ── Conversation history (in-memory, per chat) ────────────────────────────────
export interface ChatEntry { sender: string; body: string; ts: Date }
const chatHistory = new Map<string, ChatEntry[]>()
const HISTORY_LIMIT = 40

function appendHistory(chatId: string, sender: string, body: string) {
  if (!chatHistory.has(chatId)) chatHistory.set(chatId, [])
  const hist = chatHistory.get(chatId)!
  hist.push({ sender, body, ts: new Date() })
  if (hist.length > HISTORY_LIMIT) hist.splice(0, hist.length - HISTORY_LIMIT)
}

export function getHistory(chatId: string): ChatEntry[] {
  return chatHistory.get(chatId) ?? []
}

// ── Rate limiter (prevent WhatsApp spam detection) ────────────────────────────
const lastReplyAt = new Map<string, number>()
const MIN_REPLY_INTERVAL_MS = 3000  // minimum 3s between replies per chat

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
  const dedupKey = msg.isGroup ? msg.chatId : 'private'
  if (isDuplicateMessage(dedupKey, msg.body)) {
    console.log(`[dedup] skipping duplicate message in ${msg.chatId}: ${msg.body.slice(0, 50)}`)
    return
  }

  // In private chats: only respond to owner.
  if (!msg.isGroup && !msg.isFromOwner) {
    // WhatsApp sometimes reports the owner's own messages using a
    // privacy-preserving @lid identifier (a long pseudo-random ID) instead
    // of the real phone number, which can never match OWNER_PHONE. Since
    // this bot's private chat is only used by the owner, treat @lid senders
    // in private chats as the owner rather than rejecting them.
    if (msg.chatId.includes('@lid')) {
      msg.isFromOwner = true
    } else {
      await sendMessage(msg.chatId, 'מצטער, אני הבוט האישי של חגי. אינני יכול לעזור לך.')
      return
    }
  }

  // In groups: always log to history, respond ONLY on explicit mention
  // NOTE: isReplyToBot is intentionally NOT used here — the bot runs on חגי's number,
  // so any reply to חגי's messages (incl. manual) would wrongly trigger a response.
  if (msg.isGroup) {
    appendHistory(msg.chatId, msg.senderName, msg.body)
    const mentionsBot = /רגב|regev/i.test(msg.body)
    if (!mentionsBot) return
  }

  // Rate limit: at least 3s between replies to same chat
  const now = Date.now()
  if (now - (lastReplyAt.get(msg.chatId) ?? 0) < MIN_REPLY_INTERVAL_MS) {
    console.log(`[rate-limit] skipping ${msg.chatId}`)
    return
  }
  lastReplyAt.set(msg.chatId, now)

  console.log(`[${new Date().toISOString()}] ${msg.isGroup ? '👥' : '💬'} ${msg.senderName}: ${msg.body}`)

  try {
    const history = msg.isGroup ? getHistory(msg.chatId) : []
    const reply = await runAgent(msg, history)
    if (reply) {
      await sendMessage(msg.chatId, reply)
      if (msg.isGroup) appendHistory(msg.chatId, 'רגב', reply)
      console.log(`[reply] ${reply.slice(0, 80)}`)
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
