import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('cueflow', {
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close:    () => ipcRenderer.send('window:close')
  },

  app: {
    getState: () => ipcRenderer.invoke('app:getState')
  },

  settings: {
    get:             ()       => ipcRenderer.invoke('settings:get'),
    save:            (s)      => ipcRenderer.invoke('settings:save', s),
    patchRecording:  (rec)    => ipcRenderer.invoke('settings:patchRecording', rec),
    testGmail:       (creds)  => ipcRenderer.invoke('settings:testGmail', creds),
    testTelegram:    (creds)  => ipcRenderer.invoke('settings:testTelegram', creds)
  },

  flows: {
    getAll: ()           => ipcRenderer.invoke('flows:getAll'),
    save:   (flow)       => ipcRenderer.invoke('flows:save', flow),
    delete: (id)         => ipcRenderer.invoke('flows:delete', id),
    toggle: (id, en)     => ipcRenderer.invoke('flows:toggle', id, en)
  },

  tasks: {
    getAll: ()   => ipcRenderer.invoke('tasks:getAll'),
    cancel: (id) => ipcRenderer.invoke('tasks:cancel', id)
  },

  history: {
    getAll: ()     => ipcRenderer.invoke('history:getAll'),
    clear:  (days) => ipcRenderer.invoke('history:clear', days)
  },

  engine: {
    getStatus:      () => ipcRenderer.invoke('engine:getStatus'),
    restart:        () => ipcRenderer.invoke('engine:restart'),
    checkNow:       () => ipcRenderer.invoke('engine:checkNow'),
    stopRecording:  () => ipcRenderer.invoke('engine:stopRecording')
  },

  meeting: {
    openAndRecord: (url) => ipcRenderer.invoke('meeting:openAndRecord', url)
  },

  storage: {
    encrypt: (text) => ipcRenderer.invoke('storage:encrypt', text),
    decrypt: (enc)  => ipcRenderer.invoke('storage:decrypt', enc)
  },

  power: {
    prevent: () => ipcRenderer.invoke('power:prevent'),
    release: () => ipcRenderer.invoke('power:release')
  },

  shell: {
    openPath:     (p)   => ipcRenderer.invoke('shell:openPath', p),
    showInFolder: (p)   => ipcRenderer.invoke('shell:showInFolder', p),
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url)
  },

  dialog: {
    selectFolder: () => ipcRenderer.invoke('dialog:selectFolder')
  },

  tray: {
    setState: (state, info) => ipcRenderer.send('tray:setState', state, info)
  },

  screen: {
    getSources: () => ipcRenderer.invoke('screen:getSources')
  },

  audio: {
    getDevices: () => ipcRenderer.invoke('audio:getDevices')
  },

  recordings: {
    getDefaultPath: () => ipcRenderer.invoke('recordings:getDefaultPath')
  },

  on: {
    navigate: (cb) => {
      const h = (_, page) => cb(page)
      ipcRenderer.on('navigate', h)
      return () => ipcRenderer.removeListener('navigate', h)
    },
    stateChanged: (cb) => {
      const h = (_, data) => cb(data)
      ipcRenderer.on('state:changed', h)
      return () => ipcRenderer.removeListener('state:changed', h)
    },
    action: (cb) => {
      const h = (_, name) => cb(name)
      ipcRenderer.on('action', h)
      return () => ipcRenderer.removeListener('action', h)
    },
    engineStatus: (cb) => {
      const h = (_, data) => cb(data)
      ipcRenderer.on('engine:status', h)
      return () => ipcRenderer.removeListener('engine:status', h)
    },
    taskScheduled: (cb) => {
      const h = (_, t) => cb(t)
      ipcRenderer.on('engine:task-scheduled', h)
      return () => ipcRenderer.removeListener('engine:task-scheduled', h)
    },
    taskRunning: (cb) => {
      const h = (_, t) => cb(t)
      ipcRenderer.on('engine:task-running', h)
      return () => ipcRenderer.removeListener('engine:task-running', h)
    },
    taskCompleted: (cb) => {
      const h = (_, t) => cb(t)
      ipcRenderer.on('engine:task-completed', h)
      return () => ipcRenderer.removeListener('engine:task-completed', h)
    },
    updateAvailable: (cb) => {
      const h = (_, info) => cb(info)
      ipcRenderer.on('update:available', h)
      return () => ipcRenderer.removeListener('update:available', h)
    }
  },

  update: {
    check:    ()    => ipcRenderer.invoke('update:check'),
    download: (url) => ipcRenderer.invoke('update:download', url)
  },

  // Renderer-side screen recording bridge
  recorder: {
    onStart: (cb) => {
      const h = (_, opts) => cb(opts)
      ipcRenderer.on('recorder:start', h)
      return () => ipcRenderer.removeListener('recorder:start', h)
    },
    onStop: (cb) => {
      const h = () => cb()
      ipcRenderer.on('recorder:stop', h)
      return () => ipcRenderer.removeListener('recorder:stop', h)
    },
    started: (reply) => ipcRenderer.send('recorder:started', reply),
    stopped: ()      => ipcRenderer.send('recorder:stopped'),
    chunk:   (buf)   => ipcRenderer.send('recorder:chunk', buf)
  }
})
