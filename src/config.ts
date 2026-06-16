import 'dotenv/config'

function required(key: string): string {
  const val = process.env[key]
  if (!val) throw new Error(`Missing env var: ${key}`)
  return val
}

export const config = {
  anthropicApiKey: required('ANTHROPIC_API_KEY'),
  wahaUrl:         required('WHATSAPP_GW_URL'),
  wahaSession:     process.env.WAHA_SESSION ?? 'default',
  ownerPhone:      required('OWNER_PHONE'),
  // בקבוצות חגי מגיע דרך מזהה @lid ולא דרך הטלפון — צריך לזהות גם אותו
  ownerLid:        process.env.OWNER_LID ?? '157925964279827',
  port:            parseInt(process.env.PORT ?? '3001'),
  webhookSecret:   process.env.WEBHOOK_SECRET ?? '',
  supabaseUrl:     process.env.SUPABASE_URL ?? '',
  supabaseKey:     process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  geminiKey:       process.env.GEMINI_API_KEY ?? '',
}
