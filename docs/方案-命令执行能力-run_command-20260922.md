# 评估：3.0.0 发版前要不要加「命令行执行（run_command）」

> 日期：2026-09-22 ｜ 类型：决策评估（先文档化闭合闭环，再写代码）
> 关联台账：`tasks/待完成任务.md` §3.0.0 / §观察区

## 一、结论（先给答案）

**不进 3.0.0。3.0.0 照发，run_command 定档 3.1.0，现在把设计闭合。**

一句话理由：**run_command 是新增能力，不是破坏性变更——它吃不到「3.0.0 未发 npm」这个零成本窗口的任何红利，却会拖长发版并把一个全新的任意执行面塞进一个未经验证的发布包。**

## 二、现状实锤（现在到底能跑什么）

| 工具 | 能不能跑命令 | 输入形态 | 证据 |
| --- | --- | --- | --- |
| `run_code` | 宿主执行器裁决 | `code` 字符串 / `script_path` | `src/agent/builtinTools.ts:322-343` |
| `run_project_script` | ✅ 可跑 shell，但**必须指向仓库内已有脚本文件** | `script_path`（相对项目根）+ `args` | `src/agent/builtinTools.ts:643-668` |
| `run_skill_script` | ✅ shell，但限定技能 `scripts/` 目录 | `skill_name` + `script_path` | `src/agent/builtinTools.ts:625-640` |
| 宿主 `run_code` 执行器 | ❌ 只认 JavaScript | 白名单 `javascript/js/nodejs/node` | `hosts/memora-vscode/src/extension/host/codeExecutor.ts:38` |
| 脚本扩展名→运行时 | `.sh/.bash/.zsh→shell`、`.py→python`、`.js/.mjs/.cjs/.ts→node` | SSOT 映射表 | `src/utils/scanner.ts:208-217` |
| shell 实际派发 | Windows `cmd /c <脚本>`；其余 `sh <脚本>` | — | `src/skill/skillScriptRunner.ts:206-212` |
| VS Code 集成终端 | ❌ 未接入 | `grep terminal` 在 `hosts/.../extension/` **零命中** | — |

**结论：能跑命令，但必须先落一个文件。** 真实闭环是 `write_file 写 sh → run_project_script → delete_file`，多两轮往返、多两次工具开销。

## 三、主流 agent 怎么做（只看可嫁接的部分）

| 设计点 | Cline / Roo Code | Cursor / Copilot | memora 是否采纳 |
| --- | --- | --- | --- |
| 命令在真实 shell 跑 | ✅ 持久 shell 会话（`cd` 有状态） | ✅ | ❌ 首版不做（见 §六） |
| 执行前确认 | ✅ 弹「Run Command」，带 *Always allow* | ✅ | ✅ 采纳（复用 `confirmScripts` 模式） |
| 自动批准白名单 | ✅ 按命令前缀持久化 | ✅ | ⬜ 阶段 2 |
| 危险命令黑名单 | ✅ 硬拦截 | ✅ | ✅ 采纳，**判据放内核单源** |
| 超时 + 输出截断 | ✅ | ✅ | ✅ 采纳（对齐 `RUN_SCRIPT_RESULT_MAX_LEN`） |
| 用户在终端实时看到输出 | ✅ | ✅ | ⬜ 阶段 3 |

## 四、为什么不等 3.0.0：三条硬理由

**1. 零成本窗口论据在这里无效（最关键）。**
`IProjectSearchProvider` 之所以必须赶在 3.0.0 改完，是因为它是 `src/index.ts:171-177` 的**公开导出**，改接口形状 = 破坏性变更。而新增一个 `run_command` 工具 + 新增一个 provider 注入口，**对既有 API 零影响**，3.1.0 加上去一样干净。别被版本窗口焦虑绑架。

**2. 这是一个全新的任意执行面，不是顺手加的开关。**
现有三道防线（路径白名单 → 确认 → 运行时白名单三档，`toolExecutor.ts:1264`）全部建立在「执行对象 = 仓库内的一个文件」这个前提上。一旦允许裸命令字符串，对象变成模型的一次输出，防线的第一道和第三道**同时失效**。这不是补几行代码，是重新设计安全边界。赶工 = 发布后大概率立刻返工。

**3. 3.0.0 的价值是「内核形态定稿 + 宿主可用」，不是功能全集。**
版本号不决定能力完整性。而当前并非「不能用」——`run_project_script` 覆盖约 80% 场景，只是体验差。这是**体验问题，不是残废问题**。

## 五、对抗式审查（反驳我自己）

| 反驳 | 回应 |
| --- | --- |
| 「主流 agent 都有」—— 从众不是理由 | 同意，这条单独不成立。真理由是：**缺了命令执行，agent 就没有手**——跑不了测试、构建、格式化、包管理，只能绕脚本文件。这是能力缺口，不是流行度缺口。 |
| 「3.0.0 是大版本，没有命令执行不像话」 | 反驳无效：用户装的是 3.0.0，三个月后跑的是 3.4。能力按增量补，不按版本号凑。 |
| 「发版后又要等一个周期」 | 部分成立 → **这是唯一的真实成本**。缓解：本文档即为闭合闭环，发版动作（`npm publish`）与 3.1.0 开发可并行，文档先行不阻塞发版。 |
| 「万一 3.1.0 拖很久」 | 缓解：把 §六 阶段 1 拆到最小（内核工具 + 宿主执行器 + 恒确认），是约一天的改动量。 |

## 六、落地方案（3.1.0）

### 6.1 内核

