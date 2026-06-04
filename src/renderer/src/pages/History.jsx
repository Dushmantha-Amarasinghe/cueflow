import React, { useState, useEffect } from 'react'
import { Search, FolderOpen, Video, Trash2 } from 'lucide-react'

function formatDur(secs) {
  if (!secs) return '—'
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function formatSize(bytes) {
  if (!bytes) return '—'
  if (bytes > 1e9) return (bytes / 1e9).toFixed(1) + ' GB'
  return Math.round(bytes / 1e6) + ' MB'
}

function formatDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function formatTime(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

export default function History() {
  const [search, setSearch] = useState('')
  const [history, setHistory] = useState([])

  const load = () => window.cueflow?.history.getAll().then(h => setHistory(h || []))

  useEffect(() => {
    load()
    // Refresh when a recording finishes
    const unsub = window.cueflow?.on.taskCompleted?.(() => load())
    return unsub
  }, [])

  const filtered = history.filter(r =>
    r.flowName?.toLowerCase().includes(search.toLowerCase()) ||
    formatDate(r.startedAt).toLowerCase().includes(search.toLowerCase())
  )

  const handleClear = async () => {
    if (!confirm('Clear all history? Recording files are NOT deleted.')) return
    await window.cueflow?.history.clear(0)
    setHistory([])
  }

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">History</h1>
          <p className="text-xs text-zinc-600 mt-0.5">{history.length} recording{history.length !== 1 ? 's' : ''}</p>
        </div>
        {history.length > 0 && (
          <button onClick={handleClear}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-zinc-600 hover:text-red-400 hover:bg-red-500/10 text-xs transition-colors">
            <Trash2 size={12} /> Clear all
          </button>
        )}
      </div>

      <div className="relative max-w-sm">
        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by flow or date…"
          className="w-full pl-8 pr-4 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-sm text-zinc-100 placeholder-zinc-700 focus:outline-none focus:border-violet-600/60 transition-colors"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="py-14 text-center">
          <p className="text-sm text-zinc-600">{history.length === 0 ? 'No recordings yet' : 'No results'}</p>
          {history.length === 0 && <p className="text-xs text-zinc-700 mt-1">Recordings will appear here after they complete</p>}
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/60">
                {['Flow', 'Date', 'Duration', 'Size', ''].map(h => (
                  <th key={h} className="text-left px-4 py-2.5 text-xs font-medium text-zinc-600 uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="bg-zinc-900">
              {filtered.map((rec, i) => (
                <tr key={rec.id} className={`hover:bg-zinc-800/40 transition-colors ${i < filtered.length - 1 ? 'border-b border-zinc-800/50' : ''}`}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Video size={12} className="text-violet-500 flex-shrink-0" />
                      <span className="text-zinc-200">{rec.flowName}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-zinc-300">{formatDate(rec.startedAt)}</p>
                    <p className="text-xs text-zinc-600 mt-0.5">{formatTime(rec.startedAt)} → {formatTime(rec.endedAt)}</p>
                  </td>
                  <td className="px-4 py-3 text-zinc-400">{formatDur(rec.durationSeconds)}</td>
                  <td className="px-4 py-3 text-zinc-600">{formatSize(rec.fileSizeBytes)}</td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => window.cueflow?.shell.showInFolder(rec.recordingPath)}
                      title="Show in folder"
                      className="w-7 h-7 flex items-center justify-center rounded text-zinc-700 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
                    >
                      <FolderOpen size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
