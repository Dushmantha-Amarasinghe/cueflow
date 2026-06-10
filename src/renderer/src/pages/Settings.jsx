import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { Mail, Video, Settings as Cog, Info, Eye, EyeOff, Check, X, FolderOpen, RefreshCw, ExternalLink, Monitor, Download, Wifi, WifiOff } from 'lucide-react'

const CoffeeIcon = ({ size = 11 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 8h1a4 4 0 0 1 0 8h-1"/>
    <path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/>
    <line x1="6" y1="2" x2="6" y2="4"/>
    <line x1="10" y1="2" x2="10" y2="4"/>
    <line x1="14" y1="2" x2="14" y2="4"/>
  </svg>
)
import Logo from '../components/Logo'

// OBS Studio logo — three-arc iris + outer ring + center dot
function ObsLogo({ size = 28, className = '' }) {
  // At r=33, circumference ≈ 207.35. Three arcs of ~107° (61.7) with ~13° gaps (7.5).
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <circle cx="50" cy="50" r="46" stroke="white" strokeWidth="5.5" />
      <circle cx="50" cy="50" r="33" stroke="white" strokeWidth="11"
        strokeDasharray="61.7 7.5" transform="rotate(-90 50 50)" />
      <circle cx="50" cy="50" r="13" fill="white" />
    </svg>
  )
}

const TABS = [
  { id: 'connections', label: 'Connections', icon: Mail },
  { id: 'recording',   label: 'Recording',   icon: Video },
  { id: 'general',     label: 'General',     icon: Cog },
  { id: 'about',       label: 'About',       icon: Info },
]

function SettingRow({ label, description, children }) {
  return (
    <div className="flex items-start justify-between gap-8 py-3.5 border-b border-zinc-800/50 last:border-0">
      <div className="flex-1 min-w-0">
        <p className="text-sm text-zinc-200">{label}</p>
        {description && <p className="text-xs text-zinc-600 mt-0.5">{description}</p>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  )
}

function Toggle({ checked, onChange }) {
  return (
    <div onClick={() => onChange(!checked)}
      className={`relative w-9 h-5 rounded-full cursor-pointer transition-colors ${checked ? 'bg-violet-600' : 'bg-zinc-700'}`}>
      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : ''}`} />
    </div>
  )
}

function CardSection({ title, children }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-800/60">
        <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">{title}</h3>
      </div>
      <div className="px-4">{children}</div>
    </div>
  )
}

function StatusBadge({ status }) {
  if (!status) return null
  const map = {
    connected: 'bg-green-500/15 text-green-400',
    error:     'bg-red-500/15 text-red-400',
    testing:   'bg-amber-500/15 text-amber-400'
  }
  return (
    <span className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs ${map[status] || ''}`}>
      {status === 'connected' && <Check size={10} />}
      {status === 'error'     && <X size={10} />}
      {status === 'testing'   && <RefreshCw size={10} className="animate-spin" />}
      {status === 'connected' ? 'Connected' : status === 'testing' ? 'Testing…' : 'Error'}
    </span>
  )
}

// ─── Connections tab ───────────────────────────────────────────────────────────

