# 项目长期记忆（memora 样式系统）

## 样式系统审计方法论（可复用，避免再踩坑）
- **统计「硬编码色」必须排除 `tokens.css` 的定义值**：`--red: #dc2626` 是 token 定义不是泄露。脚本里先 `var_re.sub('', text)` 去掉 `var(...)`（含 fallback 颜色），再对剩余文本找色值；且遍历文件时跳过 `foundation/tokens.css`。否则会把定义值误计为硬编码色（曾误报 157→真实 3）。
- **「重复选择器」多为误报**：`.x` 出现在 2+ 文件时，先确认是「基类重定义」还是「后代作用域覆写 / `:focus-visible` 状态扩展 / `animation` 钩子」。后者合法，不算真重复。
- **csstools stylelint 插件不跨 glob 聚合 `:root`**：`stylelint-value-no-unknown-custom-properties` 只在单文件沿 `@import` 聚合，整目录 glob 会把全部合法 token 误报为 unknown（曾误报 3260 条）；跨文件 token 必须用 `importFrom` 绝对路径（`.mjs` 配置用 `fileURLToPath`）提供，或给叶子文件加 `@import tokens.css`。验证守卫有效性时务必注入幻影 token 到叶子文件确认能抓到（避免假绿）。
- **对抗式核查习惯**：grep 实测优先于记忆估算；每轮 R 改完跑 `tsc --noEmit` + grep 回归（确认 graph 文件无实际规则、新类均被使用）。
- **CSS 批量迁移脚本必须保留 `/* */` 注释定界符**：按 `/*` 切分注释片段时若把 `/*` opener 一并消费，会导致整文件注释定界符被删除（曾把 27 文件「损坏」成 1428/1428 diff）；正确做法是注释片段从 `/*` 起到 `*/` 止原样保留、仅对 code 片段做替换，并跨行维护 in_comment 状态以覆盖多行注释块。

## 设计令牌与架构约定（ADR）
- 三层 scope：L1 全局基础（foundation/）/ L2 面板前缀 / L3 组件；BEM；单文件单真理源。
- 双主题：`:root` 浅色，`[data-theme="dark"]` 深色。颜色/阴影/z-index 已 100% token 化（实测）。
- 控件收口：`.card`、按钮系统、`.input`/`.input--pill`/`.input-with-action`、标签系统均在 `foundation/controls.css`（L1 单一真理源）。
- 记忆面板洞察栏/健康度栏样式已抽到 `memory/insights.css` + `memory/health.css`（从 graph 文件迁出，聚合器 `memory.css` 在 `completion-stats.css` 前 @import）。

## 已知小债（迭代 backlog）
- ~~`--success-10` token 缺失（chat-messages-input.css 用 fallback 掩盖）~~ → **已修（CSS-R13，2026-07-24）**：双主题补 token + 去 chat fallback 遮罩。
- ~~`.lineage-source-tag` 基类在 memory-graph-detail.css:143 是 R9 残留~~ → **已删（CSS-R14，2026-07-24）**：单一真理源收敛到 controls.css。
- ~~**R13-bis（幻影 token）**~~ → **已修（CSS-R13-bis，2026-07-24）**：实际范围比初判更广——`--text-secondary` 是直接幻影（无 fallback），横跨 completion-stats.css(5)/dashboard.css:236(1)/health.css(4) 共 10 处；加 completion-stats.css 的 --orange(3)/--orange-20(1)/--text-tertiary(4)，合计 18 处全目录清零（→ --accent/--accent-20/--text-2/--text-3）。
- ~~spacing 刻度值（4/8/10/12/16/20/24/28/32px 等）裸写未用 `--space-*`~~ → **已修（CSS-R15，2026-07-24）**：注释感知脚本批量迁移 27 文件 118 处裸 px→var(--space-*)（仅 spacing 语义属性，1px/2px 次像素与非栅格值故意保留）；tokens.css 补 --space-7:28px 补全 4px 栅格。替换 computed-identical，零视觉变化，lint:css 守卫 0 错误。
- ~~**R16 样式守卫**~~ → **已实现（2026-07-24）**：stylelint v16 + `stylelint-value-no-unknown-custom-properties`@6（npm 上**无** `@csstools/` 作用域包，其注册规则名是 `csstools/value-no-unknown-custom-properties`）；关键修正——插件**不跨 glob 聚合 `:root`**，必须用 `importFrom` 绝对路径（`.mjs` 配置）提供 token 集，整目录 glob 会误报 3260 条合法 token；首跑即抓 6 处真幻影 token 并修复（`--weight-normal`→`--weight-regular`、`--overlay`→`--surface2`、补 `--surface3` 双主题）；守卫接入 `lint:css` 脚本 + lefthook pre-commit 阻塞步骤，现状 0 错误。设计文档已同步修正（docs/css-stylelint-guard-R16.md）。

