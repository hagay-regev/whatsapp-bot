/**
 * whatsapp.ts
 * Sends messages via the custom self-hosted gateway (same one used by Billing App).
 * API: POST /send  { phone, message }
 */

import { config } from './config'

export async function sendMessage(to: string, message: string): Promise<void> {
  const gwUrl = config.wahaUrl.replace(/\/+$/, '')

  // Normalize: strip @c.us / @g.us suffixes — gateway appends @c.us itself
  // But preserve group JIDs as-is
  const phone = (to.includes('@g.us') || to.includes('@lid'))
    ? to
    : to.replace(/@.*$/, '').replace(/[^\d]/g, '')

  const res = await fetch(`${gwUrl}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, message }),
  })

  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`Gateway send failed ${res.status}: ${err}`)
  }
}

/** Parsed inbound message */
export interface InboundMessage {
  chatId: string
  senderPhone: string
  senderName: string
  groupName?: string   // שם הקבוצה (רק כשisGroup=true)
  body: string
  isGroup: boolean
  isFromOwner: boolean
  isReplyToBot: boolean
  messageType: string
}

/** Parse the webhook payload from the custom gateway (same shape as WAHA) */
export function parseGatewayPayload(raw: Record<string, unknown>, ownerPhone: string): InboundMessage | null {
  try {
    // Shape: { event, session, payload: { from, fromMe, body, type, ... } }
    const p = (raw.payload ?? raw) as Record<string, unknown>

    const body = String(p.body ?? '').trim()
    if (!body) return null

    // Skip messages sent by the bot itself
    if (p.fromMe === true) return null

    const from = String(p.from ?? '')
    const isGroup = from.includes('@g.us')

    // In groups, whatsapp-web.js puts the real sender in `author`
    // (string id, or a wid object with `_serialized` in some versions).
    const author = p.author as unknown
    const authorId =
      typeof author === 'string' ? author :
      String((author as Record<string, unknown>)?._serialized ?? '')
    const senderRaw = isGroup
      ? (authorId || String((p.sender as Record<string, unknown>)?.id ?? p.from ?? ''))
      : from

    const senderPhone = senderRaw.replace(/@.*$/, '').replace(/[^\d]/g, '')

    // Push name lives in the raw `_data` of the serialized message, not top-level
    const rawData = p._data as Record<string, unknown> | undefined
    const senderName = String(p.notifyName ?? rawData?.notifyName ?? senderPhone)

    const normalizedOwner  = ownerPhone.replace(/\D/g, '')
    const isFromOwner = senderPhone.endsWith(normalizedOwner.slice(-9)) ||
                        normalizedOwner.endsWith(senderPhone.slice(-9))

    // Check if this message is a reply to a message sent by the bot (fromMe)
    const quotedMsg = p.quotedMsg as Record<string, unknown> | undefined
    const isReplyToBot = p.hasQuotedMsg === true && quotedMsg?.fromMe === true

    // Group name — WAHA includes it in payload.chat.name or payload.chatName
    const chatObj  = p.chat as Record<string, unknown> | undefined
    const groupName = isGroup
      ? (String(chatObj?.name ?? p.chatName ?? p.groupName ?? '').trim() || undefined)
      : undefined

    return {
      chatId: from,
      senderPhone,
      senderName,
      groupName,
      body,
      isGroup,
      isFromOwner,
      isReplyToBot,
      messageType: String(p.type ?? 'chat'),
    }
  } catch {
    return null
  }
}
