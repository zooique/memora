# Step 5 审查报告 · Sprite 宿主 Web 服务层

> **审查日期**：2026-07-19
> **审查范围**：`hosts/memora-sprite/src/web/`（11 文件，~2200 行）
>   - 路由层 7 文件：`routes/index.ts`, `types.ts`, `chatStreamRoutes.ts`, `configRoutes.ts`, `memoryRoutes.ts`, `sessionRoutes.ts`, `systemRoutes.ts`
>   - 入口层 4 文件：`server.ts`, `static.ts`, `webContext.ts`, `preloadWeb.ts`
> **审查方式**：凭工程经验审查，不依赖项目规则
> **前序步骤**：Step 1-4 已完成

---

## 总体评分

| 维度 | 评分 | 说明 |
|------|------|------|
| 路由设计 | 8.5/10 | RESTful 语义清晰，少量命名/归属可优化 |
| SSE 流式 | 8.0/10 | 超时/中断/错误处理完整，缺 backpressure |
| 输入校验 | 7.5/10 | 核心校验到位，部分边界值/类型校验缺失 |
| 错误处理 | 7.5/10 | 4xx/5xx 分类正确，但多处泄漏原始错误信息 |
| 中间件链 | 7.0/10 | 无中间件抽象，路由分发手动展开 |
| CSP/CORS | 7.0/10 | CSP 收紧到位，但 SECURITY_HEADERS 重复定义 |
| 分层清晰度 | 9.0/10 | 路由层薄，业务逻辑在 sprite 核心层 |
| 日志安全 | 7.5/10 | 不回显敏感路径，但缺统一请求日志 |
| 性能 | 7.0/10 | 存在 N+1 查询 |
| 类型安全 | 7.0/10 | strict 模式，但多处类型断言和降级暴力转换 |
| **综合** | **7.5/10** | 整体质量良好，安全问题集中在错误信息泄漏和 SECURITY_HEADERS 同步 |

---

## 设计评价

Web 服务层是项目中最"干净"的模块之一。设计思路清晰：

1. **零新增依赖**：使用 Node.js 原生 `http` 模块，不引入 Express/Fastify，与内核"零依赖"哲学一脉相承
2. **镜像 IPC 层**：每个路由文件与 `electron/ipc/` 下同名 handler 一一对应，消费同一 `HostContext`，双模式并行零业务逻辑重复
3. **薄路由设计**：路由层只做 HTTP 适配（解析参数 → 调用 sprite → 返回 JSON），业务逻辑全在 sprite 核心层
4. **降级友好**：Agent 未就绪时路由层返回 503，静态文件服务不受影响，用户可进入设置页配置 LLM

整体来看，这是一个**设计意图明确、实现纪律良好**的模块。问题集中在"鸡蛋里挑骨头"级别的细节打磨。

---

## 亮点

1. **SSE 流式实现完整**：`chatStreamRoutes.ts` 覆盖了无进展超时兜底（60s）、客户端断开检测（`req.on('close')`）、`abortedNotified` 单点路由防重复、`finally` 清理 AbortController 等，错误分类（`isNetworkError`）区分网络故障和业务异常

2. **`parseLimitWithMax` 消除重复**：将分页参数校验（`parseInt` + `Number.isFinite` + `Math.min`）统一为公共函数，4+ 处调用点受益，符合 ADR-017 枝叶层 2 次提取原则

3. **安全响应头统一注入**：`SECURITY_HEADERS` 覆盖 X-Content-Type-Options、X-Frame-Options、Referrer-Policy、CSP，所有 JSON 响应通过 `sendJson` 统一注入，SSE/静态文件各自展开

4. **404 不回显路径**：所有路由的 404 分支返回 `'404 Not Found'` 而非 `未找到 API 路径: ${path}`，防止注入和路由探测

5. **优雅关闭**：`server.ts` 的三阶段关闭（中断对话 → 关闭 HTTP → 清理资源）+ 单阶段 5s 超时 + 总体 15s 兜底，防止进程卡死

6. **preloadWeb.ts 流式接收竞态保护**：`activeSseAbortController === thisController` 引用比对，防止旧流 finally 错误清理新流 controller

---

## 问题清单

### P0（阻塞级，必须修复）

无。

### P1（高风险，建议修复）

#### QC-1: `safeRoute` 错误信息泄漏内部细节

