---
name: real-device-test
description: 把 memora 的 VS Code 宿主真正跑起来（F5 Extension Development Host）并按固定流程取证。当用户说「真机测试」「真机验收」「跑一下宿主看看」「F5 验一下」时使用。只管环境与取证，用例由调用方给出，不内置用例
---

# memora 真机测试（VS Code 宿主）

> 适用：必须看「用户眼睛看到的运行态」才能判的验证——UI 呈现、命令可用性、扩展激活、跨窗口落盘。
> 不适用：纯逻辑验证（走 vitest）、发版（走 `memora-host-release`）。

## 入参

| 入参 | 来源 | 缺失时 |
| --- | --- | --- |
| 本轮测试清单（用例 / 观察点 / 预期 / 判定方式） | **调用方（人）给出** | 停下问，不许自己编用例 |
| 被测项目工作区绝对路径（**必填**） | 调用方给出 | 停下问，不许拿仓库根凑数；启动后加载到的不是它 ⇒ 停 |
| 取证口径（是否每步截图、是否留日志副本） | 调用方 | 默认：每步截图 + 拷 `exthost.log` 尾部 |

**本技能不内置用例**：用例随功能变化，写进技能必然过期。技能只负责「环境正确起来 + 证据能指到时间点」。

## 前置（缺一步就不许开测）

### P1 钉住被测版本

```powershell
git -C f:\zooique\memora rev-parse --short HEAD
git -C f:\zooique\memora status --porcelain
```

```powershell
# 内核版本（在仓库根执行）
cd f:\zooique\memora; node -p "require('./package.json').version"
# 宿主版本（在宿主包执行）
cd f:\zooique\memora\hosts\memora-vscode; node -p "require('./package.json').version"
```

- 四项（commit / 内核版本 / 宿主版本 / 工作树是否干净）写进本轮报告头。
- 工作树脏**不禁止**开测，但必须把脏文件清单登记在报告里：`src\` 或 `hosts\*\src\` 下有未提交改动时，结论对应的是「工作树态」而不是 HEAD，不许在报告里写成「HEAD 已通过」。

### P2 清场

1. **整轮测试期间**（不只是开工前）要求其他会话不跑门禁、不写盘：`ci:local` / vitest / build 会重写宿主 `dist`，而开发宿主**打开与 `Reload Window` 都读 `dist`**。实测：另一会话在测试中途跑了一轮 full、重写了 `dist`（内核 hash 未变）⇒ 一旦发现 `dist` 被重写，必须在报告里登记，并**重新确认一次扩展激活状态**。
2. 关掉上一次的 Extension Development Host 窗口。
3. 找残留开发宿主（🔴 **不要按进程找**）：开发宿主**不是独立进程**，而是**同一个 `Code.exe` 进程内的新窗口**，`CommandLine` 里**没有** `extensionDevelopmentPath` ⇒ 按进程的判据永远命中不了。必须用**进程无关的顶层窗口枚举**（Win32 `EnumWindows` 逐窗口取 `PID|HWND|标题`）。

```powershell
# 仅辅助：MainWindowTitle 对基础窗口返回空（实测 16 个 Code.exe 全空），不能单独作判据
Get-Process Code -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowTitle -like '*扩展开发宿主*' } |
  Select-Object Id, MainWindowTitle
