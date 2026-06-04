import React, { useState, useEffect } from 'react'
import { X, Plus, Trash2 } from 'lucide-react'

const TIMEZONES = [
  { value: 'UTC',                 label: 'UTC' },
  { value: 'America/New_York',    label: 'Eastern (UTC-5/-4)' },
  { value: 'America/Chicago',     label: 'Central (UTC-6/-5)' },
  { value: 'America/Denver',      label: 'Mountain (UTC-7/-6)' },
  { value: 'America/Los_Angeles', label: 'Pacific (UTC-8/-7)' },
  { value: 'America/Sao_Paulo',   label: 'Brasília (UTC-3)' },
  { value: 'Europe/London',       label: 'London (UTC+0/+1)' },
  { value: 'Europe/Paris',        label: 'Central Europe (UTC+1/+2)' },
  { value: 'Europe/Istanbul',     label: 'Istanbul (UTC+3)' },
  { value: 'Asia/Dubai',          label: 'Dubai (UTC+4)' },
  { value: 'Asia/Karachi',        label: 'Pakistan (UTC+5)' },
  { value: 'Asia/Kolkata',        label: 'India (UTC+5:30)' },
  { value: 'Asia/Colombo',        label: 'Sri Lanka (UTC+5:30)' },
  { value: 'Asia/Dhaka',          label: 'Bangladesh (UTC+6)' },
  { value: 'Asia/Bangkok',        label: 'SE Asia (UTC+7)' },
  { value: 'Asia/Singapore',      label: 'Singapore (UTC+8)' },
  { value: 'Asia/Tokyo',          label: 'Japan (UTC+9)' },
  { value: 'Australia/Sydney',    label: 'Sydney (UTC+10/+11)' },
  { value: 'Pacific/Auckland',    label: 'New Zealand (UTC+12/+13)' },
]

const BLANK_FLOW = {
  name: '',
  enabled: true,
  trigger: {
    senderContains: '',
    subjectContains: '',
    meetingType: 'zoom'
  },
  schedule: {
    fallbackTime: '18:00',
    fallbackTimezone: 'Asia/Colombo',
    preferICS: true,
    gracePeriodMinutes: 45,
    stopMode: 'window-close',
    maxDurationMinutes: null
  },
  cooldownMinutes: 60
}

function Field({ label, hint, children }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium text-zinc-400">{label}</label>
      {hint && <p className="text-xs text-zinc-600">{hint}</p>}
      {children}
    </div>
  )
}

function Input({ ...props }) {
  return (
    <input
      {...props}
      className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-sm text-zinc-100 placeholder-zinc-700 focus:outline-none focus:border-violet-600/70 transition-colors"
    />
  )
}

function Select({ children, ...props }) {
  return (
    <select
      {...props}
      className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-sm text-zinc-100 focus:outline-none focus:border-violet-600/70 transition-colors"
    >
      {children}
    </select>
  )
}

