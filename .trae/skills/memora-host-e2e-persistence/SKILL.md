---
name: memora-host-e2e-persistence
description: 在 memora 双包架构（内核 @zooique/memora + VS Code 宿主）下，编写宿主侧端到端测试来验证「跨重启/跨进程持久化与自动恢复」类主张。当用户要验证 checkpoint/会话/记忆落盘、进程重启后自动恢复、或任何涉及真实宿主存储的持久化闭环时使用。
---

# memora 宿主侧端到端持久化验证

## 何时用

- 验证「暂停 → 关面板 → 重开」执行现场不丢（checkpoint 跨重启恢复）。
- 验证会话消息 / 记忆经宿主 `WorkspaceSessionStore`/`WorkspaceStorage` 真实落盘与回读。
- 任何需要**真实宿主存储**而非 mock 的持久化闭环断言。

## 架构铁律（先核实，再写）

1. **宿主测试跑的是「构建后内核」，不是 src。**
   `@zooique/memora` 是**指向内核根的符号链接**，但其 `package.json` `exports` 指向 `./dist/index.js`。
   所以宿主测试 import 的 `Agent` 来自 `dist/`。
   - 若内核 src 改过且要被测试覆盖，先同步：`cd <root> && npm run build`（`tsc -p tsconfig.build.json && tsc-alias`）。
   - 验证 dist 是否含目标行为：`grep -n "目标符号" dist/agent/agent.js`（如 `loadPersistedCheckpoint`）。
   - 不要在宿主测试里 `import` 内核 src 子路径（`exports` 未暴露子路径，只有 `.`）。

2. **`SessionManager` 在 `src/index.ts` 仅 `export type`（无 value 导出）。**
   不能 `new SessionManager(...)`。要验证持久化恢复，用**双 `Agent` 实例**共享同一真实 store：
   实例 A 写入落盘 → 构造全新实例 B（新的 store 对象但指向同一磁盘路径，`load()` 后传入 `new Agent(...)`）→ `await b.init()` 自动恢复。

3. **免 API Key：用 StubProvider 满足 `LlmProvider` 契约，不触发任何 chat。**
   ```ts
   class StubProvider {
     readonly name = 'stub';
     readonly supportsStructuredOutput = false;
     async *chat(_m: unknown[], _o?: unknown): AsyncIterable<LlmChunk> {}
   }
   const provider = new StubProvider() as unknown as LlmProvider;
   ```
   `init()` 与 `restoreFromCheckpoint()` 不调用 `provider.chat`，故安全。
   `LlmProvider`/`LlmChunk` 从 `@zooique/memora` 作 `type` 导入。

4. **`Agent` 构造最小契约**：`projectPath` + `provider` 必填；`configDir`/`dataDir`/`permission`/`allowedPaths`/`storage`/`sessionStore` 可选但建议给全。
   必须 `seedConfig(configDir)` 写一份最小 role-pack（`personas/default.md` + `rules/` 目录），否则 `init()` 加载失败。

## 真实存储落点

- `new WorkspaceSessionStore(workspacePath)` → 落盘 `workspacePath/.memora/sessions.json`（sessions/checkpoints/metas 三 map，同步 `atomicWriteFileSync`）。
- `new WorkspaceStorage(workspacePath)` → 记忆存储。
- 传入 Agent 前**必须** `store.load()`（从磁盘载入到内存 Map）。

## 测试骨架

```ts
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
vi.mock('vscode', () => ({ /* window/workspace/EventEmitter 桩 */ }));
import { Agent, type LlmProvider, type LlmChunk } from '@zooique/memora';
import { WorkspaceStorage } from '../workspaceStorage.js';
import { WorkspaceSessionStore } from '../sessionStore.js';

it('A 落盘 → B 跨重启恢复', async () => {
  // A: init → createCheckpoint → pause → close（flushCheckpoint 实时落盘）
  // 断言磁盘 sessions.json 含 { status:'paused', currentGoal, schemaVersion }
  // B: 新 WorkspaceSessionStore + WorkspaceStorage（同路径, load）→ new Agent → init()
  // 断言 b.sessionManager!.status === 'paused'、b.getCheckpoint() 字段不丢、b.resume() 闭合
});
```

## 质量门（宿主侧，根 node_modules 复用）

- 类型：`cd hosts/memora-vscode && ../../node_modules/.bin/tsc --noEmit -p ./`
- Lint：`../../node_modules/.bin/eslint . --ext .ts`（`__tests__` 目录被宿主 config 忽略，测试文件不进 lint 门）
- 单测：`node ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts src/extension/host/__tests__/<file>.test.ts`
- 全量：`... vitest.mjs run --config vitest.config.ts --no-file-parallelism`
- 格式：`../../node_modules/.bin/prettier --check <file>`

## 提交纪律（Windows，硬性）

- 用 **PowerShell**，禁用 Bash 跑 git 写操作（POSIX 沙箱 FS 视图错配会误报删除）。
- 门全绿后提交：`$env:LEFTHOOK='0'`（钩子体已在 PowerShell 下手动验过，跳过其 sh 子进程）；`git commit -F <utf8 文件>`（勿用 `-m` 中文引号/编码坑）；**手术式 `git add <绝对路径>`**，严禁 `git add -A`（曾误纳临时 `.git_*.txt`）。
- 删临时文件用 `-LiteralPath` + `Test-Path` 复验（safe-delete 不继承 cd，相对路径必失败）。
- git 管道中文/路径经 PowerShell 渲染成 `X`：落盘 UTF-8 文件再 `Read` 查看结果，勿盲信退出码显示。

## 反模式

- ❌ 在宿主测试里 `new SessionManager()`（仅 type 导出）→ 用双 Agent。
- ❌ 假设宿主测试跑 src（实际跑 dist）→ 改内核后先 build。
- ❌ 用真实 `createProvider`（需 API Key）→ 用 StubProvider。
- ❌ 忘记 `store.load()` → 新 store 内存为空，跨重启恢复读不到。
