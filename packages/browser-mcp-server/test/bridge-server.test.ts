import { describe, expect, test } from 'bun:test'
import { BridgeServer } from '../src/bridge/server'

describe('BridgeServer form fill', () => {
  test('treats target-looking refs as stable target IDs', async () => {
    const bridge = new BridgeServer()
    let expression = ''
    const bridgeWithRelay = bridge as any

    bridgeWithRelay.relay = {
      extensionConnected: () => true,
      getTools: () => [],
      sendCommand: async (_method: string, params: { expression?: string }) => {
        expression = params.expression ?? ''
        return {
          result: {
            value: JSON.stringify({ success: true, elementType: 'input' }),
          },
        }
      },
    }

    const result = await bridge.fillForm('123', 'target_abc123', 'hello', 'user')

    expect(result.success).toBe(true)
    expect(expression).toContain('resolveElement(targetId)')
    expect(expression).toContain('target_abc123')
    expect(expression).not.toContain('Element with ref')
  })

  test('normalizes invalid locate results before callers read matches', async () => {
    const bridge = new BridgeServer()
    const bridgeWithRelay = bridge as any

    bridgeWithRelay.relay = {
      extensionConnected: () => true,
      getTools: () => [],
      sendCommand: async () => ({ result: { value: '{}' } }),
    }

    const result = await bridge.locateElements('123', { query: 'missing' }, 'user')

    expect(result.matches).toEqual([])
    expect(result.warnings[0]).toContain('invalid')
  })

  test('mentions targetId in click argument validation', async () => {
    const bridge = new BridgeServer()

    await expect(bridge.clickElement('123', {}, 'bot')).rejects.toThrow('targetId')
  })
})
