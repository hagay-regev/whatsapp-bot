/**
 * approvals.ts
 * בקשות אישור: כשמישהו שאינו חגי מבקש פעולה רגישה, היא נשמרת כ"ממתינה",
 * חגי מקבל הודעה פרטית, ורק באישורו רגב מבצע. נשמר לדיסק (שורד ריסטארט).
 */

import fs from 'fs'
import path from 'path'

const PATH = path.join(__dirname, '..', 'pending.json')

export interface Pending {
  id: string
  name: string          // שם המבקש
  group: string         // שם/מזהה הקבוצה
  groupChatId: string   // לאן להחזיר תשובה
  text: string          // תקציר הבקשה
  ts: number
}

function load(): Pending[] {
  try { return JSON.parse(fs.readFileSync(PATH, 'utf-8')) } catch { return [] }
}
function save(a: Pending[]) { fs.writeFileSync(PATH, JSON.stringify(a)) }

export function addPending(x: Omit<Pending, 'id' | 'ts'>): Pending {
  const a = load()
  const p: Pending = { ...x, id: String(Date.now()).slice(-4), ts: Date.now() }
  a.push(p); save(a)
  return p
}

export function hasPending(): boolean { return load().length > 0 }

export function removePending(id: string): Pending | undefined {
  const a = load()
  const i = a.findIndex(p => p.id === id)
  if (i < 0) return undefined
  const [p] = a.splice(i, 1); save(a)
  return p
}

/** מוזרק להקשר של חגי בשיחה פרטית, כדי שהמודל ידע אילו בקשות ממתינות. */
export function pendingForOwner(): string {
  const a = load()
  if (!a.length) return ''
  return `\n\n# בקשות אישור ממתינות\n` +
    a.map(p => `[${p.id}] ${p.name} (קבוצה: ${p.group}): "${p.text}"`).join('\n') +
    `\nלאישור: בצע את הבקשה ואז resolve_approval(id, approved=true). לדחייה: resolve_approval(id, approved=false).`
}
