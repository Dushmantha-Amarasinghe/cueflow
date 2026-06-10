import { createRequire } from 'module'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { exec } from 'child_process'
import { store } from './store.js'
import { getDecryptedSettings } from './credentials.js'
import { scheduler } from './engine/scheduler.js'
import { runner } from './engine/runner.js'
import { engine } from './engine/index.js'
import { compressForTelegram } from './engine/recorder.js'

const require = createRequire(import.meta.url)
const { Telegraf, Markup } = require('telegraf')

let bot = null
let authorizedChatId = null
let _watchdog = null

// Telegram Bot API caps bot uploads at 50 MB
const TG_UPLOAD_LIMIT = 50 * 1024 * 1024

// Tracks the most recent finished recording so the inline buttons
// (Send recording / Close meeting) know what to act on.
let _lastRecording = null   // { path, bytes, meetingUrl, flowName }

// Tracks the live recording control message (screen switcher / view / stop)
let _activeRecordingMsgId = null
let _activeTask           = null
let _allDisplays          = []
let _activeDisplayId      = null

// ─── Screenshot capture (PowerShell + System.Drawing) ─────────────────────────

const CAPTURE_PS1 = path.join(os.tmpdir(), 'cueflow-capture.ps1')
let _capturePs1Written = false

function ensureCaptureScript() {
  if (_capturePs1Written) return
  const script = `param([string]$OutDir)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$screens = [System.Windows.Forms.Screen]::AllScreens
$i = 0
foreach ($s in $screens) {
  $b = $s.Bounds
  $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $g.Dispose()
  $out = Join-Path $OutDir "screen_$i.jpg"
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Jpeg)
  $bmp.Dispose()
  Write-Output $out
  $i++
}
`
  try { fs.writeFileSync(CAPTURE_PS1, script, 'utf8'); _capturePs1Written = true }
  catch (e) { console.warn('[telegram] could not write capture script:', e.message) }
}

function captureAllScreenshots() {
  ensureCaptureScript()
  if (!_capturePs1Written) return Promise.resolve([])
  const outDir = os.tmpdir()
  return new Promise(resolve => {
    exec(
      `powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${CAPTURE_PS1}" "${outDir}"`,
      { timeout: 15000 },
      (err, stdout) => {
        if (err) { console.warn('[telegram] screenshot capture failed:', err.message); resolve([]); return }
        const paths = stdout.trim().split(/\r?\n/).filter(Boolean)
        resolve(paths)
      }
    )
  })
}

// ─── Recording control keyboard ────────────────────────────────────────────────

// activeIdx = index into allDisplays of the currently recording screen (-1 = unknown)
function buildRecordingKeyboard(allDisplays, activeIdx) {
  const rows = []
  if (allDisplays.length > 0) {
    const btns = allDisplays.map((_d, i) =>
      Markup.button.callback((i === activeIdx ? '✅ ' : '') + `Screen ${i + 1}`, `switch_screen:${i}`)
    )
    for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2))
  }
  rows.push([Markup.button.callback('📸 View screens', 'view_screens')])
  rows.push([
    Markup.button.callback('🔄 Retry maximize', 'retry_maximize'),
    Markup.button.callback('⏹ Stop', 'stop_recording')
  ])
  return Markup.inlineKeyboard(rows)
}

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
  if (hrs < 24) return `in ${hrs}h ${mins % 60}m`
  const days = Math.floor(hrs / 24)
  const remHrs = hrs % 24
  return remHrs > 0 ? `in ${days}d ${remHrs}h` : `in ${days}d`
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

// Match an OBS or Electron display object against the Electron displays list.
// OBS names look like "Screen 2: 1920x1080 @ 2560,199" — parse the @ x,y position.
function findElectronDisplayIndex(display, electronDisplays) {
  if (!display || !electronDisplays.length) return -1
  // Electron-style display with bounds
  if (display.bounds) {
    return electronDisplays.findIndex(d =>
      d.bounds.x === display.bounds.x && d.bounds.y === display.bounds.y
    )
  }
  // OBS monitor name: extract "@ x,y"
  if (display.name) {
    const m = display.name.match(/@\s*(-?\d+),(-?\d+)/)
    if (m) {
      const ox = parseInt(m[1]), oy = parseInt(m[2])
      return electronDisplays.findIndex(d => d.bounds.x === ox && d.bounds.y === oy)
    }
  }
  return -1
}

