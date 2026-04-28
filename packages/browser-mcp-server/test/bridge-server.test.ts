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
})
