/**
 * voice.ts
 * תמלול הודעות קוליות. Claude לא מתמלל אודיו, אז משתמשים ב-Gemini.
 * הגייטווי מצרף את האודיו כ-payload.mediaData = { data (base64), mimetype }.
 */

import { config } from './config'

export async function transcribeVoice(payload: Record<string, unknown>): Promise<string> {
  if (!config.geminiKey) throw new Error('GEMINI_API_KEY חסר')

  const md = payload.mediaData as { data?: string; mimetype?: string } | undefined
  if (!md?.data) throw new Error('אין אודיו בהודעה (הגייטווי לא צירף mediaData)')

  const mimeType = (md.mimetype ?? 'audio/ogg').split(';')[0].trim()

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${config.geminiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { inlineData: { mimeType, data: md.data } },
            { text: 'תמלל את ההודעה הקולית הזו. החזר את הטקסט בלבד, ללא הסברים או הקדמות.' },
          ],
        }],
        generationConfig: { maxOutputTokens: 500, temperature: 0 },
      }),
    },
  )

  const data = await res.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  }
  if (!res.ok) throw new Error(`Gemini: ${JSON.stringify(data).slice(0, 150)}`)

  const transcript = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? ''
  if (!transcript) throw new Error('תמלול ריק')
  return transcript
}
