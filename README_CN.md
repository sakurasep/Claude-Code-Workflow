<div align="center">

<!-- Animated Header -->
<img src="https://capsule-render.vercel.app/api?type=waving&color=gradient&customColorList=6,11,20&height=180&section=header&text=Claude%20Code%20Workflow&fontSize=42&fontColor=fff&animation=twinkling&fontAlignY=32&desc=多智能体%20AI%20开发框架&descAlignY=52&descSize=18"/>

<!-- Badges -->
<p>
  <a href="https://github.com/catlog22/Claude-Code-Workflow/releases"><img src="https://img.shields.io/badge/version-v7.0.0-6366F1?style=flat-square" alt="Version"/></a>
  <a href="https://www.npmjs.com/package/claude-code-workflow"><img src="https://img.shields.io/npm/v/claude-code-workflow?style=flat-square&color=cb3837" alt="npm"/></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-10B981?style=flat-square" alt="License"/></a>
  <a href="https://github.com/catlog22/Claude-Code-Workflow/stargazers"><img src="https://img.shields.io/github/stars/catlog22/Claude-Code-Workflow?style=flat-square&color=F59E0B" alt="Stars"/></a>
  <a href="https://github.com/catlog22/Claude-Code-Workflow/issues"><img src="https://img.shields.io/github/issues/catlog22/Claude-Code-Workflow?style=flat-square&color=EF4444" alt="Issues"/></a>
</p>

**[English](README.md) | [中文](README_CN.md)**

<br/>

<!-- Typing Animation -->
<a href="https://git.io/typing-svg"><img src="https://readme-typing-svg.demolab.com?font=Fira+Code&weight=600&size=22&pause=1000&color=6366F1&center=true&vCenter=true&random=false&width=600&lines=JSON+驱动的多智能体框架;Skill+工作流系统;语义化+CLI+编排;Gemini+%7C+Codex+%7C+OpenCode+%7C+Qwen+%7C+Claude" alt="Typing SVG" /></a>

</div>

<br/>

<!-- Quick Links -->
<div align="center">
  <a href="#-快速开始"><img src="https://img.shields.io/badge/🚀_快速开始-4285F4?style=flat-square" alt="Quick Start"/></a>
  <a href="WORKFLOW_GUIDE_CN.md"><img src="https://img.shields.io/badge/📖_工作流指南-34A853?style=flat-square" alt="Guide"/></a>
  <a href="#-cli-工具安装"><img src="https://img.shields.io/badge/🛠️_CLI_工具-EA4335?style=flat-square" alt="CLI Tools"/></a>
  <a href="#-架构概览"><img src="https://img.shields.io/badge/🏗️_架构-FBBC05?style=flat-square" alt="Architecture"/></a>
</div>

<br/>

---

## ✨ 核心特性

<div align="center">
<table>
<tr>
<td width="50%">

### 🎯 Skill 工作流
从 `lite-plan`（轻量规划）到 `brainstorm`（多角色分析）

### 🔄 多 CLI 编排
Gemini、Qwen、Codex、Claude - 自动选择或手动指定

### ⚡ Team 架构 v2
基于角色的智能体，支持内循环执行

### 🔧 队列调度器
后台队列执行服务

</td>
<td width="50%">

### 📦 会话生命周期
启动/恢复/完成/同步工作流会话

### 🖥️ 终端仪表板
多终端网格带执行监控器

### 🎨 编排器编辑器
基于模板的可视化工作流编辑

### 💬 A2UI
智能体到用户的交互界面

</td>
</tr>
</table>
</div>

> 📖 **新用户？** 查看 [工作流指南](WORKFLOW_GUIDE_CN.md) 了解完整的工作流文档。

---

## 🚀 快速开始

### 安装 CCW

```bash
npm install -g claude-code-workflow
ccw install -m Global
```

### Codex 配置（`.codex/skills/` 所需）

如果你使用 **Codex CLI** 配合 `.codex/skills/` 工作流技能，需要在 `~/.codex/config.toml` 中添加以下必要配置：

```toml
[features]
default_mode_request_user_input = true   # 启用 request_user_input 工具，用于交互式确认
multi_agent = true                       # 启用多智能体协调（spawn_agent、wait 等）
multi_agent_v2 = true                    # 启用 v4 智能体 API（fork_context、task_name、send_message、assign_task、list_agents）
enable_fanout = true                     # 启用 spawn_agents_on_csv 并行波次执行
```

