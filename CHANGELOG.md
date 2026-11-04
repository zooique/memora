# Changelog

本文件记录 **@zooique/memora（内核 npm 包）**的版本变更。**宿主**（`hosts/memora-vscode`）不在发布包 `files` 白名单内（见 `package.json`），不占内核版本号：内核与宿主各按自己的版本号成区（ADR-033），**已发布与否以 npm registry 为准**（内核 `npm view @zooique/memora dist-tags.latest`；宿主见 Marketplace / Open VSX）——本文件不复述该状态，只记各版本改了什么。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

> **版本定位（v5.x）**：**Node.js 专属 · 零第三方运行时依赖的 Agent 内核**（依赖 `node:*` 内置模块，不引第三方运行时依赖 / native / 宿主 API）。**4.0.0**：导出面收敛（−54）+ `agent.memory.search()` 退役（唯一入口 `searchByKeyword()`）。**5.0.0**：公开面大收面（删 23 导出 + 32 成员 + 3 事件）+ 多项目形态定案（一个 Agent = 一个项目）+ 三套空转机制退役 + SQLite 存储——逐项改法见[升级指南](docs/memora-升级指南-4.x-到-5.0.0.md)。**5.1.0**：MCP 工具接入的内核接口（`ToolDefinition.confirmPolicy` + `SecurityGuard` 单一确认入口）+ 脚本族执行面四面按正文裁决（`CMD-1-BYPASS` / `CMD-1-CONTENT`）——零删除、零既有签名变更。**4.0.0 及更早版本全文**：`docs/CHANGELOG-归档.md`（仓库内归档，npm 包不含）。内核不内置 agent 级行为评估（eval）/ 独立验证——由宿主基于内核可观测性（ITracer / 事件 / 指纹）自行承担；内核对接口契约与全量单测负责，不对"agent 整体行为稳定"作承诺。
>
> 本文件 2026-10-19 起按 `CHLOG-TRIM-1` 精简：只记「改了什么 + 为什么 + 对消费者的影响」；逐批拍板过程、变异验证收据、台账叙事的 SSOT 在仓库台账 `tasks/待完成任务.md` 对应 ID 条目（npm 包不含），此处只留 ID 锚保交叉引用。

## [Unreleased]

### Added（内核）

- **LLM 调用观测新增「本次实际下发的工具名清单」**（`LLM-TOOLSNAPSHOT-1`）：LLM 调用 span 新增属性 `llmToolNames`，取值 = **实际下发载荷** `effectiveOpts.tools`，不取暴露面列表。**纯观测**：只记录、无消费方、不参与判据、不加闸、不改行为、不加 UI；无工具通道时记 `[]`——**空集照记**，与「完全没记录」可区分。**为什么**：暴露面与下发面是两层事实，先落一个只记不判的地基，避免将来拿暴露面冒充下发面（快照真源仍待定，本条不裁决）。**对消费者**：零签名 / 零行为变更；trace 多一个属性。

### Changed（内核）

- **运行时策略覆盖只能收紧权限类字段，不能放松**（`READONLY-MODE-1` / ADR-045）：`mergeStrategy` 的 `act` 段此前整段「后写覆盖」⇒ 角色包声明 `act.toolReadonly: 'readonly'` 时，运行时覆盖传 `'full'` 会把只读锁直接去掉。现 `act` 段经单点秩表 `PERMISSION_FIELD_LENIENCE` 裁决：权限类字段（`toolReadonly`：`readonly` 严于 `full`；`toolMode`：`block` 严于 `allow`）**只取更严、不可放松**，覆盖侧非法值按「不生效」处理（不落回 `'full'`）；其余行为字段（temperature / outputLimit / toolStepLimit / providerRouting / multiStepReasoning）仍由覆盖赢。**对消费者**：不传 `strategyOverride` 的代码零行为变化；「覆盖可放松权限」从未是承诺路径，现已关闭。验收判据与变异收据见台账 `READONLY-MODE-1`。
- **`capabilities` 三态：拆开「未声明」与「显式空能力」**（`CAP-TRISTATE-1`）：此前 manifest 无 `capabilities` 与显式 `capabilities: []` 在解析层被折叠成同一个 `[]`，装配层再以 `length > 0` 判「有无声明」⇒ 两者都按「全开」放行，**「显式空能力」这一意图无法表达**。现 `RolePack.capabilities` / `RolePackAssembly.capabilities` 与解析返回值均为可选：`undefined` = 未声明（放行全部）；`[]` = 显式空（仅常驻工具，特权工具全关）；非空数组 = 白名单。**读侧影响**：该字段由必填改为可选 ⇒ 读侧类型变为 `string[] | undefined`，既有 `pack.capabilities.length` / `.map()` 一类直接解引用的消费者**会编译失败**，须先判空再分支（`undefined` = 全部工具、`[]` = 仅常驻）。装配层去掉 `?? []`，应用层改判 `undefined` 而非 `length > 0`（宿主能力徽章侧仅做解引用安全折叠，不参与裁决）。**⚠️ 这是公开 manifest 语义的收紧，不是纯 bugfix**：既有外部角色包若显式写 `capabilities: []`，行为从「全开」变为「仅常驻工具」——旧折叠让该写法永远拿不到想要的收紧效果，现按字面生效。**证据边界**：仓内三个内置包均无显式 `[]`，本机与仓库内全部包已核对（行为不变）；**外部包状态不可知**。**对消费者**：不写 `capabilities` 的包零变化；显式写 `[]` 的包若要全开请删掉该字段，若要白名单请补能力项。验收判据与变异收据见台账 `CAP-TRISTATE-1`。
- **只读会话向模型如实列出「哪些工具会被拒绝」**（`UNAVAILABLE-WRITE-HINT-1`）：只读模式（`act.toolReadonly: 'readonly'`）下，系统提示新增「## 只读会话」一段，列出本会话中调用会被拒绝的工具名——判据复用 `ToolDefinition.readonly`（与 `toolRunner.applyPrechecks` 同一判据，不另立写工具名单）。**定性 = 降低概率的止血，不是修复**：应用层只读闸仍是唯一执行判据，模型仍可能被用户指令推着去试（真机已见模型改走代码执行绕过路径限制），这段文字只把确定会被拒的项提前讲清——不承诺、不闭环、不替代任何闸，不得据此宣称原事故已解决（病因未定，见台账 `AGENT-FAKE-CREATE-1`）。**触发边界**：仅当不可用工具集非空时出现；非只读会话、以及全部工具都标了 `readonly: true` 的会话零变化。**只讲事实不讲禁令**：只列工具名与「会被拒绝」这一事实，并说明本会话无法执行写入（需写入时由用户调整角色包设置），不对模型下达「不许 / 禁止」类行为禁令。**同族补齐**：`setStrategy()` 此前不重建系统消息 ⇒ 只读会话首轮按旧口径（冷启动时按默认口径）下发，现每次策略变更后重建 `messages[0]`。**对消费者**：零接口变更；仅在只读角色包会话里多一段提示文案。

### Changed（宿主）

- **工具权限徽章不再把「显式空能力」显示成「全部工具」**（`CAP-TRISTATE-1` 显示面）：内核把「未声明 `capabilities`」与「显式 `[]`」折叠后，宿主显示层又按 `capabilities.length === 0` 判「全部工具」⇒ 显式声明空能力（意图 = 仅常驻工具）在界面上被读成「全部工具」，与内核语义相反。现协议改为传**已判定的三态**（`CapabilityStateDto`：`all` / `residentOnly` / `list`），判定只在 host 单点 `deriveCapabilityState()` 发生，输入区徽章（`roleBadgeView`）、角色卡（`rolesView`）、设置页数据装配（`settingsPanel`）一律只按 `kind` 分支渲染、不再自行判 `length`。显示口径：未声明 ⇒「全部工具」（原样）；显式空 ⇒「仅基础工具」（悬停说明「联网、代码执行等特权工具已关闭」）；非空 ⇒ 能力列表（原样）。**对消费者**：不写 `capabilities` 与非空白名单的角色包界面零变化；显式写 `capabilities: []` 的角色包此前显示「全部工具」，现显示「仅基础工具」——这是修正，不是回归。

## [5.5.0] · 2026-11-03

### Added（内核）

- **`ToolExecutor.builtinDefinitions` 兼容别名**（`DEPRECATE-1`）：5.4.0 将「全部工具定义」getter 更名为 `allToolDefinitions`，`builtinDefinitions` 属源级破坏（宿主 / 第三方引用会编译失败）。现补 `@deprecated` 别名 getter 转指同一实现，5.x 保持可用，6.0.0 按 `DEPRECATE-1` 移除清单删除。**对消费者**：既有 `builtinDefinitions` 引用零改动继续可用；新代码一律用 `allToolDefinitions`。
- **技能用户目录真重扫**（`SKILL-REFRESH-1`）：`SkillManager` 此前只在装配期经 `loadExtraDir` 读一遍用户技能目录，`reload()` 只重扫 `configDir` ⇒ 用户往 `<globalStorage>/skills/` 手工放新技能后，除 Reload Window 外没有任何重扫入口。现管理器自持已登记的用户目录（`extraDirs`），覆写 `reload()` 统一重扫「`configDir` + 已登记用户目录 + 项目级目录（三段）」；额外目录注入项（`extraSkillNames`）与 `register()` 运行时项分开记账，重扫只摘前者，不误删运行时技能。**为什么**：若刷新时由宿主再传一次路径，就会形成「装配期一份、刷新期一份」的路径双源，第二个入口漏传即静默失效。**对消费者**：零签名变更；`loadExtraDir` 新增目录 / 档位登记供重扫复用，同名处置增加分档记账（见本区 `ASSET-PROJECT-SCOPE-1`），既有单参调用零改动。
- **新增公开窄口 `resyncUserSkills()`**（`SKILL-REFRESH-1` / `SKILL-CREATE-1`）：重扫已登记的用户技能目录并回报净差 `{added, removed, updated}`（形态对齐 `RolePackManager.resyncUserPacks`），供设置页刷新与新建技能后立即生效。**对消费者**：纯新增成员，零既有签名变更。
- **技能 / 角色包支持项目级来源，优先级项目 > 用户 > 内置**（`ASSET-PROJECT-SCOPE-1`）：`loadExtraDir` 的额外目录由「用户级」扩为**三段**——内置（`configDir/skills`）→ 用户级（`globalStorage/skills`）→ 项目级（`<workspace>/.memora/skills`）；角色包侧同构（内置 → 用户 → 项目）。**覆盖由加载顺序决定**（先加载者被后加载者覆盖），档位 `SkillExtraTier` / `RolePackExtraTier` 只用于记账与「顺序写反」守卫。技能侧项目覆盖单独记 `projectOverrides`，不混入 `userOverrides`；角色包侧同名处置经 `ExtraDirLoadResult.conflicts` 返回并可经 `lastExtraConflicts` 读取（胜出 / 被跳过均留日志，不再静默）。目录不存在时扫描返回空数组（首次使用前未建目录不报错）。**对消费者**：`loadExtraDir(dir, tier?)` 新增可选第二参（缺省 `'user'`，既有调用零改动）；新增 getter `userOverrideNames` / `projectOverrideNames` / `lastExtraConflicts`。
- **`AgentOptions.noOverwriteRoots`：与 `allowedPaths` 并列的「禁止覆盖根」判据**（`ASSET-WRITE-SCOPE-1`）：目标文件落在这些目录内且**已存在** ⇒ `write_file` 拒绝覆盖（结构化错误 + `path-deny` 审计），提示「请换名写入（同名已存在的一律拒写）」——**无「与用户确认」路径**（界面从未提供，不得据此理解为可确认覆盖）。**为什么**：`write_file` 的确认档是 `idempotent-key`（owner 默认不弹窗），无本判据即无覆盖拦截。**现状（2026-11-04 订正）**：宿主装配期仍传参（`assemble.ts`），但用户资产目录不在 `allowedPaths` ⇒ 白名单阶段即拒、本判据生产不可达；保留键，计划 6.0.0 按 `DEPRECATE-1` 退役（判据重写见 `ASSET-WRITE-SCOPE-1`）。（2026-11-04 订正留痕：本条原写作「本键成**保留键、生产零消费者**」——「零消费者」字面暗示宿主不再传参，与 `assemble.ts` 实际仍注入相反；已发布版本区按「原话 + 订正锚」修正、不回删，见台账 `NOOVERWRITE-WORD-1`。）**方向与白名单相反**：白名单放宽可写面，本键收紧覆盖面；工具侧不硬编码任何路径字符串。**对消费者**：纯新增可选字段，缺省 `[]` = 不启用，既有调用零行为变化。
- **资产包根 `packageRoot` + 公开 `SKILL_MAIN_FILE`**（`ASSET-PACKAGE-ROOT-1`）：`SkillEntry` 与 `RolePack` 各新增**可选只读字段** `packageRoot`（绝对路径），语义统一为「复制 / 迁移的唯一单元」——单文件技能 = 该文件本身；目录式技能 = 技能目录（资源随包）；角色包 = 包目录。**为什么**：宿主此前拿入口 `filePath` 反推包根，角色包（`manifest.json`）成立但**单文件技能**取 `dirname` 就是 `skills/` 根、会误搬兄弟技能；旧修法只堵住角色包一支。现由内核在扫描 / 装配时给出（技能包根由扫描分支直接产出——形态在扫描时已知，不按文件名反推；角色包 = 包目录），宿主零推导。同时导出 `SKILL_MAIN_FILE`，供宿主校验「目录式技能包根须含入口」而不硬编码文件名。**对消费者**：纯新增**可选**字段 + 一个常量导出，自行构造 `SkillEntry` 传给 `register()` 的代码无需改动（`packageRoot` 缺失时宿主复制入口直接拒绝并报错，不猜）。**SemVer = minor**：可选成员与新增导出不改变既有契约；若声明为**必填**则会破坏外部 `SkillEntry` 构造点，故刻意取可选。

### Changed（内核）

- **角色包 `reload()` 与技能 `reload()` 语义对齐**（`ROLEPACK-RELOAD-1`）：`RolePackManager.reload()` 此前只重扫内置 `configDir` 并保留旧运行时注入项，**不重读额外目录磁盘** ⇒ 宿主「重载技能与角色包」命令对角色包半失效（用户改 / 新增的角色包内容不生效）。现与 `resyncUserPacks` 共用同一重扫序（`rescanAllSources`），按已登记目录顺序重新读盘并保留运行时注入项；`updated` 口径统一为「同名留存，不比对内容」。**对消费者**：零签名变更；`reload()` 现在真的读取用户级 / 项目级目录的磁盘变化。
- **系统提示不再承诺「用户资产不可改写」**（`ASSET-WRITE-SCOPE-1`）：真机实证——模型被 `delete_file` 拒绝后改写临时 `.mjs` 执行 `unlinkSync`，用户资产被真实删除，应用层路径闸对代码执行无效。原提示里「用户级写入会直接被拒绝 / 须换名写入」属守不住的承诺，且「需要改动用户资产时先与用户确认」指向一个**界面从未提供**的确认路径。现改为中性表述：① 模型只写项目级 `.memora/skills`，**不要**直接写入用户级资产；② **不要**静默覆盖用户级同名资产，需要改动时交由用户处理；③ 行为边界「能通过执行代码绕过路径限制，但不应绕过」——这是行为约束，不是安全承诺，也不承诺任何确认路径（`run_code` / `run_skill_script` / `run_project_script` 仍可绕过，已如实登记）。`noOverwriteRoots` 判据本身不变（仍只约束 `write_file` / `delete_file`）。**对消费者**：零接口 / 零行为变更，仅系统提示文案。

### Fixed（内核）

- **只读闸覆盖自定义工具与四个内置读工具**（`READONLY-CUSTOM-1` / `READONLY-BUILTIN-1`）：`toolReadonly='readonly'` 的只读闸此前只查暴露面 `tools.list`（受 `toolWhitelist` 过滤）⇒ 宿主 `registerTool` 注册的自定义 / MCP 工具完全不在射程（未声明 `readonly` 的写工具照常执行）；同时 `read_skill` / `read_resource` / `list_resources` / `list_skills` 四个渐进披露读工具漏标 `readonly`，只读模式下被误拦。现闸改查「全部工具定义」——来源单点 `ToolExecutor.allToolDefinitions`（原 `builtinDefinitions` 更名，含内置全量 + 自定义，**不过白名单过滤**），四个读工具补 `readonly: true`。**行为变更**：注册自定义工具时未声明 `readonly` ⇒ 按契约缺省 false = 写操作，只读模式下**将被拒**（此前因闸查不到定义而放行）——这是修正不是回归；需在只读模式使用的自定义工具请显式声明 `readonly: true`。**为什么**：暴露面 ≠ 覆盖面，闸查可见面等于「工具不可见即不受约束」。**对消费者**：不使用 `toolReadonly='readonly'` 的代码零影响；`ToolExecutor.allToolDefinitions` 为公开 getter 更名，原 `builtinDefinitions` 已补 `@deprecated` 别名转指同一实现（见本区 Added），既有引用无需改名，6.0.0 删除。

- **`allowedPaths` 超上限由静默截断改为如实抛错**（`ASSET-WRITE-SCOPE-1`）：截断会让被截掉的路径静默失效，属假阴性。现 `loadConfig` 与 `SecurityGuard.setAllowedPaths` 共用同一常量 `MAX_ALLOWED_PATHS`（禁止同值手抄两份）：配置层按**声明条数**校验（不触碰文件系统，无法 realpath 去重），运行时白名单按 **realpath 去重后**条数校验，超 50 条即抛错并提示删几条。**方向订正（2026-11-03）**：本区曾记「宿主把两个用户资产目录并入 `allowedPaths` 使其可写」——该做法已撤回（见宿主区「收回 LLM 用户级资产写权限」）；用户级装载改由设置页「添加到用户级」复制入口完成，正常工具路径对用户资产目录的写仍被基准根判据拒绝。**对消费者**：`allowedPaths > 50` 抛 `allowedPaths 超过上限`（此前静默丢弃超额项）；不再有「用户目录自动可写」的注入。
- **路径守卫 realpath 回退在文件系统根终止，修复栈溢出**（`PATH-GUARD-REALPATH-1`）：`resolveRealpath` 在目标不存在时逐级向上解析父目录，Windows 根的 `dirname` 自指（`dirname('Z:\\') === 'Z:\\'`），配置里写一个不存在的盘符即可无限递归直至调用栈溢出。现以「`dirname` 不再变短」为终止判据。**对消费者**：零签名 / 零可见行为变更，只消除极端路径下的崩溃。
- **删除用户级角色包后无法恢复内置版本**（`ROLEPACK-OVERWRITE-REVERSIBLE-1`）：重扫序此前只重扫内置 `configDir` 并保留旧运行时注入项，用户包胜出的内存态不会因磁盘上用户包消失而回退。现重扫先摘除额外目录注入项（连同 `extraPackDirs` / `extraOverrides` 记账一并清空），再按目录顺序重读磁盘重放；删除 / 改名用户包后刷新即恢复内置版本。**对消费者**：`reload()` / `resyncUserPacks()` 对齐「按磁盘现状重建」，零签名变更。

## [0.7.0] · 2026-11-04 · 宿主

> **随包内核代次 = `5.5.0`**（esbuild 内联 dist，内核自身变更见内核区）。

### Added（宿主）

