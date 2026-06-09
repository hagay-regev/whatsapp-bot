/**
 * index.ts - WhatsApp Personal Agent — main entry point.
 */

import 'dotenv/config'
import express from 'express'
import { config } from './config'
import { parseGatewayPayload, sendMessage } from './whatsapp'
import { runAgent } from './agent'

const app = express()
app.use(express.json())

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

app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'whatsapp-personal-agent' })
})

app.post('/webhook', async (req, res) => {
  if (config.webhookSecret) {
    const token = req.headers['x-webhook-secret'] ?? req.query.token
    if (token !== config.webhookSecret) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
  }
  res.json({ ok: true })

  const payload = req.body as Record<string, unknown>
  const event = payload.event as string
  if (event && event !== 'message') return

  const msg = parseGatewayPayload(payload, config.ownerPhone)
  if (!msg || !msg.body.trim()) return

  // In private chats: only respond to owner
  if (!msg.isGroup && !msg.isFromOwner) {
    await sendMessage(msg.chatId, 'מצטער, אני הבוט האישי של חגי. אינני יכול לעזור לך.')
    return
  }

  // In groups: always log to history, respond only if addressed
  if (msg.isGroup) {
    appendHistory(msg.chatId, msg.senderName, msg.body)
    const mentionsBot = /רגב|regev/i.test(msg.body)
    if (!mentionsBot && !msg.isReplyToBot) return
  }

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

app.listen(config.port, () => {
  console.log(`🤖 WhatsApp Personal Agent running on port ${config.port}`)
  console.log(`   Owner phone: ${config.ownerPhone}`)
  console.log(`   WAHA: ${config.wahaUrl}`)
})
