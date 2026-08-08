# 项目长期记忆（memora）

## 架构与质量基线
- 内核 `src/`（零 native/第三方依赖，仅暴露 `"."` 子路径，不可深导入）；桌面端 `hosts/memora-sprite/`（Electron 40 + electron-builder 26，sprite 版本 1.5.0，渲染 `appVersion` 走 `package.json`）。内核同步用 **sprite 包的 `npm run sync-memora`**（= `hosts/memora-sprite/scripts/sync-memora.mjs`，**非 root 脚本**——root `package.json` 无此脚本、root `node_modules/memora` 不存在）编译内核（`tsc -p tsconfig.build.json`+`tsc-alias`）并 cpSync 覆盖进 `hosts/memora-sprite/node_modules/memora`（真实拷贝、非软链，memora 未声明为依赖）——**内核随客户端打包冻结，改内核后必须从 sprite 目录 `npm run sync-memora` 再打包**。
- 真实质量门 = `tsc --noEmit` + `eslint` + `lint:css`(stylelint) + vitest；prettier --check 非门（勿批量 write 制造无关 diff）。

## 设计令牌（ADR）
- 三层 scope：L1 foundation/ 全局基础 · L2 语义别名 · L3 组件覆写（在各面板 CSS）；BEM；单文件单真理源。
- 双主题：`:root` 浅 / `[data-theme="dark"]` 深；颜色/阴影/z-index 100% token 化。控件收口在 `foundation/controls.css`（L1 单一真理源）。

## 样式审计方法论（可复用）
- 统计硬编码色须排除 `tokens.css` 定义值：先去 `var(...)`(含 fallback)，遍历跳过 `foundation/tokens.css`。
- stylelint 插件 `stylelint-value-no-unknown-custom-properties`@6 **不跨 glob 聚合 `:root`**：跨文件 token 须 `importFrom` 绝对路径（`.mjs` 用 `fileURLToPath`）。整目录 glob 会误报（曾 3260 条）。验证守卫须注入幻影 token 防假绿。npm 注册名 `csstools/value-no-unknown-custom-properties`（无 `@csstools/` 作用域）。
- CSS 批量迁移脚本须保留 `/* */` 注释定界符（按 `/*` 切分，注释段原样保留，仅对 code 段替换，跨行维护 in_comment）。

## sprite 测试与集成模式（可复用）
- `inputAreaManager.test.ts` 的 QuickInputCompletion mock 是字面量对象，补全类新增公开方法须手动补进 mock 工厂。Vitest 走 esbuild 不做 type-check：抽象类仅 `export type` 时注入桩用 `implements X`（剥离 `extends`+`super()`）+ 补 readonly 成员。
- 内核未导出 Manager 只能经真实 `Agent` 实例驱动（getter 返 `|null` 用 `!` 断言），不可直接 `new`。
- 集成测试接真实实例易暴露宿主 Bug（如 SqliteStorage.upsert 展开 `Memory` 含 `metadata` 致 `Unknown named parameter`）——upsert 须显式绑定已知列、忽略 metadata。
- **双写不同步判据**：JSON 某字段恰等于默认值但其他字段是真实用户值 → 必有一路径部分写入（读合并）、另一路径完整写入（内存快照）覆盖。统一走单一写入入口。

## 代码孤儿/死导出分析（可复用）
- 遍历 `src/**/*.ts` 建引用图，排除入口（main/cli/renderer/server/preload*/index 桶）。NodeNext 显式 `.js` 须 `replace(/\.(js|ts|mjs|cjs)$/,'')` 再 resolve；Electron 多入口须手工核对；类型导出删除一律人工确认。真死导出铁律：导出值且全仓（含 __tests__）零词边界引用。

## 感知/通知架构约定
- 分级通知 `priority: normal|high|critical`：high 绕过节奏抑制，critical 绕过节奏+冷却。里程碑/健康警告→high。
- 可选接口方法向后兼容：`setErrorCallback?(cb)`，调用方 `if(x.setErrorCallback)` 检测后调用。
- 配置损坏保护：catch 内先 `rename` 备份 `.corrupted.{timestamp}` 再返默认，区分 ENOENT(首次) 与解析错误(损坏)。
- vi.mock 工厂须覆盖所有被 import 的函数，新增 import 须同步补 mock。

