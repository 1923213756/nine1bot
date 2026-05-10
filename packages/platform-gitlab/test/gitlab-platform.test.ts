import { describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  buildGitLabPageContextPayload,
  createGitLabPlatformAdapter,
  gitlabPlatformContribution,
  gitLabTemplateIdsForPage,
  parseGitLabUrl,
  refreshLocalWebhookBaseUrl,
} from '../src'

const reviewAgentsDir = join(import.meta.dir, '..', 'agents', 'review')

describe('GitLab platform adapter package', () => {
  test('parses GitLab repository, file, tree, merge request, and issue URLs', () => {
    expect(parseGitLabUrl('https://gitlab.com/nine1/nine1bot')).toMatchObject({
      host: 'gitlab.com',
      projectPath: 'nine1/nine1bot',
      pageType: 'gitlab-repo',
      objectKey: 'gitlab.com:nine1/nine1bot:repo',
      route: 'repo',
    })
    expect(parseGitLabUrl('https://gitlab.com/nine1/nine1bot/-/blob/main/src/index.ts')).toMatchObject({
      pageType: 'gitlab-file',
      objectKey: 'gitlab.com:nine1/nine1bot:file:main:src/index.ts',
      ref: 'main',
      filePath: 'src/index.ts',
      route: 'blob',
    })
    expect(parseGitLabUrl('https://gitlab.com/nine1/nine1bot/-/tree/main/packages')).toMatchObject({
      pageType: 'gitlab-repo',
      objectKey: 'gitlab.com:nine1/nine1bot:tree:main:packages',
      ref: 'main',
      treePath: 'packages',
      route: 'tree',
    })
    expect(parseGitLabUrl('https://gitlab.com/nine1/nine1bot/-/merge_requests/42')).toMatchObject({
      pageType: 'gitlab-mr',
      objectKey: 'gitlab.com:nine1/nine1bot:merge_request:42',
      iid: '42',
      route: 'merge_request',
    })
    expect(parseGitLabUrl('https://gitlab.com/nine1/nine1bot/-/issues/7')).toMatchObject({
      pageType: 'gitlab-issue',
      objectKey: 'gitlab.com:nine1/nine1bot:issue:7',
      iid: '7',
      route: 'issue',
    })
    expect(parseGitLabUrl('https://example.com/nine1/nine1bot/-/merge_requests/42')).toBeUndefined()
  })

  test('builds browser page payloads with stable GitLab identity', () => {
    expect(buildGitLabPageContextPayload({
      url: 'https://gitlab.com/nine1/nine1bot/-/merge_requests/42',
      title: 'Improve runtime',
      selection: 'selected MR line',
      visibleSummary: 'MR overview',
      raw: {
        gitlab: {
          status: 'Open',
        },
      },
    })).toMatchObject({
      platform: 'gitlab',
      pageType: 'gitlab-mr',
      objectKey: 'gitlab.com:nine1/nine1bot:merge_request:42',
      raw: {
        gitlab: {
          host: 'gitlab.com',
          projectPath: 'nine1/nine1bot',
          route: 'merge_request',
          iid: '42',
          status: 'Open',
        },
      },
    })

    expect(buildGitLabPageContextPayload({
      url: 'https://example.com/page',
      title: 'Example',
    })).toMatchObject({
      platform: 'generic-browser',
      url: 'https://example.com/page',
    })
  })

  test('contributes template ids, context blocks, and builtin resources', () => {
    const page = {
      platform: 'gitlab',
      url: 'https://gitlab.com/nine1/nine1bot/-/issues/7',
      pageType: 'gitlab-issue',
      title: 'Issue 7',
    }
    const adapter = createGitLabPlatformAdapter()
    const templateIds = gitLabTemplateIdsForPage(page)

    expect(templateIds).toEqual(['browser-gitlab', 'gitlab-issue'])
    expect(adapter.inferTemplateIds({ entry: { platform: 'gitlab' }, page })).toEqual(templateIds)
    expect(adapter.templateContextBlocks({ templateIds, page }).map((block) => block.source)).toEqual([
      'template.browser-gitlab',
      'template.gitlab-issue',
    ])
    expect(adapter.resourceContributions({ templateIds })?.builtinTools.enabledGroups).toContain('gitlab-context')
    expect(adapter.recommendedAgent?.({ templateIds, fallback: 'build' })).toBe('build')
    expect(adapter.recommendedAgent?.({ templateIds: ['gitlab-mr'], fallback: 'build' })).toBe('platform.gitlab.pm-coordinator')
  })

  test('declares platform-scoped runtime sources for GitLab review assets', () => {
    expect(gitlabPlatformContribution.runtime?.sources).toMatchObject({
      agents: [{
        id: 'gitlab-review-agents',
        namespace: 'platform.gitlab',
        visibility: 'recommendable',
        lifecycle: 'platform-enabled',
      }],
      skills: [{
        id: 'gitlab-review-skills',
        namespace: 'platform.gitlab',
        visibility: 'declared-only',
        lifecycle: 'platform-enabled',
      }],
    })
  })

  test('checks GitLab API token reachability and required scope', async () => {
    const originalFetch = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push(url)
      return new Response(JSON.stringify({
        name: 'Nine1bot Review Token',
        active: true,
        revoked: false,
        scopes: ['read_user', 'api'],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    try {
      const result = await gitlabPlatformContribution.handleAction?.('connection.test', undefined, {
        platformId: 'gitlab',
        enabled: true,
        settings: {
          'review.enabled': true,
          'review.baseUrl': 'https://gitlab.example.com',
          'review.tokenSecretRef': 'token-value',
        },
        features: {},
        env: {},
        secrets: secretAccess(),
        audit: { write() {} },
      })

      expect(result).toMatchObject({
        status: 'ok',
        message: expect.stringContaining('api scope'),
      })
      expect(calls).toEqual(['https://gitlab.example.com/api/v4/personal_access_tokens/self'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('fails GitLab connection test when token lacks api scope', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({
      active: true,
      revoked: false,
      scopes: ['read_user'],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch

    try {
      const result = await gitlabPlatformContribution.handleAction?.('connection.test', undefined, {
        platformId: 'gitlab',
        enabled: true,
        settings: {
          'review.enabled': true,
          'review.baseUrl': 'https://gitlab.example.com',
          'review.tokenSecretRef': 'token-value',
        },
        features: {},
        env: {},
        secrets: secretAccess(),
        audit: { write() {} },
      })

      expect(result).toMatchObject({
        status: 'failed',
        message: expect.stringContaining('missing required api scope'),
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('syncs GitLab project hooks to the current dedicated webhook URL', async () => {
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; method: string; body?: string }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method || 'GET'
      const body = init?.body instanceof URLSearchParams ? init.body.toString() : undefined
      calls.push({ url, method, body })
      if (url.endsWith('/api/v4/projects/3/hooks') && method === 'GET') {
        return jsonResponse([{
          id: 4,
          url: 'http://old.example.com/webhooks/gitlab/sec_old',
          note_events: true,
          merge_requests_events: true,
        }])
      }
      if (url.endsWith('/api/v4/projects/3/hooks/4') && method === 'PUT') {
        return jsonResponse({
          id: 4,
          url: 'http://192.168.53.6:4096/webhooks/gitlab/sec_test',
          note_events: true,
          merge_requests_events: true,
        })
      }
      if (url.endsWith('/api/v4/projects/3/hooks/4/test/note_events') && method === 'POST') {
        return jsonResponse({ message: '201 Created' })
      }
      return new Response('not found', { status: 404, statusText: 'Not Found' })
    }) as unknown as typeof fetch

    try {
      const result = await gitlabPlatformContribution.handleAction?.('webhook.sync-current-url', undefined, {
        platformId: 'gitlab',
        enabled: true,
        settings: {
          'review.enabled': true,
          'review.baseUrl': 'https://gitlab.example.com',
          'review.tokenSecretRef': 'token-value',
          'review.webhookSecretRef': 'sec_test',
          'review.allowedProjectIds': ['3'],
        },
        features: {},
        env: {
          NINE1BOT_LOCAL_URL: 'http://192.168.53.6:4096',
          NINE1BOT_REFRESH_LOCAL_URL: 'false',
        },
        secrets: secretAccess(),
        audit: { write() {} },
      })

      expect(result).toMatchObject({
        status: 'ok',
        data: {
          webhookUrl: 'http://192.168.53.6:4096/webhooks/gitlab/sec_test',
        },
      })
      expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
        'GET https://gitlab.example.com/api/v4/projects/3/hooks',
        'PUT https://gitlab.example.com/api/v4/projects/3/hooks/4',
        'POST https://gitlab.example.com/api/v4/projects/3/hooks/4/test/note_events',
      ])
      expect(calls[1]?.body).toContain('url=http%3A%2F%2F192.168.53.6%3A4096%2Fwebhooks%2Fgitlab%2Fsec_test')
      expect(calls[1]?.body).toContain('note_events=true')
      expect(calls[1]?.body).toContain('merge_requests_events=true')
      expect(calls[1]?.body).toContain('push_events=false')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('requires current local URL before syncing GitLab project hooks', async () => {
    const result = await gitlabPlatformContribution.handleAction?.('webhook.sync-current-url', undefined, {
      platformId: 'gitlab',
      enabled: true,
      settings: {
        'review.enabled': true,
        'review.baseUrl': 'https://gitlab.example.com',
        'review.tokenSecretRef': 'token-value',
        'review.webhookSecretRef': 'sec_test',
        'review.allowedProjectIds': ['3'],
      },
      features: {},
      env: {},
      secrets: secretAccess(),
      audit: { write() {} },
    })

    expect(result).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('NINE1BOT_LOCAL_URL'),
    })
  })

  test('renders a placeholder dedicated GitLab webhook URL without creating a secret', async () => {
    const secrets = memorySecretAccess()
    const status = await gitlabPlatformContribution.getStatus?.({
      platformId: 'gitlab',
      enabled: true,
      settings: {},
      features: {},
      env: {
        NINE1BOT_LOCAL_URL: 'http://127.0.0.1:4096',
        NINE1BOT_REFRESH_LOCAL_URL: 'false',
      },
      secrets,
      audit: { write() {} },
    })

    const webhookCard = status?.cards?.find((card) => card.id === 'webhook-url')
    expect(webhookCard?.value).toBe('http://127.0.0.1:4096/webhooks/gitlab/%7BwebhookSecret%7D')
    expect(await secrets.get({
      provider: 'nine1bot-local',
      key: 'platform:gitlab:default:review.webhookSecretRef',
    })).toBeUndefined()
  })

  test('refreshes stale local webhook IPs from current network interfaces', () => {
    expect(refreshLocalWebhookBaseUrl('http://192.168.53.6:4096', {
      vpn: [{
        address: '192.168.53.10',
        family: 'IPv4',
        internal: false,
        cidr: '192.168.53.10/24',
        mac: '00:00:00:00:00:00',
        netmask: '255.255.255.0',
        scopeid: 0,
      }],
    })).toBe('http://192.168.53.10:4096')
  })

  test('does not test stale GitLab project hook URLs', async () => {
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; method: string }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method || 'GET'
      calls.push({ url, method })
      if (url.endsWith('/api/v4/projects/3/hooks') && method === 'GET') {
        return jsonResponse([{
          id: 4,
          url: 'http://192.168.53.18:4096/webhooks/gitlab/sec_test',
          note_events: true,
          merge_requests_events: true,
        }])
      }
      if (url.includes('/test/note_events')) {
        throw new Error('stale hook should not be tested')
      }
      return new Response('not found', { status: 404, statusText: 'Not Found' })
    }) as unknown as typeof fetch

    try {
      const result = await gitlabPlatformContribution.handleAction?.('webhook.test', undefined, {
        platformId: 'gitlab',
        enabled: true,
        settings: {
          'review.enabled': true,
          'review.baseUrl': 'https://gitlab.example.com',
          'review.tokenSecretRef': 'token-value',
          'review.webhookSecretRef': 'sec_test',
          'review.allowedProjectIds': ['3'],
        },
        features: {},
        env: {
          NINE1BOT_LOCAL_URL: 'http://192.168.53.6:4096',
          NINE1BOT_REFRESH_LOCAL_URL: 'false',
        },
        secrets: secretAccess(),
        audit: { write() {} },
      })

      expect(result).toMatchObject({
        status: 'failed',
        message: expect.stringContaining('out of date'),
        data: {
          results: [{
            projectId: '3',
            action: 'url-mismatch',
            url: 'http://192.168.53.18:4096/webhooks/gitlab/sec_test',
            expectedUrl: 'http://192.168.53.6:4096/webhooks/gitlab/sec_test',
          }],
        },
      })
      expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
        'GET https://gitlab.example.com/api/v4/projects/3/hooks',
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('searches GitLab projects for review scope selection', async () => {
    const originalFetch = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push(url)
      return jsonResponse([{
        id: 3,
        path_with_namespace: 'root/uftest',
        web_url: 'https://gitlab.example.com/root/uftest',
      }])
    }) as unknown as typeof fetch

    try {
      const result = await gitlabPlatformContribution.handleAction?.('projects.search', { query: 'uftest' }, {
        platformId: 'gitlab',
        enabled: true,
        settings: {
          'review.enabled': true,
          'review.baseUrl': 'https://gitlab.example.com',
          'review.tokenSecretRef': 'token-value',
        },
        features: {},
        env: {},
        secrets: secretAccess(),
        audit: { write() {} },
      })

      expect(result).toMatchObject({
        status: 'ok',
        data: {
          projects: [{
            id: 3,
            pathWithNamespace: 'root/uftest',
            webUrl: 'https://gitlab.example.com/root/uftest',
          }],
        },
      })
      expect(calls).toEqual(['https://gitlab.example.com/api/v4/projects?simple=true&per_page=20&search=uftest'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('searches GitLab groups for group hook management', async () => {
    const originalFetch = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push(url)
      return jsonResponse([{
        id: 9,
        full_path: 'root',
        web_url: 'https://gitlab.example.com/groups/root',
      }])
    }) as unknown as typeof fetch

    try {
      const result = await gitlabPlatformContribution.handleAction?.('groups.search', { query: 'root' }, {
        platformId: 'gitlab',
        enabled: true,
        settings: {
          'review.enabled': true,
          'review.baseUrl': 'https://gitlab.example.com',
          'review.tokenSecretRef': 'token-value',
        },
        features: {},
        env: {},
        secrets: secretAccess(),
        audit: { write() {} },
      })

      expect(result).toMatchObject({
        status: 'ok',
        data: {
          groups: [{
            id: 9,
            fullPath: 'root',
            webUrl: 'https://gitlab.example.com/groups/root',
          }],
        },
      })
      expect(calls).toEqual(['https://gitlab.example.com/api/v4/groups?per_page=20&search=root'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('syncs GitLab group hooks to the current dedicated webhook URL', async () => {
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; method: string; body?: string }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method || 'GET'
      const body = init?.body instanceof URLSearchParams ? init.body.toString() : undefined
      calls.push({ url, method, body })
      if (url.endsWith('/api/v4/groups/9/hooks') && method === 'GET') {
        return jsonResponse([{
          id: 5,
          url: 'http://old.example.com/webhooks/gitlab/sec_old',
          note_events: true,
          merge_requests_events: true,
        }])
      }
      if (url.endsWith('/api/v4/groups/9/hooks/5') && method === 'PUT') {
        return jsonResponse({
          id: 5,
          url: 'http://192.168.53.6:4096/webhooks/gitlab/sec_test',
          note_events: true,
          merge_requests_events: true,
        })
      }
      if (url.endsWith('/api/v4/groups/9/hooks/5/test/note_events') && method === 'POST') {
        return jsonResponse({ message: '201 Created' })
      }
      return new Response('not found', { status: 404, statusText: 'Not Found' })
    }) as unknown as typeof fetch

    try {
      const result = await gitlabPlatformContribution.handleAction?.('group-hooks.sync-current-url', undefined, {
        platformId: 'gitlab',
        enabled: true,
        settings: {
          'review.enabled': true,
          'review.baseUrl': 'https://gitlab.example.com',
          'review.tokenSecretRef': 'token-value',
          'review.webhookSecretRef': 'sec_test',
          'review.hookGroups': [{ id: 9, fullPath: 'root' }],
        },
        features: {},
        env: {
          NINE1BOT_LOCAL_URL: 'http://192.168.53.6:4096',
          NINE1BOT_REFRESH_LOCAL_URL: 'false',
        },
        secrets: secretAccess(),
        audit: { write() {} },
      })

      expect(result).toMatchObject({
        status: 'ok',
        data: {
          webhookUrl: 'http://192.168.53.6:4096/webhooks/gitlab/sec_test',
          results: [{
            groupId: '9',
            groupPath: 'root',
            hookId: 5,
            action: 'updated',
          }],
        },
      })
      expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
        'GET https://gitlab.example.com/api/v4/groups/9/hooks',
        'PUT https://gitlab.example.com/api/v4/groups/9/hooks/5',
        'POST https://gitlab.example.com/api/v4/groups/9/hooks/5/test/note_events',
      ])
      expect(calls[1]?.body).toContain('url=http%3A%2F%2F192.168.53.6%3A4096%2Fwebhooks%2Fgitlab%2Fsec_test')
      expect(calls[1]?.body).toContain('note_events=true')
      expect(calls[1]?.body).toContain('merge_requests_events=true')
      expect(calls[1]?.body).toContain('push_events=false')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('renders GitLab status when webhook secret store read fails', async () => {
    const status = await gitlabPlatformContribution.getStatus?.({
      platformId: 'gitlab',
      enabled: true,
      settings: {
        'review.enabled': true,
        'review.baseUrl': 'https://gitlab.example.com',
        'review.tokenSecretRef': 'token-value',
        'review.webhookSecretRef': {
          provider: 'nine1bot-local',
          key: 'gitlab-webhook',
        },
      },
      features: {},
      env: {
        NINE1BOT_LOCAL_URL: 'http://192.168.53.6:4096',
        NINE1BOT_REFRESH_LOCAL_URL: 'false',
      },
      secrets: {
        async get() { throw new Error('readonly secret store') },
        async set() { throw new Error('should not write while rendering status') },
        async delete() {},
        async has() { return true },
      },
      audit: { write() {} },
    })

    expect(status?.cards?.find((card) => card.id === 'webhook-url')).toMatchObject({
      value: 'http://192.168.53.6:4096/webhooks/gitlab/%7BwebhookSecret%7D',
    })
  })

  test('declares concrete GitLab review subagents for runtime task delegation', async () => {
    const files = await readdir(reviewAgentsDir)
    expect(files).toEqual(expect.arrayContaining([
      'pm-coordinator.agent.md',
      'tech-architect.agent.md',
      'frontend-designer.agent.md',
      'risk-qa.agent.md',
      'security-agent.agent.md',
      'spec-writer.agent.md',
      'developer.agent.md',
    ]))

    const pm = await readFile(join(reviewAgentsDir, 'pm-coordinator.agent.md'), 'utf8')
    expect(pm).toEqual(expect.stringContaining('task:'))
    expect(pm).toEqual(expect.stringContaining('platform.gitlab.tech-architect'))
    expect(pm).toEqual(expect.stringContaining('platform.gitlab.frontend-designer'))
    expect(pm).toEqual(expect.stringContaining('platform.gitlab.risk-qa'))
    expect(pm).toEqual(expect.stringContaining('platform.gitlab.security-agent'))

    for (const filename of files.filter((file) => file !== 'pm-coordinator.agent.md' && file.endsWith('.agent.md'))) {
      const content = await readFile(join(reviewAgentsDir, filename), 'utf8')
      expect(content).toEqual(expect.stringContaining('mode: subagent'))
      expect(content).toEqual(expect.stringContaining('edit: deny'))
      expect(content).toEqual(expect.stringContaining('bash: deny'))
      expect(content).toEqual(expect.stringContaining('"stage"'))
      expect(content).toEqual(expect.stringContaining('"findings"'))
    }
  })

  test('builds stable runtime page context blocks', () => {
    const adapter = createGitLabPlatformAdapter()
    const page = buildGitLabPageContextPayload({
      url: 'https://gitlab.com/nine1/nine1bot/-/merge_requests/42',
      title: 'Improve runtime',
      selection: 'selected MR line',
      visibleSummary: 'MR overview',
    })

    const normalized = adapter.normalizePage(page)
    expect(normalized).toMatchObject({
      platform: 'gitlab',
      pageType: 'gitlab-mr',
      objectKey: 'gitlab.com:nine1/nine1bot:merge_request:42',
    })

    const blocks = adapter.blocksFromPage(page, 1_000) ?? []
    expect(blocks.map((block) => block.id)).toEqual([
      'platform:gitlab',
      'page:gitlab-mr',
      expect.stringMatching(/^page:browser-selection:/),
    ])
    expect(blocks[1]?.content).toEqual(expect.stringContaining('Object key: gitlab.com:nine1/nine1bot:merge_request:42'))
  })
})

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function secretAccess() {
  return {
    async get() { return undefined },
    async set() {},
    async delete() {},
    async has() { return false },
  }
}

function memorySecretAccess() {
  const store = new Map<string, string>()
  return {
    async get(ref: { provider?: string; key: string }) { return store.get(ref.key) },
    async set(ref: { provider?: string; key: string }, value: string) { store.set(ref.key, value) },
    async delete(ref: { provider?: string; key: string }) { store.delete(ref.key) },
    async has(ref: { provider?: string; key: string }) { return store.has(ref.key) },
  }
}