```

**判读规则（必须带正向对照，缺对照 = 没兜底）**：

| 结论 | 判据 |
| --- | --- |
| **有残留** | 存在任意**可见**窗口标题含 `[扩展开发宿主]` **或** `[Extension Development Host]`（随 UI 语言变，两种都要匹配；最小化窗口仍带 `WS_VISIBLE`，不会漏） |
| **干净** | **同一次 `EnumWindows` 调用**里既有**正向对照**（至少 1 条必然存在的窗口，如 `Program Manager` 或主窗口 `… - Visual Studio Code`）**且**无残留行 |
| **不可判** | 空结果且**没有**正向对照 ⇒ 一律判不可判，报人重跑 / 人目视；**只有带正向对照的空结果才算干净** |

- 报告里贴 `PID|HWND|标题` 原文，**不许**只写「没有残留」。
- 样本（本轮实测）：`PID 55444 | HWND 15732068 | memora-vscode - Visual Studio Code`；同刻该进程 `MainWindowTitle` 为空 ⇒ 这就是必须走 `EnumWindows` 的理由。

4. 锁的真相（别找错东西）：

| 锁 | 落点 | 残留判据 |
| --- | --- | --- |
| 记忆库锁 | `<被测项目>\.memora\.lock`（内含 `{pid, acquiredAt, hostname}`） | **pid 已死时下次启动自动清理**；只有 pid 还活着才是冲突源（宿主日志会报「项目已被其他进程打开」） |
| 会话写锁 | Windows 命名管道 `\\.\pipe\memora-lock-<32 位 hex>` | 进程退出即由 OS 回收，**没有锁文件可删**；只能靠杀进程，不要去找锁文件 |

```powershell
Get-Content <被测项目>\.memora\.lock -ErrorAction SilentlyContinue
Get-Process -Id <pid> -ErrorAction SilentlyContinue
```

### P3 确认被测项目

- `Test-Path <被测项目路径>` 为 `False` ⇒ 停。
- 🔴 **`launch.json` 里没有 `--folder-uri`，也没有固定工作区路径**（实测 2026-11-07）⇒ **不保证带工作区**：实测开发宿主**恢复上次工作区**（本次直接进了 `e:\ceshi`，Memora 输出 `projectPath: e:\ceshi`），不是空工作区。
- 所以启动后必须核对两点：资源管理器根节点 = 目标绝对路径；窗口标题里的文件夹名 = 目标文件夹名。**不是目标项目**才 `File → Open Folder`；是目标项目就直接开测，别多此一举。加载到别的项目又不纠正 ⇒ 停。
- 若用例依赖**项目级**技能 / 角色包（`<项目>\.memora\skills`、`<项目>\.memora\role-packs`）：先确认工作区已受信任——未受信任时 memora 不读项目级资产（宿主会给提示），用例会「看起来不生效」。

## 编译（顺序写死：先内核，后宿主）

> 为什么写死：宿主 bundle 由 esbuild **内联内核 dist**。先编宿主 = bundle 里是上一代内核，且门禁默认看不出来（`verify-dist-contract` 就是为补这个盲区而存在）。

1. 内核（仓库根）：

```powershell
cd f:\zooique\memora; npm run build:clean
```

`build:clean` = 清 `dist` → `tsc -p tsconfig.build.json` → `tsc-alias`。**用 clean 而不是 `npm run build`**：裸 tsc 不清 dist 会留孤儿产物。

2. 宿主：

```powershell
cd f:\zooique\memora\hosts\memora-vscode; npm run compile
```

`compile` = 清宿主 `dist` → `tsc -p ./` → `node esbuild.config.mjs`（内联内核、打 webview、写构建戳）→ 末尾跑产物加载冒烟（`verify-bundle-loadable.mjs`，产物加载不了则构建直接失败）。

3. 同代校验（仓库根）：

```powershell
cd f:\zooique\memora; npm run verify:dist-contract
```

必须看到 `✅ [dist-contract] 宿主 bundle 与内核 dist 同代（hash=…）` 与「内核 dist ↔ src 一一对应」。红 ⇒ 回第 2 步重编，**不许带病启动**。

4. 核对「加载的是新产物而不是旧 dist」：

```powershell
Get-Content f:\zooique\memora\hosts\memora-vscode\dist\.build-stamp.json
Get-Item f:\zooique\memora\hosts\memora-vscode\dist\extension\extension.js |
  Select-Object LastWriteTime, Length