## memora-sprite 工程门与测试模式（可复用）
- **真实质量门** = `tsc --noEmit` + `eslint` + `lint:css`（stylelint）+ vitest；**prettier --check 不是门**（lint 脚本不含，存量文件普遍不过，对照组也 warn）——勿批量 prettier --write 造成无关 diff。
- **panels/inputAreaManager.test.ts 的 QuickInputCompletion mock 是字面量对象**（非 vi.automock）：补全类新增公开方法必须手动补进 mock 工厂，否则全部用例 TypeError。
- **补全弹窗折叠（2026-07-24 落地）**：QuickInputCompletion 可选能力 `enableCollapse()`（主对话开、quick-input 浮窗关）；三态可见性 hidden/expanded/collapsed，collapsed 时容器 pointer-events:none + 左对齐胶囊；展开重绘走 paintExpandedList() 不重复 recordShown。宿主专属能力走「构造后注册方法」模式（同 onRecentFallback），不改构造签名。

## memora-sprite 集成测试与内核同步（2026-07-25 新增）
- **内核同步守卫坑**：`scripts/sync-memora.mjs` 原用 `rmSync(node_modules/memora,{recursive})` 重建，会触发沙箱 safe-delete（目录 ≥50 文件 → `SAFE_DELETE_BULK_CONFIRM_REQUIRED`）。已改为非破坏 `cpSync` 覆盖式同步（`tsc` 产出稳定文件名，dev 不复删源码文件集即可保持最新）。改内核 `src` 后须 `npm run sync-memora` 重建 dist 入 `node_modules/memora`，sprite 测的是构建后内核，否则验证无效。
- **Vitest 走 esbuild 不做 type-check** → "type-only 导入 + `extends` 抽象类"会运行期 `ReferenceError`（类值不存在）。内核 `LlmProvider`/`EmbeddingService` 等抽象类仅以 `export type` 形式从 barrel 导出，且 `package.json` 仅暴露 `"."` 子路径（不可深导入）。注入桩实现必须用 `implements X`（esbuild 整体剥离该子句，无运行期值引用）+ 去掉 `super()` + 补抽象类里的 readonly 具体成员（如 `supportsStructuredOutput`）。
- **集成测试宿主 Bug 模板**：sprite 集成测试接真实 `memora` 实例时最容易暴露**宿主存储层**问题——例：`SqliteStorage.upsert` 用 `{ ...memory }` 展开，而 `Memory.metadata?` 注释声明"SQLite 不存储此字段"，导致带 metadata 的记忆（内核加载配置文件必填）upsert 即 `Unknown named parameter 'metadata'`。修复：upsert 显式绑定 8 已知列、忽略 metadata。此类 Bug 独立于内核 12 项修复，属宿主层。
- **集成目录约定**：`src/__tests__/integration/`（vitest include `src/**/__tests__/**/*.test.ts` 自动纳入）放"接真实 Agent / 真实 SqliteStorage / 真实落盘"的端到端用例；内核未导出的 Manager（ProjectManager/UserProfile/DedupManager/WorkProjectionManager）只能经真实 `Agent` 实例驱动（getter 返 `| null`，用 `!` 断言），不可直接 `new`。
- **saveSpriteConfig 双写不同步 Bug 模式（2026-07-25 修复）**：`saveSpriteConfig` 有 isFullConfig 优化（完整配置含全部默认键时跳过读文件直接写入）。当 main.ts 直接调模块级 `saveSpriteConfig({ windowBounds })` 部分写入（绕过 ConfigManager），ConfigManager 的 `this.config` 不更新，后续 `incrementDailyMessageCount` → `saveSpriteConfig(this.config)` 完整写入用过时值覆盖文件。**症状**：sprite.json 的 windowBounds 恰好等于 FULL_SIZE 默认值（900x680）但位置是真实用户值（move 触发了部分写入但 resize 被覆盖）。**修复模式**：所有配置写入统一走 `sprite.updateConfig/updateConfigBatch`（同步 this.config），main.ts 用 `persistWindowConfig` 辅助函数封装 sprite 就绪/未就绪两条路径。**可复用判据**：发现 JSON 配置文件某字段恰好等于默认值但其他字段是真实用户值时，优先排查"双写不同步"——一个路径部分写入（读文件合并），另一个路径完整写入（内存快照），后者覆盖前者。

