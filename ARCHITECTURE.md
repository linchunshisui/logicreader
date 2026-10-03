# ARCHITECTURE · 稳定约定与不变量

> 这份文件是**长期记忆**：记录那些"推翻重写之后定下来、后续改动必须遵守"的结构性约定。
> 与 [避坑指南.md](避坑指南.md) 的分工：避坑指南讲"踩过什么坑"，本文讲"现在的地基长什么样"。
> 与 [执行记录.md](执行记录.md) 的分工：执行记录讲"每一轮做了什么"，本文只保留仍然成立的部分。

---

## 0. 一句话地图

```
PDF 内容流（矢量）
   └─ lib/pdfVectorText.ts      纯函数：文本项 → 行 → 段 → 块 + 逐项字符偏移 + 几何
        ├─ parsers/pdf.ts                    产出 Block[] 与 meta.textLayerMapping（落库）
        ├─ lib/pdfTextLayer.ts               文本层渲染：调用官方 pdf.js TextLayer（复刻其运行环境），只补 dataset 字符偏移
        └─ lib/textLayerMapping.ts           持久化/校验映射（版本 + 文本指纹）
DOM 选区
   └─ lib/selection.ts           几何端点回退 + 内容对齐（locateSelectedText）
        └─ lib/readerSelection.ts 四种阅读器共用的选区 Hook + 元素对齐
启动
   └─ apps/main/src/index.ts     启动期日志 + 同一次启动内的自动恢复（无自我提权路径）
跳转（图节点/连线、目录、查找、标注列表）
   └─ state/ui.store.ts          requestReveal({ docId, charStart, charEnd })
        └─ lib/revealRequest.ts  共用消费器：等目标内容就绪再落地（按需挂载的阅读器必须走它）
             └─ views/reader/*   各自把"区间"变成"滚动 + 1.6 秒高亮"
```

---

## 1. 不变量（改代码前先确认不会破坏它们）

### 1.1 文本层与字符偏移
| 不变量 | 判据 | 测试 |
| --- | --- | --- |
| 每一项的偏移能切出自己的原文 | `pageText.slice(off, off+len) ≈ item.str`（忽略空白折叠） | `tests/pdf-text-mapping.test.ts` |
| 矢量布局与字形同源 | `line顶 + ascent×scale == 基线×scale`（误差 < 0.05px）——**几何只在 `pdfVectorText` 里算**，DOM 文本层不参与 | `tests/pdf-text-mapping.test.ts` |
| 文本层位置交给官方实现 | `lib/pdfTextLayer.ts` 复刻 `.textLayer` 类名 + `--scale-factor`/`--total-scale-factor` + 视口尺寸后调 `new TextLayer(...).render()`；**我们只写 `dataset.charStart/charEnd`**，不写 left/top/font-size | `tests/pdf-parser-consistency.test.ts` |
| 偏移与缩放无关 | 1×/1.5×/3× 下 `itemOffsets` 逐字节相同 | `.probe-vector.mjs`（离线脚本） |
| 跨页偏移是**全文绝对**偏移 | 页首基址 = 各页文本长度累加 | `tests/pdf-parser-consistency.test.ts` |

### 1.2 选区
| 不变量 | 说明 |
| --- | --- |
| 以内容定区间 | `locateSelectedText` 唯一定位优先；片段并集与 DOM 端点只作降级 |
| 端点按方向回退 | 起点向后、终点向前找最近的可定位元素 |
| 判据是"选区在不在正文里" | 不是"鼠标在哪松手"；监听挂 `document` |
| 幂等 | 区间与已存选区一致时直接返回（否则与"恢复原生选区"死循环） |

### 1.3 派生数据
- **必须能自证**：任何持久化的派生数据（映射 / 锚点 / 缓存）在使用前抽样校验，不通过就整批丢弃并现算。
- **必须带版本**：改算法也要 +1，不能只靠"文本指纹"（文本没变、算法变了同样会错）。
- **坐标与内容同源**：不允许"位置来自 A 份数据、文字区间来自 B 份数据"。

### 1.4 跨视图定位（跳转）
| 不变量 | 判据 |
| --- | --- |
| 定位请求必须**等到内容就绪** | 阅读器标签是按需挂载的（`EditorArea` 只渲染当前标签），跳转到达时 PDF 还在异步加载、DOCX 还在渲染 —— 一次性消费必然落空且不报错。统一由 `lib/revealRequest` 在时间窗口（默认 6s）内重试，`apply` 返回 false 就再来一轮 |
| 同一请求**只消费一次** | 按**对象身份**判重（不用时间戳比较），否则每次切回阅读器标签都会重放上一次跳转 |
| 定位不到必须留痕 | 超时写 `warn` 日志 `定位请求未落地`，不允许静默失败 |
| **跳转必须由用户显式触发** | 画布上单击节点/连线**只选中、不跳转**（跳转会切到阅读器标签，单击即跳会把浏览图的动作反复打断）。跳转入口只有检查器里的「跳转」按钮，它调用唯一的 `jumpToAnchor`；双击节点只负责展开/折叠 |
| 有跳转入口就必须有反馈 | 无锚点 / 锚点失效 / 文档不可用各给一句明确提示；成功后在状态栏显示落点（`graph.jumpedTo`） |
| **落点必须是"人能看懂的一段"** | 显示前用 `expandRevealRange` 收拾区间：边界落在拉丁词内部就补到词边界、去掉两头空白（**锚点本身不动**）。中文不扩（没有词间空格）。实际应用的区间写进 `data-reveal-range`，可被断言 |
| 关系图跳转的高亮**常驻** | 请求上带 `hold`：直到下一次跳转或 `clearReveal()`（关面板）才收起；目录/查找/标注列表仍是 1.6 秒 `lr-flash` |
| 跳转要给出**局部上下文** | 文段旁并排 `GraphChainPanel`：被跳转节点的一度关系（指向它/由它指向），点任一条继续追；「在关系图中查看」回到图上居中并选中 |

