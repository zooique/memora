# 方案 G8 · allowedPaths 动态管理

> 模式：方案更新（big-tree-grower 入口 1）。设计决策先文档化闭合，再由用户评审通过后落地。
> 设计纪律参照：D4（宿主缺口 ≠ 内核特性，不必逐条消费内核 API）、D5（安全决策必须显式）。

---

## 背景与目标

### 当前问题（对抗式复核实锤，2026-08-25）
- 宿主装配时 `allowedPaths` 被硬编码为 `[projectPath]`：`hosts/memora-vscode/src/extension/host/assemble.ts:235`（`allowedPaths: [projectPath]`）。
- 内核 **无** 任何运行时重配入口：`grep -rn "setAllowedPaths\|reconfigure" src/` → 零命中。
- `SecurityGuard.allowedRoots` 仅构造器注入：`src/security/pathGuard.ts:150,168-181`。
- 先例存在：`setConfirmWrites(value)` 已是运行时 setter（`src/security/pathGuard.ts:196`），宿主经 `agent.security.setConfirmWrites()` 热更新（`settingsPanel.ts:802`）。
- `allowedPaths` 当前只走 `AgentOptions`（`src/agent/types.ts:510`），**不经过配置文件** → 缺持久化层（内核 `loader.ts:154` 虽支持配置文件的 `allowedPaths`，但 VS Code 宿主绕过内核 config loader，直接经 `AgentOptions` 传入，见 `agent.ts:303`）。

### 目标
让用户在不重启 Agent 的前提下，**增删「项目目录之外的可信目录白名单」**，且变更持久化（重启后仍生效），同时：
1. 基准根（projectPath / memoraDir / configDir / agentDataDir）**永远不可被移除**（D5）。
2. 黑名单（`BLOCKED_PATTERNS`，`pathGuard.ts:39-76`）对新增路径**依然生效**（用户在白名单里加了 `.ssh` 仍被拒）。
3. 与 `setConfirmWrites`  precedent 同构，复杂度匹配，不抽多余抽象。

---

## 涉及范围

| 层 | 文件 | 改动性质 |
|----|------|---------|
| 内核 | `src/security/pathGuard.ts` | `allowedRoots` 拆 `baseRoots`+`extraRoots`；新增 `setAllowedPaths()` |
| 内核 | `src/security/__tests__/pathGuard.test.ts` | 新增 `setAllowedPaths` 单测 |
| 宿主 | `src/shared/protocol.ts` | 增 `allowed_paths_set`(W→E) / `allowed_paths_status`(E→W) |
| 宿主 | `src/extension/extension.ts` | 读 workspace 设置 `memora.allowedPaths`，并入 assemble 入参 |
| 宿主 | `src/extension/host/assemble.ts` | `allowedPaths` 由参数传入（合并 `[projectPath, ...persisted]`），替换硬编码 `[projectPath]` |
| 宿主 | `src/webview/panels/settingsPanel.ts` | 新增 `setAllowedPaths` 处理器 + `loadAllowedPathsStatus` |
| 宿主 | `src/webview/scripts/settingsView.ts` + `src/webview/panels/settingsPanel.ts` HTML | 白名单列表 UI（增/删/渲染） |
| 宿主 | 新增 focused 测试（镜像 G21 双 Agent 模式） | 验证运行时增删 + 持久化 |

**数据库变更：无。** 持久化走 VS Code `workspace.getConfiguration('memora')`（落 `.vscode/settings.json`）。

---

## 具体需求

### 1. 内核 `SecurityGuard.setAllowedPaths(extraPaths: string[]): void`
- **语义**：设置「用户额外白名单」。**不**包含基准根；基准根不可被此方法触碰。
- **实现**：
  - 构造器（`pathGuard.ts:155-182`）改为：`baseRoots = [projectPath, memoraDir, configDir?, agentDataDir?]`（均经 `resolveRealpath(expandHome(...))`）；`extraRoots = extraAllowedPaths.map(normalize)`；`allowedRoots = [...baseRoots, ...extraRoots]`。行为等价现有构造器（现有单测须全绿）。
  - `setAllowedPaths(extraPaths)`：
    1. 内联校验（**不** import `config/loader`，避免 security→config 反向依赖 / 环）：每个元素 `assertString`，截断到本地 `MAX_EXTRA_ALLOWED_PATHS = 50`（与 `loader.ts:35` 同值，常量就近定义）。非法元素抛 `configError`（fail-closed）。
    2. `this.extraRoots = extraPaths.map(p => resolveRealpath(expandHome(p)))`。
    3. `this.allowedRoots = [...this.baseRoots, ...this.extraRoots]`。
  - `setAllowedPaths([])` = 清空用户额外项，仅留基准根（合法，等于「重置」）。
