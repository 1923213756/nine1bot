# GitLab Review 工程总结

## 背景与目标

GitLab Review 工程的目标，是让 Nine1Bot 能够以插件化方式接入 GitLab 研发流程，在 Merge Request 或 Commit 评论中通过 `@Nine1bot` 触发代码审查，并把审查结果回写到 GitLab 页面中。该能力面向实验室自建 GitLab 和 CI/CD 场景，先完成 MR 级别的代码审查闭环，再逐步扩展到 CI 日志分析、质量扫描结果分析和自动修复。

本工程的核心原则是低耦合：GitLab 相关的事件解析、Diff 获取、审查配置、评论发布、Skills 与子代理提示词都放在 `@nine1bot/platform-gitlab` 包中；Nine1Bot / OpenCode 侧只提供通用的平台适配、Webhook 入口、Controller Session、Runtime 执行和模型调用能力。

## 当前核心产出

### 1. GitLab 平台适配包

`packages/platform-gitlab` 已经从基础页面上下文适配，扩展为完整的 GitLab Review 平台包，主要包含：

- GitLab URL 解析、页面上下文识别和浏览器插件上下文注入。
- GitLab 平台运行状态、配置页、项目搜索、Group 搜索和平台 Action。
- GitLab Review 专用配置，包括 GitLab base URL、API token、模型选择、Inline comments、Review scope、Project / Group Hook 管理等。
- 平台级 Runtime Sources，向主 Runtime 注册 GitLab review agents 和 skills，但不把业务逻辑写入 Runtime 底座。

### 2. 专用 GitLab Webhook 链路

当前实现使用 GitLab 专用 webhook 入口：

```text
GitLab Project/Group/System Hook
  -> /webhooks/gitlab/{secret}
  -> GitLab event parser
  -> Review trigger
  -> Runtime review run
  -> GitLab comment publisher
```

该链路支持：

- MR note / commit note 中 `@Nine1bot` 触发审查。
- MR webhook 自动触发审查。
- 忽略 Bot 自己发出的评论，避免自触发循环。
- 对不相关 mention、询问 token 等越界请求进行拒绝，并可回写简短说明。
- URL secret 自动生成，GitLab 侧 `Secret token` 可以留空。
- 本机 IP 变化时自动刷新专用 webhook URL，降低 VPN 地址变化导致的联调失败概率。

### 3. MR Diff 获取与安全防护

Review 前置阶段已经补齐关键防线：

- 幂等 key 绑定 MR `head_sha`，避免同一个 MR 更新代码后被误判为已处理。
- Diff builder 过滤 lock 文件、构建产物、minified 文件和多媒体资源。
- 非黑名单源码文件出现空 diff 时阻断审查，避免在证据缺失情况下让模型生成不可靠意见。
- 检测 GitLab diff overflow / truncation，并直接以 blocked 状态终止。
- Inline position 在发布前校验 Diff Hunk，避免模型行号幻觉导致 GitLab API 400 后中断整次 Review。

### 4. 多 Agent 与 Skills 组织

GitLab Review 工程已经把角色提示词和流程知识迁移到平台包下：

- `agents/review/*`：PM Coordinator、Tech Architect、Frontend Designer、QA、Security、Spec Writer、Developer 等审查角色。
- `skills/review/*`：MR review workflow、commit review workflow、finding schema、risk routing、verification matrix、security policy、comment rendering 等流程技能。

实际运行时由主 Runtime 创建子代理或按 workflow 编排审查任务。平台包只提供 GitLab 场景的角色与技能资源，不要求 Runtime 直接理解 GitLab 业务概念。

### 5. 审查结果结构化与发布

模型输出通过 `GITLAB_REVIEW_RESULT` 契约解析为结构化 finding，再进入确定性处理链路：

- 按文件和行号对 QA / Security 等来源的 finding 做 groupBy 聚合。
- PM 负责风险裁决和措辞，而不是让模型承担数组合并、去重等确定性工作。
- Summary note 首先发布，作为整次审查的顶层结果。
- 可定位 finding 尝试发布为 GitLab inline diff thread。
- Inline 发布失败时降级为普通 summary note，不让单条评论失败破坏整次审查。
- 顶层 Summary 不再渲染 diff evidence 代码块，避免和 GitLab DiffNote 视觉形态混淆。
- 支持在 inline discussion 中输出 GitLab suggestion 格式，用于接近 Copilot 的代码建议体验。

### 6. 配置页与本地联调能力

GitLab 平台配置页已经从“工程配置面板”收敛为更适合 Demo 和实际使用的 MVP 配置：

