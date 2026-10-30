---
name: memora-host-release
description: "VS Code 宿主插件（hosts/memora-vscode）的发版执行流程：内核先行门禁 → 文档对齐（宿主文档 + CHANGELOG 宿主区）→ 版本号核对（tag vscode@X.Y.Z ↔ 宿主 package.json）→ 台账归档（宿主项）→ 打 tag 触发 host-release.yml（build 内核 dist + 出 vsix + GitHub Release 自动）→ Open VSX / VS Code Marketplace 手动分发 → 市场展示面核对（Changelog 标签 / Resources 链接 / 分类词表 … 版本号可见 ≠ 页面完整）。触发场景：用户说『发宿主版 / 宿主发版 / vscode@ 发版 / 插件上架 / 扩展发布』时。"
agent_created: true
---

# 宿主发版执行（memora-host-release）

> 把 `hosts/memora-vscode` 宿主从「就绪」推到「已上架」的端到端执行流程。
> 与 `memora-kernel-release`（内核 npm 发版）互补：内核管 `npm publish`，宿主管 `vsce` / marketplace；二者 tag 轴不同（内核 `v*`，宿主 `vscode@*`），互不复用 workflow。
> 设计依据同内核：**tag 是发布动作的唯一不可逆点**；文档/版本/归档须在 `git tag vscode@X.Y.Z` 前定稿并提交到该 tag 指向的 commit。

## 头号铁律（违反即永久瑕疵）

**tag 是不可逆点，一切须在打 `git tag vscode@X.Y.Z` 前定稿并提交到该 tag 指向的 commit。**
- 市场拒收「同版本重发」：GitHub Release asset 虽可 `--clobber` 覆盖同名，但 Open VSX / VS Code Marketplace 对**已发布版本号**的重新上传一律拒绝。一旦带伤的 `.vsix` 进了市场，只能 bump 版本号重发（旧版带伤常驻）。
- 故：CHANGELOG 宿主区日期/内容、宿主文档去发布态陈述、版本号、台账归档 —— **全部在 tag 之前提交**。tag 触发 `host-release.yml` 从那个 commit 构建 `.vsix`，构建产物即上架物。

## tag 格式真源（ADR-033 决策 2）

- **宿主 tag = `vscode@X.Y.Z`**（如 `vscode@0.1.0`）。`host-release.yml` 触发条件 = `vscode@*`。
- ⚠️ 宿主 tag 一律用 `vscode@X.Y.Z`。**勿与内核 `vX.Y.Z` 混**（那是内核轴，触发的是 `release.yml`）；**勿用 `memora@`**（既不触发内核也不触发宿主链，静默不发版）。内核 `memora@` 漂移教训见 `memora-kernel-release` 技能「tag 格式真源」段与 ADR-033 决策 2「偏离原案」注释。
- 枚举宿主历史：`git tag -l "vscode@*"`。

## 六步法

### Step 0：内核已先行发布（硬前置，不重复内核流程）
宿主 bundle 由 esbuild **内联**内核 dist ⇒ 产物里带的是本地构建的内核代次。若内核未先发 npm，市场上会出现「宿主依赖一个 npm 上不存在的内核版本」。
- 校验：`npm view @zooique/memora version`（= npm latest）== 本仓库根 `package.json` `version`（即已发内核版本）。
- 不等 ⇒ **终止**，先发内核（打 `vX.Y.Z` tag 走 `memora-kernel-release`），再回来发宿主。
- 这是 `host-release.yml` gate ② 的本地预演；tag 前人工跑一遍，避免推上去才红。