export async function notifyRecordingStarted(task, display, allDisplays) {
  _activeTask      = task
  _allDisplays     = allDisplays || []
  _activeDisplayId = display?.id ?? null

  const screenIdx  = findElectronDisplayIndex(display, _allDisplays)
  _activeDisplayId = screenIdx   // store the resolved index (-1 if unknown)
  const screenName = screenIdx >= 0 ? `Screen ${screenIdx + 1}` : 'configured screen'

  const msg = await send(
    `🔴 <b>Recording Started</b>\n${DIV}\n` +
    `<b>${esc(task.meetingTitle || task.flowName)}</b>\n` +
    `📌 <i>${esc(task.flowName)}</i>\n` +
    `🖥 Capturing: <b>${screenName}</b>\n` +
    `⏱ Started at <code>${fmtTime(new Date().toISOString())}</code>`,
    buildRecordingKeyboard(_allDisplays, _activeDisplayId)
  )
  _activeRecordingMsgId = msg?.message_id ?? null
}

export async function notifyRecordingDone(task) {
  // Remove the live control keyboard from the recording-started message
  if (_activeRecordingMsgId && bot && authorizedChatId) {
    try {
      await bot.telegram.editMessageReplyMarkup(
        authorizedChatId, _activeRecordingMsgId, undefined, { inline_keyboard: [] }
      )
    } catch { /* message may be too old — ignore */ }
  }
  _activeRecordingMsgId = null
  _activeTask           = null
  _allDisplays          = []
  _activeDisplayId      = null

  const r = task.result
  if (!r) {
    await send(`✅ <b>Session ended</b>  —  <i>${esc(task.meetingTitle || task.flowName)}</i>`)
    return
  }
  const dur = r.durationSeconds ?? Math.round(((r.endedAt ?? Date.now()) - (r.startedAt ?? Date.now())) / 1000)
  const mb  = Math.round((r.bytes || 0) / 1024 / 1024)
  const fname = String(r.path || '').split(/[/\\]/).pop()

  // Remember this recording for the inline buttons / upload
  _lastRecording = { path: r.path, bytes: r.bytes || 0, durationSeconds: dur, meetingUrl: task.meetingUrl, flowName: task.flowName }

  const settings   = getDecryptedSettings()
  const autoUpload = settings.telegram?.autoUpload === true

  // Buttons: "Send me the recording" only when auto-upload is OFF (otherwise it's
  // already being sent). "Close Zoom" stays for app-based meetings.
  const row = []
  if (!autoUpload) row.push(Markup.button.callback('📤  Send me the recording', 'send_recording'))
  if (task.meetingUrl && !/meet\.google/i.test(task.meetingUrl)) {
    row.push(Markup.button.callback('✕  Close Zoom', 'close_meeting'))
  }

  await send(
    `✅ <b>Recording Saved</b>\n${DIV}\n` +
    `<b>${esc(task.meetingTitle || task.flowName)}</b>\n\n` +
    `📁 <code>${esc(fname)}</code>\n` +
    `⏱ Duration: <b>${fmtDuration(dur)}</b>\n` +
    `💾 Size: <b>${mb} MB</b>`,
    row.length ? Markup.inlineKeyboard([row]) : undefined
  )

  // Auto-upload path: send if it fits, or compress-and-send if that toggle is on.
  if (autoUpload) {
    await deliverRecording({ allowCompress: settings.telegram?.compressLarge === true })
  }
}