- **项目级资产注入与工作区信任门**（`ASSET-TRUST-GATE-1`）：项目级技能 / 角色包目录取自 `workspaceFolders[0]` 的 `.memora/`（工作区数据目录单点 `resolveProjectDataDir`），**仅在 `vscode.workspace.isTrusted === true` 时注入**；未受信任时状态栏显示 `$(shield) Memora：项目级资产未启用` 并指向 `workbench.action.manageTrust`，装配期也不向 Agent 透传项目目录。授予信任由 `onDidGrantWorkspaceTrust` 监听：立即注入 `'project'` 档位并触发技能 / 角色包重扫 + 刷新技能列表，**无需重启窗口**。**单点约束**：项目目录推导与信任判定只在 `projectAssetDirsFor(ctx)` 一处发生（`extension.ts` 不再自行拼 `.memora/{skills,role-packs}`），任何调用方只消费其结果。**限制**：多根工作区只加载第一个文件夹的项目级资产。**对消费者**：未信任工作区行为零变化（仍只有内置 + 用户级）；已信任工作区新增项目级来源，同名时按加载顺序覆盖。
- **压缩包导入技能 / 角色包（.zip）**（`ASSET-ZIP-IMPORT-1`）：设置页技能区、角色包区与命令面板三入口共用同一命令处理器 `memora.importAsset`（webview 只发 `import_asset_zip` 路由，开框 / 选目标级 / 校验 / 落盘 / 重扫只有一份实现）。默认**用户级**；工作区受信任时可选项目级（未信任时该项标注「不可选：工作区未受信任」并在选中后明确拒绝，不静默降级）。校验流水线六步：① 解压前条目数（500）/ 单条解压后大小（5 MB）/ 总解压量（20 MB）上限（防 zip bomb）；② 逐条目路径校验（拒绝对路径、盘符、`..`、反斜杠、空名与符号链接条目，最终路径必须落在目标根内）；③ 类型识别（含 `manifest.json` ⇒ 角色包；否则含带 `description` 的 `.md` ⇒ 技能；都不像 ⇒ 拒绝并说明）；④ 格式校验（技能走 `validateSkillAsset`，角色包走 `validateManifestText` 且 `formatVersion` 缺省 `1.0.0`）；⑤ 同名必须询问「覆盖 / 取消」，取消则零写入；⑥ 落盘后重扫内核池并刷新面板，toast 显示类型、名称、落点与文件数。**不执行包内任何脚本**，只落盘。**对消费者**：新增一条命令与一条 webview→host 消息通道（两区按钮合并为单条 `import_asset_zip`；本版另新增 `skills_refresh` / `asset_copy_to_user` 两条消息，未删除任何既有类型）。
- **「添加到用户级」复制入口**（`ASSET-COPY-USER-1`）：设置页项目级技能 / 角色包卡片新增「添加到用户级」按钮，把一个项目级资产复制进 `globalStorage`。落盘复用 `zipImport.ts` 的 `copyAssetToRoot`（暂存 → 备份 → 换名 → 失败回滚，取消**零写入**），复制单元 = 内核给出的 `packageRoot`（单文件技能 = 文件本身；目录式技能 / 角色包 = 整包复制，资源随行），宿主不再按 `filePath` 反推（反推会把单文件技能的兄弟技能一起搬走）。技能与角色包共用同一条协议通道 `asset_copy_to_user`（`assetKind` 仅区分校验与文案）。**对消费者**：新增按钮与一条 webview→host 消息；`packageRoot` 缺失（外部 `register()` 自行构造的条目）时明确拒绝并提示，不猜。

### Changed（宿主）

- **输入区状态行增加主题分隔线**（`UI-STATUS-DIVIDE-1`）：Row 2 状态行（角色 / 能力徽章 + 上下文圆环）与 Row 1 按钮行原本只隔 `#inputFooter` 的 4px gap、同底色无色差 ⇒ 按钮在 `UI-CTL-BORDER-1` 去边框后被读成一块。现给状态行加 `padding-top: sp-2`（6px）与 `border-top: var(--line-solid)`（1px 面板边框色，与 `.context-ring__injection` 同源同值，不新造颜色令牌、不加实体边框）。**对消费者**：仅视觉分隔，输入区高度增加 6px；交互、DOM 层级与按钮无边框契约均不变。

- **收回 LLM 用户级资产写权限**（`ASSET-WRITE-SCOPE-1`）：此前宿主装配与 `allowedPaths` 热更新会把 `globalStorage` 的技能 / 角色包目录并入白名单，使 `write_file` 可写用户资产；真机实证该约束对代码执行面无效（模型可改写临时脚本直接删改），且「可写但禁止覆盖」只在 `write_file` 分支生效，属守不住的承诺。现装配与热更新**不再**注入用户目录，用户级装载改由「添加到用户级」复制入口完成；项目级写入与用户级目录**读取**链路保留。**射程边界**：`run_code` / `run_skill_script` / `run_project_script` 仍可绕过，如实登记、本轮不设防（不造沙箱、不加字符串拦截、不改权限模型）。**对消费者**：`write_file` 写用户资产目录由「可写」回到「被基准根拒绝」；手工往 `globalStorage` 投放仍可用（无提示、无回退，见台账 `ASSET-SNAPSHOT-GAP-1`）。

- **角色包同名策略反转：由「内置优先、用户静默跳过」改为项目 > 用户 > 内置**（`ASSET-PROJECT-SCOPE-1`）：此前额外目录（用户级）的同名角色包会被**静默跳过**，内置包恒胜；现按加载顺序覆盖（内置 → 用户 → 项目，后加载者胜），同名胜出 / 被跳过都会留**可见痕迹**（`logger.warn/info` + `loadExtraDir` 返回值 `conflicts` + `lastExtraConflicts`）。**这是面向用户的可见行为变化**：原先被静默忽略的用户同名包现在会接管内置包；设置页角色包来源徽章新增「项目」，项目级包可覆盖用户级与内置。**对消费者**：依赖「用户同名包不生效」旧行为的用户需重命名该包；技能侧同名策略不变（仍允许覆盖，两翼方向差异见 `SKILL-CREATE-1` 补注）。

- **设置页「刷新技能」改为真重扫**（`SKILL-REFRESH-1`）：此前只重读内核内存快照，用户新增技能文件必须 Reload Window 才可见；现刷新走 `agent.skills.resyncUserSkills()` 后重推技能列表（`userAssetRefresh.ts` 薄委托，技能 / 角色包两个刷新按钮共用同一套净差文案）。**对消费者**：点刷新即可看到手工投放或新建的技能，无需重启窗口。

- **输入区控件统一为无边框 `.ctl` 基类；选中态由边框改为图标染色**（`UI-INPUT-CTL-1`）：skill / 模型触发器与润色 / 上传 / 暂停按钮改由单一 `.ctl` 基类提供形态（`border:none`、2px 圆角、hover 底色 + 前景提亮、`[aria-disabled]` 统一置灰），各自不再自写 `border` / `border-color` / `border-radius`；发送按钮（实心、不挂 `.ctl`）补 1px 紧凑焦点环（全局 2px 对 32px 方钮偏重）。**选中态**（已挂载 Skill）由「accent 边框」改由「常驻图标染色（`.ctl--on` 的 accent 前景）」承载——**不写常驻底色**：`--accent-bg-hover` 实际映射 `--vscode-list-hoverBackground`（中性灰），常驻灰底会让选中态「看起来一直处于 hover」且与 hover 同底，三态不可分。**为什么**：边框在输入区同时承担了两种互斥语义（常驻选中 vs 瞬时 hover），去边框后必须让「常驻」走常驻通道（颜色）、「瞬时」走瞬时通道（底色）。**对消费者**：纯样式，零协议 / 零 DOM 结构变化（仅给既有按钮与下拉触发器追加 `ctl` class，`buildDropdownHtml` 增可选 `triggerClass` 入参）。

- **角色包来源徽章判定与技能聚合统一**（审查轮 `P2-8`）：设置面板此前用裸 `startsWith(projectRolePacksDir)` 判来源，既无 `resolve` 规范化也无 `path.sep` 边界，与技能聚合的口径不一致 ⇒ 兄弟目录 `role-packs-x` 会被误判为项目级。现两处共用 `isPathWithin`（`resolve` 规范化 + `root + sep` 前缀），面板内第二份判定副本删除；该函数同时接受 `undefined` 根，调用方无需先判空。**对消费者**：来源徽章在兄弟目录同名前缀场景下不再误判。
- **覆盖确认文案与事务化实现对齐**（审查轮 `P2-9`）：导入覆盖弹窗原写「会先删除原内容」，而实现早已是「先备份再替换、失败回滚」——文案描述的是被退役的旧路径。现改为「会备份并替换原内容，失败自动回滚」。**对消费者**：仅提示文案变化，无行为变化。
- **设置页两个「刷新」提示改为实际覆盖面**（`SKILL-REFRESH-1`）：两个 tooltip 此前都写「重扫**用户**…目录」，而执行面 `resyncUserSkills` / `resyncUserPacks` 均重扫**全部已登记额外目录**（项目级 + 用户级，且含内置复活）——真机实测：把文件放进 `<项目>/.memora/skills/`、不重启窗口、点刷新即出现。现两处提示改为「重扫项目与用户…目录」，协议注释与相关行内注释同步订正。**对消费者**：仅文案与注释变化，零行为变化（两个入口的实际重扫范围本就一致）。
- **输入区控件悬停底色改为可感知**（`UI-INPUT-CTL-1`）：`.ctl` 族悬停底色原用 `--accent-bg-hover`（映射 `list.hoverBackground`），与输入卡底色 `input.background` 近似同色（Dark Modern Δ≈7/255、Light Modern Δ≈15/255）⇒ 真机逐像素比对读成「悬停无变化」。现只把该族悬停底色换成既有 `--surface-hover`（`toolbar.hoverBackground`，全站其它 hover 已用它），不动全局 token 映射、不新增变量；选中态仍只靠前景 accent 染色、无常驻底色，选中 + 悬停 = 染色保留 + 底色出现。**对消费者**：悬停可感知，三态仍可分。

### Fixed（宿主）

- **MCP `readOnlyHint` 映射进只读闸**（`READONLY-CUSTOM-1`）：内核只读闸改为查「全部工具定义」后，`toToolDefinition` 此前从不写 `readonly` 字段的 MCP 工具会按缺省 false 被一律拒绝——只读 server 工具在只读模式全部不可用。现按既有判据 `readOnlyDeclaration`（`annotations.readOnlyHint === true && annotations.destructiveHint !== true`）显式映射：声明只读 ⇒ `readonly: true`；缺省 / false / 与 `destructiveHint: true` 矛盾 ⇒ 显式 `readonly: false`（不靠字段缺省，边界可审计）。与 `diskWrite` 同源镜像（同一份 `readOnlyDeclaration`，避免「写序说只读、只读闸说会写」的双头语义）。**对消费者**：MCP 读工具在只读模式恢复可用；`readOnlyHint` 仍是 server 自报，谎报只读同时绕过写串行闸与只读闸——该残余风险随本条一并放大，见仓库台账 `READONLY-CUSTOM-1`。
- **压缩包导入覆盖写到一半失败会毁掉原有资产**（`ASSET-ZIP-IMPORT-1`）：此前覆盖路径是「先删旧目标 → 再逐条写」，磁盘满 / 进程被杀 / 断电都会留下半包，且旧包已被删除、无法恢复（既有用例只覆盖「取消不动」与「成功替换」，失败中断无射程）。现改为**暂存 + 换名**：内容先写进目标同父目录的隐藏暂存区（同卷 ⇒ `rename` 原子），目标已存在时先换名成备份、提交成功才删备份；写入或换名任一步失败即反向换名回滚，旧目标按字节原样恢复，暂存与备份一并清理（清理失败只记日志，不误报导入失败）。残留按「严格命名 + 超过 1 小时」双判据在下次导入时清理，不删并发进行中的暂存。**对消费者**：成功路径的最终结果与文件数不变；失败时新增两种可读原因（「写入失败（目标未改动）」/「换名提交失败，已回滚」）。
- **导入与内置同名的角色包改为前置拒绝**（`ASSET-ZIP-IMPORT-1`）：同名判定此前只针对目标目录——内置包不在用户 / 项目根下，与内置同名的压缩包会直接落成用户包；按加载顺序（后加载者胜）它会接管内置包，用户可能以为内置功能消失。现构建期导入新增可选 `isNameTaken` 判据（判定留在命令层：内核 `rolePackManager.get(name)` 的 `filePath` 落在内置目录即命中，并另扫一遍内置目录清单，覆盖 `get` 未命中与 Agent 未就绪），命中在**解析目标 / 建目录之前**返回，原因写明「已存在同名角色包（内置）……请改名后再导入」，零写入。**对消费者**：与内置同名的压缩包导入改为明确拒绝；用户 / 项目级同名仍走既有覆盖确认，行为不变。**样本订正（2026-11-03）**：该现象**未获真机样本证实**——真机那次是模型把中文名同时写进 `name` 与 `displayName`，库内并无同名内置包（内置角色包仅 `memora助手` / `共鸣小说家` / `白话方案设计师` 三个）；本条保留为「同名输入的前置守卫」，不记为「已复现缺陷的修复」，显示名与标识的冲突面另见台账 `ROLEPACK-DISPLAYNAME-COLLIDE-1`。
- **回滚失败的备份会被后续清理删掉**（`ASSET-ZIP-IMPORT-1`）：覆盖提交回滚失败时旧内容留在 `<目标>.bak-<hex>`，而残留清理对 `.bak-` 一视同仁（仅按 1 小时过期）⇒ 用户旧内容的**唯一副本**会在下一次导入时被删除，与回执里「备份保留在磁盘，请手工恢复」自相矛盾。现回滚失败即把备份改名为 `.<目标名>.recovery-<hex>`（前导点让技能 / 角色包扫描器跳过，避免旧目录被当作同名包重新装载），清理逻辑对该形态**无条件跳过**，回执与日志给出绝对路径。**对消费者**：覆盖失败不再静默销毁旧内容；`.recovery-` 需人工确认后方可删除。

- **重载技能后已打开的面板仍是旧快照**（`SKILL-REFRESH-1`）：`memora.reloadSkills` 空闲路径只重扫内核池，没有主动回推已打开的设置页与对话面板；用户随后点「刷新」时 `resync` 已无净差，面板继续显示重载前列表。现空闲重载后同时刷新设置页技能 / 角色包两份列表与对话区技能下拉，忙碌路径仍按带 `source` 的两条请求提交后由内核补执行。**对消费者**：重载 / 新建技能后已打开面板即时更新，无需重开面板。
- **模态确认框 12 处调用点收口为单一 helper**（`MODAL-DUP-CANCEL-1` 第二段）：第一段只迁入了两个「同名覆盖」调用点，其余 12 处（`settingsPanel` 5 / `chatPanel` 3 / `fileChangeView` 2 / `memory` 1 / `userDataReset` 1）仍各自直调 `showWarningMessage(..., { modal: true }, ...)`，判据写法不统一（存在 `choice !== '删除'` 这类负判据）。现全部迁入 `host/ui/confirmModal.ts`，判据统一为「`resolved === confirmLabel`」，取消分支零写入；`scripts/verify-modal-cancel.mjs` 同步上**严闸**：生产代码 `modal: true` 只许出现在 helper 内，违规非零退出并挂进门禁。**对消费者**：可见行为等价（确认文案不变、取消仍走系统 Cancel），只是按钮集与判据收进唯一入口。

### Removed（宿主）

- **退役零调用方的资产写盘器与僵尸常量**（`UI-CREATE-PRUNE-1`）：`host/userAssets/write.ts` 的技能单文件落盘与角色包模板复制两套写盘函数在生产侧零调用——表单新建入口剪除后，真实写盘只剩「对话走内核 `write_file`」与「压缩包导入 `zipImport`」两条，留着它就是第二套覆盖语义（`pathExists` → `writeFile` 还带 TOCTOU）。现只把**校验能力**迁到独立的 `validateSkill.ts`（`validateSkillAsset` 只校验、不落盘，由 `zipImport` 复用），写盘函数、`ROLE_PACK_TEMPLATE_REL_PATH` 僵尸常量及其测试一并删除；执行面 / 零写入判据的模块边界写进 `path.ts` 头注释。**对消费者**：零行为变化、零公开导出变动，纯内部收敛。

## [5.4.0] · 2026-11-02

### Deprecated（内核）

- **`OPAQUE_WRITE_TOOL_NAMES` 转废弃登记（本版不移除，6.0.0 移除）**（`DISKWRITE-CUSTOM-1` 尾刀）：该派生集（内置 `diskWrite:'opaque'` 写工具名集）此前挂公共面只为**宿主 `chatPanel` 的旧事件兜底**；判据收敛为 `tool_start` 上报的 `diskWrite` 声明后，宿主已零真实消费、文档亦无承诺。按「公开面只留真实消费或明文承诺」政策，本版**保留导出**并标 `@deprecated`（声明 JSDoc + 手册 §十六 承诺面同批登记），**6.0.0 移除**——移除清单真源 = `tasks/待完成任务.md` · `DEPRECATE-1`。**为什么**：无消费者的公共导出是「顺手 export」的遗留形态，但直接删除会让外部接入者失去预警期；走完一个 major 周期的废弃登记更稳。**对消费者**：本版零行为变化、零编译影响；请改用 `ToolDefinition.diskWrite` 声明自行筛选。

### Added（内核）

- **技能显示名 `SkillEntry.displayName`**（`SKILL-DISPLAYNAME-1`）：`SkillEntry` 增可选 `displayName`，值 = 技能正文首个 H1（解析单点 `utils/scanner.extractDisplayName`，`SkillManager` / `RolePackManager` 共用；围栏内的 `# 注释` 不算标题）。**只供 UI 展示、不进模型面**——L1 清单真源 `SkillManager.formatSkillForPrompt` 仍只读 `name` + `description`（把显示名写进清单，模型会拿中文名去 `read_skill`，而内核按 `name` 寻址，每次必落空）。**为什么**：Agent Skills 规范的 `name` 限定小写英文 / 数字 / 连字符，中文技能只能挂英文 id，宿主的选择器 / 输入盒 chip / 设置页卡片上全是英文。**对消费者**：纯新增可选字段，零既有签名变更、零行为变化；缺失（正文无 H1 / 角色包技能正文未缓存）时由展示面回退 `name`，内核不做兜底拼装。

### Changed（内核）

- **内置角色包技能内容对齐显示名契约**（`role-packs/` 30 个技能）：正文 H1 去掉 `# <id>：` 前缀，收敛为纯中文显示名（如 `# 单一真理源（SSOT）自检`）——此前 H1 重复了 `name` 里的英文 id，界面会显示成「id：中文」。作者规范同步：`docs/architecture/role-pack-spec.md` 的 frontmatter 示例与 skills 条目写明「正文首个 H1 = UI 显示名、不进 L1 清单」；新增守卫用例（`builtinPackCoverage.test.ts`）钉死「每个内置技能有 H1 且不与 name 重复」，防新增技能静默退化为英文 id 展示。
- **后台通道失败升级前台一次**（`BG-ESCALATE-1`）：新增 `src/llm/backgroundProvider.ts` 的 `resolveBackgroundProvider(background, foreground)`，把「后台 Provider 选谁 + 后台失败怎么办」收敛为唯一判定点（装配期与热切换两处接入点各产出一份结果，均注入同一组三个后台消费者）。后台通道（轮次摘要 / 会话归档 / 文本润色）在**未产出任何增量**时调用失败 → 自动用前台 Provider 重试一次；已流出内容、或用户已取消 → 不重试（重发会产生重复正文）。**为什么**：原实现是 `backgroundProvider ?? provider` 裸回退，后台模型一次抖动 = 该次摘要丢失 / 归档跳过，而前台 Provider 明明可用。**对消费者**：零签名变更；未配置后台 Provider 时**原样返回前台实例**（不包装、零开销）；已配置时行为变化仅限「后台失败多一次前台请求」。**边界**：主对话 `AgentLoop` 完全不经过本模块（主对话换档属动态分档，已拒枝）。**同日收口**：`TextPolishManager` 补 `setBackgroundProvider`（形态与 `SessionArchiver` / `RoundSummaryGenerator` 同构），热切换从「归档 + 摘要跟随」补成三个消费者全覆盖——此前用户改后台模型后点「润色」仍走装配期实例；该方法经 `Agent.polish` 对消费者可达，已登记进公开成员面基线。
- **前台换档重解析后台通道**（`BG-ESCALATE-1` 第三刀）：`Agent.setProvider` 此前只替换前台 Provider，后台消费者（轮次摘要 / 会话归档 / 文本润色）仍持有上一次解析结果 ⇒ 未配置后台模型的会话在前台换档后，后台任务继续发往**旧前台实例**。现 `setProvider` 与 `setBackgroundProvider` 两入口统一走私有 `applyBackgroundChannel()`，每次按当前「后台配置 + 前台实例」重新求值，且不再向消费者传 `null`（消费者的 `null` 语义是「回退装配期只读快照」，对热切换无效）。**为什么**：`resolveBackgroundProvider` 的判定点只在这两个入口被调用，腐化形态 = 后加的入口忘了重解析。**对消费者**：零签名变更；未配置后台 Provider 时，换前台后的后台任务改用新前台；已配置后台时升级兜底同样指向新前台。

