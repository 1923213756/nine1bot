import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_SERVER_ORIGIN,
  browserRelayOriginToBootstrapUrl,
  browserRelayOriginToExtensionUrl,
  buildWebUiUrl,
  normalizeServerOrigin,
  relayUrlToServerOrigin,
  resolveStoredServerOrigin,
  serverOriginToRelayUrl,
} from '../src/shared/server-config'

describe('browser extension relay config', () => {
  it('uses the default local server origin for empty or invalid input', () => {
    expect(normalizeServerOrigin('')).toBe(DEFAULT_SERVER_ORIGIN)
    expect(normalizeServerOrigin('not a url')).toBe(DEFAULT_SERVER_ORIGIN)
    expect(normalizeServerOrigin('https://example.com:4096')).toBe(DEFAULT_SERVER_ORIGIN)
  })

  it('normalizes localhost and 127.0.0.1 origins with custom ports', () => {
    expect(normalizeServerOrigin('http://127.0.0.1:4100/path?q=1')).toBe('http://127.0.0.1:4100')
    expect(normalizeServerOrigin('https://localhost:9443/browser/bootstrap')).toBe('https://localhost:9443')
  })

  it('converts browser relay origins to extension WebSocket URLs', () => {
    expect(serverOriginToRelayUrl('http://127.0.0.1:4100')).toBe('ws://127.0.0.1:4100/browser/extension')
    expect(serverOriginToRelayUrl('https://localhost:9443')).toBe('wss://localhost:9443/browser/extension')
    expect(browserRelayOriginToExtensionUrl('http://127.0.0.1:4100')).toBe('ws://127.0.0.1:4100/browser/extension')
    expect(browserRelayOriginToBootstrapUrl('http://127.0.0.1:4100')).toBe('http://127.0.0.1:4100/browser/bootstrap')
  })

  it('prefers browserRelayOrigin and migrates legacy serverOrigin/webUiUrl/relayUrl values', () => {
    expect(resolveStoredServerOrigin({
      browserRelayOrigin: 'http://127.0.0.1:4103',
      serverOrigin: 'http://127.0.0.1:4100',
    })).toBe('http://127.0.0.1:4103')
    expect(resolveStoredServerOrigin({ serverOrigin: 'http://127.0.0.1:4100' })).toBe('http://127.0.0.1:4100')
    expect(resolveStoredServerOrigin({ webUiUrl: 'http://127.0.0.1:4101/app' })).toBe('http://127.0.0.1:4101')
    expect(resolveStoredServerOrigin({ relayUrl: 'ws://localhost:4102/browser/extension' })).toBe('http://localhost:4102')
    expect(relayUrlToServerOrigin('wss://localhost:9443/browser/extension')).toBe('https://localhost:9443')
  })

  it('builds the embedded web UI URL with extension query params', () => {
    expect(buildWebUiUrl('http://127.0.0.1:4100', 'nonce-1')).toBe(
      'http://127.0.0.1:4100/?client=browser-extension&newSessionNonce=nonce-1',
    )
  })
})
