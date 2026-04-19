import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getMcpAuthPath } from '../config/loader'
import { Nine1BotConfigSchema } from '../config/schema'
import { prepareOpencodeRuntime } from './opencode-runtime'
import type { EngineContext, EngineManifest } from './types'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('prepareOpencodeRuntime', () => {
  test('passes NINE1BOT_MCP_AUTH_PATH into the engine environment', async () => {
    const installDir = await mkdtemp(join(tmpdir(), 'nine1bot-opencode-runtime-'))
    tempDirs.push(installDir)

    const configPath = join(installDir, 'nine1bot.config.jsonc')
    await writeFile(configPath, '{}\n', 'utf-8')

    const manifest: EngineManifest = {
      engineId: 'opencode',
      engineVersion: 'test',
      mode: 'local-source',
      entry: {
        command: 'bun',
        args: ['run', 'serve', '--port', '{port}', '--hostname', '{host}'],
      },
      healthEndpoint: '/global/health',
      defaultPortStrategy: 'ephemeral',
      runtimeLayoutVersion: 1,
    }

    const context: EngineContext = {
      configPath,
      installDir,
      projectDir: installDir,
    }

    const prepared = await prepareOpencodeRuntime(
      Nine1BotConfigSchema.parse({}),
      context,
      manifest,
      'subprocess',
    )
    tempDirs.push(prepared.runtimeDir)

    expect(prepared.env.NINE1BOT_MCP_AUTH_PATH).toBe(getMcpAuthPath())
  })
})
