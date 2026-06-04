import { DateTime } from 'luxon'
import { net } from 'electron'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const ical = require('node-ical')

// Common city/region names that appear in Zoom emails → IANA timezone
const TZ_MAP = {
  Colombo: 'Asia/Colombo', 'Sri Lanka': 'Asia/Colombo',
  Kolkata: 'Asia/Kolkata', Mumbai: 'Asia/Kolkata', Chennai: 'Asia/Kolkata', Delhi: 'Asia/Kolkata', IST: 'Asia/Kolkata',
  Dhaka: 'Asia/Dhaka', Bangladesh: 'Asia/Dhaka',
  Bangkok: 'Asia/Bangkok', Jakarta: 'Asia/Jakarta',
  Singapore: 'Asia/Singapore', Kuala_Lumpur: 'Asia/Kuala_Lumpur',
  Tokyo: 'Asia/Tokyo', Seoul: 'Asia/Seoul',
  Sydney: 'Australia/Sydney', Melbourne: 'Australia/Sydney',
  Auckland: 'Pacific/Auckland',
  Dubai: 'Asia/Dubai', Riyadh: 'Asia/Riyadh',
  Istanbul: 'Europe/Istanbul', Cairo: 'Africa/Cairo',
  London: 'Europe/London', GMT: 'UTC', UTC: 'UTC',
  Paris: 'Europe/Paris', Berlin: 'Europe/Berlin', Rome: 'Europe/Rome',
  'New York': 'America/New_York', EST: 'America/New_York', EDT: 'America/New_York',
  Chicago: 'America/Chicago', Denver: 'America/Denver',
  'Los Angeles': 'America/Los_Angeles', PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles',
  'Sao Paulo': 'America/Sao_Paulo',
}

// ─── URL extraction ────────────────────────────────────────────────────────────

const MEETING_PATTERNS = {
  // /j/ = regular meeting, /w/ = webinar, /my/ = personal room, /s/ = screen share
  zoom:  [/https?:\/\/[a-z0-9.-]*zoom\.us\/[jws]\/[^\s<>"')]+/gi, /https?:\/\/[a-z0-9.-]*zoom\.us\/my\/[^\s<>"')]+/gi, /zoommtg:\/\/[^\s<>"')]+/gi],
  teams: [/https?:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s<>"')]+/gi],
  meet:  [/https?:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/gi]
}

