# DeskForge 开发规则

本文件约束本项目后续的程序设计、代码实现、入口接入和交付验证。适用于整个仓库；本文件是 Codex 自动读取的项目开发规则。具体任务以用户当前要求为准，不能把历史文档中的提交、推送或发布授权当作本次授权。

## 1. 项目定位与实现基线

- 产品是本地优先的 macOS 桌面工作 Agent，品牌统一使用 DeskForge，用户可见文案以中文为主。
- 现有桌面实现使用 Electron 43、React 19、TypeScript、electron-vite、SQLite 和 pnpm workspace。维护现有应用时沿用这套技术栈，不因上级目录的新项目选型约定改换框架。
- Node.js 最低版本为 22.14.0；包管理器为根 `package.json` 声明的 pnpm 10.33.3。依赖版本、脚本和构建入口以实际配置为准。
- `independent/` 是下一代独立内核原型，使用原生 ES modules 和 Node 标准库，未接入 Electron 应用，也不属于 pnpm workspace。修改它不会自动改变桌面程序行为。
- 现有实现做局部维护；重建能力按 `docs/INDEPENDENCE_PLAN.md` 和 `docs/rebuild/` 的独立规格推进。未完成验收的原型不得宣称完整替代现有程序。

## 2. 模块职责与依赖方向

| 位置 | 应放置的实现 | 边界 |
| --- | --- | --- |
| `packages/contracts/src/` | 跨进程类型、Zod schema、桌面 API 与 Worker 协议 | 不依赖 UI、Electron 主进程或数据库实现 |
| `packages/core/src/` | 策略、路径与 Shell 防护、状态机、审批、脱敏、diff 等通用逻辑 | 尽量保持可独立测试，不引用桌面业务层 |
| `apps/desktop/src/main/` | 初始化、任务编排、审批、安全检查、数据库、密钥和系统服务 | 掌握权限与持久化，不能依赖 renderer |
| `apps/desktop/src/preload/` | 明确列出的桌面 API 桥接 | 不承载业务流程，不暴露通用 IPC 或 Node 能力 |
| `apps/desktop/src/workers/` | 模型执行、工具执行、受控子进程和搜索 | 经协议与主进程通信，不自行绕过审批 |
| `apps/desktop/src/renderer/src/` | 页面、组件、交互状态、事件展示 | 通过桌面桥访问能力，不直接读文件、数据库或密钥 |
| `independent/` | 按独立规格实现的任务与文件内核 | 不导入、复制、转译或逐行改写现有业务模块 |

共享依赖方向为 `contracts → core → desktop`（箭头表示被上层使用）；桌面内部按接口与消息通信。禁止用跨层相对路径导入绕开包边界。新增代码优先放入对应业务模块，不为了复用两个小片段建立全局框架。

## 3. 程序入口标准

### 启动、构建与分发入口

- 根 `run.sh` 是日常启动入口，包含图标同步和 SQLite/Electron ABI 检查，再调用 `pnpm dev`。
- 根 `build.sh` 默认只构建；`./build.sh --package` 才生成 macOS 分发产物，并按脚本配置复制到应用程序目录。不能把普通构建描述为已生成安装包。
- 根 `clean.sh` 是清理入口，`-y` 明确确认删除依赖和构建输出；不得把清理作为日常验证必经步骤。
- npm/pnpm 命令以各级 `package.json` 为唯一脚本定义；调整命令时同步脚本、说明书和本文件。保留三个根脚本的可执行权限及 `程序说明书.md`。

### 主进程入口

- `apps/desktop/src/main/index.ts` 负责应用生命周期、服务装配、窗口、托盘、IPC 注册和退出清理。
- 新服务应在自己的模块实现，通过构造参数注入依赖，再在入口装配；不要继续把业务算法、SQL 和工具分支写进入口。
- 维持单实例、启动恢复、Worker 异常恢复和退出资源释放。新增定时器、订阅、连接与进程必须有明确清理路径。
- 窗口维持上下文隔离和沙箱；不得开启 renderer 的 Node 集成或关闭安全校验解决功能问题。

