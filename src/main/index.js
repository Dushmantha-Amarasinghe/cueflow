import { app, BrowserWindow, ipcMain, shell, powerSaveBlocker, dialog, Tray, Menu, nativeImage, screen, desktopCapturer, net } from 'electron'
import path from 'path'
import zlib from 'zlib'
import { fileURLToPath } from 'url'
import { exec } from 'child_process'
import { createRequire } from 'module'
import { store } from './store.js'
import { encrypt as encryptField, decrypt as decryptField } from './credentials.js'
import { engine } from './engine/index.js'
import { scheduler } from './engine/scheduler.js'
import { recorder } from './engine/recorder.js'
import { startBot, stopBot, wireTelegramToEngine } from './telegram.js'
import { isAllowedExternalUrl } from './security.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const _require   = createRequire(import.meta.url)
const _ffmpegBin = _require('ffmpeg-static')

// ─── Update checker (GitHub Releases API) ───────────────────────────────────────

const GITHUB_REPO = 'Dushmantha-Amarasinghe/cueflow'

// Compare two semver-ish strings. Returns 1 if a>b, -1 if a<b, 0 if equal.
function compareVersions(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0)
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1
    if ((pa[i] || 0) < (pb[i] || 0)) return -1
  }
  return 0
}

// Fetch the latest GitHub release and compare to the running version.
async function checkForUpdate() {
  try {
    const res = await net.fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'Cueflow-Updater' }
    })
    if (res.status === 404) return { ok: true, available: false, reason: 'no-releases' }
    if (!res.ok) return { ok: false, reason: `http-${res.status}` }

    const data    = await res.json()
    const latest  = (data.tag_name || '').replace(/^v/i, '')
    const current = app.getVersion()
    const available = latest && compareVersions(latest, current) > 0

    // Prefer the .exe installer asset; fall back to the release page
    const exe = (data.assets || []).find(a => /\.exe$/i.test(a.name))
    return {
      ok: true,
      available,
      version: latest,
      current,
      notes: data.body || '',
      downloadUrl: exe?.browser_download_url || data.html_url,
      pageUrl: data.html_url
    }
  } catch (e) {
    return { ok: false, reason: e.message }
  }
}

// ─── Icon generator ────────────────────────────────────────────────────────────

function crc32(buf) {
  const table = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  let crc = 0xffffffff
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}

function createCirclePNG(size, r, g, b) {
  const cx = (size - 1) / 2, cy = (size - 1) / 2, radius = size / 2 - 1
  const rows = []
  for (let y = 0; y < size; y++) {
    rows.push(0)
    for (let x = 0; x < size; x++) {
      const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2)
      d <= radius ? rows.push(r, g, b, 255) : rows.push(0, 0, 0, 0)
    }
  }
  const idat = zlib.deflateSync(Buffer.from(rows), { level: 6 })
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

const ICON_COLORS = {
  idle:      [113, 113, 122],
  active:    [245, 158,  11],
  recording: [ 34, 197,  94],
  error:     [239,  68,  68]
}

function createTrayIcon(state) {
  const [r, g, b] = ICON_COLORS[state] ?? ICON_COLORS.idle
  return nativeImage.createFromBuffer(createCirclePNG(16, r, g, b))
}

// ─── Tray ─────────────────────────────────────────────────────────────────────

let tray = null
let trayState = 'idle'
let trayInfo = null

function setupTray(win) {
  tray = new Tray(createTrayIcon('idle'))
  tray.setToolTip('Cueflow — Idle')
  rebuildTrayMenu(win)
  tray.on('click', () => { win.isVisible() ? win.focus() : (win.show(), win.focus()) })
}

function setTrayState(state, info, win) {
  trayState = state; trayInfo = info
  tray?.setImage(createTrayIcon(state))
  const tips = {
    idle:      'Cueflow — Idle',
    active:    info?.flowName ? `Cueflow — ${info.flowName} starting...` : 'Cueflow — Active',
    recording: info?.flowName ? `Cueflow — Recording: ${info.flowName}` : 'Cueflow — Recording',
    error:     info?.message  ? `Cueflow — Error: ${info.message}` : 'Cueflow — Error'
  }
  tray?.setToolTip(tips[state] ?? 'Cueflow')
  rebuildTrayMenu(win)
}

