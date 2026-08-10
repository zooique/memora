# 项目长期记忆（memora）

## 架构与质量基线
- 内核 `src/`（零 native/第三方依赖，仅暴露 `"."`，不可深导入）；桌面端 `hosts/memora-sprite/`（Electron 40 + electron-builder 26，sprite 版本 1.6.0）。
- **内核同步铁律**：改内核后必须从 sprite 目录跑 `npm run sync-memora`（**非 root 脚本**——`hosts/memora-sprite/scripts/sync-memora.mjs`）再打包——它编译内核并 cpSync 真实拷贝进 `hosts/.../node_modules/memora`（非软链，memora 未声明为依赖），内核随客户端冻结。
- 质量门 = `tsc --noEmit` + `eslint --max-warnings 0` + `vitest run`。prettier --check 非门。
- 版本：宿主与内核独立维护，发版只升宿主版本。

## source→子目录映射单一真理源（2026-08-10，T-A1~A3 落地）
- **位置**：`src/memory/sourcePaths.ts`（`SOURCE_TO_DIR`/`sourceToDir`/`resolveSourceFilePath`，经 `src/index.ts` 导出）。
- 消费方全引用：内核 `FileStore`（store.ts 委托）；宿主 `configFileManager.ts`（resolveTargetPath 委托，catch 转 null 保签名；listConfigFiles 用 `SOURCE_TO_DIR[type]!`）、`skillInstaller.ts`、`personaWatcher.ts`、`index.ts` requiredDirs。
- **铁律**：宿主严禁再定义子目录映射或硬编码 `'personas'/'rules'/'skills'`（新增 source 类型只改 sourcePaths.ts 一处）。
- 语义：未知 source 透传作目录名（ADR-004 开放字符串）；source 经 validateSource 校验；name 不做字符白名单但做目录内 startsWith 纵深防御。
- 坑：宿主 tsconfig 开 `noUncheckedIndexedAccess` → `SOURCE_TO_DIR[key]` 返回 `string | undefined`，索引 SOURCE_LABELS 固定 key 处须非空断言 `!`。

## SSOT 审查与修复（2026-08-09，已落地）
报告 `tasks/SSOT与设计闭环审查-20260809.md`；方案 `tasks/SSOT修复方案-20260809.md`（以方案为准）。病灶统一是「对称的另一半没写完」。四个根因：
- A 执行流消费双份并列 → 抽 `#consumeExecutionStream()` 收口 processEvent/executeChatLoop/resumeExecution，清理放 finally。
- B 门面窄化（`Agent.pause` 丢 `lowRisk`）→ 传参用 `every` 不用 `some`。
- C 状态恢复未强制归零 → `restoreFromCheckpoint` 用 `resetToRunning()` 强制清理并查返回值。
- D 原子写无公共原语 → 抽原子写原语，vectorStore/store 复用（先改 vectorStore 复用，避免新旧并列）。
确认正确勿动：`createCheckpoint` 展开合并语义；Rule 真理源 + SQLite 派生索引；暂停内核事实驱动延迟翻转；`consecutivePauseTimestamps` 1h 衰减。

