const { Tray, Menu, app } = require('electron')
const { createTrayIcon } = require('./icons')

let tray = null
let currentState = 'idle'
let currentInfo = null
let windowRef = null

function createTray(win) {
  windowRef = win
  tray = new Tray(createTrayIcon('idle'))
  tray.setToolTip('Cueflow — Idle')
  updateContextMenu()

  tray.on('click', () => {
    if (win.isVisible()) {
      win.focus()
    } else {
      win.show()
      win.focus()
    }
  })

  return tray
}

function updateTrayState(state, info = null) {
  if (!tray) return
  currentState = state
  currentInfo = info
  tray.setImage(createTrayIcon(state))

  const tooltips = {
    idle:      'Cueflow — Idle',
    active:    info?.flowName ? `Cueflow — ${info.flowName} starting...` : 'Cueflow — Active',
    recording: info?.flowName ? `Cueflow — Recording: ${info.flowName}` : 'Cueflow — Recording',
    error:     info?.message  ? `Cueflow — Error: ${info.message}`     : 'Cueflow — Error'
  }
  tray.setToolTip(tooltips[state] ?? 'Cueflow')
  updateContextMenu()
}

function updateContextMenu() {
  const template = []

  if (currentState === 'recording' && currentInfo?.flowName) {
    template.push({
      label: `● Recording: ${currentInfo.flowName}`,
      enabled: false
    })
    template.push({ type: 'separator' })
  }

  template.push({
    label: 'Open Cueflow',
    click: () => { windowRef?.show(); windowRef?.focus() }
  })

  template.push({
    label: 'Flows',
    click: () => {
      windowRef?.show()
      windowRef?.focus()
      windowRef?.webContents.send('navigate', 'flows')
    }
  })

  template.push({
    label: 'Check email now',
    click: () => windowRef?.webContents.send('action', 'checkEmail')
  })

  if (currentState === 'recording') {
    template.push({ type: 'separator' })
    template.push({
      label: 'Stop recording',
      click: () => windowRef?.webContents.send('action', 'stopRecording')
    })
  }

  template.push({ type: 'separator' })
  template.push({ label: 'Exit', click: () => app.quit() })

  tray.setContextMenu(Menu.buildFromTemplate(template))
}

function destroyTray() {
  tray?.destroy()
  tray = null
}

module.exports = { createTray, updateTrayState, destroyTray }