## Composer P4 澄清触发边界（2026-08-08 定案，勿回改）
- **chat 事件永不因 task 槽缺失触发 P4**（`resolveChatTaskSlot`）：chat 的 `content` 即用户意图——currentGoal 空则以 content 为初始目标（P1），非空则 P2 延续（不覆盖，「继续」不误覆盖目标）。「是否需澄清」是语义判断，归 LLM（架构哲学 §4）。
- **P4 仅保留给非 chat 事件**（command/correction/clarify），含停滞 `resolveStalledTaskSlot`（计划完成问下一步方向）。
- **clarify 回答 = 恢复会话 + 转 chat 继续执行**：agent.ts 中 resume() 成功后把回答 JSON 转可读文本（`formatClarifyAnswers`）走完整 chat 流程（写历史+召回+LLM 生成）；resume 失败（暂停超时）保留 handleClarify 只记录不执行。
- 生产链路 `chatStreamHandler.ts` 构造 `{type:'chat', content}` **无 delta**——曾致每条新会话首消息必弹 P4（task 槽 defaultVal='' isEmpty=true）。

## 网络搜索后端（2026-08-08 定案）
- **DuckDuckGo 在中国大陆不可达**（实测 8s 超时）——`FetchWebSearchProvider` 默认降级链 = **Bing 优先 → DDG 备用**，每端点独立 10s 超时，构造函数可注入端点列表。
- 端点 HTTP ok 但无命中 = 返回 `[]`（搜索成功无结果，safeSearch 不误报「暂不可用」）；全部端点失败才抛聚合错误。
- Bing HTML 解析：`<h2><a href>` 标题 + `<p class="b_lineclamp*">` 摘要，URL `&amp;→&` 解码。

## HEAL-16 UIManager 渐进重构
- 协调器模式（Perception/Chat/Memory/Settings）已落地：委托群经协调器转发，ui.ts 字段 ~29→~25。提取后须同步更新委托测试断言路径（mock.X→mock.coordinator.X）；协调器初始化须前置到 panel.init() 之前。

## 发布/分发约定（闭源桌面端）
- 主仓 Gitee + **Gitee→GitHub 私有 push 镜像**（必须保持 private，否则源码泄露）。`build.yml` 监听 `v*` tag → 仅 Windows `electron-builder --win` → `Publish Release` job 用 `RELEASE_TOKEN` 细粒度 PAT（仅公开仓 `memora-sprite-releases` 的 Contents:write）自动建 Release+传 exe。开发者零手动。
- exe 分发走独立公开发布仓 `memora-sprite-releases`（只放 exe 不含源码）：`GET /repos/{o}/{r}/releases/latest` **免鉴权**，客户端 `fetch`+`User-Agent` 取 `tag_name` 比较、`html_url` 打开发布页。国内加速备选 COS/OSS/R2 直链（非必须）。
- 版本：宿主与内核**独立维护**——发版只升宿主版本（如 1.4.0→1.5.0）。内核同步铁律见上。详见 `tasks/发布流程-gitee-20260722.md` §1/§4/§5。

## Git 操作安全红线（2026-07-31 血训）
- **禁止从 Bash 执行 git 写操作**（`git mv`/`git rm`/`git restore`）。Bash 运行在 POSIX 沙箱，FS 视图与 Windows 真实 FS 不同步——曾致 `tasks/` 11 文件被误判删除、污染 git 索引。
- **文件状态以 Read/Glob（Windows API）为准**；git 命令（含移动/删除）一律用 **PowerShell** 走真实 FS。
- **阶段完成立即 `git add -A && git commit`**；不可逆操作前用 Read/Glob 双重核验源与目标均存在。

## UI 占位符三态约定（2026-07-31）
- 占位符/空态/错误态**用类修饰而非状态机**（先例 `quick-input.css`：`.completion-loading/error/empty` 靠颜色+tooltip 区分）。
- token 用量 UX-15：错误态 `.token-usage-error`(`--yellow`+`data-tooltip`) 显示 `--`；空态/零用量显示 `0/上下文窗口`（默认 32768→`0/32.8k`），成功路径 `classList.remove('token-usage-error')` 防残留。分母=0（`0/0`）是假事实，经对抗式审查改为 `0/窗口`。
- 首屏同步陷阱：`refreshTokenUsage()` 须在 `renderer.ts` 的 `onAgentReadyCallback` 补一次，否则首屏停在 HTML 默认 `--`。