```

判据：`builtAt` 晚于本次开工时刻；`extension.js` 的 `LastWriteTime` 与 `builtAt` 同一批（秒级差异正常）。

⚠️ 宿主 `npm run watch` 只是 `tsc -watch -p ./`，**不跑 esbuild、不写构建戳** ⇒ 不能替代 `compile`，F5 也不会走它。

## 启动

1. **VS Code 打开的文件夹必须是 `f:\zooique\memora\hosts\memora-vscode`**。
   仓库根**没有** `.vscode\launch.json`（实测 2026-11-07）⇒ 在根按 F5 得不到「Run Extension」。
2. F5 前先确认 **VS Code 窗口有焦点**，且状态栏已显示 `Run Extension (memora-vscode)`；否则按 F5 可能弹出调试配置选择器（而不是直接启动）。
3. F5 → 选 **Run Extension**。
   - `preLaunchTask` = `${defaultBuildTask}` → 宿主 `npm run compile`：F5 会自动再编一次**宿主**（**不编内核**，内核已在上一节编好）。
   - 耗时随机器与冷热差数倍（两轮实测 29 秒 / 80 秒都出现过）⇒ **以当次构建戳为准**，别拿上一轮的数当超时判据。
   - `args` 含 `--disable-extensions` ⇒ 开发宿主**临时禁用已安装的扩展**（只加载被调试的 memora）。这也是下节「已知噪声」的来源。
4. **闪退判据**（本技能约定，非仓库事实）：
   - **首选口径：计时起点 = `preLaunchTask` 结束之后**（终端出现 `[BUNDLE:SMOKE] ✅`，即宿主 `compile` 收尾）。起点后 **90 秒**内没有出现标题含 `[扩展开发宿主]` 的窗口，或窗口出现后 **30 秒**内消失 / 调试会话自己结束 ⇒ 判闪退。
   - **读不到终端时（agent 常态）**：以 `hosts\memora-vscode\dist\.build-stamp.json` 的 **`builtAt`** 作为 `preLaunchTask` 结束时刻（实测误差 ≤1 秒）。agent 对任务终端没有稳定读法，**优先用构建戳**，不要靠盯终端。
   - 🔴 **不许用「按 F5 起算 90 秒」**：F5 还要跑一遍宿主 compile，窗口必然晚于预构建结束 ⇒ 该口径会把正常启动误判成闪退。
   - 若确要用「按 F5 起算」，阈值必须放到 **180 秒以上**，并在报告里写明用的是哪个口径。

   ⇒ 判闪退后按 P2 清场重试，**最多 3 次**；第 3 次仍闪退 ⇒ 停下如实报（附 `exthost.log` 尾部 + 调试控制台原文），**不许无限重试**。
5. **已知噪声处置**：见下节「已知噪声签名」。**先点「重新加载并启用扩展」**，不要关窗口、不要重启 VS Code——关窗口等于把 F5 调试会话断掉，得从头再来，还可能再撞一次闪退。
6. 启动后确认状态（三条都要有可判证据）：

   | 项 | 可判的观察点 |
   | --- | --- |
   | 目标项目已加载 | 窗口标题的文件夹名、资源管理器根节点路径 = 目标绝对路径 |
   | memora 已激活 | 命令面板（`Ctrl+Shift+P`）能搜到并执行**「Memora: 打开对话面板」**（`memora.open` 是命令 ID；界面文案真源 = `hosts\memora-vscode\package.nls.zh-cn.json`）；活动栏出现 Memora 图标、侧栏「对话」视图可打开 |
   | 有激活记录 | 输出面板 →「Memora」有启动期输出，或本次 `exthost.log` 出现 `zooique.memora-vscode` 激活段 |

   - 用例要触发工具调用时，先确认模型已配置（`Memora: 配置模型`）。模型不支持原生 function calling ⇒ 工具永不触发，记「前置能力缺失」，**不是本轮缺陷**。

## 已知噪声签名

| 项 | 内容 |
| --- | --- |
| 现象 | Extension Development Host 启动时报错，右下角弹窗提示**所有已安装扩展被临时禁用** |
| 首因（推断） | `launch.json` 的 `args` 含 `--disable-extensions`（实测值，见文末「实测事实」） |
| 弹窗按钮（实测） | **「重新加载窗口」**与**「重新加载并启用扩展」**（不是「重新加载插件」） |
| 处置顺序 | ① 先点 **「重新加载并启用扩展」**；② 点不动时按「下一档」处理，并在报告登记 |
| 程序化点击（分层实测） | ① **UIA 元素点击（element click）优先**——实测**有效**；② 坐标点击 / `Tab+Enter` 实测**无效**；③ 两者都失败才交人手动点，并报出按钮原文 |
| 其他已知噪声（**非本扩展**） | `TypeError: Missing dataLength in event`，栈在 `node:inspector`，与 memora 无关（实测同一窗口内多条）⇒ 登记但不判失败 |
| 未恢复 → 下一档 | 命令面板执行 `Developer: Reload Window`（只重载窗口，不断调试会话）；**它清不掉该通知**（实测：重载后通知仍在） |
| 恢复判据 | ① 命令面板能搜到并执行**「Memora: 打开对话面板」**（`memora.open`）；② Memora 侧栏「对话」视图能打开；③ 输出「Memora」频道或本次 `exthost.log` 出现扩展重新激活记录。**三条都满足**才算恢复 |
| 已知残留 | `Developer: Reload Window` 后**通知仍在**：不算失败，但必须在报告里登记「通知未清除 + 实际用哪种方式恢复」 |
| 签名不一致 | **停下报人**，把弹窗原文与 `exthost.log` 对应行抄进本节 |
| 副作用登记 | 点完「重新加载并启用扩展」后，已安装扩展会被重新激活，环境不再「干净宿主」；若用例要求纯净环境，在报告里显式登记这一点 |
| 禁止 | ❌ 关闭开发宿主窗口　❌ 重启 VS Code（两者都会断掉 F5 调试会话） |

> ⚠️ 本轮（2026-11-07 冷读实测）已采集**按钮文案与点击结果**；**弹窗正文原文**仍建议首次遇到时截图归档。遇到与上表签名不一致的报错 ⇒ 停下报人并补原文——**不许把新报错当已知噪声放过去**。

## 取证

- 🔴 **agent 的 CU 截图导不出文件**（会话内可见，没有落盘路径）⇒ 可交付证据只认三条：
  1. **会话内可见的截图**——报告里写明「第 N 步截图，见本次会话」，**不许**写成「已截图存档到某路径」；
  2. **日志原文行**（`exthost.log` / 「Memora」频道的原句，带时间戳）；
  3. **窗口枚举结果**（标题列表原文，用于证明「目标项目已加载 / 无残留」）。

  落盘截图只在**人手动截图**时存在：人给了就归档（放 `%TEMP%\memora-real-device-<yyyyMMdd-HHmm>\`，**不写进仓库**），没给就不许虚构文件名。
- 必收三份：

  1. **Extension Host 日志**：输出面板 →「Extension Host」；磁盘位置
     `%APPDATA%\Code\logs\<启动时间戳>\window<N>\exthost\exthost.log`。
     🔴 **`<N>` 别默认取 1**：多窗口时取 `CreationTime` **最接近开发宿主窗口出现时刻**的那个 `window<N>`（以当次实际目录为准；`window1` 往往是主窗口）。

     ```powershell
     Get-ChildItem "$env:APPDATA\Code\logs\<启动时间戳>" -Directory -Filter 'window*' |
       Select-Object Name, CreationTime | Sort-Object CreationTime
     ```
  2. **memora 自身输出**：输出面板 →「Memora」（宿主 `vscode.window.createOutputChannel('Memora')`）。
  3. **落盘证据**（被测项目内 / 用户级）：

     | 路径 | 内容 |
     | --- | --- |
     | `.memora\sessions\<encodeURIComponent(sessionId)>.json` | 每会话一文件：`{sessionId, meta, roundIds, …}` |
     | `.memora\rounds\{roundId}.json` + `index.json` | 轮次正文（物理真源）与派生索引（可重建） |
     | `.memora\memories.db`（另有 `-wal` / `-shm`） | 记忆库（SQLite） |
     | `.memora\attachments\` | 图片等附件 |
     | `%APPDATA%\Code\User\globalStorage\zooique.memora-vscode\{skills,role-packs}` | 用户级技能 / 角色包 |

- **结论写法**：每条 = 「观察点 → 时刻 → 证据（会话语境里的截图 / 日志原文行 / 窗口枚举原文 / 文件路径 + mtime）→ 通过 / 不通过」。
  **「感觉正常」不算通过**；没有证据的观察点一律记「未取证」。

## 硬禁止

- 测试期间**不许改任何代码**让用例通过；发现问题只报告（附复现步骤与证据）。
- 测试期间**不许自己跑门禁 / 构建**（会重写宿主 `dist`，开发宿主打开与重载都读它）；也不许让别的会话跑（见 P2 第 1 条）。
- 不许 `--no-verify`，不许关闸，不许降阈值，不许抬基线。
- 测完**不自动提交、不推送、不发版**。

## 实测事实（2026-11-07 复核；这些配置文件一改本节即过期，引用前先看文件本身）

| 事实 | 实测值 / 位置 |
| --- | --- |
| F5 配置位置 | `hosts\memora-vscode\.vscode\launch.json`（仓库根**无** `.vscode`） |
| 配置名 / 类型 | `Run Extension` / `extensionHost` |
| `args` | `--extensionDevelopmentPath=${workspaceFolder}`、`--disable-extensions` |
| `preLaunchTask` | `${defaultBuildTask}` → `.vscode\tasks.json` 的默认 build 任务 `npm: compile`（即宿主 `npm run compile`） |
| 测试项目指定方式 | **没有** `--folder-uri`，也没有固定工作区路径；实测开发宿主**恢复上次工作区**（本次 `e:\ceshi`，Memora 输出 `projectPath: e:\ceshi`）⇒ 必须核对，不是目标才 Open Folder |
| 宿主进程模型 | 开发宿主是**同一个 `Code.exe` 进程内的新窗口**，`CommandLine` 里**没有** `extensionDevelopmentPath` ⇒ 只能按窗口标题找，按进程找不到 |
| `preLaunchTask` 耗时 | **不写死秒数**：两轮实测 29 秒 / 80 秒都出现过，差数倍 ⇒ 计时一律以当次 `dist\.build-stamp.json` 的 `builtAt` 为准 |
| 弹窗按钮文案（实测） | 「重新加载窗口」/「重新加载并启用扩展」；点击分层：**UIA 元素点击有效**，坐标点击 / `Tab+Enter` 无效 |
| `Reload Window` 后通知 | **仍在**（已知残留，不算失败，须登记） |
| 日志 window 选择 | 取 `CreationTime` 最接近开发宿主窗口出现时刻的 `window<N>`（`window1` 往往是主窗口，别默认取 1） |
| 窗口枚举可靠性 | `Get-Process Code` 的 `MainWindowTitle` 对**基础窗口返回空**（实测 16 个进程全空，而同期确有 2 个带标题窗口）⇒ 空结果 ≠ 无残留 |
| 内核编译 | 根 `npm run build`（不清理）/ `npm run build:clean`（清后建，推荐） |
| 宿主编译 | `npm run compile`（清 dist → tsc → esbuild → 产物加载冒烟） |
| 宿主 watch | `npm run watch` = `tsc -watch -p ./`（**不产 bundle**） |
| 同代校验 | 根 `npm run verify:dist-contract` |
| 构建戳 | `hosts\memora-vscode\dist\.build-stamp.json`（`kernelDistHash` + `builtAt`） |
| 记忆锁 | `<项目>\.memora\.lock`（`{pid, acquiredAt, hostname}`；pid 已死则下次启动自动清理） |
| 会话写锁 | Windows 命名管道 `\\.\pipe\memora-lock-<32 位 hex>`（进程退出即释放，无文件可删） |
