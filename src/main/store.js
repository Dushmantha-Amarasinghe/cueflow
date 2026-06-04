import { app } from 'electron'
import path from 'path'
import fs from 'fs'

let _dir = null

function dir() {
  if (!_dir) {
    _dir = path.join(app.getPath('userData'), 'cueflow-data')
    fs.mkdirSync(_dir, { recursive: true })
  }
  return _dir
}

export const store = {
  read(name, defaults = null) {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir(), name + '.json'), 'utf8'))
    } catch {
      return defaults
    }
  },
  write(name, data) {
    fs.writeFileSync(path.join(dir(), name + '.json'), JSON.stringify(data, null, 2), 'utf8')
  },
  path(name) {
    return path.join(dir(), name + '.json')
  }
}
