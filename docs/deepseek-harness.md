# 搭载 DeepSeek Harness（dsh）的方案

> 本文是**联网调研 + 本仓库落地**的合订版：上半写"DSH 自己提供哪几条入口、各自能干什么"，
> 下半写"逻辑阅读器现在走哪条路、哪里补齐了、还差什么"。
> 上游依据取自 npm 上的 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-acp` / `@deepseek-ai/dsh-acp-app` /
> `@deepseek-ai/dsh-llm-deepseek` / `@deepseek-ai/dsh-headless` 包内 README（0.2.0-rc.2），
> 以及官方仓库 <https://github.com/deepseek-ai/deepseek-harness>。

## 1. DSH 是什么

DeepSeek Harness（命令名 **`dsh`**，npm 包 `@deepseek-ai/dsh`）是 DeepSeek 官方的 Agent harness，
自称"**Everything is a Plugin**"：它没有固定的单一形态，而是用 **profile** 描述一套能力 ——
profile 是一个插件包的有序叠加（`dsh-base` + 各形态 bundle + 用户自己的 `cordis.patch.yml`）。
安装：`npm i -g @deepseek-ai/dsh`，验证：`dsh --version`。

## 2. 入口模式（官方 README 原文归纳）

| 命令 | 形态 | 对它来说"是什么" |
| --- | --- | --- |
| `dsh --profile acp` | **ACP stdio 服务**（JSON-RPC，换行分隔） | 给自动化客户端用的常驻服务：建/续/关会话、发提示词、收语义更新、应答权限 |
| `dsh --profile headless "<任务>"` | **一次性任务** | 跑完一个全新会话，把最后一段助手正文打到 stdout，退出 |
| `dsh --profile sdk` / `sdk-minimal` | DSH 自己的 SDK stdio | DSH 私有协议，不是 ACP |
| `dsh web` / `dsh --profile <name>` | Web / 终端等交互形态 | 人机界面 |
| `dsh plugin --profile <name> …` | 插件管理 | 转发给 pnpm |

`web` / `headless` / `sdk` / `sdk-minimal` / **`acp`** 这几个 profile 都是**首次使用时自动初始化**的。

## 3. 对本程序最有价值的两条路

### 3.1 `--profile acp`（长任务、会话、权限都在这条路上）

`@deepseek-ai/dsh-acp`（0.2.0-rc.2）公开的 ACP v1 表面：

| 方法 | 能力 |
| --- | --- |
| `initialize` | ACP v1 + `session/list` / `session/resume` / `session/close` + Streamable HTTP MCP |
| `session/new` | 用**绝对路径**的 `cwd` 建会话，返回完整 `configOptions`（含 `model` 与 `reasoning_effort`） |
| `session/list` / `session/resume` / `session/close` | 列/续/关**持久化**会话（关掉进程再回来还能续） |
| `session/set_config_option` | 改 `model` 或 `reasoning_effort`，返回改完的完整状态 |
| `session/prompt` / `session/cancel` | 一轮提问 / 取消（一个会话同时只允许一个 prompt） |
| `session/update` | 提交后的助手消息与思考、通用工具生命周期、配置变更、上下文用量 |
| `session/request_permission` | 一次性"允许/拒绝"授权询问，客户端可以自动作答 |

明确**不做**的：`session/load`、删除、分叉、附加目录、模式/斜杠命令、计划卡片、终端、客户端文件系统操作、
交互式提问（elicitation）。也就是说 —— 拿它能跑通"读文档 → 提问 → 出结果"，
但拿不到 Codex/Claude 那种"计划审阅卡片 / 工具卡片细节"。

### 3.2 `--profile headless`（只有兜底价值）

`@deepseek-ai/dsh-headless` 的 runner **只从位置参数读任务**（`dsh --profile headless "任务"`）：
没有 stdin 通道、不能选模型/思考强度、只输出最后一段正文、不保留可续的交互。
所以它**不能**承担整篇文档 / 图谱抽取这类长输入 —— Windows 命令行长度上限照样会挡在前面。

### 3.3 密钥

`@deepseek-ai/dsh-llm-deepseek` 注册 `deepseek-official` 路由，密钥的默认来源是环境变量
**`DEEPSEEK_API_KEY`**（`apiKeyEnv` 的默认 credential-ref）。端点默认 `https://api.deepseek.com`；
`DEEPSEEK_BASE_URL` 只被"可信层"采纳（per-launch patch / 用户 profile），
所以**不要把端点指望在子进程环境上**，要改就改 DSH 自己的 profile/settings。

