import { createRequire } from 'module'
import fs from 'fs'
import { store } from './store.js'
import { getDecryptedSettings } from './credentials.js'
import { scheduler } from './engine/scheduler.js'
import { runner } from './engine/runner.js'
import { engine } from './engine/index.js'

const require = createRequire(import.meta.url)
const { Telegraf, Markup } = require('telegraf')

let bot = null
let authorizedChatId = null

// Telegram Bot API caps bot uploads at 50 MB
const TG_UPLOAD_LIMIT = 50 * 1024 * 1024

// Tracks the most recent finished recording so the inline buttons
// (Send recording / Close meeting) know what to act on.
let _lastRecording = null   // { path, bytes, meetingUrl, flowName }

// ─── Formatting helpers ────────────────────────────────────────────────────────

const DIV = '──────────────────────'

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
}

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

function fmtDateTime(iso) {
  return `${fmtDate(iso)} · ${fmtTime(iso)}`
}

function fmtRelative(iso) {
  const ms = new Date(iso) - Date.now()
  if (ms < 0) return 'overdue'
  const mins = Math.floor(ms / 60000)
  if (mins < 60) return `in ${mins}m`
  const hrs = Math.floor(mins / 60)
  return hrs > 0 ? `in ${hrs}h ${mins % 60}m` : `in ${mins}m`
}

function fmtDuration(seconds) {
  if (!seconds || seconds < 60) return `${seconds ?? 0}s`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

// ─── Send helpers ──────────────────────────────────────────────────────────────

async function send(text, extra = {}) {
  if (!bot || !authorizedChatId) return null
  try {
    return await bot.telegram.sendMessage(authorizedChatId, text, {
      parse_mode: 'HTML',
      ...extra
    })
  } catch (e) {
    console.error('[telegram] send failed:', e.message)
    return null
  }
}

async function edit(msgId, text, extra = {}) {
  if (!bot || !authorizedChatId || !msgId) return
  try {
    await bot.telegram.editMessageText(authorizedChatId, msgId, undefined, text, {
      parse_mode: 'HTML',
      ...extra
    })
  } catch { /* ignore — message may be too old */ }
}

// ─── Message builders ──────────────────────────────────────────────────────────

function buildStatusText() {
  const s = engine.getStatus()
  const flows = store.read('flows', [])

  const stateLabel =
    s.isRecording ? '🔴  Recording in progress' :
    s.checking    ? '🔄  Scanning inbox…' :
    s.state === 'running' ? '🟢  Monitoring' :
    s.state === 'error'   ? '🔴  Error' : '⚫  Stopped'

  let out = `⚡ <b>Cueflow Status</b>\n${DIV}\n${stateLabel}`

  if (s.error) out += `\n\n⚠️ <i>${esc(s.error)}</i>`

  out += `\n\n` +
    `📌 Active flows: <b>${s.activeFlowCount}</b> of ${flows.length}\n` +
    `📅 Sessions queued: <b>${s.pendingCount}</b>`

  if (s.lastCheck) {
    out += `\n🕐 Last scan: <b>${fmtTime(s.lastCheck)}</b>`
  }

  if (s.nextTask) {
    const t = s.nextTask
    out += `\n\n⏭ <b>Next up</b>\n` +
      `<b>${esc(t.meetingTitle || t.flowName)}</b>\n` +
      `<code>${fmtDateTime(t.scheduledAt)}</code>  <i>${fmtRelative(t.scheduledAt)}</i>`
  }

  return out
}

function buildScheduleData(flowNameFilter = null) {
  let tasks = store.read('tasks', [])
    .filter(t => t.status === 'pending')
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))

  if (flowNameFilter) {
    tasks = tasks.filter(t => t.flowName.toLowerCase().includes(flowNameFilter.toLowerCase()))
  }

  if (tasks.length === 0) {
    const text = flowNameFilter
      ? `📭 <b>No sessions</b>\n${DIV}\nNothing queued for <i>${esc(flowNameFilter)}</i>`
      : `📭 <b>Schedule is clear</b>\n${DIV}\nNo upcoming sessions.\nCueflow will schedule from the next matched email.`
    return { text, keyboard: null }
  }

  const shown = tasks.slice(0, 8)
  const header = flowNameFilter
    ? `📅 <b>Schedule — ${esc(flowNameFilter)}</b>  (${tasks.length} session${tasks.length !== 1 ? 's' : ''})`
    : `📅 <b>Upcoming Sessions</b>  (${tasks.length} total)`

  const lines = shown.map((t, i) =>
    `<b>${i + 1}.</b> <b>${esc(t.meetingTitle || t.flowName)}</b>\n` +
    `    📌 ${esc(t.flowName)}  ·  ${t.source === 'ics' ? '📎 ICS' : '🔗 link'}\n` +
    `    🕐 <code>${fmtDateTime(t.scheduledAt)}</code>  <i>${fmtRelative(t.scheduledAt)}</i>`
  )

  let text = `${header}\n${DIV}\n\n` + lines.join('\n\n')
  if (tasks.length > 8) text += `\n\n<i>…and ${tasks.length - 8} more</i>`

  const buttons = shown.map((t, i) => [
    Markup.button.callback(
      `✕  Remove #${i + 1} — ${(t.meetingTitle || t.flowName).slice(0, 24)}`,
      `cancel:${t.id}`
    )
  ])

  return { text, keyboard: Markup.inlineKeyboard(buttons) }
}

