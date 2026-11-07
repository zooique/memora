---
alwaysApply: false
description: Memora 项目总则、技术栈清单、目录结构、硬约束与 AI 行为速查
---

# Memora · 项目总则

> **设计哲学**：万物皆是记忆｜**核心矛盾**：无状态推理 ←→ 连续演化任务
> **架构定位**：memora = 通用闭环引擎（插卡机），角色包 = 参数集（卡）。通用性由内核保证，专业性由角色包驱动（[architecture_philosophy_rules.md §11](./architecture_philosophy_rules.md)）
> **基调**：专注模式（应无所住，而生其心）——支持切换，默认专注（[§9](./architecture_philosophy_rules.md)）
> **决策追溯**：决策年轮 `.trae/decisions/`（编号规则、跳号与废弃状态以 [decisions/README](../decisions/README.md) 为单一真源）

## 1. 不可违反的硬约束

1. **ADR 优先于个人偏好**：技术栈变更必须先更新 ADR（`.trae/decisions/`）
2. **跨文档引用规范**：用「文档.§章节号」格式，详见 [cross-document-reference.md](./generic/cross-document-reference.md)
3. **记忆统一模型**：不引入「规则/技能/历史」等独立子系统；统一用 `source` 开放字符串区分（[ADR-004](../decisions/ADR-004-memory-unification.md)）
4. **单 Agent 模型 + 三层架构**：memora.db 是 Agent 级共享资源，不随子项目切换重建（[§10](./architecture_philosophy_rules.md)）
5. **配置文件是真理源**：配置文件持久化，SQLite 仅作运行时索引（[§10](./architecture_philosophy_rules.md)）
6. **内核 Node.js 专属 + 零第三方依赖**：纯逻辑库，只用内置模块（`node:fs`/`node:path`/`node:os`/`node:crypto`），`dependencies` 为空。不引入 native 模块（better-sqlite3/electron）与宿主专属 API（Electron/browser）；**不做任何运行时三方模块解析**（不静态 import / 不动态 `import()` / 不 `require()`），`peerDependencies` 亦不声明。**可选内建模块**（如 `node:sqlite`）须经 `process.getBuiltinModule('node:xxx')` **延迟取用**、以「返回 `undefined`」为不可用判据（`createNodeSqliteStorage` 即此形态），**不得**改写成静态 / 动态 `import()`——静态导入会把「模块是否可用」变成**加载期崩溃**（老环境连降级路径都用不了）。日志经 `setLogger()` 注入 `ILogger`，未注入用内置 console fallback（写 stderr）（[ADR-002](../decisions/ADR-002-storage-layer.md)）
7. **设定记忆 = 纯文件装载**：persona/rules/skills 唯一归角色包 / 技能池，纯文件 + 内存缓存装载（[memory-role-pack-boundary-rules.md](./memory-role-pack-boundary-rules.md) R1/R3/R9），**不写 SQLite / 记忆库**。配置文件是真理源，内核只读；新增 / 修改由宿主落文件 + 扫描装载（skills 目录动态扫描）。历史 `ConfigManager` 两段式契约（`addRule`/`deleteRule`/`updateRule`/`deleteSkill` + `fileConsistencyCheck`）已移除，不再引用
8. **检查点纯内存态**：`SessionCheckpoint` 是同进程内存态快照，**不落盘、无序列化 / 恢复路径**；中止 / 断电走「中断轮补全为完整 turn」，暂停为同 turn 内存续跑。`schemaVersion` 字段 + `AGENT_CONSTANTS.CHECKPOINT_SCHEMA_VERSION` **已彻底删除**（勿再引用）；**无版本迁移分发表**（`normalizeCheckpoint` / `checkpointMigrations` / `CURRENT_SCHEMA_VERSION` 已随恢复链退役）。新增字段只需内存态自洽，无需注册迁移

## 2. 技术栈清单

