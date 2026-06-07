import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import { app, screen } from 'electron'
import { store } from '../store.js'
import { OBSWebSocket } from 'obs-websocket-js'

function obsRoot() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'bin', 'obs-studio')
  return path.join(app.getAppPath(), 'resources', 'bin', 'obs-studio')
}

const OBS_PORT      = 4455
const OBS_PASSWORD  = 'cueflow-obs-2026'

const SRC_DISPLAY   = 'CF Display'
const SRC_SYS_AUDIO = 'CF System Audio'
const SRC_MIC       = 'CF Microphone'

const sleep = ms => new Promise(r => setTimeout(r, ms))

function detectEncoders(root) {
  const dir = path.join(root, 'obs-plugins', '64bit')
  const has = dll => fs.existsSync(path.join(dir, dll))
  const encoders = []

  if (has('obs-x264.dll')) {
    encoders.push({ id: 'obs_x264',           label: 'H.264 · Software (x264)',     codec: 'h264', hw: false })
  }
  if (has('obs-ffmpeg.dll')) {
    encoders.push({ id: 'obs_ffmpeg_hevc_sw', label: 'H.265 · Software (HEVC)',     codec: 'h265', hw: false })
  }
  if (has('obs-nvenc.dll')) {
    encoders.push({ id: 'obs_nvenc_h264_tex', label: 'H.264 · NVIDIA NVENC',        codec: 'h264', hw: true  })
    encoders.push({ id: 'obs_nvenc_hevc_tex', label: 'H.265 · NVIDIA NVENC',        codec: 'h265', hw: true  })
    encoders.push({ id: 'obs_nvenc_av1_tex',  label: 'AV1  · NVIDIA NVENC',         codec: 'av1',  hw: true  })
  }
  // AMD AMF
  if (has('enc-amf.dll')) {
    encoders.push({ id: 'amd_amf_h264',       label: 'H.264 · AMD AMF',             codec: 'h264', hw: true  })
    encoders.push({ id: 'amd_amf_h265',       label: 'H.265 · AMD AMF',             codec: 'h265', hw: true  })
    encoders.push({ id: 'amd_amf_av1',        label: 'AV1  · AMD AMF',              codec: 'av1',  hw: true  })
  }
  // Intel QuickSync
  if (has('obs-qsv11.dll')) {
    encoders.push({ id: 'obs_qsv11_h264',     label: 'H.264 · Intel QuickSync',     codec: 'h264', hw: true  })
    encoders.push({ id: 'obs_qsv11_hevc',     label: 'H.265 · Intel QuickSync',     codec: 'h265', hw: true  })
    encoders.push({ id: 'obs_qsv11_av1',      label: 'AV1  · Intel QuickSync',      codec: 'av1',  hw: true  })
  }

  if (encoders.length === 0) {
    encoders.push({ id: 'obs_x264',           label: 'H.264 · Software (x264)',     codec: 'h264', hw: false })
    encoders.push({ id: 'obs_ffmpeg_hevc_sw', label: 'H.265 · Software (HEVC)',     codec: 'h265', hw: false })
  }

  return encoders
}

class Recorder {
  _proc       = null
  _obs        = null
  _connected  = false
  _filePath   = null
  _startedAt  = null
  _recording       = false
  _lastError       = null
  _currentDisplay  = null

  get isRecording()    { return this._recording }
  get startedAt()      { return this._recording ? this._startedAt : null }
  get lastError()      { return this._lastError }
  get currentDisplay() { return this._currentDisplay }