### 1.5 论文与关系图的绑定、命名
| 不变量 | 判据 |
| --- | --- |
| **关论文 → 连它的图一起关** | `tabs.store.closeTab` 只从 `reader` 出发收集同 `docId` 的 `graph`（跨编辑组/分屏同样覆盖）；单测 `tests/tab-binding.test.ts` |
| **关图 → 不动论文** | 反向不收集；关掉后由 `CMD.graphShow` 调回来，论文始终在 |
| 调取入口只有一条实现 | 侧边栏「显示关系图」/ 视图菜单 / `Ctrl+Shift+L` / 命令面板 → `CMD.graphShow` → `openGraphTab` |
| 图的名字只有一个来源 | `<文档名> · 逻辑关系图`：渲染进程 `lib/graphName.ts`（标签标题、导出默认文件名），主进程 `graphDisplayTitle`（落库标题、Markdown H1）同一规则；文档名拿不到时用落库标题兜底（旧图缺后缀会自动补）。**落库要真的落**：`graphs.title` / `graphs.doc_hash` 由 `store.service` 持久化，否则"只恢复了关系图标签"时名字会退化成光秃秃的"逻辑关系图" |

### 1.6 送给 Agent 的选区文本
| 不变量 | 判据 |
| --- | --- |
| **选区文本必须完整** | 拼问题用的是整段选区（`lib/askPreset.ts`）；超过 8000 字才截断，且要说明"以上为前 N 字"与完整内容在哪；上下文没带完整引用时不许声称"见【引用原文】" |
| 动作名只认 `agent.preset*` | 不用 `cmd.*`（那是命令面板的文案），更不能用**不存在的键** —— i18next 缺键会**原样返回键名**，问题文本里就会冒出 `agent.translateSelection：`（本轮的真实故障） |
| UI 与冒烟共用同一个拼装函数 | `askFlow.selectionQuestion` —— 冒烟断言的就是用户点按钮时发出去的那段文本；判据 `smoke.askPayload`（问题与上下文都含完整选区 + 无裸露文案键） |

### 1.7 人工编辑关系图
| 不变量 | 判据 |
| --- | --- |
| 手工连线必须**真的能连** | 画布传 `onConnect`（只挂把手是不够的 —— React Flow 会把没人接住的连接丢掉，且不报错）；`state/graphEdits.canLinkNodes` 定规则：不许连自己、同方向不重复、反向允许 |
| 拖拽中与松手后**同一套规则** | `isValidConnection` 与 `onConnect` 都调 `canLinkNodes`，不允许"拖的时候能连、松手被拒" |
| 人工数据要**留痕** | 新建连线带 `meta.manual = true` 与依据锚点（取起点节点的原文位置，没有就留空，跳转会明确提示"无原文依据"）；与节点 `pinned` 同一思路，重生成时不被抹掉 |
| 规则与界面分离 | 判定与构造是纯函数（`graphEdits.ts`，有单测），store 只做持久化，画布只做交互 |

### 1.8 启动：标准用户（非管理员）必须能跑
| 不变量 | 判据 |
| --- | --- |
| 程序自身绝不请求管理员权限 | `LogicReader.exe` 清单里 `requestedExecutionLevel=asInvoker`；`electron-builder.yml` 的 `win.requestedExecutionLevel` 不得改成 requireAdministrator |
| 安装默认按用户进行 | `nsis.perMachine: false` → 装到 `%LOCALAPPDATA%\Programs\LogicReader`，不需要管理员 |
| 首次双击即可用 | 渲染进程失败时在**同一次启动内**完成恢复，不需要"再打开一次"，更不需要右键以管理员身份运行 |
| 恢复只动启动开关 | 只改 `webPreferences.sandbox` / 命令行开关 / 窗口重建，不触碰任何业务逻辑 |
| **不存在自我提权路径** | 代码里不得再出现隐藏窗口调 PowerShell / `Start-Process -Verb RunAs` / `requireAdmin`：它既是安全软件判高危的行为模式，也是标准用户启动失败后的错误兜底（标准用户本来就能跑） |
| **绝不停留在提权令牌下** | 启动时用 `whoami /groups` 的完整性级别 SID 判提权（`S-1-16-12288`/`16384`；**不要**用裸磁盘/SAM 探测），提示后用 `explorer.exe` 以普通权限重开自己并退出；重开一次仍提权时写 `elevate-retry.json` 标记、不再重开（防成环）。提权实例会独占 `userData/lockfile`，使之后所有非管理员启动在 Chromium 阶段静默失败（无窗口、无日志） |

---

### 1.9 Agent 面板与授权模式
| 不变量 | 判据 |
| --- | --- |
| 面板只有**两副面孔** | 空会话 = 居中品牌块 + 底部输入区；有对话 = 紧凑消息流（思考行 / 工具行 / 正文）+ 贴底输入区。冒烟 `AGENT_UI_OK.empty` 与 `.lr-agent__welcome` 的存在性必须一致 |
| 思考与工具调用**收成一行** | 默认折叠（`.lr-thinking` / `.lr-toolrow`），点开才展开原始报文；一屏要能看完整轮过程 |
| 输入区是**卡片**，不是贴边文本域 | 状态行 / 模型 / 思考强度 / 授权模式都在卡片内；弹层锚在卡片**上方**（`bottom: calc(100% + 6px)`），不许盖住控件行 |
| 授权模式只有一份判定 | `packages/shared/permissions.ts` 的 `decidePermission`；主进程（权限往返、写文件通道）与渲染进程（自动应答）都调它 —— **两侧不许各写一套 if** |
| 授权档位是**能力位**，不是后门 | `manual` / `plan` 与设置里的 `allowWrite` / `allowExecute` 一致（默认全关）；`edit` 额外放行工作区内写入；`auto` 额外放行"安全检查通过"的命令 |
| **切档必须换会话** | 写权限在 ACP 握手时就声明过了，已建立的会话改不回来；`setPermissionMode` 必须 dispose 旧会话。判据：冒烟报告 `sessionRebuilt:true`，`main.log` 里下次会话带 `授权模式=<新模式>` |
| 自动放行必须留痕 | 每次自动放行/拒绝都写 `main.log`（`权限自动放行（<模式>）：<理由> :: <证据>`）；渲染进程侧自动应答另在消息流里留一条安静提示 |
| 写入边界是**拒绝**而不是询问 | 走到授权判定的写请求：目标越出工作区或含 `..` → 连授权卡片都不弹，直接拒绝（省得用户以为"点允许就能写外面"）。**另有第二条通道**：ACP 的 `fs/write_text_file` 按**会话创建时协商的能力位**（`canWrite`）判定 —— 会话允许就直接写，且**不再叠加**全局白名单（否则"自动档"会被静默阉掉，这是刻意的取舍） |
| 危险命令一律转人工 | 命中危险列表（`rm -rf`、`del /s`、`--force` 推送、管道执行远程脚本…）时，即使 `auto` 也弹卡片 |
| 工具的调用与结果必须**同 id** | 适配层（含 mock）要给 `tool-call` / `tool-result` 传同一个 id；否则界面永远停在"进行中"（不报错，只是永远转圈） |
| 模式随快照恢复，且**只向保守回退** | 旧快照缺 `permissionMode` 时回落 `manual`，绝不"继承"一个更宽的授权 |
| 换 Agent = **换通道**：先释放旧会话 | `selectAgent` 必须先 `sessionDispose` 旧会话（SDK / app-server 都是**常驻**子进程，只把 sessionId 置空会留下一个不走的进程），再清掉会话态（消息 / 模型清单 / 命令 / 历史）—— 新通道没有旧会话的上下文，界面留着旧对话就是"答非所问"。旧会话仍在各自的持久化里（历史会话可续） |
| 一键对切只给 **Claude Code ↔ Codex** | 两者是本工程的对标通道，来回比对是常态；按钮**只在对方可用时**出现（点了报错比不给更糟），切换后自动消失。其它 Agent（DSH / Gemini / 自建）只在 Agent 选择器里出现 |

