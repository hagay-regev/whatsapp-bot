/**
 * agent.ts - רגב — עוזר אישי חכם עם זיכרון + Google Calendar
 */

import Anthropic from '@anthropic-ai/sdk'
import { config } from './config'
import { buildMemoryPrompt, saveRule, saveFact, savePerson, deleteRule, deleteFact } from './memory'
import { createEvent, getSchedule, updateEvent, deleteEvent } from './calendar'
import type { InboundMessage, ChatEntry } from './whatsapp'

const client = new Anthropic({ apiKey: config.anthropicApiKey })

const tools: Anthropic.Tool[] = [
  { name: 'save_rule', description: 'שמור כלל התנהגות', input_schema: { type: 'object' as const, properties: { rule: { type: 'string' } }, required: ['rule'] } },
  { name: 'save_fact', description: 'שמור עובדה לזיכרון', input_schema: { type: 'object' as const, properties: { fact: { type: 'string' } }, required: ['fact'] } },
  { name: 'save_person', description: 'שמור מידע על אדם', input_schema: { type: 'object' as const, properties: { name: { type: 'string' }, info: { type: 'string' } }, required: ['name', 'info'] } },
  { name: 'delete_rule', description: 'מחק כלל', input_schema: { type: 'object' as const, properties: { rule: { type: 'string' } }, required: ['rule'] } },
  { name: 'delete_fact', description: 'מחק עובדה', input_schema: { type: 'object' as const, properties: { fact: { type: 'string' } }, required: ['fact'] } },
  { name: 'add_calendar_event', description: 'הוסף אירוע ליומן Google', input_schema: { type: 'object' as const, properties: { title: { type: 'string' }, datetime: { type: 'string' }, end_datetime: { type: 'string' }, all_day: { type: 'boolean' }, description: { type: 'string' }, calendarName: { type: 'string' }, attendees: { type: 'array', items: { type: 'string' } } }, required: ['title', 'datetime'] } },
  { name: 'get_schedule', description: 'קבל לוח זמנים', input_schema: { type: 'object' as const, properties: { date: { type: 'string' }, date_end: { type: 'string' }, search: { type: 'string' }, calendarName: { type: 'string' } }, required: [] } },
  { name: 'update_calendar_event', description: 'עדכן אירוע קיים', input_schema: { type: 'object' as const, properties: { search: { type: 'string' }, new_title: { type: 'string' }, new_datetime: { type: 'string' }, new_end_datetime: { type: 'string' }, new_calendar: { type: 'string' }, all_day: { type: 'boolean' } }, required: ['search'] } },
  { name: 'delete_calendar_event', description: 'מחק אירוע', input_schema: { type: 'object' as const, properties: { search: { type: 'string' } }, required: ['search'] } },
]

function buildSystemPrompt(msg: InboundMessage, history: ChatEntry[] = []): string {
  const today = new Date().toLocaleDateString('he-IL', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Jerusalem' })
  const time  = new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' })

  const historySection = history.length > 1
    ? `\n# הודעות אחרונות בקבוצה\n${history.slice(-20).map(h =>
        `[${h.ts.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' })}] ${h.sender}: ${h.body}`
      ).join('\n')}\n`
    : ''

  return `אתה רגב — הבוט האישי של חגי רגב-וויל.
אתה חכם, קצר, נעים — עם נגיעה של ציניות וסרקזם קל שגורמת לאנשים לחייך.
אתה שייך לחגי ועובד בשבילו בלבד.

היום: ${today} | שעה: ${time}

${msg.isGroup
  ? `📍 אתה בקבוצה (${msg.chatId}). כל מה שאתה אומר גלוי לכולם.
     אל תחשוף פרטים אישיים על חגי אלא אם הוא הורה במפורש.
     אם שואלים מי אתה — "רגב. הבוט של חגי. אל תשאל יותר מדי שאלות 😏"
     אתה רואה את ההיסטוריה של השיחה. פנו אליך — ענה בהתאם להקשר.`
  : `💬 שיחה פרטית עם ${msg.isFromOwner ? 'חגי (הבעלים)' : msg.senderName}.`}

שולח: ${msg.senderName} | ${msg.isFromOwner ? '✅ זה חגי' : '⚠️ לא חגי'}
${historySection}
# זיכרון
${buildMemoryPrompt()}

# כללים
- מגיב בעברית, קצר וישיר
- "זכור ש..." / הנחיות → save_rule או save_fact
- כשמספרים על אדם → save_person
- בקשות יומן → add_calendar_event / get_schedule / update_calendar_event / delete_calendar_event
- תאריכים יחסיים ("מחר", "ביום שלישי") — חשב לפי התאריך של היום
- טון: נעים עם קורט ציניות — לא גס, לא יבש
`
}

async function handleTool(name: string, input: Record<string, unknown>): Promise<string> {
  const s = (k: string) => String(input[k] ?? '')
  const b = (k: string) => input[k] === true || input[k] === 'true'
  switch (name) {
    case 'save_rule':   saveRule(s('rule'));              return '✅ כלל נשמר'
    case 'save_fact':   saveFact(s('fact'));              return '✅ עובדה נשמרה'
    case 'save_person': savePerson(s('name'), s('info')); return '✅ נשמר מידע'
    case 'delete_rule': deleteRule(s('rule'));             return '✅ נמחק'
    case 'delete_fact': deleteFact(s('fact'));             return '✅ נמחקה'
    case 'add_calendar_event': return await createEvent({ title: s('title'), datetime: s('datetime'), end_datetime: s('end_datetime') || undefined, all_day: b('all_day'), description: s('description') || undefined, calendarName: s('calendarName') || undefined, attendees: (input.attendees as string[]) || undefined })
    case 'get_schedule': return await getSchedule({ date: s('date') || undefined, date_end: s('date_end') || undefined, search: s('search') || undefined, calendarName: s('calendarName') || undefined })
    case 'update_calendar_event': return await updateEvent({ search: s('search'), new_title: s('new_title') || undefined, new_datetime: s('new_datetime') || undefined, new_end_datetime: s('new_end_datetime') || undefined, new_calendar: s('new_calendar') || undefined, all_day: b('all_day') })
    case 'delete_calendar_event': return await deleteEvent(s('search'))
    default: return `כלי לא מוכר: ${name}`
  }
}

export async function runAgent(msg: InboundMessage, history: ChatEntry[] = []): Promise<string> {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: msg.body }]
  while (true) {
    const res = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 1024, system: buildSystemPrompt(msg, history), tools, messages })
    messages.push({ role: 'assistant', content: res.content })
    if (res.stop_reason === 'end_turn') {
      return res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('') || '✅'
    }
    if (res.stop_reason === 'tool_use') {
      const results: Anthropic.ToolResultBlockParam[] = []
      for (const block of res.content) {
        if (block.type !== 'tool_use') continue
        let out: string
        try { out = await handleTool(block.name, block.input as Record<string, unknown>) }
        catch (err) { out = `❌ שגיאה: ${String(err)}` }
        results.push({ type: 'tool_result', tool_use_id: block.id, content: out })
      }
      messages.push({ role: 'user', content: results })
      continue
    }
    break
  }
  return '...'
}
