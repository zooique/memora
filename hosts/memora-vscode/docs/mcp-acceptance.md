# MCP 真机验收清单（闭合台账 ⑨）

> **为什么需要这份清单**：切片 1-4 的自动化用例里，握手 / 分页 / `list_changed` / 调用
> 超时跑的是真子进程，但**配置热更 / 档位重算 / 整换 / 断线补注销全是注入替身**
> （`FakeConnection` + `fakeRegistrar`）。方案 §9 切片 4 的验收判据「干净工作区按文档
> 可跑通全流程」**从未真机执行** ⇒ 在下面跑完之前，切片 4 只算代码落地、不算验收达成。

## 0. 前置

- ⚠️ **必须跑含本次修复的构建**。④（allowlist 热更同步运行态 `allowKeys`）在
  `ce1aadea` 之前不存在——用旧版安装验不到，且会误判成「缺陷仍在」。
  二选一：① 仓库根 `F5` 启动 Extension Development Host；② `npm run package` 打
  `memora-vscode.vsix` 后从 VSIX 安装。
- 构建必须走 `npm run compile`（**F5 的默认构建任务就是它**，无需手跑）。其末尾已挂产物
  加载冒烟 `scripts/verify-bundle-loadable.mjs`——产物若加载不了，构建直接失败，不会给你
  一个装上就炸的 vsix（该冒烟为 2026-10-24 真机首曝缺陷所加，见 §4 判别表首行）。
- 打开 **输出面板 → Memora**（server 的 stderr 与宿主接入告警都在这里，全程保持可见）。
- 准备一个**干净工作区**（不复用已有 `.memora/` 的项目，避免旧状态混入判别）。

## 1. 验收用 server（本地脚本，零网络依赖）

🔴 **脚本必须放在能解析 `@modelcontextprotocol/sdk` 的目录里**，本文示例取
`hosts/memora-vscode/mcp-acceptance-server.mjs`（该目录的 `node_modules` 里有 SDK）。
不是洁癖：ESM 从**脚本所在目录**逐级向上找 `node_modules`，与进程 `cwd` 无关 ⇒ 放到
`C:/tmp/` 或仓库根这类解析不到的位置，server 启动即崩，面板只显示
`McpError: MCP error -32000: Connection closed`（真因 `ERR_MODULE_NOT_FOUND` 在输出
面板的 `[DEBUG]` 行里）——2026-10-24 真机实踩。

```js
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const PAGE_SIZE = 2; // 5 个工具 → 3 页，验宿主是否循环 nextCursor 拉全

const TOOLS = [
  { name: 'echo', description: '回显文本', inputSchema: { type: 'object', properties: { message: { type: 'string', description: '要回显的文本' } }, required: ['message'] } },
  { name: 'with-enum', description: '带枚举与范围约束', inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['fast', 'safe'] }, limit: { type: 'number', minimum: 1, maximum: 10 } } } },
  { name: 'toggle-tool', description: '调用后追加一个工具并推 list_changed', inputSchema: { type: 'object', properties: {} } },
  { name: 'fail', description: '永远返回 isError', inputSchema: { type: 'object', properties: {} } },
  { name: 'hang', description: '永不响应（验 60s 转发超时）', inputSchema: { type: 'object', properties: {} } },
];
const EXTRA = { name: 'extra-tool', description: 'toggle-tool 调用后才出现', inputSchema: { type: 'object', properties: {} } };

let unlocked = false;
const server = new Server({ name: 'acceptance', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });

server.setRequestHandler(ListToolsRequestSchema, async (req) => {
  const start = req.params?.cursor ? Number(req.params.cursor) : 0;
  const list = unlocked ? [...TOOLS, EXTRA] : TOOLS;
  const page = list.slice(start, start + PAGE_SIZE);
  const next = start + PAGE_SIZE < list.length ? String(start + PAGE_SIZE) : undefined;
  return next ? { tools: page, nextCursor: next } : { tools: page };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === 'fail') return { content: [{ type: 'text', text: '故意失败' }], isError: true };
  if (name === 'hang') return new Promise(() => {});
  if (name === 'toggle-tool') {
    unlocked = true;
    await server.sendToolListChanged();
    return { content: [{ type: 'text', text: '已追加 extra-tool 并通知' }] };
  }
  return { content: [{ type: 'text', text: `echo:${name}:${JSON.stringify(args ?? {})}` }] };
});

await server.connect(new StdioServerTransport());
```

> 快速自查：`cd hosts/memora-vscode && node mcp-acceptance-server.mjs` 应「挂住不退出」
> （等 stdio 输入）；直接抛 `ERR_MODULE_NOT_FOUND` 就是位置不对。

## 2. 配置（设置面板 MCP 页）

打开 Memora 侧栏 → **设置** → **MCP** → 「添加服务器」，填：名称 `acc`、命令 `node`、
参数一行一个该脚本的**绝对路径**（如 `F:/…/hosts/memora-vscode/mcp-acceptance-server.mjs`），
保存。