## Component 化判别铁律（Phase B）
- Component = 单根 `this.el` + `new/mount/update/destroy` 四件套自包含视觉单元；§四.4 中 Manager 持有 Component，**Manager 本身不是 Component**。
- 默认豁免/保留 Manager：① 装饰注入元素（如 `BadgeManager` 收 `HTMLElement|null`，零 `getElementById`）；② 跨面板协调分布式 DOM（`PanelErrorBannerManager` 按 `${panelId}-error` 合法跨切面查找）；③ 流式引擎（`streamingRenderer` 纯函数+`Map`，无单根 el）；④ 既有 `init/cleanup` 生命周期 Manager。
- "批量清单"（如"6 个 *Renderer"）须逐个对抗式核实架构角色，不可盲套模板。转换陷阱：`update({report})` 须补 `report` 包裹层；`mount` 用 `document.querySelector`(带 `#`)；测试 fixture 须完整镜像静态容器 class。

## 声明式工厂前提核实铁律（Phase C / HEAL-17，2026-08-01 经 ADR-017 AI 时代补充细化）
- **抽取触发已从"计数阈值"改为"设计期意图 + 通用性门禁"**：领域原语（列表/详情/表单/搜索）或已有明确/近确定第二消费者 → **首次实现即抽最小公共原语**；纯臆测"以后可能用到"仍禁止（YAGNI，ADR-017 当年拒绝的"完全废除枝叶约束"风险）；2+ 处重复降级为"该抽却漏抽"的回溯补抽信号。理由：AI 编码时代代码库即协调媒介，已存在的公共原语被自然复用、缺失则 AI 就地复制。
- 「结构真实相似」非文件名相似；已抽进 helper 的共性（空/错/刷新/loading）不重复计入重复量——此判据保留。
- **列表工厂接纳硬判据**：仅接纳「单容器 + 单 load 返回 `T[]` + 单计数」面板。**双列表**（无外层包裹、各自 count+交互）/ **IPC 返回 `{entries}`** / **单 fetch 分多组** → 异类排除（防 God Object / customRender 架空工厂）。本仓库：audit(试点)+work(`customRender` 行内展开) 接入；profile(双列表+`{entries}`)、memory(list+search+detail) 排除。
- `customRender` 逃生舱：**必须注入行级 EventTracker** 随每次渲染重建前清理、`destroy` 时随工厂清理；`_renderItems` 须把 `customRender` 判断**提前到空态之前**（接管整段含空态），`renderRow` 改可选。工厂配置须用真实数据形态（load 返回数组，非 `{items,total}`）。

## UI 组件库分层 / 复杂度守恒铁律（Phase D，2026-08-01 已落地）
- **形状已定（components/）**：`base/`(Component 抽象基类 + FlatListPanel 声明式工厂基类) / `feedback/`(MessageBubble/ToastComponent) / `data/`(Phase B 5 个面板组件，文件名去 Renderer 后缀为 *Component) / 根保留 Manager·Renderer·工具等非 Component 构件（toast.ts/themeManager/suggestionCard/proactiveBanner/onboarding/modal/relationGraph/markdown/milestoneBanner/startupSummaryBanner）。
- **分层规则（后续迭代遵循）**：Component 子类按用途归入 base/feedback/data；新增面板 Component→data/、新增反馈型→feedback/；Manager/Renderer/工具暂留根，不为空目录提前抽象（form/navigation 子目录待对应用途 Component 出现再建）。形状约定见 `components/index.ts` 头注释（单一真理源）。
- **复杂度守恒仍成立**：不为空目录/合规而提前抽象；物理迁移须全量同步 import（含 `__tests__`，易漏）。
- `tokens.css` L1/L2 分区**仅用注释**（顶部作用域模型横幅 + 语义别名块标 `[L2]` + `:root` 关闭处 L3 注记），**不拆文件**；`:root` 内 L1/L2 按主题交错，须逐块标注而非单一分隔带。

## 长期观察（阈值驱动，见 `tasks/待完成任务.md`）
- **UI-MIXIN-OBS**：ui.ts 行数（applyMixins 回退判据），2026-08-01 实测 1077 行，阈值 1500。HEAL-13 已判 mixin 为有意架构选择，仅当行数触发再评估回退内联分区。
- **D-MIGRATE-OBS**：panels/→components/ 物理迁移**已实施**（2026-08-01）：components/ 已分层 base/feedback/data + 根保留非 Component；形状见 components/index.ts 注释。
- **HEAL-17-P3**：已实现收窄版 FlatListPanel 工厂（覆盖 audit+work，profile/memory 排除）；**UI-AUDIT-P0-2**：Component 基类已落地（Phase B），FlatListPanel 为其首个工厂实例。
