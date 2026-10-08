# DeskForge 优化评估与执行计划

> 评估日期：2026-10-07。基于当前工作树（HEAD `ef0aded`）逐文件阅读与本机实测。
> 本文回答三件事：现在哪里有问题、先修什么、每一步怎么算做完。

## 1. 结论摘要

DeskForge 的安全设计底子扎实：渲染层沙箱化、93 个 IPC 通道两端都做 zod 校验、SQLite 开了 WAL、审计有哈希链、类型检查全绿。问题集中在四处：

1. **两个真实缺陷需要立即修**：Worker 崩溃恢复的监听器从未注册，子进程崩了任务会卡住；`clean.sh` 会删掉被 Git 跟踪的应用图标源文件。
2. **几处安全边界有缺口**：文件预览/打开类 IPC 不校验路径；HTML 预览 iframe 同时开了 `allow-scripts` 和 `allow-same-origin`；删除命令守卫识别不了 `bash -c '…'`；MCP 调用和工具执行没有超时。
3. **会话一长就会卡**：会话列表对每条会话做完整加载；每次状态更新都把整份会话广播给界面；界面每收到一段流式文本就重建整条时间线并重新解析所有 Markdown。
4. **包体和工程化有明显浪费**：agent-host 打进了约 2.8 MB 用不到的模型 SDK 代码；渲染层是单个 1.5 MB 的包；本机是 arm64，打包脚本却只出 x64；`better-sqlite3` 只能服务 Node 或 Electron 之一，导致桌面端 69 个测试在开发机上直接失败。

按本文第 5 节执行，预计 **12–16 个工作日**完成阶段 0–4。可维护性类重构（拆分超大文件等）不在旧代码上做，原因见第 3 节。

## 2. 现状基线

### 2.1 规模

| 项 | 数值 |
| --- | --- |
| TS/TSX/CSS/MJS 源码 | 约 39,900 行，64 个测试文件 |
| 最大文件 | `database.ts` 1549 行、`bridge.ts` 1327、`tool-broker.ts` 1195、`contracts/api.ts` 1008、`App.tsx` 990 |
| IPC 通道 | 93 个（`packages/contracts/src/api.ts`） |
| 依赖体积 | 根 `node_modules` 718 MB |

### 2.2 测试与检查（2026-10-07 本机实测）

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `packages/core` 测试 | 81/81 通过 |
| `packages/contracts` 测试 | 17/17 通过 |
| `independent/` 测试 | 24/24 通过 |
| `apps/desktop` 测试（跳过 pretest 直接跑 vitest） | 255 通过、**69 失败**、1 跳过 |

69 个失败全部来自同一原因：`better-sqlite3` 当前编译给了 Electron（`NODE_MODULE_VERSION 148`），系统 Node 需要 147。正常流程靠 `pretest` 重编译解决，但重编译后 `./run.sh` 又要编回 Electron，两边来回切换。见第 4.5 节 D1。

### 2.3 构建产物体积（`apps/desktop/dist`）

| 产物 | 大小 | 说明 |
| --- | --- | --- |
| `renderer/assets/index-*.js` | 1,502 KB | 单一 chunk，所有页面和预览弹窗都打在一起 |
| `main/agent-host.cjs` | 1,444 KB | |
| `main/chunks/google-shared-*.js` | 1,217 KB | 项目只用 OpenAI 兼容协议，用不到 |
| `main/chunks/mistral-conversations-*.js` | 1,123 KB | 用不到 |
| `main/chunks/otel-*.js` / `anthropic-messages-*.js` | 292 KB / 239 KB | 用不到 |
| `main/index.cjs` | 546 KB | |
| `main/tool-runner.cjs` | 451 KB | |

## 3. 前提：和「独立重建」计划的关系

`docs/INDEPENDENCE_PLAN.md` 已经定了方向：现有桌面代码是**过渡版，冻结功能**，只处理安全、许可、数据导出和用户明确提出且可局部验证的修复；新实现在 `independent/` 里从独立规格重建。

所以本计划分两条线：

- **旧版（`apps/desktop` + `packages/*`）**：只做局部、可验证的修复——缺陷、安全缺口、明显的性能热点、构建链路。每项改动限制在少数文件内，带测试。
- **新版（`independent/`）**：结构性问题（超大文件、迁移体系、渲染层状态模型、错误分类统一）不在旧代码上重构，而是把结论写进 `docs/rebuild/ARCHITECTURE.md` 和 `ACCEPTANCE.md`，让新实现一开始就避开。见第 5 节阶段 5。