- **不动**：`assertPathAllowed`（`pathGuard.ts:218`）逻辑零改——黑名单优先 + 白名单前缀匹配天然复用新 `allowedRoots`。

### 2. 不新增 Agent 层门面（复杂度匹配）
- 宿主直接走既有 `agent.security` getter（`src/agent/agent.ts:1793`）：`agent.security.setAllowedPaths(extras)`，与 `agent.security.setConfirmWrites(...)`（`settingsPanel.ts:802`）完全同构。**不**在 `Agent` 上加 `setAllowedPaths` 包装方法。

### 3. 宿主持久化（scope 决策）
- **采用**：`workspace.getConfiguration('memora').get<string[]>('allowedPaths', [])` —— 项目级、与 `memora.showMetrics`（`chatPanel.ts:1748`）同源 precedent，落 `.vscode/settings.json`。
- **语义对齐**：持久化值 = 「用户额外目录数组」，**不含** projectPath（基准根恒在）。
- **装配**：`extension.ts` 读取后传入 assemble；`assemble.ts:235` 改为 `allowedPaths: [projectPath, ...(persistedExtras ?? [])]`。
- **备选（评审时可翻）**：若担心 `.vscode/settings.json` 含机器绝对路径被误提交 → 改用 `globalState`（用户级、跨项目），但语义错位（白名单本应项目级）。**推荐维持 workspace scope**，并在评审备注提示「`.vscode/settings.json` 含机器特定路径，按需 gitignore」。

### 4. 协议消息（`protocol.ts`）
- W→E：`{ type: 'allowed_paths_set'; paths: string[] }` —— `paths` 为完整用户额外数组（webview 本地草稿增删后整体下发，host 为真理源）。
- E→W：`{ type: 'allowed_paths_status'; projectPath: string; paths: string[] }` —— 推送当前列表供初始渲染（`projectPath` 用于渲染只读基准行）。

### 5. 设置面板 UI（安全子视图，镜像 `security_status`/`security_toggle`）
- `settingsPanel.ts` 新增：
  - `setAllowedPaths(paths)`：① 持久化 `workspace.getConfiguration('memora').update('allowedPaths', paths, vscode.ConfigurationTarget.Workspace)`；② `agent.security.setAllowedPaths(paths)`（热更新）；③ `post({type:'allowed_paths_status', projectPath, paths})` + 成功/失败 notice（try/catch 同 `toggleConfirmWrites` 形态，`settingsPanel.ts:795-818`）。
  - `loadAllowedPathsStatus()`：读 workspace 设置 → `post allowed_paths_status`（设置视图 ready 时调用，同 `loadSecurityStatus` 形态，`settingsPanel.ts:825-828`）。
- `settingsView.ts` + HTML：安全子视图增「允许路径白名单」区：
  - 只读行：`projectPath`（基准，灰显，无删除）。
  - 动态行：每个 extra 路径 + ✕ 删除按钮。
  - 「添加路径」输入框 + 按钮 → 本地草稿增/删 → 下发 `allowed_paths_set` 完整数组。
  - 消费 `allowed_paths_status` 重渲列表。

### 6. 测试
- **内核单测**（`pathGuard.test.ts`）：
  1. `setAllowedPaths([extra])` 后 `assertPathAllowed(join(extra,'x'))` 不抛。
  2. `setAllowedPaths([])` 后原 extra 路径 `assertPathAllowed` 抛「越界」。
  3. `setAllowedPaths([extra])` 后 `projectPath` 内路径仍通过（基准根未被移除）。
  4. 黑名单仍生效：extra 指向含 `.env` 的目录，`assertPathAllowed` 仍被 `BLOCKED_PATTERNS` 拒。
