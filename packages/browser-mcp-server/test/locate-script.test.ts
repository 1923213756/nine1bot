import { describe, expect, test } from 'bun:test'
import { buildLocateExpression, buildResolveTargetExpression } from '../src/core/page-scripts/locate'

class FakeText {
  nodeType = 3
  constructor(public textContent: string) {}
}

class FakeElement {
  nodeType = 1
  children: FakeElement[] = []
  childNodes: Array<FakeElement | FakeText> = []
  parentElement: FakeElement | null = null
  ownerDocument!: FakeDocument
  shadowRoot?: { children: FakeElement[] }
  contentDocument?: FakeDocument
  attributes = new Map<string, string>()
  rect = { x: 0, y: 0, width: 100, height: 24 }
  style = { display: 'block', visibility: 'visible', opacity: '1', cursor: 'auto' }
  connected = true

  constructor(public tagName: string) {
    this.tagName = tagName.toUpperCase()
  }

  get id() {
    return this.getAttribute('id') ?? ''
  }

  get className() {
    return this.getAttribute('class') ?? ''
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent ?? '').join('')
  }

  get isConnected() {
    return this.connected
  }

  append(child: FakeElement | FakeText) {
    this.childNodes.push(child)
    if (child instanceof FakeElement) {
      child.parentElement = this
      child.ownerDocument = this.ownerDocument
      this.children.push(child)
    }
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value)
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null
  }

  hasAttribute(name: string) {
    return this.attributes.has(name)
  }

  getBoundingClientRect() {
    return this.rect
  }
}

class FakeDocument {
  defaultView: any
  body: FakeElement

  constructor() {
    this.body = new FakeElement('body')
    this.body.ownerDocument = this
  }

  allElements(): FakeElement[] {
    const result: FakeElement[] = []
    const visit = (element: FakeElement) => {
      result.push(element)
      for (const child of element.children) visit(child)
      if (element.shadowRoot) {
        for (const child of element.shadowRoot.children) visit(child)
      }
    }
    visit(this.body)
    return result
  }

  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector: string) {
    const idMatch = selector.match(/^([a-z0-9-]+)#(.+)$/i)
    const attrMatch = selector.match(/^([a-z0-9-]+)\[([^=]+)="(.+)"\]$/i)
    return this.allElements().filter((element) => {
      const tag = element.tagName.toLowerCase()
      if (idMatch) return tag === idMatch[1] && element.id === idMatch[2]
      if (attrMatch) return tag === attrMatch[1] && element.getAttribute(attrMatch[2]) === attrMatch[3]
      return tag === selector.toLowerCase()
    })
  }
}

function runExpression(expression: string, doc: FakeDocument) {
  const fakeWindow = doc.defaultView ?? {
    innerWidth: 1280,
    innerHeight: 720,
    document: doc,
    CSS: { escape: (value: string) => value },
    getComputedStyle: (element: FakeElement) => element.style,
  }
  doc.defaultView = fakeWindow
  const fn = new Function(
    'window',
    'document',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLSelectElement',
    `return ${expression}`,
  )
  return fn(fakeWindow, doc, FakeElement, FakeElement, FakeElement)
}

