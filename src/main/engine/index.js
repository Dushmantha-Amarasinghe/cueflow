import EventEmitter from 'events'
import { store } from '../store.js'
import { getDecryptedSettings } from '../credentials.js'
import { fetchNewEmails, testGmailConnection } from './imap.js'
import { emailMatchesFlow, createTasksFromEmail } from './parser.js'
import { scheduler } from './scheduler.js'
import { runner } from './runner.js'
import { recorder } from './recorder.js'

// Turn raw IMAP/TLS errors into clear, actionable guidance for the dashboard.
function friendlyError(msg) {
  const m = String(msg || '')
  if (/self.?signed|certificate|unable to (get|verify)|cert|CERT_|tls/i.test(m)) {
    return 'Your antivirus or network is inspecting HTTPS. Open Settings → Connections and turn on “Allow insecure TLS” to fix this.'
  }
  if (/auth|credential|invalid|login|AUTHENTICATIONFAILED|application-specific|app password/i.test(m)) {
    return 'Gmail sign-in failed — check your email and App Password in Settings → Connections.'
  }
  return m
}

class Engine extends EventEmitter {
  state = 'stopped' // stopped | starting | running | error
  error = null
  _checkTimer = null
  _lastCheck = null
  _checking = false

  async start() {
    if (this.state === 'running') return

    runner.setEmitter(this)
    scheduler.setHandler(task => this._runTask(task))

    // Forward runner events with state changes
    this.on('task:running', task => {
      this.emit('status:update')
    })
    this.on('task:completed', task => {
      this.emit('status:update')
    })
    this.on('task:failed', task => {
      this.emit('status:update')
    })

    scheduler.restore()

    const settings = getDecryptedSettings()
    if (settings.gmail?.email && settings.gmail?.password) {
      this.state = 'running'
      this.error = null
      const intervalMin = settings.general?.checkIntervalMinutes ?? 5
      this._startPolling(intervalMin)
    } else {
      this.state = 'error'
      this.error = 'Gmail not configured — go to Settings → Connections'
    }

    this.emit('status:update')
    console.log('[engine] Started, state:', this.state)
  }

  async stop() {
    this._stopPolling()
    scheduler.stopAll()
    this.state = 'stopped'
    this.error = null
    this.emit('status:update')
  }

  async restart() {
    await this.stop()
    await this.start()
  }

  async checkNow() {
    if (this._checking) return
    this._checking = true
    this.emit('status:update')

    try {
      const settings = getDecryptedSettings()
      if (!settings.gmail?.email) throw new Error('Gmail not configured')

      const since = this._lastCheck
      const emails = await fetchNewEmails(settings.gmail, since)
      this._lastCheck = new Date()

      // Track processed messageIds so the same email is never scheduled twice
      const seen = new Set(store.read('processedEmails', []))
      const flows = store.read('flows', []).filter(f => f.enabled)
      const existingTasks = store.read('tasks', [])
      let scheduled = 0

      for (const email of emails) {
        if (email.messageId && seen.has(email.messageId)) continue

        for (const flow of flows) {
          if (emailMatchesFlow(email, flow)) {
            this.emit('email:matched', { subject: email.subject, from: email.from, flowName: flow.name })
            const tasks = await createTasksFromEmail(email, flow, existingTasks)
            for (const task of tasks) {
              scheduler.add(task)
              existingTasks.push(task)
              this.emit('task:scheduled', task)
              scheduled++
            }
          }
        }
        // Mark this email as processed regardless of whether it matched
        if (email.messageId) seen.add(email.messageId)
      }

      // Persist processed messageIds (keep last 2000 to avoid unbounded growth)
      store.write('processedEmails', [...seen].slice(-2000))

      console.log(`[engine] Checked ${emails.length} email(s), scheduled ${scheduled} task(s)`)
    } catch (err) {
      console.error('[engine] Check failed:', err.message)
      if (this.state === 'running') {
        this.error = friendlyError(err.message)
        this.emit('status:update')
      }
    } finally {
      this._checking = false
      this.emit('status:update')
    }
  }

  _runTask(task) {
    const flow = store.read('flows', []).find(f => f.id === task.flowId)
    runner.run(task, flow)
  }

  _startPolling(intervalMinutes) {
    this._stopPolling()
    // Immediate check on start
    this.checkNow()
    this._checkTimer = setInterval(() => this.checkNow(), intervalMinutes * 60 * 1000)
  }

  _stopPolling() {
    if (this._checkTimer) { clearInterval(this._checkTimer); this._checkTimer = null }
  }

  async testGmail(creds) {
    const r = await testGmailConnection(creds)
    if (!r.success) r.error = friendlyError(r.error)
    return r
  }

  async testTelegram(creds) {
    if (!creds.botToken) return { success: false, error: 'Bot token is required' }
    try {
      const res = await fetch(`https://api.telegram.org/bot${creds.botToken}/getMe`)
      const data = await res.json()
      if (data.ok) return { success: true, botName: data.result.first_name }
      return { success: false, error: data.description }
    } catch (err) {
      return { success: false, error: err.message }
    }
  }

  stopRecording() { runner.stop() }

  closeMeeting(url) { return runner.closeApp(url) }

  async openAndRecord(url) {
    const manualTask = {
      id: crypto.randomUUID(),
      flowId: 'manual',
      flowName: 'Manual',
      emailSubject: '',
      emailFrom: '',
      meetingUrl: url,
      meetingTitle: 'Manual meeting',
      source: 'manual',
      scheduledAt: new Date().toISOString(),
      stopAt: null,
      status: 'pending',
      createdAt: new Date().toISOString()
    }
    const tasks = store.read('tasks', [])
    tasks.push(manualTask)
    store.write('tasks', tasks)
    runner.run(manualTask)
  }

  getStatus() {
    const tasks = store.read('tasks', [])
    const pending = tasks.filter(t => t.status === 'pending').sort((a, b) =>
      new Date(a.scheduledAt) - new Date(b.scheduledAt)
    )
    const flows = store.read('flows', [])

    return {
      state: this.state,
      error: this.error,
      checking: this._checking,
      lastCheck: this._lastCheck?.toISOString() ?? null,
      isRecording: runner.isRunning,
      recordingActive: recorder.isRecording,
      recordingStartedAt: recorder.startedAt?.toISOString() ?? null,
      activeTaskId: runner.activeTaskId,
      pendingCount: pending.length,
      nextTask: pending[0] ?? null,
      activeFlowCount: flows.filter(f => f.enabled).length
    }
  }
}

export const engine = new Engine()