### 页面入口

- `apps/desktop/src/renderer/src/main.tsx` 只负责 React 根节点与全局样式加载。
- `App.tsx` 负责应用外壳、页面装配和顶层交互；页面实现放到 `features/<业务域>/`，通用 UI 使用 `ui.tsx`，图标沿用 `icons.tsx`。
- 非首屏页面和较重弹窗沿用现有 `lazy` / `Suspense` 方式。不要在入口一次性加载所有功能。
- 新页面必须接通页面状态/类型、导航入口、内容渲染和必要数据加载；涉及命令面板入口时同步 `features/shell/CommandPalette.tsx`。按钮必须执行真实动作并显示结果。
- 通过 `bridge.ts` 访问桌面 API，沿用现有 hooks 的刷新和事件机制；不能在组件中重复实现桥接兼容逻辑。

### 桥接与 Worker 入口

- `apps/desktop/src/preload/index.ts` 通过 `contextBridge` 暴露 `window.deskforge` 中明确列出的能力。
- 桌面请求使用 `deskforge:invoke` 与已注册的 channel；主进程校验调用窗口和 frame，并对输入、输出执行契约解析。不得向页面暴露任意 channel 调用器。
- Worker 启动入口为 `workers/agent-host.ts` 与 `workers/tool-runner.ts`，通过 `main/worker-bridge.ts` 管理。
- 构建入口由 `apps/desktop/electron.vite.config.ts` 定义。新增进程入口必须同时配置构建输出、启动位置、协议和退出处理，不允许只创建源文件。

## 4. 功能实现方式

### 新增或修改桌面 API

1. 在 `packages/contracts/src/` 定义输入、输出、类型和 schema，并在 `api.ts` 的契约表接入 channel；通过包公共入口导出。
2. 在主进程对应服务实现业务逻辑，在 `main/ipc-api.ts` 接入 handler。权限、真实路径和敏感参数检查必须在主进程执行。
3. 在 preload 显式暴露类型化方法，在 renderer `bridge.ts` 接入调用或必要的数据适配。
4. 页面处理加载、空结果、失败和成功状态。异步操作防止重复提交，失败不能显示为成功。
5. 更新契约与相关安全/行为测试；核对调用端和实现端都能通过类型检查。

### 新增 Agent 工具

1. 明确工具名称、参数 schema、返回结构、执行边界、超时和风险等级。
2. 按现有结构接入 `main/tool-registry.ts`、`main/tool-argument-validator.ts`、`main/tool-broker.ts` 及相关执行器；策略接入 `packages/core/src/policy.ts`。
3. 保持主进程统一控制：参数校验 → 路径/风险检查 → 必要审批与预览 → 执行前复核 → 执行 → 审计/产物/验证结果。
4. 修改审批参数后必须重新校验；工具执行器不能把模型提供的风险声明当作授权。
5. 写入能力提供 diff 和版本/回滚机制；不可逆操作明确提示影响。拒绝、取消、超时和执行失败都要收敛到有效状态。
6. 接通工具发现与启停机制，只给模型提供已激活工具；新增协议字段同步 `worker-ipc.ts`、解析器及通信两端。

### 修改模型或任务运行

- 模型差异集中在 `workers/provider-compat.ts`、`model-request-pipeline.ts` 等现有适配模块；不要把服务商判断散落在页面里。
- 使用夹具或本地 mock 覆盖流式文本、思考内容、工具调用、usage、错误与中断；模型请求变更补充 `workers/provider-streaming.test.ts` 等对应测试。
- 错误分类复用 `packages/core/src/model-errors.ts`，界面提供中文原因和下一步处理建议，技术详情先脱敏。
- 任务状态转换遵守 `packages/core/src/state-machine.ts` 和既有生命周期规则。取消/终态后不得继续执行工具或被迟到事件覆盖。
- 流式更新使用现有缓冲模块，避免每个 token 刷新完整页面；订阅在卸载时释放。

