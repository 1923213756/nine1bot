const TRUSTED_EXTENSION_PROTOCOLS = new Set([
  'chrome-extension:',
  'moz-extension:',
  'safari-web-extension:',
])

type AncestorOriginSource = {
  ancestorOrigins?: ArrayLike<string> | null
}

export function toTrustedExtensionOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null

  try {
    const parsed = new URL(value)
    if (!TRUSTED_EXTENSION_PROTOCOLS.has(parsed.protocol)) return null
    return parsed.host ? `${parsed.protocol}//${parsed.host}` : null
  } catch {
    return null
  }
}

function firstAncestorOrigin(locationLike?: AncestorOriginSource): string | null {
  const ancestorOrigins = locationLike?.ancestorOrigins
  if (!ancestorOrigins || ancestorOrigins.length < 1) return null
  return typeof ancestorOrigins[0] === 'string' ? ancestorOrigins[0] : null
}

export function resolveTrustedExtensionParentOrigin(options: {
  location?: AncestorOriginSource
  referrer?: string
} = {}): string | null {
  const locationLike = options.location ?? (typeof window !== 'undefined' ? window.location : undefined)
  const referrer = options.referrer ?? (typeof document !== 'undefined' ? document.referrer : '')

  return (
    toTrustedExtensionOrigin(firstAncestorOrigin(locationLike)) ??
    toTrustedExtensionOrigin(referrer)
  )
}

export function getTrustedExtensionParentContext(): {
  parent: Window
  origin: string
} | null {
  if (typeof window === 'undefined' || window.parent === window) return null

  const origin = resolveTrustedExtensionParentOrigin()
  if (!origin) return null

  return {
    parent: window.parent,
    origin,
  }
}

export function isTrustedExtensionParentEvent(event: MessageEvent): boolean {
  const context = getTrustedExtensionParentContext()
  if (!context) return false
  return event.source === context.parent && event.origin === context.origin
}