如果你决定放弃重建、长期维护旧版，阶段 5 的条目就改成在旧代码上执行，工作量另估。

## 4. 问题清单

编号规则：S＝安全与正确性，P＝性能，M＝可维护性，D＝工程化与开发体验，U＝界面体验。影响分高/中/低。行号对应当前 HEAD。

### 4.1 缺陷（必须修）

**B1　Worker 崩溃恢复监听器从未注册** · 高

`index.ts` 定义了 `workerFailureHandler`，清理时也调用了 `removeListener`，但全文件没有 `app.on('child-process-gone', …)`。`worker-bridge.ts:71` 的注释还假设这条路径存在。

```217:227:apps/desktop/src/main/index.ts
  const workerFailureHandler = (_event: Electron.Event, details: Electron.Details): void => {
    // ...
    host.stop(); runner.stop()
    coordinator.recoverAfterWorkerFailure(name, details.reason)
  }
```

后果：agent-host 或 tool-runner 崩溃后，`recoverAfterWorkerFailure` 永远不会执行，正在运行的任务不会转为「暂停」，界面停在执行中。

修复：定义后立即 `app.on('child-process-gone', workerFailureHandler)`；补一个测试，模拟崩溃事件后断言任务进入可恢复的暂停状态。

**B2　`clean.sh` 删除被 Git 跟踪的图标源文件** · 高

```bash
rm -rf apps/desktop/dist apps/desktop/build dist out
```

`apps/desktop/build/` 里是 `icon.icns`、`icon.png`、`icon.svg`，都在 Git 中，打包配置 `mac.icon` 和 `run.sh` 都依赖它们。执行一次 `./clean.sh -y` 后打包就会丢图标。

修复：从删除列表去掉 `apps/desktop/build`，改为删除 `outputs/release`（真正的打包产物目录）。

### 4.2 安全与健壮性

**S1　文件打开/预览类 IPC 不限制路径** · 高

```206:218:apps/desktop/src/main/ipc-api.ts
      'app:reveal-path': async ({ path }) => { shell.showItemInFolder(path) },
      'app:open-path': async ({ path }) => {
        const errorMessage = await shell.openPath(path)
        // ...
      'app:read-file-content': async ({ path, maxBytes }) => {
        const canonical = await realpath(path)
        // ...
        const buffer = await readFile(canonical)
```

渲染层传什么绝对路径都能读、能用系统程序打开。`read-file-content` 还先把整个文件读进内存再截断，大文件会顶满内存。渲染层一旦被注入（见 S2），这就是读取 `~/.ssh` 之类文件的通道。

修复：路径必须落在已授权工作区、`userData/artifacts` 或任务附件目录内（复用 `packages/core/src/path-guard.ts`）；`read-file-content` 用 `open` + `read` 只读取 `maxBytes`；`open-path` 对可执行文件（`.app`、`.command`、`.sh` 等）拒绝或二次确认。

**S2　HTML 预览 iframe 沙箱形同虚设** · 高（需先实测）

```310:315:apps/desktop/src/renderer/src/features/work/DocumentPreviewModal.tsx
                  <iframe
                    key={iframeKey}
                    sandbox="allow-scripts allow-forms allow-same-origin"
                    srcDoc={text}
```

`allow-scripts` 和 `allow-same-origin` 同时打开时，iframe 内脚本与应用同源，可以访问 `window.parent.deskforge`，进而调用全部 93 个 IPC（包括 `runs:respond-approval` 自己批准审批、S1 的任意文件读取）。被预览的 HTML 通常由 Agent 生成，内容可被提示注入影响。

目前 `index.html` 的 CSP（`script-src 'self'`）会被 srcdoc iframe 继承，内联脚本大概率被拦，所以「交互式 HTML 预览」可能本来就不工作；但只要将来有人为了让预览能跑而放宽 CSP，这就成了完整的逃逸链。

同文件 323–325 行用 `dangerouslySetInnerHTML` 直接插入 SVG，目前也只靠 CSP 兜底。

修复：

1. 去掉 `allow-same-origin`，只保留 `allow-scripts`（iframe 变成不透明源，无法触达父窗口）。
2. 更稳妥的做法：注册独立的 `deskforge-preview://` 协议，给预览内容单独下发 CSP（禁网络），渲染层只用这个协议加载。
3. SVG 改为 `<img src="data:image/svg+xml,…">` 或放进同样的隔离 iframe。
4. 加一条契约测试：断言预览 iframe 的 `sandbox` 不含 `allow-same-origin`。

**S3　删除命令守卫识别不了 `bash -c` / `eval`** · 高