- 新增工具 `run_command`（`builtinTools.ts`），参数：`command`（必填）、`timeout_ms`（可选，默认 60，上限 600）。
- 新增接口 `ICommandExecutionProvider`：`execute(command, { cwd?, timeoutMs? }) => { stdout, stderr, exitCode, timedOut }`，**与 `ICodeExecutionProvider` 同注入模式**（`src/code-exec/types.ts`）。
- **暴露机制：内核默认开放（`BUILTIN_TOOLS` 常驻，对齐 `run_project_script`）**，护栏 = 高危黑名单（deny 层）+ 恒确认（ask 层）。原方案「未注入 provider 时工具不暴露——对齐 web_search/search_project 条件性包含」随 CMD-1 嫁接修正（§11.4）失效，**不做 provider 条件注入**——拍板详见 §11.5。
- 新增 `SecurityGuard.confirmCommandRun()`，与 `confirmScriptRun`（`src/security/pathGuard.ts`）同签名风格。
- 高危命令判据：**内核单点 SSOT 黑名单**（`rm -rf` / `del /s` / `format` / `git push --force` / `git reset --hard` / `git clean -fd` / `curl|sh` / `chmod 777` / 对仓库外绝对路径的删除），命中即拒绝执行并返回明确文案。**宿主不得重写此判据**（派生判定律）。
- 输出净化 + 截断：复用 `sanitizeExternalText` + 新增 `RUN_COMMAND_RESULT_MAX_LEN`。

### 6.2 宿主（VS Code）

- **不新建 `commandExecutor.ts`（§11.4 拍板）**：执行链路由内核 `skillScriptRunner` 承载（win32 `cmd /c` / 其余 `sh` 平台派发已内建），宿主侧只剩三件事：
- **审批 UI**：审批卡展示**完整命令原文**（不折叠、不改写），按钮「允许本次 / 拒绝」。
- **设置开关**：设置面板「安全」区新增「命令执行二次确认」开关（复用 `CONFIRM_SCRIPTS_KEY` 同模式，`src/shared/constants.ts:32`）；阶段 2 的命令前缀白名单配置。
- **环境信息上报**（随 CMD-2 ① 层）：宿主将可用 shell/运行时**以数据上报** `IEnvironmentProvider`，内核不裁决平台差异，由模型据此决策（良好 shell 探测不做，杜绝「环境事实升为内核判据」）。
- `cwd` 固定为工作区根，**首版无状态**（不支持 `cd` 逃逸）。
- `toolNameMap.ts` 加中文名 `run_command: '运行命令'`（对齐 `run_code: '运行代码'` 的现有映射）。

### 6.3 分阶段

| 阶段 | 内容 | 定档 |
| --- | --- | --- |
| 阶段 1 | 内核工具（run_command）+ 宿主审批 UI + **高危黑名单 + 恒确认** + 超时/截断 | 3.1.0 |
| 阶段 2 | 「总是允许此命令前缀」白名单持久化 + 设置开关 | 3.1.x |
| 阶段 3 | 输出流入终端面板、持久 shell 会话（**仅在真实痛点出现后才做**） | 观察 |

### 6.4 刻意不做（复杂度守恒）

- **持久 shell 会话**（Cline 那套）：要维护进程生命周期、cwd 状态、断线重连——首版无状态、cwd 固定，复杂度不匹配收益。
- **命令模板库 / 命令补全**：过度设计。
- **内核内置 shell 实现**：内核零三方依赖 + 平台差异归宿主，`spawn` 只能在宿主层。

## 七、风险登记（针对本仓的实证风险）

**🔴 本仓血训（用户级记忆实证）：Windows 上 Bash 执行 git 写操作会污染索引——曾导致 `tasks/` 目录 11 个文件被误标删除，纯 ASCII 路径同样触发。**
→ 因此 run_command 首版对 **git 写操作类命令一律进高危恒确认**，且审批卡必须原样展示命令字符串，禁止摘要化显示。

## 八、Windows 脚本执行缺口（2026-09-22 实测订正）

> ⚠️ 本节已按实测结果重写。初稿「补 `.bat`/`.cmd`/`.ps1` 三行映射」的主张**只对前两行成立**，`.ps1` 是错的。

### 8.1 实测证据（本机 Windows，`cmd /c <path>` 与 `resolveCommand` win32 分支同形）

| 扩展名 | `cmd /c <path>` 结果 | 结论 |
| --- | --- | --- |
| `.bat` | status=0，stdout=`HELLO_BAT` | ✅ 可执行 |
| `.cmd` | status=0，stdout=`HELLO_CMD` | ✅ 可执行 |
| `.sh` | status=0，**stdout 空、stderr 空** | 🔴 **静默空跑**（比报错更坏：模型以为执行成功） |
| `.ps1` | status=0，**stdout 空、stderr 空** | 🔴 静默空跑（`cmd /c` 不起 PowerShell） |