function buildFlowsData() {
  const flows = store.read('flows', [])
  if (flows.length === 0) {
    return {
      text: `🔄 <b>Flows</b>\n${DIV}\nNo flows configured.\nCreate one in the Cueflow app.`,
      keyboard: null
    }
  }

  const tasks = store.read('tasks', []).filter(t => t.status === 'pending')

  const lines = flows.map(f => {
    const count = tasks.filter(t => t.flowId === f.id).length
    const icon  = f.enabled ? '✅' : '❌'
    const hint  = f.trigger?.subjectContains ? `<i>"${esc(f.trigger.subjectContains)}"</i>` : '<i>any subject</i>'
    const queue = count > 0 ? `  · <b>${count}</b> queued` : ''
    return `${icon} <b>${esc(f.name)}</b>  ${hint}${queue}`
  })

  const text = `🔄 <b>Your Flows</b>  (${flows.length} total)\n${DIV}\n\n` + lines.join('\n')

  const buttons = [
    ...flows.map(f => [
      Markup.button.callback(
        f.enabled ? `⏸  Pause — ${f.name}` : `▶  Enable — ${f.name}`,
        `toggle_flow:${f.id}`
      )
    ]),
    [Markup.button.callback('🔄  Scan Inbox Now', 'check_email')]
  ]

  return { text, keyboard: Markup.inlineKeyboard(buttons) }
}

// ─── Notification exports ──────────────────────────────────────────────────────

export async function notify(text) {
  await send(text)
}

export async function notifyEmailMatched({ subject, from, flowName }) {
  await send(
    `🔍 <b>Email Matched</b>\n${DIV}\n` +
    `📌 Flow: <b>${esc(flowName)}</b>\n` +
    `✉️  From: <code>${esc(from)}</code>\n` +
    `📝 <i>${esc(subject)}</i>`
  )
}

export async function notifyScheduled(task) {
  await send(
    `📅 <b>Session Scheduled</b>\n${DIV}\n` +
    `<b>${esc(task.meetingTitle || task.emailSubject || 'Meeting')}</b>\n` +
    `📌 Flow: <i>${esc(task.flowName)}</i>\n` +
    `🕐 <code>${fmtDateTime(task.scheduledAt)}</code>\n` +
    `⏱ <b>${fmtRelative(task.scheduledAt)}</b>  ·  ${task.source === 'ics' ? '📎 via ICS' : '🔗 via link'}`,
    Markup.inlineKeyboard([[
      Markup.button.callback('✕  Remove this session', `cancel:${task.id}`)
    ]])
  )
}

export async function notifyRecordingStarted(task) {
  return await send(
    `🔴 <b>Recording Started</b>\n${DIV}\n` +
    `<b>${esc(task.meetingTitle || task.flowName)}</b>\n` +
    `📌 <i>${esc(task.flowName)}</i>\n` +
    `⏱ Started at <code>${fmtTime(new Date().toISOString())}</code>`,
    Markup.inlineKeyboard([[
      Markup.button.callback('⏹  Stop Recording', 'stop_recording')
    ]])
  )
}

