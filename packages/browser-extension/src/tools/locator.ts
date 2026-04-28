import type { ToolDefinition, ToolResult } from './index'

interface LocateArgs {
  tabId?: number
  query: string
  scope?: 'auto' | 'page' | 'viewport' | 'interactive'
  visibleOnly?: boolean
  viewportOnly?: boolean
  maxResults?: number
  timeoutMs?: number
  maxNodes?: number
}

type LocateResult = {
  query: string
  matches: Array<Record<string, unknown>>
  scannedNodes: number
  truncated: boolean
  elapsedMs: number
  inaccessibleFrames: number
  warnings: string[]
}

function locateInPage(opts: Required<Omit<LocateArgs, 'tabId'>>): LocateResult {
  const startedAt = Date.now()
  const rootWindow = window as typeof window & {
    __nine1Locator?: {
      next: number
      targets: Record<string, any>
      elements: Record<string, Element>
      weak?: WeakMap<Element, string>
      resolveElement?: (targetId: string) => Element | null
    }
  }
  const state = rootWindow.__nine1Locator ?? {
    next: 1,
    targets: {},
    elements: {},
    weak: typeof WeakMap !== 'undefined' ? new WeakMap<Element, string>() : undefined,
  }
  rootWindow.__nine1Locator = state

  const normalize = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  const cssEscape = (value: string) => window.CSS?.escape?.(value) ?? value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`)
  const getRole = (element: Element) => {
    const tag = element.tagName.toLowerCase()
    const implicit: Record<string, string> = {
      a: 'link',
      button: 'button',
      input: 'textbox',
      select: 'combobox',
      textarea: 'textbox',
      img: 'img',
      table: 'table',
    }
    if (tag === 'input' && (element as HTMLInputElement).type === 'search') return 'searchbox'
    return element.getAttribute('role') || implicit[tag] || ''
  }
  const getLabel = (element: Element) =>
    (
      element.getAttribute('aria-label') ||
      element.getAttribute('title') ||
      element.getAttribute('alt') ||
      element.getAttribute('placeholder') ||
      ''
    ).replace(/\s+/g, ' ').trim()
  const getText = (element: Element) => {
    let direct = ''
    for (const child of element.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) direct += child.textContent || ''
    }
    const text = direct.trim() || (element.children.length <= 6 ? element.textContent || '' : '')
    return text.replace(/\s+/g, ' ').trim().slice(0, 240)
  }
  const selectorFor = (element: Element) => {
    const tag = element.tagName.toLowerCase()
    if (element.id) return `${tag}#${cssEscape(element.id)}`
    for (const attr of ['data-testid', 'data-test-id', 'data-qa', 'aria-label', 'name', 'role', 'title', 'placeholder']) {
      const value = element.getAttribute(attr)
      if (value && value.length <= 80) return `${tag}[${attr}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`
    }
    return tag
  }
  const rectFor = (element: Element, offsetX: number, offsetY: number) => {
    const rect = element.getBoundingClientRect()
    return {
      x: Math.round(rect.x + offsetX),
      y: Math.round(rect.y + offsetY),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    }
  }
  const inViewport = (rect: { x: number; y: number; width: number; height: number }) =>
    rect.x < window.innerWidth && rect.y < window.innerHeight && rect.x + rect.width > 0 && rect.y + rect.height > 0
  const isVisible = (element: Element, rect: { width: number; height: number }) => {
    const view = element.ownerDocument.defaultView ?? window
    const style = view.getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0
  }
  const isInteractive = (element: Element) => {
    const tag = element.tagName.toLowerCase()
    const role = getRole(element)
    if (/^(a|button|input|select|textarea|details|summary)$/.test(tag)) return true
    if (/button|link|checkbox|radio|textbox|searchbox|combobox|listbox|menu|menuitem|tab|switch/.test(role)) return true
    if (element.hasAttribute('contenteditable')) return true
    const tabIndex = element.getAttribute('tabindex')
    return tabIndex !== null && tabIndex !== '-1'
  }
  const remember = (element: Element, info: Record<string, unknown>) => {
    let targetId = state.weak?.get(element) || element.getAttribute('data-nine1-target-id') || ''
    if (!targetId) {
      targetId = `target_${(state.next++).toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      element.setAttribute('data-nine1-target-id', targetId)
      state.weak?.set(element, targetId)
    }
    state.elements[targetId] = element
    state.targets[targetId] = info
    return targetId
  }
  state.resolveElement = (targetId: string) => {
    const direct = state.elements[targetId]
    if (direct?.isConnected) return direct
    return document.querySelector(`[data-nine1-target-id="${targetId}"]`) || document.querySelector(`[data-mcp-ref="${targetId}"]`)
  }

  const query = normalize(opts.query)
  const words = query.split(/\s+/).filter(Boolean)
  const semanticSearch = /search|find|query|lookup|搜索|查找|检索/.test(query)
  const matches: Array<Record<string, unknown>> = []
  const stack: Array<{ element: Element; offsetX: number; offsetY: number; shadowPath: string[]; framePath: string[] }> = []
  if (document.body) stack.push({ element: document.body, offsetX: 0, offsetY: 0, shadowPath: [], framePath: [] })
  const seen = new WeakSet<Element>()
  let scannedNodes = 0
  let truncated = false
  let inaccessibleFrames = 0

  while (stack.length > 0) {
    if (scannedNodes >= opts.maxNodes || Date.now() - startedAt > opts.timeoutMs) {
      truncated = true
      break
    }
    const entry = stack.pop()!
    const { element } = entry
    if (seen.has(element)) continue
    seen.add(element)
    scannedNodes++

    const rect = rectFor(element, entry.offsetX, entry.offsetY)
    const visible = isVisible(element, rect)
    const visibleInViewport = inViewport(rect)
    const interactive = isInteractive(element)
    if ((!opts.visibleOnly || visible) && (!opts.viewportOnly || visibleInViewport) && (opts.scope !== 'interactive' || interactive)) {
      const label = getLabel(element)
      const text = getText(element)
      const role = getRole(element)
      const tag = element.tagName.toLowerCase()
      const haystack = normalize([label, text, role, tag, element.id, element.className].join(' '))
      let score = 0
      if (query && haystack.includes(query)) score += 60
      for (const word of words) if (haystack.includes(word)) score += 10
      if (semanticSearch && (tag === 'input' || tag === 'textarea' || /searchbox|textbox/.test(role) || haystack.includes('search'))) score += 45
      if (interactive) score += 12
      if (visibleInViewport) score += 10
      if (score > 0) {
        const center = { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
        const info = {
          tag,
          role,
          label,
          text,
          rect,
          center,
          selectorHint: selectorFor(element),
          shadowPath: entry.shadowPath,
          framePath: entry.framePath,
          visible,
          inViewport: visibleInViewport,
          interactive,
        }
        matches.push({
          targetId: remember(element, info),
          ...info,
          score,
        })
      }
    }

    if (element.tagName.toLowerCase() === 'iframe') {
      try {
        const frameDoc = (element as HTMLIFrameElement).contentDocument
        if (frameDoc?.body) {
          const frameRect = element.getBoundingClientRect()
          stack.push({
            element: frameDoc.body,
            offsetX: entry.offsetX + frameRect.x,
            offsetY: entry.offsetY + frameRect.y,
            shadowPath: [],
            framePath: entry.framePath.concat(selectorFor(element)),
          })
        }
      } catch {
        inaccessibleFrames++
      }
    }

    const children = Array.from(element.children).reverse()
    for (const child of children) stack.push({ ...entry, element: child })
    if (element.shadowRoot) {
      const shadowPath = entry.shadowPath.concat(selectorFor(element))
      for (const child of Array.from(element.shadowRoot.children).reverse()) stack.push({ ...entry, element: child, shadowPath })
    }
    if (element.tagName.toLowerCase() === 'slot') {
      for (const assigned of (element as HTMLSlotElement).assignedElements({ flatten: true }).reverse()) {
        stack.push({ ...entry, element: assigned })
      }
    }
  }

  matches.sort((a, b) => Number(b.score) - Number(a.score))
  return {
    query: opts.query,
    matches: matches.slice(0, opts.maxResults),
    scannedNodes,
    truncated,
    elapsedMs: Date.now() - startedAt,
    inaccessibleFrames,
    warnings: [
      ...(truncated ? ['Locator stopped early due to time/node budget.'] : []),
      ...(inaccessibleFrames ? [`${inaccessibleFrames} cross-origin frame(s) could not be scanned.`] : []),
    ],
  }
}

export const locateTool = {
  definition: {
    name: 'locate',
    description: 'Locate elements with stable target IDs using visible DOM, open Shadow DOM, and same-origin iframes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tabId: { type: 'number', description: 'The ID of the tab to search. If not provided, uses the active tab.' },
        query: { type: 'string', description: 'Natural language query or text to find.' },
        scope: { type: 'string', enum: ['auto', 'page', 'viewport', 'interactive'], description: 'Locator scope.' },
        visibleOnly: { type: 'boolean', description: 'Only return visible elements. Default true.' },
        viewportOnly: { type: 'boolean', description: 'Restrict to current viewport. Default false.' },
        maxResults: { type: 'number', description: 'Maximum matches. Default 20.' },
        timeoutMs: { type: 'number', description: 'Page-side locator budget in ms. Default 350.' },
        maxNodes: { type: 'number', description: 'Maximum nodes to scan. Default 6000.' },
      },
      required: ['query'],
    },
  } satisfies ToolDefinition,

  async execute(args: unknown): Promise<ToolResult> {
    const {
      tabId,
      query,
      scope = 'auto',
      visibleOnly = true,
      viewportOnly = false,
      maxResults = 20,
      timeoutMs = 350,
      maxNodes = 6000,
    } = (args as LocateArgs) || {}

    if (!query) {
      return { content: [{ type: 'text', text: 'Error: query is required' }], isError: true }
    }

    try {
      let targetTabId = tabId
      if (targetTabId === undefined) {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
        targetTabId = activeTab?.id
      }
      if (targetTabId === undefined) {
        return { content: [{ type: 'text', text: 'Error: No active tab found' }], isError: true }
      }

      const results = await chrome.scripting.executeScript({
        target: { tabId: targetTabId },
        func: locateInPage,
        args: [{ query, scope, visibleOnly, viewportOnly, maxResults, timeoutMs, maxNodes }],
      })
      return {
        content: [{ type: 'text', text: JSON.stringify(results[0]?.result ?? { matches: [] }, null, 2) }],
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { content: [{ type: 'text', text: `Error locating elements: ${errorMessage}` }], isError: true }
    }
  },
}