环境佐证：`where bash` / `where sh` / `where pwsh` **全部失败**（本机无 bash/sh/pwsh），`where powershell` 命中 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`，`where py` 失败。

### 8.2 缺口全景（比初稿判断更严重）

`run_project_script` 的 **shell 档在 Windows 上整体不可用**，不是一个扩展名的小瑕疵：

- 写 `.bat`/`.cmd` → 映射表缺 → `normalizeScriptRuntime` 兜底成 `node`（`toolExecutor.ts:77-81`）→ 拿批处理语法喂 node → **炸**；
- 写 `.sh` → 命中 shell 档 → `cmd /c x.sh` → **静默空跑**（本机无 sh，且返回 status=0）。

### 8.3 处置（分两批）

| 项 | 处置 | 定档 |
| --- | --- | --- |
| 补 `.bat` / `.cmd` → `shell` | 2 行映射，实测可执行；**零判据改动、零安全面扩大**（`run_project_script` 本就默认开放，与 `.sh` 在 POSIX 上同权限等级） | ✅ **已落地**（2026-09-22，见 §8.4） |
| `.ps1` | ❌ **不做**（初稿错误）。要跑 `.ps1` 必须 `powershell -File`，而 `resolveCommand` 的 shell 档 win32 只产出 `cmd /c <path>`，补映射等于**假修复**。真需要则新增一档 runtime（属新能力） | 观察 |
| `.sh` 静默空跑 | 属**宿主 shell 探测**问题（本机无 bash/sh）→ 与 `run_command` 的 shell 选型是同一件事，合并设计，不重复立项 | 3.1.0（随 CMD-1） |
| 工具描述告知 Windows 不用 `.sh` | 一行文案，防模型静默空跑后误判成功 | ✅ **已落地**（2026-09-22，见 §8.4） |

### 8.4 落地记录（2026-09-22）

| 改动 | 文件 |
| --- | --- |
| `SCRIPT_RUNTIME_MAP` 增 `.bat` / `.cmd` → `shell`（含语义注释：为何必须显式归入 shell 档） | `src/utils/scanner.ts` |
| 新增 `inferRuntimeFromExt` 三组断言（POSIX 档 / Windows 批处理档 / 未知扩展名返回 undefined 且 `.ps1` **刻意不映射**） | `src/utils/__tests__/scanner.test.ts` |
| `run_project_script` 描述同步：补 `.ts`/`.bat`/`.cmd`，并加「Windows 无 Git Bash 时 `.sh` 静默空跑、勿用 `.ps1`」警示 | `src/agent/builtinTools.ts` |

**验证**：变异验证（临时移除 `.bat`/`.cmd` 映射 → 目标断言红、其余 31 条不受影响 → 恢复后绿）；`tsc --noEmit` EXIT=0；`eslint --max-warnings 0` EXIT=0；内核全量 **2736 passed / 4 skipped / 0 失败**；受影响三文件（builtinTools / toolExecutor / skillScriptRunner）**245 passed**。

**⚠️ 发版前必做**：`dist/` 仍是旧产物（内核 build 不清 dist）→ `npm publish` 前须 `rimraf dist` 后 `npm run build` 重建，否则发布包不含本次改动。

## 九、落点清单（改动面）

> 🔴 **本节已被 §13.1 替代（2026-10-02）**：下表为嫁接修正（§11.4）前的旧方案遗留，所列新建文件（`commandExecutor.ts` 等）**不落地**；真实落点以 §13.1 为准，本节仅留档证明决策演变。

| 层 | 文件 |
| --- | --- |
| 内核 | `src/agent/builtinTools.ts`、`src/agent/toolExecutor.ts`、`src/security/pathGuard.ts`、`src/code-exec/types.ts`（或新 `src/command-exec/`）、`src/index.ts` |
| 宿主 | `src/extension/host/commandExecutor.ts`（新）、`src/extension/host/assemble.ts`、`src/shared/protocol.ts`、`src/shared/constants.ts`、`src/webview/panels/chatPanel.ts`、`src/webview/panels/settingsPanel.ts`、`src/webview/helpers/toolNameMap.ts` |
| 文档 | `README.md`、`README.en.md`、`docs/memora-api-reference.md`、`docs/memora-接入指南.md` |
| 测试 | 内核 `toolExecutor.test.ts`（黑名单命中不执行 / 超时 / 截断 / 未注入不暴露）+ 宿主 `commandExecutor` 单测 |

## 十、环境能力宣告（2026-09-22 追加 · CMD-2）

> 命题（用户）：脚本除了系统自带 shell，还有 node / python 这类需用户安装的运行时——
> 内核能否先检测系统 + 检测装了哪些运行时，据此写对应脚本？

### 10.1 主流做法（实锤对照）

| 来源 | 做法 | 关键事实 |
| --- | --- | --- |
| Cline | system prompt **三支柱**：Tools / **System Information** / User Preferences | System Information = 操作系统、当前目录结构、preferred terminal、环境细节。**目的明写**：不让模型在 Windows 上建议 Unix 命令 |
| Claude Code | 每轮向 system prompt 注入环境信息 | 当前工作目录绝对路径、git 分支与最近提交、**操作系统和 shell 类型**、知识截止日期 |

**共同点：探测环境 → 把事实告诉模型 → 由模型自己决定。没有任何一家是「代码替模型选语言」。**

### 10.2 裁决：探测要做，但「据此写脚本」越权

| 命题片段 | 裁决 | 理由 |
| --- | --- | --- |
| 检测系统是什么 | ✅ 该做，但**归宿主** | 内核零三方依赖 + 平台无关 + kernel/host 边界：环境事实只有宿主知道 |
| 检测装了 node / python 没 | ✅ 该做，同样**归宿主** | 同上 |
| 探测结果给谁用 | ✅ **给模型**（注入 system prompt），不是给代码做决策 | 见下 |
| 「确认安装**就会写**对应的脚本」 | ❌ **这条越权** | 写脚本的主体是 LLM。装了 python 不代表这次该用 python——任务性质由模型判断。代码替模型选语言 = 抢决策权 + 僵化（装了 python 就永远写 py？） |

### 10.3 现状缺口（比「没探测」更基础）

**memora 目前模型对自己在什么环境里跑，一无所知。**

| 缺口 | 实锤 |
| --- | --- |
| 无环境信息注入通道 | `assembler.ts` grep `environment\|platform\|systemInfo\|osName\|shell` **零命中** |
| provider 无能力自述 | `ICodeExecutionProvider` 只有 `execute()`，**没有 `supportedLanguages`**（`src/code-exec/types.ts:36-43`） |
| 🔴 因此对模型说了假话 | `run_code` 描述写「如 python、node、shell」，而 VS Code 宿主执行器**只支持 JS**（`codeExecutor.ts:38`）→ 模型照描述写 python → 收到「暂不支持语言」。**这是比 `.bat` 缺映射更严重的瑕疵**：描述与现实不符，且每轮都浪费一次工具调用 |

### 10.4 落地方案（三层，承重序）

| 层 | 内容 | 定档 |
| --- | --- | --- |
| ① **消灭谎言** | **两步走**：**(a) 3.0.0 前**只改文案——`run_code` 的 `language` 描述去掉「python/node/shell」具体列举，改为如实声明「由宿主决定、内核不预设」+ 给可操作路径（优先 `script_path` 模式按扩展名推断）〔✅ 已落地，见 §10.6〕；**(b) 3.1.0** 补 `ICodeExecutionProvider.supportedLanguages?: readonly string[]`（可选 → 不破坏既有宿主），描述按实际声明生成 | (a) ✅ 已落地 · (b) 3.1.0 |
| ② **环境信息注入** | 新增 `IEnvironmentProvider`（宿主上报 OS / shell / 可用运行时），`assembler` 注入 system prompt——对齐 Cline 的 System Information 支柱与 Claude Code 的每轮环境注入 | 3.1.0 |
| ③ **执行期兜底** | 保持现状（失败给明确错误，如 python 兜底链 `py -3`→`cmd /c python`）。**不替模型切换语言** | 不动 |

### 10.5 刻意不做

- **自动语言切换**（检测到没装 python 就改写 .py → .js）：抢模型决策权，且制造「模型以为自己写的 py、实际跑的是 js」的认知错位。
- **内核内置探测**：`where` / `which` / `process.platform` 判据一旦进内核，就把「环境事实」升为「内核判据」——违反派生判定律（宿主内部事实不得提升为内核常量/判据，只能以**数据上报**）。

### 10.6 落地记录（2026-09-22 · 3.0.0 前最小集）

**改动**：`src/agent/builtinTools.ts` 的 `RUN_CODE_TOOL.parameters.properties.language.description` ——
去掉「如 "python"、"node"、"shell"」的具体列举，改为「具体支持哪些语言由宿主执行器决定，内核不预设」+ 可操作路径（优先 `script_path` 模式按扩展名推断；语言不被支持时执行器会回知可用语言）。

**为什么只做文案层（不做接口字段）**：

| 判据 | 结论 |
| --- | --- |
| 严重度 | **中**——与 `.bat` 缺映射（必炸）不同，此瑕疵**可自愈**：宿主返回「暂不支持语言「python」；当前执行器仅支持 JavaScript」，模型据此改用 JS。损失约一轮工具调用，非静默失败 |
| 成本收益 | 彻底修需改 `ICodeExecutionProvider` 接口 + `RUN_CODE_TOOL` 常量→工厂函数 + 10 处消费点（`toolExecutor.ts:692/779/805`、两处测试、`scripts/test-temp-script-loop.ts`、宿主 dist）+ 宿主声明。**发布前动接口形状风险 > 收益** |
| 裁决 | 3.0.0 只做「去承诺」文案（零接口变更、零消费点影响）；接口层随 CMD-2 第②③层在 3.1.0 一起做 |

**验证**：`eslint --max-warnings 0` EXIT=0；`tsc --noEmit` EXIT=0；`builtinTools.test.ts` + `toolRunner.test.ts` **75 passed**；内核全量复跑（见台账 CMD-2 落地记录）。

**⚠️ 已知残留**：`scripts/test-temp-script-loop.ts` 经 3.1.0 接口改动时须同批修改（该文件在 `tsconfig.json` include 之外，脱离 tsc 守卫——与 `searchHybrid` 漏改同型教训）。

## 十一、能力归属追问（2026-09-22 二次澄清）

### 11.1 内核天然会什么（实锤）

| 能力 | 事实 | 证据 |
| --- | --- | --- |
| 跑 JS | 内核是宿主进程内的 node 模块，跑 JS 无需额外依赖 | 宿主即 node 运行时 |
| **spawn 子进程** | ✅ **内核已有**：`node:child_process` 是 node 内置模块，非三方依赖 | `src/skill/skillScriptRunner.ts:26` import + `:75` spawn + `:106-137` 超时/输出收集/windowsHide |
| 平台派发 | ✅ **内核已有**：win32 `cmd /c <path>`、其余 `sh <path>`；python 兜底链 `py -3` → `cmd /c python` | `skillScriptRunner.ts:206-212`、`:141-154` |
| 零三方运行时依赖 | ✅ `package.json` **无 `dependencies` 字段**；`engines.node >= 22` | `package.json:60-62` |

**结论**：内核不是"只能跑 JS"——它已经能 spawn、能按平台派发、能对解释器缺失做兜底。**真正的缺口只有两个**：① 入口不接收裸命令（只收脚本文件路径）；② 内核不知道宿主这台机器上有什么（无环境信息通道）。

### 11.2 「用户装了 python，宿主就会支持吗」

**当前不会**：`codeExecutor.ts:62-69` 对非 JS 语言硬拒（返回「暂不支持语言」）。但技术上很轻——宿主探测 `python` / `py` 存在 → `spawn('python', ['-c', code])`。内核侧已有先例证明这条路可走（python 兜底链）。

**该不该做**：该做，但形态是 **宿主探测 → 声明 → 模型决定**（见 §10.4），不是"自动替模型改用 python"。

### 11.3 VS Code 集成终端：能做，但定位是展示层（无实锤不下结论 → 已搜证）

| 项目 | 前台模式（终端） | 后台模式（headless） |
| --- | --- | --- |
| **Cline** | `vscodeTerminal`：VS Code 集成终端 + **Shell Integration API（v1.93 引入）** `onDidStartTerminalShellExecution` → `execution.read()` 取输出流 + 跟踪 CWD；超时默认 **1 小时**；支持 "Proceed While Running"（dev server 长跑） | `backgroundExec`：`child_process.spawn`，进程树与工具生命周期绑定，abort 杀整棵树 |
| **Roo Code** | `Terminal` 后端（VS Code API + shell integration 抓流） | `ExecaTerminal`（child_process / execa） |

**结论修正**：早年的「终端 API 拿不到输出」说法**已过时**——1.93 的 shell integration 可以取流。但：

1. **约束**：宿主 `engines.vscode: ^1.90.0`（`hosts/memora-vscode/package.json:15-17`）**低于 1.93** → 终端取输出不能作硬前提（要么升 engines，要么做可选能力探测）。
2. **定位**：终端解决的是「用户想看见命令在跑 / 长跑进程」——属**展示层**；执行与取输出仍应由 spawn 承担（可控超时、可截断、可杀进程树）。
3. **裁决**：首版**不做**（复杂度不匹配——要管终端生命周期、CWD 跟踪、1 小时级超时语义、流式输出收敛）。触发条件：真实出现「要跑 dev server / 想看实时输出」的痛点。

### 11.4 CMD-1 设计修正（嫁接而非并列）🔴

**原方案**：新建 `ICommandExecutionProvider` 注入接口。
**排雷发现**：与内核既有能力**重复**——`skillScriptRunner` 已有 spawn + 超时强杀 + 输出收集 + windowsHide + 环境继承 + 平台派发，而这套是**内核内置**的（`run_project_script` / `run_skill_script` 都不走宿主注入）。
**修正**：**不新建 provider**。改为嫁接既有链路——新增 `runShellCommand(command, cwd, timeoutMs)`，复用 `runOnce` 的进程管理与 `formatExecutionResult`（`skillScriptRunner.ts:66-137`、`:218+`），仅新增「裸命令 → `{command: shell, args: ['/c'|'-c', command]}`」的解析分支。宿主侧只剩**审批 UI + 提示词开关**（`SecurityGuard.confirmCommandRun` 保留）。

**收益**：无新接口、无新注入口、无条件暴露逻辑；与脚本执行**共用一套进程治理**（超时/截断/净化/审计单源）。
**仍需验证**：安全面设计（黑名单 + 确认 + 审计）——故**结论不变：不进 3.0.0**。

### 11.5 run_command 暴露机制拍板（2026-09-22 · 常驻开放 + deny/ask/allow 三层护栏）

> 拍板依据 = 主流养分 + 现状先例 + 前面已验证的本仓事实（对齐「网络为土壤」：搜索结论进设计）。

**主流实锤**（2026-09-22 搜证）：

| 来源 | 命令工具暴露 | 护栏 |
| --- | --- | --- |
| Cline | `execute_command` **常驻**工具面，每命令弹 Approve/Reject 确认 | 确认层 + auto-approve 按权限类型 |
| Roo Code | 命令执行常驻 | Auto-Approve 面板逐权限开关 + **命令前缀 allowlist/denylist（deny 优先）** |
| Claude Code | Bash 工具**始终在场** | 权限三区交通灯 `allow/ask/deny`，`Bash(前缀)` **前缀匹配**（非正则），优先级 **deny > ask > allow** |
| mac-shell-mcp | 常驻 | Safe（自动）/ Requires Approval（排队确认）/ Forbidden（永不执行）三档 |

**共同点：没有任何一家用「注入才暴露」**——命令执行是 agent 的基础能力面，**常驻可见**，安全靠权限分层（deny 硬阻 > ask 恒确认 > allow 豁免），不靠工具的「条件出现」。

**memora 现状（种子）**：`run_project_script` 已是内核 `BUILTIN_TOOLS` 常驻 + 默认开放（三道防线：路径白名单 → 确认 → runtime 白名单）；高危黑名单判据已定内核单点（SSOT）；确认机制已有 `confirmScriptRun` 先例与设置面板开关。

**拍板（最优方案）**：

1. **`run_command` 走内核 `BUILTIN_TOOLS` 常驻、默认开放**——对齐 `run_project_script` 与主流共识；**不做 provider 条件注入**（该机制随 §11.4 嫁接修正已失效，且主流全都不这么做）。
2. **护栏落地为三层交通灯**（对齐 Claude Code 的 deny>ask>allow）：
   - **deny（红）**：高危黑名单、内核单点 SSOT（既有清单 + 本仓血训：**git 写操作类命令一律进 deny 或恒 ask**），命中即拒、**优先级最高**（即使被 allow 前缀匹配到也拒绝）。
   - **ask（黄）**：非高危默认**恒确认**（阶段 1 默认开启；宿主设置面板可关——复用 `CONFIRM_SCRIPTS_KEY` 同款开关语义）。
   - **allow（绿）**：命令前缀白名单（阶段 2，「总是允许此前缀」），默认空、可选启用。
3. **命令匹配用前缀匹配**（对齐主流非正则共识；避免语义匹配死锁）。
4. 分阶段不变：阶段 1 = deny + 恒 ask（无白名单）→ 阶段 2 = 开放绿区可选。

### 11.6 supportedLanguages 可选性拍板（2026-09-22 · 声明列举 / 未声明退化为不列举，gold 保障）

**主流实锤**：Cline / Claude Code 工具描述是**静态写死**（preset），无 provider 自述概念——memora 的宿主注入模式是自身特色，`supportedLanguages` 属内核的**可选能力声明扩展**，不照搬静态模式。
**TS 语义版本学**：新增**可选**接口成员 = minor（兼容）；新增**必填**成员 = breaking——可选性即 minor 兼容的形制保障。

**拍板保障**：

1. 宿主**声明** `supportedLanguages: readonly string[]` → 描述生成「支持：a、b、c」。
2. 宿主**未声明** → 描述退化为现行去承诺文案（「具体支持哪些语言由宿主执行器决定，内核不预设」），**不报错、不拒服务、不列举**——对任意现有宿主零感知。
3. **测试锁死**：未声明 → 生成的描述不含任何语言名（防回归「悄悄开始列举」）。
4. `scripts/test-temp-script-loop.ts` 在 3.1.0 改接口时**同批修改**（已登记——该文件脱离 tsc 守卫，防 searchHybrid 式漏改）。

## 十二、审批档位定案（2026-10-02 · 主流养分吸收 + confirmScripts 单一真源打磨）

> 本节为 §11.5 三层护栏的**审批档位**维度的落地定案。养分来源：Trae 官方文档与博客（2026-01 沙箱公告、更新日志）、Claude Code 权限模式文档与 auto mode 工程博客（2026-03）——搜证日期 2026-10-02。

### 12.1 主流实锤（2026-10-02 搜证）

| 来源 | 档位模型 | 关键不变式 |
| --- | --- | --- |
| **Trae**（IDE） | 命令执行三档：**Sandbox + Allowlist**（默认）/ **Manual Run**（全部手动）/ **Auto Run**（自动）；更早版本四档（手动 / 黑名单 / 白名单 / 全自动）+ 高风险命令自动检测 | **Auto Run 下黑名单命令仍需手动**（自动档不吞掉红名单）；Shell 拦截层（`rm`/`rmdir` 类）独立于档位恒生效 |
| **TRAE CLI** | `permission_mode`：`default`（非只读全询问）/ `plan` / `bypass_permissions`（狂飙） | 会话级档位与工具级规则**双轴并存** |
| **Claude Code** | 会话档位：`default` / `acceptEdits` / `plan` / `auto`（分类器代审）/ `dontAsk` / `bypassPermissions`；工具级 `allow/ask/deny` 三区前缀匹配，deny > ask > allow | **「任何模式都不自动批准」清单** + 关键路径（Protected/Critical paths）删除连 bypass 也拦；auto mode 进入时**主动丢弃**已授予的任意代码执行规则 |
| **Claude Code auto mode**（93% 实证） | 用户批准 93% 的权限弹窗 → **审批疲劳**是恒问模式的实证代价；auto mode = 输入层注入探针 + 输出层分类器代审 | 恒问 ≠ 安全（无脑批准）；全自动 ≠ 无护栏（分类器/关键路径兜底） |

**共同点收敛**：主流全部收敛为**双轴模型**——轴 1 会话级审批档位（控制「问不问」基调），轴 2 工具级三区规则（deny 红名单 / ask 黄区 / allow 绿前缀）；且**红名单在任何档位下优先级最高**（Trae Auto Run 黑名单仍手动 = Claude no mode auto-approves 同一不变式）。

### 12.2 memora 种子对照（现有机制即档位雏形，不新增开关）

| memora 现有机制 | 主流同位 | 定位 |
| --- | --- | --- |
| `confirmScripts: boolean`（`memora.confirmScripts`，宿主 globalState，默认 `false`，经 extension 注入内核） | Trae 的 Manual Run ↔ Auto Run 档位切换 | **轴 1 会话档位已存在**——布尔两态恰好承载主流两档 |
| `confirmScripts = true` | Trae Manual Run / Claude `default` | 恒确认档 |
| `confirmScripts = false` | Trae **Auto Run**（黑名单仍手动）/ Claude `bypassPermissions` 但保留关键路径拦截 | 自动档（deny 红名单仍恒拦） |
| deny 高危黑名单（内核单点 SSOT，不可关） | Trae 黑名单 / Claude Critical paths | **轴 2 红名单已存在**且比主流更严（内核 SSOT，宿主无法绕过） |
| 权限模式 `guest`（恒确认 fail-closed）/ `owner`（默认自动批准走审计） | Claude「任何模式都不自动批准」+ 角色权限 | **叠加约束**：guest 压倒审批档位 |
| `SecurityGuard.confirmScriptRun`（统一确认入口，fail-closed） | 各家 Approve/Reject 弹窗 | 审批执行链路单一真源 |

**SSOT 结论**：**布尔开关不升级为枚举档位**。`confirmScripts` 两态与主流两档语义一一对应，红名单、guest 叠加、allow 白名单全部是**正交维度**（列表/模式叠加），不塞进档位枚举——新增枚举 = breaking 且制造第二套开关面，违背单一真源。Trae 的四档中「白名单」在 memora 是独立的 allow 前缀列表配置（§11.5 阶段 2），与档位正交——Trae 自身也是同样结构（模式 × 白名单列表）。

### 12.3 裁决链定案（优先级单源，run_command 与脚本工具共用）

```
deny 黑名单命中（内核 SSOT，优先级最高，任何档位/guest/owner 之下恒拦）
  → guest 权限模式（恒确认，fail-closed；未注入 confirmationHandler 即拒绝）
    → confirmScripts 档位（true = ask 弹宿主审批；false = 自动批准走审计）
      → allow 前缀白名单（阶段 2；仅对走到此层的命令生效，命中即免 ask）
