import { shell, screen } from 'electron'
import { exec } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { store } from '../store.js'
import { scheduler } from './scheduler.js'
import { recorder, postCompress } from './recorder.js'
import { isAllowedExternalUrl } from '../security.js'

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
      // Open meeting URL — convert Zoom https links to zoommtg:// so Zoom opens
      // directly. Validate the scheme first: the URL came from a parsed email, so
      // never hand a file:/javascript:/etc. link to the OS.
      const openUrl = toDirectUrl(task.meetingUrl)
      if (!isAllowedExternalUrl(openUrl)) {
        throw new Error(`Refusing to open unsafe meeting URL: ${task.meetingUrl}`)
      }
      await shell.openExternal(openUrl)
      console.log('[runner] Opened:', task.meetingUrl)

      // Wait for meeting app to load
      const flow = store.read('flows', []).find(f => f.id === task.flowId)
      const recSettings = (store.read('settings', {})).recording || {}
      const waitSecs = recSettings.waitBeforeRecord ?? 5
      await delay(waitSecs * 1000)

      const autoFullscreen = recSettings.autoFullscreen !== false

      // Maximize the meeting window before recording starts.
      if (autoFullscreen && task.meetingUrl) {
        maximizeMeetingWindow(task.meetingUrl)
        await delay(800)   // let the maximize animation settle
      }

      // Start recording on the screen the user configured in Settings.
      let recordingPath = null
      try {
        recordingPath = await recorder.start(task.flowName || 'Recording')
        console.log('[runner] Recording started:', recordingPath)
        this._emitter?.emit('status:update')   // push fresh isRecording=true to UI
        this._emitter?.emit('recording:started', {
          task,
          display:     recorder.currentDisplay,
          allDisplays: screen.getAllDisplays()
        })
      } catch (e) {
        console.error('[runner] Failed to start recorder:', e.message)
        this._emitter?.emit('recording:error', { task, error: e.message })
        this._emitter?.emit('status:update')   // push fresh isRecording=false to UI
      }

      // Retry maximizes for windows that are slow to settle (e.g. Zoom joins late)
      if (autoFullscreen) {
        ;[4000, 8000].forEach(ms => setTimeout(() => maximizeMeetingWindow(task.meetingUrl), ms))
      }

      // Wait for meeting to end (respects stop() in all modes)
      await this._waitForEnd(task, flow)

      // Stop recording
      let result = null
      if (recorder.isRecording) {
        result = await recorder.stop()
        if (result) {
          console.log('[runner] Recording saved:', result.path, Math.round(result.bytes / 1024 / 1024) + 'MB')
          this._saveHistory(task, result)

          // Post-recording FFmpeg re-encode — same codec, slower preset → much smaller file.
          // Runs in background; replaces the OBS file in-place. Default: on.
          const recSettings = (store.read('settings', {})).recording || {}
          if (recSettings.postCompress !== false && result.path) {
            const mode = recSettings.postCompressMode || 'smart'
            const originalBytes = result.bytes
            this._emitter?.emit('recording:compressing', { task, result, mode })
            postCompress(result.path, mode).then(ok => {
              let finalBytes = originalBytes
              if (ok) {
                try { finalBytes = fs.statSync(result.path).size } catch {}
                this._updateHistorySize(task.id, finalBytes)
              }
              this._emitter?.emit('recording:compressed', { task, ok, originalBytes, finalBytes })
            }).catch(() => {
              this._emitter?.emit('recording:compressed', { task, ok: false, originalBytes, finalBytes: originalBytes })
            })
          }
        }
      }

      // Auto-close the meeting app if the user enabled it in General settings
      if ((store.read('settings', {})).general?.closeAppAfterRecord) {
        closeMeetingApp(task.meetingUrl)
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

  // Close the meeting app for a given URL (e.g. quit Zoom after recording).
  closeApp(url) { return closeMeetingApp(url) }

  // Re-run the maximize script on demand (e.g. called from Telegram button).
  maximizeWindow(url) { if (url) maximizeMeetingWindow(url) }

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

  _updateHistorySize(taskId, newBytes) {
    const history = store.read('history', [])
    const idx = history.findIndex(h => h.taskId === taskId)
    if (idx >= 0) {
      history[idx] = { ...history[idx], fileSizeBytes: newBytes, compressed: true }
      store.write('history', history)
    }
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

// Close the meeting application (quit Zoom/Teams). Never kills the browser for
// Google Meet — that would close all the user's tabs.
function closeMeetingApp(url) {
  const name = detectProcess(url)
  if (name === 'chrome') {
    console.log('[runner] Skipping app close for browser-based meeting')
    return false
  }
  exec(`taskkill /IM ${name}.exe /F /T`, (err) => {
    if (err) console.warn(`[runner] could not close ${name}:`, err.message)
    else console.log(`[runner] Closed ${name}`)
  })
  return true
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

// The maximize logic needs literal double quotes (DllImport("user32.dll")) which
// don't survive cmd.exe's quoting when passed inline. Write it to a temp .ps1 and
// run with -File instead — no escaping headaches, supports here-strings.
const MAXIMIZE_PS1 = path.join(os.tmpdir(), 'cueflow-maximize-v3.ps1')
let _ps1Written = false

function ensureMaximizeScript() {
  if (_ps1Written) return
  // Strategy 1: search ALL processes for one whose MainWindowTitle contains the hint.
  //   This finds "Zoom Meeting" regardless of which exe name it runs under.
  // Strategy 2: fallback to any main window of the named process.
  const script = `param([string]$Name, [string]$Hint)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinMax {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@
$lhint = $Hint.ToLower()
$target = [IntPtr]::Zero

if ($lhint) {
  $m = Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle.ToLower().Contains($lhint) } |
    Select-Object -First 1
  if ($m) { $target = $m.MainWindowHandle }
}
if ($target -eq [IntPtr]::Zero -and $Name) {
  $m = Get-Process $Name -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($m) { $target = $m.MainWindowHandle }
}
if ($target -ne [IntPtr]::Zero) {
  [WinMax]::ShowWindow($target, 3) | Out-Null
  [WinMax]::SetForegroundWindow($target) | Out-Null
}
`
  try { fs.writeFileSync(MAXIMIZE_PS1, script, 'utf8'); _ps1Written = true }
  catch (e) { console.warn('[runner] could not write maximize script:', e.message) }
}

// Per-platform process + window-title hint for the meeting window
function meetingTarget(url) {
  if (/zoom\.us|zoommtg/i.test(url)) return { proc: 'Zoom',     hint: 'Meeting' }
  if (/teams\.microsoft/i.test(url)) return { proc: 'ms-teams', hint: 'Meeting' }
  if (/meet\.google/i.test(url))     return { proc: 'chrome',   hint: 'Meet' }
  return { proc: 'Zoom', hint: 'Meeting' }
}

function maximizeMeetingWindow(url) {
  ensureMaximizeScript()
  if (!_ps1Written) return
  const { proc, hint } = meetingTarget(url)
  exec(
    `powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${MAXIMIZE_PS1}" "${proc}" "${hint}"`,
    (err) => { if (err) console.warn('[runner] maximize failed:', err.message) }
  )
}

export const runner = new Runner()
