# GitLab Multi-Agent Code Review Plugin 架构设计

## 1. 定位

本功能把 GitLab MR / Commit 评论区的 `@Nine1bot` 和 GitLab webhook 作为 Nine1Bot 的平台入口，用 PM Coordinator 驱动一套多 agents 审查工作流，最终把阶段结论、阻塞项、修复建议和收口结果回写到 GitLab 评论中。

它不是把 GitLab 逻辑写进 Runtime core，也不是单独做一个 GitLab bot 服务。正确形态是：

- `packages/platform-gitlab` 提供 GitLab 平台插件能力。
- `packages/nine1bot` 负责产品级 controller、配置、路由挂载、session/profile 编译。
- `opencode/` 作为 Nine1Bot Runtime 执行通用 agent loop / multi-agent orchestration。
- `packages/platform-gitlab/agents/review` 先提供 PM、规格、架构、开发、QA、安全、修复、前端等 GitLab review agent prompt 资产。
- `packages/platform-gitlab/skills/review` 先提供 GitLab review workflow、风险分级、spec gate、finding schema、评论渲染等 GitLab review skill 资产。
- GitLab 只负责触发、上下文采集和结果回写，不拥有审查阶段语义。

核心链路：

```text
GitLab MR/Commit comment or webhook
  -> platform-gitlab 解析触发
  -> Nine1Bot Controller 创建 ReviewRun 并编译 AgentRunSpec
  -> Runtime 启动 PM 主代理并由主代理派生子代理
  -> platform-gitlab 渲染并回写 GitLab 评论
```

## 2. 顶层目录归属

```text
nine1bot/
  packages/
    platform-protocol/
      src/
        index.ts

    platform-gitlab/
      agents/
        review/
          pm-coordinator.agent.md
      skills/
        review/
          gitlab-mr-review-workflow/
            SKILL.md
          gitlab-commit-review-workflow/
            SKILL.md
          spec-gate-review/
            SKILL.md
          pm-risk-routing/
            SKILL.md
          review-finding-schema/
            SKILL.md
          verification-matrix/
            SKILL.md
          security-review-policy/
            SKILL.md
          gitlab-comment-rendering/
            SKILL.md
          subagent-prompts/
            spec-writer/SKILL.md
            tech-architect/SKILL.md
            developer/SKILL.md
            frontend-designer/SKILL.md
            risk-qa/SKILL.md
            security-agent/SKILL.md
            auto-fixer/SKILL.md
      src/
        review/
          api-client.ts
          comment-renderer.ts
          context-builder.ts
          diff-builder.ts
          event-parser.ts
          finding-aggregator.ts
          idempotency.ts
          inline-position.ts
          output-schema.ts
          settings.ts
          trigger.ts
          types.ts
          webhook.ts
          workflow.ts
        runtime.ts
        index.ts
      scripts/
        review-dry-run.ts
      fixtures/
        review/
          sample-mr-webhook.json
          sample-mr-changes.json
          sample-discussions.json

    nine1bot/
      src/
        platform/
        config/
        launcher/
        engine/
        review/
          controller.ts
          run-spec-compiler.ts
          run-store.ts
          event-router.ts

  opencode/
    packages/
      opencode/
        src/
          agent/
          session/
          runtime/
          tool/
          permission/
          mcp/
```

## 3. 分层边界

### 3.1 `packages/platform-gitlab`

这里放所有 GitLab 专属能力：

- GitLab webhook 事件解析。
- GitLab MR / Commit comment 中 `@Nine1bot` 触发识别。
- GitLab REST API client。
- MR metadata、diff、discussion、commit 数据读取。
- GitLab diff position / inline comment 映射。
- GitLab 顶层评论和 inline discussion 回写。
- GitLab review settings、secret 引用和 allowlist 校验。
- GitLab review agents / skills runtime source 声明。
- 将 GitLab 数据转换成通用 `PlatformContextBlock`、资源声明、workflow trigger。

不能放：

- Runtime agent loop 实现。
- PM / QA / Security 阶段推进的硬编码执行逻辑。
- OpenCode 内部工具调用逻辑。
- 通用 workflow 状态机的产品持久化。

### 3.2 `packages/nine1bot`

这里放产品级 controller 和通用 review workflow 编译：

- 注册 `@nine1bot/platform-gitlab` 插件。
- 挂载 `/platforms/gitlab/webhook` 或等价 route。
- 管理 GitLab 平台配置和 secrets。
- 接收 GitLab 插件输出的 `GitLabReviewTrigger` / `GitLabReviewRequest`。
- 创建或恢复 `ReviewRun`。
- 编译包含 GitLab review orchestration policy 的 `AgentRunSpec`。
- 编译 session `profileSnapshot` 和每轮 `TurnRuntimeSnapshot`。
- 接收 Runtime events，更新 review run 状态。
- 调用 GitLab 插件进行最终评论回写。

建议新增：

```text
packages/nine1bot/src/review/
  controller.ts
  run-spec-compiler.ts
  run-store.ts
  event-router.ts
```

这层可以理解为“平台无关的 Code Review Controller”。它不执行子代理，也不做 multi-agent 调度，只负责把 GitLab/其他平台入口编译成 Runtime 可执行的 `AgentRunSpec`，并把 Runtime events 转换成平台可展示的状态。GitLab 是第一个入口，后续 GitHub、Gerrit、Bitbucket 也可以复用。

### 3.3 `opencode/` / Nine1Bot Runtime

Runtime 只负责通用执行能力：

- 根据 `AgentRunSpec` 执行单 agent 或 multi-agent。
- 支持 `orchestration.mode = 'single' | 'parallel-review' | 'supervisor-workers' | 'plan-then-act'`。
- 启动 PM Coordinator 主代理。
- 为主代理提供受控的 subagent task 能力，让主代理在 Runtime 内派生子代理。
- 加载 agent 定义、context blocks、tools、MCP、skills、permissions。
- 发出 runtime events。
- 处理 tool call、permission ask、resource failure。

Runtime 不应该知道：

- GitLab webhook。
- GitLab MR / note / discussion / diff_refs。
- GitLab API URL。
- GitLab inline comment position。

### 3.4 `packages/platform-gitlab/agents/review`

这里先只放固定主代理：

- `pm-coordinator.agent.md`：主流程 supervisor。

其余 7 个角色不作为固定 agent catalog 直接注册，而是改造成 skill 内的自定义子代理 prompt 模板。PM 主代理在 Runtime 内读取这些 skill instructions 后，通过 `SubagentTaskSpec.prompt` 创建自定义子代理。