---

### 1.10 Agent 接入：官方 SDK 通道（Claude Code 的唯一路径）

| 不变量 | 判据 |
| --- | --- |
| Claude Code **只能**走官方 SDK | 注册表里 `kind === 'claude-code'` → `protocol: 'sdk'` → `SdkAdapter`；自研 ACP 客户端只留给支持 ACP 的其它工具 |
| SDK 是 ESM-only，必须动态加载 | 主进程产物是 CJS：`electron.vite.config.ts` 把 `@anthropic-ai/claude-agent-sdk` 及其平台子包列为 external，运行时用 `import()`（`loadSdk()`）。静态 import 或内联打包都会在启动时炸 |
| **必须** `settingSources: ['user']` | 用户的 Claude Code 可能指向第三方代理（`~/.claude/settings.json` 的 `env` 块）。传 `[]` 会丢掉鉴权与模型映射，表现为 `Not logged in · Please run /login`（本轮实测踩过） |
| 权限判定仍只有一份 | SDK 的 `canUseTool` → `runtime.decideSdkPermission` → `@logicreader/shared/permissions` 的 `decidePermission`；**只在需要授权时**被调用（读文件、cwd 内只读命令不会来），因此它不能当审计钩子 |
| 档位切换走控制通道 | `setPermissionMode()` 可在**活动会话**上直接切换（自研 ACP 把权限写死在握手时，切档必须重建会话；SDK 没有这个限制） |
| 原生 CLI 必须在 asar 外 | 打包时由 `scripts/copy-claude-cli.mjs` 复制到 `resources/claude-cli/`（extraResources），运行时优先从 `process.resourcesPath` 解析；asar 里的可执行文件起不来，pnpm 的子包路径还带哈希 |
| 工具调用与结果同 id | `tool-call` / `tool-result` 共用 `tool_use_id`（SDK 的 `assistant.tool_use.id` 与 `user.tool_result.tool_use_id`） |
| 日志要能判"是不是登录问题" | 错误 result 的 **`subtype` 仍是 `success`**，必须看 `is_error`：只判 subtype 会把"未登录"当成成功 |


### 1.10b Agent 接入：Codex 官方 app-server 通道（Codex 的首选路径）

| 不变量 | 判据 |
| --- | --- |
| Codex **优先**走官方 `app-server` | 注册表里 `kind === 'codex'` → `protocol: 'app-server'` → `CodexAdapter`；只有 app-server 起不来（CLI 太老）才回落一次性 CLI（此时能力里的协议必须是 `cli`，否则 `createAdapter` 会去建一个起不来的会话） |
| 与 VS Code 扩展**同一条路** | `codex app-server`（stdio + 换行分隔 JSON-RPC 2.0）就是 Codex 扩展用的控制通道；协议字段以官方 `codex app-server generate-json-schema` 导出的 schema + 本机实测报文为准 |
| 报文只翻译，不做策略 | `translateCodexNotification` 是**纯函数**（单测直接喂实测报文）；审批走 `options.requestPermission` → `runtime.requestPermission` → `decidePermission`，与 Claude / ACP 共用同一份判定 |
| 审批请求必须**原样回执** | `item/commandExecution/requestApproval` 的 `availableDecisions` 会在字符串与单键对象之间变化（`{acceptWithExecpolicyAmendment:{...}}`）；卡片 id 用 app-server 的原值，映射回去时对象形态要还原。不认识的服务器请求回 JSON-RPC error，**不许猜形状** |
| 模型与思考强度是**逐回合参数** | `turn/start` 的 `model` / `effort`；`setConfigOption` 只改本地状态，不需要重开进程（对比 CLI 兜底通道：改模型要重开） |
| 中断用 `turn/interrupt` | 传 `{threadId, turnId}`，模型侧知道被中断；CLI 兜底通道只能杀进程树 |
| 会话生命周期：一个会话一个常驻进程 | 建会话时 `thread/start`（续聊 `thread/resume`、分叉 `thread/fork`，失败回落新建并留日志）；`dispose()` 关客户端 + 杀进程树 |
| 历史线程与 VS Code **同源** | `thread/list` 读的是 Codex 自己持久化的 rollout 记录（`~/.codex/sessions/...`），按 `cwd` 过滤；`updatedAt` 是**秒**，界面按毫秒消费 |
| 斜杠命令 = 技能 | Codex 侧的名称是 `skills/list`；界面只展示与补全，不硬编码 |
| 拿不到就如实报错 | 缺二进制 / 握手失败 → 能力标不可用并带上原因，日志可查。`resolveCodexExecutable` 的优先级：**用户配置 > PATH > VS Code 扩展自带**（`<ext>/bin/<platform>-<arch>/codex.exe`，只在前面都拿不到时才用）；内置注册项的 `executable` 是裸命令名 `codex`，所以"扩展自带"这条是 PATH 解析失败时的兜底，不是首选 |


### 1.11 文件改动：基线、差异、检查点

