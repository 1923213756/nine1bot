import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { EngineManager } from './manager'
import type { EngineAdapter, EngineContext, EngineHandle, PreparedRuntime } from './types'
import { Nine1BotConfigSchema } from '../config/schema'

class FakeAdapter implements EngineAdapter {
  readonly name = 'fake'
  startCalls = 0
  stopCalls = 0
  nextRequiresRestart = false
  nextFingerprint = 'initial'

  async prepare(_config: any, _context: EngineContext) {
    return this.createPrepared('initial')
  }

  async start(prepared: PreparedRuntime): Promise<EngineHandle> {
    this.startCalls++
    let stopped = false
    return {
      baseUrl: `http://engine-${prepared.restartFingerprint}.local`,
      health: async () => !stopped,
      stop: async () => {
        if (stopped) return
        stopped = true
        this.stopCalls++
      },
    }
  }

  async rebuildRuntime(
    _reason: string,
    _config: any,
    _context: EngineContext,
    currentPrepared?: PreparedRuntime,
  ) {
    const prepared = this.createPrepared(this.nextFingerprint)
    return {
      prepared,
      requiresRestart: this.nextRequiresRestart && prepared.restartFingerprint !== currentPrepared?.restartFingerprint,
    }
  }

  private createPrepared(fingerprint: string): PreparedRuntime {
    return {
      runtimeDir: '/tmp/fake-runtime',
      env: {},
      artifactPaths: {
        configPath: '/tmp/fake-runtime/config.json',
        runtimeDir: '/tmp/fake-runtime',
      },
      startSpec: {
        type: 'subprocess',
        host: '127.0.0.1',
        port: 0,
        healthEndpoint: '/global/health',
      },
      restartFingerprint: fingerprint,
    }
  }
}

describe('EngineManager', () => {
  let adapter: FakeAdapter
  let manager: EngineManager
  let tempDir: string
  let configPath: string
  let originalFetch: typeof fetch
  let activeSessions = false

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'nine1bot-engine-manager-'))
    await mkdir(tempDir, { recursive: true })
    configPath = join(tempDir, 'nine1bot.config.jsonc')
    await writeFile(configPath, '{}\n', 'utf-8')

    adapter = new FakeAdapter()
    manager = new EngineManager(adapter, {
      configPath,
      installDir: tempDir,
      projectDir: tempDir,
    })

    originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/session/status')) {
        return new Response(JSON.stringify(activeSessions ? { a: { type: 'busy' } } : { a: { type: 'idle' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.endsWith('/global/health')) {
        return new Response(JSON.stringify({ healthy: true }), { status: 200 })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as typeof fetch
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    await manager.stop()
    await rm(tempDir, { recursive: true, force: true })
  })

  test('applies runtime changes immediately when restart is not required', async () => {
    const config = Nine1BotConfigSchema.parse({})
    await manager.start(config)

    adapter.nextRequiresRestart = false
    adapter.nextFingerprint = 'initial'

    const result = await manager.applyRuntimeChange('no-restart')

    expect(result).toEqual({
      state: 'applied',
      effectiveAfterCurrentSession: false,
    })
    expect(adapter.startCalls).toBe(1)
    expect(adapter.stopCalls).toBe(0)
  })

  test('defers runtime restart until active sessions finish', async () => {
    const config = Nine1BotConfigSchema.parse({})
    await manager.start(config)

    activeSessions = true
    adapter.nextRequiresRestart = true
    adapter.nextFingerprint = 'next'

    const result = await manager.applyRuntimeChange('delayed-restart')

    expect(result).toEqual({
      state: 'pending-rebuild',
      effectiveAfterCurrentSession: true,
    })
    expect(adapter.startCalls).toBe(1)

    activeSessions = false
    await Bun.sleep(1200)

    expect(adapter.startCalls).toBe(2)
    expect(adapter.stopCalls).toBe(1)
  })

  test('clears pending rebuild when a later change no longer requires restart', async () => {
    const config = Nine1BotConfigSchema.parse({})
    await manager.start(config)

    activeSessions = true
    adapter.nextRequiresRestart = true
    adapter.nextFingerprint = 'stale-pending'

    const pending = await manager.applyRuntimeChange('queue-restart')

    expect(pending).toEqual({
      state: 'pending-rebuild',
      effectiveAfterCurrentSession: true,
    })
    expect(adapter.startCalls).toBe(1)

    adapter.nextRequiresRestart = false
    adapter.nextFingerprint = 'applied-without-restart'

    const applied = await manager.applyRuntimeChange('apply-without-restart')

    expect(applied).toEqual({
      state: 'applied',
      effectiveAfterCurrentSession: false,
    })

    activeSessions = false
    await Bun.sleep(1200)

    expect(adapter.startCalls).toBe(1)
    expect(adapter.stopCalls).toBe(0)
  })
})
