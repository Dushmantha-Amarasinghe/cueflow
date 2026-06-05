import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import { app } from 'electron'
import { store } from '../store.js'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const ffmpegBin = require('ffmpeg-static')

class Recorder {
  _proc    = null
  _mkvPath = null
  _startedAt = null

  get isRecording() { return this._proc !== null }

  async start(flowName) {
    if (this._proc) throw new Error('Already recording')

    const rec = (store.read('settings', {})).recording || {}
    const fps        = rec.fps || 30
    const scaleRes   = rec.resolution && rec.resolution !== 'native' ? rec.resolution : null
    const codec      = rec.codec === 'h265' ? 'libx265' : 'libx264'
    const crf        = rec.quality ?? 23
    const audioMode  = rec.audioMode  || 'system'   // 'system' | 'mic' | 'both' | 'none'
    const audioDevice = rec.audioDevice || null      // specific device name, null = default
    const display    = rec.display || null           // { bounds:{x,y,width,height}, scaleFactor }
    const baseDir    = rec.saveFolder || path.join(app.getPath('documents'), 'Cueflow', 'Recordings')
    const dir        = rec.subfolders
      ? path.join(baseDir, flowName.replace(/[/\\?%*:|"<>]/g, '_'))
      : baseDir

    fs.mkdirSync(dir, { recursive: true })

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    this._mkvPath = path.join(dir, `${flowName.replace(/[/\\?%*:|"<>]/g, '_')}_${ts}.mkv`)
    this._startedAt = new Date()

    const wantAudio = audioMode !== 'none'
    let success = false
    if (wantAudio) {
      success = await this._spawn(fps, scaleRes, codec, crf, audioMode, audioDevice, display)
      if (!success) {
        console.warn('[recorder] Audio capture failed, falling back to video-only')
        success = await this._spawn(fps, scaleRes, codec, crf, 'none', null, display)
      }
    } else {
      success = await this._spawn(fps, scaleRes, codec, crf, 'none', null, display)
    }
    if (!success) throw new Error('Failed to start screen capture. Check your resolution setting.')

    console.log('[recorder] Recording:', this._mkvPath)
    return this._mkvPath
  }

  _spawn(fps, scaleRes, codec, crf, audioMode, audioDevice, display) {
    return new Promise((resolve) => {
      // ── Video input: capture specific display or full virtual desktop ──────────
      const captureArgs = ['-f', 'gdigrab', '-framerate', String(fps)]
      if (display?.bounds) {
        const { x, y, width, height } = display.bounds
        // Use logical pixel coords — gdigrab on Windows works in logical (DPI-aware) space
        captureArgs.push('-offset_x', String(x), '-offset_y', String(y))
        captureArgs.push('-video_size', `${width}x${height}`)
      }
      captureArgs.push('-draw_mouse', '1', '-i', 'desktop')

      // ── Audio input ────────────────────────────────────────────────────────────
      const audioArgs = []
      const hasAudio = audioMode !== 'none'
      if (audioMode === 'system' || audioMode === 'both') {
        const dev = audioDevice || 'default'
        audioArgs.push('-f', 'wasapi', '-loopback', '-i', dev)
      }
      if (audioMode === 'mic' || audioMode === 'both') {
        const dev = audioDevice || 'Microphone'
        audioArgs.push('-f', 'dshow', '-i', `audio=${dev}`)
      }

      // ── Video filter: scale to target resolution (never crops) ────────────────
      // We always capture at native/display resolution, then scale down if needed.
      const vfArgs = scaleRes ? ['-vf', `scale=${scaleRes.replace('x', ':')}:flags=lanczos`] : []

      // ── Audio filter: mix if 'both' ────────────────────────────────────────────
      const afArgs = audioMode === 'both' ? ['-filter_complex', 'amix=inputs=2:duration=first'] : []

      const args = [
        ...captureArgs,
        ...audioArgs,
        '-c:v', codec, '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p',
        ...vfArgs,
        ...(hasAudio ? ['-c:a', 'aac', '-b:a', '192k', ...afArgs] : ['-an']),
        '-f', 'matroska', this._mkvPath
      ]

      const proc = spawn(ffmpegBin, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })

      let resolved = false
      const done = (val) => { if (!resolved) { resolved = true; resolve(val) } }

      // ffmpeg prints "frame= " once encoding begins — that's our start signal
      const onData = (chunk) => {
        if (chunk.toString().includes('frame=')) {
          proc.stderr.removeListener('data', onData)
          this._proc = proc
          done(true)
        }
      }
      proc.stderr.on('data', onData)

      proc.on('error', () => done(false))
      proc.on('close', (code) => {
        if (!resolved) done(false)
        else if (code !== 0) console.warn('[recorder] ffmpeg exited with code', code)
      })

      // 12s timeout — if no frame seen, assume failure
      setTimeout(() => { if (!resolved) { proc.kill(); done(false) } }, 12000)
    })
  }

  async stop() {
    if (!this._proc || !this._mkvPath) return null

    const mkvPath   = this._mkvPath
    const startedAt = this._startedAt
    this._mkvPath   = null
    this._startedAt = null

    await new Promise((resolve) => {
      this._proc.on('close', resolve)
      // Send 'q' + end the pipe so ffmpeg flushes and exits gracefully
      try {
        this._proc.stdin.write('q')
        this._proc.stdin.end()
      } catch {
        this._proc.kill()
      }
      // Force-kill after 4s if it hasn't exited yet
      setTimeout(() => { try { this._proc?.kill() } catch { /* ignore */ } }, 4000)
    })
    this._proc = null

    if (!fs.existsSync(mkvPath)) return null

    let finalPath = mkvPath
    try {
      finalPath = await remux(mkvPath)
    } catch (e) {
      console.error('[recorder] Remux failed:', e.message)
    }

    const stat = fs.existsSync(finalPath) ? fs.statSync(finalPath) : null
    return { path: finalPath, startedAt, endedAt: new Date(), bytes: stat?.size ?? 0 }
  }
}

function remux(mkvPath) {
  const mp4Path = mkvPath.replace(/\.mkv$/, '.mp4')
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin, [
      '-i', mkvPath,
      '-c', 'copy',
      // No +faststart — it forces a full file rewrite which is slow for local files
      mp4Path
    ], { windowsHide: true, stdio: 'pipe' })

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(mp4Path)) {
        try { fs.unlinkSync(mkvPath) } catch { /* ignore */ }
        resolve(mp4Path)
      } else {
        reject(new Error(`ffmpeg remux exited ${code}`))
      }
    })
    proc.on('error', reject)
  })
}

