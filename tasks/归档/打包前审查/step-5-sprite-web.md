# Step 5 · Sprite 宿主 Web 服务层审查

> **审查日期**：2026-07-19
> **审查模式**：问诊·炼化归元（规则对齐 → 剪枝 → 提交前审查）
> **审查范围**：`hosts/memora-sprite/src/web/routes/` 7 文件 ~1801 行
>   - `index.ts` 路由聚合分发器
>   - `types.ts` 共享类型与工具（parseJsonBody/sendJson/sendError/safeRoute/ensureAgentReady/SECURITY_HEADERS）
>   - `chatStreamRoutes.ts` 对话流式 SSE（525 行，最复杂）
>   - `configRoutes.ts` 配置 + 角色管理
>   - `memoryRoutes.ts` 记忆 CRUD（最大路由集合，330 行）
>   - `sessionRoutes.ts` 会话管理
>   - `systemRoutes.ts` 系统 + LLM 配置 + 多 Provider + 审计 + 技能安装 + 作品投影

---

## 一、规则对齐（已对齐 X=6 项）

### ✅ 1.1 路由安全·输入验证（展示层 + 数据访问层注入防护）

**已对齐**：
- 所有路由使用 `shared/inputValidation.ts` 统一校验（`isValidPersonaName` / `isValidSessionName`）
- `server.ts` 路径穿越防护（normalizedRoot 前缀检查）
- `types.ts` `parseJsonBody` 限制 body ≤ 10MB（防止内存耗尽）
- `chatStreamRoutes.ts` 输入文本长度校验 ≤ 100KB
- ID 长度校验 ≤ 500 字符
- `chatStreamRoutes.ts` 未匹配路由已不回显 path（注释明确"防止用户输入注入到响应体或泄露路由细节"）

**本次修复**：
- `memoryRoutes.ts` 6 处 `id.length > 500` → 统一改用 `isValidId(id)`（与 IPC handler 行为一致）
- `configRoutes.ts` / `memoryRoutes.ts` / `systemRoutes.ts` 3 处未匹配路由回显 path → 改为通用 `'404 Not Found'`，对齐 `chatStreamRoutes.ts` / `sessionRoutes.ts` 已有约定

### ✅ 1.2 错误兜底·safeRoute 中间件兜底 500

**已对齐**：
- `types.ts` `safeRoute` 包装所有路由业务逻辑，catch 后返回 500
- `headersSent` 检查防重复写入
- `server.ts` 入口层 try/catch 兜底 handleRequest 异常（500 + 安全响应头）
- `chatStreamRoutes.ts` SSE 流式分支独立 try/catch/finally（streamTimedOut 单点路由 + finally 清理 AbortController）

**本次修复**：
- `types.ts` `safeRoute` catch 块 `error instanceof Error ? error.message : String(error)` → 改用 `toError(error).message`，与 `chatStreamRoutes` / `systemRoutes` 等位置保持一致

### ✅ 1.3 koa-connect wrapper 已废弃·使用原生 node:http

**已对齐**（实际超越约束）：
- `server.ts` 使用 `node:http` 原生 `createServer`，**未引入 Koa 或 koa-connect**（比 project_memory.md "使用原生 Koa" 更彻底）
- 零新增依赖原则（`server.ts` 文件头注释明确"不引入 express/fastify"）
- 与 `backend_layers_rules.md` "Web 模式 HTTP 调试通道，与 Electron 模式并行" 一致

### ✅ 1.4 SSE 流式响应正确处理 tool_calls delta

**已对齐**：
- `chatStreamRoutes.ts` 完整覆盖 SSE 协议 10 种事件（start/chunk/recall/tool_start/tool_result/thinking/truncated/aborted/error/end）
- 与 IPC `chatStreamHandler.ts` 镜像（`STREAM_NO_PROGRESS_TIMEOUT_MS = 60_000` 一致）
- `abortedNotified` 单点路由避免重复发送 aborted 事件
- 截断检测（done 时对比 `truncationCount`）
- 客户端断开检测（`req.on('close')` + `abortController.abort`）
- 跨日/跨会话自动重置（与 IPC `chatStreamHandler.ts` 一致）
- 错误分类：`isNetworkError` 区分网络故障与异常，避免回传 LLM/网络错误原始细节

