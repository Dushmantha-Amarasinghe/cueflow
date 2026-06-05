// Renderer-side screen recorder.
//
// Chromium's desktop capture grabs the *composited* screen (including
// hardware-accelerated video like Zoom) plus system audio — which ffmpeg's
// gdigrab can't do on Windows. The main process tells us when to start/stop;
// we stream the encoded chunks back to be written to disk.

let mediaRecorder = null
let stream = null

const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1,mp4a',   // best: writes a playable mp4 directly
  'video/mp4',
  'video/webm;codecs=h264,opus',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm'
]

function pickMime() {
  for (const m of MIME_CANDIDATES) {
    try { if (window.MediaRecorder?.isTypeSupported(m)) return m } catch { /* ignore */ }
  }
  return 'video/webm'
}

export function initScreenRecorder() {
  const r = window.cueflow?.recorder
  if (!r) return

  r.onStart(async (opts) => {
    try {
      const container = await startCapture(opts)
      r.started({ ok: true, container })
    } catch (e) {
      console.error('[screenRecorder] start failed:', e)
      try { stream?.getTracks().forEach(t => t.stop()) } catch { /* ignore */ }
      stream = null; mediaRecorder = null
      r.started({ ok: false, error: e?.message || String(e) })
    }
  })

  r.onStop(() => {
    try {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop()
      else { stream?.getTracks().forEach(t => t.stop()); stream = null; window.cueflow?.recorder?.stopped() }
    } catch (e) {
      console.error('[screenRecorder] stop failed:', e)
      window.cueflow?.recorder?.stopped()
    }
  })
}

async function startCapture({ sourceId, fps, audio, maxWidth, maxHeight, bitrate }) {
  const videoMandatory = {
    chromeMediaSource: 'desktop',
    chromeMediaSourceId: sourceId,
    maxFrameRate: fps || 30
  }
  if (maxWidth && maxHeight) {
    videoMandatory.maxWidth = maxWidth
    videoMandatory.maxHeight = maxHeight
  }

  const constraints = { video: { mandatory: videoMandatory } }
  if (audio) {
    // System (loopback) audio — what you hear, e.g. the meeting
    constraints.audio = { mandatory: { chromeMediaSource: 'desktop' } }
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints)
  } catch (e) {
    // If desktop audio loopback isn't permitted, retry video-only so the
    // recording still works (silent) rather than failing entirely.
    if (audio) {
      stream = await navigator.mediaDevices.getUserMedia({ video: { mandatory: videoMandatory } })
    } else {
      throw e
    }
  }

  const mime = pickMime()
  const opts = { mimeType: mime }
  if (bitrate) opts.videoBitsPerSecond = bitrate

  mediaRecorder = new MediaRecorder(stream, opts)

  mediaRecorder.ondataavailable = async (e) => {
    if (e.data && e.data.size > 0) {
      try {
        const buf = await e.data.arrayBuffer()
        window.cueflow?.recorder?.chunk(buf)
      } catch { /* ignore a dropped chunk */ }
    }
  }
  mediaRecorder.onstop = () => {
    try { stream?.getTracks().forEach(t => t.stop()) } catch { /* ignore */ }
    stream = null
    mediaRecorder = null
    window.cueflow?.recorder?.stopped()
  }

  mediaRecorder.start(1000)   // emit a chunk every second → written to disk incrementally
  return mime.startsWith('video/mp4') ? 'mp4' : 'webm'
}
