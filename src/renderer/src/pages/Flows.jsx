import React, { useState, useEffect, useCallback } from 'react'
import { Plus, CheckCircle2, Circle, AlertTriangle, Trash2, Edit2, Zap } from 'lucide-react'
import FlowEditor from '../components/FlowEditor'

function statusIcon(status) {
  if (status === 'completed') return <CheckCircle2 size={13} className="text-green-500" />
  if (status === 'running')   return <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse mt-0.5" />
  if (status === 'failed')    return <AlertTriangle size={13} className="text-red-500" />
  if (status === 'cancelled') return <Circle size={13} className="text-zinc-700" />
  return <Circle size={13} className="text-zinc-600" />
}

function formatDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) +
    ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

function FlowCard({ flow, tasks, onToggle, onEdit, onDelete }) {
  const [expanded, setExpanded] = useState(false)
  const flowTasks = tasks.filter(t => t.flowId === flow.id)
  const pendingTasks = flowTasks.filter(t => t.status === 'pending')
  const runningTask = flowTasks.find(t => t.status === 'running')

  return (
    <div className={`rounded-xl border transition-all ${flow.enabled ? 'border-zinc-800' : 'border-zinc-800/50 opacity-70'} bg-zinc-900`}>
      <div className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none" onClick={() => setExpanded(v => !v)}>
        {/* Enable toggle */}
        <div
          onClick={e => { e.stopPropagation(); onToggle(flow.id, !flow.enabled) }}
          className={`relative flex-shrink-0 w-9 h-5 rounded-full transition-colors cursor-pointer ${flow.enabled ? 'bg-violet-600' : 'bg-zinc-700'}`}
        >
          <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${flow.enabled ? 'translate-x-4' : ''}`} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-zinc-100 truncate">{flow.name}</span>
            {runningTask && (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-500/15 text-green-400 text-xs flex-shrink-0">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" /> Recording
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-600 mt-0.5 truncate">
            {flow.trigger?.subjectContains ? `"${flow.trigger.subjectContains}"` : 'Any subject'}
            {flow.trigger?.senderContains ? ` from ${flow.trigger.senderContains}` : ''}
            {' · '}{flow.trigger?.meetingType || 'zoom'}
            {' · '}{flow.schedule?.fallbackTime || '--:--'}
            {flow.schedule?.fallbackTimezone ? ' ' + flow.schedule.fallbackTimezone.split('/').pop() : ''}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {pendingTasks.length > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-violet-600/20 text-violet-400 text-xs">
              {pendingTasks.length} scheduled
            </span>
          )}
          <button onClick={e => { e.stopPropagation(); onEdit(flow) }}
            className="w-7 h-7 flex items-center justify-center rounded text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800 transition-colors">
            <Edit2 size={12} />
          </button>
          <button onClick={e => { e.stopPropagation(); onDelete(flow.id) }}
            className="w-7 h-7 flex items-center justify-center rounded text-zinc-600 hover:text-red-400 hover:bg-red-500/10 transition-colors">
            <Trash2 size={12} />
          </button>
          <span className={`text-xs text-zinc-600 transition-transform inline-block ${expanded ? 'rotate-180' : ''}`}>▾</span>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-zinc-800/60 px-4 py-3 space-y-2">
          {flowTasks.length === 0 ? (
            <p className="text-xs text-zinc-600 py-1">No tasks yet — waiting for matching emails</p>
          ) : (
            flowTasks.slice().reverse().slice(0, 10).map(task => (
              <div key={task.id} className="flex items-start gap-2.5">
                <div className="mt-0.5 flex-shrink-0">{statusIcon(task.status)}</div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-zinc-300 truncate">{task.meetingTitle || task.emailSubject || 'Meeting'}</p>
                  <p className="text-xs text-zinc-600 mt-0.5">{formatDate(task.scheduledAt)} · {task.source}</p>
                </div>
                <span className={`text-xs capitalize flex-shrink-0 ${
                  task.status === 'pending' ? 'text-amber-500' :
                  task.status === 'running' ? 'text-green-400' :
                  task.status === 'completed' ? 'text-zinc-500' :
                  task.status === 'failed' ? 'text-red-400' : 'text-zinc-700'
                }`}>{task.status}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

export default function Flows() {
  const [flows, setFlows] = useState([])
  const [tasks, setTasks] = useState([])
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingFlow, setEditingFlow] = useState(null)

  const load = useCallback(async () => {
    const [f, t] = await Promise.all([
      window.cueflow?.flows.getAll() ?? [],
      window.cueflow?.tasks.getAll() ?? []
    ])
    setFlows(f); setTasks(t)
  }, [])

  useEffect(() => {
    load()
    const unsub = window.cueflow?.on.taskScheduled(() => load())
    const unsub2 = window.cueflow?.on.taskCompleted(() => load())
    return () => { unsub?.(); unsub2?.() }
  }, [load])

  const handleToggle = async (id, enabled) => {
    await window.cueflow?.flows.toggle(id, enabled)
    setFlows(prev => prev.map(f => f.id === id ? { ...f, enabled } : f))
  }

  const handleDelete = async (id) => {
    if (!confirm('Delete this flow? Scheduled tasks will be cancelled.')) return
    await window.cueflow?.flows.delete(id)
    setFlows(prev => prev.filter(f => f.id !== id))
  }

  const handleSave = async (flow) => {
    const saved = await window.cueflow?.flows.save(flow)
    setFlows(prev => {
      const idx = prev.findIndex(f => f.id === saved.id)
      return idx !== -1 ? prev.map(f => f.id === saved.id ? saved : f) : [...prev, saved]
    })
    setEditorOpen(false); setEditingFlow(null)
  }

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">Flows</h1>
          <p className="text-xs text-zinc-600 mt-0.5">
            {flows.length} flow{flows.length !== 1 ? 's' : ''} · {flows.filter(f => f.enabled).length} active
          </p>
        </div>
        <button
          onClick={() => { setEditingFlow(null); setEditorOpen(true) }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 text-xs font-medium text-white transition-colors"
        >
          <Plus size={12} /> New Flow
        </button>
      </div>

      {flows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="w-12 h-12 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-4">
            <Zap size={20} className="text-zinc-600" />
          </div>
          <p className="text-sm font-medium text-zinc-400">No flows yet</p>
          <p className="text-xs text-zinc-600 mt-1 max-w-xs">
            Create a flow to monitor emails and automatically record meetings.
          </p>
          <button
            onClick={() => { setEditingFlow(null); setEditorOpen(true) }}
            className="mt-4 flex items-center gap-1.5 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-sm font-medium text-white transition-colors"
          >
            <Plus size={13} /> Create your first flow
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {flows.map(flow => (
            <FlowCard key={flow.id} flow={flow} tasks={tasks}
              onToggle={handleToggle} onEdit={f => { setEditingFlow(f); setEditorOpen(true) }} onDelete={handleDelete} />
          ))}
        </div>
      )}

      <FlowEditor
        flow={editingFlow}
        isOpen={editorOpen}
        onClose={() => { setEditorOpen(false); setEditingFlow(null) }}
        onSave={handleSave}
      />
    </div>
  )
}