> 这些功能是工作流技能正常运行的必要条件。缺少它们，交互式确认门控（`request_user_input`）、子智能体编排和 CSV 驱动的并行执行将无法工作。

### 工作流 Skill 与命令

CCW 使用两种调用方式：

| 类型 | 格式 | 示例 |
|------|------|------|
| **Skills** | 触发短语（无斜杠） | `workflow-lite-plan`, `brainstorm`, `workflow-plan` |
| **Commands** | 斜杠命令 | `/ccw`, `/workflow/session:start`, `/issue/new` |

### 选择工作流 Skill

<div align="center">
<table>
<tr><th>Skill 触发词</th><th>使用场景</th></tr>
<tr><td><code>workflow-lite-plan</code></td><td>轻量规划、单模块功能（Skill 交接给 lite-execute）</td></tr>
<tr><td><code>workflow-multi-cli-plan</code></td><td>多 CLI 协同分析</td></tr>
<tr><td><code>workflow-plan</code></td><td>完整规划与会话持久化</td></tr>
<tr><td><code>workflow-tdd-plan</code></td><td>测试驱动开发</td></tr>
<tr><td><code>workflow-test-fix</code></td><td>测试生成与修复循环</td></tr>
<tr><td><code>brainstorm</code></td><td>多角色头脑风暴分析</td></tr>
</table>
</div>

### 工作流示例

```bash
# Skill 触发（无斜杠 - 直接描述你想做什么）
workflow-lite-plan "添加 JWT 认证"
workflow-plan "实现支付网关集成"
workflow-execute

# 头脑风暴
brainstorm "设计实时协作系统"

# 会话管理命令
/workflow:session:start
/workflow:session:resume
/workflow:session:complete
```

---

## 🛠️ CLI 工具安装

<div align="center">
<table>
<tr><th>CLI</th><th>说明</th><th>官方文档</th></tr>
<tr><td><b>Gemini</b></td><td>Google AI 分析</td><td><a href="https://github.com/google-gemini/gemini-cli">google-gemini/gemini-cli</a></td></tr>
<tr><td><b>Codex</b></td><td>OpenAI 自主编码</td><td><a href="https://github.com/openai/codex">openai/codex</a></td></tr>
<tr><td><b>OpenCode</b></td><td>开源多模型</td><td><a href="https://github.com/opencode-ai/opencode">opencode-ai/opencode</a></td></tr>
<tr><td><b>Qwen</b></td><td>阿里云 Qwen-Code</td><td><a href="https://github.com/QwenLM">QwenLM/Qwen</a></td></tr>
</table>
</div>

---

## 🎭 语义化 CLI 调用

<div align="center">
<img src="https://img.shields.io/badge/只需描述-你想要什么-6366F1?style=flat-square"/>
<img src="https://img.shields.io/badge/CCW_处理-剩下的一切-10B981?style=flat-square"/>
</div>

<br/>

用户可以在提示词中 **语义指定 CLI 工具** - 系统自动调用对应的 CLI。

### 基础调用

<div align="center">

| 用户提示词 | 系统动作 |
|------------|----------|
| "使用 Gemini 分析 auth 模块" | 自动调用 `gemini` CLI 进行分析 |
| "让 Codex 审查这段代码" | 自动调用 `codex` CLI 进行审查 |
| "问问 Qwen 性能优化建议" | 自动调用 `qwen` CLI 进行咨询 |

</div>

### 多 CLI 编排

<div align="center">

| 模式 | 用户提示词示例 |
|------|----------------|
| **协同分析** | "使用 Gemini 和 Codex 协同分析安全漏洞" |
| **并行执行** | "让 Gemini、Codex、Qwen 并行分析架构设计" |
| **迭代优化** | "用 Gemini 诊断问题，然后 Codex 修复，迭代直到解决" |
| **流水线** | "Gemini 设计方案，Codex 实现，Claude 审查" |

</div>

---

## 🔍 ACE Tool 配置

ACE (Augment Context Engine) 提供强大的语义代码搜索能力。

<div align="center">