describe('locate page script', () => {
  test('locates interactive elements inside open shadow roots', () => {
    const doc = new FakeDocument()
    const host = new FakeElement('search-shell')
    host.ownerDocument = doc
    const input = new FakeElement('input')
    input.ownerDocument = doc
    input.setAttribute('aria-label', 'Search documents')
    input.setAttribute('type', 'search')
    input.rect = { x: 20, y: 30, width: 320, height: 32 }
    host.shadowRoot = { children: [input] }
    doc.body.append(host)

    const raw = runExpression(buildLocateExpression({ query: 'search bar', timeoutMs: 1000, maxNodes: 100 }), doc)
    const result = JSON.parse(raw)

    expect(result.matches.length).toBeGreaterThan(0)
    expect(result.matches[0].tag).toBe('input')
    expect(result.matches[0].targetId).toStartWith('target_')
    expect(result.matches[0].shadowPath.length).toBeGreaterThan(0)

    const resolvedRaw = runExpression(buildResolveTargetExpression(result.matches[0].targetId), doc)
    const resolved = JSON.parse(resolvedRaw)
    expect(resolved.found).toBe(true)
    expect(resolved.centerX).toBe(180)
  })

  test('returns a partial result when maxNodes is reached', () => {
    const doc = new FakeDocument()
    for (let i = 0; i < 10; i++) {
      const button = new FakeElement('button')
      button.ownerDocument = doc
      button.append(new FakeText(`Action ${i}`))
      doc.body.append(button)
    }

    const raw = runExpression(buildLocateExpression({ query: 'Action', maxNodes: 1, timeoutMs: 1000 }), doc)
    const result = JSON.parse(raw)

    expect(result.truncated).toBe(true)
    expect(result.scannedNodes).toBe(1)
    expect(result.warnings[0]).toContain('budget')
  })

  test('applies iframe offsets before viewport filtering', () => {
    const doc = new FakeDocument()
    const iframe = new FakeElement('iframe')
    iframe.ownerDocument = doc
    iframe.rect = { x: 2000, y: 0, width: 400, height: 300 }

    const frameDoc = new FakeDocument()
    const button = new FakeElement('button')
    button.ownerDocument = frameDoc
    button.rect = { x: 10, y: 10, width: 100, height: 24 }
    button.append(new FakeText('Inside frame'))
    frameDoc.body.append(button)
    iframe.contentDocument = frameDoc
    doc.body.append(iframe)

    const raw = runExpression(
      buildLocateExpression({ query: 'Inside frame', viewportOnly: true, timeoutMs: 1000, maxNodes: 100 }),
      doc,
    )
    const result = JSON.parse(raw)

    expect(result.matches).toHaveLength(0)
  })

  test('resolves iframe targets with top-level coordinates', () => {
    const doc = new FakeDocument()
    const iframe = new FakeElement('iframe')
    iframe.ownerDocument = doc
    iframe.rect = { x: 200, y: 50, width: 400, height: 300 }

    const frameDoc = new FakeDocument()
    const button = new FakeElement('button')
    button.ownerDocument = frameDoc
    button.rect = { x: 10, y: 20, width: 100, height: 24 }
    button.append(new FakeText('Inside frame'))
    frameDoc.body.append(button)
    frameDoc.defaultView = {
      innerWidth: 400,
      innerHeight: 300,
      document: frameDoc,
      frameElement: iframe,
      CSS: { escape: (value: string) => value },
      getComputedStyle: (element: FakeElement) => element.style,
    }
    iframe.contentDocument = frameDoc
    doc.body.append(iframe)

    const raw = runExpression(
      buildLocateExpression({ query: 'Inside frame', timeoutMs: 1000, maxNodes: 100 }),
      doc,
    )
    const result = JSON.parse(raw)

    expect(result.matches.length).toBeGreaterThan(0)
    expect(result.matches[0].tag).toBe('button')
    expect(result.matches[0].center).toEqual({ x: 260, y: 82 })

    const resolvedRaw = runExpression(buildResolveTargetExpression(result.matches[0].targetId), doc)
    const resolved = JSON.parse(resolvedRaw)
    expect(resolved.found).toBe(true)
    expect(resolved.centerX).toBe(260)
    expect(resolved.centerY).toBe(82)
  })

  test('prunes disconnected locator targets on later locate calls', () => {
    const doc = new FakeDocument()
    const staleButton = new FakeElement('button')
    staleButton.ownerDocument = doc
    staleButton.append(new FakeText('Stale action'))
    doc.body.append(staleButton)

    const firstRaw = runExpression(buildLocateExpression({ query: 'Stale action', timeoutMs: 1000, maxNodes: 100 }), doc)
    const first = JSON.parse(firstRaw)
    const staleTargetId = first.matches[0].targetId

    doc.body.children = doc.body.children.filter((child) => child !== staleButton)
    doc.body.childNodes = doc.body.childNodes.filter((child) => child !== staleButton)
    staleButton.connected = false

    const freshButton = new FakeElement('button')
    freshButton.ownerDocument = doc
    freshButton.append(new FakeText('Fresh action'))
    doc.body.append(freshButton)

    runExpression(buildLocateExpression({ query: 'Fresh action', timeoutMs: 1000, maxNodes: 100 }), doc)

    expect(doc.defaultView.__nine1Locator.elements[staleTargetId]).toBeUndefined()
    expect(doc.defaultView.__nine1Locator.targets[staleTargetId]).toBeUndefined()
  })
})