- **宿主 focused 测试**（镜像 G21 双 Agent + StubProvider 免 Key）：
  - 实例 A：`workspace.getConfiguration` 注入 `allowedPaths:['/tmp/extra']` → assemble → `agent.security.assertPathAllowed(extraPath)` 通过。
  - 运行时 `agent.security.setAllowedPaths(['/tmp/another'])` → 旧 extra 失效、新 extra 生效。
  - 验证持久化：读 `workspace.getConfiguration('memora').get('allowedPaths')` 等于写入值。
  - ⚠️ host 测试跑 **built kernel**，落地前须先 `npm run build`（重建 dist）使 `setAllowedPaths` 进入 `dist/`。

---

## 约束条件

- **D5 安全显式**：基准根不可移除；非法输入 fail-closed 抛错；黑名单对新增路径强制生效。
- **内核/host 边界**：持久化是宿主职责（宿主决定信任哪些目录）；内核 API 仅热更新活体 `SecurityGuard`，不碰存储。
- **分层洁净**：`security/` 不得 import `config/`（防环）→ `setAllowedPaths` 内联轻量校验，不复用 `loader.ts` 的 `validateAllowedPaths`。
- **零破坏**：构造器行为等价（现有 `pathGuard.test.ts` 全绿）；`Agent` 公共 API 形态不变（仅复用既有 `security` getter）。
- **质量门**（落地时串行执行）：
  - 内核：`tsc -p tsconfig.build.json`（build）→ `npx vitest run src/security` → `npx tsc --noEmit` → `eslint --max-warnings 0`。
  - 宿主：**先** `npm run build` 内核（dist 同步）→ `npx tsc --noEmit` → `eslint --max-warnings 0` → `npx vitest run`。
  - Windows 提交纪律：PowerShell；`$env:LEFTHOOK='0'`；`git commit -F <utf8 文件>`；surgical `git add <绝对路径>`（禁 `git add -A`）。

---

## 对抗式审查 · 风险与反驳

| 风险 | 反驳 / 缓解 |
|------|------------|
| R1 `setAllowedPaths` 误删基准根 | `baseRoots` 与 `extraRoots` 分离，`setAllowedPaths` 只写 `extraRoots`，`baseRoots` 永不被触碰（需求 1）。单测 3 锁死。 |
| R2 用户加了危险路径（如 `/etc`） | `assertPathAllowed` 黑名单优先（`pathGuard.ts:224-241`）仍拦截；单测 4 验证。白名单是「允许列表」非「绕过黑名单」。 |
| R3 符号链接逃逸 | `setAllowedPaths` 复用 `resolveRealpath(expandHome(p))`（`pathGuard.ts:20-37`），与构造器同防护。 |
| R4 持久化 scope 选错导致泄漏 | 推荐 workspace scope + 备注 gitignore；评审可翻 globalState。语义上白名单本应项目级。 |
| R5 抽了不必要的 Agent 门面 | 已决策复用 `agent.security` getter，与 `setConfirmWrites` 同构，不新增抽象（复杂度匹配）。 |
| R6 host 测试跑旧 kernel（dist 未同步） | 落地步骤强制「先 build 内核再跑 host 测试」；G21 已踩过此坑并记入记忆。 |

---

## 分步实施序（自底向上 / 风险前置 / 验证后置）

1. **[内核·风险最高先打]** `pathGuard.ts`：`baseRoots`/`extraRoots` 拆分 + `setAllowedPaths`；跑内核单测 + build。
2. **[内核·文档]** `SecurityGuard` JSDoc 补 `setAllowedPaths` 契约（无破坏性变更）。
3. **[宿主·协议]** `protocol.ts` 增两消息（独立、小）。
4. **[宿主·装配]** `extension.ts` 读 workspace 设置 → 传 assemble；`assemble.ts:235` 改参数化。
5. **[宿主·面板]** `settingsPanel.ts` 增 `setAllowedPaths` + `loadAllowedPathsStatus`。
6. **[宿主·UI]** `settingsView.ts` + HTML 白名单列表（增/删/渲染）。
7. **[宿主·测试]** focused 测试（需先 build 内核）。
8. **[验证]** 内核 + 宿主质量门全绿 → surgical 提交（每文件独立 commit 或按 phase 合并 commit）。