// Compress a recording to fit under a target size (default ~48 MB for Telegram).
// Computes a bitrate from the duration so the result reliably lands under the cap,
// and downscales to 720p. Returns the path to a temp _tg.mp4 file, or null on failure.
export function compressForTelegram(inputPath, durationSeconds, targetBytes = 48 * 1024 * 1024) {
  return new Promise((resolve) => {
    if (!fs.existsSync(inputPath)) { resolve(null); return }
    const dur = durationSeconds && durationSeconds > 0 ? durationSeconds : 60

    // total budget (bits) → subtract audio → video bitrate
    const audioBps = 128 * 1000
    let videoBps = Math.floor((targetBytes * 8) / dur) - audioBps
    if (videoBps < 150 * 1000) videoBps = 150 * 1000   // floor so it's not unwatchable

    const outPath = inputPath.replace(/\.(mp4|mkv)$/i, '_tg.mp4')
    const args = [
      '-y', '-i', inputPath,
      '-c:v', 'libx264', '-preset', 'fast',
      '-b:v', String(videoBps),
      '-maxrate', String(Math.floor(videoBps * 1.45)),
      '-bufsize', String(videoBps * 2),
      '-vf', 'scale=-2:720',          // downscale to 720p height, keep aspect (even width)
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      outPath
    ]
    const proc = spawn(ffmpegBin, args, { windowsHide: true, stdio: 'ignore' })
    proc.on('close', (code) => {
      resolve(code === 0 && fs.existsSync(outPath) ? outPath : null)
    })
    proc.on('error', () => resolve(null))
  })
}

export const recorder = new Recorder()
