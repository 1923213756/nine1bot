import { describe, expect, it } from 'bun:test'
import { sessionMatchesClientSurface } from '../src/api/client'

describe('session surface filtering', () => {
  it('keeps browser extension sessions in the main Web history', () => {
    expect(sessionMatchesClientSurface({ client: { source: 'browser-extension' } }, 'web')).toBe(true)
    expect(sessionMatchesClientSurface({ client: undefined }, 'web')).toBe(true)
  })

  it('keeps the browser extension surface scoped to extension sessions', () => {
    expect(sessionMatchesClientSurface({ client: { source: 'browser-extension' } }, 'browser-extension')).toBe(true)
    expect(sessionMatchesClientSurface({ client: { source: 'web' } }, 'browser-extension')).toBe(false)
    expect(sessionMatchesClientSurface({ client: undefined }, 'browser-extension')).toBe(false)
  })
})
