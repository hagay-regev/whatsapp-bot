/**
 * whatsapp.ts - Sends messages via the custom gateway.
 */

import { config } from './config'

export async function sendMessage(to: string, message: string): Promise<void> {
  const gwUrl = config.wahaUrl.replace(/\/+$/, '')
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

export interface InboundMessage {
  chatId: string
  senderPhone: string
  senderName: string
  body: string
  isGroup: boolean
  isFromOwner: boolean
  isReplyToBot: boolean
  messageType: string
}

export interface ChatEntry { sender: string; body: string; ts: Date }

export function parseGatewayPayload(raw: Record<string, unknown>, ownerPhone: string): InboundMessage | null {
  try {
    const p = (raw.payload ?? raw) as Record<string, unknown>
    const body = String(p.body ?? '').trim()
    if (!body) return null
    if (p.fromMe === true) return null

    const from = String(p.from ?? '')
    const isGroup = from.includes('@g.us')

    const senderRaw = isGroup
      ? String((p.sender as Record<string, unknown>)?.id ?? p.from ?? '')
      : from

    const senderPhone = senderRaw.replace(/@.*$/, '').replace(/[^\d]/g, '')
    const senderName  = String(p.notifyName ?? senderPhone)

    const normalizedOwner = ownerPhone.replace(/\D/g, '')
    const isFromOwner = senderPhone.endsWith(normalizedOwner.slice(-9)) ||
                        normalizedOwner.endsWith(senderPhone.slice(-9))

    const quotedMsg = p.quotedMsg as Record<string, unknown> | undefined
    const isReplyToBot = p.hasQuotedMsg === true && quotedMsg?.fromMe === true

    return {
      chatId: from,
      senderPhone,
      senderName,
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