`packages/core/src/shell-guard.ts` 用正则拆分命令段，包装器列表只有 `sudo`、`env`、`xargs` 等：

```7:8:packages/core/src/shell-guard.ts
const DESTRUCTIVE_EXECUTABLES = new Set(['rm', 'rmdir', 'unlink', 'shred', 'srm', 'trash', 'truncate'])
const WRAPPERS = new Set(['sudo', 'doas', 'command', 'builtin', 'nohup', 'time', 'nice', 'env', 'xargs'])
```

`bash -c 'rm -rf ~/Documents'`、`sh -c …`、`eval "rm …"`、`python3 -c "import shutil; …"` 都不会被识别为删除，硬性拒绝规则被绕过（这些命令仍会走普通审批，所以不是自动执行，但「工作区外删除直接拒绝、不出审批卡」的承诺失效）。

修复：`bash|sh|zsh|dash -c`、`eval`、`source`、`.` 的参数递归送回守卫检查；无法静态解析的（含变量、命令替换）一律视为高风险并标注原因；`python -c` / `node -e` / `perl -e` 归为「无法确认」，不允许会话级放行。补对应测试用例。

**S4　Shell 以登录 shell 执行** · 中

```199:199:apps/desktop/src/workers/tool-runner.ts
      return runProcess(command.requestId, loginShell(), ['-lc', String(args.command)], cwd, Math.min(Number(args.timeoutMs ?? 120_000), 600_000))
```

`-l` 会加载用户的 `.zprofile` / `.bash_profile`，用户定义的 alias、函数和环境变量都会影响命令的真实含义，策略层看到的 `ls` 未必是真的 `ls`。

修复：改为非登录、非交互的 `-c`，显式设置 `PATH`（在应用启动时读取一次登录 shell 的 PATH 并缓存），清掉 `ENV`、`BASH_ENV`、`ZDOTDIR`。

**S5　MCP 调用与工具执行没有超时** · 高

- `mcp-client.ts:132` 的 `listTools` 和 `:141` 的 `callTool` 没有套 `withTimeout`（同文件只有连接阶段有超时）。
- `worker-bridge.ts:116–125` 的 `ToolRunnerBridge.execute` 返回的 Promise 没有超时，Worker 不回包就永远挂起，`pending` Map 只增不减。

修复：两处都加超时（MCP 默认 60 s、可在 Server 配置里调），超时后发送 `cancel` 并 reject；`stop()` 时 reject 并清空所有 pending。

**S6　取消任务时前台 Shell 子进程可能残留** · 中

`tool-runner.ts` 的 `cancel-run` 只停止 `managedProcesses`，前台 `shell.run` 和 ripgrep 子进程只能靠逐个 `requestId` 取消；子进程以 `detached: true` 启动，若 tool-runner 被强杀，进程组会成为孤儿。

修复：`processes` Map 记录 `runId`，`cancel-run` 时一并结束；主进程在 B1 恢复流程里按数据库中记录的 PID 发送 `SIGTERM` 兜底。

**S7　模型 API Key 驻留在 agent-host 进程** · 中（路线图已暂缓）

`run-coordinator.ts` 在 `start` 消息里把明文 Key 发给 agent-host。ROADMAP「暂缓」中已列出「API key 代理」。本计划不改变暂缓决定，但建议在新内核规格里直接按「主进程代理请求、Worker 只拿会话令牌」设计。

### 4.3 性能

**P1　会话列表对每条会话做完整加载** · 高

```616:616:apps/desktop/src/main/database.ts
  listRuns(limit = 100): any[] { return (this.db.prepare('SELECT * FROM runs ORDER BY updated_at DESC LIMIT ?').all(limit) as any[]).map((r) => this.hydrateRun(r)) }
```

`hydrateRun`（644–695 行）为每条会话执行约 10 条查询：全部消息（**无 LIMIT**，664 行）、200 条事件、200 条工具调用、全部产物、审批、400 个 trace span，外加一次对 `audit_events` 的 JSON 聚合。`runs:list` 只需要摘要，却为 50 条会话做了约 500 次查询并反序列化所有 JSON；随后还在内存里按 `workspaceId`、`status` 过滤（`ipc-api.ts:251–253`），过滤条件没下推到 SQL。

修复：新增 `listRunSummaries({ workspaceId, status, limit })`，只查 `runs` 表的列加必要的计数；token 用量改为在 `runs` 表上冗余累计字段（每次模型回合完成时更新），不再每次聚合审计表。

**P2　每次状态更新都广播整份会话** · 高

