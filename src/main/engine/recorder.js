import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import { app, desktopCapturer, screen } from 'electron'
import { store } from '../store.js'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const ffmpegBin = require('ffmpeg-static')

// Recording is done in the renderer via Chromium's desktop capture
// (getUserMedia chromeMediaSource:'desktop'), which grabs the *composited*
// screen — including hardware-accelerated video like Zoom — plus system audio.
// gdigrab/ffmpeg can't do either reliably on Windows.
//
// This class is the main-process coordinator: it picks the source, tells the
// renderer to start/stop, streams the chunks to disk, and (if needed) remuxes
// the result to MP4.

class Recorder {
  _win        = null
  _filePath   = null     // final file (.mp4 or .webm)
  _writeStream = null
  _startedAt  = null
  _recording  = false
  _container  = 'mp4'
  _mode       = 'chromium'  // 'chromium' | 'gdigrab'
  _gdiProc    = null
  _startAck   = null     // resolver for the renderer's "started" reply
  _stopAck    = null     // resolver for the renderer's "stopped" reply

  setWindow(win) { this._win = win }
  get isRecording() { return this._recording }
  get startedAt()   { return this._recording ? this._startedAt : null }

  async start(flowName) {
    if (this._recording) throw new Error('Already recording')
    if (!this._win) throw new Error('No window to record from')

    const rec        = (store.read('settings', {})).recording || {}
    const fps        = rec.fps || 30
    const audioMode  = rec.audioMode || 'system'
    const wantAudio  = audioMode !== 'none'
    const baseDir    = rec.saveFolder || path.join(app.getPath('documents'), 'Cueflow', 'Recordings')
    const safeName   = (flowName || 'Recording').replace(/[/\\?%*:|"<>]/g, '_')
    const dir        = rec.subfolders ? path.join(baseDir, safeName) : baseDir
    fs.mkdirSync(dir, { recursive: true })

    // Resolution cap (renderer scales the capture). 'native' = no cap.
    let maxWidth = 0, maxHeight = 0
    if (rec.resolution && rec.resolution !== 'native') {
      const [w, h] = rec.resolution.split('x').map(Number)
      if (w && h) { maxWidth = w; maxHeight = h }
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })

    // If a specific screen is chosen but Chromium can't capture it (e.g. it's an
    // HDR/10-bit monitor), fall back to gdigrab on that screen's region so the
    // CORRECT screen still records (video only — no system audio on that path).
    if (rec.display && !isCapturable(sources, rec.display)) {
      console.warn(`[recorder] "${rec.display.name}" not Chromium-capturable (HDR?) — using gdigrab (video only)`)
      return this._startGdigrab(rec, dir, safeName, ts)
    }

    const sourceId = pickSourceId(sources, rec.display)
    if (!sourceId) throw new Error('No screen source available')
    this._startedAt = new Date()

    // Ask the renderer to start; it replies with which container it used.
    const ack = await this._request('recorder:start', {
      sourceId, fps, audio: wantAudio, maxWidth, maxHeight,
      bitrate: bitrateFor(maxWidth, maxHeight, rec.quality)
    }, 15000)

    if (!ack?.ok) throw new Error(ack?.error || 'Renderer could not start capture')

    this._mode      = 'chromium'
    this._container = ack.container === 'webm' ? 'webm' : 'mp4'
    this._filePath  = path.join(dir, `${safeName}_${ts}.${this._container}`)
    this._writeStream = fs.createWriteStream(this._filePath)
    this._recording = true
    console.log('[recorder] Recording (chromium) →', this._filePath)
    return this._filePath
  }

  // gdigrab fallback — captures a screen region directly with ffmpeg. Works on
  // any monitor (including HDR), but cannot capture system audio.
  _startGdigrab(rec, dir, safeName, ts) {
    return new Promise((resolve, reject) => {
      const fps = rec.fps || 30
      const b   = rec.display.bounds
      const crf = rec.quality ?? 23
      this._filePath = path.join(dir, `${safeName}_${ts}.mp4`)
      const scale = (rec.resolution && rec.resolution !== 'native')
        ? ['-vf', `scale=${rec.resolution.replace('x', ':')}:flags=lanczos`] : []

      const args = [
        '-y', '-f', 'gdigrab', '-framerate', String(fps),
        '-offset_x', String(b.x), '-offset_y', String(b.y),
        '-video_size', `${b.width}x${b.height}`,
        '-draw_mouse', '1', '-i', 'desktop',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p',
        ...scale, '-an', '-movflags', '+faststart', this._filePath
      ]
      const proc = spawn(ffmpegBin, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
      this._gdiProc = proc
      this._mode = 'gdigrab'

      let resolved = false
      const onData = (chunk) => {
        if (chunk.toString().includes('frame=')) {
          proc.stderr.removeListener('data', onData)
          if (!resolved) { resolved = true; this._recording = true; this._startedAt = new Date()
            console.log('[recorder] Recording (gdigrab) →', this._filePath); resolve(this._filePath) }
        }
      }
      proc.stderr.on('data', onData)
      proc.on('error', (e) => { if (!resolved) { resolved = true; reject(e) } })
      proc.on('close', () => { if (!resolved) { resolved = true; reject(new Error('gdigrab failed to start')) } })
      setTimeout(() => { if (!resolved) { resolved = true; try { proc.kill() } catch {}; reject(new Error('gdigrab timeout')) } }, 12000)
    })
  }

  // Called from main IPC as chunks arrive from the renderer.
  writeChunk(buf) {
    if (this._writeStream && buf) {
      try { this._writeStream.write(Buffer.from(buf)) } catch { /* ignore */ }
    }
  }

  // Renderer acks
  _onStarted(reply) { this._startAck?.(reply); this._startAck = null }
  _onStopped()      { this._stopAck?.();       this._stopAck = null }

  async stop() {
    if (!this._recording) return null
    this._recording = false
    const filePath  = this._filePath
    const startedAt = this._startedAt
    this._filePath = null

    if (this._mode === 'gdigrab') {
      // Gracefully quit ffmpeg
      const proc = this._gdiProc; this._gdiProc = null
      await new Promise(res => {
        if (!proc) return res()
        proc.on('close', res)
        try { proc.stdin.write('q'); proc.stdin.end() } catch { try { proc.kill() } catch {} }
        setTimeout(() => { try { proc.kill() } catch {} }, 4000)
      })
    } else {
      // Chromium: tell the renderer to stop, flush the streamed file
      this._win?.webContents.send('recorder:stop')
      await new Promise(res => { this._stopAck = res; setTimeout(res, 8000) })
      await new Promise(res => this._writeStream ? this._writeStream.end(res) : res())
      this._writeStream = null
    }

    if (!filePath || !fs.existsSync(filePath)) return null

    // webm (Chromium fallback container) → mp4
    let finalPath = filePath
    if (filePath.endsWith('.webm')) {
      try { finalPath = await convertToMp4(filePath) }
      catch (e) { console.error('[recorder] webm→mp4 failed:', e.message) }
    }

    const stat = fs.existsSync(finalPath) ? fs.statSync(finalPath) : null
    return { path: finalPath, startedAt, endedAt: new Date(), bytes: stat?.size ?? 0 }
  }

  // Send a request to the renderer and await its reply (the next _onStarted).
  _request(channel, payload, timeoutMs) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this._startAck = null; resolve({ ok: false, error: 'timeout' }) }, timeoutMs)
      this._startAck = (r) => { clearTimeout(t); resolve(r) }
      this._win?.webContents.send(channel, payload)
    })
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// Can Chromium's desktop capture grab the chosen display? (HDR/10-bit monitors
// are absent from the source list.)
function isCapturable(sources, display) {
  if (!display?.id) return true
  const rawId = String(display.id).replace(/^display_/, '')
  return sources.some(s => String(s.display_id) === rawId)
}

