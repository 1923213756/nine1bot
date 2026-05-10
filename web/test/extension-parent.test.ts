import { describe, expect, it } from 'bun:test'
import { resolveTrustedExtensionParentOrigin, toTrustedExtensionOrigin } from '../src/utils/extension-parent'

describe('trusted extension parent origin', () => {
  it('accepts extension origins from ancestorOrigins', () => {
    expect(
      resolveTrustedExtensionParentOrigin({
        location: {
          ancestorOrigins: ['chrome-extension://abcdefghijklmnopabcdefghijklmnop/sidepanel.html'],
        },
        referrer: '',
      }),
    ).toBe('chrome-extension://abcdefghijklmnopabcdefghijklmnop')
  })

  it('falls back to a trusted extension referrer when ancestorOrigins is unavailable', () => {
    expect(
      resolveTrustedExtensionParentOrigin({
        location: {},
        referrer: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/sidepanel.html?client=browser-extension',
      }),
    ).toBe('chrome-extension://abcdefghijklmnopabcdefghijklmnop')
  })

  it('rejects non-extension origins', () => {
    expect(toTrustedExtensionOrigin('https://example.com/embed')).toBeNull()
    expect(
      resolveTrustedExtensionParentOrigin({
        location: {
          ancestorOrigins: ['https://example.com/embed'],
        },
        referrer: 'https://example.com/embed',
      }),
    ).toBeNull()
  })
})