### Fixed（内核）

- **`diskWrite` 声明覆盖自定义工具**（`DISKWRITE-CUSTOM-1`）：写序判据从「内置工具静态名集」改为「工具定义行 `diskWrite` 声明」（查找序 = 当前定义快照（含自定义工具）→ 内置全量兜底），三处消费面同步收口——① 同路径写串行闸 + opaque 屏障；② 写后 `read_file` 缓存与覆盖度台账失效；③ `tool_start` 事件新增可选 `diskWrite` 字段供宿主改盘追踪，宿主 opaque 分支的 `tool_result` 侧一并改为消费写前登记（写前扫快照 / 写后按登记 diff，一次判定双向对称）。**为什么**：宿主经 `registerTool` 注册的写工具此前绕过串行闸（同一 step 内并行 `insert` + `append` 会静默丢内容）且不触发宿主改盘追踪（扩展安全契约不完整）。**对消费者**：`ToolDefinition.diskWrite` 自本版起对**所有**工具生效（含自定义）；`PATH_WRITE_TOOL_NAMES` / `OPAQUE_WRITE_TOOL_NAMES` / `WRITE_PATH_EXTRACTORS` 保留作内置契约钉与旧事件兜底，不再是唯一判据来源。
- **写侧止损覆盖声明型自定义写工具**（`DISKWRITE-CUSTOM-1` 补面）：`write_loop` 原只 `matches('write_file')` ⇒ 自定义写工具的「同路径连续失败」不进止损。现按工具声明 `diskWrite:'path'` 接入失败连击判据（只依赖目标路径 + 执行失败，与写入模式无关）；**整文件覆盖连写仍只认内置 `write_file`**（自定义工具无 `mode` 约定，缺省不得当成 overwrite，否则会冤拦正常增量写）。自定义写成功只清本路径失败计数、不推进内置连写链（防污染）。**对消费者**：注册 `diskWrite:'path'` 的自定义写工具连续失败达阈值会被 `[WRITE_FAIL_STOP]` 拦截；`diskWrite:'opaque'` 不接入（路径不可静态定位，无计数主体）。

## [5.3.0] · 2026-10-31

### Added（内核）

- **`Agent.currentRoundId()`**（`INTERRUPT-SETTLE-1`）：读当前在途轮次 id（`''` = 无在途轮），与 loop 层同源同值、不缓存副本。**为什么**：`TurnState.waiting` 投影**不含** roundId（ask 挂起时轮身份从快照里消失），而 ask 期停止收场需要轮身份做归属（折叠区归属 / 容器底栏时间与复制/分叉/删除 / 分叉锚点）；缺它时宿主 `settleRoundFooter` 首行 `if (!roundId) return` 直接早退，中断轮底栏整块不出现（真机 2026-10-31 实证）。**对消费者**：纯新增成员，零既有签名变更、零行为变化；放弃动作走独立的 `abandonTurn()` 读口（见下），轮身份与放弃结果互不耦合、两个读口各管一件事。

- **`Agent.abandonTurn()`**（`TURN-EXISTENCE-1` · ADR-044 二/三刀）：主动放弃当前在途轮的单点原语——① `cancelAsk()` 取消在途提问（只动进程内 `pendingAsk`，保 tool 配对不变量）；② `appendInterrupted` 中断收场落盘（盘面得一条诚实的中断记录，失败降级告警不抛）；③ 清当前暂停检查点并以结果作 `boolean` 返回（宿主据此提示「检查点已清理」；无检查点返回 `false`）。**为什么**：停止一个停在 ask / 长循环的轮此前没有内核原语，「放弃」语义散在宿主各处。**对消费者**：纯新增成员，零既有签名变更、零删除。
- **导出 `isRoundSuccessful`**（`METRICS-OWNER-1` 缓冲 · `INTERRUPT-SETTLE-1` 顺手修）：「轮是否成功收场」判据单点（盘面 `status === 'complete'` 投影），与既有 `isRoundSettled` 同文件同族挂出。**为什么**：宿主 `metrics.success` 原为宿主私有口径（`!aborted && !paused`），会把内核 failed 收场（盘面 `interrupted`）误标成功；判据收口内核后宿主不再自写状态比较。**对消费者**：需要「成功/失败」口径的面直接消费该函数，勿再自写 `status` 比较（与 `isRoundSettled` 同一条禁令）。
- **导出 `isWithinLocalDay`**（`E2E-TZ-SALVAGE-1`）：本地日期 ↔ UTC 时间戳换算判据单点（本地日区间 `[D 00:00, D+1 00:00)` → UTC 比较）。**为什么**：会话 ID 用本地日期、轮 `createdAt` 用 UTC 的双口径换算此前内核与宿主各写一份（宿主那份写错即漏打捞，见 Fixed）。**对消费者**：任何「按本地日过滤 UTC 时间戳」的面复用同一函数，不另立换算。
- **`AskQuestion` 增可选 `askCallId`**（`ASK-BATCH-IDENTITY-1` · ADR-043）：多问批次每题的身份 = 对应 `ask_user` 工具调用 id，由 `parseAskCalls` 按序单点填入（第 i 题 ↔ 第 i 个 toolCallId，与 `pendingAsk.toolCallIds` 同序同源，零新增状态），并随 `onPendingQuestion` / `question_pending` chunk / `takeAnsweredAsk` 快照贯通到落盘链路。**为什么**：运行时行 id（宿主自造）与盘面行 id（内核装配）两个产地、永不相遇，「实时行-重放行」配对只靠时序巧合。**对消费者**：纯新增可选字段，零既有签名变更；不做身份配对者可忽略。

### Fixed（内核）

- **ask_user 整批空问题不再挂起**（`ASK-QGUARD-1`）：`question` 空 / 纯空白的整批调用此前照常挂起等用户作答，只能干等 ask 超时（默认 30 分钟）。现整批空当场拒收：以明确错误回喂 tool result，让模型同轮重问。不变量保持：整批逐条回填 tool 消息（配对不变量不破）；`askCountThisTurn` 不计未发出的提问（askLimit 语义是防打扰，空问题不构成打扰）。**对消费者**：行为变更——全空批次立即收到错误而非静默等待；含至少一个非空问题的混合批仍正常挂起（混合批里的空问题单列 `ASK-MIXED-BATCH-1` 观察中）。
- **在途提问崩溃前落盘**（`E2E-ASK-LOSS-1`）：AI 已提问、用户未答时进程死亡 ⇒ 问题文本此前**完全丢失**（盘上轮只有 user 消息，重启只剩「没有问题的中断」，真杀进程实测）。现提问在挂起前随轮落盘，重启后收场转化出逐题 `unanswered` 记录——「问了什么、给了什么候选项」重启可回看。**对消费者**：自实现 `IRoundStore` 者无需改接口（落盘走既有 `pendingAsk` 字段）；崩溃重启后提问不再丢。
- **多问批次逐题落盘**（`ASK-MULTI-Q-1`）：作答 / 超时 / 批次内跳过三形态每题各落一条持久记录——作答题 `question-answer` + 各自答案、跳过题 `unanswered` + `[ASK_ABORTED]` 占位（与 LLM 收到的 tool result 同构）、超时整批 `timeout` + 超时通知。此前落盘只取首问，Q2..N 的问题与候选项只存活在内存。**对消费者**：重启回放多题批次可见完整 N 条问答对；`takeAnsweredAsk` 返回元素结构扩宽（成员名不动，旧读者结构兼容）。
- **凌晨崩溃轮打捞的时区口径**（`E2E-TZ-SALVAGE-1`）：会话 ID 用本地日期、轮 `createdAt` 用 UTC ⇒ 本地 00:00–08:00 创建的中断轮打捞不到（UTC+8 下每天 8 小时窗口静默丢轮）。换算判据收敛为单点 `isWithinLocalDay`（见 Added），内核 `inMemoryRoundStore` 与宿主 `WorkspaceRoundStore` 同一函数同判据（单侧改 = 分叉，已被测试钉死）。**对消费者**：打捞过滤如自行实现，复用该单点，勿再手写换算。
- **未收场轮不再「凭空消失」**（`TURN-EXISTENCE-1` · ADR-044 一/四刀）：轮的存在性不再绑死「收场」——建轮即入会话视图（此前一轮要等收场才可见；ask 超时等停滞轮在会话视图不可见、重启后也不被当「需打捞的中断轮」，用户体感「说过的话凭空消失」而盘上仍在，真机 2026-10-31 实证）；ask 超时兜底去相位化（停滞轮有确定性收场兜底）；孤儿判据口径随之收窄。**对消费者**：自实现会话视图 / 回收判定者将看到轮在创建期即出现；`Round.refCount` 语义以 `roundStore.ts` 注释为准。

## [5.2.0] · 2026-10-29

> **本区归属**：仅**内核**变更；SemVer 定档**随本区收口复核**——本区现有三批：①**文档 + 测试守卫**（**运行时代码零变更、公开面零变更**），含**三件契约守卫增量**（公开面 diff 快照 / 可达成员面冻结表 / 随包接入指南一致性，封住三处「消费者可感知的契约变更会静默通过」的真实漏洞）与**一件文本卫生守卫**（全仓 U+FFFD 乱码扫描）；②**一处运行时行为修复**（`ISessionStore.loadMessages` 的附件契约补齐，见 Fixed 小节，**公开面零变更、零签名变更**）；③**一处运行时功能项**（图片输入内核面，见 Added 小节——`ImageRef` / `ImageResolver` / `imageTokens` 三导出与三个 `attachments?` 字段在 5.1.0 中均不存在，**公开面纯新增、零删除、零既有签名变更**）。③ 使本区按 SemVer 定档 **minor（5.2.0）**——与 2026-10-27 拍板的版本号自洽；①②单看是 patch，被③吸收。
> **收据与拍板过程**：见仓库台账（npm 包不含）ID 锚 `RUNTIME-TIER-1`（运行时门槛）/ `PUB-SNAPSHOT-1`（公开面快照守卫）/ `PUB-REACHABLE-1`（可达成员面守卫）/ `GUIDE-AUDIT-1`（接入指南核查）/ `GUIDE-GUARD-1`（接入指南守卫）/ `ONBOARD-MIN-1`（最小接入面叙事）/ `FFFD-GUARD-1`（全仓乱码清零与扫描守卫）/ `IMG-1`（图片内核面）/ `IMG-3`（能力位透传链）。
> **发版纪律**：本区标题日期须在打 tag 前改为实际发布日（`scripts/verify-changelog-version.mjs` 挂 `release.yml` 校验；已发布 tarball 不可变，见 `RELEASE-CHLOG-DATE-1`）。

### Added（内核）

- **公开面 diff 守卫「向 E」**（`PUB-SNAPSHOT-1`）：`publicApiSurfaceGuard.test.ts` 新增公开面 ↔ **冻结快照**（2026-10-27 冻结，计数以快照数组自身为准）逐位对账——删除或改名任一 `src/index.ts` 导出即红。**为什么**：原向 A/B/C/D 全部从「现存集合」出发迭代，符号一旦被删就不再被任何闸门检查——**任何被删除的导出都会全库静默**（实测：删 `isRoundSettled`，它**宿主真实消费**但不挂文档承诺面 ⇒ 仅向 E 变红、其余全绿）。**对消费者**：零运行时行为变化；此后删除公开导出必走「清算 README / 手册承诺与全部消费方 → major」的显式流程。新增导出仍先过向 A，同批补进快照（快照注释写明二选一更新纪律，不存在「改断言让它绿」的第三选项）。
- **可达成员面守卫**（`PUB-REACHABLE-1`）：`publicMemberSurfaceGuard.test.ts` 新增「可达成员面」层——冻结**经已登记符号的公开 getter 返回、但未挂 `src/index.ts` 导出面**的类的公开成员清单（实测 **7 类型 / 133 成员** = `AgentLoop` / `ToolExecutor` / `MessageHistory` / `SkillManager` / `SecurityGuard` / `WorkProjectionManager` / `TextPolishManager`），增删即红。**为什么**：该守卫原只遍历**导出符号** ⇒ 不挂导出面的类完全不在射程——`SecurityGuard` 虽未从包入口导出，但 `Agent.get security` 返回它，消费者（宿主设置面板 / 装配层）**真实在调** `agent.security.setConfirmWrites(...)` 等方法，而 5.1.0 新增的 `requestToolCallConfirmation` 也在该面上 ⇒ **删改这些方法此前任何闸门都不红**（消费侧仅 TS 编译期拦截）。**对消费者**：零运行时行为变化；此后这类「经公开 getter 可达」的方法增删同样必走审查（新增 = 真能力还是谎报？删除 = 纠谎还是误删？），不再静默。冻结范围经三轮收紧（排除 TS 内置类型 / 内部协作对象 / 零消费类型），避免「为完整性而完整性」给内部实现上枷锁。
- **随包接入指南一致性守卫**（`GUIDE-GUARD-1`）：`integrationGuideGuard.test.ts` 把 `docs/memora-接入指南.md`（**随包发布**、22 个可照抄的 TS 代码块）纳入机检——① 代码块 `import` 的符号必须存在于 `src/index.ts` 导出面；② 代码块与行内 `agent.X` 必须是 `Agent` 公开成员（**解析 `extends` 链**，故 `agent.on` 不假红）；③ 文档**自称「接口全集」**时示例类必须实现接口全部必需成员；④ 扫描面归零即红（防路径漂移导致恒绿）。**为什么**：该文档此前**不在任何文档守卫射程**（既有守卫只对账 README 与 API 手册），两处真伤因此长期存活——示例里的 `appendMessage` **内核全仓不存在**（`ISessionStore` 有 11 个必需方法，示例只写 3 个 ⇒ 消费者照抄必编译失败）、`agent.projects` 僵尸引用（该 getter 已于 5.0.0 随项目层退役）。**对消费者**：零运行时行为变化；此后该指南的 API 引用与「照抄可编译」承诺随内核一起被机检。判据全部**实时读源码**（不建冻结表 ⇒ 无第二份真源）；**历史留痕**（明写「已移除 / 已退役」的表述）与**合法节选**示例均豁免，不误伤正确写法。
- **全仓 U+FFFD 乱码清零 + 替换字符扫描守卫**（`FFFD-GUARD-1`）：新增 `src/__tests__/replacementCharGuard.test.ts`——对全仓十二种文本后缀（含 `.trae` / `.github` 等隐藏目录）扫 U+FFFD 替换字符，判据为「零违例 + 扫描面下限断言（防空集假绿）+ 判据探针自检 + 与 `scan:phrase` 排除集的逐元素同源契约（防双写漂移）」；同批清零 **4 处存量乱码**（内核 `textSanitize.ts` 生产注释、宿主 `chatView.ts` 注释、仓库台账与方案文档各 1 处——生产注释**随编译进 dist .js 出货**，见 `package.json` 构建无 `removeComments`）。**为什么**：乱码是「没有任何测试会红」的伤（读者肉眼可见、机器不报错，与措辞折叠同族），4 处经 git 溯源均 **born corrupt**（入仓即带、原文不可从 VCS 恢复，只能语义重构），此前无任何闸门扫描此类损坏。**对消费者**：dist 注释里一处乱码的文本修复（零运行时行为变化）；此后文本文件混入替换字符在测试闸门即红。
- **图片输入（多模态用户输入）内核面**（`IMG-1` / `IMG-3`）：公开面**纯新增**——① `ImageRef`（宿主采集侧构造的图片引用：`sha256` / `mime` / `width` / `height` / `bytes` / 必填 `name`）；② `ImageResolver`（宿主持有的**运行时回调**，把 `ImageRef` 物化为 `{url}` 或 `{text}` 占位文案——内核零外部 IO，回调不可持久化、不进任何配置 DTO）；③ `imageTokens`（单图 token 估算**单点公式**，入参只要宽高子集，宿主入口限额直接复用，不各写一份数学）；④ `Message` / `RoundMessage` / `SessionMessage` 各增可选 `attachments` 字段（随 `loadMessages` 恢复链带回，见 Fixed 小节）；⑤ `ProviderConfig` 增 `supportsVision`（缺省 `false`——「声称看得见图却看不懂」比「坦承不支持」危害更大）与 `imageResolver`；⑥ `Agent.chat` / `AgentLoop.processUserInput` 增可选 `attachments` 参（仅流式入口承载）。带图请求发往未声明 `supportsVision` 的模型时**一级门禁 fail-closed 明确拒绝**（读**路由后** provider，非配置快照）；resolver 未命中的图推**可见占位文本块**，绝不静默丢。**为什么**：多模态输入的内核契约与执行面——OpenAI `image_url` 形态序列化、token 计量与占用环复用同一公式、无附件请求体**字节级不变**（快照守门）。**对消费者**：不用图片的既有代码零影响（`attachments` 不带即字段不存在）；要用图须三件齐备——模型声明 `supportsVision` + 注入 `imageResolver` + 调 `chat()` 时传 `attachments`。

### Fixed（内核）

- **`ISessionStore.loadMessages` 的附件契约补齐：历史图片随轮恢复，并按窗口衰减**（`IMG-2` 断点B）：`ISessionStore.loadMessages` 的 JSDoc 新增契约句——user 消息**必须**带 `attachments`，且经 `LOOP_CONSTANTS.RETAIN_IMAGE_ROUNDS` 窗口衰减；内核 `InMemorySessionStore.loadMessages` 与宿主 `WorkspaceSessionStore.loadMessages` 同批落地，两实现与 `messageHistory.loadRoundBasedMessages` **同判据同构**（`当前索引 − 消息索引 < 4`，索引一律 `roundIds.indexOf(round.id)` 取位——`getByIds` 会跳过缺失轮，用返回数组下标必错位）。**为什么**：本方法是内核 `restoreHistory` 的**唯一上游**，此前只透传 `role / content / timestamp / roundId`，漏掉了 5.0.0 起就存在于 `RoundMessage` 的 `attachments` ⇒ **重启宿主后历史图片全灭**（模型只见纯文本，连 D7 占位都没有；真机验收实锤）。**对消费者**：`loadMessages` 返回的 user 消息此后**会带** `attachments`（仅窗口内轮次）——自行实现 `ISessionStore` 的消费者不补该字段不会有任何报错，但历史图对其模型不可见；不需要该行为者可忽略该字段。**零签名变更、零公开面变更**；`RETAIN_IMAGE_ROUNDS` 仍是单点常量（其注释已同步登记**四个消费点**：三处窗口衰减 + 一处预读量）。

### Changed（内核 · 文档）

- **运行时门槛双档口径**（`RUNTIME-TIER-1`）：README 中英各三处对齐（「运行时要求」声明块 / 技术栈表行 / IMemoryStorage 表行）——包门槛 Node.js ≥ 22.0.0（与 `package.json#engines` 同源，**engines 刻意不收紧**，2026-10-16 A1 拍板）；SQLite 落盘工厂 `createNodeSqliteStorage`（`node:sqlite`）需 **Node ≥ 22.13**（22.13 起免 `--experimental-sqlite` 标志）。低于 22.13 时包可正常加载、内存存储照常可用，仅调用该工厂抛「需 Node ≥22.13」的 `NOT_AVAILABLE` 明确错误，**不会静默失败**。**对消费者**：npm 安装面此前只见 22.0.0 门槛、不知第二档能力线，现补齐双档事实。
- **最小接入面叙事**（`ONBOARD-MIN-1`）：README 中英边界声明后各增一段——构造 `Agent` 必填仅 **`projectPath` / `provider` / `dataDir` 三项**（`dataDir` 无缺省值，与 API 手册 §〇.5 同口径）；`storage` 缺省为内置内存实现（对话与记忆闭环照常，仅不持久化），`sessionStore` / `roundStore` / `tracer` 与五个外部工具 provider（`web_search` / `web_fetch` / `run_code` / `search_project` / 环境上报）均可选，不配只是不启用对应能力、不阻塞启动。**对消费者**：纠正「接入需自实现一整套存储/会话接口」的错觉——要落盘直接用内置 `createNodeSqliteStorage` 工厂，无需自实现存储接口。