function pickSourceId(sources, display) {
  if (!sources || sources.length === 0) return null
  if (display?.id) {
    const rawId = String(display.id).replace(/^display_/, '')
    const m = sources.find(s => String(s.display_id) === rawId)
    if (m) return m.id
  }
  const primary = screen.getPrimaryDisplay()
  const pm = sources.find(s => String(s.display_id) === String(primary.id))
  return (pm || sources[0]).id
}

// Target video bitrate (bps) for the MediaRecorder, by resolution + quality.
function bitrateFor(w, h, quality) {
  const pixels = (w && h) ? w * h : 2560 * 1440   // native ≈ assume 1440p
  // ~0.1 bits per pixel per frame at 30fps baseline, tuned by CRF-ish quality
  let bpp = 4   // Mbps per megapixel, roughly
  const q = Number(quality)
  if (!isNaN(q)) bpp = q <= 20 ? 6 : q >= 28 ? 2.5 : 4
  return Math.round((pixels / 1_000_000) * bpp * 1_000_000)
}

function convertToMp4(webmPath) {
  const mp4Path = webmPath.replace(/\.webm$/i, '.mp4')
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin, [
      '-y', '-i', webmPath,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k',
      mp4Path
    ], { windowsHide: true, stdio: 'ignore' })
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(mp4Path)) {
        try { fs.unlinkSync(webmPath) } catch { /* ignore */ }
        resolve(mp4Path)
      } else reject(new Error(`ffmpeg exited ${code}`))
    })
    proc.on('error', reject)
  })
}

// Reused by Telegram compression (unchanged behaviour)
export function compressForTelegram(inputPath, durationSeconds, targetBytes = 48 * 1024 * 1024) {
  return new Promise((resolve) => {
    if (!fs.existsSync(inputPath)) { resolve(null); return }
    const dur = durationSeconds && durationSeconds > 0 ? durationSeconds : 60
    const audioBps = 128 * 1000
    let videoBps = Math.floor((targetBytes * 8) / dur) - audioBps
    if (videoBps < 150 * 1000) videoBps = 150 * 1000
    const outPath = inputPath.replace(/\.(mp4|mkv|webm)$/i, '_tg.mp4')
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