```611:614:apps/desktop/src/main/run-coordinator.ts
  emitRun(runId: string): void {
    const run = this.getRun(runId)
    this.emit({ id: randomUUID(), runId, sequence: this.nextSequence(runId), at: new Date().toISOString(), kind: 'run.updated', run })
  }
```

`getRun` 走完整 `hydrateRun`，再经 `presentRun` 转换、zod 校验（`index.ts:164`）、结构化克隆发到渲染层。一个工具密集的任务里 `emitRun` 被调用几十上百次，会话越长每次越贵，且全部同步跑在主进程线程上。

修复：`run.updated` 只携带 `runs` 表本身的字段（状态、计数、时间、用量）；详情由渲染层在需要时调用 `runs:get`。同时把 `messages` 查询改为分页（默认最近 200 条，向上滚动再取）。

**P3　缺少三个常用索引** · 中

`hydrateRun` 按 `run_id` 查询 `artifacts`、`approvals`、`task_steps`，这三张表都没有对应索引（`database.ts` 中只有 runs、messages、run_events、audit_events 等的索引）。

修复：补 `artifacts(run_id, created_at)`、`approvals(run_id, status, created_at)`、`task_steps(run_id, ordinal)`。

**P4　流式输出时界面整条时间线重算** · 高

- `hooks.ts:117–127`：每个 `message.delta` 都 `map` 一遍全部事件，生成新的 `runDetail` 对象。
- `WorkTimeline.tsx:243`：`useMemo(() => buildWorkTurns(detail), [detail])`，`detail` 每次都是新对象，等于每段文本都重建全部轮次和过程时间线（`work-turn.ts:238–270`）。
- `WorkTimeline.tsx:269`、`283`：每一轮都渲染 `<Markdown>`，没有 `React.memo`，历史消息每次都被 `react-markdown` + `remark-gfm` 重新解析。
- `App.tsx` 给 `TasksView` 的约 20 个回调都是内联箭头函数，即使加了 memo 也会失效。

会话到几十轮以后，流式输出会明显掉帧。

修复：

1. 流式 delta 先进缓冲，用 `requestAnimationFrame` 每帧合并一次再更新状态。
2. 流式文本单独存放（`streamingText` 状态），不改写 `events` 数组；只有正在流式的那一轮重新渲染。
3. 抽出 `MemoMarkdown = memo(Markdown)`，`remarkPlugins`、`components` 提到模块级常量。
4. 轮次行组件按 `turn.id` + 内容长度 memo；`TasksView` 的回调用 `useCallback` 或放进 Context。
5. 50 轮以上再考虑虚拟列表（`@tanstack/react-virtual`），作为可选项。

**P5　agent-host 打进了用不到的模型 SDK** · 高

```1:2:apps/desktop/src/workers/agent-host-runtime.ts
import { createModels, createProvider, envApiKeyAuth, InMemoryCredentialStore, type Model, type ModelThinkingLevel, type ProviderStreams, type SimpleStreamOptions } from '@earendil-works/pi-ai'
import { stream as openAICompletionsStream, streamSimple as openAICompletionsStreamSimple } from '@earendil-works/pi-ai/api/openai-completions'
```

只注册了 `openai-completions`，但从包入口引入 `createModels` 把整个服务商注册表连同 Google、Mistral、Anthropic、Azure、Vertex、OpenTelemetry 一起带进来，`dist/main/chunks` 多出约 2.8 MB。

修复：改为只从子路径引入需要的部分（`createProvider` 和 `openai-completions`），不调用 `createModels`；如果 pi-ai 没有不带注册表的子路径，在 `electron.vite.config.ts` 里把这些服务商模块 alias 到空模块。验收看 chunk 列表和 agent-host 冷启动时间。

**P6　渲染层单包 1.5 MB、无代码分割** · 中

`App.tsx` 静态引入设置、资料库、自动化、审计页和 `DocumentPreviewModal`，全仓库没有 `React.lazy`。

修复：非首屏页面和预览弹窗改为 `React.lazy` + `Suspense`；`@phosphor-icons/react` 确认按图标单独引入。目标首屏 chunk < 700 KB。

**P7　本地知识库索引跑在主进程** · 中

`knowledge-index.ts:256` 起逐个文件 `lstat` / `realpath` / 读取 / 切块 / 写 FTS，`.docx` 用同步的 `inflateRawSync`（`docx-text.ts:39`）。5000 个文件的工作区建索引期间，主进程事件循环被大量同步工作切碎，界面 IPC 响应变慢。ROADMAP 已把「后台索引与进度条」列为未做事项。