- 基础区聚焦 GitLab base URL、API token、专用 webhook URL、模型、`@Nine1bot` 触发、Inline comments。
- 高级区承载自动 Review、项目范围、Group Hook、排除项目等扩展配置。
- 支持搜索 GitLab Project / Group，避免用户手动填写项目 ID。
- 支持同步 Project Hook / Group Hook 到当前 webhook URL。
- 支持测试 GitLab API token 与 webhook 可达性。
- 支持本地 dry-run harness，用 fixture 跑通 webhook、diff、runtime output、subagent output 等关键链路。

## 当前工程边界

当前 GitLab Review 的业务代码主要分布如下：

- `packages/platform-gitlab/src/review/*`：GitLab review 领域逻辑，包括 API client、diff builder、event parser、inline position、publisher、schema、workflow 等。
- `packages/platform-gitlab/src/runtime.ts`：平台配置、状态、Action、Hook 同步和 Runtime Sources。
- `packages/nine1bot/src/review/gitlab-controller.ts`：平台到通用 Controller / Runtime 的中间层，负责触发 Review Run、构造 Runtime Prompt、收口运行结果。
- `opencode/packages/opencode/src/server/routes/webhooks.ts`：通用 Webhook 路由与 GitLab 专用入口。
- `web/src/components/PlatformManager.vue`：多平台配置界面中的 GitLab 配置与运行状态展示。

整体依赖方向保持为：平台包提供能力，Nine1Bot 产品层注册平台，Runtime 只感知通用平台资源和通用执行协议。

## 已验证能力

本阶段覆盖的测试与联调包括：

- GitLab platform package 单元测试。
- GitLab review foundation 单元测试。
- TypeScript typecheck。
- 本地自建 GitLab 联调。
- Project Hook / Comment Hook / MR Hook 触发。
- `@Nine1bot review` 触发 Review Run。
- Summary note 和 inline diff thread 回写。
- Webhook URL IP 变化后的同步与可达性测试。

常用验证命令：

```bash
bun test packages/platform-gitlab/test/gitlab-platform.test.ts packages/platform-gitlab/test/gitlab-review.test.ts
bun run --cwd packages/platform-gitlab typecheck
```

## 已知限制

当前版本已经具备可演示和可继续迭代的 MVP 能力，但仍有一些限制：

- Review Runs 面板仍可能被大量 ignored / rejected events 噪声淹没，后续需要服务端过滤或分离运行记录。
- Inline comment 依赖模型输出准确 file + line，虽然已有 Hunk 校验与 fallback，但高质量定位仍需要继续优化 prompt 和 schema。
- 目前主要面向 MR diff 审查，尚未接入 Jenkins、SonarQube、Harbor 等 CI/CD 结果。
- 自动修复链路还停留在建议阶段，尚未形成可控的 patch 生成、分支提交和 MR 更新闭环。
- 本地网络联调仍依赖 GitLab 服务器能访问 Nine1Bot 地址，生产环境建议部署到 GitLab 可达的固定服务地址或内网域名。

## 未来扩展计划

### 1. CI/CD 结果接入

后续希望接入 Jenkins Pipeline 日志、GitLab Pipeline 状态、SonarQube 代码质量结果和 Harbor 镜像信息，让 Review 不只分析 diff，还能结合构建失败、测试失败、质量门禁和镜像发布状态进行综合判断。

### 2. 自动修复闭环

在 Review 稳定后，可以扩展为：

- 根据 finding 生成最小补丁。
- 在隔离工作区运行测试。
- 自动提交到修复分支。
- 回写修复说明或创建新的 MR。

该方向需要继续强化权限控制、文件隔离、测试选择和失败回滚。

### 3. 更强的 Copilot-like 体验

继续优化 inline comment 质量，包括：

- 更稳定的行号定位。
- 更好的 suggestion 粒度。
- Summary 与 DiffNote 的信息分层。
- 对重复 finding 的聚合和去重。
- 更适合 GitLab UI 的 Markdown 渲染。

### 4. Review Scope 与运行记录优化

目前已经从手动填写 project id 过渡到 Project / Group 搜索和选择，后续可以继续完善：

- System Hook / Group Hook / Project Hook 的统一接入视图。
- 默认取并集、排除项目黑名单的管理体验。
- Review Runs 与 Ignored Events 分离展示。
- 按项目、MR、状态、时间筛选运行记录。

### 5. 安全与运维增强

后续需要补强：

- Token 权限检查与最小权限建议。
- Webhook 来源校验策略。
- 审查频率限制和队列化。
- 多 GitLab 实例配置。
- 部署环境下固定回调域名、HTTPS 和访问控制。

## PR 准备说明

本 PR 应包含 GitLab Review 的平台包、Runtime 集成、Webhook 链路、配置页、测试和必要设计说明。`packages/platform-gitlab/docs/review-implementation` 下的阶段施工文档只作为本地开发过程记录，不应进入 PR。