```

- **run_command 与 run_project_script / run_skill_script 共用同一条裁决链**（`SecurityGuard.confirmCommandRun` 接入 `confirmScriptRun` 同款 handler 链路）——不出现第二套确认机制。
- 审计：`confirmScripts = false` 档的自动批准**必走审计**（沿用 owner 模式既有语义），出事可溯。
- 审批疲劳对策：恒 ask 是默认安全档（阶段 1），逃逸阀 = ①关开关进 denyOnly 自动档（deny 仍拦）②阶段 2 的 allow 前缀白名单。**不引入「按命令智能预判是否询问」**（无分类器条件下是伪安全）。

### 12.4 刻意不做（复杂度守恒，带伤预防）

| 不做 | 理由 |
| --- | --- |
| 沙箱（Trae Sandbox with Allowlist） | Windows 无系统级沙箱条件（Trae 自家 Windows 也未支持，官方建议 allowlist 替代）；memora 已有路径白名单 + 超时强杀兜底 |
| 分类器代审（Claude auto mode） | 需服务端第二模型（Sonnet 分类器），memora 本地单机 + 用户自持 API key，无条件；且「93% 批准率」问题的本仓解法是 denyOnly 档 + allow 白名单，不是再造分类器 |
| plan 模式联动（TRAE CLI / Claude `plan` 档） | memora 无 plan 权限模式；「先计划后执行」职责已由预检停顿承载，重复建设 |
| 「任何模式都不自动批准」泛化清单 | memora 的 deny 内核 SSOT 已承载该不变式；额外维护一份跨工具清单 = 第二真理源，等真实场景再收敛 |
| 会话中动态切档（Claude Shift+Tab） | 档位属宿主设置面（globalState），对话中改配置破坏「重配置对象只被显式调用」；先不做，等真实需求 |

### 12.5 不带伤自检（落地前逐条对照）

1. **零 breaking**：内核选项面无新必填成员（`confirmScripts` 布尔原样复用；run_command 新工具属新增 minor）。
2. **零第二开关**：审批面唯一入口 `confirmScriptRun`/`confirmCommandRun` 同链路；设置面唯一开关 `memora.confirmScripts`。
3. **红名单不可逃逸**：deny 在任何档位 × 任何权限模式下恒拦（内核 SSOT 判据，测试锁定：guest + denyOnly 组合、owner + deny 命中 → 拒绝）。
4. **fail-closed 保底**：`confirmationHandler` 未注入 → ask 层拒绝（既有语义，run_command 同样遵守）。
5. **审计闭环**：自动批准必留审计记录；ask 批准/拒绝结果亦入审计。
6. **分阶段护栏**：阶段 1 无 allow 白名单（逃逸阀只有 denyOnly 档）→ 阶段 2 开放绿区时白名单配置须**默认空**且设置面板明示风险（对齐 Trae「Add to allowlist 前验证安全」话术）。
7. **后台语义全程显式**（§14）：agent 发起时即知后台态（`background: true` 立即返回 taskId + 工具描述写明回流机制）；不存在「同步等一半自动变异步」的隐式切换点；不做超时自动转后台。
8. **回流 role 语义隔离**（§14）：回流事件不借道插话队列、不伪装用户发言；独立事件类型 + 来源标记，回流不占插话满员计数（测试锁定）。

## 十三、实施规格收口（2026-10-02 · 落地就绪度审查补口）

> 落地就绪度审查结论：架构决策层（§6 / §11.4-11.6 / §12）已闭合；本节收口实施规格层五处缺口，补齐后方案达到可落地形态。

### 13.1 落点清单重写（替代 §9——原清单为嫁接修正前的旧方案遗留）

**嫁接修正（§11.4）后，不新建 provider、不新建宿主 commandExecutor**。真实落点：

| 层 | 文件 | 改动 |
| --- | --- | --- |
| 内核 | `src/code-exec/skillScriptRunner.ts` | 新增 `runShellCommand(command, cwd, timeoutMs)`——复用 `runOnce` 进程治理，仅新增「裸命令 → `{command: shell, args: ['/c'\|'-c', command]}`」解析分支 |
| 内核 | `src/agent/builtinTools.ts` | 注册 `run_command` 常驻工具（schema 见 §13.3） |
| 内核 | `src/agent/toolExecutor.ts` | 新增 handler：黑名单校验（§13.2）→ `confirmCommandRun` 确认 → 调 `runShellCommand` |
| 内核 | `src/security/pathGuard.ts` | 黑名单 SSOT 清单扩展（含 alwaysAsk 分区，§13.2）+ `confirmCommandRun`（接 `confirmScriptRun` 同款 handler 链路） |
| 内核 | `src/index.ts` | 类型导出（若有新面） |
| 宿主 | `src/extension/extension.ts` | 确认 handler 注入处扩展命令确认分支（复用脚本确认同一条注入链） |
| 宿主 | `src/shared/constants.ts` | 开关键沿用 `CONFIRM_SCRIPTS_KEY`（**不新增键**）；若有独立描述开关才补 |
| 测试 | 内核 `toolExecutor.test.ts` / `pathGuard.test.ts` + `skillScriptRunner` 单测 | 清单见 §13.5 |

**明确不落点**：`protocol.ts`（审批走既有确认链路，零新协议通道）、`chatPanel.ts`、`settingsPanel.ts`（除非 §13.3 描述开关独立）、无 `commandExecutor.ts`。

### 13.2 git 写操作分级定案（消解 §11.5 的「deny 或恒 ask」悬置）

**拍板：恒 ask（alwaysAsk 分区），不进 deny 黑名单。**

- 理由：deny = 永久拒绝，agent 从此无法 `git commit` / `git add`（高频正当操作）；本仓血训（Windows git 写操作污染索引前科）的正确对策是**每次都问 + 不可豁免**，不是**永远禁跑**。
- 落地形态：内核黑名单 SSOT 处新增 `ALWAYS_ASK_PREFIXES` 分区（与 deny 同文件同源同测，**同一真源两个分区**）；裁决链在 §12.3 基础上细化：

```
deny 黑名单（恒拦）
  → ALWAYS_ASK 前缀命中（即使 denyOnly 档也弹确认；allow 白名单对它无效——不可被绿区豁免）
    → guest 恒确认（fail-closed）
      → confirmScripts 档位（true = ask；false = 自动批准走审计）
        → allow 前缀白名单（阶段 2）