| 类别 | 选型 | 决策 |
| ---- | ---- | ---- |
| 运行时 | Node.js ≥ 22 LTS + TypeScript 5 strict + ESM | [ADR-001](../decisions/ADR-001-runtime-stack.md) |
| 数据层 | IMemoryStorage 接口（宿主注入持久化实现） | [ADR-002](../decisions/ADR-002-storage-layer.md) |
| 冲突消解 | supersededBy 布尔标记（写路径取代检测，读时过滤） | [ADR-021](../decisions/ADR-021-memory-conflict-supersede-write-path.md) |
| 归档模式 | archiveMode 二态（full / manual；insights-only 随洞察层移除） | [ADR-015](../decisions/ADR-015-archive-mode.md) |
| LLM | OpenAI Chat Completions 兼容协议 | [ADR-003](../decisions/ADR-003-llm-adapter.md) |
| 形态 | 纯逻辑库（CLI 由宿主提供） | [ADR-002 v0.8](../decisions/ADR-002-storage-layer.md) |
| 安全 | 两级权限 + 路径白名单 | [ADR-006](../decisions/ADR-006-security-model.md) |
| 测试 | Vitest + MSW Mock LLM + InMemoryStorage | [ADR-007](../decisions/ADR-007-testing-strategy.md) |
| 目录 | 按职责分层 | [ADR-008](../decisions/ADR-008-directory-structure.md) |

## 2.5 同仓库多 Package 结构（Monorepo）

本仓库含 memora **内核**（纯逻辑库）与第一宿主 **VS Code 插件**（`hosts/memora-vscode/`），各有独立 `package.json` / `tsconfig` / 测试 / 构建，共享同一 Git 仓库。桌面精灵宿主（memora-sprite）已独立仓库，不受本仓库规则约束。

```
memora/
├── .gitignore          # 统一管理所有 package（单一真理源）
├── .trae/rules/        # 仓库级规则（本文件所在目录）
├── package.json        # memora 内核（纯逻辑库）
├── src/                # 内核源码（§3 目录结构）
├── tasks/              # 统一任务追踪（内核 + 插件共享，唯一真理源）
└── hosts/memora-vscode/  # 第一宿主：VS Code 插件（当前主战场）
```

| 规则 | 说明 |
|------|------|
| 独立 package | 内核与宿主各自 `npm install` / `npm test` / `npm run build`，互不依赖对方 devDependencies |
| 统一 .gitignore | 根目录 `.gitignore` 是唯一真理源，子目录不得存在独立 `.gitignore` |
| 内核 Node.js 专属 | 只用内置模块，不引入 native 模块与宿主专属 API（[ADR-002 v0.9](../decisions/ADR-002-storage-layer.md)） |
| 宿主依赖内核 | 宿主以独立 package 依赖版本化的 `@zooique/memora`（[ADR-002](../decisions/ADR-002-storage-layer.md) / [ADR-VC-001](../decisions/ADR-VC-001-vscode-plugin-host.md)） |

## 3. 目录结构（不允许修改）

```
src/
├── index.ts        # 库导出入口（类型 + 接口 + 函数 + 类导出，无 CLI）
├── agent/          # Agent 门面 + AgentLoop（seed/ turn 编排）+ 工具执行 + managers/ 子目录（专职 Manager/服务类，完整清单与职责见 backend_layers_rules.md §分层职责）+ 上下文装配
├── code-exec/      # 通用代码执行抽象（ICodeExecutionProvider + 沙箱由宿主提供）
├── config/         # 配置加载
├── llm/            # LLM 适配层
├── logging/        # 日志（ILogger 接口 + console fallback）
├── memory/         # 记忆引擎（IMemoryStorage 接口 + InMemoryStorage 实现 + 召回）
├── role-pack/      # 角色包与行为策略定义（三层结构：L1 内容 + L2 策略 + L3 代码预留）
├── security/       # 安全策略
├── skill/          # 技能管理（configDir/skills/ + 角色包 skills/ 扫描，渐进披露）
├── utils/          # 工具函数（含 eventEmitter.ts 事件系统 / scanner / configResourceManager）
├── web-fetch/      # 网页抓取抽象（IFetchProvider + FetchWebFetchProvider，条件暴露）
└── web-search/     # 网络搜索抽象（IWebSearchProvider + FetchWebSearchProvider，条件暴露）
```

> **唯一真理源声明**：本节是**顶层目录结构的唯一冻结契约**（增删顶层模块必须先走 [new-module-guide.md](./generic/new-module-guide.md) 并经 ADR 记录）。模块**内部**文件命名（index.ts / types.ts / core.ts / helpers.ts）以 [backend_layers_rules.md §模块内文件命名](./backend_layers_rules.md) 为**快照性质**参考，随重构可能漂移、**不构成冻结契约**——两处冲突以本节为准。
> **已移出**：`SqliteStorage`（**原 better-sqlite3 实现**） / `cli/` / `commander` / `better-sqlite3`（→ 宿主项目）
> **2026-10-16 补充**：内核另提供基于 `node:*` 内建模块的 SQLite 实现（`src/memory/nodeSqliteStorage.ts` 的
> `createNodeSqliteStorage` 工厂）——上面「已移出」指的是 native 版实现，二者不矛盾（ADR-002 补充节）。