| 方式 | 链接 |
|------|------|
| **官方** | [Augment MCP 文档](https://docs.augmentcode.com/context-services/mcp/overview) |
| **代理** | [ace-tool (GitHub)](https://github.com/eastxiaodong/ace-tool) |

</div>

---

## 📚 CodexLens 本地搜索

> ⚠️ **开发中**: CodexLens 正在迭代优化中，部分功能可能不稳定。

<div align="center">
<table>
<tr><th>搜索模式</th><th>说明</th></tr>
<tr><td><b>FTS</b></td><td>全文搜索，基于 SQLite FTS5</td></tr>
<tr><td><b>Semantic</b></td><td>语义搜索，基于本地嵌入模型</td></tr>
<tr><td><b>Hybrid</b></td><td>混合搜索，结合 FTS + 语义 + 重排序</td></tr>
</table>
</div>

---

## 💻 CCW CLI 命令

### 🌟 推荐命令

<div align="center">
<table>
<tr><th>命令</th><th>说明</th><th>适用场景</th></tr>
<tr>
  <td><b>/ccw</b></td>
  <td>自动工作流编排器 - 分析意图、选择工作流、执行</td>
  <td>✅ 通用任务、自动选择工作流</td>
</tr>
<tr>
  <td><b>/ccw-coordinator</b></td>
  <td>智能编排器 - 推荐命令链、支持手动调整</td>
  <td>🔧 复杂多步骤工作流</td>
</tr>
</table>
</div>

**快速示例**：

```bash
# /ccw - 自动工作流选择
/ccw "添加用户认证"
/ccw "修复 WebSocket 中的内存泄漏"
/ccw "使用 TDD 方式实现"

# /ccw-coordinator - 手动链编排
/ccw-coordinator "实现 OAuth2 系统"
```

### 会话管理命令

```bash
/workflow:session:start     # 启动新工作流会话
/workflow:session:resume    # 恢复暂停的会话
/workflow:session:list      # 列出所有会话
/workflow:session:sync      # 同步会话工作
/workflow:session:complete  # 完成会话
```

### Issue 工作流命令

```bash
/issue/new       # 创建新 issue
/issue/plan      # 规划 issue 解决方案
/issue/queue     # 形成执行队列
/issue/execute   # 执行 issue 队列
```

### 其他 CLI 命令

```bash
ccw install           # 安装工作流文件
ccw view              # 打开 Dashboard
ccw cli -p "..."      # 执行 CLI 工具 (Gemini/Qwen/Codex)
ccw upgrade -a        # 升级所有安装
```

---

## 🏗️ 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                     工作流 Skills                                │
│  📝 workflow-lite-plan / workflow-multi-cli-plan (轻量级)       │
│  📊 workflow-plan / workflow-tdd-plan (会话式)                  │
│  🧪 workflow-test-fix / workflow-test-fix         │
│  🧠 brainstorm (多角色分析)                                      │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                     Team 架构 v2                                 │
│  🤖 基于 role-spec 的 team-worker 智能体执行                     │
│  🔄 内循环框架用于顺序任务处理                                   │
│  📢 消息总线协议与团队协调                                       │
│  🧠 智慧积累 (learnings/decisions/conventions)                   │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                     队列调度服务                                  │
│  ⚙️ 后台执行服务与 API 端点                                      │
│  📊 队列管理与统一的 CLI 执行设置                                │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                     终端仪表板与编排器                            │
│  🖥️ 多终端网格与执行监控器                                       │
│  🎨 基于模板的工作流编辑器与斜杠命令                             │
│  📡 通过 A2UI 实现实时智能体通信                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📦 项目结构

```
Claude-Code-Workflow/
├── .claude/
│   ├── agents/          # 22 个专业化智能体 (team-worker, cli-discuss 等)
│   ├── commands/        # 斜杠命令（5 个类别）
│   │   ├── ccw.md       # 主编排器
│   │   ├── ccw-coordinator.md
│   │   ├── cli/         # CLI 命令 (cli-init, codex-review)
│   │   ├── issue/       # Issue 管理 (plan, execute, queue)
│   │   ├── memory/      # 内存命令 (prepare, style-skill-memory)
│   │   └── workflow/    # 工作流命令 (session, ui-design 等)
│   └── skills/          # 37 个模块化技能
│       ├── workflow-lite-plan/
│       ├── workflow-plan/
│       ├── workflow-tdd-plan/
│       ├── workflow-test-fix/
│       ├── brainstorm/
│       ├── team-*/      # 团队协调技能
│       └── ...
├── ccw/
│   ├── src/             # TypeScript 源码
│   │   ├── commands/    # CLI 命令实现
│   │   ├── core/        # 核心服务 (a2ui, auth, hooks, routes)
│   │   ├── mcp-server/  # MCP 服务器实现
│   │   └── tools/       # 工具实现
│   └── frontend/        # React 前端（终端仪表板、编排器）
├── codex-lens/          # 本地语义代码搜索引擎
└── docs/                # 文档
```

---

## 🎼 团队节拍控制 (Beat Model)

v2 团队架构引入了**事件驱动的节拍模型**，实现高效编排：

```
节拍循环 (单个节拍)
======================================================================
  事件                    协调器                    工作者
----------------------------------------------------------------------
  回调/恢复 --> +- 处理回调 ------+
                |  标记已完成      |
                |  检查流水线      |
                +- 处理下一批 -----+
                |  查找就绪任务    |
                |  生成工作者 -----+--> [team-worker A] 阶段 1-5
                |  (可并行)      --+--> [team-worker B] 阶段 1-5
                +- 停止 (空闲) ----+         |
                                             |
  回调 <--------------------------------------+
  (下一节拍)        SendMessage + TaskUpdate(completed)
======================================================================
```

**核心优势：**
- 🎯 **事件驱动**：协调器仅在需要时唤醒（回调/恢复）
- ⚡ **快速推进**：简单后继直接生成，无需协调器往返
- 🔄 **动态流水线**：根据依赖图按任务生成
- 📊 **并行执行**：独立任务并发运行

---

## 🖥️ 前端亮点

### 终端仪表板 (Terminal Dashboard)

多终端网格布局，实时执行监控。

**功能特性：**
- 🖥️ 多终端网格，可调整窗格大小
- 📊 带智能体列表的执行监控器
- 📁 项目导航文件侧边栏
- 🎯 按项目标签分组会话
- 🌙 全屏/沉浸模式

### 编排器编辑器 (Orchestrator Editor)

可视化工作流模板编辑器，支持拖放。

**功能特性：**
- 🎨 基于 React Flow 的可视化编辑
- 📦 预构建工作流的模板库
- 🔧 节点配置属性面板
- ⚡ 斜杠命令集成

---

## 🙏 致谢

- **[Impeccable](https://github.com/pbakaus/impeccable)** — 设计审计方法论、OKLCH 色彩系统、anti-AI-slop 检测模式、编辑级排版标准、动效/动画 token 体系、以及原生 JS 交互模式。UI 团队技能（`team-ui-polish`、`team-interactive-craft`、`team-motion-design`、`team-visual-a11y`、`team-uidesign`、`team-ux-improve`）大量借鉴了 Impeccable 的设计知识。

- **[gstack](https://github.com/garrytan/gstack)** — 系统化调试方法论、安全审计框架与发布流水线模式。`investigate`（Iron Law 调试）、`security-audit`（OWASP Top 10 + STRIDE）、`ship`（门控发布流水线）三个技能的设计灵感来源于 gstack 的工作流设计。

---

## 🤝 贡献

<div align="center">
  <a href="https://github.com/catlog22/Claude-Code-Workflow"><img src="https://img.shields.io/badge/GitHub-仓库-181717?style=flat-square" alt="GitHub"/></a>
  <a href="https://github.com/catlog22/Claude-Code-Workflow/issues"><img src="https://img.shields.io/badge/Issues-报告问题-EF4444?style=flat-square" alt="Issues"/></a>
</div>

---

## 📄 许可证

<div align="center">

MIT License - 详见 [LICENSE](LICENSE)

</div>

---

## 💬 社区交流

<div align="center">

欢迎加入 CCW 交流群，与其他开发者一起讨论使用心得、分享经验！

<img src="assets/wechat-group-qr.png" width="300" alt="CCW 微信交流群"/>

<sub>扫码加入微信交流群（如二维码过期，请提 Issue 获取最新二维码）</sub>

</div>

---

## 🔗 友情链接

<div align="center">
  <a href="https://linux.do/"><img src="https://img.shields.io/badge/LINUX_DO-学AI，上L站！-6366F1?style=flat-square" alt="LINUX DO"/></a>
</div>

---

<div align="center">

<!-- Footer -->
<img src="https://capsule-render.vercel.app/api?type=waving&color=gradient&customColorList=6,11,20&height=100&section=footer"/>

</div>
