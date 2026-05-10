export const DEFAULT_SERVER_ORIGIN = 'http://127.0.0.1:4096'
export const DEFAULT_BROWSER_RELAY_ORIGIN = DEFAULT_SERVER_ORIGIN
export const BROWSER_RELAY_ORIGIN_STORAGE_KEY = 'browserRelayOrigin'
export const LEGACY_SERVER_ORIGIN_STORAGE_KEY = 'serverOrigin'
export const SERVER_ORIGIN_STORAGE_KEY = BROWSER_RELAY_ORIGIN_STORAGE_KEY
export const LEGACY_WEB_UI_URL_STORAGE_KEY = 'webUiUrl'
export const LEGACY_RELAY_URL_STORAGE_KEY = 'relayUrl'
export const SIDE_PANEL_OPEN_NONCE_STORAGE_KEY = 'sidePanelOpenNonce'
export const BROWSER_AGENT_ID_STORAGE_KEY = 'browserAgentId'

export interface StoredServerConfig {
  browserRelayOrigin?: unknown
  serverOrigin?: unknown
  webUiUrl?: unknown
  relayUrl?: unknown
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase()
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
}

function isPrivateIpv4(hostname: string): boolean {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!match) return false
  const octets = match.slice(1).map(Number)
  if (octets.some((value) => Number.isNaN(value) || value < 0 || value > 255)) return false

  const [a, b] = octets
  if (a === 10) return true
  if (a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase()
  if (!normalized.includes(':')) return false
  if (normalized === '::1') return true
  return normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe8')
    || normalized.startsWith('fe9')
    || normalized.startsWith('fea')
    || normalized.startsWith('feb')
}

function isLikelyIntranetHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase()
  if (!normalized) return false
  if (!normalized.includes('.')) return true

  const allowedSuffixes = [
    '.local',
    '.lan',
    '.internal',
    '.home',
    '.corp',
    '.localdomain',
  ]

  return allowedSuffixes.some((suffix) => normalized.endsWith(suffix))
}

export function isAllowedServerOrigin(url: URL): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (isLoopbackHostname(url.hostname)) return true
  if (isPrivateIpv4(url.hostname)) return true
  if (isPrivateIpv6(url.hostname)) return true
  return isLikelyIntranetHostname(url.hostname)
}

export function normalizeServerOrigin(serverOrigin: string, fallback = DEFAULT_SERVER_ORIGIN): string {
  try {
    const parsed = new URL(serverOrigin.trim())
    if (!isAllowedServerOrigin(parsed)) return fallback
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return fallback
  }
}

export function serverOriginToRelayUrl(serverOrigin: string): string {
  const parsed = new URL(normalizeServerOrigin(serverOrigin))
  const protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${parsed.host}/browser/extension`
}

export function browserRelayOriginToBootstrapUrl(browserRelayOrigin: string): string {
  return `${normalizeServerOrigin(browserRelayOrigin)}/browser/bootstrap`
}

export function browserRelayOriginToExtensionUrl(browserRelayOrigin: string): string {
  return serverOriginToRelayUrl(browserRelayOrigin)
}

export function relayUrlToServerOrigin(relayUrl: string, fallback = DEFAULT_SERVER_ORIGIN): string {
  try {
    const parsed = new URL(relayUrl.trim())
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return fallback
    const protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
    return normalizeServerOrigin(`${protocol}//${parsed.host}`, fallback)
  } catch {
    return fallback
  }
}

export function resolveStoredServerOrigin(stored: StoredServerConfig): string {
  const fromBrowserRelayOrigin = typeof stored.browserRelayOrigin === 'string' && stored.browserRelayOrigin.trim()
    ? normalizeServerOrigin(stored.browserRelayOrigin)
    : ''
  const fromServerOrigin = typeof stored.serverOrigin === 'string' && stored.serverOrigin.trim()
    ? normalizeServerOrigin(stored.serverOrigin)
    : ''
  const fromWebUi = typeof stored.webUiUrl === 'string' && stored.webUiUrl.trim()
    ? normalizeServerOrigin(stored.webUiUrl)
    : ''
  const fromRelay = typeof stored.relayUrl === 'string' && stored.relayUrl.trim()
    ? relayUrlToServerOrigin(stored.relayUrl)
    : ''

  return fromBrowserRelayOrigin || fromServerOrigin || fromWebUi || fromRelay || DEFAULT_SERVER_ORIGIN
}

export function buildWebUiUrl(serverOrigin: string, newSessionNonce?: string): string {
  const url = new URL(normalizeServerOrigin(serverOrigin))
  url.searchParams.set('client', 'browser-extension')
  if (newSessionNonce) {
    url.searchParams.set('newSessionNonce', newSessionNonce)
  }
  return url.toString()
}

export async function readStoredServerOrigin(): Promise<string> {
  const stored = await chrome.storage.sync.get({
    [SERVER_ORIGIN_STORAGE_KEY]: '',
    [LEGACY_SERVER_ORIGIN_STORAGE_KEY]: '',
    [LEGACY_WEB_UI_URL_STORAGE_KEY]: '',
    [LEGACY_RELAY_URL_STORAGE_KEY]: '',
  }) as StoredServerConfig

  const serverOrigin = resolveStoredServerOrigin(stored)
  if (
    serverOrigin !== stored.browserRelayOrigin ||
    Boolean(stored.serverOrigin) ||
    Boolean(stored.webUiUrl) ||
    Boolean(stored.relayUrl)
  ) {
    await chrome.storage.sync.set({ [SERVER_ORIGIN_STORAGE_KEY]: serverOrigin })
    await chrome.storage.sync.remove([
      LEGACY_SERVER_ORIGIN_STORAGE_KEY,
      LEGACY_WEB_UI_URL_STORAGE_KEY,
      LEGACY_RELAY_URL_STORAGE_KEY,
    ])
  }

  return serverOrigin
}

export async function writeStoredServerOrigin(serverOrigin: string): Promise<string> {
  const normalized = normalizeServerOrigin(serverOrigin)
  await chrome.storage.sync.set({ [SERVER_ORIGIN_STORAGE_KEY]: normalized })
  await chrome.storage.sync.remove([
    LEGACY_SERVER_ORIGIN_STORAGE_KEY,
    LEGACY_WEB_UI_URL_STORAGE_KEY,
    LEGACY_RELAY_URL_STORAGE_KEY,
  ])
  return normalized
}
