import { reviewStageResultJsonSchema } from './output-schema'
import type { SubagentTaskSpec } from './types'

export const gitLabReviewSkillIds = [
  'platform.gitlab.gitlab-mr-review-workflow',
  'platform.gitlab.gitlab-commit-review-workflow',
  'platform.gitlab.spec-gate-review',
  'platform.gitlab.pm-risk-routing',
  'platform.gitlab.review-finding-schema',
  'platform.gitlab.verification-matrix',
  'platform.gitlab.security-review-policy',
  'platform.gitlab.gitlab-comment-rendering',
] as const

export function buildInitialGitLabReviewSubagentTasks(): SubagentTaskSpec[] {
  return [
    subagent('discovery-spec', 'spec-writer', 'platform.gitlab.subagent-prompts.spec-writer', 'abort-run'),
    subagent('technical-architecture', 'tech-architect', 'platform.gitlab.subagent-prompts.tech-architect', 'fallback'),
    subagent('frontend-review', 'frontend-designer', 'platform.gitlab.subagent-prompts.frontend-designer', 'ignore'),
    subagent('qa-verification', 'risk-qa', 'platform.gitlab.subagent-prompts.risk-qa', 'ignore'),
    subagent('security-verification', 'security-agent', 'platform.gitlab.subagent-prompts.security-agent', 'ignore'),
  ]
}

function subagent(
  id: string,
  role: string,
  promptRef: string,
  failureMode: SubagentTaskSpec['failureMode'],
): SubagentTaskSpec {
  return {
    id,
    kind: 'custom-subagent',
    role,
    promptRef,
    skills: [...gitLabReviewSkillIds],
    timeoutMs: 120_000,
    failureMode,
    outputSchema: reviewStageResultJsonSchema,
  }
}
