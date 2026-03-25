# Dashboard API 缺口拆分 Issues（GitHub 中文粘贴版）

本文档整理了适合直接复制到 GitHub Issue 中的中文 issue 内容。

---

# 1. Sessions REST API 兼容层

## 标题
补齐 Dashboard 的 Sessions REST API，并统一前后端会话接口

## 正文
### 背景
当前 Dashboard 的 session 相关接口存在新旧混用问题：

- 会话列表主要走旧接口：`/api/data`
- 单个会话的创建、更新、归档等逻辑，前端已经切换到 REST 风格接口：`/api/sessions*`

前端已经实现了以下调用，但后端未完整支持：

- `GET /api/sessions`
- `GET /api/sessions/:id`
- `POST /api/sessions`
- `PATCH /api/sessions/:id`
- `POST /api/sessions/:id/archive`

这导致会话相关功能处于“部分可显示、部分不可操作”的状态。

### 目标
为 Dashboard 提供一套完整、稳定、可兼容现有页面的 Sessions REST API。

### 涉及范围
**前端**
- `ccw/frontend/src/lib/api.ts`
- `fetchSession()`
- `createSession()`
- `updateSession()`
- `archiveSession()`

**后端**
- `ccw/src/core/routes/session-routes.ts`
- 现有相关接口：
  - `/api/data`
  - `/api/session-detail`
  - `/api/update-task-status`

### 需要完成
- [ ] 增加 `GET /api/sessions`
- [ ] 增加 `GET /api/sessions/:id`
- [ ] 增加 `POST /api/sessions`
- [ ] 增加 `PATCH /api/sessions/:id`
- [ ] 增加 `POST /api/sessions/:id/archive`
- [ ] 尽量复用现有 session 数据源，而不是直接重构底层存储
- [ ] 保持旧接口 `/api/data` 在兼容期内继续可用

### 验收标准
- [ ] 前端 `fetchSession()` 可以正常获取单个会话
- [ ] 前端 `createSession()` 可以正常创建会话
- [ ] 前端 `updateSession()` 可以更新标题、描述、状态等字段
- [ ] 前端 `archiveSession()` 可以归档会话
- [ ] 返回结构与前端 `SessionMetadata` 兼容
- [ ] 现有依赖 `/api/data` 的页面不被破坏

### 优先级
P0

---

# 2. Hooks 管理接口契约对齐

## 标题
对齐 Hooks 管理接口契约，兼容前端 create/update 调用方式

## 正文
### 背景
前端当前使用的 hooks 管理接口为：

- `POST /api/hooks/create`
- `PATCH /api/hooks/:hookName`

而后端现有主要接口风格为：

- `GET /api/hooks`
- `POST /api/hooks`
- `DELETE /api/hooks`

这导致 hooks 新建、编辑能力在前后端之间存在明显契约不一致。

### 目标
让前端现有 Hooks 管理页面无需重写即可正常工作。

### 涉及范围
**前端**
- `ccw/frontend/src/lib/api.ts`
- `createHook()`
- `updateHook()`

**后端**
- `ccw/src/core/routes/hooks-routes.ts`

### 需要完成
- [ ] 增加 `POST /api/hooks/create`
- [ ] 增加 `PATCH /api/hooks/:hookName`
- [ ] 保持旧接口 `/api/hooks` 继续可用
- [ ] 统一成功/失败返回格式

### 验收标准
- [ ] 前端 `createHook()` 可正常创建 hook
- [ ] 前端 `updateHook()` 可正常更新 hook
- [ ] hooks 列表与删除能力不受影响
- [ ] 所有错误返回为标准 JSON

### 优先级
P0

---

# 3. CLI 安装管理接口

## 标题
补齐 Dashboard 的 CLI 安装管理接口

## 正文
### 背景
前端已经实现了 CLI 工具安装管理能力，但后端未提供配套接口，导致页面存在按钮可见但不可用的问题。

前端已调用的接口包括：

- `GET /api/cli/installations`
- `POST /api/cli/installations/:tool/install`
- `POST /api/cli/installations/:tool/uninstall`
- `POST /api/cli/installations/:tool/upgrade`
- `POST /api/cli/installations/:tool/check`

### 目标
让 Dashboard 中的 CLI 工具安装、卸载、升级、状态检查功能可用。

### 涉及范围
**前端**
- `ccw/frontend/src/lib/api.ts`
- `fetchCliInstallations()`
- `installCliTool()`
- `uninstallCliTool()`
- `upgradeCliTool()`

**后端**
- `ccw/src/core/routes/cli-routes.ts`
- 或新增独立 route 文件

### 需要完成
- [ ] 增加 `GET /api/cli/installations`
- [ ] 增加 `POST /api/cli/installations/:tool/install`
- [ ] 增加 `POST /api/cli/installations/:tool/uninstall`
- [ ] 增加 `POST /api/cli/installations/:tool/upgrade`
- [ ] 增加 `POST /api/cli/installations/:tool/check`
- [ ] 尽量复用现有 CLI 检测/执行逻辑

