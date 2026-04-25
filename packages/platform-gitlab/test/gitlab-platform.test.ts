import { describe, expect, test } from 'bun:test'
import {
  buildGitLabPageContextPayload,
  createGitLabPlatformAdapter,
  gitLabTemplateIdsForPage,
  parseGitLabUrl,
} from '../src'

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