### Step 1：对齐发版文档（必须在 tag 前提交）
1. **CHANGELOG.md 宿主区**（`## [Unreleased] · 宿主（随做随用 · 不占内核版本号）`，含 `### Added（宿主）` / `### Fixed（宿主）`）：目标版本标题改为 `## [x.y.z] · YYYY-MM-DD`（合法日历日期，发布日 ±1 天窗口），删开发期合法存在的「未发布 / Unreleased」字样（**仅该区**，内核区不动）。
2. **内核代次陈述核对**（与 Step 0 查得的 npm latest 对拍，两处）：
   - `hosts/memora-vscode/README.md`「内核」行：`基于 npm 包 @zooique/memora X.Y.Z 开发（本版本内联的内核代次，随宿主版本发布核对）`——版本号必须等于本次内联的内核版本（0.2.0 曾滞后写 4.0.0，2026-10-23 DOC-CTX-1 批次订正）。
   - CHANGELOG 宿主区引言补一句「**随包内核代次 = X.Y.Z**（esbuild 内联 dist）」——宿主 bundle 内联内核，用户对账「这版宿主内置什么内核」须有处可查；这是版本对账文档，不是 README 的重复（README 讲现状、CHANGELOG 讲该版事实）。
3. **宿主文档去发布态陈述**：`hosts/memora-vscode/` 下随包/上架文档若写了「最新已发布为 X」「Y 待发布」类发布态**值**，改为指向真源（如「以 VS Code Marketplace / Open VSX 上架版本为准」）。
4. `git` 提交文档改动。
> ⚠️ 内核 `release.yml` 有 `verify:changelog` / `verify:publish-docs` 两道 CI 闸；**`host-release.yml` 没有**（gate ③ 只含 format:check / typecheck / lint / 测试 / package）。故 CHANGELOG 日期窗 + 文档发布态**须人工在 tag 前确认**，CI 不会替你拦。

### Step 2：核对版本号（宿主专属三方一致 + 本地预检）
- **三方一致**：`hosts/memora-vscode/package.json` `version` = CHANGELOG 宿主区标题版本 = 即将推送的 tag `vscode@X.Y.Z`。
  - 🔴 **是宿主 `package.json`（`hosts/memora-vscode/`），不是根 `package.json`**（根的是内核版本，宿主发版不动它）。
- **本地预检**（host-release.yml 不替你跑 changelog 闸，须手动在 tag 前跑，避免 tag 推上去才红）：
  - `npm run format:check`（根，prettier）
  - `cd hosts/memora-mcp && npm run build`（**测试前置**：`crossHostLayout.test.ts` 跨宿主契约测试加载 mcp 构建产物且有 mtime 守卫（dist 不旧于 src）——新 clone 或 mcp src 变更后必跑，缺它宿主测试必红）
  - `cd hosts/memora-vscode && npm run typecheck && npm run lint && npm test`
  - `cd hosts/memora-vscode && node scripts/gen-changelog.mjs --check && node scripts/verify-package-manifest.mjs`
    （**包内容物闸**：前者验根 CHANGELOG 能抽到 `· 宿主` 区，抽不到即 fail-closed 红；后者真跑 `vsce ls`，断言白名单 + **必含 `CHANGELOG.md`**。生成器没跑 / 被 `.vscodeignore` 排掉都会在这一步红，不必等发布后看市场页才发现标签是空的）
  - CHANGELOG 宿主区日期人工核对（合法日期 + 发布日窗口）
- 任一项失败 ⇒ 修完重跑，勿带伤打 tag。
- ⚠️ **本地全绿 ≠ CI 绿**：本地是 Windows 暖环境（pnpm store 已热、平台 API 走 win32 语义），CI 是 ubuntu 冷环境。平台相关断言只验本机形态的用例要写成 `runIf(平台)` 互斥孪生（见「已知坑」），CI 首跑仍可能红，红了解因再修、修完重打 tag（见 Step 4）。

### Step 3：归档台账（必须在 tag 前提交，状态标「待上架」）
> **规则与执行细节见 `memora-ledger-governance` 技能**（坐标纪律 / 状态字典 / 三道台账门的跑法）；宿主线规则与内核相同，本技能**不复制第二份**，只列宿主特有的调用形式。
> 规则真源 = `tasks/archive/README.md` 七条纪律。内核技能的 `references/archive-discipline.md` **已于 2026-10-27 删除**（其纪律 7 与真源字面相反，git 历史可查），勿从历史版本转抄。
>
> 以下只列**宿主线特有的约束**：