迁移建议：

```text
from: docs/agents/agents/pm-coordinator.agent.md
to:   packages/platform-gitlab/agents/review/pm-coordinator.agent.md

from: docs/agents/agents/{spec-writer,tech-architect,developer,frontend-designer,risk-qa,security-agent,auto-fixer}.agent.md
to:   packages/platform-gitlab/skills/review/subagent-prompts/<role>/SKILL.md
```

首版直接使用当前架构提供的 `PlatformAdapterContribution.runtime.sources.agents` 注册平台 agent source，不需要新增全局 agent registry。Platform Adapter Manager 会在 GitLab 平台启用时注册该 source，在平台禁用时注销。

GitLab contribution 中建议声明：

```ts
runtime: {
  createAdapter: createGitLabPlatformAdapter,
  sources: {
    agents: [
      {
        id: 'gitlab-review-agents',
        directory: new URL('../agents', import.meta.url).pathname,
        namespace: 'platform.gitlab',
        visibility: 'recommendable',
        lifecycle: 'platform-enabled',
      },
    ],
  },
}
```

PM 主代理应命名为 `platform.gitlab.pm-coordinator`，并作为 `recommendedAgent` 或显式 session choice 使用；它不能进入 `defaultAgent()`。GitLab 平台禁用后，旧 session 如果冻结了该平台 agent，应按当前 runtime 语义 fail closed，并发出 `runtime.agent.unavailable`。

迁移时还要改造 prompt 内容：

- 去掉另一个项目特有的路径、工具名和流程假设。
- 将强制 spec coding 规则调整为“MR review workflow policy”，避免小 MR 因缺少三件套被无条件阻塞。
- 将输出统一到 `review-finding-schema` skill 定义的 JSON Schema。
- 明确哪些自定义子代理可以执行代码修改，哪些只能审查或产出建议。
- 工具能力不写死在 prompt 中，而由 PM 生成 `SubagentTaskSpec.allowedTools`，Runtime 再强校验。

### 3.5 `packages/platform-gitlab/skills/review`

这里放可复用的 workflow 方法、检查清单和输出协议。原则是：

- Agent 负责“谁来做”。
- Skill 负责“按什么方法做”。
- Platform plugin 负责“从哪里来、回哪里去”。
- Runtime orchestration 负责“如何执行和并行”。

建议新增这些 review skills：

| Skill | 目录 | 职责 |
| --- | --- | --- |
| GitLab MR Review Workflow | `packages/platform-gitlab/skills/review/gitlab-mr-review-workflow/SKILL.md` | 定义 MR 从 trigger 到 closed 的阶段流 |
| GitLab Commit Review Workflow | `packages/platform-gitlab/skills/review/gitlab-commit-review-workflow/SKILL.md` | 定义 commit 评论触发下的窄范围审查 |
| Spec Gate Review | `packages/platform-gitlab/skills/review/spec-gate-review/SKILL.md` | 判断 requirements/design/tasks 是否足够支撑审查或实现 |
| PM Risk Routing | `packages/platform-gitlab/skills/review/pm-risk-routing/SKILL.md` | 判断 QA/Security/Frontend/Developer 的派发路径 |
| Review Finding Schema | `packages/platform-gitlab/skills/review/review-finding-schema/SKILL.md` | 统一 finding 严重级别、字段和 JSON 输出 |
| Verification Matrix | `packages/platform-gitlab/skills/review/verification-matrix/SKILL.md` | 指导 QA 建覆盖矩阵、最小验证集和未覆盖项 |
| Security Review Policy | `packages/platform-gitlab/skills/review/security-review-policy/SKILL.md` | 指导安全审查范围分级、跳过规则和阻塞口径 |
| GitLab Comment Rendering | `packages/platform-gitlab/skills/review/gitlab-comment-rendering/SKILL.md` | 指导如何把 stage result 渲染为 GitLab 评论 |
| Subagent Prompt Templates | `packages/platform-gitlab/skills/review/subagent-prompts/*/SKILL.md` | 提供 PM 创建自定义子代理时使用的角色 prompt 模板 |

技能内容应尽量是平台可复用的流程知识。GitLab API endpoint、token 读取、webhook payload 解析仍然留在 `packages/platform-gitlab`。

首版直接使用当前架构提供的 `PlatformAdapterContribution.runtime.sources.skills` 注册平台 skill source。GitLab review skills 应使用 `visibility: 'declared-only'`，避免普通 Web session 默认继承。

GitLab contribution 中建议声明：

```ts
runtime: {
  createAdapter: createGitLabPlatformAdapter,
  sources: {
    skills: [
      {
        id: 'gitlab-review-skills',
        directory: new URL('../skills', import.meta.url).pathname,
        namespace: 'platform.gitlab',
        visibility: 'declared-only',
        lifecycle: 'platform-enabled',
      },
    ],
  },
}
```

`packages/platform-gitlab` 声明本次 review session 需要哪些 skill id，例如：

```ts
skills: {
  skills: [
    'platform.gitlab.gitlab-mr-review-workflow',
    'platform.gitlab.spec-gate-review',
    'platform.gitlab.pm-risk-routing',
    'platform.gitlab.review-finding-schema',
    'platform.gitlab.verification-matrix',
    'platform.gitlab.security-review-policy',
    'platform.gitlab.gitlab-comment-rendering',
  ],
  lifecycle: 'session',
  mergeMode: 'additive-only',
}
```

Controller 创建 review session 时将这些 GitLab 插件 skills 写入 `profileSnapshot.resources.skills`。Runtime 在本轮 `TurnRuntimeSnapshot` 中用 `includeDeclaredOnly` 解析平台 skill availability，并把可用的 skill instructions 交给 Context Pipeline。平台禁用后，旧 profile 中声明的平台 skill 会变成 unavailable，并走 `runtime.resource.failed` / audit。

## 4. 与 Runtime Sources 架构对齐

最近的 Runtime Source 架构已经支持平台包声明自己的 agent / skill source。GitLab review 必须使用这条路径：

