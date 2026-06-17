/**
 * google-contacts.ts
 * חיפוש באנשי הקשר השמורים של Google (People API) — שם → מייל + טלפון.
 * דורש הרשאת contacts.readonly בטוקן (get-token.js מבקש אותה).
 */

import { getAccessToken } from './calendar'

interface Person {
  names?: Array<{ displayName?: string }>
  emailAddresses?: Array<{ value?: string }>
  phoneNumbers?: Array<{ value?: string }>
}

let warmedUp = false

export async function lookupGoogleContact(name: string): Promise<string> {
  const token = await getAccessToken()
  const search = async (query: string) => {
    const url = new URL('https://people.googleapis.com/v1/people:searchContacts')
    url.searchParams.set('query', query)
    url.searchParams.set('readMask', 'names,emailAddresses,phoneNumbers')
    url.searchParams.set('pageSize', '10')
    return fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } })
  }

  // People API recommends a warmup (empty query) before the first real search.
  if (!warmedUp) { await search('').catch(() => {}); warmedUp = true }

  const res = await search(name)
  if (res.status === 401 || res.status === 403)
    return '⚠️ אין לי עדיין הרשאת גישה לאנשי הקשר — צריך להריץ מחדש את get-token.js עם ההרשאה החדשה.'
  if (!res.ok) return `❌ שגיאה בחיפוש אנשי קשר (${res.status}).`

  const data = await res.json() as { results?: Array<{ person?: Person }> }
  const results = data.results ?? []
  if (!results.length) return `❌ לא מצאתי "${name}" באנשי הקשר של Google.`

  const lines = results.map(r => {
    const p = r.person ?? {}
    const nm = p.names?.[0]?.displayName ?? name
    const emails = (p.emailAddresses ?? []).map(e => e.value).filter(Boolean)
    const phones = (p.phoneNumbers ?? []).map(e => e.value).filter(Boolean)
    const details = [...emails, ...phones]
    return `• ${nm}${details.length ? `: ${details.join(' | ')}` : ' (אין מייל/טלפון שמור)'}`
  })
  return lines.join('\n')
}