| 不变量 | 判据 |
| --- | --- |
| "改之前"必须从 **PreToolUse hook** 抓 | 载荷是 { tool_name, tool_input: { file_path, content }, tool_use_id }（本机实测），路径在 tool_input.file_path；解析逻辑抽成纯函数 baselinePathOf 并单测 |
| 差异由**主进程**算、结构化下发 | packages/shared/diff.ts 的纯函数；主进程只发 tool-diff（hunk + 计数），渲染进程只渲染 |
| 检查点 id 用 assistant.user_message_uuid | **不要**开 replay-user-messages（会回放别的会话的消息，见避坑指南 §5.13） |
| 回退先预演再执行 | 按钮先 rewindFiles(id, { dryRun: true }) 看会动哪些文件，再真回退；两步都写日志 |
| 只读工具不进权限回调 | allowedTools 放 Read/Glob/Grep/WebFetch/WebSearch/ToolSearch/TodoWrite/Task；canUseTool 只在写/执行时出现，卡片不会淹没在只读操作里 |
| 差异算不出来不许变成错误 | 文件太大/二进制 → 跳过（truncated），工具卡片仍显示正常状态 |


### 1.12 命令与会话：交给 CLI，不自己维护

| 不变量 | 判据 |
| --- | --- |
| 斜杠命令**只从 CLI 取** | Claude 侧是 `initializationResult().commands`（65 条，含用户技能），Codex 侧是 `skills/list`；界面不硬编码命令表、不长期缓存 —— CLI 一升级，写死的表就会"少半截命令" |
| 斜杠命令**就是一条用户消息** | 实测发 `/context` 即执行（返回结构化的上下文占用）；不需要额外的控制通道 |
| 历史会话与 VS Code 同源 | `listSessions(dir, limit, agentId)`：Codex 走 `thread/list`，其余走 CLI 自己持久化的会话记录；两者都按项目目录隔离 |
| 续聊靠重建会话 | 选历史会话 → 关掉当前会话 → 下次 `sessionCreate` 带 `resume`；不要试图在活动会话上"切换历史" |
| 历史列表按目录过滤 | 没有打开文档时目录为空、列表为空是**有意**的（不混项目）；跨项目需要显式开关 |


### 1.13 @ 文件引用：候选必须来自**会话真正的工作目录**

| 不变量 | 判据 |
| --- | --- |
| 候选根目录 = 会话工作目录 | 界面通过 `agent:workdir`（= `runtime.workdirFor`）取，不自己拼路径；否则会出现"界面列的文件 Agent 读不到" |
| 索引遵守用户的 gitignore 设置 | 读 `~/.claude/settings.json` 的 `respectGitIgnore`（本机 true）；固定跳过 `node_modules`/`.git`/`dist`/`release` 等 |
| 索引有硬上限 | 4000 文件 / 8 层 / 单文件 2MB / 缓存 30 秒 —— 输入 `@` 的每次按键都会查 |
| 只索引路径，不读内容 | 读内容是 Agent 的 Read 工具的事（它有权限与行号语义） |
| 空候选要解释原因 | 没打开文档 → 工作区是隔离空目录，面板必须写清"先打开一个文档"，不能给一个空白弹层 |


### 1.14 计划模式与计划审阅

| 不变量 | 判据 |
| --- | --- |
| 方案文字来自**助手正文** | `ExitPlanMode` 的入参是空的（实测 `{}`）；适配层缓冲本轮正文，`plan-review` 事件带上它 |
| `ExitPlanMode` 不是写操作 | 它必须走人工审批；任何"按写操作拒绝"的策略都会让计划永远批不了（本轮实测踩到） |
| 策略只判一次 | SDK `canUseTool` 判定"交人工"后，桥接层用 `userDecisionRequired` 直接进人工流程，**不再算第二遍** |
| 批准 = 放行 + 换档 | `approvePlan()` 放行 `ExitPlanMode` 并把档位切到 `edit`（与 VS Code 的批准语义一致）；拒绝则留档继续改方案 |
| 计划模式只读由 CLI 保证 | plan 档下 CLI 自己把写入挡在回调之前；我们要做的是别把它拒成"不能批准" |


### 1.15 逐块回退

| 不变量 | 判据 |
| --- | --- |
| 回退 = 反向打补丁，不是写回基线 | 用 `revertHunks(before, after, current, hunks, indices)` 重建"保留未回退块"的版本；写回基线会把其它块一起抹掉 |
| 冲突时**不写盘** | 当前磁盘内容 ≠ 改动后内容 → 说明之后又被改过，报冲突并把原因带回界面 |
| 基线要有保留上限 | 只留最近 20 次改动（长会话不能把整份文件历史攒在内存里） |
| 回退后更新记录 | 回退成功就把该次改动的"改动后"换成新内容，否则第二次回退会误判冲突 |


### 1.16 子代理可观测性

| 不变量 | 判据 |
| --- | --- |
| 归属靠 `parent_tool_use_id` | 子代理的调用与主线程**共用同一个消息流**；适配层逐条记录它并给 `tool-call` 打 `parentId`，界面据此折叠 |
| 归属**不许粘住** | 下一条 `parent_tool_use_id: null` 的消息必须把归属清掉，否则主线程调用会被误归到子代理名下（已单测） |
| 主对话保持干净 | 主线程调用逐条列出；同一子代理的调用挤成一行（`子代理 · N 步 · 当前动作`），点开才展开 |
| 状态来自工具本身 | 运行/失败取该子代理内部调用的 `state`，不另设状态机 |


### 1.17 会话：续聊 vs 分叉

| 不变量 | 判据 |
| --- | --- |
| 续聊 = `resume`，分叉 = `resume` + `forkSession` | 两者语义不同：续聊接着原会话写，分叉复制历史另起一条线、**原会话不动**（`buildQueryOptions` 纯函数 + 单测） |
| 从某条消息分叉 = 再加 `resumeSessionAt` | 该值是用户消息的 uuid（`user_message_uuid`） |
| 选项组装必须是纯函数 | 这些开关一旦传错就是"静默走了另一条路"，所以抽成 `buildQueryOptions()` 并单测，而不是埋在会话构造函数里 |
| **快照水合不许被覆盖** | `hydratedFromSnapshot` 挡住 `refreshAgents` 的"选默认 Agent"分支：那条路径会把档位/模型覆盖成默认值（本轮实测踩到） |


### 1.18 模型：别名与真实模型