### 验收标准
- [ ] Dashboard 可展示支持的 CLI 工具安装状态
- [ ] 安装、卸载、升级操作可从前端触发
- [ ] check 操作可刷新状态
- [ ] 返回结构与前端 `CliInstallation` 定义兼容

### 优先级
P0

---

# 4. Prompt History 分析接口

## 标题
补齐 Prompt History 的 `/api/memory/analyze` 分析接口

## 正文
### 背景
前端 Prompt History 页面已经接入“分析 prompts”能力，但后端未实现：

- `POST /api/memory/analyze`

这导致相关分析按钮点击后报错。

### 目标
让 Prompt History 页面中的分析能力可用。

### 涉及范围
**前端**
- `ccw/frontend/src/lib/api.ts`
- `analyzePrompts()`
- `ccw/frontend/src/hooks/usePromptHistory.ts`
- `ccw/frontend/src/pages/PromptHistoryPage.tsx`

**后端**
- `ccw/src/core/routes/memory-routes.ts`

### 需要完成
- [ ] 增加 `POST /api/memory/analyze`
- [ ] 支持前端传入 `AnalyzePromptsRequest`
- [ ] 返回与 `PromptInsightsResponse` 兼容的数据结构
- [ ] 第一版可先做简化分析实现

### 验收标准
- [ ] 前端 Analyze 操作不再报错
- [ ] 返回结果可正常显示在 Prompt History 页面
- [ ] 支持可选 tool 参数
- [ ] 错误返回结构符合前端 `fetchApi` 约定

### 优先级
P0

---

# 5. Commands 分组配置接口

## 标题
补齐 Commands 管理页的分组配置接口

## 正文
### 背景
前端 Commands 管理页已依赖以下接口：

- `GET /api/commands/groups/config`

但后端当前只具备 list / toggle 等基础能力，缺少分组配置读取接口。

### 目标
让 Commands 管理页能够正确加载分组配置与命令分组映射。

### 涉及范围
**前端**
- `ccw/frontend/src/lib/api.ts`
- `getCommandsGroupsConfig()`

**后端**
- `ccw/src/core/routes/commands-routes.ts`

### 需要完成
- [ ] 增加 `GET /api/commands/groups/config`
- [ ] 支持 `location` 参数
- [ ] 支持可选 `path` 参数
- [ ] 返回 `groups` 与 `assignments`

### 验收标准
- [ ] Commands 管理页能加载分组配置
- [ ] 返回结构与前端预期一致
- [ ] 现有 `/api/commands` 相关功能不受影响

### 优先级
P1

---

# 6. Commands 导入校验接口

## 标题
补齐 Commands 导入流程的校验接口 `/api/commands/validate-import`

## 正文
### 背景
前端在导入命令前会调用：

- `POST /api/commands/validate-import`

但后端尚未提供该能力。

### 目标
支持导入命令前的合法性校验，避免用户导入失败或导入后才发现格式问题。

### 涉及范围
**前端**
- `ccw/frontend/src/lib/api.ts`
- `validateCommandImport()`
- `CommandCreateDialog`

**后端**
- `ccw/src/core/routes/commands-routes.ts`

### 需要完成
- [ ] 增加 `POST /api/commands/validate-import`
- [ ] 校验 sourcePath 是否存在
- [ ] 校验文件格式与 frontmatter
- [ ] 返回结构化校验结果

### 验收标准
- [ ] 前端可在导入前拿到校验结果
- [ ] 校验失败时能提供明确错误信息
- [ ] 该接口只做校验，不修改文件

### 优先级
P1

---

# 7. Coordinator Pipeline 兼容接口

## 标题
增加 `/api/coordinator/pipeline/:execId` 兼容接口，桥接 Orchestrator 执行数据

## 正文
### 背景
前端仍然调用：

- `GET /api/coordinator/pipeline/:execId`

但后端当前对应能力在：

- `/api/orchestrator/executions/:execId`
- `/api/orchestrator/executions/:execId/logs`

这说明前端仍依赖旧的 coordinator 概念。

### 目标
在不引入第二套执行状态存储的前提下，为前端补一个兼容入口。

### 涉及范围
**前端**
- `ccw/frontend/src/lib/api.ts`
- `fetchCoordinatorPipeline()`

**后端**
- `ccw/src/core/routes/orchestrator-routes.ts`

### 需要完成
- [ ] 增加 `GET /api/coordinator/pipeline/:execId`
- [ ] 基于 orchestrator execution 数据进行映射
- [ ] 保持实现为兼容层而不是新增第二套执行系统

### 验收标准
- [ ] `fetchCoordinatorPipeline()` 正常返回数据
- [ ] Pipeline 详情页不再因接口缺失报错
- [ ] 返回结构兼容前端 `CoordinatorPipelineDetails`