  async start(flowName, { displayOverride = null } = {}) {
    if (this._recording) throw new Error('Already recording')

    const settings  = store.read('settings', {})
    const rec       = settings.recording || {}
    const fps       = rec.fps        || 30
    const quality   = rec.quality    ?? 28
    const codec     = rec.codec      || 'h265'
    const audioMode = rec.audioMode  || 'system'
    const baseDir   = rec.saveFolder || path.join(app.getPath('documents'), 'Cueflow', 'Recordings')
    const safeName  = (flowName || 'Recording').replace(/[/\\?%*:|"<>]/g, '_')
    const dir       = rec.subfolders ? path.join(baseDir, safeName) : baseDir
    fs.mkdirSync(dir, { recursive: true })

    this._lastError = null

    try {
      await this._ensureObs()
    } catch (e) {
      this._lastError = e.message
      throw e
    }

    const obs = this._obs

    const targetDisplay = displayOverride || rec.display
    const monitorId = await this._resolveMonitorId(targetDisplay)

    // Electron bounds are logical pixels; multiply by scaleFactor for physical px
    const physPx = d => ({
      w: Math.round(d.bounds.width  * (d.scaleFactor || 1)),
      h: Math.round(d.bounds.height * (d.scaleFactor || 1))
    })

    let outW = 1920, outH = 1080
    if (rec.resolution && rec.resolution !== 'native') {
      const [w, h] = rec.resolution.split('x').map(Number)
      if (w && h) { outW = w; outH = h }
    } else if (displayOverride) {
      const p = physPx(displayOverride)
      outW = p.w; outH = p.h
    } else {
      const displays = screen.getAllDisplays()
      const selId    = rec.display?.id ? String(rec.display.id).replace(/^display_/, '') : null
      const sel      = selId
        ? (displays.find(d => String(d.id) === selId) ?? screen.getPrimaryDisplay())
        : screen.getPrimaryDisplay()
      const p = physPx(sel)
      outW = p.w; outH = p.h
    }

    await obs.call('SetVideoSettings', {
      baseWidth:    outW, baseHeight:    outH,
      outputWidth:  outW, outputHeight:  outH,
      fpsNumerator: fps,  fpsDenominator: 1
    })
    try {
      await Promise.all([
        obs.call('SetProfileParameter', { parameterCategory: 'Video', parameterName: 'BaseCX',   parameterValue: String(outW) }),
        obs.call('SetProfileParameter', { parameterCategory: 'Video', parameterName: 'BaseCY',   parameterValue: String(outH) }),
        obs.call('SetProfileParameter', { parameterCategory: 'Video', parameterName: 'OutputCX', parameterValue: String(outW) }),
        obs.call('SetProfileParameter', { parameterCategory: 'Video', parameterName: 'OutputCY', parameterValue: String(outH) }),
        obs.call('SetProfileParameter', { parameterCategory: 'Video', parameterName: 'FPSNum',   parameterValue: String(fps) }),
        obs.call('SetProfileParameter', { parameterCategory: 'Video', parameterName: 'FPSDen',   parameterValue: '1' }),
      ])
    } catch (e) {
      console.warn('[recorder] Could not persist Video profile params (non-fatal):', e.message)
    }

    await obs.call('SetProfileParameter', {
      parameterCategory: 'Output', parameterName: 'Mode', parameterValue: 'Simple'
    })
    await obs.call('SetProfileParameter', {
      parameterCategory: 'SimpleOutput', parameterName: 'FilePath', parameterValue: dir
    })
    await obs.call('SetProfileParameter', {
      parameterCategory: 'SimpleOutput', parameterName: 'RecFormat2', parameterValue: 'mp4'
    })
    await obs.call('SetProfileParameter', {
      parameterCategory: 'AdvOut', parameterName: 'RecFilePath', parameterValue: dir
    })
    await obs.call('SetProfileParameter', {
      parameterCategory: 'AdvOut', parameterName: 'RecFormat2', parameterValue: 'mp4'
    })

    const legacyMap = { h265: 'obs_ffmpeg_hevc_sw', h264: 'obs_x264' }
    const encoderId = rec.encoder || legacyMap[codec] || 'obs_ffmpeg_hevc_sw'
    await obs.call('SetProfileParameter', {
      parameterCategory: 'SimpleOutput', parameterName: 'RecEncoder', parameterValue: encoderId
    })
    try {
      await obs.call('SetProfileParameter', {
        parameterCategory: 'SimpleOutput', parameterName: 'RecQuality', parameterValue: 'HQ'
      })
    } catch (e) {
      console.warn('[recorder] Could not set RecQuality (non-fatal):', e.message)
    }
    // x265 reads CRF from x264Settings in OBS Simple mode, same as x264
    if (encoderId === 'obs_x264' || encoderId === 'obs_ffmpeg_hevc_sw') {
      try {
        await obs.call('SetProfileParameter', {
          parameterCategory: 'SimpleOutput',
          parameterName: 'x264Settings',
          parameterValue: `crf=${quality}`
        })
      } catch (e) {
        console.warn('[recorder] Could not set encoder CRF (non-fatal):', e.message)
      }
    }

    try {
      await obs.call('SetInputSettings', {
        inputName: SRC_DISPLAY,
        inputSettings: { monitor_id: monitorId, capture_mode: 'auto' }
      })
    } catch (e) {
      console.warn('[recorder] Could not set monitor_id:', e.message)
    }

    try {
      const sceneName = (await obs.call('GetCurrentProgramScene')).currentProgramSceneName
      const items     = (await obs.call('GetSceneItemList', { sceneName })).sceneItems
      const item      = items.find(i => i.sourceName === SRC_DISPLAY)
      if (item) {
        await obs.call('SetSceneItemTransform', {
          sceneName,
          sceneItemId: item.sceneItemId,
          sceneItemTransform: {
            positionX: 0, positionY: 0,
            boundsType:      'OBS_BOUNDS_SCALE_OUTER',
            boundsWidth:     outW,
            boundsHeight:    outH,
            boundsAlignment: 0
          }
        })
      }
    } catch (e) {
      console.warn('[recorder] Could not set display item transform:', e.message)
    }

    const wantSys = audioMode === 'system' || audioMode === 'both'
    const wantMic = audioMode === 'mic'    || audioMode === 'both'
    await this._setSourceMute(SRC_SYS_AUDIO, !wantSys)
    await this._setSourceMute(SRC_MIC,       !wantMic)

    if (wantSys) {
      try {
        await obs.call('SetInputSettings', {
          inputName: SRC_SYS_AUDIO,
          inputSettings: { device_id: rec.sysAudioDevice || 'default' }
        })
      } catch { /* ignore — OBS will use previous device */ }
    }

    if (wantMic && rec.micDevice) {
      try {
        await obs.call('SetInputSettings', {
          inputName: SRC_MIC,
          inputSettings: { device_id: rec.micDevice }
        })
      } catch { /* ignore — OBS will use default */ }
    }

    await obs.call('StartRecord')
    this._recording       = true
    this._startedAt       = new Date()
    this._filePath        = null
    this._currentDisplay  = targetDisplay ?? null
    console.log('[recorder] OBS recording started — output dir:', dir)
    return dir
  }

  async stop() {
    if (!this._recording) return null
    this._recording      = false
    this._currentDisplay = null
    const startedAt = this._startedAt
    this._startedAt = null

    if (!this._obs) return null

    try {
      // Register the listener BEFORE calling StopRecord — the STOPPED event can
      // arrive before the async call returns
      const stoppedPromise = new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          this._obs?.off('RecordStateChanged', handler)
          reject(new Error('Timed out waiting for OBS to finish writing'))
        }, 30000)
        const handler = (data) => {
          if (data.outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') {
            clearTimeout(t)
            this._obs?.off('RecordStateChanged', handler)
            resolve(data.outputPath)
          }
        }
        this._obs.on('RecordStateChanged', handler)
      })

