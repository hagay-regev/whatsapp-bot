/**
 * buglog.ts
 * Step 1 of the self-improvement loop: detect likely-bad bot replies and queue
 * them to bugs.jsonl. A later scheduled Claude Code run reads the queue, fixes,
 * and (after approval) deploys.
 *
 * Two signals feed the queue:
 *  1. auto — the reply matches a "model is inventing a limitation / guessing"
 *     phrase (high-precision list below; tune as new phrasings appear).
 *  2. manual — the owner replies with באג / 🐛 / 👎 to flag the previous reply.
 */

import fs from 'fs'
import path from 'path'

const BUGS_PATH = path.join(__dirname, '..', 'bugs.jsonl')

// High-precision markers that the bot claimed a system limit or guessed instead
// of admitting it lacked data — the recurring root cause of the reported bugs.
const SUSPICIOUS: Array<{ re: RegExp; tag: string }> = [
  { re: /המערכת לא (מחזיר|תומכ|מאפשר|שומר)/,        tag: 'claims-system-limit' },
  { re: /אין לי (אפשרות|דרך|יכולת)/,                tag: 'claims-cant' },
  { re: /לא יכול (להבדיל|לזהות|לערוך|למחוק|לגשת)/,  tag: 'claims-cant' },
  { re: /אין (לי )?גישה/,                           tag: 'claims-no-access' },
  { re: /לא (נתמך|נתמכת|אפשרי)/,                    tag: 'claims-unsupported' },
  { re: /לא מצליח (לזהות|למצוא|להבין)/,             tag: 'claims-fail' },
]

export function detectInventedReply(reply: string): string | null {
  for (const { re, tag } of SUSPICIOUS) if (re.test(reply)) return tag
  return null
}

// ── Manual flag command parsing ───────────────────────────────────────────────
const FLAG_TOKENS = ['🐛', '👎', 'באג', 'bug', 'Bug', 'BUG']

export function isBugFlag(body: string): boolean {
  const t = body.trim()
  return FLAG_TOKENS.some(tok => t === tok || t.startsWith(tok + ' ') || t.startsWith(tok + ':'))
}

export function bugNote(body: string): string {
  const t = body.trim()
  for (const tok of FLAG_TOKENS) if (t.startsWith(tok)) return t.slice(tok.length).replace(/^[\s:]+/, '').trim()
  return ''
}

// ── Queue writer ──────────────────────────────────────────────────────────────
export interface BugEntry {
  reason: string        // "auto:<tag>" or "user_flag[: note]"
  chatId: string
  isGroup: boolean
  userText: string      // the message that triggered the bad reply
  botReply: string
}

export function flagBug(entry: BugEntry): void {
  try {
    const id = 'b' + Date.now().toString(36)
    const line = JSON.stringify({ id, ts: new Date().toISOString(), status: 'open', ...entry })
    fs.appendFileSync(BUGS_PATH, line + '\n')
    console.log(`[bug] queued (${entry.reason}): ${entry.botReply.slice(0, 60).replace(/\n/g, ' ')}`)
  } catch (err) {
    console.error('[bug] queue write failed:', (err as Error).message)
  }
}