export async function notifyRecordingDone(task) {
  const r = task.result
  if (!r) {
    await send(`✅ <b>Session ended</b>  —  <i>${esc(task.meetingTitle || task.flowName)}</i>`)
    return
  }
  const dur = r.durationSeconds ?? Math.round(((r.endedAt ?? Date.now()) - (r.startedAt ?? Date.now())) / 1000)
  const mb  = Math.round((r.bytes || 0) / 1024 / 1024)
  const fname = String(r.path || '').split(/[/\\]/).pop()

  // Remember this recording for the inline buttons
  _lastRecording = { path: r.path, bytes: r.bytes || 0, meetingUrl: task.meetingUrl, flowName: task.flowName }

  // Build the action buttons
  const row = [Markup.button.callback('📤  Send me the recording', 'send_recording')]
  // Only offer "Close" for app-based meetings (not browser/Meet)
  if (task.meetingUrl && !/meet\.google/i.test(task.meetingUrl)) {
    row.push(Markup.button.callback('✕  Close Zoom', 'close_meeting'))
  }

  await send(
    `✅ <b>Recording Saved</b>\n${DIV}\n` +
    `<b>${esc(task.meetingTitle || task.flowName)}</b>\n\n` +
    `📁 <code>${esc(fname)}</code>\n` +
    `⏱ Duration: <b>${fmtDuration(dur)}</b>\n` +
    `💾 Size: <b>${mb} MB</b>`,
    Markup.inlineKeyboard([row])
  )

  // Auto-upload if enabled in Telegram settings
  const settings = getDecryptedSettings()
  if (settings.telegram?.autoUpload) {
    await uploadLastRecording()
  }
}

// Upload the last recording to the authorized chat. Returns a result object.
async function uploadLastRecording() {
  const rec = _lastRecording
  if (!rec?.path || !fs.existsSync(rec.path)) {
    return { ok: false, reason: 'not-found' }
  }
  const bytes = fs.statSync(rec.path).size
  if (bytes > TG_UPLOAD_LIMIT) {
    const mb = Math.round(bytes / 1024 / 1024)
    await send(
      `⚠️ <b>Too large for Telegram</b>\n${DIV}\n` +
      `The recording is <b>${mb} MB</b> — Telegram bots can only send files up to 50 MB.\n` +
      `It's saved on your PC:\n<code>${esc(rec.path)}</code>`
    )
    return { ok: false, reason: 'too-large', mb }
  }
  try {
    const filename = rec.path.split(/[/\\]/).pop()
    await bot.telegram.sendDocument(authorizedChatId, { source: rec.path, filename })
    return { ok: true }
  } catch (e) {
    console.error('[telegram] upload failed:', e.message)
    await send(`⚠️ <b>Upload failed</b>\n<code>${esc(e.message)}</code>`)
    return { ok: false, reason: e.message }
  }
}

export async function notifyError(task) {
  await send(
    `❌ <b>Error</b>  —  ${esc(task.flowName)}\n${DIV}\n` +
    `<code>${esc(task.error)}</code>`
  )
}

// ─── Command list registered with BotFather (the / menu) ──────────────────────

const BOT_COMMANDS = [
  { command: 'status',   description: 'Engine status & current recording' },
  { command: 'schedule', description: 'Upcoming sessions — /schedule or /schedule <flow>' },
  { command: 'flows',    description: 'View & manage your flows' },
  { command: 'next',     description: 'Next scheduled session countdown' },
  { command: 'history',  description: 'Recent recordings — /history or /history 10' },
  { command: 'check',    description: 'Scan inbox right now' },
  { command: 'join',     description: 'Join & record a meeting — /join <url>' },
  { command: 'stop',     description: 'Stop the current recording' },
  { command: 'pause',    description: 'Pause a flow — /pause <name>' },
  { command: 'resume',   description: 'Re-enable a flow — /resume <name>' },
  { command: 'help',     description: 'Full command reference' },
]

// ─── Bot setup ─────────────────────────────────────────────────────────────────

