import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { launch, shutdown } from '../launcher/orchestrator'
import { loadConfig } from './loader'
import type { Nine1BotConfig } from './schema'

const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'compat',
)

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

async function materializeFixture(relativePath: string): Promise<string> {
  const sourcePath = join(fixtureRoot, relativePath)
  const dir = await mkdtemp(join(tmpdir(), 'nine1bot-compat-'))
  tempDirs.push(dir)
  const targetPath = join(dir, 'nine1bot.config.jsonc')
  await writeFile(targetPath, await readFile(sourcePath, 'utf-8'), 'utf-8')
  return targetPath
}

async function createIsolatedUserDirs(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'nine1bot-home-'))
  tempDirs.push(root)

  process.env.HOME = root
  process.env.USERPROFILE = root
  process.env.XDG_DATA_HOME = join(root, '.local', 'share')
  process.env.LOCALAPPDATA = join(root, 'AppData', 'Local')
  process.env.APPDATA = join(root, 'AppData', 'Roaming')
}

function snapshotEnv(): NodeJS.ProcessEnv {
  return { ...process.env }
}

function restoreEnv(snapshot: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) {
      delete process.env[key]
    }
  }

  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

describe('legacy config compatibility', () => {
  const supportedFixtures: Array<{
    name: string
    path: string
    assert: (config: Nine1BotConfig) => void
  }> = [
    {
      name: 'minimal v1 config',
      path: 'supported/minimal-v1.jsonc',
      assert: (config) => {
        expect(config.server.port).toBe(4107)
        expect(config.server.hostname).toBe('127.0.0.1')
        expect(config.server.openBrowser).toBe(false)
        expect(config.auth.enabled).toBe(false)
        expect(config.tunnel.enabled).toBe(false)
        expect(config.browser.enabled).toBe(false)
        expect(config.runtime.agentRunSpec.enabled).toBe(true)
      },
    },
    {
      name: 'OpenCode-style user config',
      path: 'supported/opencode-style-v1.jsonc',
      assert: (config) => {
        expect(config.model).toBe('openai/gpt-4.1')
        expect(config.small_model).toBe('openai/gpt-4.1-mini')
        expect(config.default_agent).toBe('coder')
        expect(config.agent?.coder?.mode).toBe('primary')
        expect(config.permission?.bash).toBe('ask')
        expect(config.permission?.webfetch).toBe('deny')
        expect(config.instructions).toEqual(['Prefer small, reviewable changes.'])
        expect(config.skills.inheritOpencode).toBe(false)
        expect(config.mcp?.local_docs).toMatchObject({
          type: 'local',
          enabled: false,
          command: ['node', 'server.js'],
        })
        expect(config.provider?.openai).toMatchObject({
          options: {
            apiKey: 'test-key',
            timeout: false,
          },
          whitelist: ['gpt-4.1', 'gpt-4.1-mini'],
        })
      },
    },
    {
      name: 'remote MCP OAuth config',
      path: 'supported/remote-mcp-oauth-v1.jsonc',
      assert: (config) => {
        expect(config.mcp?.inheritOpencode).toBe(false)
        expect(config.mcp?.remote_docs).toEqual({
          type: 'remote',
          url: 'https://mcp.example.com/http',
          enabled: true,
          oauth: {
            clientId: 'client-id',
            clientSecret: 'client-secret',
            scope: 'read write',
          },
          headers: {
            'X-Test': 'compat',
          },
          timeout: 30000,
        })
      },
    },
    {
      name: 'custom provider config',
      path: 'supported/custom-provider-v1.jsonc',
      assert: (config) => {
        expect(config.model).toBe('compat-openai/compat-chat')
        expect(config.customProviders['compat-openai']).toEqual({
          name: 'Compat OpenAI',
          protocol: 'openai',
          baseURL: 'https://llm.example.com/v1',
          models: [
            {
              id: 'compat-chat',
              name: 'Compat Chat',
            },
          ],
          options: {
            timeout: false,
            headers: {
              'X-Compat': 'true',
            },
          },
        })
      },
    },
  ]

  for (const fixture of supportedFixtures) {
    it(`loads supported legacy fixture: ${fixture.name}`, async () => {
      const envSnapshot = snapshotEnv()
      const configPath = await materializeFixture(fixture.path)

      try {
        delete process.env.NINE1BOT_COMPAT_OPENAI_API_KEY

        const config = await loadConfig(configPath)
        fixture.assert(config)
      } finally {
        restoreEnv(envSnapshot)
      }
    })
  }

  const deprecatedFixtures = [
    {
      name: 'deprecated MCP browser config',
      path: 'deprecated/mcp-browser.jsonc',
      field: 'mcp.browser',
      hint: 'remove mcp.browser',
    },
    {
      name: 'deprecated browser bridge port config',
      path: 'deprecated/browser-bridge-port.jsonc',
      field: 'browser.bridgePort',
      hint: 'remove bridgePort',
    },
  ]

  for (const fixture of deprecatedFixtures) {
    it(`rejects ${fixture.name} with a stable migration message`, async () => {
      const configPath = await materializeFixture(fixture.path)

      try {
        await loadConfig(configPath)
        throw new Error('Expected legacy config to be rejected')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).toContain('Invalid config')
        expect(message).toContain(fixture.field)
        expect(message).toContain('deprecated')
        expect(message).toContain(fixture.hint)
      }
    })
  }

  it('starts with a supported minimal legacy config', async () => {
    const envSnapshot = snapshotEnv()
    const configPath = await materializeFixture('supported/minimal-v1.jsonc')
    let result: Awaited<ReturnType<typeof launch>> | undefined

    try {
      await createIsolatedUserDirs()

      result = await launch({
        configPath,
        port: 0,
        hostname: '127.0.0.1',
        noBrowser: true,
      })

      expect(result.localUrl).toContain('http://127.0.0.1:')
      expect(result.configPath).toBe(configPath)
    } finally {
      if (result) {
        await shutdown(result)
      }
      restoreEnv(envSnapshot)
    }
  })
})