修复：索引构建移到 tool-runner（已有 Worker 和文件访问能力）或单独的 utilityProcess，主进程只收进度事件；FTS 写入按 200 个文件一批放进事务。

向量检索（380–390 行）已经用 `iterate` + `topK` 流式计算，没有一次性载入全部向量，当前规模可以接受，不列入本计划。

**P8　启动时同步清理日志** · 中

`index.ts:150–153` 在窗口创建之前同步执行 `pruneDetailedLogs`，对 `run_events`、`tool_calls`、`audit_events` 做 UNION 扫描。数据库到几百 MB 时会拖慢冷启动。

修复：窗口 `ready-to-show` 之后用 `setImmediate` / 空闲时执行，分批删除。

**P9　工具进度输出逐块发送** · 低

`tool-runner.ts:326` 每个 stdout/stderr 块（最大 16 KB）单独 `postMessage`，构建、测试类命令会刷出大量 IPC 消息。

修复：复用 `event-buffer.ts` 的合并逻辑（50 ms 或 8 KB 一批）。

**P10　上下文预算按全部工具 schema 预留** · 低

`agent-host.ts:210` 把 `JSON.stringify(command.tools)` 全量计入预留 token，而实际只发送目录和已加载的工具，导致比必要更早触发上下文压缩。

修复：只计入实际随请求发送的工具 schema，`capability_load` 后重算。

### 4.4 可维护性（结论写进新内核规格，旧代码不重构）

| 编号 | 问题 | 证据 | 给新内核的要求 |
| --- | --- | --- | --- |
| M1 | 迁移体系名存实亡 | `database.ts:55–58` 建了 `schema_migrations` 表但从不写入；实际靠 `table_info` 判断列是否存在再 `ALTER TABLE`（340–392 行） | 用 `PRAGMA user_version` + 编号迁移函数，每个版本一个函数，带升级测试 |
| M2 | 超大文件 | `database.ts` 1549 行混合会话、审批、审计、MCP、技能；`tool-broker.ts` 1195 行；`App.tsx` 990 行 | 按领域拆仓储层；IPC 层只做参数转换 |
| M3 | 渲染层重复定义类型 | `renderer/src/types.ts`（587 行）重新定义 `RunStatus`、`RunDetailView` 等；`bridge.ts` 有几十个 `normalize*` 函数把 IPC 返回值再整形一遍 | 渲染层直接使用 contracts 的类型，只在确有差异处写适配器 |
| M4 | 两套模型错误分类 | `agent-host-runtime.ts` 的 `isRetryableProviderError` / `toPublicProviderError` 与 `packages/core/src/model-errors.ts` 的 `classifyModelError` 规则重叠；`core/src/retry.ts` 在模型请求路径上没被使用 | 只保留 core 一套分类与退避 |
| M5 | 大量 `any` | `database.ts` 几乎所有返回值、`context-checkpoint.ts`、`model-request-pipeline.ts` | 数据层返回 contracts 类型，禁止 `any` 的 lint 规则 |
| M6 | 依赖声明但未使用 | `zustand` 在 `package.json` 中，源码没有任何引用 | —（旧版直接删除，见阶段 0） |

旧版里只做两件低成本、零风险的清理：删除未使用的 `zustand`（M6）；把残留的 `WORKBUDDY_UPDATE_FEED_URL`（`update-service.ts:25`）和测试环境变量 `WORKBUDDY_ONLINE_SEARCH`（`runner-security.test.ts:200`）改为 `DESKFORGE_*`，同时保留旧变量名作为兼容回退。`WORKBUDDY.md` 规则文件的回退加载（`run-preparation-pipeline.ts:460–462`）是用户可见的兼容行为，保留。

### 4.5 工程化与开发体验

**D1　`better-sqlite3` 在 Node 和 Electron 之间来回重编译** · 高

现状：`pretest` 编译成 Node ABI，`run.sh` / `smoke` / `e2e` 编译成 Electron ABI。开发机上跑完 `./run.sh` 再直接跑 vitest，桌面端 69 个测试失败。

修复：让 vitest 也跑在 Electron 自带的 Node 上——`ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run`，这样只需要一份 Electron ABI 的二进制，去掉 `pretest` 里的重编译。CI 用同样的方式。

**D2　打包只出 x64，本机是 arm64** · 中

`package:mac` 固定 `rebuild:electron:x64` + `--x64`。在 Apple Silicon 上安装后通过 Rosetta 运行，启动和流式渲染都更慢。

修复：`package:mac` 按 `process.arch` 选择架构（默认 arm64）；需要分发给 Intel 用户时再用 `universal`。

