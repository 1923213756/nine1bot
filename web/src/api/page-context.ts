import { getTrustedExtensionParentContext, isTrustedExtensionParentEvent } from '../utils/extension-parent'

export interface RequestPagePayload {
  platform: string
  url?: string
  pageType?: string
  title?: string
  objectKey?: string
  selection?: string
  visibleSummary?: string
  raw?: Record<string, unknown>
}

type PageContextResponse = {
  type?: string
  requestId?: unknown
  payload?: unknown
}

export async function collectActivePageContext(timeoutMs = 700): Promise<RequestPagePayload | undefined> {
  const parentContext = getTrustedExtensionParentContext()
  if (!parentContext) return undefined

  const requestId = createRequestId()

  return await new Promise((resolve) => {
    const cleanup = () => {
      window.removeEventListener('message', handleMessage)
      clearTimeout(timer)
    }

    const handleMessage = (event: MessageEvent<PageContextResponse>) => {
      if (!isTrustedExtensionParentEvent(event)) return
      const message = event.data
      if (message?.type !== 'nine1bot.pageContext' || message.requestId !== requestId) return
      cleanup()
      resolve(normalizePagePayload(message.payload))
    }

    const timer = setTimeout(() => {
      cleanup()
      resolve(undefined)
    }, timeoutMs)

    window.addEventListener('message', handleMessage)
    parentContext.parent.postMessage({ type: 'nine1bot.requestPageContext', requestId }, parentContext.origin)
  })
}

function normalizePagePayload(input: unknown): RequestPagePayload | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const payload = input as Record<string, unknown>
  const platform = payload.platform
  if (typeof platform !== 'string' || !platform.trim()) return undefined
  return {
    platform,
    url: stringValue(payload.url),
    pageType: stringValue(payload.pageType),
    title: stringValue(payload.title),
    objectKey: stringValue(payload.objectKey),
    selection: stringValue(payload.selection),
    visibleSummary: stringValue(payload.visibleSummary),
    raw: recordValue(payload.raw),
  }
}

function createRequestId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `page-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input : undefined
}

function recordValue(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined
}