## 4. 命名规范（与 .trae/rules/ 一致）

| 类型 | 规则 |
| ---- | ---- |
| 文件夹 | 连字符（`cli-commands/`） |
| TS 文件 | 小驼峰（`openaiCompatible.ts`） |
| 类 | 大驼峰（`OpenAICompatibleProvider`） |
| 变量/函数 | 小驼峰（`loadConfig`） |
| 常量 | 全大写下划线（`BLOCKED_PATTERNS`） |
| 类型/接口 | 大驼峰（`Memory`、`ChatOptions`） |

> **I-prefix 例外**：宿主注入的接口（依赖倒置契约面，如 `ILogger`/`IMemoryStorage`/`ITracer`）允许 `I` 前缀——它承载「由外部实现」的架构意图，不算 Hungarian 违规。非注入接口仍须纯 PascalCase。
> **语义归属**（step / planItem 等指什么）见 [terminology-anchor-rules.md](./terminology-anchor-rules.md)。

## 5. Git 提交与推送规范

类型：`feat` / `fix` / `docs` / `test` / `refactor` / `chore`；格式 `<type>(<scope>): <subject>`

### 5.1 推送节奏

- **默认攒批（2026-11-05 用户拍板 · 取代旧「日常可攒批 / 触达面五项」）**：**只提交、不推送**；攒到 **3~5 笔**或**当天收工前**再推一次。`pre-commit` = `gate-fast`（约 60s）照常跑。
- **队列长度用可读命令判，不凭感觉**：`git rev-list --count origin/main..HEAD`。
  以该命令输出为准；**不以「今天推过几次」为准——那不可自证**。
- **三条立即推送例外（触及即推，不攒批）**：
  1. **公开面**：`package.json` 的 `exports`、`dist/index.d.ts` 导出成员、公开类型 / 签名变化；
  2. **协议面**：会话与宿主共享的协议定义 / DTO（含 webview ↔ 宿主的消息负载）；
  3. **已发布版本缺陷修复**：已上 npm 的版本冒烟出问题后的修复。
  只认这三条触达面，不认「高风险」自评——「高风险」评测不了就等于没有判据
  （同「不可机械定义的闸必然假红或漏检」）。
- **例外之外一律入队**：文档 / 台账 / 规则类改动不因「顺手」破例，攒到阈值或收工再推。
- **发版前必须推送**：打 tag / 发版判据含「本地 HEAD = 远端 main」三方一致，
  攒批会使该判据无法验证。
- **同一对象的同轮订正必须合笔（2026-11-04 立）**：同一轮里对**同一个对象**（同一条台账条目 / 同一份文档 / 同一个文件）的多个坐标 / 口径订正，**必须在一次提交里改齐再提交**，不许拆成一笔一笔。理由：拆笔的代价不是「多一条 commit」，而是**多一次 full 门禁 + 多一次推送收据**（实测 ~9 分钟），且拆出来的后一笔往往正是前一笔制造的漂移（先提交条目、才发现代码改动让行号过期）。
  **与「每笔提交单一语义」不冲突**：单一语义约束**语义维**（纯观测 / 改 prompt / 纯文档不许混笔）；本条约束**对象维**（同一对象在同一轮只能有一笔）。判据：**改完之后回头看，同一对象是否还有第二个待改点？有 → 合并再提交。**
- **禁止降级**：不许把推送档位从 `full` 换成 `fast`；**也不许用「手动跑一次
  `ci:local --preset=full`」替代推送**——后者不留推送收据（收据只由钩子落盘），等于自欺。
- **版本号判据（SEMVER-GATE-1）**：改动形态 → major / minor / patch 的**唯一判据**见
  [pre-release-audit.md §2.5](../skills/memora-kernel-release/references/pre-release-audit.md)（受众三分 /
  四类形态 / 取证命令 / 例外三项）；本文件**不复述表格**（复制即第二真源）。