1. 复用内核技能的归档脚本（带 `--kind host`）：
   `node ../memora-kernel-release/scripts/archive-kernel-release.mjs --kind host --version x.y.z --ids ID1,ID2,... --dry-run` 预览 → 逐字节核对 → `--apply`。发现漏扫时，对**已存在**的归档文件必须加 `--append` 补批（禁整体覆盖）。
2. 产出 `tasks/archive/<x.y.z>-host.md`，迁入**该宿主版已关闭（✅）项**（内核相关项不在此归档，由内核发版单独归档）；条目 **ID 沿用不改**。
3. 归档文件头标 **「待上架」**（Step 6 再订正为「已发布」）。
4. **提交前必跑两道台账硬闸**：`npm run verify:ledger-hygiene` + `npm run verify:ledger-fold`。
5. 🔴 **ID 白名单靠人肉编 ⇒ 漏扫是常态**（0.2.0 漏 45 条，欠账 `ARCH-DRAIN-1`；后补 9 条）。兜底 = 上一条的机检门；任何计数以**当场重扫实测**为准，不采信清点快照（快照会算术不闭合 + 随台账编辑漂移）。

### Step 4：发版（打 tag 触发 host-release.yml）
1. 确认 Step 0–3 全部已提交到当前 HEAD。
2. `git tag vscode@x.y.z && git push origin vscode@x.y.z`。
   - ⚠️ 仓库 origin 双推 gitee+github，GitHub 收到 tag 触发 `host-release.yml`；gitee 端无对应 workflow，不重复发。
3. 流水线（详见 `references/host-release-gates.md`）：① tag↔宿主 package.json version → ② 内核已发 npm → ③ format:check → build 内核 dist → build memora-mcp dist（跨宿主契约测试前置）→ 宿主依赖安装 `pnpm install --frozen-lockfile`（重链内核 dist——任何 pnpm install 都会重链 `file:../..`，否则测到上一代内核硬链接副本）→ typecheck → lint → 串行 test → package vsix → GitHub Release 自动挂 asset（`memora-vscode-x.y.z.vsix`，幂等 `--clobber`）。
   - **tag 前可选预演**：`host-release.yml` 带 `workflow_dispatch`（dry-run——门禁全跑到打包为止，不挂 Release，tag 校验自动跳过）。本地全绿后若想提前暴露 CI 冷环境差异，从 main 手动空跑一次再打 tag。
   - 无 npm 2FA 审批（宿主不发 npm；内核那段已在发内核时批过）。
4. 🔴 **CI 红后修 workflow / 测试 ⇒ 旧 tag 作废，删掉重打**：tag 触发的 CI 用 **tag 指向 commit 里的 workflow 文件版本**——改完 push 到 main 后重跑旧 run 用的还是旧 workflow，必须删远端+本地 tag → 在含修复的新 HEAD 重打 → 再推（0.2.0 实证两次：`pnpm install --offline` 冷 store 炸、平台相关用例 ubuntu 红）。

### Step 5：手动分发（宿主专属，CI 不做）

> 🔴 **判据纪律：上架成败只认市场 live 态，不认 run 状态 API、不认页面快照**（2026-10-29 / 10-30 双实证）。
> - **Actions run 状态 API 有快照延迟**：`api.github.com/.../runs/<id>` 的 `status` 长期停在 `in_progress`、`conclusion` 恒 `null`、`updated_at` 冻结在某一刻、不随 step 完成刷新（0.4.0 实证：冻结 14:00:50Z，而末步实际 14:05:21Z 才退出）。据它判「失败」⇒ 会去删 tag 重打，而 Open VSX 同版本不可重发（见 ②）⇒ 灾难。
> - **判成功的两个真信号**：GitHub Release 已建且挂上正确 asset + Open VSX 公开 API `version` 翻到目标版本。二者为真即发布已成功，run 页面随后自会翻绿。
> - **Marketplace 页面有传播延迟**：手动上传后抓扩展页，正文可能仍是上一版 README（0.4.0 实证：页面仍写随包内核 `5.1.0`，而仓库 README 已是 `5.2.0`）⇒ **不可据此判上传失败**。沿用惯例：**版本号以扩展页 Version History 为准，台账不写死版本快照**。