### 优先级
P1

---

# 8. Core Memory selective extract

## 标题
补齐 Core Memory 的 selective extract 接口

## 正文
### 背景
前端已经预留 selective extract 能力，并调用：

- `POST /api/core-memory/extract/selective`

但后端当前只有：

- `/api/core-memory/extract`
- `/api/core-memory/extract/preview`
- `/api/core-memory/extract/status`

缺少定向抽取接口。

### 目标
支持按指定条件进行 memory extract，而不是只能做全量或默认抽取。

### 涉及范围
**前端**
- `ccw/frontend/src/lib/api.ts`

**后端**
- `ccw/src/core/routes/core-memory-routes.ts`

### 需要完成
- [ ] 增加 `POST /api/core-memory/extract/selective`
- [ ] 支持前端传入筛选或选择条件
- [ ] 与现有 extract/status 返回风格保持一致

### 验收标准
- [ ] 前端 selective extract 调用不再 404
- [ ] 接口能处理选择性抽取请求
- [ ] 返回结果符合前端预期

### 优先级
P1

---

# 9. Graph Explorer 依赖图接口

## 标题
补齐 Graph Explorer 使用的 `/api/graph/dependencies` 接口

## 正文
### 背景
前端 Graph Explorer 页面会请求：

- `GET /api/graph/dependencies`

但当前后端未实现该 endpoint。

### 目标
让 Graph Explorer 页面可以获取依赖图数据。

### 涉及范围
**前端**
- `ccw/frontend/src/lib/api.ts`
- `fetchGraphDependencies()`
- `ccw/frontend/src/hooks/useGraphData.ts`

**后端**
- `ccw/src/core/routes/graph-routes.ts`

### 需要完成
- [ ] 增加 `GET /api/graph/dependencies`
- [ ] 支持 `rootPath`
- [ ] 支持 `maxDepth`
- [ ] 支持 `includeTypes`
- [ ] 支持 `excludePatterns`
- [ ] 返回与 `GraphDependenciesResponse` 兼容的数据结构

### 验收标准
- [ ] Graph Explorer 页能正常加载依赖图
- [ ] 查询失败时返回结构化 JSON 错误
- [ ] 后端尽量复用现有 CodexLens / 图谱逻辑

### 优先级
P1

---

# 10. Sessions 接口迁移策略文档

## 标题
制定 Sessions 接口迁移策略，收口 `/api/data` 与 `/api/sessions*` 双轨问题

## 正文
### 背景
当前 session 相关接口同时存在：

- 旧式聚合接口：`/api/data`
- 新式 REST 接口：`/api/sessions*`

这会持续导致前后端接口漂移，也会让后续开发继续踩坑。

### 目标
明确 sessions 的主接口，并为兼容期制定策略。

### 需要完成
- [ ] 盘点所有前端 session 读写入口
- [ ] 确定 `/api/sessions*` 为主接口
- [ ] 明确 `/api/data` 的兼容范围和过渡期
- [ ] 形成迁移说明文档
- [ ] 约束新功能不再扩展 `/api/data` 的 session 职责

### 验收标准
- [ ] 有一份明确的迁移设计说明
- [ ] 新增 session 功能默认走 `/api/sessions*`
- [ ] 前端和后端对兼容范围达成一致

### 优先级
P1

### 依赖
- 建议在 Sessions REST API 兼容层完成后推进

---

# 11. Dashboard 占位功能清理

## 标题
清理 Dashboard 中的占位功能，并明确未完成功能状态

## 正文
### 背景
当前前端存在多处“Coming Soon”或部分实现的功能，例如：

- Conflict Resolution
- Code Review detail
- Issues task list
- Skill Hub details

这些功能不一定是后端缺失，但会让用户误以为已经可用。

### 目标
明确区分“已实现 / 未实现 / 规划中”，避免误导用户。

### 需要完成
- [ ] 审计当前所有占位功能入口
- [ ] 为未完成功能增加禁用态或 badge
- [ ] 给占位功能关联 roadmap 或 issue
- [ ] 避免让用户进入死路交互

### 验收标准
- [ ] 所有未完成功能在 UI 上有清晰状态
- [ ] 不再出现“可点但不可用”的误导体验
- [ ] 每个占位功能至少有 backlog / issue 对应

### 优先级
P2

---

# 建议创建顺序

建议按以下顺序在 GitHub 中创建 issue：

1. Sessions REST API 兼容层
2. Hooks 管理接口契约对齐
3. CLI 安装管理接口
4. Prompt History 分析接口
5. Commands 分组配置接口
6. Commands 导入校验接口
7. Coordinator Pipeline 兼容接口
8. Core Memory selective extract
9. Graph Explorer 依赖图接口
10. Sessions 接口迁移策略文档
11. Dashboard 占位功能清理