## [5.1.0] · 2026-10-25

> **本区归属**：仅**内核**变更；SemVer = **minor**（零删除 / 零既有签名变更；**行为变化共三处、均为修复方向、不构成破坏性**：① 脚本族执行面按正文裁决，命中黑名单/恒弹清单的执行行为收紧；② 写侧护栏判据改为「无进展」（`write_loop` 只计整文件覆盖与连续失败写，增量写不再计数）；③ `task_table_update` 不再被跨轮幂等跳过（防回喂旧任务表）。三者均见 Fixed 区）。公开面**分两层**：① **包入口符号面**增量 = **仅** `ToolDefinition` 加可选字段 `confirmPolicy`（类型面）——`SecurityGuard` 类与 `SCRIPT_READ_MAX_LEN` 均**未**从包入口 `src/index.ts` 导出；② **公开成员面**零新增（`publicMemberSurfaceGuard` 成员表未增元素），但 `agent.security` 本就是公开成员，其新增方法 `requestToolCallConfirmation(toolName, summary, needConfirm)` 对消费者**可达**（文档见 `docs/memora-api-reference.md` §2.6）。宿主侧 MCP 消费面（连接 / 设置页 / 审批卡）随宿主下一版独立成区、不占内核版本号（ADR-033）。逐条拍板与变异验证收据见仓库台账（npm 包不含），**按条目 ID 检索**（`tasks/待完成任务.md` 与 `tasks/archive/5.1.0-kernel.md`，不按区名——已发行版本区已于 2026-10-26 归元折叠）：`D1-MCP`（顶层条目仍留主台账 `tasks/待完成任务.md`）；`CMD-1-BYPASS` 的实现收据见主台账 `㉔` 条、最后一面见 `tasks/archive/5.1.0-kernel.md` 的 `CMD-1-CONTENT` 条目；`CMD-1-CONTENT` / `GUARD-WRITE-PROGRESS-1` / `IDEM-TASK-TABLE-1` 均在 `tasks/archive/5.1.0-kernel.md`。
> **发版纪律**：本区标题日期即**实际发布日**——`scripts/verify-changelog-version.mjs`（挂 `release.yml`，不进 pre-push）校验「合法日历日期 + 与发布日相差 ≤1 天」；已发布版本的 npm tarball 不可变、改不回来（`RELEASE-CHLOG-DATE-1` 血训），故日期须在打 tag 前定稿。
> **日期口径（2026-10-27 澄清）**：本区标题日期 = **打 tag 的那个日历日（本地时区）**；台账「版本索引」的发布日期列 = **npm 上架日（北京时间）**。二者可能差一天（5.1.0 = 本区 10-25 / 上架 10-26，跨午夜）⇒ **两者都正确，非笔误**。

### Added（内核）

**MCP 工具接入的内核接口（`D1-MCP` 切片 0 · 2026-10-23）**——MCP SDK 与传输全在宿主依赖，内核仍不认识 MCP、零第三方运行时依赖不变

- `ToolDefinition.confirmPolicy?: 'always' | 'audit'`：自定义/外部工具（如宿主接入的 MCP 工具）声明审批意图的**唯一字段**。**缺省 = 字段不存在 = 不过闸 = 现状**；刻意不设 `'never'`——宿主只需「关弹窗」，不需「关审计」。
- `SecurityGuard.requestToolCallConfirmation(toolName, summary, needConfirm)`：复用私有 `confirmGate` 的**单一确认入口**（一次入口、两种模式），`ToolExecutor.execute()` 的 custom 分支按上述字段过闸——`'always'` 弹确认、`'audit'` 自动放行但仍落审计，拒绝则不调 handler（`[ERR:TOOL_DECLINE]` + blocked outcome）。**为什么重要**：此前 custom 分支完全不过闸 = 动态工具源（MCP）零审批；补后**全仓仍只有一条审批路径**，不存在第二条。
- 审计**零新增类型**：确认统一走后恒落既有三值（`write-auto` / `write-confirm` / `write-decline`），工具调用补 `source: 'custom'` + `tool` + `path`（= 调用摘要，与 `run_command` 把命令塞 `path` 同构）；`confirmGate` 加可选 `source` 末参并透传**全部四个**审计出口（写入类不传 = `undefined`，零行为变化）⇒ 宿主既有「denied 计数」自动覆盖 MCP，宿主审计面零改动。
- `ToolExecutor.removeTool()` 的 JSDoc 由「供测试场景使用」扩为「运行时可注销」（`K2`，零代码改动）——宿主据此实现 MCP server 停用与工具集整换。
- **对消费者**：纯增量。不声明 `confirmPolicy` 的既有自定义工具行为完全不变；要接入动态工具源的宿主声明字段即得审批 + 审计。
- ⚠️ **本期刻意不做**（`K3`，有判据的拒绝）：不放宽 `ToolDefinition.parameters` 的 schema 类型（不支持嵌套 object / enum / anyOf）——`loop.ts` 的 prompt 渲染器只读顶层 `type`/`description`，放宽须连带改模型可见文案并回归全部内置工具，收益不抵风险；宿主侧以「结构映射 + 约束搬 description」适配。

**内置角色包 L1 增「编辑纪律基线」（`GUARD-WRITE-PROGRESS-1` 配套 · 2026-10-25）**

- 三个内置包（`memora助手` / `共鸣小说家` / `白话方案设计师`）的 `rules.md` 增一条**领域无关的编辑纪律**：增量写入优先（`replace` / `insert` / `append`）、同一文件多处修订在**同一回复内连续发出**、整文件覆盖仅用于确需重建且不反复覆盖、复核只读改动片段。`role-packs/` 在 `package.json#files` 内，**消费者可见**。
- 作者指南 §2.4 同步该基线，并明示 **L1（`rules.md` / `persona.md`）不得写运行时拒绝令牌**（`[WRITE_LOOP_STOP]` / `[WRITE_FAIL_STOP]`）——L1 常驻 system prompt，令牌会干扰「按令牌定位运行时拒绝消息」的消费方（纪律真源 `src/agent/guardRail.ts` GUIDELINES）。
- **为什么**：写侧护栏只拦「无进展」，**不拦「慢」**——真正决定模型行为的纪律必须写在 L1；真机 `round-1792904123909`（7 次被拦、5 处修订拖到下轮、27 分钟 / 116 万输入 token）即缺该条所致。

### Fixed（内核）

**脚本面内容裁决（`CMD-1-BYPASS` · 2026-10-25）**

- `SecurityGuard.confirmScriptRun` 接受可选第 4 参 `content`（= 将被执行的脚本/代码正文），内部喂给**同一个** `classifyCommand`：`deny` 恒拦（任何档位/权限，不进确认流程）／`always-ask` 恒弹（`owner` + `confirmScripts=false` 也弹）／`normal` 回落原档位判据。**为什么**：此前 `classifyCommand` 的唯一调用点是 `confirmCommandRun`，脚本面只看档位不看内容 ⇒「把 `git push` / `rm -rf` 写进脚本」零护栏，恒弹清单成了纸墙（一次工具调用即可绕过）。
- 已接入两面：`run_code`（内联代码传正文）、`run_project_script`（确认前读脚本文本）；正文 > `SCRIPT_READ_MAX_LEN`（20 万字符）**拒绝执行**（fail-closed，不给「读不动就放行」的口子）。
- `ALWAYS_ASK` 清单补 `git clean`（此前落 normal 档 = 默认档直接执行，真洞）。
- `BuiltinToolHandlers.readScriptFile` 加可选 `label`（默认 `run_code script_path`）：复用读正文时审计归属不再写死 `run_code`（原会把项目脚本的路径审计记到 `run_code` 头上 = 归属说谎）。
- 三处 decline 文案改中性措辞（「未获执行许可（命中恒拦 / 用户拒绝 / fail-closed）」）——原写「未获确认（用户拒绝…）」会把命中黑名单说成用户拒绝。

**技能脚本内容裁决（`CMD-1-CONTENT` · 2026-10-25）**

- `run_skill_script` 是脚本族最后一面（此前只判档位）。现确认点经装配期新注入字段 `ToolExecutor.resolveSkillScript`（与执行回调**共用** assembler 的 `resolveSkillScriptTarget`：角色包 → 全局池，解析顺序天然单点）定位脚本文件读正文，喂同一个 `classifyCommand`。
- 长度上限复用 `SCRIPT_READ_MAX_LEN`（本轮改为导出常量，三消费面共用，**不造第二上限**）；**不走项目根白名单**——技能目录 = 可信根（脚本经作者审阅），路径防逃逸由解析器自身保证（角色包 layer3 白名单 + `resolveSafePath` 边界 / 全局 `resolveLayer3ScriptPath` + 存在性校验）。
- fail-closed 分级：解析不到 = 不传正文（维持 `[ERR:SCRIPT_NOT_FOUND]`，执行点同一解析必返 null）；读失败 / 超长 = `[ERR:SCRIPT_DECLINE]` 拒绝执行。
- **对消费者**：`runSkillScript`（执行回调）契约与行为不变；不注入 `resolveSkillScript` 的装配（含既有单测）行为与补齐前完全一致。**至此四个执行面（`run_command` / `run_code` / `run_project_script` / `run_skill_script`）全部按正文裁决。**

> **不声称的内容（防误读）**：`classifyCommand` 是**字符串判据**——拦「模型手滑 / 幻觉 / 提示注入直接写出危险命令」，不是「危险执行总闸」；正文之外的间接载体（变量展开、编码混淆、执行期才决定的路径）拦不住。语义防护由**用户审批 + 审计溯源**承担，不由 denylist 承担。

**写侧护栏判据改为「无进展」（`GUARD-WRITE-PROGRESS-1` · 2026-10-25）**

- `write_loop` 原判据 = 「同路径连续写 N 次」，把 `mode=replace` 的逐处修订与整文件覆盖混算：第 5 次写入即硬拦，且被拦后 `read_file` **不复位**计数（`notifyExec` 原先只按 `matches` 分发，读事件根本喂不到该护栏）⇒ 该路径在**本 turn 内永久封死**。真机 `round-1792904123909` 实证：7 次被拦、5 处修订拖到下轮、27 分钟 / 116 万输入 token。
- 现判据 = **无进展信号**：① 仅整文件覆盖（`mode=overwrite`，缺省）计入连写（阈值 `writeLoop` 不变 = 5）；② 增量写（`replace` / `insert` / `append`）每次改不同片段，**永不计数**；③ 同路径连续**失败写**达新增静态阈值 `writeFail`（= 3）即拦，读成功 / 写成功即清；④ `failed` 不再被当作一次写（原实现会推进 streak）。
- `notifyExec` 改为**全量分发**（各护栏在 `onExec` 内按工具自过滤）——原「借 `matches` 路由」让一个字段担两份职责，护栏文案承诺的「先读再写」出口从未生效。
- 新增**放行钩子** `onAllow` / `notifyAllow`（同批洞补丁，真机 `round-1792919558093`）：同批工具调用先集中判定、后统一执行，判定阶段看不到结果 ⇒ 只靠执行后回喂的连写计数会被「一条回复内连发 N 次整文件覆盖」整批绕过（实测 6 次全部放行）。现于派发时**预登记整文件覆盖意图**，第 5 次同批覆盖即拦；执行回喂消费预登记（一次写只计一次），被拦未执行则撤销。增量写不登记（批量逐处修订仍零计数）。`write_fail` 刻意不预登记——批内看不到失败结果，预拦会误伤同批中本可成功的写。
- 文案：`[WRITE_LOOP_STOP]` 的出口改为**可执行**的「改用 replace/insert/append 增量写入」；新增 `[WRITE_FAIL_STOP]`（先读最新原文再写）。
- **对消费者**：`BlockedReason` 未新增/未改名（仍是 `write_loop`）、零公开签名变更、零新增 metrics 字段（拦截事实已在 round 事件的 `tool_result.blocked` 中，另立计数即第二真理源）。行为向修复：同一 turn 内对同一文件的增量修订不再被封顶。

**任务表更新不再被跨轮幂等跳过（`IDEM-TASK-TABLE-1` · 2026-10-25）**

- `BUILTIN_TOOL_IDEMPOTENCY.task_table_update`：`idempotent` → `non-idempotent`。**为什么**：幂等键只有 `name + 完整 args`，而 `task_table_update` 的 `plan_item_id` 是**位置序号**——跨轮 `task_table_write` 重写任务表后，同序号可能指向另一个任务项；此时同 args 重发会被「仅一次语义」跳过并回喂上一轮的旧任务表摘要 = **向模型谎报「已更新」而实际未更新**（真机观测：回显旧任务项）。重跑本身无害（状态确定），故与 `delete_file` 同判据——归入「禁止跳过」而非「重跑有害」。
- **对消费者**：`IdempotencyLevel` 枚举未变、零签名变更；仅该工具不再被跳过。内置映射现**无** `idempotent` 级工具（级别本身保留，供宿主自定义工具声明）。
- 同族**未改**（登记观察，不随本版动）：`write_file`（`idempotent-key`）跨轮「同 path + 同 content」仍会跳过——若文件在两次调用间被外部删除/改动，同内容重写不会落盘。无真机实证，且该跳过是核心重试去重通道，改动面大。

## [5.0.0] · 2026-10-23

> **📖 升级必读**：[`docs/memora-升级指南-4.x-到-5.0.0.md`](docs/memora-升级指南-4.x-到-5.0.0.md) —— 本区所有 Breaking 项的**改法**逐项在那篇，本区不重复**怎么改**。
> 本区归属：仅**内核**变更；SemVer = **major**（编译期破坏：删 23 个导出符号 + 32 个公开成员 + 3 个事件）。

### ⚠️ Breaking Removed（内核）

**多项目链整体删除（形态定案：一个 Agent = 一个项目 · `PR-SWITCH-1` / `PR-SWITCH-2` / `PUB-API-PRUNE-3`）**

- 删：`Agent.switchProject()` / `projectSwitched` 事件 / `AgentOptions.registryDir` / `agent.projects`（`list`·`registerProject`·`unregisterProject`）/ `ProjectRegistry` 类导出 / `ProjectEntry` 类型 / `projects.json` 写入 / `Agent.init(projectPathOverride?)` 的路径参数（变无参）/ `Agent.rebuildComponents()`。
- 为什么：注入的 storage **不随切换重建**——切了项目、存储不跟着换，**用了会错**（不是「没人用」）。多项目改用「宿主为每个项目各建一个 Agent 实例」；项目名推断摘为 `projectManager` 模块级纯函数保留。

**目标漂移检测链退役（`GOAL-DRIFT-1`）**

- 删：`SessionManager.updateGoal()` / `goalDriftDetected` 事件 / `SessionCheckpoint` 的 `mainGoal`·`currentGoal`·`goalChangeSeq` / `createCheckpoint(mainGoal?)` 入参（变无参，返回类型收窄为非 null）/ `goalConsistencyChecker` 整模块。
- 为什么：字面相似度判据实测**零区分度**（12 组正常子任务 12/12 判漂移，与 6 组真漂移完全不可分）；「两段文本是否意图一致」属语义判断，内核零依赖架构下永无可接模型。目标偏离防范交还用户在环 + `ask_user`（引导句属角色包 `rules.md` 范畴，当前零配置，见台账 `GOAL-DRIFT-2`）。

**记忆治理门面退役（`GOVERNANCE-SRC-1`）**

- 删：`MemoryGovernance` 类导出 / `agent.governance` getter / `dedupCompleted` 事件 / 装配产物 `dedupManager`·`memoryAdvisor`。
- 为什么：`deduplicate()` / `detectConflicts()` / `suggest()` 逐 `GOVERNANCE_SOURCES` 取样，而该常量是**字面量空数组**——代码路径永远拿不到输入，去重数恒 0、冲突报告恒空、推荐恒 `[]`。唯一有效的 `sourceHealth()` 计数口径已由 `agent.memory.stats().bySource` 覆盖（`daysSinceLastAccess` / `diagnosedAt` 无替代，宿主从未消费）。**写时治理不受影响**：`supersede` 写时取代 + `supersededBy` 软指针才是真实生效的治理路径。

**公开面通用工具收面（`PUB-API-PRUNE-1`，函数本体保留在内核内部）**

- 删导出：`truncate` / `isPlainObject` / `safeSetTimeout` / `safeSetInterval` / `clearSafeTimeout` / `clearSafeInterval` / `segmentText` / `escapeLike` / `serializeFrontmatter` / `toError`（11 个通用小工具，均与 Agent 领域无关、宿主零 import）+ `createLlmProvider`（与规范入口 `createProviderFromConfig` 重复）。唯一本体同删：`escapeLikeSnippet`（收面后零调用；SQLite 后端自实现仍须转义 `%`/`_` 并 `LIKE ? ESCAPE '\'`，规则在 `IMemoryStorage` 接口注释）。

**内部机制与默认实现收面（`PUB-API-PRUNE-2` / `PUB-API-PRUNE-4`，能力不撤、只收回公开位）**

- 删导出：`safeFetch` / `safeExecuteCode` / `safeSearchProjectFiles` / `safeSearchProjectText`（provider 超时包装，保护仍生效）/ `InMemoryStorage` / `InMemorySessionStore` / `LockManager`（默认实现收回——显式实现接口或用 `createNodeSqliteStorage`）/ `NOOP_TRACER`（不传 `tracer` 即可）/ `RolePackManager.tryBuildMeetingPlan`（队伍数据改经 `getActiveTeam()` / `getTeam()` 取）。
- 删 Agent 转发门面：`appendPlanItem` / `triggerError` / `recover`（经 `agent.sessionManager.*` 可达）；`injectSystemMessage` 无公开替代（需引导模型写在 `chat()` 输入或角色包 rules）。

**Agent / SessionManager 成员删除（`PUB-API-PRUNE-5` · 2026-10-16 两批 · `CHKPT-1/2/3`）**

- Agent：`canContinueWithoutInput()`（软暂停模型下暂停恒安全，可续跑性由 waiting 原因位表达，方法本身是采样时机不可靠的带陷阱死面）/ `getRecentToolExecutions()`（订阅 `tool_start`/`tool_result` 事件自聚合）/ `getBackgroundTaskStats()` / `forceReleaseChatLock()`（承诺的超时兜底从未接线）/ `heartbeat()`（私有 `touchCheckpoint` 的机制外漏）。
- SessionManager：`flushNow()` / `flushOnShutdown()`（检查点不落盘，二者是 no-op 清脏，方法名谎报持久化）/ `loadSessionMessages()`（改锚点不 restore 工作记忆的陷阱出口）/ `restoreSession(date, session)` / `restoreMostRecentSession()`（恢复双入口并入 `switchToSession('YYYY-MM-DD-session')` 复合 ID，最近会话从自己的 store `listSessionMetas()[0]` 取）/ `isPauseLimitReached()` / `getConsecutivePauseCount()` / `resetConsecutivePauseCount()`（连续暂停计数链从未通电，生产恒传 `lowRisk=true`）/ `compensateTool()` / `compensateAllNonIdempotent()`（只生成文案、零状态变更）/ `isPaused()` / `isRunning()`（三态 `'running'|'paused'|'error'` 被两布尔吞掉 error 态——看 `status`）。
- ⚠️ 上述多项随 4.0.0 已发布，直删失去 deprecation 预警期，由本 Breaking 明示；`loadSessionMessages` 原走 `DEPRECATE-1` 周期，用户拍板提前直删。决策依据 = 三面零消费 + 5.0.0 定档时点未发布（npm 最新 4.0.0）零外部破坏窗口。

**选项与常量**

- 删 `AgentOptions.fileConsistencyCheck`（透传链路先删后字段零读取的僵尸）/ `LOOP_CONSTANTS.MAX_WEB_SEARCH_CALLS`（搜索上限改策略键后零读取的幽灵旋钮，缺省 6 真源归 `DEFAULT_BEHAVIOR_STRATEGY.global.webSearchLimit`）。

### Added（内核）