**位置**：[routes/types.ts#L151](file:///f:/zooique/memora/hosts/memora-sprite/src/web/routes/types.ts#L151)

```typescript
// 当前
sendError(res, 500, `${context}失败: ${message}`);
```

`message` 来自 `toError(error).message`，可能包含文件系统路径、SQL 错误等内部细节。当 `error` 为 `SpriteError` 时 message 可控，但其他异常（如 `fs.readFile` 抛出的 `ENOENT`）会直接暴露。

**建议**：区分 `SpriteError`（已知错误，可回传 message）和未知异常（回传通用文案）。

```typescript
// 建议
const isKnownError = error instanceof SpriteError;
const clientMessage = isKnownError
  ? `${context}失败: ${message}`
  : `${context}失败，请稍后重试`;
sendError(res, 500, clientMessage);
```

#### QC-2: `POST /api/llm-config/test` 泄漏原始错误

**位置**：[systemRoutes.ts#L144](file:///f:/zooique/memora/hosts/memora-sprite/src/web/routes/systemRoutes.ts#L144)

```typescript
// 当前
sendJson(res, 200, { success: false, error: toError(error).message });
```

LLM 连接测试失败时，`toError(error).message` 可能包含 API endpoint URL、hostname 等敏感信息。同样问题存在于 L178（saveLlmConfig）、L209（saveLlmProvider）、L225（deleteLlmProvider）、L271（setActiveLlmProvider）。

**建议**：使用 `isNetworkError` 分类（chatStreamRoutes 已有此函数），或统一使用 `shared/llmErrorClassifier.ts` 的分类映射。

#### QC-3: `SECURITY_HEADERS` 双副本同步风险

**位置**：[routes/types.ts#L35-L41](file:///f:/zooique/memora/hosts/memora-sprite/src/web/routes/types.ts#L35-L41) 和 [static.ts#L46-L51](file:///f:/zooique/memora/hosts/memora-sprite/src/web/static.ts#L46-L51)

两个文件各自定义了内容相同的 `SECURITY_HEADERS` 常量。虽然注释说明了同步要求，但无编译期强制校验。如果未来修改 CSP 只改了一处，会产生安全漏洞。

**建议**：将 `SECURITY_HEADERS` 提取到 `routes/types.ts` 作为唯一真理源，`static.ts` 和 `server.ts` 从 `routes/types.ts` 导入。当前的反向依赖顾虑（"web 入口层不反向依赖 routes 子层"）可以通过将常量提升到 `web/` 根级文件（如 `web/securityHeaders.ts`）解决。

#### QC-4: 会话列表 N+1 查询

**位置**：[sessionRoutes.ts#L46-L56](file:///f:/zooique/memora/hosts/memora-sprite/src/web/routes/sessionRoutes.ts#L46-L56)

```typescript
// 当前：对每个 session 调用 countMessages + loadMessagesPaginated
const result = sessions.map((sessionId) => {
  const messageCount = ctx.sessionStore.countMessages(date, session);
  const messages = ctx.sessionStore.loadMessagesPaginated(date, session, 1, ...);
  // ...
});
```

假设 30 个 session，产生 60 次 SQLite 查询。当会话数量增长到 100+ 时，响应时间会明显增加。

**建议**：在 `SessionStore` 层新增 `listSessionsWithPreview()` 方法，用一条 SQL（`GROUP BY` + `MAX(timestamp)`）批量获取预览数据。

### P2（中等风险，建议在后续迭代修复）

#### QC-5: SSE 无 backpressure 处理

**位置**：[chatStreamRoutes.ts#L74-L82](file:///f:/zooique/memora/hosts/memora-sprite/src/web/routes/chatStreamRoutes.ts#L74-L82)

```typescript
function writeSSE(res: ServerResponse, eventName: string, data: unknown): void {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  // ...
}
```

`res.write()` 返回 `boolean` 表示内部缓冲区是否已满（需要暂停写入），但代码未检查返回值。在高频 chunk 场景（如 LLM 快速输出短 token），可能导致内存积压。

**建议**：检查 `res.write()` 返回值，`false` 时监听 `res` 的 `'drain'` 事件后再继续。

#### QC-6: 关系操作参数校验不足

**位置**：[memoryRoutes.ts#L157-L162](file:///f:/zooique/memora/hosts/memora-sprite/src/web/routes/memoryRoutes.ts#L157-L162)

```typescript
// POST /api/memories/relation
const body = await parseJsonBody<{ sourceId: string; targetId: string; type: string; weight: number }>(req);
if (!body?.sourceId || !body?.targetId) {
  sendError(res, 400, 'sourceId 和 targetId 必填');
  return;
}
ctx.sprite.addRelation(body.sourceId, body.targetId, body.type, body.weight);
```

`body.type` 和 `body.weight` 无任何校验。`type` 可能为任意字符串（应限定为合法关系类型），`weight` 可能为 `NaN`/`Infinity`（`typeof NaN === 'number'` 会通过）。

**建议**：
- `type` 校验：限定为已知关系类型枚举
- `weight` 校验：`Number.isFinite(body.weight)` 和范围检查

#### QC-7: 记忆添加字段长度无上限

**位置**：[memoryRoutes.ts#L193-L199](file:///f:/zooique/memora/hosts/memora-sprite/src/web/routes/memoryRoutes.ts#L193-L199)

```typescript
// POST /api/memories
const body = await parseJsonBody<{ source: string; name: string; content: string }>(req);
if (!body?.source || !body?.name || !body?.content) {
  sendError(res, 400, 'source、name、content 必填');
  return;
}
```

`source`、`name`、`content` 只有非空检查，没有长度上限。恶意请求可发送 10MB 的 `content` 字段（`parseJsonBody` 限制 10MB 整体），但 10MB 的纯文本存储到记忆系统可能造成问题。

**建议**：添加字段级长度上限（如 `source` ≤ 500, `name` ≤ 500, `content` ≤ 100KB）。

#### QC-8: `purge` 操作 `retentionDays` 无下限校验

**位置**：[memoryRoutes.ts#L258-L264](file:///f:/zooique/memora/hosts/memora-sprite/src/web/routes/memoryRoutes.ts#L258-L264)

```typescript
const retentionDays = body?.retentionDays ?? 30;
const before = new Date(Date.now() - retentionDays * MS_PER_DAY);
```

`retentionDays` 为 0 或负数时，`before` 为未来时间，`purgeExpired` 可能清空所有记忆。

**建议**：`retentionDays` 最小值为 1（至少保留 1 天），`Number.isFinite` 校验。

#### QC-9: `GET /api/sessions` 中正则匹配失败会静默吞掉 session

**位置**：[sessionRoutes.ts#L49-L51](file:///f:/zooique/memora/hosts/memora-sprite/src/web/routes/sessionRoutes.ts#L49-L51)

```typescript
const match = sessionId.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
if (!match) return null;
```

`sessions.map()` 中 `return null` 后被 `.filter()` 过滤。如果 `sessionId` 格式不合法（如迁移残留数据），该 session 会被静默隐藏，用户无法感知。

**建议**：格式不匹配时返回 `id: sessionId, name: sessionId, preview: '(格式异常)', messageCount: 0` 而非 `null`，让用户看到异常数据并排查。

#### QC-10: `server.ts` 降级 HostContext 使用暴力类型断言

**位置**：[server.ts#L341-L351](file:///f:/zooique/memora/hosts/memora-sprite/src/web/server.ts#L341-L351)

```typescript
// 降级 HostContext：Agent 未就绪时路由层返回 503
agent: null as unknown as Agent,
sprite: null as unknown as Sprite,
sessionStore: null as unknown as SqliteSessionStore,
```

`null as unknown as Agent` 是三重类型断言，绕过了 TypeScript 的所有类型检查。如果路由层未正确检查 `isAgentReady()` 就访问 `ctx.agent`，会在运行时崩溃。

**建议**：将 `HostContext` 的 `agent`/`sprite`/`sessionStore` 改为可选字段（`Agent | null`），路由层在访问前判空。这需要修改 `shared/hostContext.ts` 的接口定义，工作量稍大，但类型安全收益显著。

### P3（低风险，归档即可）

#### QC-11: `writeSSE` 使用 `as unknown as` 类型断言

**位置**：[chatStreamRoutes.ts#L79-L81](file:///f:/zooique/memora/hosts/memora-sprite/src/web/routes/chatStreamRoutes.ts#L79-L81)

```typescript
if (typeof (res as unknown as { flush?: () => void }).flush === 'function') {
  (res as unknown as { flush: () => void }).flush();
}
```

Node.js 的 `ServerResponse` 类型不包含 `flush` 方法，但某些场景下底层 socket 可能支持。可以通过 `(res as any).flush?.()` 简化，或定义更精确的类型。

#### QC-12: `parseJsonBody` 中 `chunk as Buffer` 类型断言

**位置**：[types.ts#L89](file:///f:/zooique/memora/hosts/memora-sprite/src/web/routes/types.ts#L89)

```typescript
chunks.push(chunk as Buffer);
```

`IncomingMessage` 的 `for await` 迭代器返回 `Buffer`，但 TypeScript 类型定义可能不精确。可改用 `Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)` 替代类型断言。

#### QC-13: `static.ts` 中 `existsSync` + `readFile` 存在 TOCTOU 竞态

**位置**：[static.ts#L63-L72](file:///f:/zooique/memora/hosts/memora-sprite/src/web/static.ts#L63-L72)

```typescript
if (!existsSync(filePath)) {
  res.writeHead(404, ...);
  return;
}
const content = await readFile(filePath);
```

`existsSync` 和 `readFile` 之间文件可能被删除。`readFile` 本身会抛 `ENOENT`，可以去掉 `existsSync` 检查，直接用 `try/catch` 处理 `readFile` 的 `ENOENT`。

#### QC-14: `preloadWeb.ts` 的 `stripTypeAnnotations` 正则转译不完善

**位置**：[webContext.ts#L132-L149](file:///f:/zooique/memora/hosts/memora-sprite/src/web/webContext.ts#L132-L149)

注释已标注"Phase 2 用 Vite 后此函数可删除"，当前作为 esbuild 不可用时的降级方案，风险可控。

#### QC-15: 非流式分支无超时保护

**位置**：[chatStreamRoutes.ts#L427-L521](file:///f:/zooique/memora/hosts/memora-sprite/src/web/routes/chatStreamRoutes.ts#L427-L521)

非流式分支（`stream: false`）直接 `for await` 消费 `agent.chat()`，没有超时保护。如果 LLM 卡住，HTTP 请求会一直挂起直到 TCP 超时。但 `stream: false` 场景极少使用（默认 `stream: true`），风险低。

---

## 模块评分

| 文件 | 行数 | 评分 | 说明 |
|------|------|------|------|
| `routes/index.ts` | 98 | 8.5/10 | 路由分发清晰，404 安全 |
| `routes/types.ts` | 209 | 9.0/10 | 工具函数设计良好，`parseLimitWithMax` 是亮点 |
| `routes/chatStreamRoutes.ts` | 522 | 8.5/10 | SSE 流式实现完整，超时/中断/错误处理全面 |
| `routes/configRoutes.ts` | 146 | 8.5/10 | 薄路由，校验到位 |
| `routes/memoryRoutes.ts` | 336 | 8.0/10 | 路由最多覆盖完整，参数校验略有不足 |
| `routes/sessionRoutes.ts` | 229 | 7.5/10 | N+1 查询，正则静默过滤 |
| `routes/systemRoutes.ts` | 465 | 7.5/10 | 功能最多，但多处错误信息泄漏 |
| `server.ts` | 439 | 8.5/10 | 优雅关闭设计优秀，降级 HostContext 类型断言暴力 |
| `static.ts` | 92 | 8.0/10 | 简洁，TOCTOU 竞态 |
| `webContext.ts` | 167 | 8.0/10 | esbuild 降级方案合理 |
| `preloadWeb.ts` | 943 | 8.0/10 | 流式接收竞态保护好，多处 `as Type` 断言 |

---

## 修复优先级建议

| 优先级 | 编号 | 问题 | 预计工作量 |
|--------|------|------|-----------|
| P1 | QC-3 | SECURITY_HEADERS 双副本同步 | 30 分钟 |
| P1 | QC-1 | safeRoute 错误信息泄漏 | 15 分钟 |
| P1 | QC-2 | LLM 配置路由错误信息泄漏 | 20 分钟 |
| P1 | QC-4 | 会话列表 N+1 查询 | 60 分钟 |
| P2 | QC-6 | 关系操作参数校验 | 15 分钟 |
| P2 | QC-7 | 记忆添加字段长度上限 | 10 分钟 |
| P2 | QC-8 | purge retentionDays 下限 | 5 分钟 |
| P2 | QC-5 | SSE backpressure | 30 分钟 |
| P2 | QC-9 | 会话格式异常静默过滤 | 10 分钟 |
| P2 | QC-10 | 降级 HostContext 类型安全 | 60 分钟 |

---

## 与前序步骤对比

| 维度 | Step 1-2 (内核) | Step 3-4 (精灵核心) | Step 5 (Web 服务层) |
|------|----------------|---------------------|---------------------|
| 代码质量 | 高（纯逻辑库） | 中高（核心+控制器） | 中高（传输层适配） |
| 问题密度 | 低 | 中 | 中 |
| 主要风险 | 接口设计 | 业务逻辑正确性 | 安全（信息泄漏） |
| 亮点 | 架构清晰 | 镜像 IPC 设计 | 薄路由 + SSE 完整 |

---

## 总结

Web 服务层是一条"设计好、实现干净"的传输通道。核心架构决策（零依赖、镜像 IPC、薄路由）是正确的。问题集中在**安全细节**（错误信息泄漏、SECURITY_HEADERS 同步）和**性能边界**（N+1 查询、backpressure），属于"打磨"而非"重构"级别。

建议优先修复 P1 的 4 个问题（QC-1~4），总计约 2 小时工作量，可显著提升安全性和性能。

---

> **下一步**：Step 6 — sprite 渲染层（面板与组件）