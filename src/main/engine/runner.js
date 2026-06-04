import { shell } from 'electron'
import { exec } from 'child_process'
import { store } from '../store.js'
import { scheduler } from './scheduler.js'
import { recorder } from './recorder.js'

class Runner {
  _activeTaskId = null
  _stopResolve  = null
  _emitter      = null
  _stopped      = false   // set by stop() — all polling loops check this

  setEmitter(em) { this._emitter = em }

  async run(task) {
    if (this._activeTaskId) {
      console.warn('[runner] Already running, skipping', task.id)
      return
    }

    this._activeTaskId = task.id
    this._stopped      = false
    scheduler.updateStatus(task.id, 'running', { startedAt: new Date().toISOString() })
    this._emitter?.emit('task:running', task)

    try {
      // Open meeting URL — convert Zoom https links to zoommtg:// so Zoom opens directly
      await shell.openExternal(toDirectUrl(task.meetingUrl))
      console.log('[runner] Opened:', task.meetingUrl)

      // Wait for meeting app to load
      const flow = store.read('flows', []).find(f => f.id === task.flowId)
      const waitSecs = (store.read('settings', {})).recording?.waitBeforeRecord ?? 5
      await delay(waitSecs * 1000)

      // Start recording
      let recordingPath = null
      try {
        recordingPath = await recorder.start(task.flowName || 'Recording')
        console.log('[runner] Recording started:', recordingPath)
      } catch (e) {
        console.error('[runner] Failed to start recorder:', e.message)
        this._emitter?.emit('recording:error', { task, error: e.message })
      }

      // Auto-fullscreen if enabled
      const autoFullscreen = (store.read('settings', {})).recording?.autoFullscreen !== false
      if (autoFullscreen) setTimeout(() => maximizeMeetingWindow(task.meetingUrl), 3000)

      // Wait for meeting to end (respects stop() in all modes)
      await this._waitForEnd(task, flow)

      // Stop recording
      let result = null
      if (recorder.isRecording) {
        result = await recorder.stop()
        if (result) {
          console.log('[runner] Recording saved:', result.path, Math.round(result.bytes / 1024 / 1024) + 'MB')
          this._saveHistory(task, result)
        }
      }

      scheduler.updateStatus(task.id, 'completed', { endedAt: new Date().toISOString() })
      this._emitter?.emit('task:completed', { ...task, result })
    } catch (err) {
      console.error('[runner] Error:', err.message)
      if (recorder.isRecording) await recorder.stop().catch(() => {})
      scheduler.updateStatus(task.id, 'failed', { error: err.message })
      this._emitter?.emit('task:failed', { ...task, error: err.message })
    } finally {
      this._activeTaskId = null
      this._stopResolve  = null
      this._stopped      = false
    }
  }

  async stop() {
    this._stopped = true   // polling loops check this and exit on their next tick
    this._stopResolve?.()  // manual-mode wait resolves immediately
    // Do NOT call recorder.stop() here — run() calls it after _waitForEnd exits
    // so the result is captured and _saveHistory is called correctly.
  }

  async _waitForEnd(task, flow) {
    const stopMode  = flow?.schedule?.stopMode ?? 'window-close'
    const shouldStop = () => this._stopped

    if (stopMode === 'window-close') {
      const processName = detectProcess(task.meetingUrl)
      console.log(`[runner] Waiting for ${processName}…`)
      await waitForProcess(processName, 60000, shouldStop)
      await waitForProcessClose(processName, shouldStop)
    } else if (stopMode === 'ics-end' && task.stopAt) {
      const ms = new Date(task.stopAt) - Date.now()
      if (ms > 0) await cancellableDelay(ms, shouldStop)
      else await waitForProcessClose(detectProcess(task.meetingUrl), shouldStop)
    } else {
      // manual — wait until stop() is called
      await new Promise(res => { this._stopResolve = res })
    }
  }

  _saveHistory(task, result) {
    const entry = {
      id: crypto.randomUUID(),
      flowId:    task.flowId,
      flowName:  task.flowName,
      taskId:    task.id,
      recordingPath: result.path,
      startedAt: result.startedAt.toISOString(),
      endedAt:   result.endedAt.toISOString(),
      durationSeconds: Math.round((result.endedAt - result.startedAt) / 1000),
      fileSizeBytes:   result.bytes,
      status: 'completed'
    }
    const history = store.read('history', [])
    history.unshift(entry)
    store.write('history', history.slice(0, 500))
  }

  get isRunning()    { return this._activeTaskId !== null }
  get activeTaskId() { return this._activeTaskId }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toDirectUrl(url) {
  if (!url || !url.startsWith('https://')) return url
  try {
    const u = new URL(url)
    if (!u.hostname.endsWith('zoom.us')) return url
    const m = u.pathname.match(/^\/[jwsy]\/(\d+)/)
    if (!m) return url
    const confno = m[1]
    const pwd    = u.searchParams.get('pwd') || ''
    const tk     = u.searchParams.get('tk')  || ''
    let direct   = `zoommtg://${u.hostname}/join?action=join&confno=${confno}`
    if (pwd) direct += `&pwd=${encodeURIComponent(pwd)}`
    if (tk)  direct += `&tk=${encodeURIComponent(tk)}`
    return direct
  } catch {
    return url
  }
}

function detectProcess(url) {
  if (/zoom\.us|zoommtg/i.test(url)) return 'Zoom'
  if (/teams\.microsoft/i.test(url))  return 'ms-teams'
  if (/meet\.google/i.test(url))      return 'chrome'
  return 'Zoom'
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)) }

// Delay that exits early when shouldStop() returns true
function cancellableDelay(ms, shouldStop) {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms)
    const check = setInterval(() => {
      if (shouldStop()) { clearTimeout(t); clearInterval(check); resolve() }
    }, 1000)
    setTimeout(() => clearInterval(check), ms + 100)
  })
}

function isProcessRunning(name) {
  return new Promise(resolve => {
    exec(`tasklist /FI "IMAGENAME eq ${name}.exe" /FO CSV /NH`, (err, stdout) => {
      resolve(!err && stdout.toLowerCase().includes(name.toLowerCase()))
    })
  })
}

// Polls until process is running OR shouldStop() OR timeout
function waitForProcess(name, timeout = 30000, shouldStop = () => false) {
  return new Promise(resolve => {
    const start = Date.now()
    const poll = () => {
      if (shouldStop()) { resolve(); return }
      isProcessRunning(name).then(running => {
        if (running || Date.now() - start > timeout || shouldStop()) { resolve(); return }
        setTimeout(poll, 2000)
      })
    }
    poll()
  })
}

// Polls until process is gone OR shouldStop()
function waitForProcessClose(name, shouldStop = () => false) {
  return new Promise(resolve => {
    const poll = () => {
      if (shouldStop()) { resolve(); return }
      isProcessRunning(name).then(running => {
        if (!running || shouldStop()) { resolve(); return }
        setTimeout(poll, 3000)
      })
    }
    setTimeout(poll, 5000)
  })
}

function maximizeMeetingWindow(url) {
  const name = detectProcess(url)
  const ps = `
    $proc = Get-Process '${name}' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($proc) {
      Add-Type -Name Win32 -Namespace _ -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);'
      [_+Win32]::ShowWindow($proc.MainWindowHandle, 3)
    }
  `
  exec(`powershell -NoProfile -Command "${ps.replace(/\n/g, ' ')}"`)
}

export const runner = new Runner()
