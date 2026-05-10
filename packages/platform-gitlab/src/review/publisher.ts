import { GitLabApiError, type GitLabApiClient } from './api-client'
import { aggregateReviewFindings } from './finding-aggregator'
import { renderReviewSummaryComment } from './comment-renderer'
import { renderInlineFindingBody, validateGitLabInlinePosition } from './inline-position'
import type { GitLabDiffManifest, GitLabReviewObjectType, ReviewFinding } from './types'

export type PublishGitLabReviewInput = {
  client: Pick<GitLabApiClient, 'createNote' | 'createDiscussion'>
  projectId: string | number
  objectType: GitLabReviewObjectType
  objectId: string | number
  manifest: GitLabDiffManifest
  summary: string
  findings: ReviewFinding[]
  inlineComments: boolean
  warnings?: string[]
}

export type PublishGitLabReviewResult = {
  summaryPosted: boolean
  inlinePosted: number
  fallbackPosted: number
  warnings: string[]
}

export async function publishGitLabReviewResult(input: PublishGitLabReviewInput): Promise<PublishGitLabReviewResult> {
  const resource = resourceForObject(input.objectType)
  const aggregated = aggregateReviewFindings(input.findings)
  const warnings = [...(input.warnings ?? [])]
  let inlinePosted = 0
  let fallbackPosted = 0
  const inlineFindings: typeof aggregated = []
  const summaryFindings: typeof aggregated = input.inlineComments && input.objectType === 'mr' ? [] : [...aggregated]
  const inlineCandidates: Array<{ finding: (typeof aggregated)[number]; position: Record<string, unknown> }> = []

  if (input.inlineComments && input.objectType === 'mr') {
    for (const finding of aggregated) {
      const validation = validateGitLabInlinePosition(finding, input.manifest.files, input.manifest.diffRefs)
      if (!validation.ok) {
        summaryFindings.push(finding)
        fallbackPosted += 1
        warnings.push(`Inline fallback for ${finding.file ?? finding.title}: ${validation.reason}`)
        continue
      }
      inlineCandidates.push({ finding, position: validation.position })
      inlineFindings.push(finding)
    }
  } else if (input.inlineComments && input.objectType === 'commit') {
    warnings.push('Inline comments are skipped for commit review runs; findings are included in the summary comment.')
  }

  const summaryBody = [
    renderReviewSummaryComment({
      summary: input.summary,
      findings: summaryFindings,
      inlineFindings,
      manifest: input.manifest,
      warnings,
    }),
  ].filter(Boolean).join('\n')

  await input.client.createNote({
    projectId: input.projectId,
    resource,
    resourceId: input.objectId,
    body: summaryBody,
  })

  if (inlineCandidates.length) {
    const publishFallbacks: typeof aggregated = []
    for (const candidate of inlineCandidates) {
      try {
        await input.client.createDiscussion({
          projectId: input.projectId,
          resource,
          resourceId: input.objectId,
          body: renderInlineFindingBody(candidate.finding),
          position: candidate.position,
        })
        inlinePosted += 1
      } catch (error) {
        if (error instanceof GitLabApiError && error.status === 400) {
          const detail = summarizeGitLabApiError(error)
          publishFallbacks.push(candidate.finding)
          fallbackPosted += 1
          warnings.push(`Inline fallback for ${candidate.finding.file ?? candidate.finding.title}: GitLab API returned 400${detail ? `: ${detail}` : ''}.`)
          continue
        }
        throw error
      }
    }
    if (publishFallbacks.length) {
      await input.client.createNote({
        projectId: input.projectId,
        resource,
        resourceId: input.objectId,
        body: renderReviewSummaryComment({
          title: 'Nine1bot Inline Publish Fallback',
          summary: 'Some validated inline comments could not be posted as GitLab diff threads after the summary was created.',
          findings: publishFallbacks,
          manifest: input.manifest,
          warnings,
        }),
      })
    }
  }

  return {
    summaryPosted: true,
    inlinePosted,
    fallbackPosted,
    warnings,
  }
}

function resourceForObject(objectType: GitLabReviewObjectType): 'merge_requests' | 'repository/commits' {
  return objectType === 'mr' ? 'merge_requests' : 'repository/commits'
}

function summarizeGitLabApiError(error: GitLabApiError) {
  const body = error.responseBody?.trim()
  if (!body) return undefined
  return body.length > 240 ? `${body.slice(0, 237)}...` : body
}