| 不变量 | 判据 |
| --- | --- |
| 显示**真实模型**，别名只能当补充 | `supportedModels()` 的 `resolvedModel` 是唯一权威来源；用户换 API 后 `sonnet` 可能就是 GLM-5.3-Flash |
| 当前运行的模型来自 `system/init.model` | 它是 CLI **解析后**的值；界面芯片显示它，弹层给"运行中"标记 |
| 真实清单与 `capability.models` **分开存** | 后者会被 `refreshAgents()` 的兜底清单覆盖（静默失效）；前者存 `resolvedModels`，只在会话建立/初始化完成时刷新 |
| 拉清单要重试 | 紧跟 `sessionCreate` 的那次 `supportedModels()` 可能返回空；重试 + `system/init` 后再拉一次 |
| 模型名比对忽略大小写 | `[1m]` 与 `[1M]` 是同一个模型（实测） |


### 1.19 Agent 注册表：内置定义的协议**不许被历史数据覆盖**

| 不变量 | 判据 |
| --- | --- |
| 内置 Agent 的 `protocol` 以内置定义为准 | `registry.init()` 读数据库时，`existing.builtin` 为真则忽略记录里的 protocol；只有用户自建 Agent 才允许自定义 |
| 协议变了必须丢弃能力缓存 | 缓存里的 version/executable/models 都对应旧通道；留着会让 `probe()` 永远命中缓存、不再重探 |
| 覆盖/丢弃都要留痕 | 各打一条日志（`忽略历史注册表里的协议…` / `丢弃过期的能力缓存…`），否则下次又只能靠现象猜 |
| 启动第一行必须能回答"跑的是哪次构建" | `LogicReader 主进程启动 :: 构建=<时间戳> · 版本=… · Electron=…`；主/渲染两侧共用同一个 `buildStamp()` |
| 冒烟必须覆盖"有历史数据"的画像 | 空画像会绕过"数据库覆盖内置定义"这类问题（本轮就是这么漏掉的）；用真实画像副本复现是必备手法 |


### 1.20 面板伸缩：拖拽期间不许进 React 状态

| 不变量 | 判据 |
| --- | --- |
| 尺寸由 CSS 变量驱动 | `--lr-sidebar-w` / `--lr-aux-w` / `--lr-panel-h`；面板**不得**用内联 `style.width/height` 写死像素（会盖过变量，拖拽时宽度不动） |
| 拖拽只写变量，不写状态 | `nudge()` 直接 `setProperty`；`Workbench` 订阅了整个 layout store，任何一次 `setState` 都会重渲染整棵树（含消息流） |
| 每帧最多写一次 | `pointermove` 用 `requestAnimationFrame` 合并，避免一帧多次样式写入 |
| 松手提交一次 | `onResizeEnd` 把变量值写回 store —— 全程仅此一次重渲染 + 快照落盘 |
| 高亮不引入状态 | 分割条高亮走伪元素 + `--lr-resizer-active`，不改 `data-dragging` 触发组件重渲染 |
| 性能要有**可测判据** | `__lrDragMetrics`（渲染次数 / store 更新次数）+ `smoke.resizeDrag` 断言：拖拽期间均为 0、松手为 1、且宽度真的变了 |


### 1.21 面板伸缩：绝对坐标，不是增量累加

| 不变量 | 判据 |
| --- | --- |
| 目标尺寸由**绝对坐标**算出 | 起手记 `起始坐标 + 起始尺寸`，移动时 `最终尺寸 = 起始尺寸 ± (当前坐标 - 起始坐标)`；只认鼠标现在在哪 |
| 禁止增量累加 | 增量只加"相邻两点的差"，丢帧就丢距离，窗口会慢半拍追鼠标（用户感受为"一点一点延伸"） |
| 禁止回读布局 | 不回读 `offsetWidth`（那是上一帧的值）；尺寸由 ResizeHandle 算好传入 |
| 天然幂等 | 同一坐标重复派发结果不变（可断言） |
| 尺寸边界在起手时就确定 | `min`/`max` 由调用方给常量，避免每帧读 computedStyle |

### 1.22 i18n：平铺键的两种写法别混

| 不变量 | 判据 |
| --- | --- |
| 组件的 `t` 绑定哪个命名空间，键就写哪一层 | `PdfReaderView` 绑定 `reader` → 写 `t('debugTextLayer')`，**不能**写 `t('reader.debugTextLayer')`（那会去找 `reader['reader.debugTextLayer']`） |
| 平铺键必须整体存在于该对象下 | `cmd.reader.toggleDarkMode` 能命中，是因为 `cmd` 对象里**确实有** `'reader.toggleDarkMode'` 这个平铺键（i18next 先按点号直达） |
| 缺键会刷日志 | `missingKeyHandler` 把缺键写进 main.log；`smoke.agentUi` 也扫界面文本里的裸露键名，两条一起用 |

---

### 1.23 阅读器宽度：**每一层 flex 项都要 `min-width: 0`**

| 不变量 | 判据 |
| --- | --- |
| 从工作台到滚动容器的整条链都要能"缩到比内容窄" | 链：`.lr-workbench__center → .lr-editor-area → .lr-editor-group → .lr-reader-host → .lr-reader → .lr-pdf-root → .lr-pdf-root__main → .lr-pdf-scroll`。**行向 flex 里的 flex 项**（`.lr-reader` / `.lr-pdf-root`）必须显式写 `min-width: 0`：`min-width` 默认 `auto` = 内容的最小宽度，内容一变宽这一层就被撑开，而不是让滚动容器出滚动条 |
| 谁负责溢出，谁就得是滚动容器 | 宽内容（旋转后的 PDF 页、宽表格）由**最内层**的 `overflow: auto`（`.lr-pdf-scroll`）消化；中间任何一层被撑开都算 bug |
| 用**测量**决定缩放时，容器宽度必须与内容无关 | `PdfReaderView` 的"适应宽度/适应页面"用 `.lr-pdf-scroll.clientWidth` 反推 scale —— 一旦容器宽度受内容影响就成**正反馈**：旋转 → 页宽 ×1.41 → 容器变宽 → scale 变大 → 页更宽 … 实测一路涨到 Chromium 的 2^25 px 布局上限 |
| 这类回归只能用**真实 DOM** 的闸门 | 纯函数单测测不到 flex 布局；判据是 `smoke.pdfZoomRotate`：fit 完成后旋转两圈，容器宽度漂移 ≤2px、缩放倍率不失控（修复前实测 `drift:2311`、容器 1424→3735→3355 万） |

---

### 1.24 PDF 三种视图模式的语义（别混）