// Deliver the last recording to the chat.
// - Under the limit → send directly.
// - Over the limit  → compress and send if allowed, else report too-large.
async function deliverRecording({ allowCompress }) {
  const rec = _lastRecording
  if (!rec?.path || !fs.existsSync(rec.path)) return { ok: false, reason: 'not-found' }

  const bytes = fs.statSync(rec.path).size

  // Fits → send as-is
  if (bytes <= TG_UPLOAD_LIMIT) {
    return await sendFile(rec.path)
  }

  // Too large
  const mb = Math.round(bytes / 1024 / 1024)
  if (!allowCompress) {
    await send(
      `⚠️ <b>Too large for Telegram</b>\n${DIV}\n` +
      `The recording is <b>${mb} MB</b> (bot limit is 50 MB).\n` +
      `It's saved on your PC:\n<code>${esc(rec.path)}</code>`
    )
    return { ok: false, reason: 'too-large', mb }
  }

  // Compress then send
  await send(`🗜 <b>Compressing for Telegram…</b>\n<i>${mb} MB → reducing quality to fit under 50 MB. This may take a moment.</i>`)
  const compressed = await compressForTelegram(rec.path, rec.durationSeconds)
  if (!compressed) {
    await send(`⚠️ <b>Compression failed</b>\nThe recording is saved on your PC:\n<code>${esc(rec.path)}</code>`)
    return { ok: false, reason: 'compress-failed' }
  }
  const cBytes = fs.statSync(compressed).size
  if (cBytes > TG_UPLOAD_LIMIT) {
    const cmb = Math.round(cBytes / 1024 / 1024)
    await send(`⚠️ <b>Still too large after compression</b> (${cmb} MB).\nSaved locally:\n<code>${esc(rec.path)}</code>`)
    try { fs.unlinkSync(compressed) } catch { /* ignore */ }
    return { ok: false, reason: 'too-large-after-compress' }
  }
  const result = await sendFile(compressed, '  (compressed)')
  try { fs.unlinkSync(compressed) } catch { /* ignore */ }   // remove temp file
  return result
}

