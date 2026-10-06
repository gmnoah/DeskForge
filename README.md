# DeskForge

本地优先的 macOS 桌面工作 Agent。界面跑在沙箱里，审批、策略和密钥留在主进程，模型调用和工具执行分别放在独立进程。文件和 Shell 只作用于你选中的工作区，授权根默认不会设成磁盘根目录 `/`。

DeskForge 是独立项目，不是 WorkBuddy，也不是腾讯的产品。桌面实现改编自 [OpenWorkbuddy](https://github.com/chenin0931/OpenWorkbuddy)（MIT，Copyright (c) 2026 OpenWorkbuddy contributors），详见 [`NOTICE`](NOTICE)。

DeskForge is an independent local-first macOS work agent. It is not WorkBuddy and it is not a Tencent product.

- 路线图：[docs/ROADMAP.md](docs/ROADMAP.md)
- 参与开发：[CONTRIBUTING.md](CONTRIBUTING.md)

## macOS 快速开始

需要 macOS、Node.js 22.14 或更新版本，以及 pnpm 10.33（可用 corepack 启用）。

```bash
git clone https://github.com/gmnoah/DeskForge.git
cd DeskForge
corepack enable
pnpm install
pnpm dev
```

首次启动会进入引导：

1. **连接模型**：选择服务商，确认服务地址和模型 ID，填写 API Key，然后点「测试连接」。测试只发一个极小的请求（约十几个 token，不带工具），成功后再「安全保存并继续」。
2. **授权工作区**：选择一个文件夹。之后的文件和 Shell 操作都被限制在这个目录里。
3. **记忆与执行方式**：按需开启。

之后可以在「设置 → 模型」里增删模型、替换 Key、对已保存的配置再次「测试连接」。

## 模型服务预设

所有预设都走 OpenAI 兼容的 Chat Completions 接口（`POST {baseUrl}/chat/completions`，流式）。服务地址都可以改。

| 预设 | 默认 baseUrl | 默认模型 | 其它常用模型 |
| --- | --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-flash` | `deepseek-v4-pro` |
| Kimi（Moonshot） | `https://api.moonshot.cn/v1` | `kimi-k2.6` | `kimi-k3`、`kimi-k2.7-code` |
| 通义（阿里云百炼 DashScope） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | `qwen3.8-max`、`qwen3.8-flash` |
| 自定义 | 由你填写（通常以 `/v1` 结尾） | 由你填写 | 任何 OpenAI 兼容服务，例如本地 vLLM / Ollama / 代理网关 |

各家需要注意的地方：

- **DeepSeek**：`deepseek-chat` 和 `deepseek-reasoner` 已于 2026-07-24 停用。旧配置会在请求时自动映射到 `deepseek-flash`（`deepseek-chat` 关闭思考，`deepseek-reasoner` 开启思考），诊断记录里会提示，建议把模型 ID 改掉。思考模式下的多轮工具调用会按官方要求回传 `reasoning_content`。
- **Kimi**：Key 与地址必须来自同一个平台。`platform.moonshot.cn` 的 Key 配 `https://api.moonshot.cn/v1`，`platform.moonshot.ai`（国际站）的 Key 配 `https://api.moonshot.ai/v1`，混用会返回 401。`moonshot-v1-*` 等旧模型已下线。`kimi-k2.7-code` 只能在思考模式下运行。K2.6 / K3 / K2.7 的采样参数（temperature、top_p 等）由服务端固定，DeskForge 不会发送这些参数。
- **通义 / DashScope**：Key 有地域之分。北京地域用 `dashscope.aliyuncs.com`，新加坡地域用 `dashscope-intl.aliyuncs.com`。如果百炼控制台给你的业务空间提供了专属接入地址，就按控制台显示的 `…/compatible-mode/v1` 填写。混合思考模型（如 `qwen-plus`、`qwen3.x`）通过 `enable_thinking` 开关思考。
- **自定义**：如果主机名属于上述服务商（如 `api.deepseek.com`、`api.moonshot.ai`、`dashscope-intl.aliyuncs.com`），DeskForge 会套用对应的兼容规则。其它服务按标准 OpenAI 协议处理，并且不会回传 `reasoning_content` 之类的非标准字段。

### 连接测试和报错

「测试连接」和对话中的失败都会被归类成中文提示，并附带处理建议：

| 情况 | 提示示例 |
| --- | --- |
| 401 / Key 无效 | 「DeepSeek拒绝了 API Key（认证失败）。」，并说明在哪里重新生成 Key、Kimi 的 .cn / .ai 平台怎么对应 |
| 404 / 返回 HTML | 「服务地址不正确」，并给出该服务商的正确 baseUrl |
| 模型不存在 | 「找不到这个模型」，并列出可用模型；已下线的模型会特别说明 |
| 402 / 余额不足 | 「账户余额或额度不足」 |
| 429 | 「请求过于频繁，触发了限速」 |
| 网络不通 / DNS / 证书 | 「无法连接」「无法解析域名」「证书校验未通过」 |
| 超时 | 「连接超时」 |
| 服务繁忙 / 5xx | 「当前繁忙」「服务端出错」，可重试 |

原始错误经过脱敏（Key 会被替换为 `[REDACTED]`）后放在「技术信息」里，方便排查。

### Token 用量

服务商在流式响应里返回 usage 时，每次工作的用量会显示在对话末尾和右侧「Token 用量」面板，包括输入（含缓存命中）、输出（含思考）和模型调用次数。所有模型回合（包括工具调用回合）都会累加。

### API Key 存储

API Key 在设置或引导里填写。macOS 上由系统钥匙串（Electron `safeStorage`）加密后保存在本机数据库，界面无法读回。密钥框留空表示保留已有密钥。加密不可用时保存会直接失败，不会把明文写入 SQLite。密钥不会进入工具参数、活动记录或模型上下文。

## 工作区白名单与审批

- **白名单**：只有你在引导或「设置 → 工作区」里添加的文件夹可以被访问。路径会先解析符号链接再检查，越界路径（`..`、绝对路径、指向工作区外的软链接）会被拒绝。
- **工作区搜索**：Agent 用 `file_find` 按文件名或 glob（如 `*.ts`、`src/**/*.md`）找文件，用 `file_search` 搜索文件内容（默认按字面量、忽略大小写，可选正则、区分大小写和 glob 过滤）。两个工具都属于 `readonly`，会自动执行，并且：
  - 遵守 `.gitignore`（包括父目录和子目录里的规则），始终跳过 `.git`、`node_modules` 和 `.deskforge-trash`；
  - 不跟随符号链接，起点路径越界（`..`、指向工作区外的软链接）直接拒绝；
  - 跳过二进制文件和超过 1 MB（最大可调到 2 MB）的文件；结果数默认 200、最多 1000，扫描条目和耗时也有上限，触顶时返回 `truncated` 和原因；
  - 有 ripgrep 时优先使用，没有时回退到内置扫描，行为一致。
- **风险分级**：每个工具调用在执行前由主进程的策略层分级：
  - `readonly`：读文件、列目录、查找和搜索、严格白名单内的只读 Shell 命令，以及不带凭据的公开网页读取，会自动执行。
  - `reversible_write`：写入、编辑、创建、移动文件，需要你批准。写入前会记录文件版本，可以回滚。
  - `external_side_effect`：会把数据发到本机以外的操作（如联网搜索的查询词、上传、发帖），需要你批准。
  - `high_risk_irreversible`：删除、支付、发送、提交等，每次都单独确认。
  - 删除类命令（`rm`、`rmdir`、`shred`、`find … -delete` 等）只要目标是主目录、磁盘根目录、工作区外的绝对路径，或用 `..` 跳出工作区，就直接拒绝，不会出现审批卡。
- **审批卡里的 diff**：写入、精确编辑、提交长文草稿和移入废纸篓之前，审批卡会显示统一 diff，可以切换为并排对比。新建文件全部显示为新增行，删除全部显示为删除行；超过 400 行时截断并注明省略了多少行。`.env` 等敏感配置只显示增删行数，不显示内容。
- **批准范围**：
  - 「仅批准本次」。
  - 「本工作相同参数操作」：只放行参数完全相同的同一操作。
  - 「本会话总是允许此类操作」：在本次工作（会话）里，同一工具、同一风险等级的操作自动允许；Shell 命令按命令前缀匹配（如 `pnpm test`、`git commit`；`npm run build` 这类命令会连脚本名一起匹配），只接受不含管道、重定向、变量或多条命令的简单命令。高风险、删除、外部发送、涉及凭据的操作，以及 `sudo`、`curl`、`rm`、`git push`、`npm publish` 等命令，永远不会出现这个选项，也不会被自动批准。生效中的规则显示在工作详情的「详细」页和「隐私与记录」页，可以随时撤销；DeskForge 重启后全部失效。
  - 对特定路径的写入/编辑，可以在设置里创建永久授权，随时撤销。
- **审计**：每次批准、拒绝、执行和模型回合都写入带哈希链的本地审计日志。会话规则自动批准的操作同样记录，结果为「会话规则自动批准」，并附带命中的规则。在「设置 → 隐私与记录 → 查看活动记录」中可以：
  - 按工作、类别、结果、时间范围和关键字筛选；
  - 查看哈希链校验结果（逐条重算哈希，并检查与前一条的链接）；
  - 通过保存对话框导出为 JSON、CSV 或 Markdown（导出内容带 `prevHash` / `entryHash` 和校验结果，并经过脱敏）。

## 项目结构

```
DeskForge/
├── apps/desktop/               Electron 应用
│   ├── src/main/               主进程：IPC、SQLite、策略与审批、任务调度、密钥加密
│   ├── src/preload/            受限的 renderer ↔ main 桥（只暴露白名单通道）
│   ├── src/renderer/           React 界面（引导、对话、设置、检查面板）
│   └── src/workers/            utilityProcess：agent-host（模型与 Agent 循环）、tool-runner（工具执行）
│       ├── provider-compat.ts  各服务商 OpenAI 兼容差异（思考模式、tool_choice、采样参数、旧模型映射）
│       └── agent-host-runtime.ts  pi-ai 运行时、请求守卫、连接测试
├── packages/contracts/         zod schema 与类型：IPC、worker 协议、公共数据结构
├── packages/core/              纯逻辑：路径守卫、风险策略、diff、会话规则、状态机、脱敏、模型错误分类
├── skills/examples/            随应用安装的示例 Skill
├── docs/ROADMAP.md             路线图
└── .github/workflows/ci.yml    CI：push / PR 时运行安装、typecheck 和测试
```

## 开发检查

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm smoke
```

`pnpm smoke` 会先构建，再按当前 CPU 架构为 Electron 重建 `better-sqlite3`，然后以 `DESKFORGE_SMOKE=1` 启动。窗口加载完成后标准输出会出现 `deskforge-ready`，进程随即退出。Linux 上可以用 `xvfb-run -a pnpm smoke`。`better-sqlite3` 不能同时服务系统 Node 和 Electron，所以跑完 smoke 再执行 `pnpm test`，测试的 pretest 会把它重建回 Node。

模型兼容性测试不需要真实 Key：`apps/desktop/src/workers/provider-streaming.test.ts` 会在 127.0.0.1 上启动按各家文档构造的 SSE 夹具服务，直接检查请求体和流式解析结果。

### 打包（未签名）

```bash
pnpm package
```

这会执行 `electron-builder --mac`，并设置 `CSC_IDENTITY_AUTO_DISCOVERY=false`，产物在 `outputs/release/`。当前脚本按 x64 重建 `better-sqlite3`。未签名包会被 Gatekeeper 拦截，需要在「隐私与安全性」里手动放行。签名和公证在路线图的「暂缓」部分。

### 常见失败

- `pnpm install` 没有编译 `better-sqlite3`：确认 `pnpm-workspace.yaml` 的 `onlyBuiltDependencies` 包含 `better-sqlite3` 和 `electron`，然后重新安装。
- Electron 启动时报 `NODE_MODULE_VERSION` 或架构不匹配：说明 `better-sqlite3` 需要按 Electron 重建。`pnpm smoke` 会自动完成；也可以在 `apps/desktop` 下执行 `pnpm rebuild:electron:arm64` 或 `pnpm rebuild:electron:x64`。
- 测试前 pretest 报 `not found: make`：Linux 上需要先安装 `make` 和 `g++`。
- 打开 `.app` 被 Gatekeeper 拒绝：未签名包本来就会这样。开发时用 `pnpm dev`。
- 保存 API Key 时提示系统安全存储不可用：当前环境没有可用的钥匙串加密。请在已登录的 macOS 图形会话里保存，不要改成明文落库。

## 示例 Skills

`skills/examples/workspace-summary`（工作区总结）和 `skills/examples/safe-shell`（安全 Shell 使用说明）会随应用安装到本机的 Skills 目录。它们只作用于当前工作区，并要求 Shell 操作走审批。

## 许可

MIT，见 [`LICENSE`](LICENSE) 和 [`NOTICE`](NOTICE)。
