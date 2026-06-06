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
const MAXIMIZE_PS1 = path.join(os.tmpdir(), 'cueflow-maximize-v5.ps1')
let _ps1Written = false

function ensureMaximizeScript() {
  if (_ps1Written) return
  // Enumerates ALL top-level windows via EnumWindows (not just MainWindowHandle),
  // filters to those owned by any process whose name starts with the app name,
  // then picks the window whose title contains the hint — or the largest window
  // as fallback (the meeting window is always the biggest Zoom window).
  // NOTE: $candidates is collected via pipeline OUTPUT, not $candidates += inside
  // ForEach-Object. += inside a pipeline scriptblock only modifies a local copy;
  // the outer variable is never updated (PowerShell child-scope rule).
  const script = `param([string]$Name, [string]$Hint)
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class WinFind {
  public delegate bool EnumWinCb(IntPtr h, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWinCb cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern int  GetWindowText(IntPtr h, StringBuilder s, int m);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int L, T, R, B; }
  public static List<IntPtr> AllWindows() {
    var list = new List<IntPtr>();
    EnumWindows((h, lp) => { list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
}
"@
$lhint = $Hint.ToLower()
$lname = $Name.ToLower()

$appPids = New-Object System.Collections.Generic.HashSet[uint32]
Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessName.ToLower().StartsWith($lname) } |
  ForEach-Object { [void]$appPids.Add([uint32]$_.Id) }

if ($appPids.Count -eq 0) { exit }

# Each matching window is EMITTED by the scriptblock and collected by the pipeline.
# This is the correct pattern — $var += inside ForEach-Object only modifies a
# local copy and the outer array stays empty.
$candidates = @([WinFind]::AllWindows() | ForEach-Object {
  $h = $_
  if (-not [WinFind]::IsWindowVisible($h)) { return }
  $wpid = [uint32]0
  [void][WinFind]::GetWindowThreadProcessId($h, [ref]$wpid)
  if (-not $appPids.Contains($wpid)) { return }
  $sb = New-Object System.Text.StringBuilder 512
  [void][WinFind]::GetWindowText($h, $sb, 512)
  $title = $sb.ToString()
  if ($title.Length -eq 0) { return }
  $r = New-Object WinFind+RECT
  [void][WinFind]::GetWindowRect($h, [ref]$r)
  $area = [long]($r.R - $r.L) * ($r.B - $r.T)
  [pscustomobject]@{ Handle=$h; Title=$title; Area=$area }
})

if ($candidates.Count -eq 0) { exit }

$found = $candidates |
  Where-Object { $_.Title.ToLower().Contains($lhint) } |
  Sort-Object Area -Descending | Select-Object -First 1
if (-not $found) {
  $found = $candidates | Sort-Object Area -Descending | Select-Object -First 1
}

[WinFind]::ShowWindow($found.Handle, 3) | Out-Null
[WinFind]::SetForegroundWindow($found.Handle) | Out-Null
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
