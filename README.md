# DeskForge

本地优先的 macOS 桌面工作 Agent。界面跑在沙箱里，审批、策略和密钥留在主进程，模型调用和工具执行分别放在独立进程。文件和 Shell 只作用于你选中的工作区，授权根默认不会设成磁盘根目录 `/`。

DeskForge 是独立项目，不是 WorkBuddy，也不是腾讯的产品。桌面实现改编自 [OpenWorkbuddy](https://github.com/chenin0931/OpenWorkbuddy)（MIT，Copyright (c) 2026 OpenWorkbuddy contributors），详见 [`NOTICE`](NOTICE)。

DeskForge is an independent local-first macOS work agent. It is not WorkBuddy and it is not a Tencent product.

- 路线图：[docs/ROADMAP.md](docs/ROADMAP.md)
- 参与开发：[CONTRIBUTING.md](CONTRIBUTING.md)
- 手动验收清单：[docs/TESTING.md](docs/TESTING.md)

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

## MCP 连接

在「设置 → MCP 连接」（或「资料库 → 连接」）里可以添加、编辑、删除、启用或停用 MCP Server。

- **stdio**：填写启动命令、参数（按空格分隔，含空格的参数加引号）、环境变量和工作目录。
  - 工作目录有三种：「独立目录」（默认，每个 Server 一个空目录，位于应用数据目录的 `mcp-servers/<id>`）、「当前工作区」（在任务所在的工作区里运行，没有工作区时拒绝启动），以及「指定文件夹」。指定的文件夹必须是通过「选择文件夹」对话框选的，或者位于已授权的工作区内；不能是磁盘根目录或个人主目录。启动时会重新解析路径，被替换成软链接的目录会被拒绝。
  - Server 进程继承的系统环境会先去掉名称含 `TOKEN`、`SECRET`、`API_KEY`、`PASSWORD`、`COOKIE` 等的变量，再加上你配置的环境变量；DeskForge 的模型 Key 不在环境变量里，也不会传给它。`LD_*`、`DYLD_*`、`NODE_OPTIONS` 等能改变加载行为的变量不允许设置。
  - stdio Server 以当前系统用户身份运行，**不是沙箱**，只添加你信任的命令。
- **Streamable HTTP**：填写 Server URL（必须是 HTTPS；只有 `localhost` / `127.0.0.1` 允许 http）、普通 Header 和认证方式（无、Bearer Token、自定义加密 Header、OAuth）。勾选「旧版 SSE 兼容」后，如果服务器对 Streamable HTTP 返回 4xx（401/403 除外），会改用 SSE 传输重试一次。
- **密钥**：环境变量和 Header 每一行都有「加密保存」选项。勾选后，值用 Electron `safeStorage` 加密存进本机数据库，配置里只保留名称；界面不会回显，编辑时留空表示保留原值。名称像密钥（含 `TOKEN`、`SECRET`、`API_KEY`、`PASSWORD`、`Authorization` 等）却没有勾选时，保存会失败并提示「请勾选加密保存」。连接错误里出现的密钥值会被替换成 `[REDACTED]`；审计日志只记录密钥名称，不记录值。
- **测试连接**：会真正启动或连接 Server，列出发现的工具，并显示连接方式（stdio / Streamable HTTP / SSE）、耗时和版本。每个工具都可以单独停用；停用的工具不会出现在 Agent 的工具列表里，调用会被直接拒绝。
- **审批**：`mcp_list_tools` 是只读操作，自动执行。`mcp_call_tool` 属于 `external_side_effect`，**每次调用都要你批准**，不提供「本工作相同参数」和「本会话总是允许」两种范围，也不会被会话规则自动放行。Server 自己声明的 `readOnlyHint` 等标注只作展示，不影响审批。

示例：本地文件检索（stdio）和团队知识库（HTTP）。界面表单最终提交的就是这种结构；本地能力包里的 `mcp/*.json` 也用同样的格式，但不能包含 `id`、`secrets`、自定义工作目录或需要密钥的认证，这些要在安装后到设置里补充。

```json
[
  {
    "name": "本地文件检索",
    "enabled": true,
    "toolNamespace": "files",
    "transport": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "env": { "LOG_LEVEL": "info" },
      "envKeys": [],
      "cwdMode": "workspace"
    }
  },
  {
    "name": "团队知识库",
    "enabled": true,
    "toolNamespace": "kb",
    "transport": {
      "type": "streamable_http",
      "url": "https://kb.example.com/mcp",
      "auth": "bearer",
      "headers": { "x-team": "office" },
      "secretHeaderKeys": ["x-api-key"],
      "sseFallback": true
    }
  }
]
```

上例中 Bearer Token 和 `x-api-key` 的值在界面里填写，只以加密形式保存，不会出现在配置 JSON 中。

## 导入 Skill

在「资料库 → 技能」里导入、更新、启停和移除 Skill。

- **从文件夹导入**：选择根目录包含 `SKILL.md` 的文件夹。
- **从 Git 导入**：填写仓库地址，可选分支 / 标签和子目录（如 `skills/weekly-report`）。
  - 只接受公开的 `https://` 地址；`git@`、`ssh://`、`file://`、带用户名或令牌的地址、本机和内网地址都会被拒绝。
  - DeskForge 用 `git clone --depth 1` 浅克隆到临时目录，并关闭 Git 钩子、子模块、LFS 下载、凭据助手和交互式登录，只允许 HTTPS 协议。子目录不能包含 `..`、绝对路径或软链接。
- **先预览再安装**：预览列出名称、版本（更新时显示旧版本 → 新版本）、来源（Git 会记录 commit）、权限声明、全部文件（脚本单独标出）和提醒。确认前不会安装；确认时会重新校验文件指纹，预览后有改动就要求重新预览。导入只复制文件，**不会执行任何脚本**。
- **校验**：`SKILL.md` 必须以 YAML frontmatter 开头，包含 `name`、`description` 和非空正文。任何位置的软链接、设备文件、单个超过 10 MB 或总计超过 50 MB 的内容都会被拒绝，错误信息为中文，例如「Skill 包不能包含符号链接：references/leak.txt」「SKILL.md 缺少 name」。
- **更新**：从文件夹或 Git 导入的 Skill 可以「更新」，即按记录的来源重新导入。名称必须不变，启用状态保持不变。内置 Skill 随应用更新。
- **移除**：移除只删除 DeskForge 里的副本，不影响原文件夹或仓库。移除的内置 Skill 不会在下次启动时自动装回。

## 会话管理

- **搜索**：侧栏搜索框同时检索会话标题和对话正文（用户和助手消息），中英文都可以。底层是 SQLite FTS5 的 `trigram` 分词：三个字符以上的词走全文索引，「周报」这类两个字的词自动改用 LIKE 匹配。结果显示命中片段，并只列出当前工作区的会话。多个词需要同时出现在同一条标题或消息里。
- **重命名**：会话标题栏的「重命名」按钮，新名称同步到侧栏和搜索。
- **删除**：已结束的会话可以删除，需二次确认；审计日志不受影响。
- **导出 Markdown**：标题栏「导出为 Markdown」打开保存对话框，导出内容包括元信息、计划步骤、对话、工具调用摘要表（时间、工具、风险、状态、参数摘要、结果）、审批记录（结果、范围、外发数据）、引用来源、产物和验证结果，不含工具的完整输出。导出前会脱敏：已配置的模型 Key、MCP 密钥 / OAuth 令牌和向量接口 Key 按原值替换为 `[REDACTED]`，另外按形态识别 `sk-…`、`Bearer …`、GitHub / AWS / Slack 令牌、JWT、私钥块、URL 中的密码、`password=` 等。

## 本地知识库

「设置 → 本地知识库」为每个授权工作区建立本地全文索引，供你和 Agent 检索。

- **建立 / 增量更新 / 重建 / 清除**：第一次点「建立索引」；之后「增量更新」只处理变化的文件（先比较大小和修改时间，再比较 SHA-256），并移除已删除或新加入 `.gitignore` 的文件；「完全重建」清空后重来；「清除」只删除索引文件。
- **存储位置**：应用数据目录下的 `knowledge/<工作区 ID>.sqlite3`，不会在工作区里写任何文件。移除工作区授权时一并删除。
- **索引范围**：沿用 `file_search` 的规则——遵守各级 `.gitignore`，跳过 `.git`、`node_modules`，不跟随符号链接（读取前再校验真实路径仍在工作区内），跳过二进制和超过 1 MB 的文本，单个工作区最多 5000 个文件。`.env`、`*.pem`、`*.key`、`id_rsa`、`.npmrc`、`credentials.json` 等敏感文件永远不索引。支持 Markdown、纯文本、常见代码和配置文件，以及 `.docx`（内置轻量解析）；PDF 暂不支持。
- **Agent 工具 `knowledge_search`**：只读、无需审批，默认对 Agent 可用。返回按相关度排序的片段，附 `路径:起始行-结束行` 引用，可按路径前缀过滤（如 `docs/`）。设置页也有检索框，可以直接试。

## 向量检索（可选）

「设置 → 向量检索」可以配置 OpenAI 兼容的 Embeddings 接口，让知识库用「关键词 + 向量」混合排序（RRF 融合）。不配置时知识库照常工作。

| 预设 | 接口地址 | 模型 |
| --- | --- | --- |
| 通义 DashScope（推荐） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `text-embedding-v4`（默认 1024 维）/ `text-embedding-v3` |
| OpenAI | `https://api.openai.com/v1` | `text-embedding-3-small` |
| 自定义 | 任意 OpenAI 兼容地址（必须 HTTPS，本机回环地址除外） | 自填 |

- **默认关闭**。启用时会弹窗确认：建立或更新索引时，**工作区文档片段（含相对路径）会发送到所配置的服务**；每次检索（包括 Agent 调用 `knowledge_search`）的**检索词**也会发送。每次发送都会写入审计日志。关闭后立即停止发送。
- **API Key** 用 `safeStorage` 加密保存，只在主进程使用，不会传给渲染进程或 Agent worker。「测试连接」只发送一句固定文本。
- 向量以 Float32 BLOB 存在同一个索引文件中，检索时暴力计算余弦相似度。更换模型或维度后，下次更新索引会重新生成向量；接口出错时自动回退为关键词检索并给出提示。

## 项目结构

```
DeskForge/
├── apps/desktop/               Electron 应用
│   ├── src/main/               主进程：IPC、SQLite、策略与审批、任务调度、密钥加密、MCP 与 Skill 导入、本地知识库
│   ├── resources/skills/       内置 Skill
│   ├── src/preload/            受限的 renderer ↔ main 桥（只暴露白名单通道）
│   ├── src/renderer/           React 界面（引导、对话、设置、检查面板）
│   └── src/workers/            utilityProcess：agent-host（模型与 Agent 循环）、tool-runner（工具执行、MCP 客户端）
│       ├── provider-compat.ts  各服务商 OpenAI 兼容差异（思考模式、tool_choice、采样参数、旧模型映射）
│       └── agent-host-runtime.ts  pi-ai 运行时、请求守卫、连接测试
├── packages/contracts/         zod schema 与类型：IPC、worker 协议、公共数据结构
├── packages/core/              纯逻辑：路径守卫、风险策略、diff、会话规则、状态机、脱敏、模型错误分类、MCP 配置校验、FTS 查询与混合排序、会话导出
├── skills/examples/            示例 Skill（与内置 Skill 相同，可作为编写模板）
├── docs/ROADMAP.md             路线图
├── docs/TESTING.md             M1–M4 手动验收清单（macOS）
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

下面这些 Skill 随应用安装（源文件在 `apps/desktop/resources/skills/`，`skills/examples/` 里有同样的副本），都只读写当前工作区和任务附件，不联网：

| Skill | 用途 |
| --- | --- |
| `weekly-report` | 从日报、待办、会议记录里整理周报 / 日报，每条可追溯到素材 |
| `meeting-minutes` | 把转写稿或速记整理成会议纪要，提取决议、待办（负责人、截止时间）和未决问题 |
| `document-key-points` | 提取合同、制度等文档的要点和风险提示，标注原文出处（不构成法律意见） |
| `spreadsheet-summary` | 按维度汇总 CSV / TSV 数据并做总计核对；数据量大时只用 Python 标准库脚本，运行需批准 |
| `repo-overview` | 只读浏览代码仓库，输出技术栈、结构、入口和上手建议 |
| `workspace-summary` | 总结当前工作区的目录、关键文件和近期变化 |
| `safe-shell` | 说明如何在工作区内安全使用 Shell |

## 许可

MIT，见 [`LICENSE`](LICENSE) 和 [`NOTICE`](NOTICE)。
