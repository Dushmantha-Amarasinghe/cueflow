import React, { useState, useEffect, useCallback } from 'react'
import { Video, Clock, Inbox, Play, RefreshCw, AlertTriangle, CheckCircle, Zap, ChevronRight, Square } from 'lucide-react'

function formatTimeUntil(iso) {
  if (!iso) return null
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

function formatDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) +
    ' · ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

function StatusCard({ engineStatus, onNavigate }) {
  const { state, error, checking, lastCheck, isRecording, activeFlowCount, pendingCount } = engineStatus
  const isError = state === 'error'

  const bg = isRecording ? 'bg-green-500/10 border-green-500/30' :
    state === 'running'  ? 'bg-zinc-900 border-zinc-800' :
    isError              ? 'bg-red-500/10 border-red-500/30' :
    'bg-zinc-900 border-zinc-800'

  const dot = isRecording ? 'bg-green-400 animate-pulse' :
    state === 'running'  ? 'bg-violet-500' :
    isError              ? 'bg-red-400' : 'bg-zinc-600'

  const label = isRecording ? 'Recording' :
    checking ? 'Checking email…' :
    state === 'running' ? 'Monitoring' :
    isError ? 'Error' : 'Stopped'

  return (
    <div
      className={`rounded-xl border p-4 transition-all ${bg} ${isError ? 'cursor-pointer hover:border-red-500/60 active:scale-[0.99]' : ''}`}
      onClick={isError ? () => onNavigate('settings') : undefined}
      title={isError ? 'Click to open Settings → Connections' : undefined}
    >
      <div className="flex items-center gap-3">
        <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${dot}`} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-zinc-100">{label}</p>
          {error ? (
            <p className="text-xs text-red-400 mt-0.5 leading-snug">
              {error}
              {isError && <span className="text-zinc-500 ml-1">— click to open Settings</span>}
            </p>
          ) : lastCheck ? (
            <p className="text-xs text-zinc-600 mt-0.5">
              Last check: {new Date(lastCheck).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
              {' · '}{activeFlowCount} active flow{activeFlowCount !== 1 ? 's' : ''}
              {pendingCount > 0 ? ` · ${pendingCount} scheduled` : ''}
            </p>
          ) : state === 'running' ? (
            <p className="text-xs text-zinc-600 mt-0.5">
              {activeFlowCount} active flow{activeFlowCount !== 1 ? 's' : ''} · Checking shortly…
            </p>
          ) : (
            <p className="text-xs text-zinc-600 mt-0.5">Configure Gmail in Settings → Connections</p>
          )}
        </div>
        {checking && <RefreshCw size={13} className="text-zinc-500 animate-spin flex-shrink-0" />}
      </div>
    </div>
  )
}

function NextTaskCard({ task, onNavigate }) {
  if (!task) return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <p className="text-xs text-zinc-600 font-medium uppercase tracking-wider mb-2">Next scheduled</p>
      <p className="text-sm text-zinc-600">Nothing scheduled yet</p>
      <p className="text-xs text-zinc-700 mt-1">Create a flow and enable it to get started</p>
    </div>
  )

  const timeUntil = formatTimeUntil(task.scheduledAt)

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <p className="text-xs text-zinc-600 font-medium uppercase tracking-wider mb-3">Next scheduled</p>
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-lg bg-violet-600/20 flex items-center justify-center flex-shrink-0">
          <Video size={14} className="text-violet-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-zinc-200 truncate">
            {task.meetingTitle || task.flowName}
          </p>
          <p className="text-xs text-zinc-500 mt-0.5">{task.flowName}</p>
          <div className="flex items-center gap-3 mt-2">
            <span className="flex items-center gap-1 text-xs text-zinc-400">
              <Clock size={11} /> {formatDate(task.scheduledAt)}
            </span>
            {timeUntil && (
              <span className={`text-xs font-medium ${timeUntil === 'overdue' ? 'text-red-400' : 'text-amber-400'}`}>
                {timeUntil}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function StopRecordingBanner() {
  const [stopping, setStopping] = useState(false)

  const handleStop = async () => {
    setStopping(true)
    await window.cueflow?.engine.stopRecording()
    setTimeout(() => setStopping(false), 3000)
  }

  return (
    <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 flex items-center gap-3">
      <div className="w-2.5 h-2.5 rounded-full bg-red-400 animate-pulse flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-red-300">Recording in progress</p>
        <p className="text-xs text-red-500/70 mt-0.5">ffmpeg is capturing your screen</p>
      </div>
      <button
        onClick={handleStop}
        disabled={stopping}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-50 text-xs font-medium text-white transition-colors flex-shrink-0"
      >
        <Square size={11} />
        {stopping ? 'Stopping…' : 'Stop'}
      </button>
    </div>
  )
}

function QuickActions({ onCheckNow, onNavigate, engineStatus }) {
  const [checking, setChecking] = useState(false)

  const handleCheck = async () => {
    setChecking(true)
    await window.cueflow?.engine.checkNow()
    setTimeout(() => setChecking(false), 2000)
  }

  return (
    <div className="grid grid-cols-2 gap-3">
      <button
        onClick={handleCheck}
        disabled={checking || engineStatus?.state !== 'running'}
        className="flex items-center gap-2.5 p-3 rounded-xl border border-zinc-800 bg-zinc-900 hover:bg-zinc-800/60 disabled:opacity-50 transition-colors text-left"
      >
        <div className="w-7 h-7 rounded-lg bg-zinc-800 flex items-center justify-center">
          <RefreshCw size={13} className={`text-zinc-400 ${checking ? 'animate-spin' : ''}`} />
        </div>
        <div>
          <p className="text-xs font-medium text-zinc-200">Check now</p>
          <p className="text-xs text-zinc-600">Scan inbox immediately</p>
        </div>
      </button>

      <button
        onClick={() => onNavigate('flows')}
        className="flex items-center gap-2.5 p-3 rounded-xl border border-zinc-800 bg-zinc-900 hover:bg-zinc-800/60 transition-colors text-left"
      >
        <div className="w-7 h-7 rounded-lg bg-zinc-800 flex items-center justify-center">
          <Zap size={13} className="text-zinc-400" />
        </div>
        <div>
          <p className="text-xs font-medium text-zinc-200">Manage flows</p>
          <p className="text-xs text-zinc-600">Create or edit flows</p>
        </div>
      </button>
    </div>
  )
}

export default function Dashboard({ onNavigate }) {
  const [engineStatus, setEngineStatus] = useState({
    state: 'stopped', error: null, checking: false,
    lastCheck: null, isRecording: false,
    pendingCount: 0, nextTask: null, activeFlowCount: 0
  })
  const [tasks, setTasks] = useState([])

  const loadStatus = useCallback(async () => {
    const [s, t] = await Promise.all([
      window.cueflow?.engine.getStatus(),
      window.cueflow?.tasks.getAll()
    ])
    if (s) setEngineStatus(s)
    if (t) setTasks(t)
  }, [])

  useEffect(() => {
    loadStatus()
    const unsub = window.cueflow?.on.engineStatus(() => loadStatus())
    const interval = setInterval(loadStatus, 15000) // refresh every 15s
    return () => { unsub?.(); clearInterval(interval) }
  }, [loadStatus])

  // Upcoming = pending tasks sorted by time, skipping the very next one
  // (already shown in the Next Scheduled card above).
  const upcoming = tasks
    .filter(t => t.status === 'pending')
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))
    .slice(1, 7)

  return (
    <div className="p-6 space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-zinc-100">Dashboard</h1>
        <p className="text-xs text-zinc-600 mt-0.5">
          {new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
        </p>
      </div>

      <StatusCard engineStatus={engineStatus} onNavigate={onNavigate} />
      {engineStatus.isRecording && <StopRecordingBanner />}
      <NextTaskCard task={engineStatus.nextTask} onNavigate={onNavigate} />
      <QuickActions onCheckNow={loadStatus} onNavigate={onNavigate} engineStatus={engineStatus} />

      {/* Upcoming tasks list */}
      {upcoming.length > 0 && (
        <div className="space-y-2">
          <button
            onClick={() => onNavigate('flows')}
            className="flex items-center justify-between w-full text-left group"
          >
            <p className="text-xs text-zinc-600 font-medium uppercase tracking-wider">Upcoming</p>
            <span className="flex items-center gap-1 text-xs text-zinc-600 group-hover:text-violet-400 transition-colors">
              See all in Flows <ChevronRight size={11} />
            </span>
          </button>

          <div className="rounded-xl border border-zinc-800 bg-zinc-900 divide-y divide-zinc-800/60">
            {upcoming.map(task => {
              const timeUntil = formatTimeUntil(task.scheduledAt)
              return (
                <div key={task.id} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="w-7 h-7 rounded-lg bg-zinc-800 flex items-center justify-center flex-shrink-0">
                    <Video size={12} className="text-zinc-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-zinc-300 truncate">{task.meetingTitle || task.flowName}</p>
                    <p className="text-xs text-zinc-600 mt-0.5">{formatDate(task.scheduledAt)}</p>
                  </div>
                  {timeUntil && (
                    <span className={`text-xs flex-shrink-0 ${timeUntil === 'overdue' ? 'text-red-400' : 'text-zinc-500'}`}>
                      {timeUntil}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
