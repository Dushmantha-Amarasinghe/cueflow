// Clears ELECTRON_RUN_AS_NODE before starting electron-vite dev.
// Needed when developing inside VS Code / Claude Code (Electron-based editors)
// which inherit ELECTRON_RUN_AS_NODE=1 into all child processes.

const { spawnSync } = require('child_process')
const path = require('path')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

// Use npx to invoke electron-vite (handles Windows .cmd transparently)
const result = spawnSync('npx', ['electron-vite', 'dev'], {
  stdio: 'inherit',
  env,
  shell: true,
  cwd: path.join(__dirname, '..')
})

process.exit(result.status ?? 1)