1. **① GitHub Release**：`host-release.yml` 已自动创建/更新 Release 并挂 `.vsix` asset。核对 Release 存在 + asset 名正确（`memora-vscode-<VER>.vsix`）+ **body 结构化齐全**——workflow 注入「随包内核代次 / sha256 / 字节数 / Marketplace 手动上传提示」四项（0.2.0 实证缺口：body 只剩 auto changelog 链接，「随包内核代次」这条对账信息在发布面丢失，只活在 CHANGELOG 里）。
2. **② Open VSX**：✅ **已自动化（2026-10-26）**——`host-release.yml` 末尾两步已带（发布 + 回查），打 `vscode@*` tag 即发；前置（namespace ownership / 手动首发 0.2.0 / Trusted Publisher 登记）均已完成。核对 = 回查步断言 <https://open-vsx.org/api/zooique/memora-vscode> 的 `version` == 本次 tag 版本。
   - 🔴 **发版前必须升 `hosts/memora-vscode/package.json` 的 version**：Open VSX 版本号**永久保留**（删除后仍保留），同版本不可重发 ⇒ 已发的 0.2.0 若重打 tag，门禁与 GitHub Release 都能过、**只有 Open VSX 那步红**。
   - 🔴 **Trusted Publisher 按 workflow 文件名匹配**（`host-release.yml`，非数字 ID）⇒ 本文件**不得改名**（改名须删掉 Open VSX 注册重来）。
3. **③ VS Code Marketplace**：🔒 **定案保持手动上传**（全局 PAT 2026-12-01 退役；稳的 Entra ID 路线需 Azure 订阅 = 国外银行卡拦路石；干净路线 `vsce publish --oidc` 尚未进稳定版且 Marketplace 侧无策略注册 UI）。每版传一次 `.vsix`，成本可忽略 ⇒ 手动最优。
   - 上传物 = **① 的同一个 GitHub Release asset**（下载后直接传），**不本地重出包**——重出包会与上架物 sha256 不一致，直接破坏「Release asset ↔ 市场产物」的对账链。
4. **④ 市场展示面核对（不是只对版本号）** —— 0.4.0 实证缺口：版本号对，但扩展详情页的 **Changelog 标签是空的**，Resources 区**没有报问题入口**。版本号由 Marketplace 的 Version History 自己记，**必然可见**；展示面则全靠包内容物与 `package.json`，不会自愈。逐条扫：

   | 展示面 | 来源 | 核对法 |
   | --- | --- | --- |
   | Changelog 标签 | **包内 `changelog.md`**（不是仓库根 CHANGELOG） | `unzip -l <vsix> \| grep -i changelog` |
   | 详情页正文 | 包内 `readme.md` | `unzip -p <vsix> extension/readme.md \| head` |
   | Resources 四项 | `package.json` 的 `bugs` / `repository` / `homepage` / `license` | 人工一眼：**缺 `bugs` = 用户没有报问题入口** |
   | 分类 / 图标 | `package.json` 的 `categories` / `icon` | `categories` 只能用官方词表内的值（**词表内没有 `AI` / `Chat`**，见下） |

   - **Changelog 生成链真源**：`scripts/gen-changelog.mjs` 从根 `CHANGELOG.md` 抽标题带 `· 宿主` 的区 → 扩展根 `CHANGELOG.md`（**生成物，不入库**，真源永远只有根文件一份）→ `.vscodeignore` 的 `!CHANGELOG.md` 放行 → `vscode:prepublish` 与 `package` 两条路都会重建。
   - ⚠️ **vsce 会把 `CHANGELOG.md` / `README.md` 重命名成小写**（`changelog.md` / `readme.md`）写进 vsix，而 `vsce ls` 清单里仍是大写 —— **两处形态不同是正常的**，别据此判「没打进去」；包清单闸的白名单按大写写才对。
   - **Changelog 标签只能随「含该文件的版本」出现**：已发布版本不可覆盖 ⇒ 空白标签无法补，只有后续版本才有（本条即 0.4.0 的既成事实）。
   - `categories` 官方词表：`Programming Languages` / `Snippets` / `Linters` / `Themes` / `Debuggers` / `Formatters` / `Keymaps` / `SCM Providers` / `Other` / `Extension Packs` / `Language Packs` / `Data Science` / `Machine Learning` / `Visualization` / `Notebooks` / `Education` / `Testing`。填词表外的值 = 市场侧报错或降级，别凭「AI 插件应该选 AI」想当然（本条 2026-10-30 查官方 manifest 文档确认）。