```ts
export const gitlabPlatformContribution = {
  descriptor: gitlabPlatformDescriptor,
  runtime: {
    createAdapter: createGitLabPlatformAdapter,
    sources: {
      agents: [
        {
          id: 'gitlab-review-agents',
          directory: new URL('../agents', import.meta.url).pathname,
          namespace: 'platform.gitlab',
          visibility: 'recommendable',
          lifecycle: 'platform-enabled',
        },
      ],
      skills: [
        {
          id: 'gitlab-review-skills',
          directory: new URL('../skills', import.meta.url).pathname,
          namespace: 'platform.gitlab',
          visibility: 'declared-only',
          lifecycle: 'platform-enabled',
        },
      ],
    },
  },
} satisfies PlatformAdapterContribution
```

含义：

- Platform Adapter Manager 在 GitLab 启用时注册 sources，在禁用时注销 sources。
- `PlatformManagerDetail.runtimeSources` 会暴露 source 注册状态，Web 多平台设置页可以展示 agents / skills source 摘要。
- `recommendable` 平台 agent 不进入 `Agent.defaultAgent()`，但可被平台推荐或 session 显式选择。
- `declared-only` 平台 skills 不进入普通 Web 会话，只有 GitLab review session 的 `profileSnapshot.resources.skills` 显式声明后才可解析。
- 平台禁用是 hard gate。旧 session 后续 turn 如果引用 GitLab agent，会 fail closed 并发 `runtime.agent.unavailable`；如果引用 GitLab skill，会走 unavailable / resource failure / audit。
- Runtime core 仍不 import `@nine1bot/platform-gitlab`。

## 5. GitLab 插件内部模块

建议在 `packages/platform-gitlab/src/review` 下实现：

```text
review/
  types.ts
```

定义 GitLab review 相关类型：

- `GitLabWebhookInput`
- `GitLabWebhookEvent`
- `GitLabReviewTrigger`
- `GitLabReviewRequest`
- `GitLabReviewSettings`
- `GitLabCommentPlan`
- `GitLabPublishResult`

```text
review/event-parser.ts
```

职责：

- 校验 webhook event kind。
- 解析 note event、merge request event、commit comment event。
- 输出稳定的 `GitLabWebhookEvent`。
- 不访问网络，不写状态。

```text
review/trigger.ts
```

职责：

- 判断评论是否包含 `@Nine1bot`。
- 解析命令：`review`、`security`、`qa`、`fix`、`recheck`。
- 提取用户附加指令。
- 判断 MR note / commit note 是否可触发。

```text
review/idempotency.ts
```

职责：

- 生成绑定代码状态的幂等 key。
- 标记 review run 是否已处理。
- 第一阶段可只提供接口和内存实现，真实持久化放到 `packages/nine1bot/src/review/run-store.ts`。

MR 审查幂等 key 必须包含 `head_sha`：

```text
manual note:
gitlab:{host}:{projectId}:mr:{mrIid}:head_sha:{headSha}:note:{noteId}

auto webhook:
gitlab:{host}:{projectId}:mr:{mrIid}:head_sha:{headSha}:auto:{eventName}
```

不能只使用 `mrIid`。同一个 MR 在 push 新 commit 后 `mrIid` 不变，但 `head_sha` 会变化，必须允许重新审查新代码。

```text
review/api-client.ts
```

职责：

- GitLab REST API 最小 client。
- 获取 MR metadata。
- 获取 MR changes / diffs。
- 获取 MR discussions。
- 获取 commit 信息。
- 创建 MR note / commit note。
- 创建 inline discussion。

```text
review/diff-builder.ts
```

职责：

- 将 GitLab diff 转为审查用 `changedFiles`。
- 生成 changed file manifest。
- 控制 diff token / bytes 预算。
- 对大 MR 做摘要和裁剪。
- 检测 GitLab API diff overflow / 截断。
- 过滤 lock 文件、构建产物和二进制/多媒体/生成文件。

必须硬编码首版文件过滤黑名单：

```ts
const excludedDiffFilePatterns = [
  /(^|\/)(package-lock|yarn\.lock|pnpm-lock|bun\.lockb?|composer\.lock|Gemfile\.lock)$/i,
  /(^|\/)dist\//i,
  /(^|\/)build\//i,
  /(^|\/)coverage\//i,
  /(^|\/)\.next\//i,
  /(^|\/)\.nuxt\//i,
  /\.min\.(js|css)$/i,
  /\.(map|png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|mp4|mov|mp3|woff2?|ttf|eot)$/i,
]
```

如果 GitLab changes/diff 返回 `overflow = true`，或关键 diff 为空但文件状态显示有变更，必须将 review run 标记为 `blocked`，并回写 MR 顶层评论：

```text
MR 差异过大或被 GitLab 截断，Nine1Bot 拒绝自动审查。请人工 Review 或拆分 MR 后重新触发。
```

禁止在 diff 不完整时让 agent 基于空 diff 继续审查。

```text
review/context-builder.ts
```

职责：

- 将 `GitLabReviewRequest` 转为 `PlatformContextBlock[]`。
- 生成 MR / Commit / diff / discussion / trigger note / output contract blocks。
- 不拼接最终 prompt，只产出结构化 blocks。

```text
review/workflow.ts
```

职责：

- 根据 GitLab trigger 和 changed files 生成 `GitLabReviewWorkflowPlan`。
- 选择所需 GitLab review skills 和允许的 prompt assets。
- 输出通用 workflow hints：
  - `entry.mode = 'mr-review' | 'commit-review'`
  - `orchestration.mode`
  - `stages`
  - `allowedTaskKinds`

```text
review/output-schema.ts
```

职责：

- 用 Zod 定义 `ReviewStageResult`、`ReviewFinding`、`ReviewRunReport`。
- 生成传给 Runtime 的 JSON Schema。
- 在 Controller 收口处反序列化和类型校验 Runtime 返回的 `Record<string, unknown>`。
- 不让 `opencode` / Runtime 依赖这些业务类型。

```text
review/finding-aggregator.ts
```

职责：

- 对 QA / Security / Frontend / Architect 等子代理返回的 findings 先做代码侧聚合。
- 按 `file + newLine + oldLine + category` 分组。
- 合并重复 finding、保留来源 agents、取最高 severity。
- 再把聚合结果交给 PM 主代理润色和冲突裁决。
- 不把数组合并去重这种确定性逻辑交给 LLM。

```text
review/comment-renderer.ts
```

职责：

- 将 Runtime 输出渲染为 GitLab Markdown 评论。
- 顶层 summary comment。
- 阶段失败 comment。
- inline finding comment。
- dry-run comment。

```text
review/inline-position.ts
```

职责：

- 校验 finding 的 file/line 是否真的落在当前 diff hunk 的可评论行内。
- 将合法 finding 映射为 GitLab discussion position。
- 对非法行号或 GitLab API 400 做 fallback。