### 修改持久化与独立内核

- 数据库操作集中在主进程数据库/服务模块；使用参数绑定，关联更新使用事务。数据库结构变更沿用现有迁移机制，兼容已有用户数据。
- 审计链、会话、产物和文件版本不能因普通升级被清空。跨版本迁移先用匿名数据副本验证，失败应有明确恢复方式。
- 独立内核按“规格 → 契约/安全测试 → 实现 → 来源记录 → 验收”推进，更新 `independent/SOURCE_LEDGER.md` 和 `docs/rebuild/STATUS.md`。
- 独立实现兼容范围以 `docs/rebuild/ACCEPTANCE.md` 为准，阶段性演示通过不能代替完整功能验收。

## 5. 代码与界面规范

- TypeScript 使用 strict 配置，保留 `noUncheckedIndexedAccess` 与 `exactOptionalPropertyTypes`，不得通过关闭检查解决报错。
- 使用 2 空格缩进、单引号，并沿用所在文件的分号风格；函数和变量用 `camelCase`，组件、类型和类用 `PascalCase`，普通模块沿用 `kebab-case`。
- 新增跨边界数据优先使用 `unknown` 加 schema 解析，避免新增无必要的 `any`、强制断言和非空断言；类型不能替代运行时校验。
- 函数职责明确；纯规则放 core，流程放服务/协调器，展示放组件。不要复制已有策略、脱敏、diff 或错误分类。
- 不使用空 catch 隐藏业务失败；允许回退时明确回退条件并记录脱敏信息。公开行为应覆盖输入边界、错误和取消路径。
- 样式统一使用 `design/tokens.css` 的设计变量，按职责放入 `design/` 的对应样式文件，避免新增重复色值和随意的全局覆盖。
- 交互具备键盘操作、可辨识按钮名称、焦点管理和禁用状态；弹窗沿用现有 Modal 与焦点约束。
- 不使用占位数据冒充真实任务结果；新增可见文案用中文，说明动作和结果，不把内部路径、协议细节当作产品引导。
- 新增依赖先确认现有能力不能满足需求，添加到实际使用的 workspace 包，同时更新锁文件；不要混用 npm/yarn 锁文件。

## 6. 必须保留的安全规则

以下是 DeskForge 产品运行时规则，不是要求开发助手对每次仓库编辑弹出审批。

- 文件和 Shell 能力受用户授权工作区限制；路径检查覆盖 `..`、绝对路径、符号链接、撤销授权与执行时路径变化。不得默认授权 `/` 或个人主目录。
- “直接处理/先整理计划”控制任务流程，“请求批准/工作区内自动处理”控制权限；直接处理不等于自动批准，规划阶段只读。
- 自动处理仅限策略允许的可撤销工作区写入与严格验证命令；删除、敏感文件、凭据、外发、未知命令仍需批准或拒绝。
- MCP 调用逐次审批，不依据 Server 的 `readOnlyHint` 自动放行；stdio Server 不属于 OS 沙箱，不得宣传为完全隔离。
- 密钥使用 `safeStorage` 加密持久化，加密不可用时拒绝保存；界面不读回密钥，日志、导出、工具参数和一般模型上下文不得泄漏密钥。
- 不把模型通信所需凭据传播给工具执行器、MCP 子进程或任意系统环境；传给模型请求层的必要凭据限制用途与生命周期。
- 文件写入预览与实际执行绑定版本，冲突时拒绝覆盖；审批编辑不能提升原批准权限或绕过校验。
- Skill 导入保留预览、指纹复核、大小与路径检查；安装只复制文件，不执行包内脚本。
- 测试使用假密钥、临时目录和本地 mock。真实模型测试可能计费或外发，执行前应具备当前任务授权，不默认使用本机已有用户配置。

