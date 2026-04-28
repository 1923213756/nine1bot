import { describe, expect, test } from 'bun:test'
import { getExtensionRelay } from '../src/bridge/relay-routes'

describe('extension relay target validation', () => {
  test('rejects unknown target IDs instead of falling back to active tab', async () => {
    await expect(
      getExtensionRelay().sendCommand('Runtime.evaluate', { expression: '1 + 1' }, 'missing-target'),
    ).rejects.toThrow('Browser target not found: missing-target')
  })
})