inline position 不能信任 LLM 行号。流程必须是：

1. 拿到 finding `{ file, oldLine?, newLine? }`。
2. 在原始 diff hunk 中解析可评论行集合。
3. 只有 line 落在变更 hunk 中，才创建 inline discussion。
4. 如果 line 不在 hunk 中，或 GitLab API 返回 400，将该 finding 降级为 summary note。
5. inline 失败不能让整个 review run 失败。

```text
review/webhook.ts
```

职责：

- 提供 `handleGitLabWebhook()` 这种无框架函数。
- 输入 headers/body/settings/secrets/client factory。
- 输出平台触发结果，不直接启动 HTTP server。

## 6. 通用 Review Controller

建议在 `packages/nine1bot/src/review` 中放通用 controller。

```text
review/controller.ts
```

职责：

- 接收平台插件产出的 `PlatformReviewTrigger`。
- 创建 `ReviewRun`。
- 调用 workflow compiler。
- 调用 Runtime。
- 收集 Runtime events。
- 交给平台插件渲染和发布评论。

```text
review/run-spec-compiler.ts
```

职责：

- 将 `GitLabReviewRequest` 这类平台请求编译成 Runtime 当前可消费的 `AgentRunSpec`。
- 决定 `profileSnapshot`、`context.blocks`、`resources`、`permissions`、`orchestration`。
- 写入 `orchestration.mode = 'supervisor-workers'`、PM 主代理、允许派生的子代理类型、可用 skills 和输出契约。

```text
review/run-store.ts
```

职责：

- 持久化 review run 状态。
- 记录幂等 key。
- 记录阶段状态、trace id、GitLab note id、最终评论 id。
- 第一阶段可以复用现有 storage，或先抽象接口。

```text
review/event-router.ts
```

职责：

- 将 Runtime events 转换为 review run events。
- 处理 resource failure、permission ask、supervisor started、subagent task started/completed、stage blocked。
- 给 Web debug / GitLab comment renderer 提供统一事件源。

## 7. AgentRunSpec 与 Runtime Subagent Task

为了不把 GitLab 阶段流写死到平台包，也不把 8 个 agents 固定绑定到某个 GitLab workflow，Controller 应把 GitLab review 编译成一个普通 `AgentRunSpec`，其中的 `orchestration` policy 指明本次运行由 Runtime 启动 PM 主代理，并允许主代理派生受控子代理。

核心思路：

- `AgentRunSpec` 描述一次 review run 的来源、上下文、资源、skills、权限和 orchestration policy。
- `PM Coordinator` 是唯一默认 supervisor。
- 其他 reviewer / implementer / verifier 都由 PM 主代理在 Runtime 内按需生成 `SubagentTaskSpec`。
- Runtime 提供通用 subagent task 执行能力，负责创建子代理、裁剪上下文、注入 skills、限制工具、收集结构化输出。

```ts
type SubagentTaskKind =
  | 'discovery'
  | 'spec'
  | 'architecture-review'
  | 'frontend-review'
  | 'implementation'
  | 'qa'
  | 'security'
  | 'fix'
  | 'closed'

type ReviewStageSpec = {
  id: 'discovery' | 'spec' | 'implementation' | 'verification' | 'fix' | 'closed'
  required: boolean
  execution: 'supervisor' | 'subagent-task' | 'parallel-subagent-tasks'
  dependsOn?: string[]
  gate?: string
}

type ReviewOrchestrationPolicy = {
  mode: 'supervisor-workers'
  supervisor: {
    agent: 'platform.gitlab.pm-coordinator'
    skills: string[]
  }
  stages: ReviewStageSpec[]
  subagentTask: {
    enabled: true
    allowedTaskKinds: SubagentTaskKind[]
    allowedPromptSkillRefs: string[]
    allowedSkillRefs: string[]
    maxParallelTasks: number
    defaultTimeoutMs: number
  }
  output: {
    schema: 'review-run-report-v1'
  }
}
```

Controller 将该 policy 放入 `AgentRunSpec.orchestration`。Runtime 冻结 `TurnRuntimeSnapshot` 后，启动 PM 主代理。PM 在每个阶段根据 workflow skill、MR 上下文、风险分级和历史状态动态产出任务：

```ts
type SubagentTaskSpec = {
  id: string
  stage: ReviewStageSpec['id']
  kind: SubagentTaskKind
  prompt?: string
  promptRef?: string
  skills: string[]
  contextRefs: string[]
  allowedTools: string[]
  outputSchema: Record<string, unknown>
  timeoutMs?: number
  failureMode: 'abort-run' | 'ignore' | 'fallback'
  fallbackPrompt?: string
  parallelGroup?: string
  dependsOn?: string[]
  fileScope?: string[]
}
```

PM 主代理可以直接在 `prompt` 中写入自定义子代理提示词，也可以用 `promptRef` 引用 `packages/platform-gitlab/skills/review/subagent-prompts/*` 中的 prompt skill。`skills` 指向 Runtime 已解析的 skill catalog，例如 `platform.gitlab.verification-matrix`。`contextRefs` 指向 `TurnRuntimeSnapshot` 中已编译好的 context blocks 或 diff slices。`allowedTools` 只能从当前 session 已解析且权限允许的工具集合中取子集。

Runtime 不理解 `ReviewStageResult` 或 `ReviewFinding` 这类业务类型。`outputSchema` 是 Controller / GitLab 插件传入的 JSON Schema；Runtime 只负责约束模型输出符合 schema，并返回 `Record<string, unknown>`。具体反序列化、Zod 校验、finding 聚合和 GitLab 渲染都在 `packages/platform-gitlab` / `packages/nine1bot/src/review` 收口。

`failureMode` 语义：

- `abort-run`：任务失败或超时后立即中断整个 review run，并回写失败原因。PM Coordinator 自身必须使用该模式。
- `ignore`：任务失败或超时后继续运行，最终报告中标记该节点未完成。QA/Security 可按风险使用该模式。
- `fallback`：任务失败或超时后使用 `fallbackPrompt` 或更小上下文重试一次，失败后再按该阶段策略降级。

GitLab 插件只提供 workflow hints 和推荐 skill ids；Controller 只把这些信息编译成 `AgentRunSpec`；真正的阶段推进、主代理执行和子代理派生都发生在 Runtime 内。workflow 本身的阶段规则优先来自 skill，子代理选择由 PM 主代理动态决定，而不是写死在 GitLab 插件或 Controller 中。