```

- 清单初始内容：`git commit`、`git push`、`git reset`、`git rebase`、`git merge`、`git checkout`（`--` 文件形态）——前缀匹配，实施时按本仓实测补全；**清单只增不减须过测试**（清单回归 = 内容真源变更，走台账）。
- 同理适用的高危写操作：`rm -rf`/`Remove-Item -Recurse -Force` 类**留 deny**（无正当 agent 场景）；`npm publish` 类发布操作**进 ALWAYS_ASK**。

### 13.3 工具 schema 定案（LLM 契约面）

```jsonc
// run_command 参数面（name: run_command；常驻 BUILTIN_TOOLS）
{
  "command":    "string — 要执行的 shell 命令（Windows 经 cmd /c，类 Unix 经 sh -c）",
  "cwd":        "string? — 工作目录（绝对路径；缺省 = 宿主注入的工作区根）",
  "timeoutMs":  "number? — 超时毫秒（缺省 60_000，上限 600_000，越界取边界）",
  "background": "boolean? — true = 后台执行：立即返回 taskId，完成后经气口回流（定案见 §14）；缺省同步等待"
}
```

**描述措辞红线**（止血④同款纪律）：

1. **禁写安全承诺**——不出现「已校验/安全/已过滤」类字样（LLM 会据此跳过谨慎）；只写能力边界：「在工作区执行 shell 命令，受黑名单与用户审批约束」。
2. **禁写 bypass 提示**——不写「可通过关闭确认开关自动执行」（引诱 LLM 建议用户关护栏 = 诱导性越权）。
3. 超时语义写明：超时即强杀并返回已捕获输出（复用 `runOnce` 语义）。

### 13.4 审计与确认呈现接线（自检第 5 条的落地形态）

- **审计**：实施第一步先核实 `SecurityGuard` 既有审计通道的落点形态（脚本工具自动批准的审计现状），`run_command` 接**同一通道**——禁止新建第二审计流。若现状脚本工具无审计落盘（仅有内存痕迹），则 run_command 阶段 1 至少保证「确认请求与裁决结果（ask 批准/拒绝/自动）进既有 trace/审计面」，并如实登记边界，不虚写。
- **确认呈现**：复用脚本确认 handler 的**现有宿主呈现**（extension 注入 confirmationHandler → 既有 UI 通道），**零新协议通道**。实施首日核对该链路的呈现形态（模态/内联），若发现脚本确认本身无 UI 呈现（静默 fail-closed），属独立缺口，单独立项不动 run_command 结构。
- **fail-closed 保底**：handler 未注入 → 拒绝执行（既有测试语义，run_command 用例同锁）。

### 13.5 阶段 1 验收锚点（完成判据）

**测试清单**（全绿 = 代码层完成）：

1. 黑名单命中不执行（deny 分区，任何档位 × guest/owner 组合恒拒）。
2. ALWAYS_ASK 命中：denyOnly 档仍弹确认；allow 白名单（阶段 2 到来后）对它无效。
3. guest + 未注入 handler → 拒绝（fail-closed）。
4. owner + confirmScripts=false → 自动批准 + 审计记录存在。
5. owner + confirmScripts=true → 弹确认；拒绝后不执行、LLM 收到拒绝语义（非静默空跑，止血③教训）。
6. 超时强杀 + 输出截断（复用 runOnce 语义的边界用例）。
7. 描述文案守卫：不含「安全/已校验」承诺词、不含 bypass 提示（文案快照测试）。
8. `scripts/test-temp-script-loop.ts` 同批修改核验（§11.6.4）。
9. `background: true` 立即返回 `taskId`（不等待进程结束）；同步路径行为不受参数缺省影响（§14）。
10. 后台完成 → 回流事件在下个 iteration 检查点注入且带来源标记；回流不占插话满员计数（role 语义隔离，§12.5 第 8 条）。
11. turn 终态收割：done / interrupted / error 后存活后台进程被强杀且收尾报告；回流不跨 turn（§14.5）。

**真机点验项**：恒确认档弹窗 → 批准执行成功 / 拒绝后 LLM 行为合理；denyOnly 档普通命令直跑 + git commit 弹窗；黑名单命令直接拒绝的对话呈现。

**阶段 1 完成定义 = 测试全绿 + 真机点验通过 + §12.5 八条自检逐条对照通过**；阶段 2（allow 白名单）另行排期，不随阶段 1 顺车。

## 十四、后台执行定案（2026-10-02 · 长命令消费者实锤后的阶段 1 范围修订）

> 触发：长命令消费者场景实锤——全量测试 1-2 分钟、gate-full 285s、冷缓存依赖安装数分钟，600s 同步上限贴脸，且同步执行期间 agent 全程停摆（插话也须等命令结束后的气口）。本节修订阶段 1 范围：**同步默认不变，新增显式后台能力**。

### 14.1 能力面（阶段 1 修订后）

| 组件 | 定案 | 边界 |
| --- | --- | --- |
| `run_command` 同步 | runOnce 嫁接，等**进程退出码**（非输出流静默判定），600s 上限 | §13 已定案不变 |
| `background: true` 参数 | **发起时显式声明后台**：立即返回 `taskId`，agent 心理模型全程一致 | **不做超时自动转后台**（拒绝理由见 §14.3 末行） |
| 完成回流 | 后台命令结束 → **气口排队回流**（形态见 §14.2），agent 下个 step 消费结果继续原任务链 | **不跨 turn**：turn 终态收割存活进程并收尾报告（§14.5） |
| `kill_command` 工具 | 显式终止，返回截至终止时的已捕获输出（兼任「放弃并看输出」） | watch/server 类**中途增量查询**（command_output）不做——触发 = 长驻进程真实需求，阶段 2 |

### 14.2 回流通道形态（对齐 TOOL-ASYNC-1 沉淀设计，零新基建）

- 回流走**独立队列**：与 pendingInterjections 同机制（iteration 间检查点消费、挂起/恢复全链路复用），但**独立事件类型**——插话通道留给用户意图，系统事件不借道、不占插话满员计数。
- 回流进 LLM 历史时标记来源为「后台命令完成」（非用户发言），role 语义隔离。
- ask 挂起 / 打断续跑期间后台进程继续跑：回流在恢复后的下个气口注入（不丢、不打断当前推理）。
- 多命令并发完成：按完成顺序逐个回流。
- 进程治理复用 `runOnce` 强杀语义（tree-kill），收割锚在 turn 终态既有集合。

### 14.3 养分吸收矩阵（土壤 → 种子过滤）

| 养分 | 吸收 | 拒绝 | 拒绝理由 |
| --- | --- | --- | --- |
| Claude Code `run_in_background` | 发起时决定后台（显式参数） | BashOutput 轮询 | 轮询烧 token + 有忘查风险；memora 有气口回流原生通道，推优于拉 |
| Trae 同步默认 | runOnce 同步嫁接 | 等待中人工降级转后台 | 状态中途转换是带伤高发区（Trae 官方社区「命令已结束 agent 傻等」「工作流全停」bug 帖实锤，2026-10-02 搜证） |
| Trae 集成终端读流 | 进程退出码判定 | 输出流静默判定 | 结束信号确定性——Trae 流静默误判痛点天然免疫 |
| Claude 权限三模式 | `confirmScripts` 档位语义（§12.2） | 枚举化模式切换 | 布尔即两档同位；红名单/guest/allow 全是正交维度（§12.2 SSOT 结论） |
| Trae/Claude 黑名单 | 内核 SSOT deny 恒拦 | 宿主侧黑名单 | 集成方不可绕过，内核是不可逆约束层 |
| Anthropic 93% 批准率实证 | 逃逸阀前置：关开关进 denyOnly 自动档（deny 仍拦） | 恒问不设逃逸 | 恒问必然被无脑批准（审批疲劳），安全 theater |
| 用户「等待 60s 超时自动转后台」提案 | **回流走气口排队——完整保留** | 隐式超时切换 + 魔法数阈值 | 语义中途切换 → agent 在不确定态幻觉推进；违背「禁止隐式自动挂起」定案；同一工具行为不可预测 |

### 14.4 对 TOOL-ASYNC-1 的改判

- `run_command` 的 `background` = 沉淀设计的**首个单工具实例**（显式发起 + 结果回流作新输入事件 + 气口注入，均为台账已闭合设计）。
- `wait_tool_results` 挂起语义**继续不做**：回流是推模式，「agent 主动等待」需求被回流通道消解。
- 泛化触发条件改判：~~首个 async 消费者开工~~ → **第二个 async 工具真实需求出现时**，将单工具回流通道泛化为通用 `async` 声明位（升级不改地基）。

### 14.5 竞态边界（阶段 1 拍板）

- turn 终态（`done` / `interrupted` / `error`）统一收割存活后台进程，收尾报告未收割任务；回流不跨 turn（跨 turn 回流属新语义面，待真实需求另立项）。
- 打断续跑不算终态：后台进程继续跑，续跑后回流照常注入。

### 14.6 不带伤自检（新增两条，清单单点在 §12.5 第 7/8 条）

本节修订引入的新伤面（隐式切换 / 回流借道）对应 §12.5 追加的第 7、8 条自检，落地前逐条对照，不在本节重复陈述。
