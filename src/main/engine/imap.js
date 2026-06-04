import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'

const IMAP_CONFIG = (creds) => ({
  host: 'imap.gmail.com',
  port: 993,
  secure: true,
  auth: { user: creds.email, pass: creds.password },
  logger: false,
  tls: { rejectUnauthorized: false }
})

export async function fetchNewEmails(gmailCreds, since) {
  const client = new ImapFlow(IMAP_CONFIG(gmailCreds))
  const emails = []
  const sinceDate = since instanceof Date ? since
    : (since ? new Date(since) : new Date(Date.now() - 24 * 60 * 60 * 1000))

  try {
    await client.connect()

    const mailbox = await client.mailboxOpen('INBOX')
    const total = mailbox.exists || 0

    if (total > 0) {
      // Fetch last 100 messages by sequence range — avoids SEARCH command entirely.
      // Filter by date in memory after fetching envelopes.
      const start = Math.max(1, total - 99)

      for await (const msg of client.fetch(`${start}:${total}`, { source: true, envelope: true })) {
        try {
          const msgDate = msg.envelope?.date ? new Date(msg.envelope.date) : null
          if (!msgDate || msgDate < sinceDate) continue

          const parsed = await simpleParser(msg.source)
          emails.push({
            uid: msg.uid,
            messageId: msg.envelope.messageId || '',
            from: (msg.envelope.from?.[0]?.address || '').toLowerCase(),
            fromName: msg.envelope.from?.[0]?.name || '',
            subject: msg.envelope.subject || '',
            date: msgDate,
            text: parsed.text || '',
            html: parsed.html || '',
            attachments: (parsed.attachments || []).map(a => ({
              filename: a.filename || '',
              contentType: a.contentType || '',
              content: a.content
            }))
          })
        } catch (e) {
          console.error('[imap] parse error uid', msg.uid, e.message)
        }
      }
    }

    await client.logout()
  } catch (err) {
    try { await client.logout() } catch { /* ignore */ }
    // Surface the real IMAP response details — imapflow buries them under "Command failed"
    const detail = err.responseText || err.serverResponseCode || err.message
    const e = new Error(detail || 'Command failed')
    e.original = err
    throw e
  }

  return emails
}

export async function testGmailConnection(creds) {
  const client = new ImapFlow(IMAP_CONFIG(creds))
  try {
    await client.connect()
    await client.logout()
    return { success: true }
  } catch (err) {
    try { await client.logout() } catch { /* ignore */ }
    return { success: false, error: err.message }
  }
}