- **SQLite 存储切片**（2026-10-16，服务 `DSH-1` / `MCP-SERVER-1`）：`createNodeSqliteStorage(dbPath[, { readOnly: true }])` 工厂 + `ReadOnlyMemoryStorage` 类型导出。基于 `node:sqlite` 内建模块**延迟加载**，零三方依赖、`engines` 不收紧（不可用抛 `NOT_AVAILABLE`）；**可用性判据唯一来源 = 调用工厂结果**（宿主禁自行解析 `process.versions.node`）。只读形态写方法结构上不存在、连接只读模式打开不建库（库缺失抛 `MemoraError{FILE_NOT_FOUND}`，`HOST-ALIGN-1`）。语义与 InMemoryStorage 逐位对齐（共用契约套件参数化跑两实现）；写模式 `journal_mode = WAL`。
- **归档防重意图解耦 + 跨进程持久化**（`ARCH-GAP-2`，2026-10-19）：`ArchiveTriggerOptions.skipIfUnchanged?: boolean`（显式优先，否则随 `autoTriggered`，既有语义不动）；防重快照落盘副本 `SessionMeta.archivedMessageCount`（内存 Map 优先双源读写）——宿主重启后不再对「内容未变」的会话重复烧 LLM。
- **记忆命中可见**（`MEM-EVENT-1` / `MEM-EVENT-2` / `MEM-EVENT-3`，2026-10-19）：`memoryRecalled` 载荷补可选 `hits`（命中条目）与 `toolCallId`（与工具调用 1:1 配对，缺省不带键）；`Round.evidence` 新增 `memory_hits` 变体——**实时面走事件、回看面走证据轨**，宿主重放历史轮不再丢命中明细。同批载荷扩展（`MEM-UI-1`）：`hits[]` 元素补可选 `contentPreview`、`memoryAdded` 载荷补可选 `content`（实时轨与 evidence 落盘轨同批，支撑宿主记忆显示正文为主位）。
- **web_search 增强**（`GUARD-SEARCH-1` / `SEARCH-QUALITY-1` P1-1）：联网搜索硬上限抬为角色包策略键 `webSearchLimit`（1~20，默认 6，与 `askLimit` 同构——只解决「不能调」，不改护栏）；新增裁决证据 `web_search_result`（query/endpoint/count/titles 随 Round 持久化，`toolCallId` 配对根治证据错配，0 结果同样留痕）。
- **悬空取代单一判据**（2026-10-16）：`hasActiveSuperseder()` 导出——替代物经物理删/软删移除时旧摘要回退为当前版本可正常召回；判据与移除路径解耦（原「移除点 eager 收敛」是半修复），零数据删除、不改写入语义。
- **单段文本 token 估算挂公共面**（2026-10-20）：`estimateTokensText(text)` 导出——宿主注入量归因（`HOST-CTX-6②`）需要单段计量，原「不挂公共面」是当时无消费面的决定；若宿主自写换算即与运行时口径漂移（第二真理源）。单段用本函数；多段一律 `estimateTokensMessages`（逐段调用会放大取整误差）。

### Fixed（内核）

- **上下文占用快照补动态注入段**（`CTX-OCC-1`，2026-10-16）：此前漏计全部动态 system 注入（最近对话块/情报区/任务表/压力提示等）⇒ `usedPct` 偏小、用户误以为剩余很多。`ContextOccupancy` 增**必填** `dynamicSystemTokens`（杜绝漏填静默归零），段值单点 `loop.getDynamicSystemTokens()`；截断超窗加观测守卫 + 复用摘要 20% 封顶；估算/实测比 >1.5 告警。
- **登录墙识别 + Bing 摘要错位**（`SEARCH-QUALITY-1` P2，2026-10-15）：HTTP 200 登录页不再被洗成正文交付（保守判墙宁漏勿误）；Bing 解析改 `<li>` 块内提取，根除「标题 + 干扰摘要」错位；`FetchedPage.fetchFailed?: true` 区分抓取失败与空内容（失败不谎报为需登录）。
- **技能脚本 cwd 逃逸**（`SKILL-CWD-1`，2026-10-15）：`run_skill_script` 子进程 cwd 由宿主进程 cwd 改为项目根（实锤事故：29 个文件落进 VS Code 安装目录）；`run_code` 内联模式同批对称收口，四执行面 cwd 判据对称。
- **归档模式顺延契约**（`ARCH-GAP-1` / ADR-041，2026-10-17）：`setArchiveMode` busy 时暂存 + 抛错，`chat()` / `resumeExecution()` 双挂点轮终补执行——「对话结束后生效」从文案承诺变真实现。
- **会话替换入口状态闸对称**（2026-10-16）：`assertSessionReplaceable` 单一前置闸，5 个替换入口全部受「非 running 态拒绝」保护（原仅 `switchSession` 有，暂停/错误态替换会留脏快照）。
- **提问链路收口**（2026-10-15）：回答缺答案落 `[ASK_ABORTED]` 占位（杜绝回填他题答案）；暂停记账统一收口 `pause()`，超时清理在途提问。
- **文档与守卫修正**（`DOC-CLAIM-1` / `GUARD-METHOD-1` / `DIST-ORPHAN-1`，2026-10-18）：README 中英 6 处退役能力宣称收回（「发版即失信」级）；API 手册补 9 字段 + 删幻觉符号；`prepublishOnly` 改 `prepack`（堵 `npm pack` 打出含已删模块的 tarball）；新增手册 interface 成员双向守卫（面 B）。

### Changed（内核）

- **后台任务槽位按 Agent 实例隔离**（`MULTI-AGENT-1`，2026-10-18）：模块级槽位 → `class BackgroundTaskScheduler` 实例级，同进程多 Agent 不再交叉等待/挤占（形态定案后多实例是必然）。非公开 API 变更。

## [0.6.0] · 2026-11-02 · 宿主

> **随包内核代次 = `5.4.0`**（esbuild 内联 dist，内核自身变更见内核区）。

### Added（宿主）

- **输入框键入 `/` 直接触发技能选择器（第二入口，零新增界面）**（`SKILL-SLASH-1`）：在输入框行首或空白后键入半角 `/`，即在既有技能菜单上方弹出选择器——此前只能点输入框下方的技能触发入口。触发判据是**文本事实**（`input` / `compositionend`），不认 keydown：中文输入法经 `insertCompositionText` 打出的 `/` 同样能触发；`A/B`、`1/2`、`2026/11/01`、URL 里的斜杠一律不触发。弹窗是**非模态被动提示**：焦点留在输入框，继续键入（字母 / 中文 / 标点 / 粘贴）即自动收起且正文原样保留，不会把 token 当搜索词；`Esc` 收起时已打的字与 `/` 都留在正文；选中后仅当光标前一位确为合法起点的 `/` 才撤该字符。菜单开合以 `.is-open` class 为单一真源，无落点状态、无镜像搜索词。**同日四修**：菜单项改 `<button>` 修键盘导航（原 `div` 无 tab 序）；斜杠态退出（遇空白 / 删到 `/` 前）收起弹窗；「继续输入变搜索」改为直接收起；删掉推测性的 `isComposing` 守卫（真机主路径本就是组合态）。**同批**把输入框占位提示精简为功能说明（去掉「在文档上打磨你的想法……」，保留 `@` 引用文件 / `/` 选择技能 / Enter 发送）。**对消费者**：多一个入口、旧入口不变；Enter 仍是发送（不抢作选中）。

### Changed（宿主）

- **技能显示名贯穿三处 UI**（`SKILL-DISPLAYNAME-1`）：技能选择器菜单项 / 输入盒已选技能 chip / 设置页技能卡标题统一显示 `displayName ?? name`；搜索同时匹配显示名与描述，**选中回传与禁用集仍恒用 `name`**（id 与展示分离）。`skills_loaded` 改为整条 `SkillDto` 透传，不再逐字段拷贝（新协议字段在第二个消费面静默丢失的腐化点一并消掉）。**为什么**：中文技能只能以英文 id 命名，界面上满屏英文 id。**对消费者**：中文命名的技能在界面上显示中文标题；内部寻址、禁用、回传载荷不变。

- **内置技能资源对齐显示名契约**：`code-review` / `summarize` / `web-search` 补中文正文 H1（`# 代码审查` / `# 摘要提炼` / `# 联网搜索`）并统一声明 `layer: agent`（此前三者缺 `layer`，内核按缺失回退 `project`，与「内置来源」自相矛盾）；`role-pack-creator` 的模板说明与校验清单补「正文首个 H1 = 纯中文显示名」一条，新造角色包不再漏写。
- **opaque 快照判据单点化**（`DISKWRITE-CUSTOM-1` 收口）：`chatPanel` 的 opaque 工具判断原带静态名集兜底（`SCRIPT_WRITE_TOOLS`），与同文件「写后按写前登记、不重判工具名」的注释自相矛盾。现统一为事件字段 `chunk.diskWrite === 'opaque'` 单点，常量与内核 `OPAQUE_WRITE_TOOL_NAMES` 的 import 一并退役。**为什么**：`tool_start` 由内核唯一产地恒定携带声明，兜底分支不可达（宿主与内核 dist 同代由 `verify:dist-contract` 保证）。**对消费者**：零行为变化。

### Fixed（宿主）

- **MCP 写工具补上改盘声明**（`DISKWRITE-CUSTOM-1`）：`toolRegistry.toToolDefinition` 映射 MCP 工具时此前从不带 `diskWrite` ⇒ MCP 写工具在内核按「未声明 = 不改盘」处理，绕过同路径写串行闸与宿主改盘追踪。现 fail-closed 映射：server 未声明只读（`annotations.readOnlyHint === true` 且 `destructiveHint !== true`）⇒ 一律 `diskWrite:'opaque'`（与一切写互斥的屏障）；声明只读 ⇒ 无字段（读工具维持完全并发）。**为什么**：MCP 是宿主唯一的动态工具源，声明源头空洞会同时绕过串行闸与「执行前后快照 diff」两条安全面。**对消费者**：MCP 写工具与内置写工具同受串行保护、改动可在改动清单中看到；**残余风险**——`readOnlyHint` 是 server 自报（MCP SDK 明言 ToolAnnotations 不可作工具使用决策依据），谎报只读仍可绕过串行闸。

## [0.5.0] · 2026-11-01 · 宿主

> **本区归属**：仅**宿主**（`hosts/memora-vscode`）变更，随 `vsce package` 定版，不进内核 npm 包（ADR-033）。**开区原因**：`vscode@0.4.0` tag 早于宿主面收口（停止/中断收场链、操作菜单单源、Marketplace 中英双语）。**主体条目随 `git log vscode@0.4.0..HEAD -- hosts/` 补齐**；切片叙事不复述，逐笔变更以该 tag 区间为准。**对外文档不引用内部台账坐标**（区名会随台账重组失效，tag 区间不会）。
> **随包内核代次 = `5.3.0`**（esbuild 内联 dist，内核自身变更见内核区）。

### Added（宿主）

- **Marketplace 元数据中英双语**（`HOST-I18N-1`）：新增 `package.nls.json`（英文）+ `package.nls.zh-cn.json`（中文）+ `%key%` 占位，Marketplace 展示与扩展详情页不再全中文硬编码。**为什么**：此前打包面元数据只有中文，非中文 VS Code 环境下显示中文、且不符 Marketplace 惯例。**对消费者**：扩展在 Marketplace / Open VSX 的中英文展示随系统 locale 切换；运行时 UI 本地化不在本版（仅包面最小切片，决策真源 ADR-042）。
- **右键上下文菜单语义级操作**（`COPY-2`）：对话消息条右键新增「重新生成 / 分叉 / 删除 / 复制 / 引用回复」语义级操作。**为什么**：此前这些动作只能从容器底栏触发，消息条缺右键入口。**对消费者**：在消息条上右键即可执行这些操作；与容器底栏动作收敛为同一真源（见 Changed，两边永远同名同序）。

### Changed（宿主）

- **操作菜单收敛为单一真源**（`ACTIONS-SSOT-1`）：右键菜单与容器底栏的操作动作原本各维护一套、易漂移。现收敛为单一派生源，右键五项 = 底栏三键 + 复制，两边永远同名同序。**为什么**：同一组动作两份实现 = 迟早不一致（实测曾出现右键有「重新生成」而底栏无）。**对消费者**：两处菜单行为完全一致；「重新生成」为破坏性动作（重发整轮），操作前有明确提示。
- **停止 / 中断收场链补齐**（`INTERRUPT-SETTLE-1`）：ask 期停止、异常中断不再「悬着」——过程收进折叠块，底栏出现时间与复制 / 分叉 / 删除按钮，终态标签三态判据归一（异常收场不再被「已完成」抹掉）。**为什么**：此前停止后提问卡悬空、无终态标签、无底栏，用户看不到「已中断」。**对消费者**：正常完成 / 用户中断 / 异常中断三种场景，结束后过程都收起、可展开回看，底栏终态标签正确；真机三场景验收通过。

### Fixed（宿主）

- **多问批次部分作答答案错位**（`ASK-PARTIAL-ANSWER-1`）：提交入口过滤未答项后按位配对，答案串到别人头上。`parseAskCalls` 改用身份配对（与内核 `askCallId` 同序同源），同批多问每题答案落在对应题上。**对消费者**：多问批次部分作答不再答错对象。
- **引用回复事务修复**（`COPY-2-QUOTE-TXN-1`）：引用草稿在发送早退路径被提前消费（丢引用 + chip 与状态分叉），已修。
- **消息条锚点修复**（`COPY-2-ANCHOR-1`）：用户消息条缺 `dataset` 锚导致删除 / 分叉在用户条缺位，已修。
- **截断契约修复**（`COPY-2-OK-CONTRACT-1`）：`truncateTurnCore` 恒返回 `ok: true` 与自身注释契约相反，已修。
- **底栏「重新生成」图标尺寸归位**（`ICON-REFRESH-SCALE-1`）：刷新图标的弧线撑满画布（含描边占 96%，同排图标 72%~78%），视觉上比复制 / 分叉 / 删除大一圈、两个箭头间距过宽。改为圆心居中的真圆弧并内收折角，占位与同排图标一致。**为什么**：同画布同描边下唯一的变量是路径几何，撑满即失真。**对消费者**：底栏动作行四个图标视觉重量统一。
- **多中断轮重放记录消失**（`INTERRUPT-MULTI-1`）：一个会话里停过多次时，重载后除最后一个中断轮外，其余轮的过程记录、问答行、底部操作条全部不见（屏上只剩用户气泡，且该轮无法删除）。根因 = 重放渲染「本轮」时仍在清理「上一轮」的容器，而容器正包着过程块 / 问答行 / 底栏。**为什么**：旧的逐条事件流模型下需要一个跨轮清理，切到「整批重放 + 先整体重置」后这个前提已不存在，清理只剩破坏。**对消费者**：多次中断的会话重开后每一轮记录都在，每轮底栏都能单独删除。
- **删除 / 重新生成删错轮**（`DELETE-ANCHOR-1`）：这两个动作的截断锚原本是时间戳——先找「首条 assistant ts ≥ 锚」的轮，再对无 assistant 的中断轮做**单层**折回。会话里出现相邻两个中断轮时折回退不到目标：点第一轮的删除，被删掉的是它后面那轮（后面是完成轮时 = 静默销毁别的内容、目标轮还在）；后面全是中断轮时则提示「删除失败」、什么都不删。「重新生成」同锚，且会把**别人的原文**重发出去。现锚改为轮身份 `roundId`（`roundIds` 有序真源 `indexOf` 精确定位），三支时间窗启发式（assistant 下界 / 末尾锚定 / 上折回）整体删除；`ts` 降级为底栏时间显示，不再参与任何动作判据。**为什么**：ts 是 Round 的落盘投影（一次落盘时刻），中断轮没有 assistant ts 可锚，用投影反推身份只能靠猜。**对消费者**：任意轮次组合下「删除 / 重新生成」只作用于你点的那一轮；锚失效（该轮已在别处删除）时如实报失败而不是误删；用户提问条右键的「删除」仍在（两半同锚 roundId），分叉仍只在 AI 段出现。
- **「发完就停」的轮在重载后整轮消失**（`REPLAY-EMPTY-INTERRUPT-1`）：消息发出后立刻停止、或崩溃后被打捞的中断轮，这一轮没有任何过程事件；重载会话后它既没有过程折叠块，也没有底部操作条——屏上只剩用户气泡，那行「未回答」还落在下一轮的位置上，整轮不可删除 / 复制 / 分叉。根因 = 重放拿「有没有过程事件」当「是不是中断收场」的判据，空事件轮被挡在渲染分支之外。**为什么**：停止时内核的收场信号不携带轮身份，宿主一条过程事件都收不到（崩溃打捞轮数据同形），空事件是正常形态而非缺数据。**对消费者**：发完即停的轮重开后仍有底部操作条，时间是发送时刻（不是重载时刻），可正常删除。
- **重启后打开的是「最近写过消息的会话」而不是「你关闭时正在看的会话」**（`SESSION-RESUME-1`）：切到旧会话翻历史（没发消息）后重载窗口，回来的是另一个会话。根因 = 初始会话取 `listSessionMetas()[0]`，而该排序的时间只在「有一轮落盘」时刷新 ⇒「只看不发」的停留态在磁盘上零痕迹。现新增会话导航指针（与留存分组标签同文件、同一份 `sessions.json`，不新增存储位置）：切会话 / 新建 / 分叉三条路径同步记录，启动优先回到它；指针不可解析（会话已删 / 旧档无字段）时退回最近写入的会话，绝不返回悬空 id。同批修一处陪跑缺陷——缺元数据的会话（新建首轮刚落盘、自动命名未回写时）占位时间原取「当前时刻」，每次查询都被标成「刚刚」而恒排第一，现改取会话 id 自带日期的零点。**对消费者**：关闭时停在哪个会话，重启就回到哪个；新建后未发消息的空会话不被记住（退回上一个有内容的会话），删除会话不会在重启后复活。

## [0.4.0] · 2026-10-29 · 宿主

> **本区归属**：仅**宿主**（`hosts/memora-vscode`）变更，随 `vsce package` 定版，不进内核 npm 包（ADR-033）。**开区原因**：`vscode@0.3.0` tag 早于图片输入全链（`IMG-1`~`IMG-13` 宿主面 + `IMG-3` 视觉能力位宿主面），已发布版无图片输入能力。**主体条目随 `git log vscode@0.3.0..HEAD -- hosts/` 补齐**；切片叙事不复述，逐笔变更以该 tag 区间为准。**对外文档不引用内部台账坐标**（区名会随台账重组失效，tag 区间不会）。
> **随包内核代次 = `5.2.0`**（esbuild 内联 dist，内核自身变更见内核区）。

### Added（宿主）

- **图片输入全链（多模态用户输入）**：对话里现在能直接发图片——四种入口汇流到**同一执行面**（落盘 / 校验 / 真 chip 建连），无第二份循环 / 第二份扩展名表 / 第二份能力判据：**① 粘贴**图片到输入框；**② 上传按钮**选本地图片（模型未声明支持视觉时按钮置灰并跳设置——这是可发现性，不是裁决）；**③ 资源管理器 / 编辑器右键「Memora: 添加到对话」**命中真图时直入摄取面（不再是「拒挂 + 指路」）；**④ 从文件系统拖入**（外部 OS 文件须按住 `Shift`，VS Code 1.140+ 资源管理器内拖入受上游回归阻塞、等 1.142）。**为什么**：此前模型看不到图，图文混聊要绕文件引用。**对消费者**：发图即建可发送的图片 chip；模型未声明 `supportsVision` 时一级门禁 fail-closed 明确拒绝并给理由（不静默丢）；字节只走 base64（不过 `postMessage` 传 `File`/`Blob`），host→webview 单向高效传输；未命中推可见占位而非静默丢。回执复用既有 `image_picked` 消息（协议零新 op）；历史图片随对话轮次恢复（窗口衰减）。视觉能力位在设置面板 Provider 配置新增「支持图片输入（多模态视觉理解）」复选框（五跳透传，内核面见 `IMG-3`），由 `IMG-2` / `IMG-5` 承载宿主侧落地与热刷新。

### Fixed（宿主）