function rebuildTrayMenu(win) {
  const items = []
  if (trayState === 'recording' && trayInfo?.flowName) {
    items.push({ label: `● Recording: ${trayInfo.flowName}`, enabled: false })
    items.push({ type: 'separator' })
  }
  items.push({ label: 'Open Cueflow',    click: () => { win?.show(); win?.focus() } })
  items.push({ label: 'Flows',           click: () => { win?.show(); win?.focus(); win?.webContents.send('navigate', 'flows') } })
  items.push({ label: 'Check email now', click: () => { engine.checkNow(); win?.webContents.send('action', 'checkEmail') } })
  if (trayState === 'recording') {
    items.push({ type: 'separator' })
    items.push({ label: 'Stop recording', click: () => engine.stopRecording() })
  }
  items.push({ type: 'separator' })
  items.push({ label: 'Exit', click: () => app.quit() })
  tray?.setContextMenu(Menu.buildFromTemplate(items))
}

// ─── Window ────────────────────────────────────────────────────────────────────

let mainWindow = null
let powerBlockerId = null
let isQuitting = false

function resolveResource(file) {
  // Packaged: resources are unpacked alongside the app. Dev: project ./resources
  const packaged = path.join(process.resourcesPath || '', file)
  const dev      = path.join(__dirname, '../../resources', file)
  return app.isPackaged ? packaged : dev
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    backgroundColor: '#0d0d0d',
    show: false,
    icon: resolveResource('icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
      // Keep the renderer (and its MediaRecorder) running at full speed even
      // when the window is hidden/minimised — recordings happen in the tray.
      backgroundThrottling: false
    }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  // Security: never let the renderer spawn new windows or navigate away from
  // the app. External links are opened in the real browser, scheme-checked.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const dev = process.env['ELECTRON_RENDERER_URL']
    if (!(dev && url.startsWith(dev)) && !url.startsWith('file://')) {
      e.preventDefault()
      if (isAllowedExternalUrl(url)) shell.openExternal(url)
    }
  })
  mainWindow.webContents.on('will-attach-webview', (e) => e.preventDefault())

  mainWindow.on('ready-to-show', () => mainWindow.show())
  mainWindow.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); mainWindow.hide() }
  })

  return mainWindow
}

// ─── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  const win = createWindow()
  setupTray(win)
  setupIPC(win)

  // Renderer-driven screen recorder wiring
  recorder.setWindow(win)
  ipcMain.on('recorder:chunk',   (_, buf)   => recorder.writeChunk(buf))
  ipcMain.on('recorder:started', (_, reply) => recorder._onStarted(reply))
  ipcMain.on('recorder:stopped', ()         => recorder._onStopped())

  // Wire engine events → renderer + tray
  engine.on('task:scheduled', task => {
    win.webContents.send('engine:task-scheduled', task)
    win.webContents.send('engine:status', engine.getStatus())
  })
  engine.on('task:running', task => {
    win.webContents.send('engine:task-running', task)
    win.webContents.send('engine:status', engine.getStatus())
    setTrayState('recording', { flowName: task.flowName }, win)
  })
  engine.on('task:completed', task => {
    win.webContents.send('engine:task-completed', task)
    win.webContents.send('engine:status', engine.getStatus())
    setTrayState('idle', null, win)
  })
  engine.on('task:failed', task => {
    win.webContents.send('engine:task-failed', task)
    win.webContents.send('engine:status', engine.getStatus())
    setTrayState('error', { message: task.error }, win)
  })
  engine.on('status:update', () => {
    win.webContents.send('engine:status', engine.getStatus())
  })

  wireTelegramToEngine()
  await engine.start()
  await startBot()

  // Update check: on launch (after a short delay) + every 4 hours.
  // If a newer release exists, notify the renderer so the sidebar badge shows.
  const runUpdateCheck = async () => {
    const r = await checkForUpdate()
    if (r.ok && r.available) {
      win.webContents.send('update:available', { version: r.version, downloadUrl: r.downloadUrl, pageUrl: r.pageUrl, notes: r.notes })
    }
  }
  setTimeout(runUpdateCheck, 8000)
  setInterval(runUpdateCheck, 4 * 60 * 60 * 1000)
})