模型目录默认 `deepseek-v4-flash` / `deepseek-v4-pro`；thinking 打开时 `reasoning_effort` 只有
`off` / `high` / `max`，默认 `high`（`low` / `medium` 在服务端被折叠成 `high`）。

> 注意优先级：程序注入的是**进程环境变量**。DSH 通过 credential-ref（默认就是 `DEEPSEEK_API_KEY`）
> 解析密钥，环境变量会盖过它自己配置里的那条 —— 如果你已经在 DSH 自己的 settings / 凭据里配好了
> 密钥（比如指向了另一个网关账号），**不要把本程序里那一行也填上**，否则等于悄悄换了账号。
> 同理，`DEEPSEEK_BASE_URL` 只被 DSH 的"可信层"采纳，本程序不改端点：要换网关请在 DSH 侧配。

## 4. 逻辑阅读器怎么接（现状）

### 4.0 实机验过的事实（本机 DSH 桌面端 0.2.0-rc.2，`D:\DeepSeek Harness`）

> 桌面端自带命令在 `<安装目录>\resources\runtime\cli\bin\dsh.cmd`：
> `ELECTRON_RUN_AS_NODE=1` + `DeepSeek Harness.exe --expose-internals "…app.asar\…\dsh-desktop-host\lib\cli.js"`。
> 本程序现在会**自己找到它**（卸载表的 `InstallLocation` → `resources\runtime\cli\bin`，或
> `HKCU\Software\DeepSeekHarness\Command`、或注册表 PATH），并按"那个 exe + `--expose-internals` + cli.js"
> 启动 —— 不需要用户配路径，也不需要先把 dsh 加进 PATH。

探针 `node scripts/probe-dsh-acp.mjs "<dsh.cmd 路径>"` 的实测输出（`initialize → session/new → session/list`）：

```
initialize ✅ {"protocolVersion":1,"agentInfo":{"name":"deepseek-harness-acp","version":"0.0.1"},
  "agentCapabilities":{"sessionCapabilities":{"close":{},"list":{},"resume":{}},...}}
session/new ✅ sessionId=…
  configOption model [model]             当前=["deepseek-official","deepseek-v4-flash"]  可选=（空）
  configOption reasoning_effort [thought_level] 当前=high  可选=off|low|high|max
session/list ✅ 8 条
```

由此得到三条**必须照着做**的结论：

| 结论 | 依据 |
| --- | --- |
| `model` 的当前值是 **[provider, model] 路由**，而且是以 **JSON 字符串**形态回给我们的 | `String(currentValue)` 打出 `["deepseek-official","deepseek-v4-flash"]` |
| 改模型必须提交**这条 JSON 的字符串**；裸模型名会被拒 | `set_config_option model=deepseek-v4-flash → ✖ unknown model option`；`model='["deepseek-official","deepseek-v4-flash"]' → ✅` |
| `reasoning_effort` 实测可选 `off\|low\|high\|max`（默认 `high`），并且**没有** `providers/list` / 模型枚举方法 | 逐个方法实调；`low`/`medium` 服务端按 `high` 处理，但 dsh 仍然列出来 |

界面只提供"模型名 + 思考强度"两个选择器，路由的 provider 由程序按当前值补上
（`apps/main/src/services/agent/config-value.ts` 的 `encodeConfigValue`）——
用户从任何入口（会话创建 / 中途换模型）改模型，走的都是同一个编码。

```
LogicReader 主进程
  └─ Registry：内置 Agent `dsh` = executable `dsh` + args `--profile acp` + protocol `acp`
       ├─ 会话：AcpSession（apps/main/src/services/agent/session.ts）
       │    ├─ spawn `dsh --profile acp`（stderr 只记日志，stdout 归协议）
       │    ├─ initialize → session/new（或 session/resume）→ 应用 model / thought_level
       │    ├─ prompt → session/prompt；cancel → session/cancel
       │    └─ dispose → session/close（4 秒上限，不拖住退出）→ 关连接 → 杀进程树
       ├─ 历史会话：runtime.listSessions → 临时 ACP 连接问 `session/list`
       └─ 兜底：dsh --profile headless <任务>（只在 ACP 建不起来时用）
```