function extractMeetingUrl(content, type = 'any') {
  const types = type === 'any' ? ['zoom', 'teams', 'meet'] : [type]
  for (const t of types) {
    for (const pattern of (MEETING_PATTERNS[t] || [])) {
      const m = content.match(pattern)
      if (m) return m[0].replace(/[,;>)"'\s]+$/, '')
    }
  }
  return null
}

function contentHasMeetingUrl(content, type) {
  return !!extractMeetingUrl(content, type)
}

// ─── Flow matching ─────────────────────────────────────────────────────────────

export function emailMatchesFlow(email, flow) {
  const { trigger } = flow
  if (!trigger) return false

  if (trigger.senderContains?.trim()) {
    if (!email.from.includes(trigger.senderContains.toLowerCase().trim())) return false
  }
  if (trigger.subjectContains?.trim()) {
    if (!email.subject.toLowerCase().includes(trigger.subjectContains.toLowerCase().trim())) return false
  }

  const meetingType = trigger.meetingType || 'any'
  if (meetingType !== 'any') {
    const content = email.subject + ' ' + email.text + ' ' + email.html
    if (!contentHasMeetingUrl(content, meetingType)) return false
  }

  return true
}

// ─── ICS parsing ──────────────────────────────────────────────────────────────

async function parseICSFromEmail(email) {
  const events = []

  for (const att of email.attachments) {
    if (att.contentType?.includes('calendar') || att.filename?.toLowerCase().endsWith('.ics')) {
      try {
        const str = att.content.toString('utf8')
        events.push(...extractVEvents(ical.sync.parseICS(str)))
      } catch (e) {
        console.error('[parser] ICS attachment parse error:', e.message)
      }
    }
  }

  // Inline calendar in body
  if (events.length === 0) {
    const combined = email.text + '\n' + email.html
    if (combined.includes('BEGIN:VCALENDAR')) {
      const start = combined.indexOf('BEGIN:VCALENDAR')
      const end = combined.lastIndexOf('END:VCALENDAR')
      if (end > start) {
        try {
          events.push(...extractVEvents(ical.sync.parseICS(combined.slice(start, end + 13))))
        } catch { /* ignore */ }
      }
    }
  }

  // Download linked .ics files ("Add to Calendar" links)
  if (events.length === 0 && email.html) {
    const links = extractICSLinks(email.html)
    for (const url of links) {
      try {
        // net.fetch uses Chromium's stack — handles TLS inspection on corporate networks
        const res = await net.fetch(url)
        if (res.ok) {
          const text = await res.text()
          if (text.includes('BEGIN:VCALENDAR')) {
            events.push(...extractVEvents(ical.sync.parseICS(text)))
            console.log(`[parser] ICS downloaded: ${events.length} event(s)`)
            if (events.length > 0) break
          }
        }
      } catch (e) {
        console.warn('[parser] ICS link fetch failed:', e.message)
      }
    }
  }

  return events
}

function extractICSLinks(html) {
  const links = []
  // Match href containing .ics or /ics/ path segment
  const re = /href=["']([^"']*(?:\.ics[^"']*|\/ics\/[^"']*|[?&]format=ics[^"']*))/gi
  let m
  while ((m = re.exec(html)) !== null) {
    const url = m[1].replace(/&amp;/g, '&')
    if (url.startsWith('http')) links.push(url)
  }
  return [...new Set(links)]
}

function extractVEvents(parsed) {
  const results = []
  const now = new Date()
  const horizon = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000) // 90 days

  for (const [, ev] of Object.entries(parsed)) {
    if (ev.type !== 'VEVENT') continue

    // Check description, URL field, and location — Zoom/Teams often put the link in LOCATION
    const descContent = String(ev.description || '') + ' ' + String(ev.url || '') + ' ' + String(ev.location || '')
    const url = ev.url || extractMeetingUrl(descContent, 'any')

    if (ev.rrule) {
      try {
        const occurrences = ev.rrule.between(now, horizon, true)
        const duration = ev.end && ev.start ? (new Date(ev.end) - new Date(ev.start)) : 0
        for (const dt of occurrences) {
          // rrule-temporal (used by node-ical ≥0.26) returns Temporal.ZonedDateTime,
          // not JS Date — convert via epochMilliseconds.
          const start = typeof dt.epochMilliseconds === 'number'
            ? new Date(dt.epochMilliseconds)
            : new Date(dt)
          results.push({
            title: ev.summary || 'Meeting',
            start,
            end: duration ? new Date(start.getTime() + duration) : null,
            url
          })
        }
      } catch (e) {
        console.error('[parser] RRULE error:', e.message)
      }
    } else {
      const start = ev.start instanceof Date ? ev.start : new Date(ev.start)
      if (start >= now) {
        results.push({
          title: ev.summary || 'Meeting',
          start,
          end: ev.end ? new Date(ev.end) : null,
          url
        })
      }
    }
  }

  return results
}

// ─── Task creation ─────────────────────────────────────────────────────────────

// Returns true if a pending task for this flow is already scheduled within
// cooldownMinutes of the given time. Prevents duplicate scheduling of the
// same meeting slot from multiple reminder emails.
function isSlotTaken(flowId, scheduledAt, existingTasks, cooldownMinutes) {
  const ms = (cooldownMinutes || 60) * 60 * 1000
  return existingTasks.some(t =>
    t.flowId === flowId &&
    t.status === 'pending' &&
    Math.abs(new Date(t.scheduledAt) - new Date(scheduledAt)) < ms
  )
}

export async function createTasksFromEmail(email, flow, existingTasks) {
  const { schedule: sched, trigger } = flow
  const now = new Date()
  const cooldown = flow.cooldownMinutes ?? 60
  const gracePeriodMinutes = sched?.gracePeriodMinutes ?? 45

  const content = email.subject + ' ' + email.text + ' ' + email.html
  const fallbackUrl = extractMeetingUrl(content, trigger?.meetingType || 'any')

  const icsEvents = await parseICSFromEmail(email)
  const preferICS = sched?.preferICS !== false
  const tasks = []

  if (icsEvents.length > 0 && (preferICS || !fallbackUrl)) {
    // ICS path — schedule every non-duplicate future event
    for (const ev of icsEvents) {
      const url = ev.url || fallbackUrl
      if (!url) continue

      if (isSlotTaken(flow.id, ev.start, existingTasks, cooldown)) {
        console.log(`[parser] Slot already taken at ${ev.start.toISOString()}, skipping`)
        continue
      }

      tasks.push({
        id: crypto.randomUUID(),
        flowId: flow.id, flowName: flow.name,
        emailSubject: email.subject, emailFrom: email.from,
        meetingUrl: url, meetingTitle: ev.title,
        source: 'ics',
        scheduledAt: ev.start.toISOString(),
        stopAt: ev.end ? ev.end.toISOString() : null,
        status: 'pending', createdAt: now.toISOString()
      })
    }
  } else if (fallbackUrl) {
    // Try to extract a specific date/time from the email body first (e.g. Zoom confirmation emails)
    const extracted = extractDateFromEmail(email.text, email.html)

    // Then apply the configured time override if user prefers it
    let scheduledAt = extracted?.date ?? null

    if (!scheduledAt || !sched?.preferICS) {
      // Use configured fallback time but on the extracted date if we have one
      if (sched?.fallbackTime && extracted?.date) {
        const [h, m] = sched.fallbackTime.split(':').map(Number)
        const tz = sched.fallbackTimezone || extracted.tz || 'UTC'
        const dt = DateTime.fromJSDate(extracted.date).setZone(tz).set({ hour: h, minute: m, second: 0 })
        scheduledAt = dt.toJSDate()
      } else {
        scheduledAt = computeFallbackTime(sched, gracePeriodMinutes)
      }
    }

    if (!scheduledAt) {
      console.log(`[parser] No schedulable time for flow "${flow.name}", skipping`)
      return []
    }

    if (scheduledAt < now) {
      console.log(`[parser] Scheduled time is in the past, skipping`)
      return []
    }

    if (isSlotTaken(flow.id, scheduledAt, existingTasks, cooldown)) {
      console.log(`[parser] Slot already taken at ${scheduledAt.toISOString()}, skipping`)
      return []
    }

    tasks.push({
      id: crypto.randomUUID(),
      flowId: flow.id, flowName: flow.name,
      emailSubject: email.subject, emailFrom: email.from,
      meetingUrl: fallbackUrl, meetingTitle: extracted ? email.subject : null,
      source: 'fallback',
      scheduledAt: scheduledAt.toISOString(),
      stopAt: null,
      status: 'pending', createdAt: now.toISOString()
    })
  }

  return tasks
}

// Extract a specific meeting date/time written in the email body.
// Zoom webinar confirmation emails contain e.g. "Jun 5, 2026 07:00 PM Colombo".
function extractDateFromEmail(text, html) {
  const content = (text + ' ' + html).replace(/<[^>]+>/g, ' ') // strip tags from html
  // Matches: "Jun 5, 2026 07:00 PM" or "Jun 05, 2026 7:00 PM"
  const RE = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+(\d{1,2}),?\s+(\d{4})\s+(\d{1,2}:\d{2}\s*(?:AM|PM))\s*([A-Za-z /]+)?/i
  const m = content.match(RE)
  if (!m) return null

  const dateStr = `${m[1]} ${m[2]}, ${m[3]} ${m[4].trim()}`
  const tzRaw   = (m[5] || '').trim().replace(/\s+/g, '_')

  // Look for a timezone match in TZ_MAP (try multi-word first, then single)
  let tz = 'UTC'
  for (const [key, val] of Object.entries(TZ_MAP)) {
    if (tzRaw.replace(/_/g, ' ').toLowerCase().includes(key.toLowerCase())) { tz = val; break }
  }

  const dt = DateTime.fromFormat(dateStr, 'MMM d, yyyy h:mm a', { zone: tz })
  if (!dt.isValid) return null

  console.log(`[parser] Extracted date from email: ${dt.toISO()} (${tz})`)
  return { date: dt.toJSDate(), tz }
}

function computeFallbackTime(sched, gracePeriodMinutes) {
  if (!sched?.fallbackTime) return null

  const [h, m] = sched.fallbackTime.split(':').map(Number)
  const tz = sched.fallbackTimezone || 'UTC'
  const now = DateTime.now().setZone(tz)
  let scheduled = now.set({ hour: h, minute: m, second: 0, millisecond: 0 })

  // If today's time is in the past beyond grace period, try tomorrow
  if (scheduled < now) {
    const minutesPast = now.diff(scheduled, 'minutes').minutes
    if (minutesPast > gracePeriodMinutes) {
      scheduled = scheduled.plus({ days: 1 })
    }
  }

  // Still in the past? skip
  if (scheduled < DateTime.now()) return null

  return scheduled.toJSDate()
}