- **对话记录选区复制兜底（修复 WebviewView 原生复制失效）**（`COPY-1`）：选中消息正文后 Ctrl+C / 右键「复制」都不落盘。根因：VS Code WebviewView 里非输入区原生剪贴板不可靠，且原 `copyText` 只服务 hover 动作按钮（整条 / 原始文本 / 代码块），**自由选区（选一句 / 一段）无入口**——「选中对话记录复制不出」与「右键菜单能弹但复制无效」是同一根因（都走原生复制）。现 webview 侧复制逻辑抽单点 `webview/helpers/selectionClipboard.ts`——`installSelectionCopyGuard` 在 document `copy` 事件**同步**写 `clipboardData`（`if (!sel) return` 仅接管文档选区、放行输入框原生复制，不与图片粘贴 / 原生剪贴板打架）；`copyText` 从 `chatView` 外置到此（4 处调用方不变）。**为什么**：13 处 `user-select:none` 全挂标签 / 日期分隔、document 唯一 keydown 只处理 Esc、全仓无清选择逻辑、CSP 无 `clipboard` 限制——均逐符号排除假凶手。行数闸：`chatView.ts` 5097→5091（抽 `copyText` 定义 −11 + 导入 / 调用 +2，守 5098 闸门）；新文件 `selectionClipboard.ts` 58 行不计入四闸门文件。**对消费者**：选中消息正文 Ctrl+C / 右键复制 → 字节落盘；输入框内选中仍走原生（不被吞）；无选区时平台菜单复制行为不变。测试 `selectionClipboard.test.ts` 5 条（有选区写盘 + preventDefault / 无选区放行 / textarea 选区放行 / 幂等 / copyText 优先 `navigator.clipboard`）。

- **占用圆环「空态」滞留修复**（`OCC-STALE-1`）：配置热刷新（改窗口 / 切 Provider）重推 `chat_providers` 触发空态渲染后，圆环显示「0 条对话 · 100% 可用」且与真实占用矛盾，切会话才恢复。根因（两缺口叠加，均既有代码）：① `renderOccupancyLimit` 空态语义假设「首轮对话前」、配置变更也走同一分支 = 假事实（`contextLimitShown` 防误清零只比对数值，「变过去再变回来」即放行空态）；② 真实快照到达时机族漏了「配置热刷新」面，拦截类不发消息则空态无限滞留（非 IMG-8 引入，occupancy 链路零触碰）。现 `chatPanel.applyActiveProviderRefresh`（IMG-5 热刷新唯一入口，覆盖配置监听 / 切 Provider / 发送前 stale 补做 3 调用方）在 `refreshActiveProvider` 返回后补推 `postHistoryOccupancy()`；`handleSetProvider` 回滚分支 `pushProviders` 后同样补推。**对消费者**：改窗口配置保存后、无需发生 round，圆环即恢复真实占用；切 Provider 失败回滚后回到 prev 口径真实占用；切会话 / 流尾既有路径不回归（守内核 / 宿主边界，webview 侧零改动）。协议零新增（复用 `context_occupancy`，计数不变）。守卫 `chatPanelHistory.test.ts` 新增「配置热刷新（retryAgentAssembly）→ 补推 context_occupancy 纠正空态」——修复前红（`expected 0 ≥ 1`，红在判据上）、修复后绿。

- **中断兜底行直出裸英文 `interrupted`**（`TERM-REASON-1`）：`decideTerminus` 兜底分支构造对象写 `reason: 'interrupted'`（语义键）却当展示文案用，`stopReasonLabel` 无 `stopReason` 时回落原文 ⇒ 中断行出现裸英文。`decideTerminus` 兜底改传 `stopReason: 'interrupted'`（`reason` 仍填同键保可追溯），下游 `appendInterruptedRow` 对 `verdict.reason` 仅 `textContent` 纯展示、无字符串匹配（grep 实证零破坏面）。**为什么**：文案回落判据与调用点意图不同源（语义键 ≠ 展示文案）；取「构造点改字段」单点修正，不破坏 `stopReasonLabel` 的自由文本原文回落契约（调试可追溯）。**对消费者**：中断行显示「对话已中断」（中文），不再出裸英文。测试判据随事实更新（`'interrupted'` → `'对话已中断'`），prettier / tsc / eslint / processFlowModel 23 例 / 宿主全量 vitest 绿。

- **能力徽章链路补断言覆盖**（`CAPB-1`）：`#currentCapabilityBadge` 在生产骨架与测试夹具都存在、骨架 id 三方一致性守卫也覆盖其存在性，但全仓**无任何用例** dispatch `capability_badge`、也没断言过 `textContent` / `title` / `hidden` ⇒ 三分支（block 纯 LLM / allow + 无能力「全部工具」/ allow + 能力列表）全无守护。属静默失测形态（节点在、链路可跑、断言缺失），非代码缺陷。现补 4 例（block / allow + 空 / allow + 能力列表含重复 label 验去重 / 骨架初始 hidden）断言文案与 title；顺带修正 `roleBadgeView` 注释撒谎（实为骨架初始 hidden、无隐藏分支）。**为什么**：CHATVIEW-SLIM-3 第三刀搬迁前扫覆盖发现，行为等价不受影响，但缺口不补下次改动该链路无网可守。**对消费者**：无行为变化；能力徽章（模型支持的工具 / 视觉等能力）的展示逻辑此后有测试钉住。

## [0.3.0] · 2026-10-26 · 宿主

> **本区归属**：仅**宿主**（`hosts/memora-vscode`）变更，随 `vsce package` 定版，不进内核 npm 包（ADR-033）。**开区原因**：`vscode@0.2.0` tag 早于宿主 MCP 接入 ⇒ 已发布版没有任何 MCP 能力。**主体条目（MCP 接入）已于 2026-10-26 按 `git log vscode@0.2.0..vscode@0.3.0 -- hosts/` 补齐**（该区间实测 63 笔宿主提交，其中 33 笔属 MCP 接入）；切片叙事不复述，逐笔变更以该 tag 区间为准。**对外文档不引用内部台账坐标**（区名会随台账重组失效，tag 区间不会）。
> **随包内核代次 = `5.1.0`**（esbuild 内联 dist，内核自身变更见内核区）。

### Added（宿主）

- **MCP 工具接入（本地 stdio）：对话里可以直接调用外部工具服务器**（2026-10-23 ~ 10-25 落地，2026-10-26 补记）：Memora 现在是一个 **MCP 客户端**——你告诉它有哪些工具服务器，它把这些服务器暴露的工具注册进 Agent，模型在对话里能像调内置工具一样调用，工具名形如 `mcp__<服务器名>__<工具名>`。配置在**设置面板 → MCP** 页（每台服务器一张卡片 + 表单增删改），写用户级 `memora.mcpServers`；工作区级配置**不读**（可被他人提交进仓库 = 让任意仓库拉起任意命令，2026-10-25 定案不开放）。启动前做一次**静态预检**（命令是否存在 / 是否把脚本当命令 / 工作目录是否存在），不通过就不拉起并把原因写在卡片上。卡片给的是**真实状态**而非「我以为连上了」：已连接 / 启动失败（附原因）/ **待接入**（配置在、运行态还没追平——不是故障）/ 已停用 / 配置不完整。配置**改完即时生效**：新增立即拉起、改参数先停后起、停用与删除立即注销工具、改白名单只重算档位不重连；配置没变但连接已坏（子进程被外部杀掉）时热更不触发，用卡片「重启」按名字重建。也支持**粘贴 JSON 片段批量导入**（Claude Desktop / Cursor / VS Code `mcp.json` 均可），同名与字段不合法的条目逐条跳过、不覆盖已有配置。**为什么**：`vscode@0.2.0` tag 早于本接入，已发布版**没有任何 MCP 能力**，这 33 笔提交（占 0.2.0 之后宿主提交的六成）此前在本区一条未记。**对消费者**：这是 0.3.0 唯一的功能级新增；调用面如实登记四条边界——单次转发 60s 超时（超时不断连接，其余工具照常可调）、单条结果超 20,000 字符截断、图片/音频等非文本内容丢弃并注明类型、合计工具数 > 64 时在输出面板告警（工具过多会降低模型选对工具的概率，可停用部分服务器收敛）。**排障入口**：输出面板 → Memora（server 的 stderr 与宿主接入告警都在此处）；完整用法见 `hosts/memora-vscode/docs/mcp-setup.md`。

- **MCP 免确认白名单（工具级 / 整台级）**（2026-10-23 ~ 10-25 落地，2026-10-26 补记）：默认**每次调用都弹确认**（MCP 工具来源不可信，宁多弹窗不静默放行）；写进 `memora.mcpToolAllowlist` 后免弹窗但**仍写审计**（`write-auto`，可在审计记录里回查）。两种键都按**原始名**寻址：`mcp__<服务器名>__<工具名>` 只放行一个工具，`mcp__<服务器名>__*` 放行整台。最省事的做法是在 MCP 页的工具行勾「免确认」，写的就是这个键。**为什么**：只给「全问」或「全不问」两端，用户会在第三次弹窗时去关掉整个功能；放行必须逐台/逐工具显式表达才既能用又不失控。**对消费者**：① 没有「一次放行所有服务器」的写法（`mcp__*` 不是合法键，防「自动化默认」）；② 键若写成**显示名**（如 `my-tool` 被清洗成 `mcp__fs__my_tool`）**不命中**、回落为每次确认——写错的表现是「还在问」，不是「悄悄放行」（fail-closed）；③ 删除服务器**不联动**清白名单（那是逐条授予的信任记录），重新添加同名服务器时档位自动恢复；④ **整台级键是服务器级授权，不是工具名快照**——该台之后新增的工具（server 升级后多出工具、或同名换了另一台）**自动**落进免确认范围，不会重新问你，批准时也不存在「我当初批了哪几个工具」的记录可回查；工具名无法预知 ⇒ 想让新工具仍需确认的只能用工具级键逐个放行。

- **MCP 远程服务器接入（Streamable HTTP，无 OAuth）**（2026-10-25 落地，2026-10-26 补记）：配置项新增 `transport: 'http'` + `url`；**stdio 仍是缺省**，既有配置零迁移（写盘只在 http 时落 `transport`）。从外部格式导入时 `type: "http"` 映射到本仓 `transport`（别名只在写入点映射一次，读面零第二字段名）。**为什么**：远程 MCP 是社区主流形态，只支持本地子进程等于把一半生态排除在外。**对消费者**：① 远程服务器**没有表单编辑**（本期未做）——用页脚「粘贴 JSON」导入或手写 settings.json，面板只读标注 `http · <url>`，卡片上的「编辑」按钮对远程**置灰**（表单里没有 `url` / `headers` 字段，打开也只能填 command，而 command 与 http 互斥 ⇒ 那会是个点了必然失败的假动作）；② **SSE 已定案不支持**（只接 Streamable HTTP）；③ 本期**不含 OAuth**，需要鉴权的远程服务器会在 401 时落到「启动失败」（归因见下方 Fixed 条）；④ **`headers` 一律明文落盘**——作用域 `machine` 只表示不随 Settings Sync 同步到别的设备，**不是**加密存储，本机任何能读 `settings.json` 的程序都能看到里面的令牌；当前版本**没有** SecretStorage 托管入口，别把长期有效的高权限令牌放进去。

- **设置面板入口：侧栏「对话」视图标题栏齿轮**（2026-10-26）：`menus.view/title` 挂 `memora.openSettings`（`when: view == memora.chat`，icon `$(settings-gear)`），点开即 editor tab 形态的设置面板（默认落「记忆」页，单例复用已开面板）。**为什么**：设置整体迁 editor tab 后侧栏不再有设置入口，只剩命令面板——真机反馈「输入框没有直接打开设置页的按钮」，可发现性不足。**取舍**：走 VS Code 原生 view 标题栏而非 webview 内自建按钮 ⇒ **零协议改动、零 webview 改动**；刻意不给「当前角色徽章」挂齿轮（图标承诺全局设置、行为却落角色页 = 视觉谎报），也未给徽章加常驻描边（齿轮方案落地后即取代该思路，两处都做 = 同一问题双补丁）。角色徽章维持原职（点开落角色页），与齿轮职责不同、不构成双入口。

### Changed（宿主）

- **设置六页从侧栏 view 迁到 editor tab（L3 设置分家）**（2026-10-26）：`MemoraSettingsViewProvider`（`registerWebviewViewProvider`）→ `MemoraSettingsPanel`（`createWebviewPanel`）；package.json 侧栏 `memora.settings` 视图贡献项删除，对话 view 独占侧栏。导航仍走既有 `switchTab` + `_pendingTab` + ready 握手单点（`memora.configureModel` / `memora.openRoles` 落点不变）；panel 单例 reveal-or-create，**设 `retainContextWhenHidden: true` 保上下文**（切走 tab 是 editor tab 的常态用法，不设则每次失焦销毁上下文 ⇒ 六页表单草稿全丢；隐藏态投递语义官方注释两说，故导航在隐藏期只记 pending、转可见时补发，数据面同一时机补刷兜底，见下方条目），关 tab 仍走 dispose 后重开 + ready 握手重建；协议**零新增消息**、内核 `src/` 零改动、设置样式 / HTML 零逻辑改动（九条判据全过，收据见台账「L3 设置分家方案」条）。**为什么**：真机 UI 评审实测设置六页挤占对话空间、对话→设置→返回三层级导航、危险按钮贴脸、回执离视线远。**对消费者**：活动栏不再有设置入口，改用 `memora.openSettings` 命令或侧栏标题栏齿轮（见 Added）。

- **设置面板：上下文保留 + 打开入口收 tab 参数 + 挂载链数据驱动**（2026-10-26，L3 落地后审查修复）：
  **① 假前提订正（先认错再改）**：L3 落地时记「panel 无 `retainContextWhenHidden` 选项（API 本就不存在）」，据此判定「与侧栏隐藏销毁语义等价」——**该前提是假的**。`createWebviewPanel` 的 options 类型是 `WebviewPanelOptions & WebviewOptions`，后者明载 `retainContextWhenHidden?: boolean`，且默认行为是「面板不可见即销毁 html context」。后果真实存在：editor tab 切走是常态用法（改一半配置去看代码），而 webview 侧零 `setState` 兜底 ⇒ 六页表单草稿每次切换全丢。现设 `retainContextWhenHidden: true`。**代价不是「消息全丢」，而是官方文档在此自相矛盾**：`retainContextWhenHidden` 的注释写「You cannot send messages to a hidden webview, even with retainContextWhenHidden enabled」，同一份 `index.d.ts` 里 `Webview.postMessage` 的注释却把「hidden webviews that set retainContextWhenHidden」算作 live（可投递）——两句不可能同时为真。处理方式是不赌任何一侧：隐藏期导航只记 pending、转可见时补发（见下方条目），重新可见时另全量补刷一次作为**收敛网**（覆盖那些没有推送路径的宿主侧变更）。**对消费者**：切走再切回的设置页保状态，回来看到的是当前态。
  **② 打开入口收 `tab` 参数**：`memora.openSettings` 接受可选 `SettingsTab`，`memora.configureModel` / `memora.openRoles` 变为它的薄包装（命令名保留，既有 keybinding 不断）。`chatPanel` 的「tab → 命令名」映射表删除，`open_settings_tab` 的 tab 由 `Extract<…,'config'|'roles'>` 放宽回全集——收窄的前提（其余页无导航入口）已不成立。**对消费者**：无行为变化；**对后续加页**：不必新增命令或映射表，`executeCommand('memora.openSettings', '<tab>')` 直达。
  **③ 挂载链数据驱动**：`settingsView.ts` 六段手抄 try/catch → 一张 `mounts` 表，异常隔离语义不变（每项独立 try/catch，不截断末尾 ready 握手）。**为什么**：手抄版漏一段不会让任何测试红（该页有按钮无内容，只有真机能发现）；`settingsTabs.ts` 旧注释承诺「加 tab = 一行数组 + 两张 Record」与实际改动面差 5 处，已按实测订正为完整清单。
  **守卫**：`settingsPanelRoles.test.ts` 新增两例（创建参数含 `retainContextWhenHidden` / 仅由隐藏转可见才补刷），`settingsTabs.test.ts` 新增一例类型级（tab 收窄即 TS2322）。变异实测三条全红：`expected false to be true` / `expected "refreshAll" to not be called at all` / `TS2322: Type '"skills"' is not assignable to type '"config" | "roles"'`。

- **设置面板：导航落点可靠性 + 遗留四项收口**（2026-10-26，`L3-AUDIT-FIX-2`）：
  **① 导航判据从「panel 存在」改为「可投递」**：`_panel` 有值只说明 tab 存在，不说明脚本已注册监听器——`postMessage` 契约原文「A response of `true` does not mean that the message was actually received … no message listeners may have been hooked up」，而隐藏态又两说（见上条）。旧实现「投出即清 `_pendingTab`」在这两类时机（open→ready 之间 / 面板在后台）会把导航指令丢掉且宿主侧无痕，用户落在默认「记忆」页。现单点：`isDeliverable()`（`_panel` ∧ `_webviewReady` ∧ `visible`）+ `flushPendingTab()`（唯一投递点与唯一清空点，`switchTab` / `ready` / 由隐藏转可见三个时机共用）；不可投递时只记 pending。**对消费者**：设置已开但还在加载、或设置 tab 在后台时点角色徽章，仍会落在「角色」页。
  **② `settingsPanelHostDiag` 补接线自证**：`expect(posted).toHaveLength(0)` 是负向断言，`post → postMessage` 通道断线时照样绿（只证明「没发」，证明不了「发得出」）。现每例先投一条已知消息断言被捕获，再清空验零下行。
  **③ `memora.settings.focus` 消失记入 Removed**（见下）。
  **④ 闸门数字与注释对齐**：eslint 的 `settingsPanel.ts` 注「一 class 扛 5 个 tab」改为六页；三条 `max-lines` 按「闸门自报」口径下调（chatView 6716→6715 / chatPanel 4516→4515 / settingsPanel 2041→2037，只降不升）。
  **守卫**：`settingsPanelRoles.test.ts` 新增两例（未 ready 不投递且 pending 保留 / 已 ready 但后台不投递、转可见补发），`settingsPanelHostDiag.test.ts` 加接线自证。变异实测三条全红：判据退回 `_panel !== undefined` ⇒ 两例 `expected [ { …(2) } ] to deeply equal []`；去掉 `visible` ⇒ 后台例同上；`post()` 断线 ⇒ `接线自证失败：post → webview.postMessage 捕获链断了: expected [] to have a length of 1 but got +0`。

- **设置面板：切走再切回不再丢列表态（重推非破坏化）**（2026-10-26，`L3-CTX-KEEP-1` + `L3-CTX-KEEP-2`）：
  **现象**：`retainContextWhenHidden` 只保住了「输入框里还没提交的草稿」，保不住「列表正在看哪一页」——面板由隐藏转可见时宿主会重推一次数据（`refreshAll` 收敛网，覆盖那些没有推送路径的宿主侧变更），而 webview 侧把每次重推都当「新数据」处理：技能页 `pager.show(1, …)` + `contentMap.clear()` ⇒ 翻到第 N 页被打回第 1 页、已展开的技能正文收起并需要重新向宿主取；记忆页回第 1 页，且**搜索框里的词没清、列表却回全量**（界面自相矛盾）。**即：草稿保住了，列表态被反向洗掉 = 只保一半。**
  **修法（留触发、消代价）**：不删重推触发——「隐藏期消息是否可达」VS Code 自己的两份注释互相矛盾（`retainContextWhenHidden` 注说不可投递，`Webview.postMessage` 注把设了该选项的隐藏 webview 算作 live），两边各赌一半是最坏组合。改为让重推**非破坏**：① 技能页把展开态收进 `expanded` 集合（唯一真源，DOM 只做投影），`skills_loaded` 改为「留在原页（页数变少时向前夹取）+ 按名字逐出已消失技能」，不再整体清缓存；「整体清空」只保留给用户显式点刷新（显式意图与被动重推判据不同源，刻意不合并）。② 记忆页三条分支：搜索框有词 ⇒ 按原词重放 `memory_search`（检索只走一条路，不在 webview 本地过滤数组）；当前页 > 1 ⇒ 走既有 `memory_page` 增量通道取该页（首屏载荷只含第 1 页，直接铺会把第 1 页数据贴上第 N 页页码）；其余直接填充。③ 角色页同样漏扫（`roles_loaded` 无条件回第 1 页），本批一并收口，并把「保持当前页 + 越界夹取」的判据下沉到 `PagerController.showKeepingPage` 单点——调用方不得再各写一份 `Math.min(getPage(), pageCount)`。
  **对消费者**：切去别的 tab 再切回设置页，页面停在你离开时的那一页，展开的技能正文仍展开，搜索词与结果仍在同一上下文。**代价**：重推数据变了（例如角色包被删除）时按新页数向前夹取，落到最后一个有内容的页而不是空页。
  **守卫**：`settingsView.test.ts` 3 例（留在当前页 / 已展开正文保持展开 / 页数变少向前夹取）、`memoryView.test.ts` 2 例（第 2 页不被第 1 页数据顶替 / 搜索词重放且输入框与列表同上下文）、`pager.test.ts` 3 例（保持当前页 / 变少夹取 / 空数据集收敛）、`rolesView.test.ts` 2 例（重推保页 / 重推变少夹取），全部变异验证。