## 8. PM 动态 Subagent Task 阶段流

用户设计的主链路建议落为 `GitLab Review Workflow v1`：

```text
GitLab trigger
  -> PM Coordinator 恢复状态 & 风险分级
  -> PM 读取 workflow skills
  -> PM 在 Runtime 内按阶段动态创建 SubagentTaskSpec
  -> Runtime 执行子代理任务并返回结构化结果
  -> PM 合并、裁决并推进下一阶段
  -> closed
  -> GitLab comment publish
```

阶段与默认子代理模板：

| 阶段 | PM 可能创建的任务 | prompt 来源 | 主要输出 |
| --- | --- | --- | --- |
| trigger | 无子代理，平台插件解析 | `platform-gitlab` | `GitLabReviewTrigger` |
| coordinator | supervisor 本体执行 | `platform.gitlab.pm-coordinator` | 风险分级、阶段路由、任务计划 |
| discovery | 文档取证任务 | `platform.gitlab.subagent-prompts.spec-writer` | 取证、基线、假设、影响模块 |
| spec | spec gate / spec 落文任务 | `platform.gitlab.subagent-prompts.spec-writer` | `requirements.md`、`design.md`、`tasks.md` 或 spec 缺口 |
| implementation | 架构审查任务、前端审查任务、开发实现任务 | `platform.gitlab.subagent-prompts.tech-architect` / `platform.gitlab.subagent-prompts.frontend-designer` / `platform.gitlab.subagent-prompts.developer` | 架构审查、实现建议、必要补丁或隔离子任务 |
| verification | QA 任务、安全任务，可并行 | `platform.gitlab.subagent-prompts.risk-qa` / `platform.gitlab.subagent-prompts.security-agent` | 测试结论、安全结论 |
| fix | 修复任务 | `platform.gitlab.subagent-prompts.auto-fixer` | 根因、最小补丁、定向复测 |
| closed | 收口记录任务 | `platform.gitlab.subagent-prompts.spec-writer` | 进度、变更日志、memory 收口 |
| publish | 无子代理，GitLab renderer 渲染 | `platform-gitlab` | MR / Commit 评论 |

风险分级规则：

- 涉及运行时代码、对外接口、权限、token、HTTP、shell、path、依赖、构建供应链：QA + Security 并行。
- 仅测试代码、测试资源、非生产配置：只派发 QA。
- 涉及 `web/**`、`.vue`、CSS、交互：implementation 阶段优先选择 Frontend Designer，verification 仍由 QA 负责。

PM 生成并行验证任务示例：

```ts
const verificationTasks: SubagentTaskSpec[] = [
  {
    id: 'verify-qa',
    stage: 'verification',
    kind: 'qa',
    promptRef: 'platform.gitlab.subagent-prompts.risk-qa',
    skills: ['platform.gitlab.verification-matrix', 'platform.gitlab.review-finding-schema'],
    contextRefs: ['gitlab.mr.metadata', 'gitlab.diff.manifest', 'gitlab.diff.summary', 'gitlab.discussions'],
    allowedTools: ['read', 'search', 'test'],
    outputSchema: reviewStageResultJsonSchema,
    failureMode: 'ignore',
    parallelGroup: 'verification',
  },
  {
    id: 'verify-security',
    stage: 'verification',
    kind: 'security',
    promptRef: 'platform.gitlab.subagent-prompts.security-agent',
    skills: ['platform.gitlab.security-review-policy', 'platform.gitlab.review-finding-schema'],
    contextRefs: ['gitlab.mr.metadata', 'gitlab.diff.manifest', 'gitlab.diff.summary'],
    allowedTools: ['read', 'search'],
    outputSchema: reviewStageResultJsonSchema,
    failureMode: 'ignore',
    parallelGroup: 'verification',
  },
]
```

这意味着 GitLab 插件和 Controller 都不需要知道子代理底层如何启动。PM 主代理只声明任务，Runtime 统一负责启动、隔离、执行、收集结果。

阶段与 skill 映射：

| 阶段 | Skill | 主要用途 |
| --- | --- | --- |
| workflow bootstrap | `platform.gitlab.gitlab-mr-review-workflow` | 定义 MR review 的阶段顺序、门禁和默认降级策略 |
| workflow bootstrap | `platform.gitlab.gitlab-commit-review-workflow` | 定义 commit review 的窄范围流程 |
| coordinator | `platform.gitlab.pm-risk-routing` | PM Coordinator 按文件类型、权限面、运行时面做风险分级 |
| discovery/spec | `platform.gitlab.spec-gate-review` | 文档规格专家判断 spec 是否存在、是否完整、是否可指导审查 |
| verification | `platform.gitlab.verification-matrix` | QA 建立覆盖矩阵、最小验证集和未覆盖项 |
| verification | `platform.gitlab.security-review-policy` | Security 判定安全审查范围、跳过条件和阻塞口径 |
| all stages | `platform.gitlab.review-finding-schema` | 所有 agent 统一输出 finding / stage result |
| publish | `platform.gitlab.gitlab-comment-rendering` | 将结构化结果转成 GitLab summary / inline 评论 |

## 9. GitLab 触发类型

### 8.1 MR 评论区 `@Nine1bot`

GitLab note webhook：

- `object_kind = 'note'`
- `object_attributes.noteable_type = 'MergeRequest'`
- `object_attributes.note` 包含 bot mention。

适合触发：

- `@Nine1bot review`
- `@Nine1bot security`
- `@Nine1bot qa`
- `@Nine1bot fix`
- `@Nine1bot recheck`

### 8.2 Commit 评论区 `@Nine1bot`

GitLab note webhook：

- `object_kind = 'note'`
- `object_attributes.noteable_type = 'Commit'`
- `object_attributes.note` 包含 bot mention。

适合触发较窄范围审查：

- 只读取 commit diff。
- 不执行完整 MR spec gate，除非能关联 MR。
- 评论回写到 commit note。

### 8.3 Webhook 自动触发

GitLab merge request webhook：

- MR opened。
- MR updated。
- MR marked ready。
- label 包含配置的 auto-review label。

默认建议保守：

- 第一阶段只启用手动 `@Nine1bot`。
- 自动触发通过 settings 显式开启。
- 自动触发必须有幂等和节流。

## 10. Context 和 History 关系

GitLab 插件构建 context blocks：

