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

存为任意路径（下面以 `C:/tmp/mcp-acceptance-server.mjs` 为例）：

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

> ⚠️ 该脚本依赖 `@modelcontextprotocol/sdk`，需放在**能解析到该包**的目录下运行
> （最简做法：放进 `hosts/memora-vscode/` 目录内，用其 `node_modules`）。

## 2. 配置（用户设置 JSON）

```json
"memora.mcpServers": [
  { "name": "acc", "command": "node", "args": ["C:/tmp/mcp-acceptance-server.mjs"] }
]
```

派生名 = `mcp__acc__echo` / `mcp__acc__with-enum` / `mcp__acc__toggle-tool` /
`mcp__acc__fail` / `mcp__acc__hang`。

## 3. 用例与判据

| # | 操作 | 预期（不符即记缺陷） |
|---|------|----------------------|
| A | 打开 Memora 面板，问「你有哪些工具」 | 5 个 `mcp__acc__*` **全部**出现（分页拉全；少一个 = 只取了第一页）。输出面板有「server「acc」已接入，注册工具 5 个」 |
| B | 让模型调 `echo` | **弹确认框**（默认每次确认 = 设计行为，非故障）。放行后回显 `echo:echo:{...}` |
| C1 | 设置加 `"memora.mcpToolAllowlist": ["mcp__acc__echo"]`，保存后再调 `echo` | **不再弹窗**，调用成功；审计里仍有该次记录（免弹窗≠免审计）。`with-enum` 仍弹（未命中） |
| C2 | **④ 回归**：在 C1 生效状态下，让模型调 `toggle-tool`，再调 `echo` | `extra-tool` 出现在工具列表（整换生效），且 **`echo` 仍不弹窗**。若 `echo` 又开始弹确认 = ④ 回归（整换把档位退回 `always`） |
| D1 | 改配置里的 `args`（指向改过的脚本或改 name） | 立即停旧连接、起新的，工具列表随之更新（无需重载窗口） |
| D2 | 把 `memora.mcpServers` 改为 `[]` | 5 个工具**全部消失**；任务管理器里 `node` 子进程退出（漏退 = 僵尸进程） |
| D3 | 恢复配置 | 工具重新出现（热更可逆） |
| E1 | 调 `fail` | 模型收到**工具失败**（不是把「故意失败」当正常结果回填） |
| E2 | 调 `hang` | **耐心等满 60s** 才报超时；超时后 `echo` **仍可调**（连接未被超时顺带杀掉） |
| F | （可选·真实生态）换 `"command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"]` | 真实 server 能接入、工具可列可调。⚠️ npx 首次冷启动可能吃掉 20s 握手预算 → 失败先重跑一次再判（见 §4） |

## 4. 判别标准：真缺陷 vs 环境假象

| 现象 | 先排除 | 才算缺陷 |
|------|--------|----------|
| **激活失败**：`Dynamic require of "X" is not supported` | 是否真的重跑过 compile（旧产物） | 重跑后仍现 ⇒ CJS/ESM 产物形态缺陷（2026-10-24 已修 cross-spawn 那条；新依赖可能重蹈，报缺陷并附 X） |
| 工具没出现 | 输出面板是否有「握手失败 / 未声明 tools 能力 / 分页异常收口」；配置绝对路径是否正确；Agent 是否已装配（面板开过） | 面板无任何告警但工具仍不出现 |
| `hang` 立刻报错 | 是否等满 60s | 未到 60s 就报错（超时未生效），或超时后 `echo` 也不可用 |
| F 用例接入失败 | npx 冷启动慢（重试一次） | 重试仍失败且面板有明确错误 |
| C2 又弹窗 | 确认 C1 当时确实免弹过（否则是 allowlist 键没写对） | C1 已免弹、toggle 后回退 ⇒ **④ 回归** |
| D2 子进程未退 | 进程名是否真是该脚本（可能有别的 node） | 确认是该脚本仍存活 |

## 5. 需要反馈的内容

跑完请把下面几项贴回来（有则贴、无则写「未见」）：

1. 每个用例**实际现象**（与预期不符的逐条说明）；
2. 输出面板 **Memora** 的完整相关输出（接入 / 告警 / 断开各行）；
3. C2 的结果（**最关键**：toggle 后 `echo` 是否仍免确认）；
4. 任何「文档说 X、实际是 Y」的不一致（`docs/mcp-setup.md` 的步骤若跑不通，一并指出）。

判定：全部用例符合预期 ⇒ 台账 ⑨ 销项，D1-MCP 功能面收口，可进入内核 5.1.0 发版准备。
