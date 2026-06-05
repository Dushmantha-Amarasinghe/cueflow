import schedule from 'node-schedule'
import { store } from '../store.js'

class Scheduler {
  _jobs = new Map() // taskId → schedule.Job
  _onFire = null    // (task) => void — set by engine

  setHandler(fn) { this._onFire = fn }

  // Restore pending tasks from storage + reconcile stale state left by a restart
  restore() {
    const tasks = store.read('tasks', [])
    const history = store.read('history', [])
    const now = new Date()
    let restored = 0, reconciled = 0

    for (const task of tasks) {
      // A task still marked 'running' means the app was restarted mid-recording —
      // the in-memory runner is gone, so it can never finish on its own.
      // Reconcile: 'completed' if a recording was saved, else 'interrupted'.
      if (task.status === 'running') {
        task.status = history.some(h => h.taskId === task.id) ? 'completed' : 'interrupted'
        reconciled++
        continue
      }
      // A 'pending' task whose time passed while the app was closed will never fire.
      if (task.status === 'pending' && new Date(task.scheduledAt) <= now) {
        task.status = 'missed'
        reconciled++
        continue
      }
      if (task.status === 'pending' && new Date(task.scheduledAt) > now) {
        this._schedule(task)
        restored++
      }
    }

    if (reconciled) store.write('tasks', tasks)
    if (restored)   console.log(`[scheduler] Restored ${restored} pending task(s)`)
    if (reconciled) console.log(`[scheduler] Reconciled ${reconciled} stale task(s)`)
  }

  add(task) {
    const tasks = store.read('tasks', [])
    tasks.push(task)
    store.write('tasks', tasks)
    this._schedule(task)
    console.log(`[scheduler] Scheduled "${task.meetingTitle || task.flowName}" at ${task.scheduledAt}`)
  }

  cancel(taskId) {
    const job = this._jobs.get(taskId)
    if (job) { job.cancel(); this._jobs.delete(taskId) }

    const tasks = store.read('tasks', [])
    const idx = tasks.findIndex(t => t.id === taskId)
    if (idx !== -1) {
      tasks[idx] = { ...tasks[idx], status: 'cancelled' }
      store.write('tasks', tasks)
    }
  }

  updateStatus(taskId, status, extra = {}) {
    const tasks = store.read('tasks', [])
    const idx = tasks.findIndex(t => t.id === taskId)
    if (idx !== -1) {
      tasks[idx] = { ...tasks[idx], status, ...extra }
      store.write('tasks', tasks)
    }
  }

  stopAll() {
    for (const job of this._jobs.values()) job.cancel()
    this._jobs.clear()
  }

  _schedule(task) {
    const date = new Date(task.scheduledAt)
    if (date <= new Date()) return // already past

    const job = schedule.scheduleJob(date, () => {
      this._jobs.delete(task.id)
      this._onFire?.(task)
    })
    if (job) this._jobs.set(task.id, job)
  }
}

export const scheduler = new Scheduler()
