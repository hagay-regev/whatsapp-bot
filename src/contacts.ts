/**
 * contacts.ts
 * חיפוש אנשי קשר של וואטסאפ דרך הגייטווי (endpoint /contacts).
 * משמש לשליחת הודעות יזומות לאנשים אחרים.
 */

import { config } from './config'

export interface Contact { name: string; number: string; type?: 'contact' | 'group' }

export async function findContacts(query: string): Promise<Contact[]> {
  const gw = config.wahaUrl.replace(/\/+$/, '')
  try {
    const res = await fetch(`${gw}/contacts?q=${encodeURIComponent(query)}`)
    if (!res.ok) return []
    const data = await res.json() as { contacts?: Contact[] }
    return data.contacts ?? []
  } catch {
    return []
  }
}