- **与既有拍板共存**：本规则**不写**「推送必须跑 full / 禁止绕行」——
  [lefthook.yml](../../lefthook.yml) 与 [ADR-032](../decisions/ADR-032-gate-ownership-loop.md) 已拍板
  「推送绕过 full 是故意设计、禁止修成强制」；本规则只约束**节奏**与**禁止降级**，不改变绕行权限。

### 5.2 门禁拦住时：改到能过，不许绕（2026-11-07 立）

- **唯一处置**：`pre-commit` / `pre-push` 门禁红时，必须把改动**改到能过**；不许
  `--no-verify`、不许关闸（改 `lefthook.yml` / `local-ci.mjs` 移除步骤）、不许降阈值
  （调高 `max-lines` / 放宽 eslint 规则 / 改判据宽）。
- **顺序问题也不许绕**：若红是因为提交顺序（如新代码先让行数超闸、压行数在后续提交），
  **把满足闸的那笔提到前面**（合笔或重排），不允许「先绕过、后补齐」。理由：绕过那笔会在
  远端留下一个**单独 checkout 也红**的提交，破坏所有后续的按提交验证与 bisect。
- **别人的在途改动占着工作树时，不许移动它（2026-11-07 立 · 本仓实锤）**：为了过
  `pre-commit` 而 `git stash` / 事后恢复别人的未提交改动，一律禁止；更不许「恢复时保留
  对方新版、丢弃 stash 旧版」。只提交自己的文件用 `git commit --only -- <路径...>`；
  遇到别人的 `M` / `??` 占着工作树，正确做法是**等**对方落笔，或只提交自己的路径。
  判据：**工作树里不属于本笔的 `M` / `??` 原样不动**（连「临时移开再放回」也不算）。
  理由：stash → commit → pop 的窗口期内对方只要写一次，`pop` 就会失败或冲突，
  此时「保留新版」会**静默吞掉**对方那份改动，而这种丢失**事后没有任何测试会红**。
- **例外只有一种**：`pre-push` 的 `only` 文件匹配导致 `gate-full` 显示 skip，是
  [lefthook.yml](../../lefthook.yml) 的**设计内路径**（不是关闸）；判据是「本轮推送文件确实不在
  该步匹配面」，不是「门禁红了所以跳过」。
- **已知不可 bisect 点（事实记录）**：`21c4c84c` 是上述纪律建立前的一笔既定提交，单独
  `checkout` 时 `host:lint` 会红（该笔的暂存快照超出 `max-lines`，压行数在后续提交）；
  后续 bisect 遇到它一律 `git bisect skip`，不得据此判定「该区间无缺陷」。

## 6. 规则文件索引

> 列出 `.trae/rules/` 全部规则文件，方便按需加载。**`alwaysApply: true` 随会话自动加载，其余需 AI 主动读取。**

| 类别 | 文件 |
|------|------|
| 总则 / 硬约束 | [project-rules.md](./project-rules.md)（本文件） |
| 架构哲学（12 原则） | [architecture_philosophy_rules.md](./architecture_philosophy_rules.md) |
| 后端分层 / 目录 | [backend_layers_rules.md](./backend_layers_rules.md) |
| 通用编码约束 | [coding-convention-rules.md](./generic/coding-convention-rules.md) |
| 心智模型（Bug/逻辑） | [programmer-mindset-rules.md](./generic/programmer-mindset-rules.md) |
| 单一真理源思维模型 | [single-truth-source-mindset.md](./generic/single-truth-source-mindset.md) |
| **领域术语锚点（常驻）** | [terminology-anchor-rules.md](./terminology-anchor-rules.md)（`alwaysApply: true`；术语唯一定义，命名前必读） |
| 网络为土壤思维模型 | [network-soil-mindset.md](./generic/network-soil-mindset.md) |
| UI 工程化心智 | [ui-engineering-mindset-rules.md](./generic/ui-engineering-mindset-rules.md) |
| 渐进式重构 | [progressive-refactor-rules.md](./generic/progressive-refactor-rules.md) |
| 安全 / 测试 | [security_rules.md](./generic/security_rules.md) / [testing_rules.md](./generic/testing_rules.md) |
| 跨文档引用 / 新增模块 | [cross-document-reference.md](./generic/cross-document-reference.md) / [new-module-guide.md](./generic/new-module-guide.md) |
| 决策记录 | `decisions/`（[README](../decisions/README.md) = **索引唯一真源**；技术栈变更先更新 ADR，§1①）。⚠️ **不在此处登记 ADR 条数**——计数是时点快照、每次新增即过期（历史已漂移三次：37 → 25 → 26 → 30）⇒ 需要引用时**现读 README 索引** |