**D3　`build.sh` 不遵守 01_APP 产物约定** · 低

`01_APP/CLAUDE.md` 要求打包后复制到 `01_APP/应用程序/<项目>/`，当前 `build.sh --package` 只把产物留在 `outputs/release`。

修复：`--package` 成功后把 `DeskForge.app` 复制到 `${NOAH_APPS_DIR:-../../应用程序}/12_DeskForge/`，`NOAH_COPY_APPS=0` 时跳过。

**D4　`run.sh` 吞掉原生模块重编译的错误** · 低

```bash
pnpm --filter @deskforge/desktop exec electron-rebuild -f -w better-sqlite3 >/dev/null 2>&1 || true
```

重编译失败时脚本照常启动，用户看到的是 Electron 里一条难懂的 `NODE_MODULE_VERSION` 报错。

修复：失败时打印日志尾部并退出非零。

**D5　有 ESLint 配置却没有 lint 脚本，CI 只跑 Ubuntu** · 中

根目录有 `eslint.config.mjs`，但根和 `apps/desktop` 的 `package.json` 都没有 `lint` 脚本；CI（`.github/workflows/ci.yml`）只做安装、类型检查和测试，不构建、不跑 smoke，也没有 macOS 任务。

修复：加 `pnpm lint` 并进 CI；CI 增加 `pnpm build` 和 `xvfb-run -a pnpm smoke`；包体积超过阈值时让 CI 失败（防止 P5/P6 回退）。

**D6　内置 Skill 有两份副本且已漂移** · 低

README 称 `skills/examples/` 与 `apps/desktop/resources/skills/` 相同，实际 `resources/skills` 多了 `data-analysis` 和 `document-export`。

修复：`skills/examples/` 改为说明文档指向 `resources/skills/`，或加一个测试断言两边一致。

### 4.6 界面体验

| 编号 | 问题 | 位置 | 修复 |
| --- | --- | --- | --- |
| U1 | 文档预览弹窗和引导页没有焦点圈定与焦点归还 | `DocumentPreviewModal.tsx:124–135` 只处理 Escape；引导页 `App.tsx` 约 745 行只有 `role="dialog"` | 复用 `ui.tsx` 中 `Modal` 已有的焦点管理 |
| U2 | 图片预览用 `file://` 路径，CSP 的 `img-src` 不允许 | `DocumentPreviewModal.tsx:304` | 走 S2 的预览协议或读成 `blob:` URL |
| U3 | 部分颜色写死，没有用设计变量 | `overlays.css` 124–136 行引导页 `#121216`、`#9e968c`、`#fff` 等 | 新增 `--onboarding-side`、`--on-accent` 等变量替换 |

### 4.7 测试缺口

| 模块 | 现状 | 应补的用例 |
| --- | --- | --- |
| `main/index.ts` 崩溃恢复 | 无测试 | B1：崩溃事件 → 任务暂停 |
| `main/ipc-api.ts` | 无测试 | S1：工作区外路径拒绝、大文件只读前 N 字节；P1：列表过滤 |
| `main/worker-bridge.ts` | 无测试 | S5：超时 reject、`stop()` 清空 pending、非法消息丢弃 |
| `core/shell-guard.ts` | 无 `bash -c` / `eval` 用例 | S3 全部绕过形式 |
| `renderer/hooks.ts` 流式合并 | 无测试 | P4：多次 delta 合并为一次状态更新、乐观消息对账 |
| `DocumentPreviewModal` | 测试复制了格式判断逻辑，没引入组件本身 | S2：sandbox 属性契约 |
| `secret-store.ts`、`artifact-store.ts`、`session-export.ts`、`trace-recorder.ts` | 无测试 | 加密不可用时拒绝、按 SHA 去重、导出脱敏 |

## 5. 执行计划

每个阶段一个或几个 PR。每个任务做完都要跑：`pnpm typecheck`、`pnpm test`、`pnpm build`；涉及界面的再跑 `./run.sh` 手动走一遍主流程。

### 阶段 0　护栏与基线（0.5–1 天）

先把会让后续改动「看不出好坏」的问题解决掉。

