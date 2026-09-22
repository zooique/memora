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