> 任务追踪统一在根 `tasks/`（唯一真理源）。
> **架构说明书**：[docs/architecture/agent-design-philosophy.md](../../docs/architecture/agent-design-philosophy.md)（设计哲学 + 闭环设计 + 数据模型 + 角色包体系 + 思维模式速查）。
> **架构定论**：不中断工作模型 = 「申请暂停模型」——不中断原则作用于 **turn 内的 step 循环**；暂停 = 等进行中的 turn 结束于 step 边界挂起（可继续 / 注入）；硬停止 `signal.abort` 是唯一霸道中止（推导见架构说明书 §2.3）。

## 7. AI 行为 DO/DON'T 速查表

> §1 是原则级硬约束，本节是实施级补充。

### 7.1 代码质量

| 类型 | 规则 |
| ---- | ---- |
| DON'T | 使用 `@ts-ignore` 或 `as any`（零容忍） |
| DON'T | 在生产文件中保留死代码 |
| DO | 提交前通过 pre-commit lint + typecheck + commitlint |
| DO | 参考 [testing_rules.md §3 覆盖率目标](./generic/testing_rules.md) 与 [coding-convention-rules.md §2 异常处理](./generic/coding-convention-rules.md) |

### 7.2 内核独立性（补充 §1.6）

| 类型 | 规则 |
| ---- | ---- |
| DON'T | 在 `src/` 下 import better-sqlite3 / electron / commander 等 native 或宿主专属模块 |
| DON'T | 在 `src/` 下 import 任何 web 框架（Express / HTML / CSS） |
| DON'T | 工具函数绑定特定第三方依赖（如 pino） |

### 7.3 记忆与存储（补充 §1.3 / §1.4）

| 类型 | 规则 |
| ---- | ---- |
| DON'T | 在 SQLite 中存储原始工作内容（仅存投影 / 摘要） |
| DON'T | 混合技能定义与内存存储（技能通过 `skills/` 文件夹管理） |
| DON'T | 直接修改 config schema（配置文件是真理源，§1） |
| DO | 工作内容通过宿主工具访问，内核仅保留投影 |
| DO | 切换项目用 `close()`，完全终止用 `shutdown()` |

### 7.4 Agent 门面约束

| 类型 | 规则 |
| ---- | ---- |
| DON'T | Agent 管理 LLM API keys 或 provider 配置（宿主负责） |
| DON'T | Agent 含 CLI/REPL 逻辑（CLI 由宿主提供） |
| DON'T | Agent 直接输出到终端（UI 由宿主处理） |
| DON'T | Agent 直接修改用户配置文件（通过宿主回调中介） |
| DO | LlmProvider 通过构造函数注入（`provider` 必填，`backgroundProvider` 可选） |
| DO | 工具注册通过 `registerTool()` 机制 |

### 7.5 功能开发流程

| 类型 | 规则 |
| ---- | ---- |
| DO | 底层问题优先修复（架构 / 基础设施层面，避免积重难返） |
| DO | **落地批次同批入台账**：凡写进 `CHANGELOG.md` 的落地批次，**同一批**必须在 `tasks/待完成任务.md` 落账（唯一台账，2026-10-10 起；销项条目标 ✅ 留册，**发版时**随版本号归档 `tasks/archive/`，不即迁）——CHANGELOG 记**发布变更**、台账记**待办与销项**，**职责不同、两边都进**；只进一处 = SSOT 断裂（发版前核对会漏项） |
| DON'T | 只更新 CHANGELOG、不进台账（2026-10-06 实证：`eed62d49` 批次遗漏，同周另两笔均同步 ⇒ 纪律执行不一致本身即缺口） |
| DON'T | **凭条目标题/状态直觉断定改动的轴归属**（内核 vs 宿主）：台账条目常是内核+宿主**混合面**收口，回源归属判据 = `git log --name-only <commit>` 的文件清单（落 `hosts/` = 宿主面，落 `src/` = 内核面），不得据此写 CHANGELOG 归属（5.3.0 实证：`ASK-PARTIAL-ANSWER-1` 落地提交纯 `hosts/`，凭标题直觉错列内核 CHANGELOG 欠账，复审以 `--name-only` 剔除——写错 = 对读者谎报包契约） |
| DO | 代码修复独立可回滚（每次修复独立提交） |
| DO | 自动归档根据 `archiveMode` 执行（full / manual 二态） |
| DO | LLM 工具调用传递 `tools` 参数，SSE 流正确解析 `tool_calls` delta |