| 模式 | 语义 | 判据 |
| --- | --- | --- |
| 单页 `single` | 只渲染当前页 | `pageNumbers = [currentPage]` |
| 连续 `continuous` | 渲染**全篇**，竖向堆叠 | `pageNumbers = 1..total`，`.lr-pdf-pages` 是 column |
| 双页 `spread` | 渲染**全篇**，按 `(1,2)(3,4)…` 分行，**行内并排**、行与行竖向 | `spreadRows` 每行 ≤2 页，行容器 `.lr-pdf-spread` 是 **row**（不是 column！）；不是"只留当前那一对"，也不是"竖向摆两页" |
| 配对约定 | 左页为奇数页：`(1,2)(3,4)…` | 沿用旧实现 `start = currentPage % 2 === 0 ? currentPage-1 : currentPage` 的约定，不做"封面单排" |
| fit 要按**实际装下的盒子**算 | 单页 = 旋转后的单页盒；双页 = 两页宽 + 中缝 | `pageBox`（`rotation` 为 90/270 时宽高互换）→ `fitBox`；`SPREAD_GAP` 必须与 `pdf.css` 里 `.lr-pdf-spread` 的 `gap` 一致，否则差几像素就出横向滚动条 |
| 拿未旋转尺寸做 fit = 横向溢出 | 渲染用 `getViewport({scale, rotation})`，fit 却按 `rotation:0` 算 → 旋转 90° 后页面比视口宽 | 实测：改前 fit-width 旋转后仍 231%（溢出），改后 186%↔132%（各自贴合） |
| 闸门 | `smoke.pdfSpread` | 全篇在（`pages===total`）＋ 1、2 页 `top` 相同且左右相邻 ＋ 第 3 页在下一行 ＋ 一对页宽 ≤ 视口−40，四条全绿才报 `PDF_SPREAD_OK` |

---

## 2. 模块职责（不要越界）

| 模块 | 只做这件事 | 不要在这里做的事 |
| --- | --- | --- |
| `lib/pdfVectorText.ts` | 纯函数：矢量项 → 布局与偏移。**无 DOM、无 React、无 pdf.js 依赖** | 不要读写 DOM / 不要碰 store |
| `lib/pdfTextLayer.ts` | 调官方 pdf.js `TextLayer` 渲染文本层（复刻它的运行环境），并写入字符偏移 | 不要自己写 `left/top/font-size`（与官方实现打架就会整页偏移）；不要重新计算偏移（必须用传入的布局） |
| `lib/textLayerMapping.ts` | 映射的持久化形状与取用校验 | 不要重新实现偏移算法 |
| `lib/selection.ts` | 纯函数：DOM 选区 → 文档区间 | 不要碰 uiStore |
| `lib/readerSelection.ts` | 阅读器共用：元素对齐 + 选区 Hook | 不要写阅读器专属逻辑 |
| `lib/revealRequest.ts` | 阅读器共用：消费"外部定位请求"（重试到内容就绪、按身份判重） | 不要在这里做滚动/高亮（那是各阅读器的 `apply`） |
| `lib/graphImage.ts` | SVG → PNG/JPG 字节；读"界面上的画布底色" | 不要在这里拼 SVG（那属于主进程的 `renderSvg`），也不要写文件 |
| `lib/graphName.ts` | 关系图显示名（`文档名 · 逻辑关系图`） | 不要在这里开标签页（那是 `commands.openGraphTab`） |
| `lib/graphJump.ts` | "从关系图跳到原文"的唯一实现（开阅读器标签 + 发定位请求，带 `hold`/`chain`） | 不要在这里做高亮（那是阅读器与 `lib/revealMark`） |
| `lib/revealMark.ts` | 阅读器共用的打高亮（`lr-flash` 1.6s / `lr-reveal` 常驻）+ `data-reveal-range` | 不要在这里找目标元素（那是各阅读器的 `apply`） |
| `views/reader/GraphChainPanel.tsx` | 文段旁的局部逻辑链（一度关系 + 跳转） | 不要在这里画整张图（那是画布的职责） |
| `state/graphEdits.ts` | 人工编辑的**规则**（能否连线、怎么造一条人工连线）—— 纯函数 | 不要碰 store / API / React Flow |
| `services/graph.service.renderSvg` | 关系图 → SVG 文本（`background` 决定画不画底） | 不要做光栅化（主进程没有光栅化器）、不要校验用户输入之外的颜色 |
| `packages/shared/permissions.ts` | 授权模式的**唯一判定**（纯函数：模式 × 类别 × 证据 → 自动放行 / 自动拒绝 / 转人工） | 不要读设置、不要碰 DOM、不要在这里发 IPC |
| `services/agent/sdk.ts` | 官方 Claude Agent SDK 通道：动态加载、消息翻译、授权模式映射、`canUseTool` 转接 | 不要在里判定权限（交给 `decideSdkPermission`）；不要静态 import SDK（ESM-only） |
| `scripts/copy-claude-cli.mjs` | 打包前把 SDK 自带的原生 CLI 复制到 `resources/claude-cli/` | 不要在运行时去 asar 里找可执行文件 |
| `services/agent/runtime.ts` | 会话生命周期 + 权限往返；把 `permissionMode` 落成会话级能力位（`canWrite` / `canExecute`） | 不要自己判断"这个命令危不危险"（那是 permissions.ts） |
| `features/agent/AgentSidebarView.tsx` | 面板的两副面孔：欢迎块 / 消息流 / 输入卡片 / 档位选择器 | 不要在这里再实现一套授权规则（只负责展示与选择） |
| `state/agent.store.ts` | 面板状态、模式持久化、权限自动应答、提示词拼装 | 不要在这里做滚动/高亮，也不要把模式写进 settings（它是**会话级**的） |
| `views/reader/*` | 只用上面这些，负责渲染与交互 | 不要再自建一套偏移/选区算术 |
| `apps/main/src/index.ts` | 启动顺序、降级、日志 | 不要塞业务逻辑 |

---

## 3. 启动流程（顺序有硬约束）

```
1. bootLog 就绪（写 userData/logs/boot.log）
2. （没有自我提权步骤：不为「看起来可信」引入隐藏 PowerShell / -Verb RunAs）
3. setupGpuSwitches()        ← 必须在 app ready 之前：
     · 读 render-fallback.json（上次的降级结论）
     · 软件渲染：app.disableHardwareAcceleration()
     · 关沙箱：app.commandLine.appendSwitch('no-sandbox')
     · 单进程：--single-process --in-process-gpu
4. requestSingleInstanceLock()
5. app.whenReady() → 服务 → 窗口（webPreferences.sandbox 跟随降级结论）
6. render-process-gone → **同一次启动内自动恢复**（见下表）→ 结论落盘供后续启动使用
```