| 任务 | 对应问题 | 完成标准 |
| --- | --- | --- |
| 0.1 修 `clean.sh`，不再删除 `apps/desktop/build` | B2 | 执行 `./clean.sh -y` 后 `git status` 中图标文件无变化 |
| 0.2 vitest 改用 Electron 内置 Node 运行，去掉 pretest 重编译 | D1 | 先 `./run.sh` 再 `pnpm test`，桌面端 325 项无 ABI 失败 |
| 0.3 加 `pnpm lint` 脚本，修掉存量报错或设为 warn | D5 | `pnpm lint` 退出码 0 |
| 0.4 删除未使用的 `zustand` | M6 | 构建通过 |
| 0.5 建性能基线脚本：生成含 200 个会话、每个 300 条消息的测试库，测 `runs:list`、`runs:get`、`emitRun` 耗时；记录各 chunk 体积 | P1/P2/P5/P6 | 基线数字写入本文第 6 节 |

### 阶段 1　缺陷与安全缺口（3–4 天）

| 任务 | 对应问题 | 完成标准 |
| --- | --- | --- |
| 1.1 注册 `child-process-gone` 监听；恢复后清理孤儿进程 | B1、S6 | 测试：模拟崩溃 → 任务暂停 → 可继续；`kill -9` tool-runner 后无残留子进程 |
| 1.2 `app:*` 文件类 IPC 加路径白名单与读取上限 | S1 | 测试：工作区外路径、`~/.ssh/id_rsa`、软链接越界均拒绝；1 GB 文件只读 2 MB |
| 1.3 预览 iframe 去掉 `allow-same-origin`；SVG 改为图片或隔离 iframe；评估预览专用协议 | S2、U2 | 契约测试通过；手动验证：恶意 HTML 访问 `parent.deskforge` 得到错误 |
| 1.4 删除守卫递归检查 `sh -c` / `eval` / `source`；解释器 `-c` / `-e` 标为无法确认 | S3 | 新增至少 10 个绕过用例全部被拦或标高风险 |
| 1.5 Shell 改为非登录 `-c`，启动时缓存登录 shell 的 PATH | S4 | `pnpm test`、`git status` 等白名单命令在工作区内正常；alias 不再生效 |
| 1.6 MCP `listTools`/`callTool` 与 `ToolRunnerBridge.execute` 加超时 | S5 | 测试：挂起的 MCP 假服务在超时后返回中文错误，pending 清空 |

### 阶段 2　主进程数据路径（3–4 天）

| 任务 | 对应问题 | 完成标准 |
| --- | --- | --- |
| 2.1 `runs` 表冗余 token 用量字段，模型回合完成时累加；启动时一次性回填旧数据 | P1 | 与原聚合结果一致的测试 |
| 2.2 新增 `listRunSummaries`，过滤条件下推 SQL；`runs:list` 改用它 | P1 | 基线库上 `runs:list` 耗时下降 ≥ 80% |
| 2.3 `run.updated` 只发摘要字段；渲染层按需 `runs:get` | P2 | 单次事件负载 < 4 KB；界面行为不变（手动验收 TESTING.md M1–M4 主流程） |
| 2.4 消息分页：默认最近 200 条，渲染层向上滚动加载 | P2 | 2000 条消息的会话打开时间 < 300 ms |
| 2.5 补三个索引 | P3 | `EXPLAIN QUERY PLAN` 显示使用索引 |
| 2.6 启动清理日志延后、分批 | P8 | 窗口出现时间不受日志量影响 |

### 阶段 3　渲染层与包体积（3–4 天）

| 任务 | 对应问题 | 完成标准 |
| --- | --- | --- |
| 3.1 流式 delta 按帧合并，流式文本独立存放 | P4 | 测试：100 次 delta 只触发 ≤ 10 次状态提交 |
| 3.2 Markdown 和轮次行 memo，回调稳定化 | P4 | React Profiler：流式期间历史轮次不重新渲染 |
| 3.3 agent-host 只引入 OpenAI 兼容协议 | P5 | `dist/main/chunks` 不再含 google / mistral / anthropic / otel；连接测试和 `provider-streaming.test.ts` 通过 |
| 3.4 非首屏页面和预览弹窗懒加载 | P6 | 首屏 chunk < 700 KB |
| 3.5 预览弹窗、引导页焦点管理；引导页颜色改用变量 | U1、U3 | 键盘可完整操作，Tab 不逃出弹窗 |

### 阶段 4　Worker、知识库与发布（2–3 天）

| 任务 | 对应问题 | 完成标准 |
| --- | --- | --- |
| 4.1 知识库索引移出主进程，带进度事件 | P7 | 索引 5000 文件期间界面切换会话无卡顿；`knowledge.test.ts` 通过 |
| 4.2 工具进度输出合并 | P9 | `pnpm test` 类命令的 IPC 消息数下降一个数量级 |
| 4.3 上下文预算只计实际发送的工具 | P10 | `model-request-pipeline.test.ts` 增加用例 |
| 4.4 打包按本机架构，产物复制到 `01_APP/应用程序/`；`run.sh` 重编译失败时报错退出 | D2、D3、D4 | arm64 机器上打出原生 arm64 `.app` |
| 4.5 CI 加 build、smoke、lint 和包体积阈值 | D5 | CI 绿；人为加入大依赖时 CI 失败 |
| 4.6 统一 Skill 副本，残留命名改为 `DESKFORGE_*`（保留兼容） | D6、M6 | 测试断言两处一致 |