> 等价做法仍是手写
> `"memora.mcpServers": [{ "name": "acc", "command": "node", "args": ["<仓库>/hosts/memora-vscode/mcp-acceptance-server.mjs"] }]`。
> 本批新增的页内 CRUD 用例（G 组）**必须**走面板，否则验不到。

**两层名字别混**（真机易错点）：

| server 侧原始名 | 派生名（模型所见，`-`→`_`） | allowlist 寻址键（用原始名） |
| --- | --- | --- |
| `echo` | `mcp__acc__echo` | `mcp__acc__echo` |
| `with-enum` | `mcp__acc__with_enum` | `mcp__acc__with-enum` |
| `toggle-tool` | `mcp__acc__toggle_tool` | `mcp__acc__toggle-tool` |
| `extra-tool` | `mcp__acc__extra_tool` | `mcp__acc__extra-tool` |
| `fail` | `mcp__acc__fail` | `mcp__acc__fail` |
| `hang` | `mcp__acc__hang` | `mcp__acc__hang` |

> 派生名由 [toolRegistry.ts](../src/extension/host/mcp/toolRegistry.ts) 的 `sanitizeSegment`
> 清洗（`-` / `.` / `/` → `_`）；allowlist 由 [policy.ts](../src/extension/host/mcp/policy.ts)
> 的 `allowlistKey` 按**原名**寻址、刻意不认派生名。故含连字符的工具，把模型可见名
> 直接抄进 allowlist 会**静默不命中**（例外：无连字符的 `echo` / `fail` / `hang` 两者同形）。

## 3. 用例与判据

| # | 操作 | 预期（不符即记缺陷） |
|---|------|----------------------|
| A | 打开 Memora 面板，问「有 5 个 `mcp__acc__` 工具吗」 | 5 个派生名**全部**出现（分页拉全；少一个 = 只取了第一页）。输出面板有「server「acc」已接入，注册工具 5 个」。⚠️ 开放式提问「你有哪些工具」常被模型写成概括性介绍、漏列 MCP 工具（2026-10-24 实测），**不作为判据** |
| B | 让模型调 `echo` | **弹确认框**（默认每次确认 = 设计行为，非故障）。放行后回显 `echo:echo:{...}` |
| C1 | 设置加 `"memora.mcpToolAllowlist": ["mcp__acc__echo"]`，保存后再调 `echo` | **不再弹窗**，调用成功；审计里仍有该次记录（免弹窗≠免审计）。`with-enum` 仍弹（未命中） |
| C2 | **④ 回归**：在 C1 生效状态下，让模型调 `toggle-tool`（模型侧 `mcp__acc__toggle_tool`），再调 `echo` | 新增工具 `mcp__acc__extra_tool` 出现在模型可见工具列表（整换生效），且 **`echo` 仍不弹窗**。若 `echo` 又开始弹确认 = ④ 回归（整换把档位退回 `always`） |
| D1 | 改配置里的 `args`（指向改过的脚本或改 name） | 立即停旧连接、起新的，工具列表随之更新（无需重载窗口） |
| D2 | 把 `memora.mcpServers` 改为 `[]` | 5 个工具**全部消失**；任务管理器里 `node` 子进程退出（漏退 = 僵尸进程） |
| D3 | 恢复配置 | 工具重新出现（热更可逆） |
| E1 | 调 `fail` | 模型收到**工具失败**（不是把「故意失败」当正常结果回填） |
| E2 | 调 `hang` | **耐心等满 60s** 才报超时；超时后 `echo` **仍可调**（连接未被超时顺带杀掉） |
| F | （可选·真实生态）换 `"command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"]` | 真实 server 能接入、工具可列可调。⚠️ npx 首次冷启动可能吃掉 20s 握手预算 → 失败先重跑一次再判（见 §4） |
| G1 | 面板添加一台**命令不存在**的 server（如 `command: "definitely-not-exist"`） | 卡片变「启动失败」并**直接显示失败原因**，顶部有失败回执；不是静默消失，也不是永远停在「加载中」 |
| G2 | 配置不改，从任务管理器杀掉 `acc` 的子进程，再点该卡片「重启」 | 连接恢复、工具重新可调（**恢复路径**：配置未变时热更不重连）。重启仍失败则卡片显示新的失败原因 |
| G3 | 手写 JSON 给 `acc` 加本页不认识的字段（如 `"timeout": 5000`），再用面板改它的参数并保存 | 保存成功；回查 settings.json，`timeout` **仍在**（编辑动作不销毁未知字段） |
| G4 | 手写 JSON 把某台 `args` 改成含空串项或换行（`["a", "", "b"]` / `["a\nb"]`） | 该台「编辑」**置灰**、title 指路 settings.json；仍可查看 / 停用 / 删除，且**配置内容不被面板改写** |
| G5 | 点「删除」→「取消」，再点「删除」→「确认删除」 | 首次不删（二次确认生效）；确认后卡片消失、工具消失、子进程退出 |
| G6 | 对已连接的一台点「停用」，再点「启用」 | 停用后卡片变「已停用」、工具从模型侧消失；启用后重新拉起恢复（可逆，不是删除） |
| G7 | **冷启动顺序**：重载窗口后**先**只打开 设置→MCP（不要先开对话面板） | 已配置的台显示「**待接入**」而不是「还没有配置任何服务器」；此时添加一台也能**立刻出卡片**（不是「已添加」回执后列表仍空）；随后打开对话面板，卡片自动转「已连接」 |
| G8 | **⑦ 新增重名**：面板「添加服务器」填一个**已存在**的名字（如 `acc`），命令填 `definitely-not-exist`，保存 | 回执「已存在：acc…」，表单**复开且填过的内容还在**；回查 settings.json，原 `acc` **未被改写**（命令仍是原值，fail-closed） |
| G9 | **④ 写失败**：把 settings.json 设为只读（Windows：`attrib +R`，或 ACL 去掉写权限）后保存一台新 server | 回执带**真实原因**，表单**复开且输入未丢**；卡片仍是旧配置（不是假成功）。验完记得 `attrib -R` 还原 |
| G10 | **接入按钮**：冷启动后先开设置页（不打开对话面板），点「待接入」卡片的「**接入**」 | 数秒内卡片转「已连接」（或给出**真实**失败原因）；**不能**点了毫无变化——点了没反应 = 假动作缺陷（判据必须落在 applied，不是「Agent 装配过」） |
| G11 | **隐藏条目计数**：手写 JSON 造两条——一条缺 `name`、一条与 `acc` 归一化重名（`"acc "`）；打开设置页 | 可见卡片数 + 顶部「另有 N 台未显示」的计数/解释行 **= 配置总条数**（不静默吞条目）；解释行说明「为什么看不到」 |
| G12 | **A 误杀回归**：新增一台 `command: "npx", args: ["@modelcontextprotocol/server-everything"]`（**不带 `-y`**） | 不被判「参数里的文件不存在」；正常进入拉起（冷启动慢按 F 的规则重试一次） |