- **设置面板：子视图挂载表可被测试钉住**（2026-10-26，`L3-CTX-KEEP-2`）：`settingsView.ts` 的六页挂载表原在 `createSettingsView` 函数作用域内 ⇒ `settingsTabs.ts` 承诺的「加一页 = 挂载表一行」**没有任何测试能守住**，而漏一行的表现是「该页有按钮、无内容」：tsc 不报错、其余测试全绿，只有真机能发现。现提到模块级导出 `SETTINGS_VIEW_MOUNTS`，由 `settingsView.test.ts` 断言「表内 name 集合 == `SETTINGS_TABS`」+ 无重复 + 每项工厂为函数（断言集合相等而非顺序相等：UI 顺序与初始化时序刻意不同源）。**对消费者**：无行为变化；**对后续加页**：漏挂载从「真机才发现」变成「测试红」。

- **MCP 两键作用域 `application` → `machine`**（`H0-2`，2026-10-25）：`memora.mcpServers` / `memora.mcpToolAllowlist` 不再随 VS Code Settings Sync 同步。**为什么**：`application` 会把 `headers` 里的明文令牌与免确认批准带到同账号的其他设备——批准的语义是「本机用户同意本机进程」，跨机继承等于替另一台机器点同意。**对消费者**：① 只写用户设置、工作区 / 文件夹写入仍被忽略（`.mcp.json` 不读的红线不变）；② **升级后每台机器需各配一次**，原先靠设置同步带过来的 MCP 配置不会再自动出现；③ 本机已有配置不受影响。断言钉在 `mcpConfig.test.ts`（结构机制不在代码里，改 scope 只有这条测试能拦住）。

### Removed（宿主）

- **`memora.settings.focus` 命令**（2026-10-26，L3 设置分家的连带影响）：该命令**不是本扩展显式贡献的**——VS Code 为每个 `contributes.views` 视图自动提供 `<viewId>.focus`（本仓全历史 grep 无一处置，键位设置里却能搜到），`memora.settings` 视图贡献项删除后它随之消失。**对消费者**：若曾绑过该命令的快捷键，绑定会**静默失效**（按 id 调用不抛错，只是不再发生）；聚焦设置请改用 `memora.openSettings`。

### Fixed（宿主）

- **安装包夹带本地文件（出包前复核发现，2026-10-26）**：0.3.0 首版 `memora-vscode.vsix`（183 条目）里实际混进了 `mcp-acceptance-server.mjs`（手工验收脚本）、`.workbuddy/*.log` ×3（本地调试日志）、`.tmp-vsce.log`（vsce 自身临时日志）、`dist/.bundle-smoke/vscode-stub.mjs`（打包前门禁探针）。**成因**：`.gitignore` 与 `.vscodeignore` 是**两套判据**——前三个前缀都已在 `.gitignore` 里，`git status` 干净，但 `vsce` **不读 `.gitignore`** ⇒ 「仓库干净」被当成了「包内干净」。**修法**：`.vscodeignore` 补 `.workbuddy/**` / `*.log` / `.tmp-vsce.log` / `mcp-acceptance-server.mjs` / `dist/.bundle-smoke/**`，本地日志与临时产物同批删除。**对消费者**：安装包不再包含验收脚本与本地日志（183 → 177 条目，1,852,326 → 1,809,088 字节），运行时行为零变化。**守卫缺口如实登记**：无自动闸门——`vsce ls` 断言只查「该有的在」（`dist/extension/host/mcp/*.js`），不查「不该有的不在」，本次靠人工按条目清单逐条核对，登记于台账 F 段。

- **MCP 连接失败归因订正**（`H0-1`，2026-10-25）：没有 `tools` 能力的 server 此前被判成「server 未声明 tools 能力」并置 `failed`——但纯 `resources` / `prompts` 的 server 是**合法形态**，这是本宿主只接 tools 的**覆盖面边界**，不是对方故障。现文案改为「本宿主当前只接 tools 能力；该 server 只提供 X / Y，暂不支持（不是 server 故障）」，并对连上后被忽略的非 tools 能力打一次 info 日志（不静默）。**为什么**：谎报成因与谎报能力同族——原文案会让用户去查一台没坏的 server。**对消费者**：仅失败原因文案变化；无 tools 的 server 仍不注册空工具清单（不静默成功）。**登记**：方案-MCP工具接入 §10 新增「`resources` / `prompts` 零接入（能力边界 · 非功能缺口）」行。

- **角色页：角色包被清空后不再留着幽灵分页条**（2026-10-26，`L3-ROLES-SLIM-1`）：`roles_loaded` 收到空列表时，列表正确地换成了「暂无角色包」空态，但**分页条没被收掉**——它保留着上一轮的页码与条数（实测：17 个角色翻到第 2 页后角色包被清空 ⇒ 条上仍写「第 2 / 2 页（共 16 条）」且上下页都能点）。于是页面上同时存在「一个声称有 16 条内容、可双向翻页的条」和「一个永远空着的列表」，点翻页也翻不出任何东西。**成因**：空态分支渲染完空态引导就 `return`，跳过了分页态的收敛（`othersAll` 因早退没被清、`pager` 也没被重置 ⇒ 翻页切的是上一轮的旧数组）。现空态分支同批收敛两件事：`othersAll` 随 `lastData` 一并清空（派生数据必须随源更新），`pager.showKeepingPage([])` 让分页条隐藏、页码回到 1/1、上下页均禁用。**对消费者**：角色包全删光 / 切到没有角色包的工作区时，看到的是干净的空态，不会再有翻不出内容的条。**守卫**：`rolesView.test.ts` 新增一例（先翻到第 2 页，再投空载荷，断言分页条 `hidden`、双向 `disabled`、卡片数 0），变异实测：删掉收敛 ⇒ `expected false to be true`。

## [0.2.0] · 2026-10-23 · 宿主

> 仅**宿主**（`hosts/memora-vscode`）变更，随 `vsce package` 定版。**随包内核代次 = `5.0.0`**（esbuild 内联 dist，内核自身变更见内核区）。逐条拍板与变异验证收据见台账对应 ID。

### Added（宿主）

- **`@problems`：把工作区错误 / 警告挂进对话（有界注入第一笔）**（`HOST-CTX-4`，2026-10-21）：对话框原本只能挂「文件 / 目录 / 当前文件」——它们都只给**指针**，内容由模型自己读。但 VS Code 的诊断是**瞬态派生数据**，内核工具箱里没有 diagnostics（也没有 git / 终端读取），「提示模型去看」这条路根本不通 ⇒ 定案（`HOST-CTX-0`）为这类数据开了**唯一一处例外**：允许有界注入。本笔只落 `@problems` 一源（同版另有 `@git-changes` 有界注入二笔，见下条；terminal 源 spike 结论 = 不做、维持触发登记）。用法：输入框打 `@` → 列表置顶多一项「诊断（问题面板）」→ 选中挂一枚**与引用 chip 明显不同长相**的 chip（圆角矩形 + warn 色 + ⚠，形状/颜色/图标三通道可辨；**无锁**）→ 发送。**体验要点**：① 选中那一刻**不取数**，按下发送那刻才去问题面板拉最新（按严重度取前 20 条，每条带 `文件:行:列` + 错误文案 + 该行源码，超限明说「已截断」）；② chip **发完即消**——注入的是那一刻的快照，钉住就是下轮拿过期数据糊弄模型，要新鲜的下轮重点；③ 圆环 hover 卡片底部出「本轮注入 N」回执（分项明细同屏：当前文件正文 / 工作区诊断），下一轮发送覆盖；④ 历史里你的消息仍只显示你打的字（注入块回放时剥掉），但模型确实收到了。**同一笔的类型级重构**：`ActiveFileProjection.injectedTokens` 迁出为 `injection_summary.segments` 的 `active-file` 分项（三个源各挂一个字段 = 并列腐化 + 违反「与 CTX-6 同一处呈现」），本轮注入量自此**按源分项**回推、「渲染两处、数据一次」。协议 +2 条（消息计数 126 → **128**，治理阈值 130，**余 2**）。逐条拍板过程与 14 次变异验证签名见台账 `HOST-CTX-4`。**真机验收第一项通过**（2026-10-21 用户实测功能通过；反馈「徽记突然出现在状态行有点奇怪」⇒ 已按 `.injection-badge` 样式注释里预登记的回退方向，把回执从状态行徽记整模迁入圆环 hover 卡片底部、分项明细同屏可见，新形态与浅色主题 chip 对比度均于 2026-10-23 真机复验通过，`HOST-CTX-4` 关账）。
- **`@git-changes`：把 git 未提交改动挂进对话（有界注入二笔）**（`HOST-CTX-4`，2026-10-21 落地 · 10-22 三轮硬化）：@ 提及置顶项「未提交改动（git）」→ **发送时刻**宿主只读采集（`git status --porcelain -z` + `git diff` + `git diff --cached`；固定开关防中文路径八进制转义、防 ANSI 污染、防仓库配置借 diff 执行外部程序；子目录工作区按工作区根换算坐标），有界三道闸（≤20 文件 / 单文件 ≤200 行 / 合计 ≤12K 字符，超出明示截断），非 git 仓库 / git 缺失 / 执行失败一律给**事实行**、不给空。语义给的是真 `git diff`（未提交），不是「本会话助手改动快照」——「帮我的改动写提交信息」场景下模型看到的即 git 所见；未跟踪文件只给 `?? 路径`（git 不对未跟踪文件做 diff，如实为限）。注入形态与 `@problems` 同款（chip 无锁 · 发送即取即清 · 回执按源归因）。
- **输入框 @ 提及挂引用**（`HOST-CTX-1`，2026-10-20）：主输入框键入 `@` 弹出工作区文件 QuickPick（多选、模糊过滤），选中即挂引用 chip——想加文件不再必须去资源管理器右键。引用模式红线守住：@ 只是「挂引用的快捷入口」，宿主侧零内容注入。触发时 `@` 先留在正文（Esc 取消文本零扰动），mention 通道挂载成功后按触发点精准撤除该字符（判据不猜，其余入口不带信源不撤——防误删正文里邮箱等合法 `@` 字样）；文件列表逐项过首根归属判据（`relativeUnderPrimaryRoot`，第二根 / 根外连列表都不进，与 addToChat 拒挂同一契约两半）。协议最小改动：W→E `mention_open`（只报意图不传过滤词）+ E→W `addRef.source?: 'mention'`。守卫 webview 3 例 + 宿主 2 例，变异验证摘撤除调用即红。
- **@ 提及落地补强：判据守卫 + 截断明示 + 防重入**（`HOST-CTX-11`，2026-10-20，CTX-1 落地次日对抗式审查后当日修）：① 撤除 `@` 的判据中真正带语义的只有「落点恰为 `@`」一条（另两条 null / 越界删掉行为等价），而它此前**零测试**——实测删掉该行 chatView 448 例全绿；现补 2 例守卫（触发后文本被编辑 / @ 已被删，均不撤不猜），并订正「判据三重」的夸大措辞。② `findFiles` 上限命中即**静默截断**（大仓里搜不到目标文件还以为仓库里没有）——现上限提为导出常量 `MENTION_FILE_LIMIT`，命中时 placeholder 明示「已截断，请输入关键词缩小范围」（不用「提示项」进列表：QuickPickItem 无 disabled，选中即变伪引用）。③ 连按 `@` 会各开一个 QuickPick、后开的静默覆盖先开的且只撤一个 `@`——现加 in-flight 守卫（try/finally 保证异常路径也归位）。④ 订正退化分支注释的**描述性撒谎**：该分支唯一可达场景是「QuickPick 打开期间视图被销毁」，不是注释原写的「webview 未就绪」；代价如实改写为「多出一个延迟注入的引用」。守卫 chatView 450 / chatPanelMention 4，变异三次均红后还原。
- **修复输入 `@` 无反应：未知消息不再静默丢弃 + 消息链获得可测入口**（`HOST-CTX-12`，2026-10-20，真机验收发现当日修）：真机输入 `@` 字符正常落入输入框但 QuickPick 毫无反应。根因不是 `@` 分支写错，而是 **webview 脚本与扩展宿主不是同一版本**——webview 脚本是外部文件（`dist/webview/scripts/chatView.js`，从磁盘读 ⇒ 重编译后是新的），而宿主的消息分发活在进程内存里（旧的）⇒ 新 webview 朝旧宿主发 `mention_open`，旧宿主**没有任何分支匹配、静默丢弃**。修法第一动作是 Reload Window 重启扩展宿主，但真正的伤是「静默丢弃」本身：消息链**没有 else 兜底**，123 个类型里任何一个因版本错位不到达都表现为功能凭空消失、零反馈（「静默失败」族第三次踩）。① 加 else 兜底，未知类型落 `console.warn`（含类型名与「最可能原因：扩展宿主未重启」），不驱动 UI 不弹提示；② 🔴 把整条 120+ 分支的消息链从匿名回调**摘为 `private handleWebviewMessage`**——它原先零可测入口（加上兜底后立刻发现「有守卫却验证不了」），摘出后与 `handleInput` 等同构、测试可直接驱动。守卫 +1 例，变异（摘 `console.warn`）红后还原。
- **中文输入法 / 粘贴也能触发 `@` 提及**（`HOST-CTX-13`，2026-10-20，真机验收反馈当日修）：原触发判据是 `keydown` 的 `e.key === '@'`——那是**按键事实**，依赖键盘布局与 IME 行为；中文输入法插入的 `@` 不保证走 keydown，粘贴 `@` 根本不产生 keydown，两条路都表现为「要英文 @ 才有反应」。改为在既有 `input` 监听里加兜底：`inputType` 属 `insert` 家族 + 光标前恰为 `@`（**文本事实**）。`inputType` 判据不可省——删除文本同样触发 `input`，用户在「帮我@x」里删掉「我」后光标仍停在 `@` 后，不判 inputType 会把删除误判成插入而误弹列表。keydown 快路径保留（offset 语义更直接），英文键盘一次 `@` 两条路径都 fire 由 CTX-11 的 in-flight 守卫拦掉（复用既有机制，不新建第二套防抖）。守卫 chatView 453（+3），变异红后还原。
- **当前文件 chip：上下文附加可见 + 本会话可关**（`HOST-CTX-3`，2026-10-20）：输入框上方新增第三种 chip，把「当前打开文件会不会进本轮上下文」摊开——干净文件显示 `📄 docs/白话设计文档.md`（只给指针、不占预算），**有未保存修改 / 未命名 / 工作区外**时显示 `… · 未保存·全文已附`（这三类磁盘不是真相，注入正文），因此用户第一次能看懂「这条消息为什么突然贵了」。chip 上的 ✕ = **本会话**不再附加（关掉后整枚变虚线胶囊「当前文件未附加 · 点击启用」，点一下即回开，不留死角；重开面板复位为开）。开关状态与注入判据归宿主单点（同一份快照既拼信封又产出 chip），webview 只渲染不推断。
- **上下文透明性：指针提示 + 注入量归因**（`HOST-CTX-6`，2026-10-20）：①引用 chip 的 title 首句改为「仅挂指针，正文由模型按需读取（不占预算）」——挂了 ≠ 注入了，目录引用尤其如此（信封只给一张目录地图，内容按需 `list_dir`）；②发送后的本轮 chip 徽记短显注入规模（`未保存·全文已附 ≈3.3k`），title 给全数（`注入约 N token`）——「这轮贵在哪」有归因入口（圆环只示总量，这里示出处）。取数纪律：估算**只在发送时刻**取（正文块已在手，零额外读取），token 口径与内核 `estimateTokensText` 同源（宿主自估即第二真理源）；实时投影刻意不带此字段，正文惰性（CTX-3 收尾）不被显示需求破坏。
- **会话大纲导航条**（`HOST-NAV-1`，2026-10-20）：对话流右缘一列细横条，每轮用户输入一根；**视口内当前轮加粗高亮**，hover 弹浮层列出各轮输入预览（当前轮粗体），点击滚动定位——长会话「回到我上次说了什么」不再滚轮硬扒（ChatGPT 同款范式）。不足两轮或不可滚动时整条隐形。预览文本 = 上屏文本过 `stripInjectedContextPrefix` 归一（重放带注入前缀 / 运行时无前缀两路同源）；条列重建挂既有 MutationObserver 拍子（签名比对防流式期每帧重建）；点击定位后显式重算吸底标记（对齐一键到底纪律）。**2026-10-20 二轮加固（边界收口）**：长会话极端轮数不再外溢——改为**全量条 + 自适应压密**（轮数超出可用高时先压间隙、再压条高至下限，极端仍不足交条列自身滚动兜底，绝不画到输入区上）；高度上限按视口高内联下发（**条列** CSS 不再设 `max-height`，上限单一真源；浮层面板的 `max-height` 与该比例同判、另留在 CSS）；条更短、右缘更紧（条宽 `--sp-6`→`--sp-5`、`right` `--sp-2`→`--sp-1`、去横向内距）；修复重建指纹「条数 + 首尾长」在重放 / 分叉（中段变化而首尾同长）下静默失效（改全量预览拼接）；`resize` 触发压密重算。**2026-10-20 三轮复核（SSOT / 不带伤）**：轮次收集锚由 `.msg-wrapper` 改为 `.msg.user`——该外壳由 `append()` 的 else 分支创建、**同包 user 与 error**（错误气泡会被误算作一轮、错误文案进条列与预览），锚 `.msg.user` 天然筛除；压密常量（条高 / 间隙 / 高度比例）与设计令牌的镜像补**测试守卫**（漂移即红，闭合「仅注释自认」的静默风险）。
- **文档上下文改按引用模式注入**（`HOST-CTX-0` 落地，2026-10-20）：活动文件**干净**时不再把全文塞进每轮消息（此前最多 12000 字符 ≈ 3~4k token），改为一行指针（`当前打开文件：path`）让模型按需 `read_file`；文件**有未保存修改 / 未命名 / 不在工作区内**时仍注入正文（这三种情形磁盘不是真相，只给指针会让模型读到旧版或读不到）。对消费者：预算显著下降；未保存编辑的可见性与「编辑器随手一开就注入」的旧观感不同——现在只有脏文件才注入。
- **引用 chip 点击跳回编辑器**（`HOST-CTX-8`，2026-10-20）：chip 的路径与行号是两个独立可点域（补 `role=button` / `tabindex` / Enter-Space），点击打开文件并选中该行区间，目录则在资源管理器露出；失败走面板内提示单一出口。
- **编辑器选区引用带行号**（`HOST-CTX-2`，2026-10-20）：右键「添加到对话」对当前编辑器文件挂 `path#L{start}-L{end}` 指针（1-based 闭区间，0→1 基准只在宿主转一次），信封把 `read_file` 的 `offset`/`limit` 预先算好给模型——选中 20 行不必读整个文件，引用模式仍不注入内容。
- **manual 归档入口**（`ARCH-GAP-2`，2026-10-19）：历史浮层「移入留存区」双动作 = 本地留存 + `agent.archiveSession(…, { skipIfUnchanged: true })`；「归档」（LLM 摘要）与「留存」（视图分组）术语显式分家；按钮文案 = 运行时真值（`chat_archive_mode` 推送）。真机验收通过（跨进程防重真实生效）。
- **自定义搜索引擎**（2026-10-13）：五档预设 + 自定义引擎；保存前实测验证门禁 + 差分探针（区分「策略选错」与「0 命中」）；紧凑手风琴编辑器；重名/非 http(s) 护栏；装配侧脏配置过滤。
- **归档模式设置接线**（2026-10-16）：设置面板「记忆」选项卡接 `agent.setArchiveMode()` 三段式，繁忙顺延不谎报「已生效」。
- **暂停按钮投影**（2026-10-16）：TurnState 单通道投影接线——后被 `ARCH-GAP-F1` 撤除门控改恒显示（见 Fixed）。
- **webview 错误边界 + 丢弃留痕**（2026-10-11）：error/unhandledrejection 兜底卡片 + `host_diag` 通道上报扩展日志（装配期错误也能抓）；错位输入丢弃落日志可观测。
- **文件改动可视化**（DIFF-1~4，2026-09-26~28）：真实文件行内高亮 + 标题栏文件级确认/回退 + 块级「接受/拒绝此处」（git `add -p` 同构模型）+ 脚本类写工具 workspace 快照 diff 追踪（`OPAQUE_WRITE_TOOL_NAMES` 单源派生）+ 未保存编辑 fail-closed 模态（W2）+ 大仓库扫描上限守卫。
- **后台任务可见性**（`CMD-1` 阶段 2）：StatusDock 第四条 + 终止按钮；内容签名去重 + ready 全量对齐（防「面板重开条凭空消失」）。
- **角色包策略键编辑**（`RP-EDIT-1`）：16 键键面单源内核 `describeStrategyKeys()`（宿主零清单维护）；保存全链路 extension 侧（全量保真 + 校验拦截 + reload 失效缓存）。
- **命令注册面守卫 + 默认快捷键**（2026-10-11 / `HOST-KB-1`）：`contributes` ↔ `registerCommand` ↔ `keybindings` 四向对拍；`memora.open` 默认 `ctrl+alt+m`。
- **skill 菜单搜索**（`UI-INPUT-3`，2026-10-11）：名称+描述过滤；分容器重建保焦点（真机打字丢焦实锤修复）。附件行 skill chip 归位输入盒内（`UI-INPUT-1`）。
- **角色包「刷新」按钮**（2026-10-08）：用户角色包目录改动免重启生效（`roles_refresh` → `resyncUserPacks`）。
- **终态标签收口底栏**（2026-10-13）：勾/用户中断/异常中断三档统一 `data-status` 载体契约。