**同一次启动内的两级恢复（都不需要管理员权限，也不需要用户手动再开一次）**：

| 级 | 动作 | 何时生效 | 代价 |
| --- | --- | --- | --- |
| 1 | 关掉窗口级沙箱重开窗口（`webPreferences.sandbox=false`） | 立刻 —— 该选项**不受 `app ready` 限制** | 无重启 |
| 2 | 用 `--no-sandbox` 重启自己一次（带 `--lr-recovered` 标记，只重启一次） | 立刻 —— 新进程在 ready 之前拿到开关 | 一次进程重启 |

**为什么还需要"落盘 + 下次启动生效"这一层**：`disableHardwareAcceleration()` 与**主进程**的命令行开关
只允许在 `app ready` 之前调用，而失败是 ready 之后才知道的。所以除上面两级即时恢复外，
结论还要写进 `render-fallback.json`，让之后每次启动一上来就是兼容形态；
连渲染子进程都创建不出来时，再升到最后一档单进程（`--single-process --in-process-gpu`）。

---

## 4. 验证矩阵（每次改动后跑）

> **两份产物，别搞混**：`out/` 是开发运行（`electron .`）与所有开发态冒烟用的；
> `release/win-unpacked/`（exe + `resources/app.asar`）是**打包那一刻**的快照。
> 改完代码要双击 exe 生效，必须再跑一次 electron-builder（详见 避坑指南 §2.9）。
> 状态栏的 `__LR_BUILD__` 时间戳用来判断"我跑的是哪份产物"。

```powershell
# 1) 类型 + 单测（含几何不变量、选区内容对齐、跨页绝对偏移）
pnpm run typecheck
pnpm exec vitest run

# 1.5) 要交付 exe 时：打包并镜像回 release\（release\ 被占用就先出到 staging）
node node_modules/electron-builder/cli.js --win --dir --config electron-builder.yml --config.directories.output=release-staging
robocopy 'release-staging\win-unpacked' 'release\win-unpacked' /MIR /NFL /NDL /NJH /NJS /NP

# 2) 离线几何/缩放不变性（不需要 GUI）
node --experimental-strip-types .probe-vector.mjs <某个真实 PDF>

# 3) 应用内冒烟（真实文件 + 真实鼠标拖选）
$env:LR_SMOKE='34000'
$env:LR_SMOKE_COMMAND='smoke.gotoPage:31,smoke.auditMapping,smoke.mapCoverage,smoke.selectText,smoke.verifySelection,smoke.zoom:250,smoke.auditMapping'
& .\release\win-unpacked\LogicReader.exe --no-sandbox <PDF 路径>

# 4) 论文↔关系图绑定与命名（关论文连带关图 / 关图不关论文 / 能再调取 / 命名规则）
$env:LR_SMOKE='45000'
$env:LR_SMOKE_COMMAND='smoke.graphBinding'
& .\node_modules\electron\dist\electron.exe . --no-sandbox --user-data-dir=<隔离画像>

# 5) 跳转（关系图节点 → 原文）：单击只选中，点检查器里的「跳转」才跳
$env:LR_SMOKE='60000'
$env:LR_SMOKE_COMMAND='smoke.graphJump'
& .\node_modules\electron\dist\electron.exe . --no-sandbox --user-data-dir=<隔离画像>

# 6) 送给 Agent 的文本完整性：选区 146 字必须一字不少地进问题与上下文
$env:LR_SMOKE='40000'
$env:LR_SMOKE_COMMAND='smoke.askPayload'
& .\node_modules\electron\dist\electron.exe . --no-sandbox --user-data-dir=<隔离画像>

# 7) 手工连线：真的从把手拖一条线到另一个节点（含落库、重复拒绝）
$env:LR_SMOKE='40000'
$env:LR_SMOKE_COMMAND='smoke.graphEdge'
& .\node_modules\electron\dist\electron.exe . --no-sandbox --user-data-dir=<隔离画像>

# 8) 图片导出（PNG 透明 / JPG 画布底色）：读导出像素断言，不看截图
$env:LR_SMOKE='52000'
$env:LR_SMOKE_COMMAND='smoke.graphImage'
& .\node_modules\electron\dist\electron.exe . --no-sandbox --user-data-dir=<隔离画像>

# 9) Agent 面板形态 + 授权模式（不消耗真实模型：用 mock 跑完整流程）
$env:LR_SMOKE='9000'
$env:LR_SMOKE_AGENT_ID='mock'                       # 强制用 mock，截图/断言都不碰真实配额
$env:LR_SMOKE_AGENT='用一句话说明这份文档在讲什么。'   # 只截图空态时留空
$env:LR_SMOKE_COMMAND='smoke.agentUi'
$env:LR_SMOKE_SHOT='<输出 PNG>'
& .\node_modules\electron\dist\electron.exe . --no-sandbox --user-data-dir=<隔离画像>
# 期望日志：AGENT_UI_OK {"empty":true|false,...,"modeAfterClick":"auto","sessionRebuilt":true,"rawKeyLeaks":0}

# 10) 授权判定矩阵（纯函数，无需 GUI）
pnpm exec vitest run tests/permission-policy.test.ts

# 11) PDF「适应宽度/适应页面 + 旋转」不许把容器越撑越大（布局级正反馈，见 §1.23）
$env:LR_SMOKE='26000'
$env:LR_SMOKE_COMMAND='smoke.pdfZoomRotate'
& .\release\win-unpacked\LogicReader.exe <PDF 路径>
# 期望日志：PDF_ZOOM_ROTATE_OK {"drift":0,"runaway":false,...}

# 12) PDF 双页：并排两页 + 全篇可见 + 自适应装下两页（语义见 §1.24）
$env:LR_SMOKE='26000'
$env:LR_SMOKE_COMMAND='smoke.pdfSpread'
& .\release\win-unpacked\LogicReader.exe <PDF 路径>
# 期望日志：PDF_SPREAD_OK {"allPages":true,"sideBySide":true,"nextRowBelow":true,"fits":true,...}
```