### Step 6：发版后订正
1. 将 Step 3 的「待上架」订正为「已发布」：`tasks/archive/<x.y.z>-host.md` 文件头 + 主台账**版本索引**里该版那一行的状态列（归档文件不在 `files` 白名单，订正在 tag 之后不影响已发 `.vsix`）。
2. 核对三市场上架状态：GitHub Release（asset）/ Open VSX / VS Code Marketplace 均可见目标版本。
3. `git show --stat` 核对本次提交文件归属 ↔ 标题（PowerShell 回显中文乱码是显示层，勿据此重提交；字节用 `git log -1 --format=%B | od -c` 校验）。
4. 🔴 **Marketplace 手动上传完成后，回头订正归档里的「未执行」标记**（0.4.0 实证缺口，且**大概率跨会话**——用户上传往往在发版次日）：
   - Step 6 第 1 条订正为「已发布」时，若 Marketplace 尚未上传，头标会留下一句「**未执行** = VS Code Marketplace 手动上传」。这是**一次性快照，不会自动跟进后续收口**；用户上传完成后须订正 `tasks/archive/<x.y.z>-host.md` 头标 + `tasks/archive/README.md` 归档表该行**两处**，补执行日期与「上传物 = 同一 asset、未本地重出包」。
   - **连带回扫上一版**：该标记从写下到被订正跨越整个发版周期，0.3.0 的同类标记自 2026-10-27 遗留到 2026-10-30 才暴露，且长期与本文件 H6 正文收据**自相矛盾**。订正本版时顺手 grep 前一版归档头 + 归档表，一并清掉同类遗留。
   - ⚠️ grep `未执行` 会命中大量无关语义（「尚未执行」「断言中断未执行」等）⇒ **逐条判语义，严禁批量替换**。
   - 订正提交同样必跑两道台账硬闸（`verify:ledger-hygiene` + `verify:ledger-fold`）。

