/**
 * agent.ts
 * רגב — עוזר אישי חכם עם זיכרון דינמי + Google Calendar
 */

import Anthropic from '@anthropic-ai/sdk'
import { config } from './config'
import { buildMemoryPrompt, saveRule, saveFact, savePerson, deleteRule, deleteFact } from './memory'
import { createEvent, getSchedule, updateEvent, deleteEvent } from './calendar'
import { searchEmails, getEmailContent, sendEmail, listInbox, markEmailRead, trashEmail } from './gmail'
import { logHours, queryHours, queryBilling, updateBilling, createTask, updateTask, listTasks } from './billing'
import type { InboundMessage } from './whatsapp'
import type { ChatEntry } from './index'

const client = new Anthropic({ apiKey: config.anthropicApiKey })

// ── Tools ─────────────────────────────────────────────────────────────────────

const tools: Anthropic.Tool[] = [
  // ── זיכרון ──
  {
    name: 'save_rule',
    description: 'שמור כלל התנהגות. השתמש כשהמשתמש אומר "זכור ש...", "אל תעשה...", "תמיד..."',
    input_schema: { type: 'object' as const, properties: { rule: { type: 'string' } }, required: ['rule'] },
  },
  {
    name: 'save_fact',
    description: 'שמור עובדה לזיכרון לשימוש עתידי.',
    input_schema: { type: 'object' as const, properties: { fact: { type: 'string' } }, required: ['fact'] },
  },
  {
    name: 'save_person',
    description: 'שמור מידע על אדם.',
    input_schema: { type: 'object' as const, properties: { name: { type: 'string' }, info: { type: 'string' } }, required: ['name', 'info'] },
  },
  {
    name: 'delete_rule',
    description: 'מחק כלל מהזיכרון.',
    input_schema: { type: 'object' as const, properties: { rule: { type: 'string' } }, required: ['rule'] },
  },
  {
    name: 'delete_fact',
    description: 'מחק עובדה מהזיכרון.',
    input_schema: { type: 'object' as const, properties: { fact: { type: 'string' } }, required: ['fact'] },
  },

  // ── לוח שנה ──
  {
    name: 'add_calendar_event',
    description: 'הוסף אירוע ליומן Google. השתמש כשמבקשים לקבוע פגישה, תזכורת, אירוע וכו\'.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title:        { type: 'string',  description: 'שם האירוע' },
        datetime:     { type: 'string',  description: 'תאריך ושעה בפורמט YYYY-MM-DDTHH:MM:00' },
        end_datetime: { type: 'string',  description: 'שעת סיום (אופציונלי) YYYY-MM-DDTHH:MM:00' },
        all_day:      { type: 'boolean', description: 'אירוע כל היום?' },
        description:  { type: 'string',  description: 'תיאור (אופציונלי)' },
        calendarName: { type: 'string',  description: 'אישי / משפחתי / עבודה' },
        attendees:    { type: 'array', items: { type: 'string' }, description: 'כתובות מייל של משתתפים' },
      },
      required: ['title', 'datetime'],
    },
  },
  {
    name: 'get_schedule',
    description: 'קבל את לוח הזמנים ליום מסוים או חיפוש לפי נושא.',
    input_schema: {
      type: 'object' as const,
      properties: {
        date:         { type: 'string', description: 'YYYY-MM-DD (ברירת מחדל: היום)' },
        date_end:     { type: 'string', description: 'תאריך סיום לטווח YYYY-MM-DD' },
        search:       { type: 'string', description: 'חיפוש לפי מילת מפתח' },
        calendarName: { type: 'string', description: 'אישי / משפחתי / עבודה / הכל' },
      },
      required: [],
    },
  },
  {
    name: 'update_calendar_event',
    description: 'עדכן אירוע קיים — שנה שם, שעה, או העבר ליומן אחר.',
    input_schema: {
      type: 'object' as const,
      properties: {
        search:           { type: 'string', description: 'מילת חיפוש לזיהוי האירוע' },
        new_title:        { type: 'string', description: 'שם חדש' },
        new_datetime:     { type: 'string', description: 'שעה/תאריך חדש YYYY-MM-DDTHH:MM:00' },
        new_end_datetime: { type: 'string', description: 'שעת סיום חדשה' },
        new_calendar:     { type: 'string', description: 'יומן יעד: אישי / משפחתי / עבודה' },
        all_day:          { type: 'boolean', description: 'המר לאירוע כל היום' },
      },
      required: ['search'],
    },
  },
  {
    name: 'delete_calendar_event',
    description: 'מחק אירוע מהיומן.',
    input_schema: {
      type: 'object' as const,
      properties: {
        search: { type: 'string', description: 'מילת חיפוש לזיהוי האירוע למחיקה' },
      },
      required: ['search'],
    },
  },

  // ── Gmail ──
  {
    name: 'list_inbox',
    description: 'הצג מיילים נכנסים. השתמש כשמבקשים "מה יש במייל", "מיילים שלא נקראו", "תראה את התיבה".',
    input_schema: {
      type: 'object' as const,
      properties: {
        unread_only:  { type: 'boolean', description: 'רק מיילים שלא נקראו? (ברירת מחדל: true)' },
        max_results:  { type: 'number',  description: 'מספר מיילים להציג (ברירת מחדל: 8)' },
      },
      required: [],
    },
  },
  {
    name: 'search_emails',
    description: 'חפש מיילים לפי נושא, שולח, או מילות מפתח.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query:       { type: 'string', description: 'שאילתת חיפוש Gmail (כמו: from:someone@example.com subject:חשבונית)' },
        max_results: { type: 'number', description: 'מספר תוצאות (ברירת מחדל: 8)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_email',
    description: 'קרא את תוכן מייל מלא לפי ID שהתקבל מחיפוש.',
    input_schema: {
      type: 'object' as const,
      properties: {
        email_id: { type: 'string', description: 'מזהה המייל (ID)' },
      },
      required: ['email_id'],
    },
  },
  {
    name: 'mark_email_read',
    description: 'סמן מייל כנקרא. השתמש כשמבקשים "תסמן שנקרא", "סמן כנקרא". אם אין ID — חפש קודם עם list_inbox/search_emails.',
    input_schema: {
      type: 'object' as const,
      properties: {
        email_id: { type: 'string', description: 'מזהה המייל (ID)' },
      },
      required: ['email_id'],
    },
  },
  {
    name: 'delete_email',
    description: 'העבר מייל לאשפה. השתמש כשמבקשים "תמחק את המייל". אם אין ID — חפש קודם עם list_inbox/search_emails.',
    input_schema: {
      type: 'object' as const,
      properties: {
        email_id: { type: 'string', description: 'מזהה המייל (ID)' },
      },
      required: ['email_id'],
    },
  },
  // ── תשלומים / שעות / משימות (מסד הנתונים של אפליקציית התשלומים) ──
  {
    name: 'log_hours',
    description: 'דווח שעות עבודה ללקוח. השתמש כש: "3 שעות לכפרית, אינסטלציה", "שעה לרגב בתשלום".',
    input_schema: {
      type: 'object' as const,
      properties: {
        client_name: { type: 'string', description: 'שם הלקוח' },
        hours:       { type: 'number', description: 'מספר שעות' },
        type:        { type: 'string', description: 'maintenance (תחזוקה) / paid_implementation (בתשלום) / order_implementation (מהזמנה)' },
        description: { type: 'string', description: 'תיאור העבודה' },
        date:        { type: 'string', description: 'YYYY-MM-DD (ברירת מחדל: היום)' },
        start_time:  { type: 'string', description: 'שעת התחלה HH:MM (אופציונלי)' },
      },
      required: ['client_name', 'hours'],
    },
  },
  {
    name: 'query_hours',
    description: 'סיכום או רשימת שעות עבודה. לשאלה על יום/טווח ספציפי ("ביום שישי האחרון", "ב-12/6", "בין ה-1 ל-7") — חשב את התאריכים לפי היום והעבר date_from/date_to. ל"היום/השבוע/החודש" אפשר period.',
    input_schema: {
      type: 'object' as const,
      properties: {
        date_from: { type: 'string', description: 'תאריך התחלה YYYY-MM-DD (ליום בודד שים אותו תאריך גם ב-date_to)' },
        date_to:   { type: 'string', description: 'תאריך סיום YYYY-MM-DD' },
        period:    { type: 'string', description: 'today / week / month (חלופה ל-date_from כשהשאלה כללית)' },
        list:      { type: 'boolean', description: 'true = רשימת דיווחים מפורטת, false = סיכום' },
      },
      required: [],
    },
  },
  {
    name: 'query_billing',
    description: 'שאילתת חשבוניות/גבייה. "כמה יש לי לגבות", "מה פתוח אצל כפרית".',
    input_schema: {
      type: 'object' as const,
      properties: {
        client_name: { type: 'string', description: 'סינון לפי לקוח (אופציונלי)' },
        status:      { type: 'string', description: 'unpaid (לגבייה) / paid / all' },
      },
      required: [],
    },
  },
  {
    name: 'update_billing',
    description: 'עדכן חיוב: סמן כשולם / חשבונית הונפקה / קבלה. פעולה רגישה — אשר עם חגי לפני הקריאה.',
    input_schema: {
      type: 'object' as const,
      properties: {
        client_name:     { type: 'string', description: 'שם הלקוח' },
        period:          { type: 'string', description: 'תקופה לסינון (אופציונלי) — בלי זה כל השורות הפתוחות' },
        is_paid:         { type: 'boolean', description: 'סמן כשולם' },
        invoice_created: { type: 'boolean', description: 'חשבונית הונפקה' },
        receipt_issued:  { type: 'boolean', description: 'קבלה הונפקה' },
      },
      required: ['client_name'],
    },
  },
  {
    name: 'manage_tasks',
    description: 'משימות: יצירה/עדכון/רשימה. "צור משימה...", "סגור משימה...", "המשימות שלי". (משימה ≠ תזכורת ביומן)',
    input_schema: {
      type: 'object' as const,
      properties: {
        op:                    { type: 'string', description: 'create / update / list' },
        title:                 { type: 'string', description: 'כותרת (ל-create)' },
        search:                { type: 'string', description: 'מילות חיפוש לזיהוי המשימה (ל-update)' },
        status:                { type: 'string', description: 'open / in_progress / done / cancelled' },
        client_name:           { type: 'string', description: 'לקוח משויך (אופציונלי)' },
        priority:              { type: 'string', description: 'low / medium / high / urgent' },
        category:              { type: 'string', description: 'development / quote / marketing / support / general' },
        description:           { type: 'string' },
        due_date:              { type: 'string', description: 'YYYY-MM-DD' },
        due_time:              { type: 'string', description: 'HH:MM' },
        remind_before_minutes: { type: 'number', description: 'התראה כמה דקות לפני' },
      },
      required: ['op'],
    },
  },
  {
    name: 'send_email',
    description: 'שלח מייל. השתמש רק כשמבקשים במפורש לשלוח.',
    input_schema: {
      type: 'object' as const,
      properties: {
        to:      { type: 'string', description: 'כתובת המייל של הנמען' },
        subject: { type: 'string', description: 'נושא המייל' },
        body:    { type: 'string', description: 'גוף המייל' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
]

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(msg: InboundMessage, history: ChatEntry[] = []): string {
  const today = new Date().toLocaleDateString('he-IL', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Jerusalem' })
  const time  = new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' })

  const historySection = msg.isGroup && history.length > 1
    ? `\n# הודעות אחרונות בקבוצה\n${history.slice(-20).map(h =>
        `[${h.ts.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' })}] ${h.sender}: ${h.body}`
      ).join('\n')}\n`
    : ''

  const groupLabel = msg.groupName ?? msg.chatId

  return `אתה רגב — הבוט האישי של חגי רגב-וויל.
אתה חכם, קצר, נעים — עם נגיעה של ציניות וסרקזם קל שגורמת לאנשים לחייך.
אתה שייך לחגי ועובד בשבילו בלבד.

היום: ${today} | שעה: ${time}

${msg.isGroup
  ? `📍 אתה בקבוצה: "${groupLabel}". כל מה שאתה אומר גלוי לכולם.
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
- בקשות מייל → list_inbox / search_emails / get_email / send_email / mark_email_read / delete_email
- "תראה מיילים", "מה יש במייל" → list_inbox | חיפוש → search_emails | "שלח מייל" → send_email
- "תסמן שנקרא" / "תמחק את המייל" → אם הזכרת מייל קודם בשיחה השתמש ב-ID שלו; אחרת חפש קודם

# תשלומים, שעות ומשימות (אפליקציית התשלומים)
- "X שעות ל<לקוח>, <תיאור>" → log_hours | "כמה שעות עבדתי..." / "הדיווחים שלי" → query_hours
- "כמה לגבות" / "מה פתוח אצל <לקוח>" → query_billing | "סמן ש<לקוח> שילם / הנפיקו חשבונית" → update_billing (אשר עם חגי קודם!)
- "צור משימה..." / "סגור משימה..." / "המשימות שלי" → manage_tasks
- **הבחנה חשובה:** "תזכיר לי מחר ב-9 ל..." = אירוע ביומן → add_calendar_event. "צור משימה..." = משימה אמיתית → manage_tasks. אל תבלבל ביניהם; אם לא ברור — שאל.
- שמות לקוחות מותאמים אוטומטית (התאמה חלקית). אם לקוח לא נמצא — הצג את הרשימה ובקש הבהרה.
- תאריכים יחסיים ("מחר", "ביום שלישי") — חשב לפי התאריך של היום
- טון: נעים עם קורט ציניות — לא גס, לא יבש
- **בקבוצה: אל תציע פעולות שאינך יכול לבצע** (הסרת חברים, בלוק, ניהול קבוצה וכו')
- **הודעה אחת בלבד** — אל תפצל תשובות למספר הודעות
`
}

// ── Tool handler ──────────────────────────────────────────────────────────────

async function handleTool(name: string, input: Record<string, unknown>): Promise<string> {
  const s = (k: string) => String(input[k] ?? '')
  const b = (k: string) => input[k] === true || input[k] === 'true'

  switch (name) {
    // זיכרון
    case 'save_rule':   saveRule(s('rule'));              return `✅ כלל נשמר`
    case 'save_fact':   saveFact(s('fact'));              return `✅ עובדה נשמרה`
    case 'save_person': savePerson(s('name'), s('info')); return `✅ נשמר מידע`
    case 'delete_rule': deleteRule(s('rule'));             return `✅ נמחק`
    case 'delete_fact': deleteFact(s('fact'));             return `✅ נמחקה`

    // לוח שנה
    case 'add_calendar_event':
      return await createEvent({
        title:        s('title'),
        datetime:     s('datetime'),
        end_datetime: s('end_datetime') || undefined,
        all_day:      b('all_day'),
        description:  s('description') || undefined,
        calendarName: s('calendarName') || undefined,
        attendees:    (input.attendees as string[]) || undefined,
      })

    case 'get_schedule':
      return await getSchedule({
        date:         s('date') || undefined,
        date_end:     s('date_end') || undefined,
        search:       s('search') || undefined,
        calendarName: s('calendarName') || undefined,
      })

    case 'update_calendar_event':
      return await updateEvent({
        search:           s('search'),
        new_title:        s('new_title') || undefined,
        new_datetime:     s('new_datetime') || undefined,
        new_end_datetime: s('new_end_datetime') || undefined,
        new_calendar:     s('new_calendar') || undefined,
        all_day:          b('all_day'),
      })

    case 'delete_calendar_event':
      return await deleteEvent(s('search'))

    // Gmail
    case 'list_inbox':
      return await listInbox(
        input.unread_only !== false,
        typeof input.max_results === 'number' ? input.max_results : 8
      )

    case 'search_emails':
      return await searchEmails({
        query:       s('query'),
        maxResults:  typeof input.max_results === 'number' ? input.max_results : 8,
      })

    // תשלומים / שעות / משימות
    case 'log_hours':
      return await logHours({
        client_name: s('client_name'),
        hours:       Number(input.hours),
        type:        s('type') || undefined,
        description: s('description') || undefined,
        date:        s('date') || undefined,
        start_time:  s('start_time') || undefined,
      })

    case 'query_hours':
      return await queryHours({
        date_from: s('date_from') || undefined,
        date_to:   s('date_to') || undefined,
        period:    (s('period') || undefined) as 'today' | 'week' | 'month' | undefined,
        list:      b('list'),
      })

    case 'query_billing':
      return await queryBilling({
        client_name: s('client_name') || undefined,
        status:      (s('status') || 'unpaid') as 'unpaid' | 'paid' | 'all',
      })

    case 'update_billing':
      return await updateBilling({
        client_name:     s('client_name'),
        period:          s('period') || undefined,
        is_paid:         b('is_paid'),
        invoice_created: b('invoice_created'),
        receipt_issued:  b('receipt_issued'),
      })

    case 'manage_tasks': {
      const op = s('op')
      const rbm = typeof input.remind_before_minutes === 'number' ? input.remind_before_minutes : undefined
      if (op === 'create') return await createTask({
        title: s('title'), client_name: s('client_name') || undefined,
        priority: s('priority') || undefined, category: s('category') || undefined,
        description: s('description') || undefined, due_date: s('due_date') || undefined,
        due_time: s('due_time') || undefined, remind_before_minutes: rbm,
      })
      if (op === 'update') return await updateTask({
        search: s('search') || s('title'), status: s('status') || undefined,
        due_date: s('due_date') || undefined, due_time: s('due_time') || undefined,
        remind_before_minutes: rbm,
      })
      return await listTasks({ status: s('status') || undefined, client_name: s('client_name') || undefined })
    }

    case 'get_email':
      return await getEmailContent(s('email_id'))

    case 'mark_email_read':
      return await markEmailRead(s('email_id'))

    case 'delete_email':
      return await trashEmail(s('email_id'))

    case 'send_email':
      return await sendEmail({ to: s('to'), subject: s('subject'), body: s('body') })

    default:
      return `כלי לא מוכר: ${name}`
  }
}

// ── Main agent loop ───────────────────────────────────────────────────────────

/** In private chats, replay the conversation as real user/assistant turns so the
 *  model has context for follow-ups ("תסמן שנקרא" right after an email listing). */
function buildPrivateMessages(msg: InboundMessage, history: ChatEntry[]): Anthropic.MessageParam[] {
  const turns: Anthropic.MessageParam[] = history.slice(-20).map(h => ({
    role: h.sender === 'רגב' ? 'assistant' as const : 'user' as const,
    content: h.body,
  }))
  // First message must be a user turn
  while (turns.length && turns[0].role === 'assistant') turns.shift()
  // Make sure the current message is the last user turn
  if (!turns.length || turns[turns.length - 1].role !== 'user') {
    turns.push({ role: 'user', content: msg.body })
  }
  return turns
}

export async function runAgent(msg: InboundMessage, history: ChatEntry[] = []): Promise<string> {
  const messages: Anthropic.MessageParam[] = msg.isGroup
    ? [{ role: 'user', content: msg.body }]
    : buildPrivateMessages(msg, history)

  while (true) {
    const res = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 1024,
      system:     buildSystemPrompt(msg, history),
      tools,
      messages,
    })

    messages.push({ role: 'assistant', content: res.content })

    if (res.stop_reason === 'end_turn') {
      return res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('') || '✅'
    }

    if (res.stop_reason === 'tool_use') {
      const results: Anthropic.ToolResultBlockParam[] = []
      for (const block of res.content) {
        if (block.type !== 'tool_use') continue
        let out: string
        try {
          out = await handleTool(block.name, block.input as Record<string, unknown>)
        } catch (err) {
          out = `❌ שגיאה: ${String(err)}`
        }
        results.push({ type: 'tool_result', tool_use_id: block.id, content: out })
      }
      messages.push({ role: 'user', content: results })
      continue
    }

    break
  }
  return '...'
}