app.on('before-quit', () => { isQuitting = true; engine.stop(); stopBot() })
app.on('window-all-closed', () => {})

// ─── IPC ──────────────────────────────────────────────────────────────────────

function setupIPC(win) {
  // ── Window controls
  ipcMain.on('window:minimize', () => mainWindow?.minimize())
  ipcMain.on('window:maximize', () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize())
  ipcMain.on('window:close',    () => mainWindow?.hide())

  // ── App state
  ipcMain.handle('app:getState', () => ({
    status: engine.state,
    version: app.getVersion(),
    platform: process.platform,
    engine: engine.getStatus()
  }))

  // ── Power
  ipcMain.handle('power:prevent', () => {
    if (powerBlockerId === null) powerBlockerId = powerSaveBlocker.start('prevent-app-suspension')
    return powerBlockerId
  })
  ipcMain.handle('power:release', () => {
    if (powerBlockerId !== null && powerSaveBlocker.isStarted(powerBlockerId)) {
      powerSaveBlocker.stop(powerBlockerId); powerBlockerId = null
    }
  })

  // ── Shell
  ipcMain.handle('shell:openPath',     (_, p)   => shell.openPath(p))
  ipcMain.handle('shell:showInFolder', (_, p)   => shell.showItemInFolder(p))
  ipcMain.handle('shell:openExternal', (_, url) => {
    if (!isAllowedExternalUrl(url)) return false   // block file:/javascript:/etc.
    return shell.openExternal(url)
  })

  // ── Dialog
  ipcMain.handle('dialog:selectFolder', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select recordings folder'
    })
    return r.canceled ? null : r.filePaths[0]
  })

  // ── Storage (generic encrypt/decrypt, kept for compatibility)
  ipcMain.handle('storage:encrypt', (_, text) => encryptField(text))
  ipcMain.handle('storage:decrypt', (_, enc)  => decryptField(enc))

  // ── Tray
  ipcMain.on('tray:setState', (_, state, info) => {
    setTrayState(state, info, win)
    mainWindow?.webContents.send('state:changed', { status: state, ...info })
  })

  // ── Settings
  ipcMain.handle('settings:get', () => {
    const s = store.read('settings', {})
    // Decrypt sensitive fields before sending to renderer
    if (s.gmail?.password) s.gmail.password = decryptField(s.gmail.password)
    if (s.telegram?.botToken) s.telegram.botToken = decryptField(s.telegram.botToken)
    return s
  })

  ipcMain.handle('settings:save', async (_, settings) => {
    const toSave = JSON.parse(JSON.stringify(settings))
    if (toSave.gmail?.password) toSave.gmail.password = encryptField(toSave.gmail.password)
    if (toSave.telegram?.botToken) toSave.telegram.botToken = encryptField(toSave.telegram.botToken)
    store.write('settings', toSave)
    await engine.restart()
    await startBot()   // restart bot with potentially new token
    return true
  })

  ipcMain.handle('settings:testGmail',    (_, creds) => engine.testGmail(creds))
  ipcMain.handle('settings:testTelegram', (_, creds) => engine.testTelegram(creds))

  // Patch a single section without restarting the engine — safe for display/audio/ui prefs
  ipcMain.handle('settings:patchRecording', (_, recordingPartial) => {
    const current = store.read('settings', {})
    current.recording = { ...(current.recording || {}), ...recordingPartial }
    store.write('settings', current)
    return true
  })

  // ── Flows
  ipcMain.handle('flows:getAll', () => store.read('flows', []))

  ipcMain.handle('flows:save', (_, flow) => {
    const flows = store.read('flows', [])
    const idx = flows.findIndex(f => f.id === flow.id)
    if (idx !== -1) flows[idx] = flow
    else flows.push(flow)
    store.write('flows', flows)
    engine.restart()
    return flow
  })

  ipcMain.handle('flows:delete', (_, id) => {
    const flows = store.read('flows', []).filter(f => f.id !== id)
    store.write('flows', flows)
    engine.restart()
    return true
  })

  ipcMain.handle('flows:toggle', (_, id, enabled) => {
    const flows = store.read('flows', [])
    const idx = flows.findIndex(f => f.id === id)
    if (idx !== -1) { flows[idx] = { ...flows[idx], enabled }; store.write('flows', flows) }
    engine.restart()
    return true
  })

  // ── Tasks
  ipcMain.handle('tasks:getAll', () => store.read('tasks', []))
  ipcMain.handle('tasks:cancel', (_, id) => { scheduler.cancel(id); return true })

  // ── History
  ipcMain.handle('history:getAll', () => store.read('history', []))
  ipcMain.handle('history:clear', (_, days) => {
    const all = store.read('history', [])
    const cutoff = days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : new Date(0)
    const filtered = all.filter(h => new Date(h.startedAt) >= cutoff)
    store.write('history', filtered)
    return true
  })

  // ── Engine control
  ipcMain.handle('engine:getStatus',      () => engine.getStatus())
  ipcMain.handle('engine:restart',        () => engine.restart())
  ipcMain.handle('engine:checkNow',       () => engine.checkNow())
  ipcMain.handle('engine:stopRecording',  () => engine.stopRecording())

  // ── Manual meeting trigger
  ipcMain.handle('meeting:openAndRecord', (_, url) => engine.openAndRecord(url))

  // ── Screen sources (with thumbnails for screen picker)
  ipcMain.handle('screen:getSources', async () => {
    try {
      const sources  = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 240, height: 135 } })
      const displays = screen.getAllDisplays()
      const primary  = screen.getPrimaryDisplay()

      // Use getAllDisplays() as the source of truth — always returns every monitor.
      // Match thumbnails via source.display_id (Electron 13+); fall back by index.
      return displays.map((d, i) => {
        const src   = sources.find(s => String(s.display_id) === String(d.id)) ?? sources[i] ?? null
        const label = d.id === primary.id ? `Screen ${i + 1} — Primary` : `Screen ${i + 1}`
        // Only pass the thumbnail if it actually has pixel data
        const thumb = src?.thumbnail
        const thumbnail = (thumb && !thumb.isEmpty()) ? thumb.toDataURL() : null
        return {
          id:          `display_${d.id}`,
          name:        label,
          thumbnail,
          bounds:      d.bounds,
          scaleFactor: d.scaleFactor,
          isPrimary:   d.id === primary.id
        }
      })
    } catch { return [] }
  })

  // ── Audio device enumeration
  ipcMain.handle('audio:getDevices', () => new Promise((resolve) => {
    const out = { microphones: [], systemOutputs: [] }

    // DirectShow audio inputs (microphones)
    exec(`"${_ffmpegBin}" -f dshow -list_devices true -i dummy`, (_, stdout, stderr) => {
      let inAudio = false
      for (const line of (stdout + stderr).split('\n')) {
        if (line.includes('DirectShow audio devices')) { inAudio = true; continue }
        if (inAudio) {
          const m = line.match(/"([^"@][^"]*)"/)
          if (m) out.microphones.push(m[1])
        }
      }

      // WASAPI output devices (for loopback capture)
      exec(`"${_ffmpegBin}" -f wasapi -list_devices 1 -i ""`, (__, s2, e2) => {
        for (const line of (s2 + e2).split('\n')) {
          const m = line.match(/\]\s+"([^"]+)"/)
          if (m) out.systemOutputs.push(m[1])
        }
        if (out.systemOutputs.length === 0) out.systemOutputs.push('default')
        resolve(out)
      })
    })
  }))

  // ── Default recordings path (so renderer can show/open it)
  ipcMain.handle('recordings:getDefaultPath', () =>
    path.join(app.getPath('documents'), 'Cueflow', 'Recordings')
  )

  // ── Update controls (GitHub Releases)
  ipcMain.handle('update:check',   () => checkForUpdate())
  ipcMain.handle('update:download', (_, url) => {
    // Only ever open our own GitHub release/asset URLs
    try {
      const h = new URL(String(url)).hostname.toLowerCase()
      const ok = h === 'github.com' || h.endsWith('.github.com') || h.endsWith('.githubusercontent.com')
      if (ok) return shell.openExternal(url)
    } catch { /* fall through */ }
    return false
  })
}
