import React, { useState, useEffect } from 'react'
import TitleBar from './components/TitleBar'
import Sidebar from './components/Sidebar'
import Dashboard from './pages/Dashboard'
import Flows from './pages/Flows'
import History from './pages/History'
import Settings from './pages/Settings'
import Onboarding from './pages/Onboarding'
import { initScreenRecorder } from './screenRecorder'

// Derive a simple sidebar status from the full engine status object
function deriveStatus(s) {
  if (!s) return 'idle'
  if (s.isRecording) return 'recording'
  if (s.checking)    return 'checking'
  if (s.state === 'running') return 'monitoring'
  if (s.state === 'error')   return 'error'
  return 'idle'
}

export default function App() {
  const [page,            setPage]            = useState('dashboard')
  const [engineStatus,    setEngineStatus]    = useState(null)
  const [showOnboarding,  setShowOnboarding]  = useState(false)
  const [ready,           setReady]           = useState(false)
  const [updateInfo,      setUpdateInfo]       = useState(null)   // { version, downloaded }

  // First-run check + screen-recorder bridge
  useEffect(() => {
    window.cueflow?.settings.get().then(s => {
      setShowOnboarding(!s?.gmail?.email && !s?._onboardingDone)
      setReady(true)
    })
    initScreenRecorder()
  }, [])

  // Pull initial engine status
  useEffect(() => {
    window.cueflow?.engine.getStatus().then(s => s && setEngineStatus(s))
  }, [])

  // Live engine status updates
  useEffect(() => {
    const unsub = window.cueflow?.on.engineStatus(s => setEngineStatus(s))
    return unsub
  }, [])

  // Navigation from main process (tray clicks etc.)
  useEffect(() => {
    const unsub = window.cueflow?.on.navigate(target => setPage(target))
    return unsub
  }, [])

  // Update notification (from launch-time check)
  useEffect(() => {
    const unsub = window.cueflow?.on.updateAvailable?.(info => setUpdateInfo(info))
    return unsub
  }, [])

  if (!ready) return null

  const status = deriveStatus(engineStatus)

  const pages = {
    dashboard: <Dashboard onNavigate={setPage} />,
    flows:     <Flows />,
    history:   <History />,
    settings:  <Settings />
  }

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100 overflow-hidden select-none">
      <TitleBar />

      {showOnboarding ? (
        <div className="flex-1 overflow-hidden">
          <Onboarding onComplete={() => { setShowOnboarding(false); setPage('dashboard') }} />
        </div>
      ) : (
        <div className="flex flex-1 overflow-hidden">
          <Sidebar currentPage={page} onNavigate={setPage} status={status} updateInfo={updateInfo} />
          <main className="flex-1 overflow-auto">
            {pages[page] ?? pages.dashboard}
          </main>
        </div>
      )}
    </div>
  )
}