### 7.6 代码组织与治理

| 类型 | 规则 |
| ---- | ---- |
| DO | 新增 IPC 通道前确认能否由现有通道组合达成，避免重复注册 |
| DO | IPC 通道总数接近 130 条时启动治理评估（当前 **120** 条，2026-10-19 按守卫同源判据实测重算——阈值 130，**余量仅 10 条**，新增通道前建议先做合并评估；阈值单一真源见 `hosts/memora-vscode/src/shared/__tests__/protocolGuard.test.ts`；⚠️ **该计数每次增删通道即过期，引用前须按守卫同源判据重算**——此前 2026-10-11 记「111」、2026-10-04 记「107」、2026-10-01 记「105」、2026-09-20 记「101」均已实测漂移，本次重算即发现已漂 9 条） |
| DO | 新增模块前先走 [new-module-guide.md](./generic/new-module-guide.md) 评估流程 |

## 8. 验收口径：用户会不会撞上（2026-11-07 立）

> **唯一验收口径 = 用户执行某个动作后，看到 / 得到的是不是对的。**
> 与 [testing_rules.md §7.3](./generic/testing_rules.md) 的分工：那节管「判据与不变量同源」，本节管「判据落在用户可见面」。适用于功能、修复、UI 与闸门本身的一切交付判定。

### 8.1 不许当完成证据

| 不许当证据 | 为什么它不算 |
| --- | --- |
| 函数被调用过 | 调用 ≠ 生效；入口预判、早退分支、闸门都能让它不执行 |
| 测试绿了 | 只证明「已写的判据成立」，不证明「判据覆盖了用户那条路」 |
| 注释说 X | 注释是意图不是事实；本仓已有注释与实现相反的实例（结论必须回源） |
| 配置项存在 | 键在 ≠ 有消费面（僵尸键 / 预留键之别见 [single-truth-source-mindset.md](./generic/single-truth-source-mindset.md)） |
| 接口已接 | 接线 ≠ 走到；「已接」必须附调用点证据 |
| 日志有输出 | 输出 ≠ 用户看到；停在无人消费的事件面上等于没到屏幕 |

### 8.2 判据三件套（缺一即「未验证」）

| 要素 | 要求 |
| --- | --- |
| **动作** | 用户具体怎么做（点哪个按钮 / 敲什么命令 / 什么前提）；不写「调用 X」 |
| **预期** | 该看到 / 得到什么（屏上文本、落盘文件、状态），可观察、可截图 |
| **反证** | 变异或反向操作能把它转红（例：注释掉该分支 → 对应用例转红） |

**给不出反证判据的，视为未验证**，不得写成「已验」。反证优先用**变异**，其次用反向操作（正常路径应当不红）。

### 8.3 入口类改动必须附「全部入口表」

只补被点名的那一个入口不算完成。逐项标注三态，缺一不可：

| 标注 | 要求 |
| --- | --- |
| 已接 | 该入口确实走到同一执行面（附调用点 / 用例名） |
| 未接 | 写明「未接」+ 为什么现在不接 + 触发条件 |
| 不该接 | **必须附理由**（按语义本就不该走到该执行面），不许留空 |

依据 = [single-truth-source-mindset.md「自然生长」](./generic/single-truth-source-mindset.md)：新入口只写差异段，执行全部归真理源。

### 8.4 公开面变更必须列全

修 bug 时**顺手改的签名 / 返回值 / 语义**同样算公开面变更。漏登记 = **发版级缺陷**，不作「顺手小改」处理。登记面 = `CHANGELOG.md` 对应版本区 + 台账条目；公开面口径见 §5.1 立即推送例外第 1 条。

### 8.5 已知边界只能这样写

- **允许**：「未复现」「未验证」「缺 N 项证据」——必须同时写清缺哪项、下次怎么补。
- **禁止**：「无害」「已修复」「已闭环」——除非有**可复现的正向证据 + 反证判据**。
- 判据：读者照这句话**能不能判断「我能安全使用了吗」**；不能 = 措辞折叠（[single-truth-source-mindset.md](./generic/single-truth-source-mindset.md)）。