本轮补齐的四处（都是"字段存在但没接上"或"照着旧版 DSH 写的"）：

| 问题 | 表现 | 处理 |
| --- | --- | --- |
| `agents.env_json` **只落库、不生效** | 用户无法在程序里给 dsh 配密钥 | `resolveEnv`（`apps/main/src/services/agent/env.ts`）把内置默认 + 注册表 `env` 解析成子进程环境；`secret:<key>` 走 safeStorage 密钥库；设置 → Agent 多了一行 DeepSeek API Key |
| CLI 兜底把 ACP 参数一起带上 | 命令行变成 `dsh --profile acp --profile headless …`，dsh 启动器报 `select a profile only once` | `cliLaunchPrefix()` 在回落到 CLI 时摘掉注册表参数（解释器前缀保留），并有单测钉住"只有一个 `--profile`" |
| 兜底模型目录是旧版 DSH 的 | 写着 `deepseek-chat` / `deepseek-reasoner`，在 DSH 上不存在 | 改成 `deepseek-v4-flash` / `deepseek-v4-pro`，思考强度 `off` / `high` / `max`（默认 `high`），见 `fallback-models.ts` |
| ACP 通道没有续聊/收尾 | capability 声称 supportResume，实现里却当没这回事 | 支持 `session/resume`（失败回落新建）、`session/list`（历史会话）、`session/close`（优雅收尾），并把手里的远端会话 id 通过 `session` 事件交给界面 |

## 5. 还需要用户做的事

1. `npm i -g @deepseek-ai/dsh`（装完本程序会在探测时自动发现；也可在 Agent 管理器里手动指路径）。
2. 设置 → Agent → **DeepSeek API Key** 填一次（存进系统加密的密钥库，不写日志）。
3. 首次真正发消息时，`acp` profile 会自动初始化（要下有依赖的包，第一次会慢一点）。

> 装了 **DSH 桌面端**的话，第 1 步可以跳过：桌面端自带的命令本程序会自己找到
> （本机实测路径 `D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`，版本 0.2.0-rc.2）。
> 第 2 步也可以跳过 —— 如果你已经在 DSH 自己那边配好了密钥，就别在这里再填（见上面的优先级说明）。

**自己验证一遍**（不消耗模型额度、也不写文件）：

```powershell
cd D:\逻辑阅读器
node scripts/probe-dsh-acp.mjs "D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
```

## 6. 已知边界与下一步

- **DSH 的 ACP 不提供计划/工具卡片细节**：界面上那些"计划审阅卡片""逐块 diff 回退"是 Claude SDK 通道独有的，
  dsh 走到不了那里（ACP 只给通用工具生命周期）。这是上游协议边界，不是本程序的缺陷。
- **一次性任务（关系图抽取）走 ACP**，所以不受命令行长度限制；只有 ACP 起不来时才会退到 headless，
  此时超过 `ARGV_PROMPT_LIMIT` 的提示词会明确报错，而不是静默失败。
- **可以再做的一步：把"阅读器能力"作为 MCP 工具交给 DSH**。`session/new` 支持 stdio/HTTP MCP 声明，
  程序可以在建会话时挂一个本地 stdio MCP server（例如"取当前选区/按锚点跳转/按关键词检索文档"），
  让 dsh 不必读整篇也能定位原文。这属于产品级新功能，需要先定工具清单与授权边界。
- **图片/多模态**：ACP 的图片提示词要求"持久附件存储 + 精确路由支持"，本程序目前只发纯文本，
  扫描版 PDF 的 OCR 也就还没到那一步。
- **模型清单没法从 ACP 枚举**：dsh 的 `model` 项"可选值"是空的，也没有 `providers/list` /
  模型枚举方法。程序现在用的是兜底的官方目录（`deepseek-v4-flash` / `deepseek-v4-pro`）+ 当前路由里的
  provider；如果用户在 dsh 的 settings 里换了目录（例如接自己的网关），改模型时可能会撞
  `unknown model option` —— 那时以 dsh 侧为准，我们只能把它记进日志（`setConfigOption` 的 warn）。