## 审计 / 测试方法论（高复用）
- **判死代码必须跨宿主边界 grep**：只搜 `src/` 会误判「内核写、宿主读」的活字段为死（`pauseMeta`/`standard` 曾误判——`main.ts`/`chatHandlers.ts`/`composer.ts` 有消费）。
- **区分「死字段」与「契约未兑现」**：类型/注释承诺 N 态、实现只兑现 1 态 ≠ 字段死，危害更高；修法二选一：兑现 or 收窄（同步删下游分支），禁止维持现状。
- **快照内字段 vs 有运行时副本的字段**：只有别处有第二副本（hotMemory→loop、status→stateMachine）才需回灌 restore；纯 checkpoint 内字段整体赋值即完成 = SSOT 正确。
- **门面窄化审计**：Facade 必须与被委托方参数面等宽（`Agent.pause` 两参 vs `SessionManager.pause` 三参 ⇒ lowRisk 不可达）。JS `.length` 忽略默认参，无法用 `.length` 断言等宽——改用行为断言锁死契约。
- **注释即契约**：行为性注释须 grep 验证，无代码路径支撑等同撒谎且危害更大。
- **dual-source 判据**：「删掉从库能否无损重建？」能=派生索引（合法），不能=反模式。一致性不是目的，正确性才是——推广修法前逐点核对语义。**判据须分维度**：Rule 索引的「内容」可重建（合法派生），但「存在性」不可重建（`loader.ts` 只 add 不 evict，删文件后 SQLite 行永生）⇒ 同一字段可能一半合法一半泄漏。
- **审查必须跨内核/宿主边界（2026-08-09 第二轮血训）**：只审 `src/` 会漏掉「宿主对内核契约的调用姿势」类缺陷——契约两端各自看都对，错在中间。最严重实例：`void agent.processEvent(event)` 调 async generator = 函数体一行不执行，而 tsc/eslint 全绿、IPC 照常返回 success、用户再发一条消息即掩盖断裂。**跨进程边界不要把 generator 作为唯一入口**，应提供内部自 drain 的非流式门面，把「记得迭代」变成类型上不可能错。
- **对称性检查是缺失的工序**：反复出现的病灶不是某段代码，而是「方向性操作只写了一半」——归零无兜底 / 抄副作用漏主作用（`updateStep` 手写 lastHeartbeat 却漏 `touchCheckpoint`）/ 有 add 无 evict / 写了 `for await` 文档却 void 调用。任何增删、生产消费、读写、翻转归零的改动，评审必须回答「反方向在哪里」。
- **修复本身可能引入新分叉**：`restoreFromCheckpoint` 加无条件 `resetToRunning()` 后，原本只是「不恢复」的 error 字段缺失场景变成「反向恢复」（状态机 running / 检查点 error 永久分叉且无日志）。强制归零必须同时归零所有镜像。
- **同一数据缺陷两种崩法 = 降级设计缺失**：`loadPersistedCheckpoint` catch 吞掉（静默丢整个会话）vs `restoreFromCheckpoint` 直接抛（崩进程），无一是「降级但可用」。反序列化应收口为单一 `parseXxx()` 做字段补齐。
- **防回归测试铁律**：必须能在修复前失败；同时补一条「修复后仍应通过」的绿测防过度修复。验证手段：临时中和生产分支跑测试应红，再精确还原。
- **变异"误绿"要实测（2026-08-09 实证）**：行为级断言可能被无关路径干扰而误绿（T3 初次变异：chatSync 路径有其他 touchCheckpoint 置脏，写盘断言变异后仍绿）。对策：行为断言脆时改**契约级断言**（spy 私有方法 / spy logger.warn 确认 catch 已挂），直接锁「必须走哪个方法」。vitest 不把 unhandledRejection 转测试失败——测"悬空 Promise"要 spy 降级日志而非指望进程报错。
- **tsc 与 vitest 的不对称是防线而非冗余**：vitest（esbuild）不查类型——Agent 调 SessionManager private 方法在测试里"绿"、`tsc --noEmit` 里"红"。改完必跑 tsc，别只信测试全绿。
- **收口优于补漏（SSOT 修复的升级路径）**：`updateStep` 从"补 touchCheckpoint 调用"升级为「状态变更收口到 SessionManager 公共方法 `updatePlanStepStatus`」——消灭外部直改 checkpoint 的通道。凡是「外部直改被绕过路径」的修复，优先考虑把写入收进拥有者（单一真理源），而不是在调用点打补丁。
- **测试 Provider 轮次计数陷阱（2026-08-09 实证）**：loop 在**迭代边界**检查 `pauseRequested` 才挂起（pause 触发后下一轮迭代开头才翻 PAUSED）。且 `postProcess` 的归档（ArchiveCoordinator）仍会调 `provider.chat`。故 MockProvider 按「chat 调用次数」决定产工具调用会被归档 LLM 调用污染轮次、导致续跑无法触发第二次暂停。正确做法：按「已产出工具步数」计数（文本型 LLM 调用不占预算），且测试关 `archiveMode:'manual'` 双保险。`resumeExecution` 无输入且计划停滞会短路、不走 `continueAfterPause`——续跑测试须传 input。

## 设计令牌与 UI 架构
- 三层 scope：L1 `foundation/` · L2 语义别名 · L3 组件覆写；BEM；控件收口 `foundation/controls.css`。双主题 `:root` / `[data-theme="dark"]`，颜色/阴影/z-index 100% token 化。`tokens.css` L1/L2 仅注释分区，不拆文件。
- **Component 判别**：单根 `this.el` + 四件套；Manager 持有 Component，Manager 本身不是。豁免：装饰注入元素 / 跨面板协调分布式 DOM / 流式引擎(纯函数+Map 无单根 el) / 既有 init/cleanup Manager。
- `components/` 形状：`base/`(Component 基类 + FlatListPanel 工厂) / `feedback/` / `data/` / 根留 Manager·Renderer·工具。不为空目录提前抽象（复杂度守恒）。
- **抽象触发**（ADR-017）：领域原语或已有明确第二消费者 → 首次实现即抽最小公共原语；纯臆测禁止；2+ 重复（尤其已实证漂移）是「该抽却漏抽」的回溯信号。
- **列表工厂硬判据**：仅接纳「单容器 + 单 load 返回 T[] + 单计数」。双列表 / IPC 返回 `{entries}` / 单 fetch 分多组 → 排除。`customRender` 逃生舱必须注入行级 EventTracker 并在重渲染前清理。
- 占位符/空态/错误态用类修饰而非状态机。分母=0 是假事实（`0/0` → `0/窗口`）。首屏须在 `onAgentReadyCallback` 补刷新。

