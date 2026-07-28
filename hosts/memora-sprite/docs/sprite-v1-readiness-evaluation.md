# Memora Sprite — v1 发布就绪度评估

> 评估日期：2026-07-28 · 评估对象：`hosts/memora-sprite`（当前 `package.json` 版本 **1.3.0**）
> 方法：第一性原理 + 对抗式核查（实测门禁 + 代码/git 取证，不靠记忆估算）

## 一、结论（TL;DR）

**当前未达可发布的「绿门」状态。** 生产代码本身健康（类型 / ESLint / 样式 / 配置同步全绿，已知数据损坏风险已闭环），但存在三处发布短板：

1. 🔴 **测试套件 RED**：87 失败 / 4544 通过（2 个文件）。这是**硬性阻断项**——CI 会挂，且这批测试已失去对"委托映射正确性"的真实守护。
2. 🟠 **桌面应用缺用户向 `PRIVACY.md` / `README.md`**（仅有 `CHANGELOG.md` + `docs/` 内部设计稿）。
3. 🟠 **覆盖率阈值（80%/75%）未接入默认 `test` 门**，形同虚设。
4. 备注：当前版本已是 1.3.0，`release/` 已存在 `Memora Sprite Setup 1.3.0.exe`；本次为质量审计，"第一版"实际早已越过。

---

## 二、质量门实测（`hosts/memora-sprite`）

| 门禁 | 命令 | 结果 |
|------|------|------|
| 类型检查（core） | `npm run typecheck` | ✅ GREEN |
| 类型检查（electron） | `npm run typecheck:electron` | ✅ GREEN |
| 类型检查（web） | `npm run typecheck:web` | ✅ GREEN |
| ESLint | `eslint . --ext .ts` | ⚠️ 原 RED（3 错误）→ **已修** → ✅ GREEN |
| Stylelint（lint:css） | `stylelint "src/electron/renderer/styles/**/*.css"` | ✅ GREEN（无幻影 token） |
| IPC 通道同步 | `check-ipc-channels` | ✅ GREEN |
| CLI 配置键同步 | `check-cli-config-keys` | ✅ GREEN |
| 测试 | `vitest run` | ❌ **RED：87 失败 / 4544 通过（4631）** |
| 覆盖率 | `vitest run --coverage` | ⚠️ 阈值已定义但**默认 `test` 不收集覆盖**，不强制 |

> ESLint 原 3 处错误：`errors.ts` / `storageError.ts` 缺 `import type`；`uiDelegations.test.ts` 的 Proxy `receiver: any`。均已修复（import type + `unknown`），门禁现绿。

---

## 三、测试失败根因（对抗式确认）

### 现象
`vitest run`：**Test Files 2 failed | 136 passed (138)**；**Tests 87 failed | 4544 passed (4631)**。
- 文件 1：`src/__tests__/electron/renderer/uiDelegations.test.ts` — **86 失败**
- 文件 2：`src/__tests__/electron/renderer/settingsOrchestrator.test.ts` — **1 失败**

### 根因：HEAL-16 协调器重构落地后，测试断言未同步

git 提交证明重构是**刻意且已完成**的：
- `ec50942c` refactor(sprite): HEAL-16 Phase 4 — SettingsCoordinator 提取
- `14ca555e` refactor(ui): 实施 MemoryCoordinator 协调器重构
- `cb2df729` refactor(ui): 提取ChatCoordinator协调器优化UIManager结构
- `538b0ba2` refactor(sprite): HEAL-11 — PerceptionCoordinator 提取

生产代码已改为**经协调器转发**：
- `settingsModalDelegations.ts:74` → `this.settingsCoordinator.settingsPanelManager.loadEmbeddingConfig(data)`
- `settingsOrchestrator.ts:219` → `uiManager.settingsCoordinator.settingsPanelManager.loadProviderList()`
- 以及 `this.memoryCoordinator.profilePanel / auditPanel`、`this.chatCoordinator.inputAreaManager` 等

但测试断言仍指向**重构前的直接属性**：
- `uiDelegations.test.ts:1033` → `expect(mock.settingsPanelManager.loadEmbeddingConfig)...`
- `settingsOrchestrator.test.ts:264` → `expect(uiManager.settingsPanelManager.loadProviderList)...`