- `platform:gitlab`
- `page:gitlab-mr` 或 `page:gitlab-commit`
- `business:gitlab-review-trigger`
- `business:gitlab-diff-manifest`
- `business:gitlab-diff-summary`
- `business:gitlab-existing-discussions`
- `runtime:review-output-contract`

Controller 负责决定哪些内容进入 history：

- 新 MR review run 创建时写入 synthetic context event。
- 同一个 note 重放不重复写 history。
- `recheck` 应复用上一轮 review run 摘要，并追加新的 context event。

Runtime 每个 agent stage 使用同一份 `TurnRuntimeSnapshot`，阶段内不重新采集 GitLab 状态。需要最新状态时由显式 GitLab context refresh 工具完成。

Subagent task 的上下文必须来自 Runtime 冻结的 `TurnRuntimeSnapshot`。PM 主代理可以给不同子代理分配不同 `contextRefs`，但不能让子代理绕过 snapshot 自行读取新的 GitLab 状态。这样可以保证同一阶段内 QA、安全、架构等子代理看到的是同一个 MR 世界。

## 11. 资源与权限

GitLab 插件声明资源，不直接创建 Runtime tool：

```ts
type GitLabReviewResourceContribution = {
  builtinTools: {
    enabledGroups: ['gitlab-context', 'gitlab-review-comment'],
  }
  mcp: {
    servers: [],
    lifecycle: 'session',
    mergeMode: 'additive-only',
  }
  skills: {
    skills: [
      'platform.gitlab.gitlab-mr-review-workflow',
      'platform.gitlab.spec-gate-review',
      'platform.gitlab.pm-risk-routing',
      'platform.gitlab.review-finding-schema',
      'platform.gitlab.verification-matrix',
      'platform.gitlab.security-review-policy',
      'platform.gitlab.gitlab-comment-rendering',
    ],
    lifecycle: 'session',
    mergeMode: 'additive-only',
  }
}
```

权限建议：

- 读取 MR / diff / discussions：默认 allow，但受 host/project allowlist 限制。
- 写 GitLab 评论：默认 ask 或由平台配置授权。
- inline comment：比 summary comment 更高风险，可单独开关。
- fix 阶段写文件 / push branch：第一阶段禁用，后续必须显式授权。
- 子代理 `allowedTools` 必须是当前 session 已解析工具的子集，不能由 prompt 自行“发明”工具。
- 子代理不能直接继承 supervisor 的全部工具；PM 主代理必须按任务类型显式裁剪，Runtime 再做强校验。
- 子代理执行结果只返回给 PM 主代理 / Runtime，不直接展示给 GitLab 用户；最终展示由 PM 汇总后交给 GitLab renderer。

Secret：

- Webhook secret 存在 Nine1Bot secret store。
- GitLab token 存在 Nine1Bot secret store。
- `packages/platform-gitlab` 只通过 `PlatformSecretAccess` 读取，不自行落盘。

## 12. 配置位置

GitLab code review 必须由用户在 Web 配置页显式启用，默认关闭。原因是该功能会接收外部 webhook、读取代码 diff、调用模型并可能写回 GitLab 评论，属于有外部攻击面和写操作的能力。

Web 配置入口建议放在现有“平台适配 / GitLab”详情页中：

```text
web/src/components/
  PlatformSettingsPanel.vue          # 若已有平台设置入口，则扩展它
  GitLabReviewSettingsPanel.vue      # 可选：GitLab review 专用配置表单
```

配置页应该分成四块：

1. `Enable`：是否启用 GitLab code review，默认 `false`。
2. `Connection`：GitLab host、project allowlist、bot mention。
3. `Credentials`：Webhook secret、GitLab access token。
4. `Review behavior`：手动 `@Nine1bot`、自动 webhook、inline comment、dry-run、diff 限额、多 agents 模式。

GitLab 平台 settings 建议扩展：

```ts
type GitLabReviewSettings = {
  enabled: boolean
  botMention: string
  gitlabBaseUrl: string
  webhookSecretRef?: PlatformSecretRef
  accessTokenRef?: PlatformSecretRef
  allowedHosts: string[]
  allowedProjects?: string[]
  review: {
    manualMentionEnabled: boolean
    autoWebhookEnabled: boolean
    autoReviewLabels: string[]
    executionMode: 'supervisor-only' | 'dynamic-subagents'
    maxDiffBytes: number
    postSummaryComment: boolean
    postInlineComments: boolean
    dryRun: boolean
  }
}
```

默认值：

```ts
const defaultGitLabReviewSettings = {
  enabled: false,
  botMention: '@Nine1bot',
  allowedHosts: [],
  allowedProjects: [],
  review: {
    manualMentionEnabled: true,
    autoWebhookEnabled: false,
    autoReviewLabels: [],
    executionMode: 'dynamic-subagents',
    maxDiffBytes: 200_000,
    postSummaryComment: true,
    postInlineComments: false,
    dryRun: true,
  },
}
```

实现归属：

- 类型定义：`packages/platform-gitlab/src/review/settings.ts`
- 平台 descriptor 表单项：`packages/platform-gitlab/src/runtime.ts`
- schema 接入：`packages/nine1bot/src/config/schema.ts`
- Web 设置页展示：`web/src/components` 或现有平台设置页组件。
- secret 存取：`packages/nine1bot/src/platform` / `preferences` 现有机制
- 配置校验：`packages/platform-gitlab/src/review/settings.ts` + `packages/nine1bot/src/platform`。

配置页需要提示用户准备：

- 一个 Nine1Bot 可公网访问或 GitLab 可访问的 webhook URL。
- 一个 GitLab project webhook，至少开启 Comment events；自动审查再开启 Merge request events。
- 一个 webhook secret，用于校验 GitLab 请求。
- 一个 GitLab bot 账号或 project access token。
- token 至少需要能读取 MR/diff/discussion 并创建 MR note；如果要写评论，通常需要 `api` scope。
- 项目 allowlist，避免一个 token 意外作用到不该审查的项目。

## 13. 输出、聚合和回写

Runtime 输出是被 JSON Schema 约束后的通用 JSON：

```ts
type RuntimeStructuredOutput = Record<string, unknown>
```

GitLab review 业务层负责用 Zod 校验成具体结果：

```ts
type ReviewRunReport = {
  status: 'passed' | 'failed' | 'blocked'
  stages: ReviewStageResult[]
  findings: ReviewFinding[]
  testsRun: string[]
  securityChecks: string[]
  uncoveredItems: string[]
  recommendedNextStage: 'fix' | 'verification' | 'closed'
  traceId: string
}
```