## 样式审计
- 统计硬编码色须排除 `tokens.css` 定义值：先去 `var(...)`(含 fallback)，遍历跳过 `foundation/tokens.css`。
- `stylelint-value-no-unknown-custom-properties`@6 不跨 glob 聚合 `:root`：跨文件 token 须 `importFrom` 绝对路径（`.mjs` 用 `fileURLToPath`）。整目录 glob 误报（曾 3260 条）。守卫须注入幻影 token 防假绿。
- CSS 批量迁移脚本须保留 `/* */` 定界符。

## 测试与集成
- Vitest 走 esbuild 不做 type-check：抽象类仅 `export type` 时桩用 `implements X`（剥离 extends+super）+ 补 readonly 成员。
- 内核未导出 Manager 只能经真实 `Agent` 实例驱动（getter 返 `|null` 用 `!`），不可直接 `new`。
- mock 工厂是字面量对象，被 mock 类新增公开方法须手动补入；vi.mock 须覆盖所有被 import 的函数。
- 集成测试接真实实例易暴露宿主 Bug（upsert 展开 `Memory` 含 metadata 致 Unknown named parameter → 须显式绑定已知列）。
- **双写不同步判据**：JSON 某字段恰等于默认值而其他字段是真实用户值 → 必有一路径部分写入、另一路径完整覆盖。统一走单一写入入口。

## 已定案特性约定（勿回改）
- **Composer P4 澄清边界**：chat 事件永不因 task 槽缺失触发 P4（content 即用户意图）；P4 仅保留给非 chat 事件+停滞。clarify 回答=恢复会话+转 chat 续跑；resume 失败只记录不执行。生产链路 `chatStreamHandler` 构造 chat 事件无 delta（曾致每条新会话首消息必弹 P4）。
- **网络搜索后端**：DuckDuckGo 在中国大陆不可达 → 降级链 Bing 优先→DDG 备用，每端点独立 10s 超时；ok 无命中返回 `[]`（不误报暂不可用），全失败才抛聚合错误。Bing 解析 `<h2><a href>` + `<p class="b_lineclamp*">`，`&amp;→&`。

## 其他约定
- 分级通知 `priority: normal|high|critical`：high 绕过节奏抑制，critical 绕过节奏+冷却。
- 可选接口方法向后兼容：`setErrorCallback?(cb)` + 调用方检测。
- 配置损坏保护：catch 内先 rename 备份 `.corrupted.{ts}` 再返默认，区分 ENOENT(首次)与解析错误(损坏)。
- 发布：主仓 Gitee + Gitee→GitHub **私有**镜像（泄源风险）；`v*` tag 触发 Windows 打包，`RELEASE_TOKEN` 传 exe 到公开发布仓 `memora-sprite-releases`；客户端查 `releases/latest` 免鉴权。详见 `tasks/发布流程-gitee-20260722.md`。
- 事件闭环审计：emit/on 双正则须同时匹配字符串字面量与 `AGENT_EVENTS.XXX` 常量；判 dangling 后须核实宿主 IPC 旁路消费。脚本 `%TEMP%\event_audit.mjs`。

## Git 安全红线（2026-07-31 血训）
- **禁止从 Bash 执行 git 写操作**：Bash 在 POSIX 沙箱，FS 视图与 Windows 真实 FS 不同步，曾致 `tasks/` 11 文件被误判删除、污染索引。文件状态以 Read/Glob 为准；git 一律走 PowerShell。阶段完成立即 commit；不可逆操作前双重核验。

## 长期观察（阈值驱动，见 `tasks/待完成任务.md`）
- **UI-MIXIN-OBS**：ui.ts 行数（applyMixins 回退判据），2026-08-01 实测 1077，阈值 1500。
- **检查点未来兼容**：SQLite 单 TEXT 列存整个 JSON、无 schemaVersion、无 CAS、全量覆盖。多 Agent 并发写或长上下文（hotMemory 数 MB）会击穿。建议触发前先加 `schemaVersion`（一行成本）。
