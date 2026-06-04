import React from 'react'
import { LayoutDashboard, GitBranch, Clock, Settings, Heart, Download } from 'lucide-react'

const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'flows',     label: 'Flows',     icon: GitBranch },
  { id: 'history',   label: 'History',   icon: Clock },
  { id: 'settings',  label: 'Settings',  icon: Settings }
]

const STATUS = {
  idle:       { dot: 'bg-zinc-600',              label: 'Idle',       pulse: false },
  monitoring: { dot: 'bg-violet-500',            label: 'Monitoring', pulse: false },
  checking:   { dot: 'bg-amber-500 animate-pulse', label: 'Checking…', pulse: false },
  recording:  { dot: 'bg-green-500',             label: 'Recording',  pulse: true  },
  error:      { dot: 'bg-red-500',               label: 'Error',      pulse: false },
}

export default function Sidebar({ currentPage, onNavigate, status = 'idle', updateInfo }) {
  const st = STATUS[status] ?? STATUS.idle

  const handleUpdate = () => {
    if (updateInfo?.downloadUrl) window.cueflow?.update?.download(updateInfo.downloadUrl)
  }

  return (
    <aside className="w-52 flex flex-col bg-zinc-900 border-r border-zinc-800 flex-shrink-0">
      <nav className="flex-1 p-2.5 space-y-0.5 pt-3">
        {NAV.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => onNavigate(id)}
            className={`
              w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-left
              ${currentPage === id
                ? 'bg-violet-600/15 text-violet-400'
                : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/70'
              }
            `}
          >
            <Icon size={15} strokeWidth={currentPage === id ? 2 : 1.75} />
            {label}
          </button>
        ))}
      </nav>

      <div className="p-3 space-y-2 border-t border-zinc-800/60">

        {/* Update notification */}
        {updateInfo && (
          <button
            onClick={handleUpdate}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-violet-600/15 border border-violet-500/30 hover:bg-violet-600/25 transition-colors text-left"
          >
            <Download size={13} className="text-violet-400 flex-shrink-0" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-violet-300">Update available</p>
              <p className="text-xs text-violet-500/70">v{updateInfo.version} — download</p>
            </div>
          </button>
        )}

        {/* Donate */}
        <button
          onClick={() => window.cueflow?.shell.openExternal('https://www.paypal.com/donate?business=dsbamarasinghe1234@gmail.com&currency_code=USD&amount=5')}
          className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-zinc-600 hover:text-pink-400 hover:bg-pink-500/8 transition-colors"
        >
          <Heart size={13} />
          <span className="text-xs">Support Cueflow</span>
        </button>

        {/* Engine status */}
        <div className="flex items-center gap-2.5 px-3 py-1">
          <div className={`w-2 h-2 rounded-full flex-shrink-0 ${st.dot} ${st.pulse ? 'animate-pulse' : ''}`} />
          <span className="text-xs text-zinc-600">{st.label}</span>
        </div>
      </div>
    </aside>
  )
}
