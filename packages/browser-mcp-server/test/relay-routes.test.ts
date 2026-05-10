import { describe, expect, test } from 'bun:test'
import { getExtensionRelay } from '../src/bridge/relay-routes'

describe('extension relay target validation', () => {
  test('reports disconnected extension before validating target IDs', async () => {
    await expect(
      getExtensionRelay('browser_test').sendCommand('Runtime.evaluate', { expression: '1 + 1' }, 'missing-target'),
    ).rejects.toThrow('No browser agent is currently connected')
  })
})