> **11/12 两条 PDF 冒烟会改标签页的视图状态**（缩放 / 旋转 / 视图模式）——它们跑在哪个画像上，
> 哪个画像的会话快照就会被改。别拿用户的真实目录当试验场：加 `--user-data-dir=<隔离画像>`
> （同上面第 4~8 条的规矩），或者跑完把标签页的视图改回去。

**判定标准**：`MAPPING_AUDIT ok>0 bad=0`、`MAP_COVERAGE_OK skipped=0`、`SELECTION_MATCH`；
`GRAPH_BINDING_OK`（标题 = `文档名 · 逻辑关系图`、关图后论文还在、能再调取、关论文时图一起关）；
`GRAPH_JUMP_IDLE_OK`（单击没跳走）＋ `GRAPH_JUMP_OK`（锚点区间 == 定位请求区间、`flash` 落在目标页、
**`rangeOk` 高亮范围 == 收拾过的区间**、**`holdOk` 2.6 秒后高亮仍在**、**`chainOk` 文段旁的面板指向同一节点且有相连项**）；
`AGENT_PAYLOAD_OK`（问题文本与上下文都含**完整**选区、且问题里没有裸露的文案键）；
`GRAPH_EDGE_OK`（拖拽产生新连线、`persistedOk` 已落库、DOM 边数 +1、同方向重复被拒）；
`GRAPH_IMAGE_OK`（PNG 角落 `alpha=0` 且 SVG 无底色矩形、JPG 角落逐通道等于界面画布底色、尺寸 = SVG×2 且有内容）；
`AGENT_UI_OK`（空态与欢迎块一致、档位弹层 4 项且当前项打勾、点"自动"真的改到 store 并**重建了会话**、面板与菜单/侧边栏/状态栏都没有裸露的文案键 `chromeKeyLeaks=0`）；
`PDF_ZOOM_ROTATE_OK`（`drift<=2`：fit 完成后旋转两圈，滚动容器宽度不变、缩放倍率不失控）；
`PDF_SPREAD_OK`（双页模式全篇都在、两页左右并排、下一行在下方、一对页能装进视口）；
且 `main.log` 里有 `矢量文本层：page=N span=M 来源=... 自校验bad=0`。

> 跳转与图片冒烟**必须用隔离的 userData**（`--user-data-dir`，把 `logicreader.db` / `session.json` 拷进去）：
> 它们会真的点节点、切标签、写导出文件、改会话快照，不能拿用户的真实目录当试验场。
>
> **冒烟之间是会并发的，别把它们串成一条链**：`LR_SMOKE_COMMAND` 里每条命令只间隔 900ms **启动**，
> 而处理函数是异步的、立刻返回 —— 于是多条命令真正在**同时**跑，会互相抢标签、抢选区、抢画布：
> 实测出现过 `GRAPH_JUMP_FAIL {"activeTab":"graph"}`（图片冒烟把标签切走了）、
> `GRAPH_EDGE_FAIL {domEdges:[80,80]}`（跳转冒烟在换标签时画布重挂载，拖拽落点失效）、
> `AGENT_PAYLOAD_FAIL 没能建立选区`（阅读器被别条冒烟切走）。
> **结论：动了标签/选区/画布的冒烟，一次启动只跑一条**（本轮起按这个方式验证）；
> 确实要连跑时，先确认它们互不触碰这三样东西。

---

## 4.1 文本层定位：**只用像素**

- 文本层容器的尺寸由 `PdfPageView` **按视口显式设定**（`style.width/height`），
  span 一律用**像素**的 `left / top / font-size`。
- **不要用百分比定位**：百分比要经过"浏览器如何解析绝对定位元素的百分比高度"这一环，
  出问题时**不报错、只是偏**，排查成本极高（本项目实测踩过：整页偏移约 100px，
  查了整整一轮才发现问题不在几何计算、而在定位方式本身）。
- 位置经 `viewport.convertToViewportPoint` 变换后再乘缩放，旋转页同样正确。

## 4.2 现场诊断（命令面板内置）

命令面板 → **诊断：文本层几何**，会把"DOM 实测矩形 vs 矢量应有矩形"的逐项差值写进
`%APPDATA%/logicreader/logs/main.log`（搜索 `LAYER_GEOMETRY`）。读法：

| 现象 | 结论 |
| --- | --- |
| 所有项的 `dy` / `dx` 相同 | 定位基准错（容器尺寸或 layer 偏移） |
| `dy` 随项序号线性增长 | 行高 / 字号换算错 |
| 只有个别项错 | 该项自身的几何算错 |
| `expectedTop` 与 `domTop` 完全相等 | 文本层正确，问题在选区解析 |

---

## 5. 已知边界（诚实记录，不要当成 bug）

1. **扫描版 PDF**：没有文本项，选区不可用（插入 image 块占位）。
2. **图表/示意图里的散落标签**：选中的文字在文档模型里不是连续区间，
   记录的是"覆盖选区的最小包围"；`quote` 仍以用户实际选中的文字为准。
3. **DOM 字体与内嵌字体不同**：隐藏文本的水平宽度会有微小差异（`data-target-width` 里记了矢量宽度，
   需要精确时可以据此校正），但不影响字符偏移与选区命中。
4. **首次启动可能"闪一下"**：正常形态失败后会**自动**恢复（进程内重开窗口，必要时自动重启一次进程），
   用户不需要手动打开第二次；只有连恢复都失败时才弹窗，此时按弹窗里的排查步骤处理即可，**不需要管理员权限**。
5. **降级后安全性下降**：`--no-sandbox` 与单进程模式会削弱进程隔离，
   仅在检测到环境确实拦死子进程时才启用（有 `render-fallback.json` 为证）。
6. ~~表格阅读器命中数据库缓存时停在加载态~~（已修复，执行记录 §47）：
   视图上 `getSheets` 为空时用 `ensureSheets` 从原文件补载（并发去重、失败给错误页），
   单元格提取逻辑收敛为唯一的纯函数 `workbookToSheets`（解析与补载共用，保证同源）。
   注意 `BlockRecord` 仍不持久化 `meta`：表格相关代码一律用 `locator.range` 取行号，不许用 `meta.rowIndex`。
7. **PDF 的跳转高亮需要文本层就绪**：精确矩形来自文本层 span 的字符偏移；
   扫描页 / 无偏移表的旧缓存等拿不到映射时，约 2 秒后降级为"闪整页"（滚动仍然正确）。