收口顺序：

1. Runtime 返回 `Record<string, unknown>`。
2. `packages/platform-gitlab/src/review/output-schema.ts` 用 Zod 校验为 `ReviewStageResult` / `ReviewRunReport`。
3. `finding-aggregator.ts` 先按 `file + oldLine + newLine + category` 对 findings 做代码侧聚合。
4. PM 主代理只处理聚合后的冲突裁决和文字润色。
5. `comment-renderer.ts` 转成 GitLab Markdown。

GitLab renderer 负责：

- 将 `ReviewRunReport` 转成 GitLab Markdown。
- 失败时突出 blocker / major findings。
- 通过时说明验证范围和未覆盖风险。
- inline comments 必须先经过 `inline-position.ts` 校验；校验失败或 GitLab API 400 时降级到 summary。
- 评论中带 trace id 和幂等 key。

首版回写一个 MR 顶层 note，后续再做 inline。

## 14. 首版实现顺序

### Phase 0：Agent/Skill 迁移、Web 配置入口和 Dry-Run Harness

实现目录：

- `packages/platform-gitlab/agents/review/*.agent.md`
- `packages/platform-gitlab/skills/review/*/SKILL.md`
- `packages/platform-gitlab/src/review/settings.ts`
- `packages/platform-gitlab/src/runtime.ts`
- `packages/platform-gitlab/scripts/review-dry-run.ts`
- `packages/platform-gitlab/fixtures/review/*.json`
- `packages/nine1bot/src/config/schema.ts`
- `web/src/components/*`

能力：

- 将 `pm-coordinator.agent.md` 迁移到 `packages/platform-gitlab/agents/review`。
- 将其余 7 个 agent 改造成 `packages/platform-gitlab/skills/review/subagent-prompts/*/SKILL.md`。
- 新增 GitLab review workflow skills，将阶段流、风险分级、spec gate、finding schema、QA 矩阵、安全策略和 GitLab 评论渲染从固定 agent prompt 中抽出。
- 在 `gitlabPlatformContribution.runtime.sources` 中声明 GitLab review agent / skill sources，分别使用 `recommendable` 和 `declared-only` visibility。
- Controller 可以按 `profileSnapshot.resources.skills` 显式声明 GitLab review skills，Runtime 通过 declared-only source 解析并注入可用 skill instructions。
- GitLab code review 默认关闭。
- Web 配置页可以启用功能、配置 host/project allowlist、bot mention、webhook secret、access token、dry-run、inline comment、自动 webhook 等选项。
- 配置页展示用户需要在 GitLab 侧创建的 webhook URL 和所需 token 权限。
- 提供本地 dry-run harness：不依赖真实 GitLab webhook，直接读取 fixture 的 MR webhook、changes、discussions JSON，跑通 trigger、diff-builder、context-builder、run-spec-compiler 和 comment-renderer。

### Phase 1：平台触发闭环

实现目录：

- `packages/platform-gitlab/src/review/types.ts`
- `event-parser.ts`
- `trigger.ts`
- `api-client.ts`
- `idempotency.ts`
- `diff-builder.ts`
- `context-builder.ts`
- `comment-renderer.ts`
- `webhook.ts`
- `packages/platform-gitlab/test/*`

能力：

- 解析 GitLab note webhook。
- 识别 `@Nine1bot review`。
- 拉 MR metadata / diff / discussions。
- 幂等 key 绑定 MR `head_sha`。
- 拦截 diff overflow 和黑名单文件。
- 生成 context blocks。
- 渲染 summary comment。

### Phase 2：Nine1Bot Controller 接入

实现目录：

- `packages/nine1bot/src/review/controller.ts`
- `run-spec-compiler.ts`
- `run-store.ts`
- `event-router.ts`
- `packages/nine1bot/src/platform/*`
- `packages/nine1bot/src/config/*`

能力：

- 挂载 GitLab webhook route。
- 接入 settings / secrets。
- 创建 review run。
- 编译包含 `ReviewOrchestrationPolicy` 的 `AgentRunSpec`。
- 调用 Runtime。

### Phase 3：多 agents 工作流

实现目录：

- `packages/platform-gitlab/src/review/workflow.ts`
- `packages/platform-gitlab/src/review/output-schema.ts`
- `packages/platform-gitlab/src/review/finding-aggregator.ts`
- `packages/nine1bot/src/review/run-spec-compiler.ts`
- `packages/nine1bot/src/review/event-router.ts`
- `opencode/packages/opencode/src/agent`
- `opencode/packages/opencode/src/runtime`
- `opencode/packages/opencode/src/session`

能力：

- PM Coordinator 作为唯一默认 supervisor。
- PM 主代理在 Runtime 内根据 workflow skills 动态生成 `SubagentTaskSpec`。
- Runtime 提供通用 subagent task 执行能力。
- Runtime 只接收 JSON Schema 并返回 `Record<string, unknown>`，不依赖 review 业务类型。
- QA + Security 作为并行 subagent tasks，而不是 GitLab 插件硬编码 worker。
- 大型任务由 PM 主代理拆解 developer subagent tasks，并通过 `fileScope` 保证文件隔离。
- 子代理结果先经过代码侧 findings 聚合，再交给 PM 主代理做裁决。

### Phase 4：inline comments 和 recheck

实现目录：

- `packages/platform-gitlab/src/review/inline-position.ts`
- `packages/platform-gitlab/src/review/comment-renderer.ts`
- `packages/nine1bot/src/review/run-store.ts`

能力：

- finding 映射 diff line。
- 创建 inline discussion。
- 支持 `@Nine1bot recheck` 增量复审。

## 15. 验收标准

第一阶段完成时：

- 未包含 `@Nine1bot` 的 GitLab 评论不会触发。
- MR note 中 `@Nine1bot review` 可以生成唯一 review run。
- 同一 `head_sha + noteId` webhook 重放不会重复执行或重复评论。
- MR push 新 commit 后 `head_sha` 变化，自动审查必须能产生新的 review run。
- GitLab API token 缺失时返回可审计错误。
- GitLab diff overflow / 截断时必须 blocked 并回写提示，不允许空 diff 审查。
- lock 文件、构建产物、多媒体和生成文件不会进入 LLM diff 上下文。
- 能构造 MR metadata、diff manifest、discussion summary context blocks。
- 能生成 `entry.platform = 'gitlab'`、`entry.mode = 'mr-review'` 的 workflow input。
- 能声明 review workflow 所需 skills，并在 debug/audit 中展示 skill availability。
- 能把 Runtime 结果回写为 MR 顶层评论。
- 能用 `packages/platform-gitlab/scripts/review-dry-run.ts` 基于 fixture 跑通主要链路。
- GitLab 专属逻辑不进入 `opencode/`。
- `packages/platform-gitlab` 有单元测试覆盖 event parser、trigger、context builder、renderer。