## 7. 开发命令与验证要求

下列命令除特别标注外，都从本项目根目录执行。

| 目的 | 命令 |
| --- | --- |
| 安装依赖 | `pnpm install`（CI 使用 `--frozen-lockfile`） |
| 日常启动 | `./run.sh` |
| 代码检查 | `pnpm lint` |
| 全包类型检查 | `pnpm typecheck` |
| workspace 单元测试 | `pnpm test` |
| 只测 core | `pnpm --filter @deskforge/core test` |
| 只测 desktop | `pnpm --filter @deskforge/desktop test` |
| UI 回归 | `pnpm --filter @deskforge/desktop test:review` |
| 构建 | `./build.sh` 或 `pnpm build` |
| 构建后体积检查 | `pnpm check:size` |
| Electron 启动冒烟 | `pnpm smoke` |
| 独立内核测试 | `npm --prefix independent test` |
| macOS 打包 | `./build.sh --package` |

- 桌面 Vitest 通过 `scripts/vitest-electron.mjs` 在 Electron Node 环境运行，并检测/重建 `better-sqlite3` ABI。不要直接用普通 Node 运行桌面测试并随意切换原生模块版本。
- 代码交付至少通过 `pnpm lint`、`pnpm typecheck` 和 `pnpm test`；桌面行为或构建相关变更补 `pnpm build`。先运行针对性检查，再完成相关交付检查。
- UI 变更补 UI 回归，并在 macOS 验证相关主流程、主题与窗口尺寸；记录实际验证结果，不能把浏览器 mock 测试当作 Electron 全链路验证。
- 独立内核必须另外运行自己的测试，根 `pnpm test` 不包含它。跨进程、安全或数据库变更覆盖对应边界和失败路径。
- `.github/workflows/ci.yml` 是 CI 检查基线。`test:e2e` 等额外脚本执行前核对配置、测试文件和浏览器依赖确实存在。
- 纯文档修改核对命令、文件路径、链接和 `git diff --check` 即可，无需为文档启动应用或打包。

## 8. 开发与交付流程

1. 修改前查看 `git status` 和相关文件，保留已有未提交工作；不重置、覆盖或纳入无关改动。
2. 明确验收行为与影响层，沿着现有入口完成最小闭环。不能仅完成页面、接口或工具的一端就宣称功能已实现。
3. 完成输入校验、失败状态、权限检查与资源释放，再运行与变更匹配的验证。
4. 变更影响启动、配置、功能或兼容范围时，同步 README、`程序说明书.md` 或相关设计文档；避免文档中的计划状态冒充代码现状。
5. 交付说明包含改了什么、入口在哪里、验证命令与结果，以及尚未完成或环境限制。未执行的验证必须明确标注。
6. 用户未要求时不自动提交、推送、发布或覆盖已安装应用。需要提交时使用清晰的 `feat:`、`fix:`、`docs:` 等主题。
7. 保留 `LICENSE`、`NOTICE`、`licenses/` 的来源与许可声明；不能仅凭改名、迁目录或增加独立原型删除现有声明。

## 9. 参考文档与维护方式

- `README.md`：现有桌面功能和使用说明。
- `CONTRIBUTING.md`：贡献约定；测试运行细节以当前脚本为准。
- `docs/TESTING.md`：macOS 手动验收。
- `docs/INDEPENDENCE_PLAN.md`、`docs/SOURCE_PROVENANCE.md`：重建方向与来源依据。
- `docs/rebuild/PRODUCT.md`、`ARCHITECTURE.md`、`ACCEPTANCE.md`、`STATUS.md`：新实现规格、验收与阶段记录。
- `independent/README.md`、`SOURCE_LEDGER.md`：独立内核现状、限制与来源记录。

技术栈、入口、跨进程协议、安全策略或验证命令变化时同步本文件。历史文档与当前代码冲突时核对实际实现并修正文档，涉及安全或产品范围的冲突不得通过降低约束消除。