function ConnectionsTab({ settings, onSave }) {
  const [gmailEmail,     setGmailEmail]     = useState(settings.gmail?.email || '')
  const [gmailPassword,  setGmailPassword]  = useState(settings.gmail?.password || '')
  const [gmailStatus,    setGmailStatus]    = useState(settings.gmail?.email ? 'connected' : null)
  const [gmailError,     setGmailError]     = useState('')
  const [showGmailPwd,   setShowGmailPwd]   = useState(false)
  const [allowInsecure,  setAllowInsecure]  = useState(settings.gmail?.allowInsecureTLS === true)

  const [tgToken,    setTgToken]    = useState(settings.telegram?.botToken || '')
  const [tgChatId,   setTgChatId]   = useState(settings.telegram?.chatId || '')
  const [tgStatus,   setTgStatus]   = useState(settings.telegram?.botToken ? 'connected' : null)
  const [tgError,    setTgError]    = useState('')
  const [showTgToken, setShowTgToken] = useState(false)
  const [tgAutoUpload, setTgAutoUpload] = useState(settings.telegram?.autoUpload === true)
  const [tgCompress,   setTgCompress]   = useState(settings.telegram?.compressLarge === true)

  useEffect(() => {
    setGmailEmail(settings.gmail?.email || '')
    setGmailPassword(settings.gmail?.password || '')
    setGmailStatus(settings.gmail?.email ? 'connected' : null)
    setAllowInsecure(settings.gmail?.allowInsecureTLS === true)
    setTgToken(settings.telegram?.botToken || '')
    setTgChatId(settings.telegram?.chatId || '')
    setTgStatus(settings.telegram?.botToken ? 'connected' : null)
    setTgAutoUpload(settings.telegram?.autoUpload === true)
    setTgCompress(settings.telegram?.compressLarge === true)
  }, [settings])

  // Persist immediately, merging into the saved telegram settings
  const toggleAutoUpload = async (v) => {
    setTgAutoUpload(v)
    await onSave({ telegram: { autoUpload: v } })
  }
  const toggleCompress = async (v) => {
    setTgCompress(v)
    await onSave({ telegram: { compressLarge: v } })
  }

  const handleGmailConnect = async () => {
    if (!gmailEmail || !gmailPassword) { setGmailError('Email and App Password are required'); return }
    setGmailStatus('testing'); setGmailError('')
    const result = await window.cueflow?.settings.testGmail({ email: gmailEmail, password: gmailPassword, allowInsecureTLS: allowInsecure })
    if (result?.success) {
      await onSave({ gmail: { email: gmailEmail, password: gmailPassword, allowInsecureTLS: allowInsecure } })
      setGmailStatus('connected')
    } else {
      setGmailStatus('error')
      setGmailError(result?.error || 'Connection failed')
    }
  }

  // Persist the TLS toggle immediately (also triggers an engine restart so the
  // change takes effect without needing to re-enter credentials).
  const toggleInsecure = async (v) => {
    setAllowInsecure(v)
    await onSave({ gmail: { allowInsecureTLS: v } })
  }

  const handleTgConnect = async () => {
    if (!tgToken) { setTgError('Bot token is required'); return }
    setTgStatus('testing'); setTgError('')
    const result = await window.cueflow?.settings.testTelegram({ botToken: tgToken, chatId: tgChatId })
    if (result?.success) {
      await onSave({ telegram: { botToken: tgToken, chatId: tgChatId } })
      setTgStatus('connected')
    } else {
      setTgStatus('error')
      setTgError(result?.error || 'Connection failed')
    }
  }

  return (
    <div className="space-y-4">
      {/* Gmail */}
      <CardSection title="Gmail">
        <SettingRow label="Email address" description="Your Gmail address">
          <input
            value={gmailEmail}
            onChange={e => setGmailEmail(e.target.value)}
            placeholder="you@gmail.com"
            className="w-52 px-2.5 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-violet-600/70"
          />
        </SettingRow>
        <SettingRow label="App Password" description="16-character Google App Password (not your account password)">
          <div className="flex items-center gap-1.5">
            <div className="relative">
              <input
                type={showGmailPwd ? 'text' : 'password'}
                value={gmailPassword}
                onChange={e => setGmailPassword(e.target.value)}
                placeholder="xxxx xxxx xxxx xxxx"
                className="w-44 px-2.5 py-1.5 pr-8 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-violet-600/70"
              />
              <button onClick={() => setShowGmailPwd(v => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300">
                {showGmailPwd ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
          </div>
        </SettingRow>
        {gmailError && <p className="text-xs text-red-400 pb-2">{gmailError}</p>}
        <div className="flex items-center gap-3 py-3">
          <button onClick={handleGmailConnect}
            disabled={gmailStatus === 'testing'}
            className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-xs font-medium text-white transition-colors">
            {gmailStatus === 'testing' ? 'Testing…' : 'Connect'}
          </button>
          <StatusBadge status={gmailStatus} />
          <button
            onClick={() => window.cueflow?.shell.openExternal('https://myaccount.google.com/apppasswords')}
            className="ml-auto flex items-center gap-1 text-xs text-zinc-600 hover:text-violet-400 transition-colors">
            <ExternalLink size={11} /> Get App Password
          </button>
        </div>
        <SettingRow label="Allow insecure TLS" description="Only enable if your antivirus/proxy inspects HTTPS and email checks fail with a certificate error">
          <Toggle checked={allowInsecure} onChange={toggleInsecure} />
        </SettingRow>
      </CardSection>

      {/* Telegram */}
      <CardSection title="Telegram Bot (optional)">
        <SettingRow label="Bot token" description="From @BotFather — create your own bot">
          <div className="relative">
            <input
              type={showTgToken ? 'text' : 'password'}
              value={tgToken}
              onChange={e => setTgToken(e.target.value)}
              placeholder="123456:ABC-DEF..."
              className="w-52 px-2.5 py-1.5 pr-8 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-violet-600/70"
            />
            <button onClick={() => setShowTgToken(v => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300">
              {showTgToken ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          </div>
        </SettingRow>
        <SettingRow label="Your Chat ID" description="Send /start to your bot, then use @userinfobot to find your ID">
          <input
            value={tgChatId}
            onChange={e => setTgChatId(e.target.value)}
            placeholder="123456789"
            className="w-52 px-2.5 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-violet-600/70"
          />
        </SettingRow>
        {tgError && <p className="text-xs text-red-400 pb-2">{tgError}</p>}
        <div className="flex items-center gap-3 py-3">
          <button onClick={handleTgConnect}
            disabled={tgStatus === 'testing'}
            className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-xs font-medium text-white transition-colors">
            {tgStatus === 'testing' ? 'Testing…' : 'Connect & Test'}
          </button>
          <StatusBadge status={tgStatus} />
        </div>
        <SettingRow label="Auto-upload recordings" description="Send each finished recording to your chat (files up to 50 MB)">
          <Toggle checked={tgAutoUpload} onChange={toggleAutoUpload} />
        </SettingRow>
        {tgAutoUpload && (
          <SettingRow label="Compress & send large recordings" description="Recordings over 50 MB are downscaled to fit — quality may be reduced">
            <Toggle checked={tgCompress} onChange={toggleCompress} />
          </SettingRow>
        )}
      </CardSection>
    </div>
  )
}

// ─── Recording tab ─────────────────────────────────────────────────────────────
// Module-level cache — persists for the whole session so screens don't re-detect on every tab switch
let _screensCache = null

// Thumbnail for the screen picker — falls back to monitor icon if image is null or fails to load
function ScreenThumb({ thumbnail, name }) {
  const [broken, setBroken] = React.useState(false)
  if (!thumbnail || broken) {
    return (
      <div className="w-24 h-14 rounded bg-zinc-700 flex items-center justify-center">
        <Monitor size={22} className="text-zinc-500" />
      </div>
    )
  }
  return (
    <img
      src={thumbnail}
      className="w-24 h-14 rounded object-cover bg-zinc-700"
      alt={name}
      onError={() => setBroken(true)}
    />
  )
}

function RecordingTab({ settings, onSave, onPatch }) {
  const rec = settings.recording || {}

  const [folder,        setFolder]        = useState(rec.saveFolder || '')
  const [defaultPath,   setDefaultPath]   = useState('')
  const [subfolder,     setSubfolder]     = useState(rec.subfolders !== false)
  const [resolution,    setResolution]    = useState(rec.resolution || 'native')
  const [fps,           setFps]           = useState(rec.fps || 30)
  // encoder holds the full OBS encoder ID (e.g. 'obs_nvenc_h264_tex').
  // Falls back from legacy 'codec' field when 'encoder' has never been saved.
  // encoder holds the full OBS encoder ID — obs_x264 is the universal fallback
  // (the old codec field mapped h265 to obs_ffmpeg_hevc_sw which never existed)
  const [encoder,       setEncoder]       = useState(rec.encoder || 'obs_x264')
  const [quality,       setQuality]       = useState(rec.quality ?? 28)
  const [audioMode,      setAudioMode]      = useState(rec.audioMode || 'system')
  const [sysAudioDevice, setSysAudioDevice] = useState(rec.sysAudioDevice || '')
  const [micDevice,      setMicDevice]      = useState(rec.micDevice || '')
  const [audioDevices,   setAudioDevices]   = useState([])
  const [obsInfo,        setObsInfo]        = useState(null)
  const [screens,       setScreens]       = useState([])
  const [selectedScreen,setSelectedScreen]= useState(rec.display || null)
  const [autoFullscreen,    setAutoFullscreen]    = useState(rec.autoFullscreen !== false)
  const [waitSecs,          setWaitSecs]          = useState(rec.waitBeforeRecord ?? 5)
  const [postCompress,      setPostCompress]      = useState(rec.postCompress !== false)
  const [postCompressMode,  setPostCompressMode]  = useState(rec.postCompressMode || 'smart')
  const [saved,         setSaved]         = useState(false)
  const [loadingScreens,setLoadingScreens]= useState(false)

  // ── Resolution options — context-aware based on the selected screen ───────────
  // The top "native" option always reflects the actual recording source so the
  // connection between screen picker and resolution is obvious.
  const resolutionOptions = useMemo(() => {
    let nativeW, nativeH

    if (selectedScreen?.bounds) {
      // A specific screen is selected — use its exact dimensions
      nativeW = selectedScreen.bounds.width
      nativeH = selectedScreen.bounds.height
    } else {
      // "All screens" — recorder.js uses the primary display for 'native'
      const primary = screens.find(s => s.isPrimary)
      if (primary?.bounds) {
        nativeW = primary.bounds.width
        nativeH = primary.bounds.height
      } else {
        // Fallback: largest monitor known to OBS
        const biggest = (obsInfo?.monitors || []).reduce(
          (a, m) => (m.height || 0) > (a.height || 0) ? m : a, {}
        )
        nativeW = biggest.width  || 1920
        nativeH = biggest.height || 1080
      }
    }

    // Only show downscales strictly below the native height — no duplicates
    const downscales = [
      { value: '3840x2160', h: 2160, label: '3840 × 2160  ·  4K'    },
      { value: '2560x1440', h: 1440, label: '2560 × 1440  ·  2K'    },
      { value: '1920x1080', h: 1080, label: '1920 × 1080  ·  1080p' },
      { value: '1280x720',  h: 720,  label: '1280 × 720   ·  720p'  },
      { value: '854x480',   h: 480,  label: '854 × 480    ·  480p'  },
    ].filter(r => r.h < nativeH && r.value !== `${nativeW}x${nativeH}`)

    return [
      { value: 'native', label: `Full screen — ${nativeW} × ${nativeH}` },
      ...downscales.map(r => ({ value: r.value, label: r.label })),
    ]
  }, [obsInfo?.monitors, selectedScreen, screens])

  // ── Encoder list from OBS — available even before OBS connects ─────────────
  const hwEncoders  = (obsInfo?.encoders || []).filter(e => e.hw)
  const swEncoders  = (obsInfo?.encoders || []).filter(e => !e.hw)
  const noEncoders  = !obsInfo?.encoders?.length

  // System audio device options — from OBS WASAPI output capture device list
  const sysAudioOptions = (obsInfo?.audioOutputs || [])
    .map(d => ({ label: d.name, value: d.id ?? d.name }))

  useEffect(() => {
    window.cueflow?.recordings?.getDefaultPath().then(p => p && setDefaultPath(p))
    window.cueflow?.audio?.getDevices().then(d => d && setAudioDevices(d))
    loadScreens(false)

    // Poll OBS capabilities every 3 s until connected so the banner updates live.
    // Stops as soon as the connection is established.
    let timer
    const pollObs = async () => {
      const caps = await window.cueflow?.obs?.getCapabilities()
      if (caps) setObsInfo(caps)
      if (!caps?.connected) timer = setTimeout(pollObs, 3000)
    }
    pollObs()
    return () => clearTimeout(timer)
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const loadScreens = useCallback(async (force = false) => {
    // Use cached screens unless forced (Detect button) — avoids re-detecting on every tab visit
    if (_screensCache && !force) {
      setScreens(_screensCache)
      syncSelection(_screensCache)
      return
    }
    setLoadingScreens(true)
    const srcs = await window.cueflow?.screen?.getSources() || []
    _screensCache = srcs
    setScreens(srcs)
    syncSelection(srcs)
    setLoadingScreens(false)
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const syncSelection = (srcs) => {
    if (srcs.length > 0) {
      setSelectedScreen(prev => {
        if (prev) return srcs.find(s => s.id === prev.id) ?? prev
        // Nothing saved yet — auto-select the primary screen on first install
        return srcs.find(s => s.isPrimary) ?? srcs[0]
      })
    }
  }

  const save = async () => {
    // Derive the legacy codec field from the encoder ID for backward compat
    const codec = /hevc|h265/i.test(encoder) ? 'h265' : /av1/i.test(encoder) ? 'av1' : 'h264'
    await onSave({
      recording: {
        saveFolder: folder, subfolders: subfolder,
        resolution, fps: Number(fps),
        encoder, codec,   // encoder = full OBS ID; codec = h264/h265/av1 for compat
        quality: Number(quality),
        audioMode, sysAudioDevice: sysAudioDevice || null, micDevice: micDevice || null,
        // Save only metadata — never persist the thumbnail (bloats settings.json)
        display: selectedScreen ? {
          id: selectedScreen.id, name: selectedScreen.name,
          bounds: selectedScreen.bounds, scaleFactor: selectedScreen.scaleFactor,
          isPrimary: selectedScreen.isPrimary
        } : null,
        autoFullscreen, waitBeforeRecord: Number(waitSecs),
        postCompress, postCompressMode
      }
    })
    setSaved(true); setTimeout(() => setSaved(false), 2000)
  }

  // Auto-save display selection immediately on click — persists to disk AND syncs
  // parent state so switching tabs and returning keeps the selection.
  const selectScreen = async (src) => {
    setSelectedScreen(src)

    if (resolution !== 'native') {
      const [resW, resH] = resolution.split('x').map(Number)
      if (src?.bounds) {
        // Normalize: if saved resolution exactly matches the new screen's native, switch to 'native'
        // so the "Full screen — WxH" option is selected rather than nothing.
        if (resW === src.bounds.width && resH === src.bounds.height) {
          setResolution('native')
        } else if (src.bounds.height < resH) {
          // Screen is smaller than the saved resolution — downgrade
          setResolution('native')
        }
      }
    }

    const display = src ? {
      id: src.id, name: src.name, bounds: src.bounds,
      scaleFactor: src.scaleFactor, isPrimary: src.isPrimary
    } : null
    await onPatch?.({ display })
  }

  const browseFolder = async () => {
    const p = await window.cueflow?.dialog.selectFolder()
    if (p) setFolder(p)
  }

  const openFolder = () => {
    const target = folder || defaultPath
    if (target) window.cueflow?.shell.openPath(target)
    else browseFolder()
  }

  const displayedFolder = folder || ''
  const folderPlaceholder = defaultPath
    ? defaultPath.replace(/^.*[/\\]/, '…\\').replace(/\\/g, '\\')
    : 'Documents\\Cueflow\\Recordings'


  // Mic options: prefer OBS WASAPI list (what OBS actually sees from Windows),
  // fall back to ffmpeg dshow list when OBS isn't connected yet.
  const micOptions = (obsInfo?.microphones?.length ? obsInfo.microphones : audioDevices)
    .map(d => ({ label: d.name, value: d.id ?? d.name }))

  return (
    <div className="space-y-4">

      {/* ── OBS Studio banner ─────────────────────────────────────────────── */}
      <div className={`flex items-center justify-between px-4 py-3 rounded-xl border ${
        obsInfo?.connected ? 'bg-[#1a1a2e] border-[#302d5a]' : 'bg-zinc-900 border-zinc-800'
      }`}>
        <div className="flex items-center gap-2.5">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
            obsInfo?.connected ? 'bg-violet-700' : 'bg-zinc-700'
          }`}>
            <ObsLogo size={22} />
          </div>
          <div>
            <p className="text-xs font-semibold text-zinc-200">OBS Studio</p>
            <p className="text-xs text-zinc-500">
              {obsInfo?.connected
                ? `v${obsInfo.obsVersion} · Screen capture · WASAPI audio`
                : 'Not connected — launch Cueflow to start OBS in the background'}
            </p>
          </div>
        </div>
        <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
          obsInfo?.connected ? 'bg-violet-600/20 text-violet-300' : 'bg-zinc-800 text-zinc-500'
        }`}>
          {obsInfo?.connected ? <><Wifi size={10} />&nbsp;Connected</> : <><WifiOff size={10} />&nbsp;Offline</>}
        </div>
      </div>

      {/* Output */}
      <CardSection title="Output">
        <SettingRow label="Save folder" description="Where recordings are saved">
          <div className="flex items-center gap-1.5">
            <input
              readOnly value={displayedFolder}
              placeholder={folderPlaceholder}
              title={folder || defaultPath || 'Documents\\Cueflow\\Recordings'}
              className="w-44 px-2.5 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-xs text-zinc-400 placeholder-zinc-600 cursor-pointer"
              onClick={browseFolder}
            />
            <button onClick={openFolder} title={folder || defaultPath ? 'Open in Explorer' : 'Browse'}
              className="w-7 h-7 flex items-center justify-center rounded bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-zinc-200">
              <FolderOpen size={13} />
            </button>
          </div>
        </SettingRow>
        <SettingRow label="Subfolders per flow" description="Organise recordings into flow-named subfolders">
          <Toggle checked={subfolder} onChange={setSubfolder} />
        </SettingRow>
      </CardSection>

      {/* Screen selection */}
      <CardSection title="Screen">
        <div className="py-3 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-zinc-200">Select screen to record</p>
              <p className="text-xs text-zinc-600 mt-0.5">
                {selectedScreen ? selectedScreen.name : 'No screen selected'}
              </p>
            </div>
            <button onClick={() => loadScreens(true)} disabled={loadingScreens}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-50 transition-colors">
              <Monitor size={12} /> {loadingScreens ? 'Detecting…' : 'Detect screens'}
            </button>
          </div>

          {screens.length > 0 && (
            <div className="flex gap-2 flex-wrap">
              {screens.map((src) => (
                <button key={src.id} onClick={() => selectScreen(src)}
                  className={`flex flex-col items-center gap-1.5 p-1.5 rounded-lg border transition-colors ${
                    selectedScreen?.id === src.id ? 'border-violet-500 bg-violet-600/10' : 'border-zinc-700 bg-zinc-800 hover:border-zinc-600'
                  }`}
                >
                  <ScreenThumb thumbnail={src.thumbnail} name={src.name} />
                  <span className="text-xs text-zinc-300 font-medium">{src.name}</span>
                  {src.bounds && (
                    <span className="text-xs text-zinc-600">{src.bounds.width}×{src.bounds.height}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </CardSection>

      {/* Quality */}
      <CardSection title="Quality">
        <SettingRow label="Output resolution" description="Full screen captures native resolution then scales down — never crops">
          <select value={resolution} onChange={e => setResolution(e.target.value)}
            className="w-52 px-2.5 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-200 focus:outline-none">
            {resolutionOptions.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </SettingRow>
        <SettingRow label="Frame rate">
          <select value={fps} onChange={e => setFps(e.target.value)}
            className="w-36 px-2.5 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-200 focus:outline-none">
            {['15','24','25','30','48','60'].map(r => (
              <option key={r} value={r}>{r} fps
                {obsInfo?.videoSettings && Math.round(obsInfo.videoSettings.fps) === Number(r) ? ' (current)' : ''}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow label="Encoder" description={
          noEncoders
            ? 'Launch Cueflow to detect available encoders'
            : hwEncoders.length > 0
              ? `${hwEncoders.length} GPU encoder${hwEncoders.length > 1 ? 's' : ''} detected`
              : 'Software encoding only'
        }>
          <select value={encoder} onChange={e => setEncoder(e.target.value)}
            className="w-52 px-2.5 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-200 focus:outline-none">
            {noEncoders ? (
              // OBS not yet connected — show static fallback so the dropdown isn't blank
              <option value="obs_x264">H.264 · Software (x264)</option>
            ) : (
              <>
                {hwEncoders.length > 0 && (
                  <optgroup label="Hardware (GPU)">
                    {hwEncoders.map(enc => (
                      <option key={enc.id} value={enc.id}>{enc.label}</option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="Software (CPU)">
                  {swEncoders.map(enc => (
                    <option key={enc.id} value={enc.id}>{enc.label}</option>
                  ))}
                </optgroup>
              </>
            )}
          </select>
        </SettingRow>
        <SettingRow label={`Quality — CRF ${quality}`} description="Lower = better quality, larger file. 18–28 is typical.">
          <input type="range" min={10} max={40} value={quality} onChange={e => setQuality(e.target.value)}
            className="w-36 accent-violet-500" />
        </SettingRow>
      </CardSection>

      {/* Post-processing */}
      <CardSection title="Post-processing">
        <SettingRow
          label="Compress after recording"
          description="FFmpeg drops duplicate frames (VFR) and re-encodes — like HandBrake. Runs silently in the background, replaces the file in-place."
        >
          <Toggle checked={postCompress} onChange={setPostCompress} />
        </SettingRow>
        {postCompress && (
          <div className="pb-3.5 border-b border-zinc-800/50">
            <p className="text-xs text-zinc-500 mb-2">Compression mode</p>
            <div className="flex gap-2">
              {[
                { value: 'smart', label: 'Smart', detail: 'HEVC CRF 30 · fast', hint: '70 MB → ~1 MB · seconds' },
                { value: 'max',   label: 'Max',   detail: 'HEVC CRF 28 · medium', hint: 'Better quality · still fast' },
              ].map(opt => (
                <button key={opt.value} onClick={() => setPostCompressMode(opt.value)}
                  className={`flex-1 py-2.5 px-3 rounded-lg text-left border transition-colors ${
                    postCompressMode === opt.value
                      ? 'bg-violet-600/20 border-violet-500/50 text-violet-200'
                      : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:border-zinc-600'
                  }`}
                >
                  <p className="text-xs font-semibold">{opt.label}</p>
                  <p className="text-[10px] text-zinc-500 mt-0.5">{opt.detail}</p>
                  <p className="text-[10px] mt-0.5 opacity-70">{opt.hint}</p>
                </button>
              ))}
            </div>
          </div>
        )}
      </CardSection>

      {/* Audio */}
      <CardSection title="Audio">
        <SettingRow label="Audio mode">
          <select value={audioMode} onChange={e => setAudioMode(e.target.value)}
            className="w-44 px-2.5 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-200 focus:outline-none">
            <option value="system">System audio (what you hear)</option>
            <option value="mic">Microphone only</option>
            <option value="both">System + Microphone</option>
            <option value="none">No audio</option>
          </select>
        </SettingRow>

        {/* System audio output device — shown when system audio is active */}
        {(audioMode === 'system' || audioMode === 'both') && (
          <SettingRow
            label="System audio device"
            description={obsInfo?.connected
              ? `${sysAudioOptions.length} output device${sysAudioOptions.length !== 1 ? 's' : ''} detected by OBS (WASAPI)`
              : 'Output device OBS will loopback-capture. Leave blank for the Windows default.'}
          >
            <select value={sysAudioDevice} onChange={e => setSysAudioDevice(e.target.value)}
              className="w-52 px-2.5 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-xs text-zinc-200 focus:outline-none">
              <option value="">— default output —</option>
              {sysAudioOptions.map(d => (
                <option key={d.value} value={d.value}>{d.label}</option>
              ))}
            </select>
          </SettingRow>
        )}

        {/* Microphone device — shown when mic capture is active */}
        {(audioMode === 'mic' || audioMode === 'both') && (
          <SettingRow
            label="Microphone"
            description={obsInfo?.connected
              ? `${micOptions.length} input device${micOptions.length !== 1 ? 's' : ''} detected by OBS (WASAPI)`
              : 'Input device for your voice. Leave blank for the Windows default.'}
          >
            <select value={micDevice} onChange={e => setMicDevice(e.target.value)}
              className="w-52 px-2.5 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-xs text-zinc-200 focus:outline-none">
              <option value="">— default microphone —</option>
              {micOptions.map(d => (
                <option key={d.value} value={d.value}>{d.label}</option>
              ))}
            </select>
          </SettingRow>
        )}
      </CardSection>

      {/* Behaviour */}
      <CardSection title="Behaviour">
        <SettingRow label="Auto-fullscreen" description="Maximise meeting window before recording">
          <Toggle checked={autoFullscreen} onChange={setAutoFullscreen} />
        </SettingRow>
        <SettingRow label="Wait before recording" description="Seconds to wait after meeting opens">
          <div className="flex items-center gap-1.5">
            <input type="number" min={0} max={60} value={waitSecs} onChange={e => setWaitSecs(e.target.value)}
              className="w-16 px-2.5 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-200 focus:outline-none text-center" />
            <span className="text-xs text-zinc-600">sec</span>
          </div>
        </SettingRow>
      </CardSection>

      <div className="flex justify-end">
        <button onClick={save}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${saved ? 'bg-green-600/20 text-green-400' : 'bg-violet-600 hover:bg-violet-500 text-white'}`}>
          {saved ? '✓ Saved' : 'Save changes'}
        </button>
      </div>
    </div>
  )
}

// ─── General tab ───────────────────────────────────────────────────────────────

function GeneralTab({ settings, onSave }) {
  const gen = settings.general || {}
  const [preventSleep, setPreventSleep] = useState(gen.preventSleep !== false)
  const [checkInterval, setCheckInterval] = useState(gen.checkIntervalMinutes ?? 5)
  const gracePeriod = gen.gracePeriodMinutes ?? 45
  const [autoClearDays, setAutoClearDays] = useState(gen.autoClearDays ?? 30)
  const [closeApp, setCloseApp] = useState(gen.closeAppAfterRecord === true)
  const [saved, setSaved] = useState(false)

  const save = async () => {
    await onSave({ general: { preventSleep, checkIntervalMinutes: Number(checkInterval), gracePeriodMinutes: Number(gracePeriod), autoClearDays: Number(autoClearDays), closeAppAfterRecord: closeApp } })
    setSaved(true); setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="space-y-4">
      <CardSection title="System">
        <SettingRow label="Prevent sleep" description="Keep the computer awake while a flow is active">
          <Toggle checked={preventSleep} onChange={setPreventSleep} />
        </SettingRow>
        <SettingRow label="Email check interval" description="How often to check for new matching emails">
          <div className="flex items-center gap-1.5">
            <input type="number" min={1} max={60} value={checkInterval} onChange={e => setCheckInterval(e.target.value)}
              className="w-16 px-2.5 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-200 focus:outline-none text-center" />
            <span className="text-xs text-zinc-600">min</span>
          </div>
        </SettingRow>
      </CardSection>

      <CardSection title="Meeting">
        <SettingRow label="Close meeting after recording" description="Automatically quit Zoom/Teams when a recording finishes">
          <Toggle checked={closeApp} onChange={setCloseApp} />
        </SettingRow>
      </CardSection>

      <CardSection title="Data">
        <SettingRow label="Auto-clear history" description="Remove history entries older than this many days (0 = never)">
          <div className="flex items-center gap-1.5">
            <input type="number" min={0} value={autoClearDays} onChange={e => setAutoClearDays(e.target.value)}
              className="w-16 px-2.5 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-200 focus:outline-none text-center" />
            <span className="text-xs text-zinc-600">days</span>
          </div>
        </SettingRow>
      </CardSection>

      <div className="flex justify-end">
        <button onClick={save}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${saved ? 'bg-green-600/20 text-green-400' : 'bg-violet-600 hover:bg-violet-500 text-white'}`}>
          {saved ? '✓ Saved' : 'Save changes'}
        </button>
      </div>
    </div>
  )
}

// ─── About tab ─────────────────────────────────────────────────────────────────

function AboutTab() {
  const [updateState, setUpdateState] = useState('idle')
  const [info, setInfo] = useState(null)
  const [appVersion, setAppVersion] = useState('')

  useEffect(() => {
    window.cueflow?.app.getState().then(s => s?.version && setAppVersion(s.version))
  }, [])

  const checkForUpdates = async () => {
    setUpdateState('checking')
    const r = await window.cueflow?.update?.check()
    if (!r || !r.ok) { setUpdateState('error'); return }
    if (r.available) { setInfo(r); setUpdateState('available') }
    else setUpdateState('latest')
  }

  const download = () => window.cueflow?.update?.download(info?.downloadUrl)

  // Always the same button — only the icon (spin) and text/colour change,
  // so the layout never shifts.
  const UpdateButton = () => {
    const base = 'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors'
    const checking = updateState === 'checking'

    // Found an update → violet download button
    if (updateState === 'available') return (
      <button onClick={download} className={`${base} bg-violet-600 hover:bg-violet-500 text-white`}>
        <Download size={11} /> Download v{info?.version}
      </button>
    )

    const tone =
      updateState === 'latest' ? 'text-green-400' :
      updateState === 'error'  ? 'text-red-400'   : 'text-zinc-300'

    const icon = updateState === 'latest'
      ? <Check size={11} />
      : <RefreshCw size={11} className={checking ? 'animate-spin' : ''} />

    const text =
      checking                  ? 'Checking…' :
      updateState === 'latest'  ? "You're on the latest version" :
      updateState === 'error'   ? 'Check failed — retry' :
                                  'Check for updates'

    return (
      <button onClick={checkForUpdates} disabled={checking}
        className={`${base} bg-zinc-800 hover:bg-zinc-700 disabled:hover:bg-zinc-800 disabled:cursor-default ${tone}`}>
        {icon} {text}
      </button>
    )
  }

  return (
    <div className="space-y-4">
      <CardSection title="Cueflow">
        <div className="py-6 flex flex-col items-center gap-3">
          <Logo size={56} className="shadow-lg shadow-violet-500/20" />
          <div className="text-center">
            <p className="text-sm font-semibold text-zinc-100">Cueflow</p>
            <p className="text-xs text-zinc-600 mt-0.5">{appVersion ? `v${appVersion}` : ''}</p>
          </div>
          <p className="text-xs text-zinc-600 text-center max-w-xs">
            Automated meeting recorder triggered by email.<br />
            Modular flows, ICS scheduling, Gmail IMAP.
          </p>
        </div>
      </CardSection>

      <CardSection title="Updates">
        <SettingRow label="Check for updates" description="Latest releases are published on GitHub">
          <UpdateButton />
        </SettingRow>
      </CardSection>

      <CardSection title="Open source">
        <SettingRow label="GitHub" description="Source code, issues, and contributions">
          <button onClick={() => window.cueflow?.shell.openExternal('https://github.com/Dushmantha-Amarasinghe/cueflow')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-300 transition-colors">
            <ExternalLink size={11} /> View on GitHub
          </button>
        </SettingRow>
        <SettingRow label="Support" description="If Cueflow saves you time, buy me a coffee">
          <button onClick={() => window.cueflow?.shell.openExternal('https://www.paypal.com/donate?business=dsbamarasinghe1234@gmail.com&currency_code=USD&amount=5')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-300 hover:text-amber-400 transition-colors">
            <CoffeeIcon /> Buy me a coffee
          </button>
        </SettingRow>
      </CardSection>
    </div>
  )
}

// ─── Root ──────────────────────────────────────────────────────────────────────

export default function Settings() {
  const [tab, setTab] = useState('connections')
  const [settings, setSettings] = useState({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    window.cueflow?.settings.get().then(s => { setSettings(s || {}); setLoading(false) })
  }, [])

  const handleSave = async (partial) => {
    const merged = JSON.parse(JSON.stringify(settings))
    for (const [key, val] of Object.entries(partial)) {
      merged[key] = { ...(merged[key] || {}), ...val }
    }
    await window.cueflow?.settings.save(merged)
    setSettings(merged)
  }

  // Lightweight patch for the recording section — persists to disk AND syncs parent
  // state so tab remounts don't read stale values (no engine restart).
  const handlePatchRecording = async (recPartial) => {
    await window.cueflow?.settings.patchRecording(recPartial)
    setSettings(prev => ({
      ...prev,
      recording: { ...(prev.recording || {}), ...recPartial }
    }))
  }

  if (loading) return <div className="p-6 text-xs text-zinc-600">Loading…</div>

  return (
    <div className="flex h-full">
      {/* Tab sidebar */}
      <nav className="w-44 flex-shrink-0 border-r border-zinc-800 p-3 space-y-1">
        {TABS.map(t => {
          const Icon = t.icon
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors text-left ${
                tab === t.id ? 'bg-violet-600/15 text-violet-300' : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/60'
              }`}
            >
              <Icon size={14} />
              {t.label}
            </button>
          )
        })}
      </nav>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-5">
        {tab === 'connections' && <ConnectionsTab settings={settings} onSave={handleSave} />}
        {tab === 'recording'   && <RecordingTab   settings={settings} onSave={handleSave} onPatch={handlePatchRecording} />}
        {tab === 'general'     && <GeneralTab     settings={settings} onSave={handleSave} />}
        {tab === 'about'       && <AboutTab />}
      </div>
    </div>
  )
}