export async function startBot() {
  const settings = getDecryptedSettings()
  if (!settings.telegram?.botToken) return

  authorizedChatId = settings.telegram.chatId
  if (bot) await stopBot()

  bot = new Telegraf(settings.telegram.botToken)

  // Register slash-menu commands
  bot.telegram.setMyCommands(BOT_COMMANDS).catch(() => {})

  // Auth — only the configured chat ID can interact
  bot.use((ctx, next) => {
    const id = String(ctx.from?.id || ctx.message?.chat?.id || '')
    if (id && authorizedChatId && id !== String(authorizedChatId)) return
    return next()
  })

  // ── /start ──────────────────────────────────────────────────────────────────
  bot.command('start', async (ctx) => {
    const s = engine.getStatus()
    const stateLabel =
      s.isRecording ? '🔴 Recording' :
      s.state === 'running' ? '🟢 Monitoring' :
      s.state === 'error'   ? '🔴 Error' : '⚫ Stopped'

    const text =
      `👋 <b>Cueflow</b>\n${DIV}\n` +
      `Your automated meeting recorder\n\n` +
      `${stateLabel}  ·  <b>${s.activeFlowCount}</b> flow${s.activeFlowCount !== 1 ? 's' : ''}  ·  <b>${s.pendingCount}</b> queued\n\n` +
      `Use the buttons below or type <b>/help</b> for all commands.`

    await ctx.reply(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📊  Status',    'show_status'),  Markup.button.callback('📅  Schedule', 'show_schedule')],
        [Markup.button.callback('🔄  Flows',     'show_flows'),   Markup.button.callback('📼  History',  'show_history')],
        [Markup.button.callback('🔄  Scan Now',  'check_email')],
      ])
    })
  })

  // ── /status ─────────────────────────────────────────────────────────────────
  bot.command('status', async (ctx) => {
    await ctx.reply(buildStatusText(), {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📅  Schedule', 'show_schedule'), Markup.button.callback('🔄  Flows', 'show_flows')],
        [Markup.button.callback('🔄  Scan Inbox', 'check_email')],
      ])
    })
  })

  // ── /schedule [name] ────────────────────────────────────────────────────────
  bot.command('schedule', async (ctx) => {
    const arg = ctx.message.text.split(' ').slice(1).join(' ').trim() || null
    const { text, keyboard } = buildScheduleData(arg)
    await ctx.reply(text, { parse_mode: 'HTML', ...(keyboard ?? {}) })
  })

  // ── /flows ──────────────────────────────────────────────────────────────────
  bot.command('flows', async (ctx) => {
    const { text, keyboard } = buildFlowsData()
    await ctx.reply(text, { parse_mode: 'HTML', ...(keyboard ?? {}) })
  })

  // ── /next ───────────────────────────────────────────────────────────────────
  bot.command('next', async (ctx) => {
    const t = engine.getStatus().nextTask
    if (!t) {
      await ctx.reply(`📭 <b>Nothing scheduled</b>\n${DIV}\nNo sessions queued right now.`, { parse_mode: 'HTML' })
      return
    }
    await ctx.reply(
      `⏭ <b>Next Session</b>\n${DIV}\n` +
      `<b>${esc(t.meetingTitle || t.flowName)}</b>\n` +
      `📌 <i>${esc(t.flowName)}</i>\n` +
      `🕐 <code>${fmtDateTime(t.scheduledAt)}</code>\n` +
      `⏱ <b>${fmtRelative(t.scheduledAt)}</b>`,
      { parse_mode: 'HTML' }
    )
  })

  // ── /history [n] ────────────────────────────────────────────────────────────
  bot.command('history', async (ctx) => {
    const n = Math.min(Math.max(parseInt(ctx.message.text.split(' ')[1]) || 5, 1), 20)
    const history = store.read('history', []).slice(0, n)

    if (history.length === 0) {
      await ctx.reply(`📭 <b>No recordings yet</b>\n${DIV}\nCompleted sessions will appear here.`, { parse_mode: 'HTML' })
      return
    }

    const lines = history.map((h, i) => {
      const fname = String(h.recordingPath || '').split(/[/\\]/).pop() || 'unknown'
      return (
        `<b>${i + 1}.</b> <code>${esc(fname)}</code>\n` +
        `    📅 ${fmtDateTime(h.startedAt)}  ·  ⏱ ${fmtDuration(h.durationSeconds)}  ·  💾 ${Math.round((h.fileSizeBytes || 0) / 1024 / 1024)} MB`
      )
    })

    await ctx.reply(
      `📼 <b>Recent Recordings</b>  (last ${history.length})\n${DIV}\n\n` + lines.join('\n\n'),
      { parse_mode: 'HTML' }
    )
  })

  // ── /check ──────────────────────────────────────────────────────────────────
  bot.command('check', async (ctx) => {
    const msg = await ctx.reply('🔄 <b>Scanning inbox…</b>', { parse_mode: 'HTML' })
    try {
      await engine.checkNow()
      await edit(msg?.message_id, '✅ <b>Inbox scan complete</b>')
    } catch {
      await edit(msg?.message_id, '❌ <b>Scan failed</b> — check Settings → Connections')
    }
  })

  // ── /join <url>  ────────────────────────────────────────────────────────────
  bot.command(['join', 'record'], async (ctx) => {
    const url = ctx.message.text.split(' ').slice(1).join(' ').trim()
    if (!url?.startsWith('http')) {
      await ctx.reply(
        `ℹ️ <b>Usage</b>\n${DIV}\n<code>/join &lt;meeting-url&gt;</code>\n\n` +
        `Supports Zoom, Teams, and Google Meet.\nOr just paste the URL directly — Cueflow detects it automatically.`,
        { parse_mode: 'HTML' }
      )
      return
    }
    await ctx.reply(
      `🎬 <b>Joining meeting…</b>\n${DIV}\n<code>${esc(url)}</code>`,
      { parse_mode: 'HTML' }
    )
    engine.openAndRecord(url)
  })

  // ── /stop ───────────────────────────────────────────────────────────────────
  bot.command('stop', async (ctx) => {
    if (!runner.isRunning) {
      await ctx.reply(`⚫ <b>Nothing is recording</b>\n${DIV}\nNo active recording to stop.`, { parse_mode: 'HTML' })
      return
    }
    await ctx.reply('⏹ <b>Stop signal sent</b>\n<i>Saving and remuxing…</i>', { parse_mode: 'HTML' })
    engine.stopRecording()
  })

  // ── /pause <name> ───────────────────────────────────────────────────────────
  bot.command('pause', async (ctx) => {
    const name = ctx.message.text.split(' ').slice(1).join(' ').trim()
    if (!name) {
      await ctx.reply('Usage: <code>/pause &lt;flow name&gt;</code>\nUse /flows to see all flows.', { parse_mode: 'HTML' })
      return
    }
    const flows = store.read('flows', [])
    const idx = flows.findIndex(f => f.name.toLowerCase().includes(name.toLowerCase()))
    if (idx === -1) {
      await ctx.reply(`⚠️ No flow matching <i>${esc(name)}</i>\nUse /flows to see all flows.`, { parse_mode: 'HTML' })
      return
    }
    flows[idx] = { ...flows[idx], enabled: false }
    store.write('flows', flows)
    engine.restart()
    await ctx.reply(`⏸ <b>${esc(flows[idx].name)}</b> paused\n<i>No new sessions will be scheduled.</i>`, { parse_mode: 'HTML' })
  })

  // ── /resume <name> ──────────────────────────────────────────────────────────
  bot.command('resume', async (ctx) => {
    const name = ctx.message.text.split(' ').slice(1).join(' ').trim()
    if (!name) {
      await ctx.reply('Usage: <code>/resume &lt;flow name&gt;</code>\nUse /flows to see all flows.', { parse_mode: 'HTML' })
      return
    }
    const flows = store.read('flows', [])
    const idx = flows.findIndex(f => f.name.toLowerCase().includes(name.toLowerCase()))
    if (idx === -1) {
      await ctx.reply(`⚠️ No flow matching <i>${esc(name)}</i>\nUse /flows to see all flows.`, { parse_mode: 'HTML' })
      return
    }
    flows[idx] = { ...flows[idx], enabled: true }
    store.write('flows', flows)
    engine.restart()
    await ctx.reply(`▶ <b>${esc(flows[idx].name)}</b> enabled\n<i>Will resume scheduling from next matched email.</i>`, { parse_mode: 'HTML' })
  })

  // ── /help ───────────────────────────────────────────────────────────────────
  bot.command('help', async (ctx) => {
    await ctx.reply(
      `📖 <b>Cueflow — Command Reference</b>\n${DIV}\n\n` +

      `<b>📊 Info</b>\n` +
      `/status  —  Engine state & recording\n` +
      `/schedule  —  All upcoming sessions\n` +
      `/schedule <i>name</i>  —  Sessions for a flow\n` +
      `/flows  —  View &amp; manage flows\n` +
      `/next  —  Next session countdown\n` +
      `/history  —  Last 5 recordings\n` +
      `/history <i>n</i>  —  Last <i>n</i> recordings\n\n` +

      `<b>🎬 Recording</b>\n` +
      `/check  —  Scan inbox immediately\n` +
      `/join <i>url</i>  —  Join &amp; record a meeting now\n` +
      `/stop  —  Stop current recording\n\n` +

      `<b>🔄 Flows</b>\n` +
      `/pause <i>name</i>  —  Pause a flow\n` +
      `/resume <i>name</i>  —  Re-enable a flow\n\n` +

      `${DIV}\n` +
      `💡 <i>Tip: paste any Zoom, Teams, or Meet URL directly to join &amp; record instantly.</i>`,
      { parse_mode: 'HTML' }
    )
  })

  // ── Inline button callbacks ──────────────────────────────────────────────────

  bot.action('show_status', async (ctx) => {
    await ctx.answerCbQuery()
    await ctx.reply(buildStatusText(), {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📅  Schedule', 'show_schedule'), Markup.button.callback('🔄  Flows', 'show_flows')],
        [Markup.button.callback('🔄  Scan Inbox', 'check_email')],
      ])
    })
  })

  bot.action('show_schedule', async (ctx) => {
    await ctx.answerCbQuery()
    const { text, keyboard } = buildScheduleData()
    await ctx.reply(text, { parse_mode: 'HTML', ...(keyboard ?? {}) })
  })

  bot.action('show_flows', async (ctx) => {
    await ctx.answerCbQuery()
    const { text, keyboard } = buildFlowsData()
    await ctx.reply(text, { parse_mode: 'HTML', ...(keyboard ?? {}) })
  })

  bot.action('show_history', async (ctx) => {
    await ctx.answerCbQuery()
    const history = store.read('history', []).slice(0, 5)
    if (history.length === 0) {
      await ctx.reply(`📭 <b>No recordings yet</b>`, { parse_mode: 'HTML' })
      return
    }
    const lines = history.map((h, i) => {
      const fname = String(h.recordingPath || '').split(/[/\\]/).pop() || 'unknown'
      return (
        `<b>${i + 1}.</b> <code>${esc(fname)}</code>\n` +
        `    📅 ${fmtDateTime(h.startedAt)}  ·  ⏱ ${fmtDuration(h.durationSeconds)}  ·  💾 ${Math.round((h.fileSizeBytes || 0) / 1024 / 1024)} MB`
      )
    })
    await ctx.reply(
      `📼 <b>Recent Recordings</b>\n${DIV}\n\n` + lines.join('\n\n'),
      { parse_mode: 'HTML' }
    )
  })

  bot.action('check_email', async (ctx) => {
    await ctx.answerCbQuery('Scanning inbox…')
    engine.checkNow()
  })

  bot.action('stop_recording', async (ctx) => {
    if (!runner.isRunning) {
      await ctx.answerCbQuery('Nothing is recording right now', { show_alert: true })
      return
    }
    await ctx.answerCbQuery('Stop signal sent')
    try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }) } catch { /* ignore */ }
    await ctx.reply('⏹ <b>Stop signal sent</b>\n<i>Saving and remuxing…</i>', { parse_mode: 'HTML' })
    engine.stopRecording()
  })

  // Send the last recording on demand
  bot.action('send_recording', async (ctx) => {
    if (!_lastRecording?.path) {
      await ctx.answerCbQuery('No recording available', { show_alert: true })
      return
    }
    await ctx.answerCbQuery('Uploading…')
    const sizeMb = Math.round((_lastRecording.bytes || 0) / 1024 / 1024)
    const msg = await ctx.reply(`📤 <b>Uploading recording…</b>  <i>(${sizeMb} MB)</i>`, { parse_mode: 'HTML' })
    const up = await uploadLastRecording()
    if (up.ok) {
      try { await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id) } catch { /* ignore */ }
    }
    // too-large / errors already message the user from uploadLastRecording
  })

  // Close the meeting app (quit Zoom/Teams)
  bot.action('close_meeting', async (ctx) => {
    const url = _lastRecording?.meetingUrl
    if (!url) {
      await ctx.answerCbQuery('No meeting to close', { show_alert: true })
      return
    }
    const did = engine.closeMeeting(url)
    await ctx.answerCbQuery(did ? 'Closing meeting…' : 'Cannot close browser meetings')
    if (did) {
      await ctx.reply('✕ <b>Meeting app closed</b>', { parse_mode: 'HTML' })
    }
  })

  // Cancel a specific scheduled task
  bot.action(/^cancel:(.+)$/, async (ctx) => {
    const taskId = ctx.match[1]
    const tasks = store.read('tasks', [])
    const task = tasks.find(t => t.id === taskId)
    if (!task) {
      await ctx.answerCbQuery('Already removed or not found', { show_alert: true })
      return
    }
    await ctx.answerCbQuery('Session removed')
    scheduler.cancel(taskId)
    try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }) } catch { /* ignore */ }
    await ctx.reply(
      `🗑 <b>Session Removed</b>\n${DIV}\n` +
      `<b>${esc(task.meetingTitle || task.flowName)}</b>\n` +
      `📅 <code>${fmtDateTime(task.scheduledAt)}</code>`,
      { parse_mode: 'HTML' }
    )
  })

  // Toggle flow on/off
  bot.action(/^toggle_flow:(.+)$/, async (ctx) => {
    const flowId = ctx.match[1]
    const flows = store.read('flows', [])
    const idx = flows.findIndex(f => f.id === flowId)
    if (idx === -1) { await ctx.answerCbQuery('Flow not found', { show_alert: true }); return }

    flows[idx] = { ...flows[idx], enabled: !flows[idx].enabled }
    store.write('flows', flows)
    engine.restart()

    const f = flows[idx]
    await ctx.answerCbQuery(f.enabled ? `▶ ${f.name} enabled` : `⏸ ${f.name} paused`)

    try {
      const { text, keyboard } = buildFlowsData()
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...(keyboard ?? {}) })
    } catch {
      const { text, keyboard } = buildFlowsData()
      await ctx.reply(text, { parse_mode: 'HTML', ...(keyboard ?? {}) })
    }
  })

  // ── Auto-detect meeting URLs pasted directly ─────────────────────────────────
  bot.on('message', async (ctx) => {
    const text = ctx.message?.text || ''
    if (text.startsWith('/')) return

    const urlMatch = text.match(/https?:\/\/\S*(?:zoom\.us|teams\.microsoft\.com|meet\.google\.com)\S*/i)
    if (urlMatch) {
      const url = urlMatch[0].replace(/[,;)'"]+$/, '')
      await ctx.reply(
        `🎬 <b>Meeting URL detected</b>\n${DIV}\nJoining and starting recording…\n\n<code>${esc(url)}</code>`,
        { parse_mode: 'HTML' }
      )
      engine.openAndRecord(url)
      return
    }

    await ctx.reply(
      `💬 <i>Unknown input.</i>\nType /help to see all commands, or paste a meeting URL to join instantly.`,
      { parse_mode: 'HTML' }
    )
  })

  bot.launch({ dropPendingUpdates: true })
  console.log('[telegram] Bot started')
}

export async function stopBot() {
  if (bot) { bot.stop(); bot = null }
}

// ─── Wire engine events → Telegram notifications ───────────────────────────────

export function wireTelegramToEngine() {
  engine.on('email:matched', ({ subject, from, flowName }) => {
    notifyEmailMatched({ subject, from, flowName })
  })

  engine.on('task:scheduled', task => {
    notifyScheduled(task)
  })

  engine.on('task:running', task => {
    notifyRecordingStarted(task)
  })

  engine.on('task:completed', task => {
    notifyRecordingDone(task)
  })

  engine.on('task:failed', task => {
    notifyError(task)
  })
}