function Toggle({ label, checked, onChange }) {
  return (
    <label className="flex items-center gap-3 cursor-pointer">
      <div
        onClick={() => onChange(!checked)}
        className={`relative w-9 h-5 rounded-full transition-colors ${checked ? 'bg-violet-600' : 'bg-zinc-700'}`}
      >
        <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : 'translate-x-0'}`} />
      </div>
      <span className="text-sm text-zinc-300">{label}</span>
    </label>
  )
}

export default function FlowEditor({ flow: initialFlow, isOpen, onClose, onSave }) {
  const [flow, setFlow] = useState(BLANK_FLOW)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (isOpen) {
      setFlow(initialFlow ? JSON.parse(JSON.stringify(initialFlow)) : { ...BLANK_FLOW, id: undefined })
      setError('')
    }
  }, [isOpen, initialFlow])

  const set = (path, value) => {
    setFlow(prev => {
      const next = JSON.parse(JSON.stringify(prev))
      const parts = path.split('.')
      let obj = next
      for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]]
      obj[parts[parts.length - 1]] = value
      return next
    })
  }

  const handleSave = async () => {
    if (!flow.name.trim()) { setError('Flow name is required'); return }
    setSaving(true)
    try {
      const toSave = { ...flow, id: flow.id || crypto.randomUUID() }
      await onSave(toSave)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 z-40 bg-black/60 transition-opacity duration-200 ${isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={onClose}
      />

      {/* Drawer */}
      <div className={`fixed right-0 top-0 bottom-0 z-50 w-[480px] bg-zinc-950 border-l border-zinc-800 flex flex-col transition-transform duration-200 ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-100">
            {initialFlow ? 'Edit Flow' : 'New Flow'}
          </h2>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors">
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {/* Basic */}
          <section className="space-y-4">
            <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Basic</h3>

            <Field label="Flow name">
              <Input
                value={flow.name}
                onChange={e => set('name', e.target.value)}
                placeholder="e.g. CS301 Lectures"
              />
            </Field>

            <Toggle
              label="Enable immediately after saving"
              checked={flow.enabled}
              onChange={v => set('enabled', v)}
            />
          </section>

          {/* Trigger */}
          <section className="space-y-4">
            <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Email trigger</h3>

            <Field label="Sender contains" hint="Partial match on From address. Leave blank to match any sender.">
              <Input
                value={flow.trigger.senderContains}
                onChange={e => set('trigger.senderContains', e.target.value)}
                placeholder="e.g. university.edu"
              />
            </Field>

            <Field label="Subject contains" hint="Partial match on email Subject.">
              <Input
                value={flow.trigger.subjectContains}
                onChange={e => set('trigger.subjectContains', e.target.value)}
                placeholder="e.g. CS301"
              />
            </Field>

            <Field label="Meeting type">
              <Select value={flow.trigger.meetingType} onChange={e => set('trigger.meetingType', e.target.value)}>
                <option value="zoom">Zoom</option>
                <option value="teams">Microsoft Teams</option>
                <option value="meet">Google Meet</option>
                <option value="any">Any meeting link</option>
              </Select>
            </Field>

            {/* Warn when no filters set */}
            {!flow.trigger.senderContains?.trim() && !flow.trigger.subjectContains?.trim() && (
              <div className="flex gap-2 px-3 py-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
                <span className="text-amber-500 flex-shrink-0 text-xs mt-0.5">⚠</span>
                <p className="text-xs text-amber-500/90">
                  No filters set — this flow will match <strong>every</strong> email that contains a {flow.trigger.meetingType === 'any' ? 'meeting' : flow.trigger.meetingType} link.
                  That's fine if you only get one type of meeting email.
                </p>
              </div>
            )}
          </section>

          {/* Schedule */}
          <section className="space-y-4">
            <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Schedule</h3>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Fallback time" hint="Used when no ICS file.">
                <Input
                  type="time"
                  value={flow.schedule.fallbackTime}
                  onChange={e => set('schedule.fallbackTime', e.target.value)}
                />
              </Field>

              <Field label="Timezone">
                <Select value={flow.schedule.fallbackTimezone} onChange={e => set('schedule.fallbackTimezone', e.target.value)}>
                  {TIMEZONES.map(tz => (
                    <option key={tz.value} value={tz.value}>{tz.label}</option>
                  ))}
                </Select>
              </Field>
            </div>

            <Toggle
              label="Prefer ICS time over fallback time"
              checked={flow.schedule.preferICS}
              onChange={v => set('schedule.preferICS', v)}
            />

            <Field label="Grace period" hint="Skip email if it arrives this long after the scheduled time.">
              <Select value={flow.schedule.gracePeriodMinutes} onChange={e => set('schedule.gracePeriodMinutes', Number(e.target.value))}>
                <option value={15}>15 minutes</option>
                <option value={30}>30 minutes</option>
                <option value={45}>45 minutes</option>
                <option value={60}>1 hour</option>
                <option value={9999}>Never skip</option>
              </Select>
            </Field>
          </section>

          {/* Recording stop */}
          <section className="space-y-4">
            <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Stop recording</h3>

            <Field label="Stop mode">
              <Select value={flow.schedule.stopMode} onChange={e => set('schedule.stopMode', e.target.value)}>
                <option value="window-close">When meeting window closes</option>
                <option value="ics-end">At ICS end time (fallback: window close)</option>
                <option value="manual">Manual only (Telegram or UI)</option>
              </Select>
            </Field>
          </section>

          {/* Advanced */}
          <section className="space-y-4">
            <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Advanced</h3>

            <Field label="Minimum gap between meetings" hint="Don't schedule two meetings for this flow unless their times are at least this far apart. Prevents the same lecture being double-booked from reminder emails.">
              <Select value={flow.cooldownMinutes} onChange={e => set('cooldownMinutes', Number(e.target.value))}>
                <option value={30}>30 minutes</option>
                <option value={60}>1 hour</option>
                <option value={120}>2 hours</option>
                <option value={360}>6 hours</option>
                <option value={720}>12 hours</option>
              </Select>
            </Field>
          </section>

          {error && (
            <p className="text-sm text-red-400 bg-red-500/10 rounded-lg px-3 py-2">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-zinc-800 flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 rounded-lg border border-zinc-800 text-sm text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-sm font-medium text-white transition-colors"
          >
            {saving ? 'Saving…' : initialFlow ? 'Save changes' : 'Create flow'}
          </button>
        </div>
      </div>
    </>
  )
}