`createMockThis()` 是一个**通用深 Proxy**（任意属性访问返回独立的 `vi.fn()` 嵌套 mock），因此生产调用被记录在 `*.settingsCoordinator.settingsPanelManager.X` 路径，而断言查的是 `*.settingsPanelManager.X` 路径 → 全部 "0 calls"。

**已用 `git stash` 验证**：stash 掉本人本次 3 处编辑后，`uiDelegations.test.ts` 仍 **86 失败**，证明失败先于本次修改、非我引入。

### 判定
**生产代码正确且自洽；87 个失败全部是测试陈旧（stale）所致，非功能回归。** 但红门即红门——不可发布。

---

## 四、其他发布就绪度发现

1. **文档缺口（🟠）**：sprite 宿主层只有 `CHANGELOG.md` + `docs/` 内部设计稿（如 `场景闭环设计.md`、`memory-ui-visual-language.md` 等），**无用户向 `README.md` / `PRIVACY.md`**。仓库根级的 `README.md` / `PRIVACY.md` 属于内核 npm 包（`@zooique/memora`），不是桌面应用文档。对一款会访问**剪贴板、窗口标题（nut-js / koffi）、本地 SQLite 记忆**的桌面应用，缺 `PRIVACY.md` 是信任 / 合规短板。

2. **覆盖门未强制（🟠）**：`test` 脚本是 `vitest run`，未传 `--coverage`；`vitest.config.ts` 里的 80%/75% 阈值仅在 `--coverage` 时生效。建议把 `test` 改为 `vitest run --coverage`（或 CI 单独强制），否则"测试绿"不保证"≥ 基线覆盖"。

3. **数据损坏风险已闭环（🟢）**：早期 `saveSpriteConfig` 双写不同步已通过 `persistWindowConfig` 统一入口收敛（`main.ts:189`）。就绪路径统一走 `updateConfigBatch`（同步 `this.config`）；`spriteConfigManager` 始终写完整 `this.config`；`main.ts:193` 仅 sprite 未就绪时的 fallback。损坏有 `.corrupted.<ts>` 备份 + `0o600` + 原子写。无残留数据损坏路径。

4. **代码卫生（🟢）**：`console.*` 集中在 CLI / errorHandler（eslint 对 CLI 放行，合理）；生产代码 **0 处 `any`**（`no-explicit-any:error` 强制）；**0 处空 catch**；`TODO/FIXME` 仅 5 处。强。

5. **平台范围（🟠/待定）**：`release/` 仅有 Windows 产物（NSIS 安装包 + `app.asar` + `.blockmap` 增量更新）。mac / linux 脚本存在但无产物。若 v1 仅 Windows，则 OK；若跨平台，需补构建验证。

---

## 五、发布判定与修复路径

### 阻断项（must-fix，不修不能发）
- **绿化测试套件**。87 个失败源于同一重构，修复是机械性的"对齐断言到协调器路径"：
  - `uiDelegations.test.ts`：`mock.settingsPanelManager.X` → `mock.settingsCoordinator.settingsPanelManager.X`；`mock.auditPanel` / `mock.profilePanel` → `mock.memoryCoordinator.auditPanel` / `mock.memoryCoordinator.profilePanel`；`mock.chatPanel` / `mock.inputAreaManager` → 对应 `mock.chatCoordinator.*`；等等（每个委托方法的目标需逐一对照 production 的 delegation 文件）。
  - `settingsOrchestrator.test.ts:264`：`uiManager.settingsPanelManager.loadProviderList` → `uiManager.settingsCoordinator.settingsPanelManager.loadProviderList`。
  - 完成后 `vitest run` 应转绿（预计 0 失败）。

### 建议项（should-fix，发前补）
- 补 sprite 宿主层 `README.md`（安装 / 使用 / 构建）与 `PRIVACY.md`（数据流向、本地存储、剪贴板 / 窗口标题访问说明）。
- 将覆盖率阈值接入默认 `test` 门（或 CI 强制 `--coverage`）。
- 明确 v1 平台范围；若跨平台，补 mac / linux 打包并验证。

### 本次已处理
- ESLint 3 处错误已修复（`errors.ts` / `storageError.ts` 补 `import type`；`uiDelegations.test.ts` `receiver: any` → `unknown`），门禁现绿。

---

## 六、一句话总结

精灵的"骨架与血肉"是健康的，但**测试这层免疫系统的探针还停留在上一版架构**，导致红门。修测试、补隐私文档、把覆盖门焊死，即可达到 v1 发布质量。