### ✅ 1.5 CSP 收紧·style-src 'self'

**本次修复**：
- `types.ts` `SECURITY_HEADERS` 增加 `'Content-Security-Policy': "default-src 'self'"`
- `static.ts` `SECURITY_HEADERS` 同步副本同步更新
- 与 `renderer/index.html` meta CSP（`default-src 'self'; script-src 'self'; style-src 'self'; ...`）兼容（HTTP 响应头与 meta CSP 并存，浏览器取更严格者）
- API/SSE 响应本身不加载子资源，CSP 仅作为深度防御

### ✅ 1.6 枝叶层 2 次提取（ADR-017）

**本次修复**：
- `memoryRoutes.ts` / `systemRoutes.ts` 4 处 `Math.min(parseInt(...) || default, max)` 重复 → 提取 `parseLimitWithMax` 到 `types.ts`
- `parseLimitWithMax` 语义：超上限截断到上限（与 memoryRoutes/systemRoutes 原代码一致），与 sessionRoutes "越界返回默认值"语义不同
- **sessionRoutes 不复用** `parseLimitWithMax`：保留原代码 + 注释说明语义差异（ADR-017 隐含约束：相同语义才提取）

---

## 二、剪枝（已剪枝 Y=3 处）

### ✅ 2.1 ID 长度校验重复实现（memoryRoutes.ts）

**剪枝前**：6 处 `id.length > 500` 内联判断（relation-path / relation-neighbors / batch-delete / GET :id / DELETE :id / trash/restore / trash/:id）
**剪枝后**：统一使用 `shared/inputValidation.ts` 的 `isValidId(id)`
**收益**：消除 6 处重复，与 IPC handler 行为完全一致

### ✅ 2.2 分页参数解析重复（memoryRoutes + systemRoutes）

**剪枝前**：4 处 `Math.min(parseInt(...) || default, max)` + Number.isFinite 校验
**剪枝后**：提取 `parseLimitWithMax` 到 `types.ts`，4 处调用统一为 1 行
**收益**：消除 4 处重复，校验逻辑集中维护

### ✅ 2.3 未匹配路由回显 path（configRoutes + memoryRoutes + systemRoutes）

**剪枝前**：3 处 `sendError(res, 404, \`未找到 X 路由: ${method} ${path}\`)` 回显 path
**剪枝后**：统一改为 `sendError(res, 404, '404 Not Found')` + `logger.info` 记录到服务端日志
**收益**：消除信息泄露风险（path 可能含用户输入），与 chatStreamRoutes/sessionRoutes 已有约定对齐

---

## 三、提交前审查（已审查修复 Z=4 项）

### ✅ 3.1 P1 修复：memoryRoutes ID 校验未用 isValidId

**位置**：memoryRoutes.ts 6 处
**问题**：违反 `coding-convention-rules.md §3` "复制粘贴 `if` 判断——相同校验逻辑出现 2 次即抽工具函数"
**修复**：统一改用 `isValidId(id)`

### ✅ 3.2 P2 修复：分页参数解析重复

**位置**：memoryRoutes.ts (3 处) + systemRoutes.ts (1 处)
**问题**：违反 ADR-017 枝叶层 2 次提取原则
**修复**：提取 `parseLimitWithMax` 到 types.ts

### ✅ 3.3 P2 修复：未匹配路由回显 path

**位置**：configRoutes.ts:142 + memoryRoutes.ts:330 + systemRoutes.ts:462
**问题**：path 可能含用户输入，回显到响应体存在注入风险 + 泄露路由结构
**修复**：统一改为 `'404 Not Found'` 通用文案 + 服务端日志记录

### ✅ 3.4 P2 修复：CSP 头部缺失

**位置**：types.ts SECURITY_HEADERS + static.ts SECURITY_HEADERS 副本
**问题**：违反 `security_rules.md §7.1` "style-src 'self'"
**修复**：增加 `Content-Security-Policy: default-src 'self'`

