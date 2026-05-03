import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useAgentTerminal } from '../src/composables/useAgentTerminal'

const originalFetch = globalThis.fetch

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function installFetchMock() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const parsed = new URL(url, 'http://localhost')

    if (parsed.pathname === '/agent-terminal' && parsed.searchParams.get('sessionID') === 'ses_a') {
      return jsonResponse([
        {
          id: 'agt_a',
          name: 'A',
          sessionID: 'ses_a',
          status: 'running',
          rows: 24,
          cols: 80,
          createdAt: 1,
          lastActivity: 1,
        },
      ])
    }

    if (parsed.pathname === '/agent-terminal/agt_a/screen') {
      return jsonResponse({
        sessionID: 'ses_a',
        screen: 'ready',
        screenAnsi: 'ready',
        cursor: { row: 0, col: 5 },
      })
    }

    if (parsed.pathname === '/agent-terminal/agt_a/buffer' && parsed.searchParams.get('afterSeq') === '1') {
      return jsonResponse({
        buffer: '',
        chunks: [
          { seq: 2, data: 'two' },
          { seq: 3, data: 'three' },
        ],
        latestSeq: 3,
        firstSeq: 1,
        reset: false,
      })
    }

    return jsonResponse({ buffer: '', chunks: [], latestSeq: 0, firstSeq: 1, reset: true })
  }) as typeof fetch
}

beforeEach(() => {
  useAgentTerminal().clearTerminals()
  installFetchMock()
})

afterEach(() => {
  useAgentTerminal().clearTerminals()
  globalThis.fetch = originalFetch
})

describe('useAgentTerminal', () => {
  it('filters terminals by current session and ignores other session output', async () => {
    const terminal = useAgentTerminal()
    terminal.setSessionContext('ses_a')
    await terminal.initialize(true)

    expect(terminal.terminals.value.map((item) => item.id)).toEqual(['agt_a'])
    expect(terminal.activeTerminalId.value).toBe('agt_a')

    terminal.handleSSEEvent({
      type: 'agent-terminal.created',
      properties: {
        info: {
          id: 'agt_b',
          name: 'B',
          sessionID: 'ses_b',
          status: 'running',
          rows: 24,
          cols: 80,
          createdAt: 1,
          lastActivity: 1,
        },
      },
    })
    terminal.handleSSEEvent({
      type: 'agent-terminal.output',
      properties: { id: 'agt_b', sessionID: 'ses_b', seq: 1, data: 'wrong' },
    })

    expect(terminal.terminals.value.map((item) => item.id)).toEqual(['agt_a'])
    expect(terminal.activeScreen.value?.outputData).toBeUndefined()
  })

  it('deduplicates output seqs and recovers gaps from the ring buffer', async () => {
    const terminal = useAgentTerminal()
    terminal.setSessionContext('ses_a')
    await terminal.initialize(true)

    terminal.handleSSEEvent({
      type: 'agent-terminal.output',
      properties: { id: 'agt_a', sessionID: 'ses_a', seq: 1, data: 'one' },
    })
    terminal.handleSSEEvent({
      type: 'agent-terminal.output',
      properties: { id: 'agt_a', sessionID: 'ses_a', seq: 1, data: 'duplicate' },
    })

    expect(terminal.activeScreen.value?.outputData).toBe('one')
    expect(terminal.activeScreen.value?.latestSeq).toBe(1)

    terminal.handleSSEEvent({
      type: 'agent-terminal.output',
      properties: { id: 'agt_a', sessionID: 'ses_a', seq: 3, data: 'three' },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(terminal.activeScreen.value?.outputData).toBe('twothree')
    expect(terminal.activeScreen.value?.latestSeq).toBe(3)
  })
})
