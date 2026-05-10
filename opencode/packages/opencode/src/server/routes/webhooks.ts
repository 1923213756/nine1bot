import { PermissionNext } from "@/permission/next"
import { Project } from "@/project/project"
import { RuntimeControllerProtocol } from "@/runtime/controller/protocol"
import { Webhook } from "@/webhook/webhook"
import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { networkInterfaces, type NetworkInterfaceInfo } from "os"
import z from "zod"
import { lazy } from "../../util/lazy"
import { errors } from "../error"
import { runAutomatedControllerSession, type AutomatedControllerResponse } from "./automated-controller"
import {
  extractGitLabReviewStageResultFromRuntimeText,
  handleGitLabReviewWebhook,
  gitLabReviewRuntimeSkillIds,
  publishGitLabReviewRunResult,
  reportGitLabReviewRunFailure,
  resolveGitLabReviewModelSelection,
  validateGitLabDedicatedWebhookSecret as validateGitLabDedicatedWebhookPathSecret,
} from "../../../../../../packages/nine1bot/src/review/gitlab-controller"
import { buildGitLabReviewRuntimePrompt } from "../../../../../../packages/nine1bot/src/review/gitlab-controller"
import { ReviewRunStore, type ReviewRunRecord } from "../../../../../../packages/nine1bot/src/review/run-store"
import { readPlatformManagerConfig } from "../../../../../../packages/nine1bot/src/platform/config-store"
import { FilePlatformSecretStore } from "../../../../../../packages/nine1bot/src/platform/secrets"
import { registerBuiltinPlatformAdapters } from "../../../../../../packages/nine1bot/src/platform/builtin"

const WEBHOOK_CLIENT_CAPABILITIES = {
  interactions: false,
  permissionRequests: false,
  questionRequests: false,
  artifacts: false,
  filePreview: false,
  resourceFailures: true,
  continueInWeb: true,
} satisfies RuntimeControllerProtocol.ClientCapabilities

const WEBHOOK_ENTRY_BASE = {
  source: "webhook",
  platform: "generic-webhook",
  mode: "event-trigger",
  templateIds: ["default-user-template", "webhook-entry"],
} satisfies RuntimeControllerProtocol.Entry

const GITLAB_REVIEW_CLIENT_CAPABILITIES = {
  interactions: false,
  permissionRequests: false,
  questionRequests: false,
  artifacts: false,
  filePreview: false,
  resourceFailures: true,
  continueInWeb: true,
  contextAudit: true,
} satisfies RuntimeControllerProtocol.ClientCapabilities

const GitLabReviewPublishBody = z.object({
  stageResult: z.unknown(),
}).strict()

const RUN_MONITOR_TIMEOUT_MS = 30 * 60 * 1000
const PROMPT_PREVIEW_LIMIT = 4000
const FULL_PERMISSION_RULES: PermissionNext.Ruleset = [
  {
    permission: "*",
    pattern: "*",
    action: "allow",
  },
]

function projectDirectory(project: Project.Info) {
  return project.rootDirectory || project.worktree
}

function currentOrigin(c: { req: { url: string } }) {
  return new URL(c.req.url).origin
}

export function webhookLocalOrigin(input: {
  requestOrigin: string
  envLocalUrl?: string
  interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>
}) {
  if (input.envLocalUrl?.trim()) return input.envLocalUrl.trim().replace(/\/+$/, "")
  const request = new URL(input.requestOrigin)
  if (!isLoopbackHost(request.hostname)) return request.origin
  const address = firstReachableIPv4(input.interfaces ?? networkInterfaces())
  if (!address) return request.origin
  request.hostname = address
  return request.origin
}

function firstReachableIPv4(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>) {
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal && info.address) return info.address
    }
  }
  return undefined
}

function isLoopbackHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase()
  return host === "localhost" || host === "::1" || host.startsWith("127.")
}

function webhookTemplateUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/$/, "")}/webhooks/{sourceId}/{secret}`
}

function promptPreview(prompt: string) {
  return prompt.length > PROMPT_PREVIEW_LIMIT ? `${prompt.slice(0, PROMPT_PREVIEW_LIMIT)}...` : prompt
}

function sessionChoiceForSource(source: Webhook.Source): RuntimeControllerProtocol.SessionChoice {
  const choice: NonNullable<RuntimeControllerProtocol.SessionChoice> = {}
  if (source.runtimeProfile.modelMode === "custom" && source.runtimeProfile.model) {
    choice.model = source.runtimeProfile.model
  }
  const mcpServers = source.runtimeProfile.resourcesMode === "default-plus-selected"
    ? source.runtimeProfile.mcpServers.filter((server) => server.trim().length > 0)
    : []
  if (mcpServers.length > 0) {
    choice.resources = {
      mcp: {
        servers: mcpServers,
      },
    }
  }
  return Object.keys(choice).length > 0 ? choice : undefined
}

function permissionForSource(source: Webhook.Source) {
  return source.permissionPolicy.mode === "full" ? FULL_PERMISSION_RULES : undefined
}

function responseForRun(runID: string, response: AutomatedControllerResponse): Webhook.TriggerResponse {
  return {
    accepted: response.accepted,
    runId: runID,
    sessionId: response.sessionID,
    turnSnapshotId: response.turnSnapshotId,
    ...(response.accepted ? {} : { error: "controller_message_not_accepted" }),
  }
}

async function createRejectedRun(c: any, input: {
  sourceID: string
  projectID: string
  httpStatus: number
  requestSummary: unknown
  error: string
  guardType?: Webhook.GuardType
  guardReason?: string
  dedupeKey?: string
}) {
  const responseBody = {
    accepted: false,
    error: input.error,
    ...(input.guardType ? { guardType: input.guardType } : {}),
    ...(input.guardReason ? { guardReason: input.guardReason } : {}),
  } satisfies Webhook.TriggerResponse
  const run = await Webhook.createRun({
    sourceID: input.sourceID,
    projectID: input.projectID,
    status: "rejected",
    httpStatus: input.httpStatus,
    requestSummary: input.requestSummary,
    error: input.error,
    guardType: input.guardType,
    guardReason: input.guardReason,
    dedupeKey: input.dedupeKey,
    responseBody,
  })
  return c.json(
    {
      ...responseBody,
      runId: run.id,
    } satisfies Webhook.TriggerResponse,
    input.httpStatus,
  )
}

async function triggerWebhook(c: any) {
  const { sourceID, secret } = c.req.param()
  let source: Webhook.Source
  try {
    source = await Webhook.getSource(sourceID)
  } catch {
    return c.json(
      {
        accepted: false,
        error: "webhook_source_not_found",
      } satisfies Webhook.TriggerResponse,
      404,
    )
  }

  const headers = Webhook.normalizeHeaders(c.req.raw.headers)
  const query = Object.fromEntries(new URL(c.req.url).searchParams.entries())
  const requestBase = {
    method: c.req.method,
    sourceID,
    headers,
    query,
    body: undefined,
  }

  if (source.deletedAt || !source.enabled) {
    return createRejectedRun(c, {
      sourceID,
      projectID: source.projectID,
      httpStatus: 403,
      requestSummary: Webhook.requestSummary(requestBase),
      error: "webhook_source_disabled",
    })
  }

  if (!Webhook.verifySecret(source, secret)) {
    return createRejectedRun(c, {
      sourceID,
      projectID: source.projectID,
      httpStatus: 401,
      requestSummary: Webhook.requestSummary(requestBase),
      error: "invalid_webhook_secret",
    })
  }

  const contentType = c.req.header("content-type") || ""
  if (!contentType.toLowerCase().includes("application/json")) {
    return createRejectedRun(c, {
      sourceID,
      projectID: source.projectID,
      httpStatus: 400,
      requestSummary: Webhook.requestSummary(requestBase),
      error: "json_body_required",
    })
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return createRejectedRun(c, {
      sourceID,
      projectID: source.projectID,
      httpStatus: 400,
      requestSummary: Webhook.requestSummary(requestBase),
      error: "invalid_json_body",
    })
  }

  let project: Project.Info
  try {
    project = await Project.get(source.projectID)
  } catch {
    const run = await Webhook.createRun({
      sourceID,
      projectID: source.projectID,
      status: "failed",
      httpStatus: 500,
      requestSummary: Webhook.requestSummary({
        ...requestBase,
        body,
      }),
      error: "webhook_project_not_found",
    })
    return c.json(
      {
        accepted: false,
        runId: run.id,
        error: "webhook_project_not_found",
      } satisfies Webhook.TriggerResponse,
      500,
    )
  }
  const contextWithoutFields = {
    source: {
      id: source.id,
      name: source.name,
    },
    project,
    fields: {},
    body,
    headers,
    query,
  }
  const fields = Webhook.mapFields(source.requestMapping, contextWithoutFields)
  const renderContext = {
    ...contextWithoutFields,
    fields,
  }
  const renderedPrompt = Webhook.renderTemplate(source.promptTemplate, renderContext)
  const requestSummary = Webhook.requestSummary({
    ...requestBase,
    body,
  })

  return Webhook.withSourceLock(source.id, async () => {
    const guard = await Webhook.evaluateRequestGuards(source, renderContext)
    if (!guard.allowed) {
      return createRejectedRun(c, {
        sourceID,
        projectID: source.projectID,
        httpStatus: guard.httpStatus,
        requestSummary,
        error: guard.error,
        guardType: guard.guardType,
        guardReason: guard.guardReason,
        dedupeKey: guard.dedupeKey,
      })
    }

    const run = await Webhook.createRun({
      sourceID,
      projectID: source.projectID,
      status: "accepted",
      httpStatus: 202,
      requestSummary,
      renderedPromptPreview: promptPreview(renderedPrompt),
      dedupeKey: guard.dedupeKey,
    })

    const entry = {
      ...WEBHOOK_ENTRY_BASE,
      traceId: run.id,
    } satisfies RuntimeControllerProtocol.Entry

    try {
      const directory = projectDirectory(project)
      const created = await runAutomatedControllerSession({
        directory,
        title: `Webhook: ${source.name}`,
        permission: permissionForSource(source),
        sessionChoice: sessionChoiceForSource(source),
        entry,
        clientCapabilities: WEBHOOK_CLIENT_CAPABILITIES,
        parts: [{ type: "text", text: renderedPrompt }],
        timeoutMs: RUN_MONITOR_TIMEOUT_MS,
        timeoutMessage: "Webhook run monitor timed out.",
        interactionPolicy: {
          permission: source.permissionPolicy.mode === "full" ? "allow-session" : "deny",
          question: "deny",
          permissionAllowMessage: "Webhook run uses the full permission policy, so permission requests are allowed for this session.",
          permissionDenyMessage: "Webhook runs use the default non-interactive permission policy, so permission requests are denied.",
          questionDenyMessage: "Question request denied automatically in webhook run.",
        },
        async onControllerResponse(response) {
          const responseBody = responseForRun(run.id, response)
          await Webhook.updateRun(run.id, {
            sessionID: response.sessionID,
            turnSnapshotId: response.turnSnapshotId,
            status: response.accepted ? "running" : "failed",
            httpStatus: response.status,
            responseBody,
            time: { started: Date.now() },
            ...(response.accepted ? {} : { error: "controller_message_not_accepted" }),
          })
          if (response.accepted) {
            await Webhook.markCooldown(source, run.id)
          }
        },
        async onFinished(result) {
          await Webhook.updateRun(run.id, {
            status: result.status,
            ...(result.error ? { error: result.error } : {}),
            time: { finished: Date.now() },
          }).catch(() => undefined)
        },
        async onInteraction(interaction) {
          if (!interaction.error) return
          await Webhook.updateRun(run.id, {
            error: interaction.error,
          }).catch(() => undefined)
        },
      })

      return c.json(responseForRun(run.id, created), created.status as never)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const responseBody = {
        accepted: false,
        runId: run.id,
        error: message,
      } satisfies Webhook.TriggerResponse
      await Webhook.updateRun(run.id, {
        status: "failed",
        httpStatus: 500,
        error: message,
        responseBody,
        time: { finished: Date.now() },
      })
      return c.json(responseBody, 500)
    }
  })
}

export function publicGitLabReviewRun(run: ReviewRunRecord) {
  const { context: _context, ...publicRun } = run
  return publicRun
}

async function triggerGitLabReviewWebhook(c: any) {
  const contentType = c.req.header("content-type") || ""
  if (!contentType.toLowerCase().includes("application/json")) {
    return c.json({ accepted: false, error: "json_body_required" }, 400)
  }

  const platforms = await readPlatformManagerConfig()
  const secretValidation = await validateGitLabDedicatedWebhookSecret(c, platforms)
  if ("response" in secretValidation) return secretValidation.response

  let payload: unknown
  try {
    payload = await c.req.json()
  } catch {
    return c.json({ accepted: false, error: "invalid_json_body" }, 400)
  }

  const result = await handleGitLabReviewWebhook({
    payload,
    headers: Webhook.normalizeHeaders(c.req.raw.headers),
    platforms,
    secrets: new FilePlatformSecretStore(process.env.NINE1BOT_PLATFORM_SECRETS_PATH),
    ...(secretValidation.verified ? { verifiedWebhookSecret: true } : {}),
  })

  if (isAcceptedGitLabReviewWithContext(result) && result.status === "accepted") {
    startGitLabReviewRuntimeRun(result).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      ReviewRunStore.update(result.runId, {
        status: "failed",
        error: message,
      })
      reportStoredGitLabReviewFailure(result.runId, "runtime_start", message).catch(() => undefined)
    })
  }

  return c.json(result, result.accepted ? 202 : result.httpStatus as never)
}

async function validateGitLabDedicatedWebhookSecret(c: any, platforms: Awaited<ReturnType<typeof readPlatformManagerConfig>>) {
  const secret = c.req.param?.("secret")
  if (!secret) return {}

  const validation = await validateGitLabDedicatedWebhookPathSecret({
    secret,
    platforms,
    secrets: new FilePlatformSecretStore(process.env.NINE1BOT_PLATFORM_SECRETS_PATH),
  })
  if (!validation.ok) return { response: c.json({ accepted: false, error: validation.error }, 401) }
  return { verified: true }
}

type AcceptedGitLabReviewWithContext = Extract<Awaited<ReturnType<typeof handleGitLabReviewWebhook>>, { accepted: true }> & {
  context: NonNullable<Extract<Awaited<ReturnType<typeof handleGitLabReviewWebhook>>, { accepted: true }>["context"]>
}

type GitLabReviewRuntimeRunInput = {
  runId: string
  idempotencyKey: string
  trigger: AcceptedGitLabReviewWithContext["trigger"]
  context: AcceptedGitLabReviewWithContext["context"]
}

function isAcceptedGitLabReviewWithContext(
  result: Awaited<ReturnType<typeof handleGitLabReviewWebhook>>,
): result is AcceptedGitLabReviewWithContext {
  return result.accepted && Boolean(result.context)
}

function gitLabReviewRuntimeInputFromRecord(run: ReviewRunRecord): GitLabReviewRuntimeRunInput | { error: string } {
  if (!run.idempotencyKey) return { error: "review_run_idempotency_key_missing" }
  if (!run.trigger || !run.context) return { error: "review_run_context_missing" }
  return {
    runId: run.id,
    idempotencyKey: run.idempotencyKey,
    trigger: run.trigger as GitLabReviewRuntimeRunInput["trigger"],
    context: run.context as GitLabReviewRuntimeRunInput["context"],
  }
}

async function startGitLabReviewRuntimeRun(result: GitLabReviewRuntimeRunInput) {
  const directory = process.env.NINE1BOT_PROJECT_DIR || process.cwd()
  const platforms = await readPlatformManagerConfig()
  registerBuiltinPlatformAdapters({
    config: platforms,
    secrets: new FilePlatformSecretStore(process.env.NINE1BOT_PLATFORM_SECRETS_PATH),
  })
  let publishAttempted = false
  const entry = {
    source: "webhook",
    platform: "gitlab",
    mode: "gitlab-code-review",
    templateIds: ["browser-gitlab", result.trigger.objectType === "mr" ? "gitlab-mr" : "gitlab-commit"],
    traceId: result.runId,
  } satisfies RuntimeControllerProtocol.Entry

  await runAutomatedControllerSession({
    directory,
    title: `GitLab review: ${result.trigger.projectPath ?? result.trigger.projectId}`,
    sessionChoice: {
      agent: "platform.gitlab.pm-coordinator",
      ...gitLabReviewModelChoice(resolveGitLabReviewModelSelection(platforms)),
      resources: {
        skills: {
          skills: [...gitLabReviewRuntimeSkillIds],
        },
      },
    },
    entry,
    clientCapabilities: GITLAB_REVIEW_CLIENT_CAPABILITIES,
    parts: [{ type: "text", text: buildGitLabReviewRuntimePrompt(result) }],
    context: {
      blocks: result.context.contextBlocks,
    },
    timeoutMs: RUN_MONITOR_TIMEOUT_MS,
    timeoutMessage: "GitLab review run monitor timed out.",
    interactionPolicy: {
      permission: "deny",
      question: "deny",
      permissionAllowMessage: "GitLab review run allowed session permission request.",
      permissionDenyMessage: "GitLab review runs are non-interactive, so permission requests are denied.",
      questionDenyMessage: "Question request denied automatically in GitLab review run.",
    },
    async onControllerResponse(response) {
      ReviewRunStore.update(result.runId, {
        status: response.accepted ? "running" : "failed",
        sessionId: response.sessionID,
        turnSnapshotId: response.turnSnapshotId,
        ...(response.accepted ? {} : { error: "controller_message_not_accepted" }),
      })
      if (!response.accepted) {
        await reportStoredGitLabReviewFailure(result.runId, "controller_message", "controller_message_not_accepted")
      }
    },
    async onRuntimeOutput(output) {
      if (publishAttempted || output.kind !== "part" || !output.text) return
      const stageResult = extractGitLabReviewStageResultFromRuntimeText(output.text)
      if (!stageResult) return
      publishAttempted = true
      const published = await publishGitLabReviewRunResult({
        runId: result.runId,
        stageResult,
        platforms: await readPlatformManagerConfig(),
        secrets: new FilePlatformSecretStore(process.env.NINE1BOT_PLATFORM_SECRETS_PATH),
      })
      if (!published.published) {
        ReviewRunStore.update(result.runId, {
          status: "failed",
          error: published.error,
          warnings: published.warnings,
        })
        await reportStoredGitLabReviewFailure(result.runId, "publish_result", published.error)
      }
    },
    async onFinished(finished) {
      if (publishAttempted) return
      const current = ReviewRunStore.get(result.runId)
      if (current?.publishedAt) return
      if (finished.status === "succeeded") {
        const error = "gitlab_review_result_missing"
        ReviewRunStore.update(result.runId, {
          status: "failed",
          error,
          warnings: [
            ...((current?.warnings as string[] | undefined) ?? []),
            "Runtime session finished without a valid GITLAB_REVIEW_RESULT payload.",
          ],
        })
        await reportStoredGitLabReviewFailure(result.runId, "runtime_output", error)
        return
      }
      const error = finished.error ?? `runtime_finished_${finished.status}`
      ReviewRunStore.update(result.runId, {
        status: "failed",
        error,
      })
      await reportStoredGitLabReviewFailure(result.runId, "runtime_finished", error)
    },
  })
}

async function reportStoredGitLabReviewFailure(runId: string, phase: string, error: string) {
  await reportGitLabReviewRunFailure({
    runId,
    platforms: await readPlatformManagerConfig(),
    secrets: new FilePlatformSecretStore(process.env.NINE1BOT_PLATFORM_SECRETS_PATH),
    phase,
    error,
  })
}

function gitLabReviewModelChoice(model: ReturnType<typeof resolveGitLabReviewModelSelection>) {
  if (!model) return {}
  return {
    model: {
      providerID: model.providerID,
      modelID: model.modelID,
    },
  } satisfies NonNullable<RuntimeControllerProtocol.SessionChoice>
}

export function gitLabReviewPublishStatus(error: string | undefined) {
  if (!error) return 400
  if (error === "review_run_not_found") return 404
  if (error === "review_run_already_published" || error === "review_run_already_active") return 409
  if (error.startsWith("gitlab_api_")) return 502
  return 400
}

export function gitLabReviewRetryPatch(run: ReviewRunRecord) {
  return {
    status: "accepted",
    error: undefined,
    sessionId: undefined,
    turnSnapshotId: undefined,
    failureNotifiedAt: undefined,
    retryCount: (run.retryCount ?? 0) + 1,
    lastRetryAt: Date.now(),
    warnings: uniqueStrings([
      ...((run.warnings as string[] | undefined) ?? []),
      "Review run manually retried from stored GitLab context.",
    ]),
    publishedAt: undefined,
  } satisfies Parameters<typeof ReviewRunStore.update>[1]
}

async function retryGitLabReviewRun(c: any) {
  const runId = c.req.valid("param").runId
  const run = ReviewRunStore.get(runId)
  if (!run) return c.json({ accepted: false, error: "review_run_not_found" }, 404)
  if (run.publishedAt) return c.json({ accepted: false, runId, error: "review_run_already_published" }, 409)
  if (run.status === "running" || run.status === "accepted") {
    return c.json({ accepted: false, runId, error: "review_run_already_active" }, 409)
  }

  const input = gitLabReviewRuntimeInputFromRecord(run)
  if ("error" in input) return c.json({ accepted: false, runId, error: input.error }, 400)

  ReviewRunStore.update(runId, gitLabReviewRetryPatch(run))

  startGitLabReviewRuntimeRun(input).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    ReviewRunStore.update(runId, {
      status: "failed",
      error: message,
    })
    reportStoredGitLabReviewFailure(runId, "runtime_retry", message).catch(() => undefined)
  })

  return c.json({ accepted: true, runId }, 202)
}

function uniqueStrings(items: string[]) {
  return [...new Set(items)]
}

export const WebhookPublicRoutes = lazy(() =>
  new Hono()
    .post("/gitlab", triggerGitLabReviewWebhook)
    .post(
      "/gitlab/:secret",
      validator("param", z.object({ secret: z.string() })),
      triggerGitLabReviewWebhook,
    )
    .post(
      "/:sourceID/:secret",
      validator("param", z.object({ sourceID: z.string(), secret: z.string() })),
      triggerWebhook,
    ),
)

export const WebhookRoutes = lazy(() =>
  new Hono()
    .get(
      "/status",
      describeRoute({
        summary: "Get webhook service status",
        operationId: "webhooks.status",
      }),
      async (c) => {
        const localUrl = webhookLocalOrigin({
          requestOrigin: currentOrigin(c),
          envLocalUrl: process.env.NINE1BOT_LOCAL_URL,
        })
        const publicUrl = process.env.NINE1BOT_PUBLIC_URL || ""
        return c.json({
          listening: true,
          localUrl,
          publicUrl,
          localWebhookUrl: webhookTemplateUrl(localUrl),
          publicWebhookUrl: publicUrl ? webhookTemplateUrl(publicUrl) : "",
          tunnel: {
            enabled: Boolean(publicUrl),
            status: publicUrl ? "active" : "disabled",
          },
        })
      },
    )
    .get(
      "/sources",
      describeRoute({
        summary: "List webhook sources",
        operationId: "webhooks.sources.list",
        responses: {
          200: {
            description: "Webhook sources",
            content: {
              "application/json": {
                schema: resolver(Webhook.PublicSource.array()),
              },
            },
          },
        },
      }),
      async (c) => c.json(await Webhook.listSources()),
    )
    .post(
      "/sources",
      describeRoute({
        summary: "Create webhook source",
        operationId: "webhooks.sources.create",
        responses: {
          200: {
            description: "Created webhook source",
          },
          ...errors(400, 404),
        },
      }),
      validator("json", Webhook.SourceCreate),
      async (c) => c.json(await Webhook.createSource(c.req.valid("json"))),
    )
    .patch(
      "/sources/:sourceID",
      validator("param", z.object({ sourceID: z.string() })),
      validator("json", Webhook.SourceUpdate),
      async (c) => c.json(await Webhook.updateSource(c.req.valid("param").sourceID, c.req.valid("json"))),
    )
    .post(
      "/sources/:sourceID/secret/refresh",
      validator("param", z.object({ sourceID: z.string() })),
      async (c) => c.json(await Webhook.refreshSourceSecret(c.req.valid("param").sourceID)),
    )
    .delete(
      "/sources/:sourceID",
      validator("param", z.object({ sourceID: z.string() })),
      async (c) => c.json(await Webhook.deleteSource(c.req.valid("param").sourceID)),
    )
    .get(
      "/runs",
      validator(
        "query",
        z.object({
          sourceID: z.string().optional(),
          limit: z.coerce.number().min(1).max(500).optional(),
        }),
      ),
      async (c) => c.json(await Webhook.listRuns(c.req.valid("query"))),
    )
    .get(
      "/gitlab/runs",
      validator(
        "query",
        z.object({
          limit: z.coerce.number().min(1).max(500).optional(),
        }),
      ),
      async (c) => {
        return c.json({
          runs: ReviewRunStore.list({ limit: c.req.valid("query").limit }).map(publicGitLabReviewRun),
        })
      },
    )
    .get(
      "/gitlab/runs/:runId",
      validator("param", z.object({ runId: z.string() })),
      async (c) => {
        const run = ReviewRunStore.get(c.req.valid("param").runId)
        if (!run) return c.json({ error: "review_run_not_found" }, 404)
        return c.json(run)
      },
    )
    .post(
      "/gitlab/runs/:runId/publish",
      validator("param", z.object({ runId: z.string() })),
      validator("json", GitLabReviewPublishBody),
      async (c) => {
        const result = await publishGitLabReviewRunResult({
          runId: c.req.valid("param").runId,
          stageResult: c.req.valid("json").stageResult,
          platforms: await readPlatformManagerConfig(),
          secrets: new FilePlatformSecretStore(process.env.NINE1BOT_PLATFORM_SECRETS_PATH),
        })
        return c.json(result, result.published ? 200 : gitLabReviewPublishStatus(result.error))
      },
    )
    .post(
      "/gitlab/runs/:runId/retry",
      validator("param", z.object({ runId: z.string() })),
      retryGitLabReviewRun,
    ),
)