### ✅ 3.5 P3 修复：safeRoute 错误处理不一致

**位置**：types.ts:141
**问题**：使用 `error instanceof Error ? error.message : String(error)`，与项目其他位置使用 `toError(error).message` 不一致
**修复**：改用 `toError(error).message`

---

## 四、验证结果

| 验证项 | 结果 |
|--------|------|
| TypeScript 编译（`tsc --noEmit`） | ✅ 0 错误 |
| Web 路由测试（`vitest run src/__tests__/web/routes/`） | ✅ 242/242 通过 |
| 测试文件影响 | types.test.ts（mock 补 toError + sendJson 断言加 CSP 头）/ memoryRoutes.test.ts / configRoutes.test.ts / systemRoutes.test.ts（3 处未匹配路由断言改为 '404 Not Found'） |

---

## 五、归档待办（K=3 项，归档到 tasks/待完成任务.md）

### P3 待自然生长触发

| ID | 任务 | 位置 | 建议 |
|----|------|------|------|
| WEB-0719-P1 | systemRoutes.ts LLM 测试路由回显 `error.message` 可能含 baseUrl/host 信息 | systemRoutes.ts:144 | 待自然生长触发：LLM 测试是用户主动调试场景，回显有助于排查。若出现安全审计要求，可分类脱敏（参考 chatStreamRoutes.ts `isNetworkError` 模式） |
| WEB-0719-P2 | systemRoutes.ts 动态 import `createLlmProvider`（顶部已静态 import 其他 memora 导出） | systemRoutes.ts:122 | 待自然生长触发：改为顶部静态 import 保持一致。当前动态 import 无功能性问题，仅风格不一致 |
| WEB-0719-P3 | `path === '/api/xxx' || path === '/api/xxx/'` 双路径兼容模式 7+ 处重复 | 所有路由文件 | 待自然生长触发：可在 index.ts 分发前规范化路径（去尾 /）。当前重复属公共路由基础设施，提取收益有限 |

---

## 六、与 Step 1-4 衔接

- Step 1-4 已完成 memora 内核 + sprite 主进程 + 控制器审查
- Step 5（本次）完成 sprite Web 服务层审查
- **下一步**：Step 6 — sprite 渲染层（面板与组件）审查

---

## 七、修改文件清单

| 文件 | 修改类型 | 行数变化 |
|------|----------|----------|
| `src/web/routes/types.ts` | 新增 `parseLimitWithMax` + SECURITY_HEADERS 加 CSP + safeRoute 用 toError | +41 行 |
| `src/web/routes/memoryRoutes.ts` | 6 处 ID 校验改 `isValidId` + 4 处分页用 `parseLimitWithMax` + 未匹配路由不回显 | -8 行 |
| `src/web/routes/configRoutes.ts` | 未匹配路由不回显 + 引入 logger | +2 行 |
| `src/web/routes/sessionRoutes.ts` | 注释说明为何不复用 parseLimitWithMax（语义不同） | +2 行 |
| `src/web/routes/systemRoutes.ts` | 1 处分页用 `parseLimitWithMax` + 未匹配路由不回显 | ±0 行 |
| `src/web/static.ts` | SECURITY_HEADERS 副本同步 CSP | +1 行 |
| `src/__tests__/web/routes/types.test.ts` | mock 补 toError + sendJson 断言加 CSP 头 | +9 行 |
| `src/__tests__/web/routes/memoryRoutes.test.ts` | 未匹配路由断言改 '404 Not Found' | ±0 行 |
| `src/__tests__/web/routes/configRoutes.test.ts` | 未匹配路由断言改 '404 Not Found' | ±0 行 |
| `src/__tests__/web/routes/systemRoutes.test.ts` | 未匹配路由断言改 '404 Not Found' | ±0 行 |

**净行数变化**：约 +47 行（含新增工具函数 + 注释 + 测试断言扩展）

---

_审查完成时间：2026-07-19_
_下一步：进入 Step 6（sprite 渲染层 - 面板与组件）_