### Fixed（宿主）

- **当前文件气泡也只显示文件名**（`HOST-CTX-18`，2026-10-20 真机验收 CTX-16/17 通过后即修，CTX-17 同族延伸）：输入盒上方「当前文件」chip 的可见文本同步降噪为文件名（`docs/白话设计文档.md` → `白话设计文档.md`）——复用 CTX-17 同一纯函数，不新建第二份判据；完整路径保留在 title 末尾括号（注入语义仍是第一问）与 ✕ 的 aria-label。活动文件永远只有一个，不存在引用气泡的同名撞车，纯文件名零歧义代价。守卫 +1 例、原「干净文件」例断言同步订正；变异（退回全路径）红后还原。

- **@ 提及列表收起后焦点自动回到输入框**（`HOST-CTX-16`，2026-10-20 真机验收通过后反馈即修）：Esc 取消或确认选中文件后，VS Code 不会把焦点还给 webview 输入框（QuickPick 是宿主全局 UI，焦点被它拿走就不还）⇒ 想继续打字得先用鼠标点一下。协议加 E→W `focus_input`，宿主在 QuickPick dispose 后、确认/取消分叉前发一条（两条收场路共用一个出口；未开工作区 / findFiles 抛错时 QuickPick 从未开出，天然不发），webview 只 focus、不动文本（@ 撤不撤归 addRef 的 source 分支）。守卫 accept/cancel 两路 + webview focus 例，变异双红后还原。
- **引用气泡只显示文件名**（`HOST-CTX-17`，2026-10-20 真机反馈即修）：附件行引用 chip 的可见文本从完整相对路径改为文件名（`src/webview/scripts/chatView.ts` → `chatView.ts`）——信息不丢：chip title 末尾括号（hover 消歧同名文件）、pin/remove 的 aria-label（屏幕阅读器）、open_ref 载荷与发送信封三处各司其职。范围只及用户添加的引用；活动文件 chip（自动投射）语义不同不动。已知限制：同名文件可见标签相同靠 hover 区分（刻意不上父目录消歧，复杂度守恒）。

- **@ 文件列表不再被 node_modules 挤爆 + 排除语义注释谎言订正**（`HOST-CTX-14`，2026-10-20 当日三审发现即修）：输入 `@` 弹出的文件 QuickPick 此前给 `findFiles` 传 `undefined` 排除——VS Code 源码一手实读：legacy `findFiles` 只应用 `files.exclude`、**不应用** `search.exclude`、`.gitignore` **默认不尊重**（1.87 起硬编码，PR #204845）⇒ `node_modules`（本仓实测 32,040 文件）/ `dist` / `coverage` 全进列表、撞 2,000 上限**静默截断**，用户想引的源码文件随机缺席，而 placeholder 只说「已截断」不说原因（搜不到还以为没有）。修：① 新建 `extension/host/ignoredDirs.ts` 单一真源（派生自内核 `IGNORED_DIR_NAMES`，与 `search_project` / `list_dir` 同一套忽略规则），mention 与 `projectSearchProvider` 两处 `findFiles` 同挂（消一份行内第二基线）；② placeholder 补「内置忽略目录已排除、仍超上限」；③ 订正两处注释的三项断两项谎话。守卫 chatPanelMention +1 例 + 截断例 +1 断言；变异三连均红后还原；全量 78 套件 1396 passed / 2 skipped。

- **编辑器右键「登记作品投影」在选中行时仍出现**（`HOST-MENU-2`，2026-10-20）：该命令只登记整个文件（`works` 存储无区间字段），带选区时出现会让人以为「登记了这几行」⇒ `editor/context` 的 `when` 加 `!editorHasSelection`，编辑器入口只在无选区时出现；命令面板入口不变。
- **引用标签与定位的四处漂移**（`HOST-CTX-2` / `HOST-CTX-8` 收尾，2026-10-20）：① `#L` 标签改由 `shared/refKey.formatRefRange` 单点产出——此前键 / chip / 行号 span / 信封各写一套，单行引用在 chip 显示 `#L7`、喂给模型却是 `#L7-L7`；② `open_ref` 定位改用与内核 `read_file` cwd **同源的首个工作区根**（原「逐根取第一个存在」在多根工作区会打开另一根的同名文件，用户核对的和模型读到的不是同一个）；③ 非法行区间（`start > end`）统一降级为整文件引用，不再算出 0 或负数 `limit`；④ 目录引用的读取工具名改为 `list_dir`（原写 `read_file`，而 `read_file` 只读文件——等于给模型一条必然失败的指令）。
- **当前文件上下文：显示订阅不再每次击键读全文**（`HOST-CTX-3` 收尾，2026-10-20）：为修「缓存撒谎」把快照改为发送时实时读之后，显示订阅（换文件 / 同文件被编辑 / 保存）按**每次击键**取快照，而旧快照顺带产出注入正文（`getText()` 全篇）⇒ 大文件下**每敲一个字就全量读一遍文档**。已拆为「廉价事实快照（文件名 / 脏态 / 相对路径，不读正文）+ `readDocBody` 惰性读取」，`resolveActiveFile(withBody)` 显示路径恒 `withBody=false`（零 `getText`）、仅发送且本轮**真要注入**时才读。守卫 `chatPanelHistory` +1 例（快照 `getText` 读取次数恒 0）。
- **多根工作区右键「添加到对话」挂出模型读不到的引用**（`HOST-CTX-9` 创建侧，2026-10-20）：原 `addToChat` 用 `asRelativePath` 生成 `ref.path`（相对**「所在根」**），而模型 `read_file` 的 cwd 与 `open_ref` 定位都恒取**首个工作区根** ⇒ 在**第二根**下落引用，chip 显示正常、模型却按首根读到同名路径（不存在即失败）。新增根归属纯函数 `extension/host/refPath.relativeUnderPrimaryRoot`（以首根为唯一基准，越出即拒），`addToChat` 改为 **fail-closed**：不在首根下的目标不挂引用并提示（挂一条注定读错的指针比不挂更坏）。同批把**消费侧**（`open_ref` 点击定位的越界守卫）也收口到同一模块（`refPath.resolveUnderPrimaryRoot`，含规范形往返校验）——此前生成 / 消费两半各写一套判据且消费侧零测试，属第二真理源。
- **引用文件失效后信封仍给出死指针**（`HOST-CTX-9` 发送侧，2026-10-20）：引用挂上后文件被删 / 改名，下一轮信封仍写 `- 参考文件：old/path.ts（offset=… limit=…）`，模型照读撞一次错、用户只看到「模型读文件失败」，不知道引用已过期。发送前新增**无状态**存在性核实 `extension/host/refProbe.collectMissingFileRefPaths(refs, rootFsPath, stat)`（`stat` 注入式、`Promise.all` 并发、空 root / 零文件引用短路；解析器**复用** `refPath.resolveUnderPrimaryRoot` 首根 SSOT，不另写守卫），失效者在 `docContext.refItemLine` 降级为**裸指针 + 「注意：添加后已不存在，请向用户确认」**，并**去掉 `#L` 区间与 `offset/limit`**（死文件上的精确读参数同样注定读空——纪律「绝不给 `read_file` 一条必然失败的指令」）。刻意**不维护「失效引用集合」**（那是第二真理源、必与磁盘漂移）。**偏离登记**：① 台账原写 `fs.stat`，实现改用 `vscode.workspace.fs.stat`（异步、兼容远程 / 虚拟 FS，与 `extension.ts` 既有用法同源）；② 标记文案原拟 `⚠`，改**纯文本**——`iconLanguage` 守卫把 `⚠` 列为 webview 代码内禁用的字符图标，且该块被剥离契约从 UI 隐藏、只喂模型，纯文本无损。守卫 `refProbe.test.ts` 6 例（存在 / 不存在 / 目录忽略 / 解析失败计入 / 空 root / 多引用并发）+ `docContext.test.ts` +4 例（失效带 range 去参数 / 无 range / 目录不标 / 未命中与缺省原样）。
- **引用 chip 行缺批量出口**（`HOST-CTX-7`，2026-10-20）：挂 6 个引用要逐个点 ✕ 六次。引用行在引用存在时追加**「清空全部引用（含常驻）」**按钮（范式照抄待发送行的 `pending-queue-bar__clear`），点击 = webview 本地清 `currentRefs` 并重渲染——**刻意不走上行消息**：待发送队列清空走 `clear_pending_queue` 是因为其 SSOT 在宿主，而引用 SSOT 在 webview（单删 ✕ 同为纯本地过滤），上行等于让宿主镜像一份引用状态（第二真理源）。范围**只及引用**：活动文件 chip（CTX-3 本会话开关、宿主投影）不受牵连；pinned 一并清（与 ✕ 语义一致，🔒 只管「发送后是否保留」）。样式零新增规则（`.ref-chips__clear` 并列进 `.skill-chip__remove` 既有选择器组，一份规则多锚点）。守卫 `chatView.test.ts` +4 例（批量清空 + 断言无上行 / pinned 一并清 / 活动文件 chip 不受牵连 / 无引用无按钮）。
- **运行时整轮无暂停按钮**（`ARCH-GAP-F1`，2026-10-19）：撤除 `canContinue` 门控全链（采样时机在流前恒 false 且架构上不可靠），running 相位暂停按钮恒显示。
- **记忆命中明细三连修**（`MEM-EVENT-2/3` 宿主侧，2026-10-19）：明细收进对应工具折叠行（不再沉底遮挡运行时状态）；重渲染改读 `Round.evidence` 证据轨（100 字截断副本退位）；中断轮一并补齐；磁盘实证 3 条命中与 toolCallId 1:1 配对零悬空。
- **底栏终态偶尔不显示**（2026-10-19）：运行态 `data-status` 与终态 `data-terminus` 拆为双通道（SSOT 收敛），终态展示不再依赖容器存在。
- **历史浮层滚动分层**（2026-10-19）：tab/搜索框恒置顶、条目容器成唯一滚动面（纯 CSS，含 dropdown display 特异性回归排雷）。
- **悬空取代展示判据归一**（2026-10-16）：「已被取代」徽标与治理统计改用内核 `hasActiveSuperseder`（原 `!== undefined` 会把悬空指针误标）。
- **提问等待态输入走 answer 通道**（2026-10-15）：修复同一意图两种落盘形态（答案退化成补充、提问原文不落盘）；「拒答也是回答」。
- **真机复盘三连**（2026-10-13）：提问等待对齐 30 分钟（`ASK-TIMEOUT-1`，与 confirm 超时「数值巧合、判据独立、禁合并」）；token 累计口径标注（`ROUND-ANALYTICS-1`）；成文文件分区纪律入技能文档（`ROLEPACK-BODY-1`）。
- **内核错误诊断不再被吞**（2026-10-13）：`MemoraError` 经 `toNoticeText` 全文呈现（此前 37 处边界截断只留标题）；CSP 补 `img-src data:`。
- **启动会话对齐**（2026-10-13）：修「启动即分叉报当前会话不存在」（宿主 current 与内核惰性初值错位），挂 `refreshAfterAssemble` 唯一收口点。
- **配置 LLM 后免重启**（`HOST-BUG-1`，2026-10-12）：装配失败 catch 重置缓存 + `retryAgentAssembly()` + 配置变更监听触发重试（僵尸 Promise 根因）。
- **角色页详情/编辑不可达回归**（`RP-EDIT-1` 后续，2026-10-04）：重挂判据把首挂场景整体挡死，改到达即渲染（纪律：新增判定分支必须补「分支被走到」的用例）。
- **多流续跑 metrics 同轮合并**（2026-10-10）：前段指标不再被静默清零（求和合并、success 取末段）。
- **队伍对账只检测不删除**（`TEAM-GHOST-1`，2026-10-08）：清理写回退役、删除权交还用户（真机事故：瞬时扫描失败被当「全部卸载」静默物理删除队伍）；空池护栏；内核 `effectiveMembers` 同口径收口。
- **历史条目悬停假显「当前会话」+ 归档后不刷新**（`HIST-INFO-1`）：title 移内层防泄漏；订阅 `sessionArchived` 重拉列表。
- **异常终态轮缺底部栏**（2026-10-10）：`settleRoundFooter` 单点收口（锚 roundId 不依赖 DOM 连通性），早相位中断也能拿到复制/分叉/删除/时间戳。
- **消息区自动吸底**（2026-10-10）：`MutationObserver` 收口「高度变更不派发 scroll」整类缺口（思考折叠块/工具流式/长气泡）。
- **设计令牌 SSOT 收口弧**（2026-10-12，四批，`UI-TOKEN-PAIR-1` / `UI-TOKEN-MENU-1` / `UI-TOKEN-WARN-1` / `UI-TOKEN-LAYER-2`）：同变量不同回退 8 组 → 0；`--dim-*` / `--line-*` / z-index / 行高 / 不透明度刻度收口，裸值债 74→20 升硬门；无障碍对比度、`--menu-*` 幻影变量（引不存在的 VS Code 主题键致暗色白底黑字）、角色包卡片双箭头修复。
- **工具批断段与口径收口**（2026-09-25~26，`TOOL-RUN-1`）：思考换步即断段（反转「按 step 分组」前置决议，依据=前提变了）；叙述词表统一到工具显示名、取消「第 N 批」序号；问答卡纳入断面（`BATCH-SPLIT-1`）；任务项组位置判据归位 (ts, seq)、组外条目不再沉底。
- **diff 可视化复盘收口**（2026-09-28）：对照回滚为 git 同款左右分栏（真机定案）、删行尾红色预览；文案口径单源 `COMPARE_LABEL`；台账/docs 失真订正 + 退役概念回扫清单补第 8 层（`tasks/`）。
- **空响应计数假阳**（`EMPTY-RESP-1`，2026-09-29 复核推翻 09-29 验收）：截断救回计数补 `!aborted`（用户中断不再记成救回成功）；取证面改记生效值 `getEffectiveMaxTokens()`（宿主不再重算裁决规则）。
- **市场上传撞键**（2026-10-14）：截图文件名 ASCII 化（门户把非 ASCII 字节替换成 `?` 后等长撞键）。
- **插话丢弃信号成对契约**（2026-10-09）：停止路径补 `syncPendingQueue`，`_lastPendingQueueLen` 折叠 0 误判修为 `undefined`。
- **渲染异常用户侧静默**（2026-10-10）：`onMessage` 兜底补非阻断红条。
- **挂起/插话补充输入渲染根治**（2026-10-07）：user 消息一律不删骨架 + 正文单块续写统一（打断分段形态退役）。
- **任务项组层级与折叠箭头右置**（`TOP-UI-2`/`TOP-UI-3`，2026-10-04）+ **待发送区空条常驻**（`STATUS-DOCK-FIX`，2026-10-04）+ **`backgroundProvider` 声明收口**（`HOST-RESET-2`，2026-10-13：删硬编码补丁，键清单回归纯派生）。

### Changed（宿主）

- **附件行改单轨横向滚动**（`HOST-CTX-10`，2026-10-20）：输入框上方的技能 chip 行与引用 chip 行不再换行堆高（挂 3 枚以上就顶起输入区、压扁对话区），改为单轨排列、超出横向滚动、滚动条隐藏，**鼠标滚轮直接横切查看**（触控板原生横滑不受影响）；两侧按溢出位置做边缘渐隐，作为「这一侧还有 chip」的唯一可见线索。拦截只在**真的溢出**时发生——装得下时滚轮照旧滚对话，不劫持。
- **记忆显示正文为主位**（`MEM-UI-1`，2026-10-19）：设置记忆卡片（含回收站）与聊天命中项不再默认展示机器 id/name，改显示记忆正文预览（内核 `contentPreview`/`content` 新字段，旧内核按 name→id 回退链降级）；id 保留于 dataset 反馈寻址与 tooltip、卡片详情保留全文与溯源。
- **输入条进度信号去重**（2026-10-18）：占用构成条移入圆环 hover 卡片（四段→五段含「动态注入」，`CTX-OCC-1` 宿主侧 + 跨包字段对账守卫）；会话记录量词订正。
- **输出上限裁决改取交集**（2026-09-28）：per-LLM 面板与角色包 `act.outputLimit` 取 min（原角色包直接覆盖 = 允许把用户配的小值顶大）；默认 4096 隐形天花板改 0（不干预），0-哨兵与 `contextLimit`/`stepBudget` 同构。
- **token 显示诚实口径**（`MAXTOKEN-SSOT-1` 销项）：「估算/正文」标注 + 生效上限亮明。
- **示例包行为参数对齐**（2026-09-28）：共鸣小说家 `stepBudget`/`toolStepLimit` → 100、`multiStepReasoning` manual→auto（思考深度听服务端默认）。
- **工程 SSOT 收敛**（2026-10-15）：默认窗口同族数字指针化 ×16；删 `package-lock.json`（`HOST-LOCK-1`）。零行为变化。
- **0.1.0 定版与市场门面对齐**（2026-10-12）：manifest 0.0.1→0.1.0、打包链三缺陷修复、README 市场定稿；真机装包实测通过。

## 历史版本

> 全文见 `docs/CHANGELOG-归档.md`（仓库内归档，npm 包不含；原文迁入，未改写）。

- **[4.0.0] · 2026-10-08** — 首个 major：导出面收敛（−54，桶导出时代收场）+ `agent.memory.search()` 退役（唯一入口 `searchByKeyword()`）+ 角色包 16 策略键定型。
- **[3.0.1] · 2026-09-30** — 开源归口翻转：GitHub 升主仓库。
- **[3.0.0] · 2026-09-30** — 架构收敛后第一个稳定基线（Node.js 专属 · 零第三方运行时依赖）。
- **[2.1.0] · 2026-08-08 / [2.0.3] · 2026-08-01 / [2.0.2] · 2026-07-27** — 探索性迭代期。
- **[1.0.2] · 2026-07-11 / [1.0.1] · 2026-07-08 / [1.0.0] · 2026-07-08 / [0.3.0] · 2026-06-27** — 早期版本。
