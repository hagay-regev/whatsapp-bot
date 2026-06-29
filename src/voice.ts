/**
 * voice.ts
 * תמלול הודעות קוליות + תיאור תמונות. Claude לא מתמלל אודיו/קורא תמונות כאן, אז משתמשים ב-Gemini.
 * הגייטווי מצרף את המדיה כ-payload.mediaData = { data (base64), mimetype }.
 */

import { config } from './config'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Call Gemini generateContent with retry on transient overload (503/429) and
// fallback across models — Gemini occasionally returns 503 "high demand" which
// would otherwise drop the message entirely (voice "doesn't respond at all").
async function geminiGenerate(opts: {
  models: string[]; parts: unknown[]; maxOutputTokens: number
}): Promise<string> {
  if (!config.geminiKey) throw new Error('GEMINI_API_KEY חסר')
  let lastErr = 'unknown'
  for (const model of opts.models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: opts.parts }],
            generationConfig: { maxOutputTokens: opts.maxOutputTokens, temperature: 0 },
          }),
        },
      )
      const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
      if (res.ok) {
        const out = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? ''
        if (out) return out
        lastErr = 'תשובה ריקה'
        break  // empty result — try the next model rather than retrying
      }
      lastErr = JSON.stringify(data).slice(0, 150)
      // Retry only on transient overload / rate-limit; otherwise move to next model.
      if (res.status === 503 || res.status === 429) { await sleep(600 * (attempt + 1)); continue }
      break
    }
  }
  throw new Error(`Gemini: ${lastErr}`)
}

export async function describeImage(payload: Record<string, unknown>): Promise<string> {
  const md = payload.mediaData as { data?: string; mimetype?: string } | undefined
  if (!md?.data) throw new Error('אין תמונה')
  const mimeType = (md.mimetype ?? 'image/jpeg').split(';')[0].trim()
  return geminiGenerate({
    models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    maxOutputTokens: 600,
    parts: [
      { inlineData: { mimeType, data: md.data } },
      { text: 'תאר את התמונה בקצרה, וחלץ כל טקסט ופרטים חשובים שמופיעים בה (תאריכים, שעות, מספרים, שמות, יעדים, סכומים). החזר טקסט בלבד.' },
    ],
  })
}

export async function transcribeVoice(payload: Record<string, unknown>): Promise<string> {
  const md = payload.mediaData as { data?: string; mimetype?: string } | undefined
  if (!md?.data) throw new Error('אין אודיו בהודעה (הגייטווי לא צירף mediaData)')
  const mimeType = (md.mimetype ?? 'audio/ogg').split(';')[0].trim()
  return geminiGenerate({
    // flash-lite first (cheap/fast); fall back to flash when lite is overloaded.
    models: ['gemini-2.5-flash-lite', 'gemini-2.5-flash'],
    maxOutputTokens: 500,
    parts: [
      { inlineData: { mimeType, data: md.data } },
      { text: 'תמלל את ההודעה הקולית הזו. החזר את הטקסט בלבד, ללא הסברים או הקדמות.' },
    ],
  })
}
