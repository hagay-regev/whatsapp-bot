/**
 * get-token.js
 * הרץ: node get-token.js
 * יפתח דפדפן לאישור Google ויחזיר את ה-refresh_token
 */

require('dotenv').config()
const http = require('http')
const { exec } = require('child_process')

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('חסרים GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET ב-.env')
  process.exit(1)
}
const REDIRECT_URI  = 'http://localhost:8080'
const SCOPES        = [
  'https://www.googleapis.com/auth/calendar',
  // modify = קריאה + סימון נקרא/לא-נקרא + אשפה + שליחה (לא מחיקה לצמיתות)
  'https://www.googleapis.com/auth/gmail.modify',
  // אנשי קשר (קריאה בלבד) — לחיפוש מייל/טלפון לפי שם
  'https://www.googleapis.com/auth/contacts.readonly',
].join(' ')

const authUrl = `https://accounts.google.com/o/oauth2/auth?` +
  `client_id=${CLIENT_ID}&` +
  `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
  `response_type=code&` +
  `scope=${encodeURIComponent(SCOPES)}&` +
  `access_type=offline&` +
  `prompt=consent`

const server = http.createServer(async (req, res) => {
  const url  = new URL(req.url, REDIRECT_URI)
  const code = url.searchParams.get('code')

  if (!code) {
    res.writeHead(400); res.end('No code'); return
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end('<h2>✅ קיבלנו את הקוד! חזור לטרמינל.</h2>')
  server.close()

  // Exchange code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri:  REDIRECT_URI,
      grant_type:    'authorization_code',
    }),
  })

  const tokens = await tokenRes.json()

  if (tokens.refresh_token) {
    console.log('\n✅ הצלחה!\n')
    console.log('GOOGLE_REFRESH_TOKEN=' + tokens.refresh_token)
    console.log('\nהעתק את השורה הזו ל-.env שלך\n')
  } else {
    console.error('\n❌ שגיאה:', JSON.stringify(tokens, null, 2))
  }
})

server.listen(8080, () => {
  console.log('פותח דפדפן לאישור Google...')
  exec(`start "" "${authUrl}"`)
})
