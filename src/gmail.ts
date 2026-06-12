/**
 * gmail.ts
 * Gmail integration for רגב — חיפוש, קריאה ושליחת מיילים.
 */

// ── Auth ──────────────────────────────────────────────────────────────────────

async function getGmailToken(): Promise<string> {
  // Falls back to the same refresh token used for Calendar
  const refreshToken = process.env.GOOGLE_GMAIL_REFRESH_TOKEN ?? process.env.GOOGLE_REFRESH_TOKEN!
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  })
  const data = await res.json() as { access_token?: string; error?: string }
  if (!res.ok) throw new Error(`Gmail token error: ${JSON.stringify(data)}`)
  return data.access_token!
}

// ── Internal helpers ──────────────────────────────────────────────────────────

interface GmailPart {
  mimeType: string
  body?:  { data?: string }
  parts?: GmailPart[]
}

interface GmailMsg {
  id: string
  snippet?: string
  payload?: {
    headers?: Array<{ name: string; value: string }>
    body?:    { data?: string }
    parts?:   GmailPart[]
  }
  internalDate?: string
}

function header(msg: GmailMsg, name: string): string {
  return msg.payload?.headers
    ?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

function decodeBody(msg: GmailMsg): string {
  const tryDecode = (data?: string) => data ? Buffer.from(data, 'base64').toString('utf-8') : null

  // direct body
  const direct = tryDecode(msg.payload?.body?.data)
  if (direct) return direct

  // find text/plain part (possibly nested)
  const allParts: GmailPart[] = []
  const collect = (parts?: GmailPart[]) => { if (parts) { allParts.push(...parts); parts.forEach(p => collect(p.parts)) } }
  collect(msg.payload?.parts)

  const plain = allParts.find(p => p.mimeType === 'text/plain')
  return tryDecode(plain?.body?.data) ?? msg.snippet ?? ''
}

// ── Search emails ─────────────────────────────────────────────────────────────

export async function searchEmails(opts: {
  query:       string
  maxResults?: number
}): Promise<string> {
  const token      = await getGmailToken()
  const maxResults = opts.maxResults ?? 8

  const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages')
  url.searchParams.set('q', opts.query)
  url.searchParams.set('maxResults', String(maxResults))

  const res  = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Gmail search ${res.status}`)
  const data = await res.json() as { messages?: Array<{ id: string }> }

  if (!data.messages?.length) return `📭 לא נמצאו מיילים עבור: "${opts.query}"`

  const details = await Promise.all(data.messages.map(async m => {
    const r = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata` +
      `&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    return r.ok ? (await r.json() as GmailMsg) : null
  }))

  const lines = details.filter(Boolean).map((m, i) => {
    const subj    = header(m!, 'Subject') || '(ללא נושא)'
    const from    = header(m!, 'From').split('<')[0].trim() || '?'
    const dateRaw = header(m!, 'Date')
    const dateStr = dateRaw ? new Date(dateRaw).toLocaleDateString('he-IL') : ''
    return `${i + 1}. *${subj}*\n   ✉️ ${from} | ${dateStr} | ID: \`${m!.id}\``
  })

  return `📬 ${lines.length} מיילים:\n\n${lines.join('\n\n')}`
}

// ── Get full email content ────────────────────────────────────────────────────

export async function getEmailContent(emailId: string): Promise<string> {
  const token = await getGmailToken()
  const res   = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${emailId}?format=full`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!res.ok) throw new Error(`Gmail get ${res.status}`)

  const msg     = await res.json() as GmailMsg
  const subject = header(msg, 'Subject') || '(ללא נושא)'
  const from    = header(msg, 'From') || '?'
  const dateRaw = header(msg, 'Date')
  const dateStr = dateRaw ? new Date(dateRaw).toLocaleString('he-IL') : ''
  const body    = decodeBody(msg).replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 1500)

  return `📧 *${subject}*\nמ: ${from}\n${dateStr}\n\n${body}${body.length >= 1500 ? '\n...(קוצר)' : ''}`
}

// ── Send email ────────────────────────────────────────────────────────────────

export async function sendEmail(opts: {
  to:      string
  subject: string
  body:    string
}): Promise<string> {
  const token = await getGmailToken()

  const mime = [
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    'Content-Type: text/plain; charset=UTF-8',
    'MIME-Version: 1.0',
    '',
    opts.body,
  ].join('\r\n')

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ raw: Buffer.from(mime).toString('base64url') }),
  })

  if (!res.ok) {
    const err = await res.json() as { error?: unknown }
    throw new Error(JSON.stringify(err.error).slice(0, 150))
  }

  return `✉️ מייל נשלח בהצלחה ל-${opts.to}!`
}

// ── List unread inbox ─────────────────────────────────────────────────────────

export async function listInbox(unreadOnly = true, maxResults = 8): Promise<string> {
  const q = unreadOnly ? 'is:unread in:inbox' : 'in:inbox'
  return searchEmails({ query: q, maxResults })
}
