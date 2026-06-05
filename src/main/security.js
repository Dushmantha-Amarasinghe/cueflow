// Centralised URL safety checks.

// Schemes we allow to be opened via shell.openExternal. Blocks dangerous ones
// like file:, javascript:, data:, vbscript: that could be smuggled in from a
// parsed email or a tricked renderer.
const OPEN_SCHEMES = new Set(['https:', 'http:', 'mailto:', 'zoommtg:', 'msteams:'])

export function isAllowedExternalUrl(url) {
  try {
    return OPEN_SCHEMES.has(new URL(String(url)).protocol)
  } catch {
    return false
  }
}

// SSRF guard for fetching attacker-influenced URLs (e.g. "Add to Calendar"
// links pulled out of an email body). Legit calendar links are always public
// https domains, so we block:
//   - non-http(s) schemes
//   - localhost / *.local / *.internal
//   - raw IP-literal hosts (used to reach internal services / cloud metadata)
export function isSafeFetchUrl(url) {
  try {
    const u = new URL(String(url))
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
    const host = u.hostname.toLowerCase()
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false  // IPv4 literal (e.g. 169.254.169.254)
    if (host.includes(':') || host.startsWith('[')) return false  // IPv6 literal
    return true
  } catch {
    return false
  }
}
