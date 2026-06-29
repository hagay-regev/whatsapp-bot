/**
 * bugloop.ts
 * Step 2 of the self-improvement loop — the WhatsApp approval bridge.
 *
 * The scheduled Claude Code run is the "brain": it reads open bugs from
 * bugs.jsonl, writes a `diagnosis` + `fix_plan` + `summary`, and flips status to
 * `awaiting_approval`. This module is the bot-side "messenger":
 *   - pollBugLoop()        — pushes approval requests + done-notices to the owner.
 *   - applyOwnerDecision() — turns the owner's 👍/👎 reply into approved/rejected.
 *
 * Lifecycle: open → awaiting_approval → pending_user → approved/rejected → fixed.
 */

import fs from 'fs'
import path from 'path'
import { sendMessage } from './whatsapp'
import { config } from './config'

const BUGS_PATH = path.join(__dirname, '..', 'bugs.jsonl')

export type BugStatus =
  | 'open' | 'awaiting_approval' | 'pending_user' | 'approved' | 'rejected' | 'fixed'

export interface Bug {
  id: string
  ts: string
  status: BugStatus
  reason: string
  chatId: string
  isGroup: boolean
  userText: string
  botReply: string
  diagnosis?: string
  fix_plan?: string
  summary?: string         // approval text written by the Claude Code run
  commit?: string
  done_summary?: string
  done_notified?: boolean
  user_note?: string
}

function readBugs(): Bug[] {
  try {
    return fs.readFileSync(BUGS_PATH, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Bug)
  } catch { return [] }
}

function writeBugs(bugs: Bug[]): void {
  const tmp = `${BUGS_PATH}.${process.pid}.tmp`
  fs.writeFileSync(tmp, bugs.map(b => JSON.stringify(b)).join('\n') + (bugs.length ? '\n' : ''))
  fs.renameSync(tmp, BUGS_PATH)
}

export function updateBug(id: string, patch: Partial<Bug>): void {
  const bugs = readBugs()
  const i = bugs.findIndex(b => b.id === id)
  if (i === -1) return
  bugs[i] = { ...bugs[i], ...patch }
  writeBugs(bugs)
}

// Timer-driven: push pending approval requests and completion notices to the owner.
export async function pollBugLoop(): Promise<void> {
  const bugs = readBugs()
  let changed = false
  for (const b of bugs) {
    if (b.status === 'awaiting_approval' && b.summary) {
      const msg = `🔧 *באג ${b.id}* — דרוש אישור\n\n${b.summary}\n\n👍 לאשר · 👎 לדחות`
      try { await sendMessage(config.ownerPhone, msg); b.status = 'pending_user'; changed = true }
      catch (e) { console.error('[bugloop] approval send failed:', (e as Error).message) }
    } else if (b.status === 'fixed' && !b.done_notified) {
      const msg = `✅ *באג ${b.id} תוקן ועלה לפרודקשן.*${b.done_summary ? `\n${b.done_summary}` : ''}${b.commit ? `\ncommit ${b.commit}` : ''}`
      try { await sendMessage(config.ownerPhone, msg); b.done_notified = true; changed = true }
      catch (e) { console.error('[bugloop] done send failed:', (e as Error).message) }
    }
  }
  if (changed) writeBugs(bugs)
}

// Explicit approval words only (no bare כן/לא) so normal chat isn't hijacked.
const APPROVE = /^\s*(👍|אשר|מאשר|מאושר|לאשר)\b/i
const REJECT  = /^\s*(👎|דחה|דוחה|לדחות|בטל)\b/i

// Owner's reply → decision on the latest pending bug (or a specific #id if named).
// Returns a confirmation string, or null if it isn't an approval (let it flow on).
export function applyOwnerDecision(body: string): string | null {
  const bugs = readBugs()
  const pending = bugs.filter(b => b.status === 'pending_user')
  if (!pending.length) return null
  const t = body.trim()
  const approve = APPROVE.test(t), reject = REJECT.test(t)
  if (!approve && !reject) return null

  const idMatch = t.match(/\b(b[0-9a-z]+)\b/i)
  const target = idMatch ? pending.find(b => b.id === idMatch[1]) : pending[pending.length - 1]
  if (!target) return null

  const note = t.replace(APPROVE, '').replace(REJECT, '').replace(/\b(b[0-9a-z]+)\b/i, '').trim()
  updateBug(target.id, { status: approve ? 'approved' : 'rejected', ...(note ? { user_note: note } : {}) })
  return approve
    ? `👍 אושר — באג ${target.id} ייכנס לטיפול ויעלה. אעדכן כשיהיה מוכן.`
    : `👎 נדחה — באג ${target.id}${note ? ` (${note})` : ''}. לא יעלה.`
}