      await this._obs.call('StopRecord')
      const finalPath = await stoppedPromise
      this._filePath  = finalPath

      const stat = finalPath && fs.existsSync(finalPath) ? fs.statSync(finalPath) : null
      console.log('[recorder] OBS recording stopped →', finalPath)
      return { path: finalPath, startedAt, endedAt: new Date(), bytes: stat?.size ?? 0 }
    } catch (e) {
      console.error('[recorder] OBS StopRecord failed:', e.message)
      this._lastError = e.message
      return null
    }
  }

  async switchDisplay(display) {
    if (!this._recording || !this._obs) return false
    try {
      const monitorId = await this._resolveMonitorId(display)
      await this._obs.call('SetInputSettings', {
        inputName: SRC_DISPLAY,
        inputSettings: { monitor_id: monitorId, capture_mode: 'auto' }
      })
      const { baseWidth: cw, baseHeight: ch } = await this._obs.call('GetVideoSettings')
      const sceneName = (await this._obs.call('GetCurrentProgramScene')).currentProgramSceneName
      const items = (await this._obs.call('GetSceneItemList', { sceneName })).sceneItems
      const item = items.find(i => i.sourceName === SRC_DISPLAY)
      if (item) {
        await this._obs.call('SetSceneItemTransform', {
          sceneName, sceneItemId: item.sceneItemId,
          sceneItemTransform: {
            positionX: 0, positionY: 0,
            boundsType: 'OBS_BOUNDS_SCALE_OUTER',
            boundsWidth: cw, boundsHeight: ch, boundsAlignment: 0
          }
        })
      }
      this._currentDisplay = display
      return true
    } catch (e) {
      console.warn('[recorder] switchDisplay failed:', e.message)
      return false
    }
  }

  async _ensureObs() {
    if (this._connected && this._obs) {
      try { await this._obs.call('GetVersion'); return } catch { /* reconnect */ }
      this._connected = false
    }

    const root = obsRoot()
    const exe  = path.join(root, 'bin', '64bit', 'obs64.exe')
    const cwd  = path.dirname(exe)

    if (!fs.existsSync(exe)) {
      throw new Error(`OBS not found at ${exe}. Please reinstall Cueflow.`)
    }

    if (!this._proc) {
      // clear crash sentinel so OBS doesn't show the safe mode dialog on launch
      this._clearCrashSentinel(root)

      console.log('[recorder] Launching OBS portable…')
      this._proc = spawn(exe, [
        '--portable',
        '--minimize-to-tray',
        '--disable-updater'
      ], { cwd, stdio: 'ignore', detached: false, windowsHide: true })

      this._proc.on('exit', (code) => {
        console.log('[recorder] OBS exited with code', code)
        this._proc      = null
        this._connected = false
        this._obs       = null
      })

      // auto-click "Normal launch" if the safe mode dialog still shows up
      this._autoDismissObsDialog()
    }

    const obs = new OBSWebSocket()
    this._obs = obs

    let connected = false
    for (let i = 0; i < 15 && !connected; i++) {
      await sleep(2000)
      try {
        await obs.connect(`ws://127.0.0.1:${OBS_PORT}`, OBS_PASSWORD)
        connected = true
      } catch { /* OBS still initialising — retry */ }
    }
    if (!connected) {
      this._obs = null
      throw new Error('OBS WebSocket did not respond after 30 s. OBS may have failed to start.')
    }

    obs.on('ConnectionClosed', () => {
      this._connected = false
      console.warn('[recorder] OBS WebSocket connection closed')
    })

    this._connected = true

    await this._ensureSources()
    console.log('[recorder] OBS WebSocket connected and ready')
  }

  // polls for 20s after spawn and clicks "Normal launch" if the dialog appears
  _autoDismissObsDialog() {
    const ps = `
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
  $wins = Get-Process obs64 -ErrorAction SilentlyContinue | ForEach-Object {
    $h = $_.MainWindowHandle
    if ($h -ne 0 -and $_.MainWindowTitle -ne '') { [pscustomobject]@{Handle=$h;Title=$_.MainWindowTitle} }
  }
  foreach ($w in $wins) {
    if ($w.Title -like '*Safe*' -or $w.Title -like '*OBS*') {
      Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinAPI {
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumWindowsProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int m);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr lp);
}
"@
      $clicked = $false
      [WinAPI]::EnumChildWindows($w.Handle, {
        param($child, $lp)
        $sb = New-Object System.Text.StringBuilder 256
        [WinAPI]::GetWindowText($child, $sb, 256) | Out-Null
        $t = $sb.ToString()
        if ($t -like '*Normal*' -or $t -like '*Launch*') {
          [WinAPI]::PostMessage($child, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
          $script:clicked = $true
        }
        return !$script:clicked
      }, [IntPtr]::Zero)
      if ($clicked) { exit 0 }
    }
  }
  Start-Sleep -Milliseconds 1000
}
`
    spawn('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], {
      stdio: 'ignore', windowsHide: true, detached: true
    }).unref()
  }

  _clearCrashSentinel(obsRoot) {
    // OBS creates .sentinel on start, removes it on clean exit — if it exists on next
    // launch OBS shows a safe mode dialog that blocks WebSocket from loading
    try {
      const sentinel = path.join(obsRoot, 'config', 'obs-studio', '.sentinel')
      if (fs.existsSync(sentinel)) {
        fs.rmSync(sentinel, { force: true, recursive: true })
        console.log('[recorder] OBS crash sentinel cleared')
      }
    } catch (e) {
      console.warn('[recorder] Could not clear crash sentinel:', e.message)
    }
  }

  async _ensureSources() {
    const obs = this._obs
    let sceneName
    try {
      sceneName = (await obs.call('GetSceneList')).currentProgramSceneName
    } catch { sceneName = 'Scene' }

    const ensureInput = async (name, kind, settings = {}) => {
      try { await obs.call('GetInputSettings', { inputName: name }); return }
      catch { /* doesn't exist → create */ }
      try {
        await obs.call('CreateInput', {
          sceneName, inputName: name, inputKind: kind,
          inputSettings: settings, sceneItemEnabled: true
        })
        console.log('[recorder] Created OBS source:', name)
      } catch (e) {
        console.warn('[recorder] Could not create source', name, ':', e.message)
      }
    }

    await ensureInput(SRC_DISPLAY,   'monitor_capture',       { capture_mode: 'auto' })
    await ensureInput(SRC_SYS_AUDIO, 'wasapi_output_capture', { device_id: 'default' })
    await ensureInput(SRC_MIC,       'wasapi_input_capture',  {})

    // monitoring=NONE prevents audio deduplication on devices like SteelSeries Sonar
    try {
      await this._obs.call('SetInputAudioMonitorType', {
        inputName: SRC_SYS_AUDIO, monitorType: 'OBS_MONITORING_TYPE_NONE'
      })
    } catch { /* ignore — older OBS versions */ }
  }

  async _resolveMonitorId(display) {
    try {
      const items = (await this._obs.call('GetInputPropertiesListPropertyItems', {
        inputName: SRC_DISPLAY, propertyName: 'monitor_id'
      })).propertyItems

      if (!display?.id && !display?.name) return items[0]?.itemValue ?? 0

      if (display.bounds) {
        const { x, y, width, height } = display.bounds
        // OBS names look like: "Screen 2: 1920x1080 @ 2560,199"
        const byPos  = items.find(m => m.itemName.includes(`@ ${x},${y}`))
        if (byPos) return byPos.itemValue
        const bySize = items.find(m => m.itemName.includes(`${width}x${height}`))
        if (bySize) return bySize.itemValue
      }

      return items[0]?.itemValue ?? 0
    } catch {
      return 0
    }
  }

  async _setSourceMute(name, muted) {
    try { await this._obs.call('SetInputMute', { inputName: name, inputMuted: muted }) }
    catch { /* source might not exist yet — ignore */ }
  }

  async shutdown() {
    if (this._recording) {
      try { await this.stop() } catch { /* ignore */ }
    }
    if (this._obs && this._connected) {
      try { await this._obs.call('ExitProgram') } catch { /* ignore */ }
      await sleep(1500)
    }
    if (this._obs) {
      try { this._obs.disconnect() } catch { /* ignore */ }
      this._obs = null
    }
    if (this._proc) {
      try { this._proc.kill() } catch { /* ignore */ }
      this._proc = null
    }
    this._connected = false
  }

  async warmUp() {
    try {
      console.log('[recorder] Warming up OBS…')
      await this._ensureObs()
      console.log('[recorder] OBS warm-up complete')
    } catch (e) {
      console.warn('[recorder] OBS warm-up failed (will retry on first recording):', e.message)
    }
  }

  async getCapabilities() {
    const encoders = detectEncoders(obsRoot())

    if (!this._connected || !this._obs) return { connected: false, encoders }

    try {
      const [ver, vid, mics, outs, mons] = await Promise.all([
        this._obs.call('GetVersion'),
        this._obs.call('GetVideoSettings'),
        this._obs.call('GetInputPropertiesListPropertyItems', { inputName: SRC_MIC,       propertyName: 'device_id' }),
        this._obs.call('GetInputPropertiesListPropertyItems', { inputName: SRC_SYS_AUDIO, propertyName: 'device_id' }),
        this._obs.call('GetInputPropertiesListPropertyItems', { inputName: SRC_DISPLAY,   propertyName: 'monitor_id' }),
      ])

      // OBS monitor names: "Screen 2: 1920x1080 @ 2560,199"
      const monitors = mons.propertyItems.map(i => {
        const m = i.itemName.match(/\b(\d{3,5})[xX×](\d{3,5})\b/)
        return {
          name: i.itemName,
          id:   i.itemValue,
          ...(m ? { width: parseInt(m[1]), height: parseInt(m[2]) } : {})
        }
      })

      return {
        connected:    true,
        obsVersion:   ver.obsVersion,
        wsVersion:    ver.obsWebSocketVersion,
        encoders,
        videoSettings: {
          baseWidth:    vid.baseWidth,
          baseHeight:   vid.baseHeight,
          outputWidth:  vid.outputWidth,
          outputHeight: vid.outputHeight,
          fps: vid.fpsNumerator / vid.fpsDenominator,
        },
        microphones:  mics.propertyItems.map(i => ({ name: i.itemName, id: i.itemValue })),
        audioOutputs: outs.propertyItems.map(i => ({ name: i.itemName, id: i.itemValue })),
        monitors,
      }
    } catch (e) {
      return { connected: true, encoders, error: e.message }
    }
  }
}

