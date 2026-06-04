import { safeStorage } from 'electron'
import { store } from './store.js'

export function encrypt(plain) {
  if (!plain || !safeStorage.isEncryptionAvailable()) return plain || ''
  return safeStorage.encryptString(plain).toString('base64')
}

export function decrypt(enc) {
  if (!enc || !safeStorage.isEncryptionAvailable()) return enc || ''
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return ''
  }
}

// Returns settings with sensitive fields DECRYPTED, ready for use by the engine.
export function getDecryptedSettings() {
  const s = store.read('settings', {})
  const out = JSON.parse(JSON.stringify(s))
  if (out.gmail?.password) out.gmail.password = decrypt(out.gmail.password)
  if (out.telegram?.botToken) out.telegram.botToken = decrypt(out.telegram.botToken)
  return out
}