## 已知坑（对抗式核查清单）
- 🔴 **内核未先行**：宿主 bundle 内联内核 dist，内核未发 npm 会在市场出现「依赖不存在的内核版本」（host-release.yml gate ② 拦，但 tag 前人工跑更省一次 CI 往返）。
- 🔴 **tag 格式**：`vscode@X.Y.Z`，非 `vX.Y.Z`（内核轴）、非 `memora@`（不触发任何链）。
- 🔴 **宿主 package.json 路径**：`hosts/memora-vscode/package.json`，别改根 `package.json`。
- 🔴 **CHANGELOG 双区**：宿主发版只动 `## [Unreleased] · 宿主` 区，内核区（`## [5.0.0] …`）不动。
- 🔴 **host-release.yml 不含 `verify:changelog` / `verify:publish-docs`** ⇒ 须人工跑/核对（内核有、宿主无，这是两链最易踩的差异）。
- 🔴 **Open VSX Trusted Publisher 绑定 workflow 文件名** ⇒ `host-release.yml` 不得改名。
- 🔴 **Windows 上 Bash 跑 git 写操作会污染索引**（曾致 `tasks/` 十余文件被误标删除）——归档/提交/打 tag 用 PowerShell 直接命令或 `node -e`，忌用 Bash 流。push 走 Bash `env -u NODE_OPTIONS LEFTHOOK=0`（PowerShell 进程树拦 credential-manager ⇒ 网络 git 操作静默 EXIT=128）。
- 🔴 **CI 冷 store 勿用 `--offline`**（0.2.0 首跑实证，run 39889566947）：根与宿主是两个独立 pnpm 工程（无 workspace），CI 只装了根依赖；宿主 lockfile 239 包中 ~187 个根没有（vsce/@vscode 系）⇒ 冷 store offline 解析必炸。workflow 安装步已定 `--frozen-lockfile`，**勿改回 `--offline`**；本地 store 已暖，本地跑 `--offline` 仍可。
- 🔴 **平台相关 API 的断言写 `runIf(平台)` 互斥孪生**（0.2.0 二跑实证，run 39890131524）：`path.relative` / findFiles `fsPath` 等语义随 OS 变，反斜杠形态只在 Windows 运行时出现，ubuntu 上喂 Windows 路径必错。win32 用例 `runIf(process.platform === 'win32')` + POSIX 孪生 `runIf(!win32)` 各跑真实形态——**不产生隐藏 skip**，任一平台都有在跑的用例。
- 🔴 **跨宿主契约测试的前置是 memora-mcp dist**：`crossHostLayout.test.ts` 加载 `hosts/memora-mcp/dist` 产物（非源码）且有 mtime 守卫。workflow 已带构建步（mcp 无 lockfile ⇒ `--no-frozen-lockfile`，mcp 出包补 lockfile 后收紧为 frozen）；本地新 clone 同样先 build mcp。
- 🔴 **归档白名单靠人肉编 ⇒ 漏扫是常态**（0.2.0 漏 45 条，欠账 `ARCH-DRAIN-1`；4.0.0 前的 copy 式归档在主台账留过无指针原文）。兜底 = Step 3 第 4 条的两道机检门，`local-ci` full 档会强制跑；任何计数以**当场重扫实测**为准，不采信清点快照（快照会算术不闭合 + 随台账编辑漂移）。
- 🔴 **判 CI 成败别信 run 状态 API**（快照延迟：`status` 恒 `in_progress` / `conclusion` 恒 `null`）⇒ 误判会诱导「删 tag 重打」，而 Open VSX 同版本不可重发 ⇒ 只能 bump 版本号。判据与传播延迟容忍见 **Step 5 判据纪律**。
- 🔴 **`.vscodeignore` 的 `*.md` 会静默吃掉市场展示文件**：CHANGELOG / SUPPORT 都落在 `*.md` 覆盖范围内，只放行 README 就会让 Changelog 标签空白。0.4.0 实测：vsix 根目录只有 `readme.md`；社区同族实证写着「Restored Changelog tab by re-including CHANGELOG.md in packaged VSIX」。**放行清单与 `verify-package-manifest.mjs` 的必需文件清单必须同源改**——改一处漏一处 = 静默缺失，且不报错。
- 🔴 **市场核对只对版本号 = 漏掉整个展示面**：版本号进 Version History 是 Marketplace 自己记的，必然绿；而 Changelog / Resources 链接来自包内容物与 `package.json`，**不会自愈**。Step 5 ④ 四项逐条过，别用「版本能搜到」代替「页面完整」。

## 验收门槛
GitHub Release 存在 + body 含随包内核代次与 sha256 + Open VSX / VS Code Marketplace 上架状态正确 + 归档文件 `tasks/archive/<x.y.z>-host.md` 存在且 ✅ 项全迁、开放项留主台账 + 主台账指针齐全 + CHANGELOG 宿主区无「未发布」且引言注明随包内核代次 + README 内核行 = 本次内联内核版本 + 门禁全绿 = 完成。

**外加市场展示面**（0.4.0 缺口的补丁，缺一不算完成）：`.vsix` 内含 `readme.md` **与 `changelog.md`**（`unzip -l` 实证）+ 市场页 Changelog 标签有正文、Resources 区有 Issues 链接（`bugs`）+ 分类在官方词表内。