function findFfmpegBin() {
  if (app.isPackaged) {
    const p = path.join(process.resourcesPath, 'bin', 'ffmpeg.exe')
    if (fs.existsSync(p)) return p
  }
  const local = path.join(app.getAppPath(), 'resources', 'bin', 'ffmpeg.exe')
  if (fs.existsSync(local)) return local
  return 'ffmpeg'
}

// re-encode to x265 after recording — massively smaller files for lecture content
// falls back to x264 + mpdecimate if x265 isn't in the bundled ffmpeg
export function postCompress(inputPath, mode = 'smart') {
  return new Promise((resolve) => {
    const ffmpegBin = findFfmpegBin()
    if (!ffmpegBin || !fs.existsSync(inputPath)) { resolve(false); return }

    const preset  = mode === 'max' ? 'medium' : 'fast'
    const tmp     = inputPath.replace(/(\.[^.]+)$/, '_cftmp$1')

    const runArgs = (args, cb) => {
      const proc = spawn(ffmpegBin, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
      let errOut = ''
      proc.stderr?.on('data', d => { errOut += d.toString().slice(-500) })
      proc.on('close', code => {
        if (code !== 0) console.warn('[recorder] ffmpeg exit', code, '—', errOut.trim().split('\n').pop())
        cb(code)
      })
      proc.on('error', e => { console.warn('[recorder] ffmpeg spawn error:', e.message); cb(-1) })
    }

    const finish = (code) => {
      if (code === 0 && fs.existsSync(tmp)) {
        try { fs.unlinkSync(inputPath) } catch {}
        try { fs.renameSync(tmp, inputPath) } catch {}
        resolve(true)
      } else {
        try { fs.unlinkSync(tmp) } catch {}
        resolve(false)
      }
    }

    const x265crf = mode === 'max' ? '28' : '30'
    console.log(`[recorder] Post-compress using: ${ffmpegBin}`)
    console.log(`[recorder] Post-compress: x265 CRF ${x265crf}, ${preset} — ${inputPath}`)
    runArgs([
      '-y', '-i', inputPath,
      '-c:v', 'libx265', '-preset', preset, '-crf', x265crf,
      '-c:a', 'aac', '-b:a', '64k',
      '-movflags', '+faststart',
      tmp
    ], (code) => {
      if (code === 0 && fs.existsSync(tmp)) { finish(0); return }

      // fall back to x264 if x265 not available
      try { fs.unlinkSync(tmp) } catch {}
      console.log('[recorder] x265 unavailable — falling back to x264 + mpdecimate')
      const x264crf = mode === 'max' ? '22' : '23'
      runArgs([
        '-y', '-i', inputPath,
        '-vf', 'mpdecimate', '-vsync', 'vfr',
        '-c:v', 'libx264', '-preset', preset, '-crf', x264crf,
        '-c:a', 'aac', '-b:a', '64k',
        '-movflags', '+faststart',
        tmp
      ], finish)
    })
  })
}

export function compressForTelegram(inputPath, durationSeconds, targetBytes = 48 * 1024 * 1024) {
  return new Promise((resolve) => {
    if (!fs.existsSync(inputPath)) { resolve(null); return }
    const ffmpegBin = findFfmpegBin()
    if (!ffmpegBin) { resolve(null); return }

    const dur      = durationSeconds && durationSeconds > 0 ? durationSeconds : 60
    const audioBps = 128 * 1000
    let   videoBps = Math.floor((targetBytes * 8) / dur) - audioBps
    if (videoBps < 150 * 1000) videoBps = 150 * 1000
    const outPath  = inputPath.replace(/\.(mp4|mkv|webm)$/i, '_tg.mp4')
    const args = [
      '-y', '-i', inputPath,
      '-c:v', 'libx264', '-preset', 'fast',
      '-b:v', String(videoBps),
      '-maxrate', String(Math.floor(videoBps * 1.45)),
      '-bufsize', String(videoBps * 2),
      '-vf', 'scale=-2:720',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      outPath
    ]
    const proc = spawn(ffmpegBin, args, { windowsHide: true, stdio: 'ignore' })
    proc.on('close', (code) => resolve(code === 0 && fs.existsSync(outPath) ? outPath : null))
    proc.on('error', () => resolve(null))
  })
}

export const recorder = new Recorder()
