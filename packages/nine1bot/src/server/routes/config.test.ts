import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { EngineManager } from '../../engine'
import { readRawConfig } from '../../config/raw'
import { createShellConfigRoutes } from './config'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function createEngineManager(applyRuntimeChange: EngineManager['applyRuntimeChange']): EngineManager {
  return {
    applyRuntimeChange,
  } as EngineManager
}

async function createConfigFile(initial: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nine1bot-config-route-'))
  tempDirs.push(dir)
  const configPath = join(dir, 'nine1bot.config.jsonc')
  await writeFile(configPath, `${JSON.stringify(initial, null, 2)}\n`, 'utf-8')
  return configPath
}

describe('createShellConfigRoutes', () => {
  test('rejects deprecated browser config before writing to disk', async () => {
    const configPath = await createConfigFile({ model: 'before' })
    let applyCalls = 0
    const app = createShellConfigRoutes({
      configPath,
      engineManager: createEngineManager(async () => {
        applyCalls++
        return { state: 'applied', effectiveAfterCurrentSession: false }
      }),
    })

    const response = await app.request('http://localhost/nine1bot', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        browser: {
          enabled: true,
          bridgePort: 18793,
        },
      }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: expect.stringContaining('browser.bridgePort'),
    })
    expect(applyCalls).toBe(0)
    expect(await readRawConfig(configPath)).toEqual({ model: 'before' })
  })

  test('restores the previous config when runtime apply fails', async () => {
    const configPath = await createConfigFile({ model: 'before' })
    const app = createShellConfigRoutes({
      configPath,
      engineManager: createEngineManager(async () => {
        throw new Error('engine rebuild failed')
      }),
    })

    const response = await app.request('http://localhost/nine1bot', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'after' }),
    })

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: 'engine rebuild failed',
    })
    expect(await readRawConfig(configPath)).toEqual({ model: 'before' })
  })
})