## 代码孤儿/死导出静态分析方法论（可复用，2026-07-25 新增）
- **分析器骨架**：遍历 `src/**/*.ts`，解析相对 `import`/`export ... from` 构建「模块→被谁引用」图 + 「符→被谁 import」图；排除入口（main/cli/renderer/server/preload*/index 桶）。输出全模块孤儿/仅测试引用/死导出。
- **坑1（必踩）**：NodeNext 源码 import 写显式 `.js` 扩展名 → 解析器必须先 `replace(/\.(js|ts|mjs|cjs)$/,'')` 再 `path.resolve`+尝试 `.ts/.d.ts/.js/index.ts`，否则 100% 误判孤儿。
- **坑2（Electron 多入口）**：整模块孤儿数不可信——preload 脚本经 `path.join(ELECTRON_DIR,'x.cjs')` 加载、renderer 入口经 HTML `<script src="x.js">` 加载、preloadWeb 经运行时 esbuild 转译、类型 barrel 仅 `export type` 转发。此四类须手工核对，否则全误删。
- **坑3（类型漏判）**：interface/type 经 `import type` 或 barrel re-export 时易漏抓 → 类型"死导出"误报率极高（如 ElectronAPI 36 处引用被漏判）。**类型导出删除一律人工确认，不可信分析器**。
- **真死代码铁律**：仅「导出值（函数/const）且全仓（含 __tests__）零词边界引用」可信为真死导出；「导出但仅内部使用」属不必要 export（测试可达性保留），非死代码，删会破测试。
- **顺带清理**：删死导出时同步修 import（如死导出是唯一某 import 使用者 → 删该 import 避免 lint 报错）与引用它的陈旧注释（去痕）。

## 精灵感知系统架构约定（2026-07-26 新增）
- **vi.mock 工厂必须覆盖所有被 import 的函数**：`vi.mock('node:fs', () => ({ readFileSync, writeFileSync, existsSync, mkdirSync }))` 若源码新增 `import { renameSync }`，测试 mock 工厂必须同步加 `renameSync: vi.fn()`，否则运行期 `renameSync` 为 `undefined` 抛 TypeError（曾导致 spriteConfig 损坏测试失败）。
- **可选接口方法模式（向后兼容扩展）**：扩展 `SpriteTrigger` 等接口时用 `setErrorCallback?(cb)` 可选方法，现有实现（TimerTrigger）不需修改。调用方 `if (trigger.setErrorCallback)` 检测后再调用。
- **分级通知架构**：`priority: 'normal' | 'high' | 'critical'`，high 绕过节奏抑制（rapid rhythm），critical 绕过节奏+冷却。里程碑→high，健康警告→high，普通建议→normal。
- **触发器错误回调链路**：`SpriteTrigger.setErrorCallback?()` → `TriggerBus.onError()` → `spriteLifecycleManager` 订阅 → `proactiveEngine.addNotice('suggestion', ..., false, 'high')`。三段式：触发器自报告→总线转发→宿主转通知。
- **配置损坏保护模式**：catch 块先 `rename`/`renameSync` 备份为 `.corrupted.{timestamp}` 再返回默认值，区分 ENOENT（正常首次运行）和 JSON 解析错误（损坏）。两层实现：`loadSpriteConfig`（同步）+ `spriteConfigStore.loadOrDefault`（异步）。