async function sendFile(path, suffix = '') {
  try {
    const filename = path.split(/[/\\]/).pop()
    await bot.telegram.sendDocument(authorizedChatId, { source: path, filename },
      { caption: `📼 Recording${suffix}` })
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

  // Auth — deny by default. Only the configured Chat ID may interact; if no
  // Chat ID is set, the bot responds to nobody (prevents strangers who find the
  // bot from issuing commands like /join on the user's machine).
  bot.use((ctx, next) => {
    const id = String(ctx.from?.id || ctx.message?.chat?.id || '')
    if (!authorizedChatId || id !== String(authorizedChatId)) return
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

  // Send the last recording on demand. The software decides: send directly if it
  // fits, otherwise compress and send automatically (button path always compresses).
  bot.action('send_recording', async (ctx) => {
    if (!_lastRecording?.path || !fs.existsSync(_lastRecording.path)) {
      await ctx.answerCbQuery('Recording not found', { show_alert: true })
      return
    }
    await ctx.answerCbQuery('Sending…')
    try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }) } catch { /* ignore */ }
    const actualBytes = fs.existsSync(_lastRecording.path) ? fs.statSync(_lastRecording.path).size : (_lastRecording.bytes || 0)
    const sizeMb = Math.round(actualBytes / 1024 / 1024)
    await ctx.reply(`📤 <b>Uploading recording…</b>  <i>(${sizeMb} MB — this may take a minute)</i>`, { parse_mode: 'HTML' })
    // Fire-and-forget: don't await inside the handler (90 s callback timeout).
    deliverRecording({ allowCompress: true })
      .catch(e => console.error('[telegram] deliver failed:', e.message))
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

  // ── Screen-control actions (active during recording) ────────────────────────

  bot.action('view_screens', async (ctx) => {
    await ctx.answerCbQuery('Capturing screens…')
    const paths = await captureAllScreenshots()
    if (paths.length === 0) {
      await ctx.reply('⚠️ <b>Could not capture screenshots</b>', { parse_mode: 'HTML' })
      return
    }
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i]
      if (!fs.existsSync(p)) continue
      const isActive = String(_allDisplays[i]?.id) === String(_activeDisplayId)
      try {
        await bot.telegram.sendPhoto(authorizedChatId, { source: p },
          { caption: `🖥 Screen ${i + 1}${isActive ? ' ← recording here' : ''}` })
      } catch (e) {
        console.warn('[telegram] screenshot send failed:', e.message)
      }
      try { fs.unlinkSync(p) } catch {}
    }
  })

  bot.action(/^switch_screen:(\d+)$/, async (ctx) => {
    const idx = parseInt(ctx.match[1])
    const display = _allDisplays[idx]
    if (!display) {
      await ctx.answerCbQuery('Screen not found', { show_alert: true })
      return
    }
    await ctx.answerCbQuery(`Switching to Screen ${idx + 1}…`)
    const ok = await engine.switchRecordingDisplay(display)
    if (ok) {
      _activeDisplayId = idx
      try {
        await ctx.editMessageReplyMarkup(
          buildRecordingKeyboard(_allDisplays, _activeDisplayId).reply_markup
        )
      } catch { /* ignore */ }
      await ctx.reply(`🖥 <b>Switched to Screen ${idx + 1}</b>`, { parse_mode: 'HTML' })
    } else {
      await ctx.reply(`⚠️ <b>Could not switch screen</b> — not recording right now`, { parse_mode: 'HTML' })
    }
  })

  bot.action('retry_maximize', async (ctx) => {
    if (!_activeTask?.meetingUrl) {
      await ctx.answerCbQuery('No active meeting', { show_alert: true })
      return
    }
    await ctx.answerCbQuery('Maximizing window…')
    engine.maximizeMeetingWindow(_activeTask.meetingUrl)
    await ctx.reply('🔄 <b>Retry maximize sent</b>', { parse_mode: 'HTML' })
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

  bot.catch((err) => {
    console.error('[telegram] unhandled handler error:', err.message)
  })

  // bot.launch() rejects when polling dies — catch it so it never becomes an
  // unhandled rejection. 409 means another instance is still polling; wait 65s
  // for Telegram's long-poll to expire before retrying. Any other error: 5s retry.
  bot.launch({ dropPendingUpdates: true })
    .catch(async (e) => {
      const is409 = /409|conflict/i.test(e.message || '')
      if (is409) {
        console.warn('[telegram] polling conflict (409) — another instance running, waiting 65s')
      } else {
        console.error('[telegram] polling stopped:', e.message)
      }
      try { if (bot) { bot.stop(); bot = null } } catch {}
      await new Promise(r => setTimeout(r, is409 ? 65000 : 5000))
      try { await startBot() } catch (retryErr) {
        console.error('[telegram] restart after polling error failed:', retryErr.message)
      }
    })

  console.log('[telegram] Bot started')

  // heartbeat: if getMe() fails the polling connection has died — restart silently
  clearInterval(_watchdog)
  _watchdog = setInterval(async () => {
    if (!bot) return
    try {
      await bot.telegram.getMe()
    } catch {
      console.warn('[telegram] heartbeat failed — restarting bot')
      try { bot.stop(); bot = null } catch {}
      try { await startBot() } catch (e) {
        console.error('[telegram] restart failed:', e.message)
      }
    }
  }, 3 * 60 * 1000)
}

export async function stopBot() {
  clearInterval(_watchdog)
  _watchdog = null
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

  engine.on('recording:started', ({ task, display, allDisplays }) => {
    notifyRecordingStarted(task, display, allDisplays)
  })

  engine.on('task:completed', task => {
    notifyRecordingDone(task)
  })

  engine.on('recording:compressing', ({ mode }) => {
    const label = mode === 'max' ? 'Max (HEVC CRF 28 · medium)' : 'Smart (HEVC CRF 30 · fast)'
    send(`🗜 <b>Compressing…</b>  <i>${label}</i>\nRe-encoding with HEVC. Running in background.`)
  })

  engine.on('recording:compressed', ({ ok, originalBytes, finalBytes }) => {
    if (!ok) {
      send('⚠️ <b>Compression skipped</b>  —  FFmpeg not available or encoding failed.')
      return
    }
    const before = Math.round(originalBytes / 1024 / 1024)
    const after  = Math.round(finalBytes  / 1024 / 1024)
    const pct    = Math.round((1 - finalBytes / originalBytes) * 100)
    send(`✅ <b>Compression done</b>  —  <b>${before} MB → ${after} MB</b>  <i>(${pct}% smaller)</i>`)
  })

  engine.on('task:failed', task => {
    notifyError(task)
  })
}