多 agents 阶段完成时：

- PM Coordinator 能根据 MR 风险选择阶段路径并生成 `SubagentTaskSpec`。
- discovery / spec / implementation / verification / fix / closed 都有结构化 stage result。
- verification 能按风险并行 QA + Security subagent tasks，或仅 QA。
- 阶段规则来自 review skills，agents 只承接角色职责。
- Runtime audit 能显示每个 subagent task 的 prompt/promptRef、skills、contextRefs、allowedTools、输出 schema 和状态。
- subagent timeout 按 `failureMode` 执行：PM abort-run，QA/Security 可 ignore 或 fallback。
- Runtime 不依赖 `ReviewFinding` / `ReviewStageResult` TypeScript 类型，只按传入 JSON Schema 约束输出。
- inline comment 只对 diff hunk 内合法行创建；非法行号和 GitLab 400 必须降级到 summary。
- closed 阶段能回写最终 MR 评论。
- Runtime event / audit 能解释每个阶段使用的 agent、context、resources 和权限。

## 16. GitLab 开源版能力调查

基于 GitLab 官方文档，GitLab Free / Self-Managed 已经提供实现首版所需的大部分能力：

| 能力 | GitLab 支持情况 | 本项目用途 |
| --- | --- | --- |
| Project Webhooks | GitLab Webhooks 文档标注 Free / Premium / Ultimate 均支持，GitLab.com、Self-Managed、Dedicated 均可用 | 接收 MR、comment、push 等事件 |
| Comment events | Webhook events 文档说明 commit、merge request、issue、snippet 新增或编辑评论会触发 comment event，header 为 `X-Gitlab-Event: Note Hook` | `@Nine1bot` 评论触发 |
| Merge request events | Webhook events 文档说明 MR 创建、编辑、合并、关闭、源分支新增 commit 会触发 MR event | 自动审查或 recheck |
| Project Webhooks API | Free / Premium / Ultimate 支持，但需要管理员或项目 Maintainer / Owner | 后续可在 Web UI 中自动创建或检测 webhook |
| Merge Requests API | 可读取 MR 元信息、状态、diff refs、changes 等 | 构造 MR review context |
| Notes API | 支持列出、读取、创建、更新 MR notes；MR note 不绑定具体 diff 行 | 首版 summary comment 回写 |
| Discussions API | 支持 MR discussion、thread note、resolve/reopen；可创建 MR diff thread | 后续 inline review comments |
| Commits API | 支持 commit comment，提供 `path`、`line`、`line_type` 等参数 | Commit 评论触发和回写 |
| Project access token | scopes 包括 `read_api`、`read_repository`、`api` 等；`api` 是 scoped project API 的完整读写访问 | Bot 账号读 MR、写 note |
| GitLab CLI `glab` | `glab mr note` 可管理 MR comments/discussions | 本地调试可选，不作为服务端依赖 |
| System hooks | Free / Self-Managed 支持，但属于实例级 hook | 企业自托管可选，不作为首版依赖 |

首版推荐用户手动配置 project webhook：

- URL：Nine1Bot 暴露的 `/platforms/gitlab/webhook`。
- Secret token：填入 Web 配置页生成或保存的 webhook secret。
- Trigger：开启 `Comments` / `Note events`。
- 可选 Trigger：开启 `Merge request events` 用于自动审查。
- SSL verification：生产环境应开启。

首版推荐 token 方案：

- 优先：专用 GitLab bot 用户的 project access token。
- scope：如果只读可用 `read_api`；如果需要写 MR note / discussion，使用 `api`。
- role：项目内最小可用角色，通常至少需要能读取代码和创建评论。
- 不建议首版要求 `write_repository`，因为首版不 push 修复分支。
- token 存在 Nine1Bot secret store，不写入 `packages/platform-gitlab`。

官方参考：

- [GitLab Webhooks](https://docs.gitlab.com/user/project/integrations/webhooks/)
- [GitLab Webhook events](https://docs.gitlab.com/user/project/integrations/webhook_events/)
- [GitLab Project webhooks API](https://docs.gitlab.com/api/project_webhooks/)
- [GitLab Merge requests API](https://docs.gitlab.com/api/merge_requests/)
- [GitLab Notes API](https://docs.gitlab.com/api/notes/)
- [GitLab Discussions API](https://docs.gitlab.com/api/discussions/)
- [GitLab Commits API](https://docs.gitlab.com/api/commits/)
- [GitLab Project access tokens](https://docs.gitlab.com/user/project/settings/project_access_tokens/)
- [GitLab CLI `glab mr note`](https://docs.gitlab.com/cli/mr/note/)

## 17. 关键风险与约束

- 幂等 key 必须绑定 MR `head_sha`，否则 push 新 commit 后会被误判为已处理。
- GitLab diff overflow / 截断必须 blocked，不能让 agent 基于空 diff 输出幻觉审查。
- GitLab inline position 复杂，首版应先做 summary comment；开启 inline 后必须有 hunk validator 和 API 400 fallback。
- 8 个 agents 来自另一个项目，其中一些规则带有强 spec coding 假设；首版应将这些方法论移入 GitLab package skills，主代理通过创建自定义子代理来消费，不应阻塞所有小 MR。
- 自动 webhook review 容易产生噪音，首版默认手动 `@Nine1bot`。
- 大 MR diff 需要裁剪，否则会拖慢 Runtime 并污染上下文。
- QA/Security 等并行子代理结果必须先做代码侧 groupBy 聚合，再交给 PM 裁决。
- Runtime 不能依赖 GitLab review 业务类型；业务层通过 JSON Schema/Zod 约束和校验输出。
- 所有 subagent task 必须定义 `failureMode`，否则 timeout 后流程不可预期。
- Phase 0/1 必须提供 dry-run harness，否则 prompt 和 workflow 调试会严重依赖真实 GitLab MR，迭代成本过高。
- GitLab token 权限必须最小化，评论写权限要可配置、可审计。
- 多 agents 并行实现必须保持文件隔离，否则自动实现阶段容易产生冲突。