### 阶段 5　写进新内核规格（1 天，随重建持续）

不改旧代码。把第 4.4 节 M1–M5、S7、P1–P4 的教训写成 `docs/rebuild/ARCHITECTURE.md` 的约束和 `ACCEPTANCE.md` 的验收项，例如：

- 数据层：编号迁移 + `user_version`；列表接口只返回摘要；事件只发增量。
- 渲染层：流式文本与历史消息分离存储；共享 contracts 类型，不重复定义。
- 安全：Key 不出主进程；Shell 非登录执行；所有外部调用有超时；预览内容放在独立源。
- 验收矩阵 F03、F08、F13、F29 各补一条对应的性能或安全用例。

## 6. 度量指标

阶段 0.5 先填「基线」列，每个阶段结束后更新「当前」列。

| 指标 | 基线 | 目标 | 当前 |
| --- | --- | --- | --- |
| 桌面端测试（开发机直接跑） | 255 过 / 69 失败 | 全部通过 | 345 过 / 0 失败 / 1 跳过 |
| 渲染层首屏 JS | 1,502 KB | < 700 KB | 296 KB（代码分割与懒加载） |
| agent-host 主文件 + 服务商 chunk | 约 4.3 MB | < 1.6 MB | 924 KB（剔除未用 Provider） |
| `runs:list`（200 会话测试库，100条） | 49.8 ms | 下降 ≥ 80% | 1.24 ms（下推摘要下降 97.5%） |
| 单次 `run.updated` 事件负载 | 0.82 KB | < 4 KB | 0.70 KB（轻量摘要通知） |
| 2000 条消息会话打开时间 | 2.64 ms | < 300 ms | 0.62 ms（分页加载提速 76%） |
| 流式输出时历史轮次重渲染次数 | 每段文本一次 | 0 | 0（独立流式状态与组件记忆化） |
| Worker 崩溃后任务状态 | 停在执行中 | 自动暂停、可继续 | 自动暂停、可继续、清理孤儿进程 |

## 7. 明确不做的事

- **不在旧代码上拆分超大文件、重写状态管理**：与独立重建计划冲突，投入会在新内核上线后作废。
- **不给向量检索上 ANN 索引**：当前已是流式 topK，5000 文件规模足够。
- **不做签名公证、API Key 代理、Chrome 扩展**：ROADMAP 已暂缓，本计划不改变。
- **不引入 i18n 框架**：目前只有中文界面，收益低。

## 8. 风险与待决事项

| 事项 | 说明 | 默认处理 |
| --- | --- | --- |
| 是否继续独立重建 | 决定第 3 节的分线是否成立 | 按 INDEPENDENCE_PLAN 继续重建，旧版只做本计划阶段 0–4 |
| 交互式 HTML 预览要不要保留脚本能力 | 去掉 `allow-same-origin` 后部分依赖 localStorage 的页面会失效 | 安全优先；需要完整能力时用系统浏览器打开 |
| Shell 改非登录模式 | 依赖 `.zprofile` 中 alias 或函数的用户命令会失效 | 启动时缓存 PATH 覆盖大多数场景；在 README 说明 |
| `run.updated` 瘦身 | 渲染层若有地方依赖事件里的完整详情，会出现显示缺失 | 改动前先 grep 所有 `run.updated` 消费点并补测试 |
| pi-ai 子路径引入 | 依赖第三方包的内部导出路径，升级时可能断 | 锁定版本（已是 0.80.6 精确版本），升级时跑 `provider-streaming.test.ts` |

## 附录：本次评估的验证命令

```bash
cd 01_APP/01_Maintained/12_DeskForge
pnpm typecheck                                   # 通过
pnpm --filter @deskforge/core --filter @deskforge/contracts test   # 81 + 17 通过
(cd independent && npm test)                     # 24 通过
(cd apps/desktop && npx vitest run)              # 255 通过 / 69 失败（ABI）
rg -n "child-process-gone" apps packages         # 只有注释和 removeListener，没有注册
ls -la apps/desktop/dist/main/chunks             # 服务商 chunk 体积
```