## 4. 判别标准：真缺陷 vs 环境假象

| 现象 | 先排除 | 才算缺陷 |
|------|--------|----------|
| **激活失败**：`Dynamic require of "X" is not supported` | 是否真的重跑过 compile（旧产物） | 重跑后仍现 ⇒ CJS/ESM 产物形态缺陷（2026-10-24 已修 cross-spawn 那条；新依赖可能重蹈，报缺陷并附 X） |
| 卡片「启动失败」，错误只有 `McpError … -32000: Connection closed` | 在脚本所在目录直跑一遍（`node <脚本>`）：是否 `ERR_MODULE_NOT_FOUND`（依赖解析不到）；`command` 是否在 PATH | 直跑能挂住、面板仍 closed ⇒ 宿主启动链路缺陷（不是脚本问题） |
| 工具没出现 | 输出面板是否有「握手失败 / 未声明 tools 能力 / 分页异常收口」；配置绝对路径是否正确；Agent 是否已装配（面板开过） | 面板无任何告警但工具仍不出现 |
| `hang` 立刻报错 | 是否等满 60s | 未到 60s 就报错（超时未生效），或超时后 `echo` 也不可用 |
| F 用例接入失败 | npx 冷启动慢（重试一次） | 重试仍失败且面板有明确错误 |
| C2 又弹窗 | 确认 C1 当时确实免弹过（否则是 allowlist 键没写对） | C1 已免弹、toggle 后回退 ⇒ **④ 回归** |
| D2 子进程未退 | 进程名是否真是该脚本（可能有别的 node） | 确认是该脚本仍存活 |
| 卡片状态与实际不符（显示「已连接」但工具调不通） | 输出面板有无断开/重连告警；工具是否真在模型列表 | 面板状态点与真实运行态背离 ⇒ 状态真源散点（状态必须由运行态合并推导，不是面板本地记的） |
| G2 重启后照旧不通 | 是否真杀的是 `acc` 的子进程；输出面板有无新错误 | 重启无回执、也无新失败原因 ⇒ 恢复路径未生效 |
| G7 仍是空态 | 构建是否含本次修复（旧版列表只读运行态） | 新版仍空 ⇒ 列表基线又退回运行态（回归） |

## 5. 需要反馈的内容

跑完请把下面几项贴回来（有则贴、无则写「未见」）：

1. 每个用例**实际现象**（与预期不符的逐条说明）；
2. 输出面板 **Memora** 的完整相关输出（接入 / 告警 / 断开各行）；
3. C2 的结果（**最关键**：toggle 后 `echo` 是否仍免确认）；
4. G 组结果，尤其 **G2（恢复路径）**、**G3（未知字段保留）**、
   **G7（冷启动先开设置页）**、**G8（新增重名被拒）**、**G9（写失败表单复开）**、
   **G10（接入按钮不是假动作）**、**G11（隐藏条目计数）**、**G12（包名不误杀）**；
5. 任何「文档说 X、实际是 Y」的不一致（`docs/mcp-setup.md` 的步骤若跑不通，一并指出）。

判定：全部用例符合预期 ⇒ 台账 ⑨ 销项，D1-MCP 功能面收口，可进入内核 5.1.0 发版准备。
