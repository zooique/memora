---
name: memora-host-release
description: "VS Code 宿主插件（hosts/memora-vscode）的发版执行流程：内核先行门禁 → 文档对齐（宿主文档 + CHANGELOG 宿主区）→ 版本号核对（tag vscode@X.Y.Z ↔ 宿主 package.json）→ 台账归档（宿主项）→ 打 tag 触发 host-release.yml（build 内核 dist + 出 vsix + GitHub Release 自动）→ Open VSX / VS Code Marketplace 手动分发。触发场景：用户说『发宿主版 / 宿主发版 / vscode@ 发版 / 插件上架 / 扩展发布』时。"
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
2. **宿主文档去发布态陈述**：`hosts/memora-vscode/` 下随包/上架文档若写了「最新已发布为 X」「Y 待发布」类发布态**值**，改为指向真源（如「以 VS Code Marketplace / Open VSX 上架版本为准」）。
3. `git` 提交文档改动。
> ⚠️ 内核 `release.yml` 有 `verify:changelog` / `verify:publish-docs` 两道 CI 闸；**`host-release.yml` 没有**（gate ③ 只含 format:check / typecheck / lint / 测试 / package）。故 CHANGELOG 日期窗 + 文档发布态**须人工在 tag 前确认**，CI 不会替你拦。

### Step 2：核对版本号（宿主专属三方一致 + 本地预检）
- **三方一致**：`hosts/memora-vscode/package.json` `version` = CHANGELOG 宿主区标题版本 = 即将推送的 tag `vscode@X.Y.Z`。
  - 🔴 **是宿主 `package.json`（`hosts/memora-vscode/`），不是根 `package.json`**（根的是内核版本，宿主发版不动它）。
- **本地预检**（host-release.yml 不替你跑 changelog 闸，须手动在 tag 前跑，避免 tag 推上去才红）：
  - `npm run format:check`（根，prettier）
  - `cd hosts/memora-vscode && npm run typecheck && npm run lint && npm test`
  - CHANGELOG 宿主区日期人工核对（合法日期 + 发布日窗口）
- 任一项失败 ⇒ 修完重跑，勿带伤打 tag。

### Step 3：归档台账（必须在 tag 前提交，状态标「待上架」）
按 `tasks/archive/README.md` 七条纪律（内核技能 `references/archive-discipline.md` 已蒸馏；宿主线规则相同，仅线别 = host）：
1. 复用内核技能的归档脚本（已支持 `--kind`）：
   `node ../memora-kernel-release/scripts/archive-kernel-release.mjs --kind host --version x.y.z --ids ID1,ID2,... --dry-run` 先预览切片，核对逐字节无损后加 `--apply` 落盘。**首次使用须 `git diff` 人工核对**再提交。
2. 脚本产出 `tasks/archive/<x.y.z>-host.md`，迁入主台账 **该宿主版已关闭（✅）项**（内核相关项不在此归档，内核发版单独归档）。
3. 条目 **ID 沿用不改**；主台账原位置留指针行 `→ 见 tasks/archive/<x.y.z>-host.md`。
4. 归档文件头 + 主台账对应区标 **「待上架」**（未真发不写「已发布」；发版跑完再订正）。

### Step 4：发版（打 tag 触发 host-release.yml）
1. 确认 Step 0–3 全部已提交到当前 HEAD。
2. `git tag vscode@x.y.z && git push origin vscode@x.y.z`。
   - ⚠️ 仓库 origin 双推 gitee+github，GitHub 收到 tag 触发 `host-release.yml`；gitee 端无对应 workflow，不重复发。
3. 流水线（详见 `references/host-release-gates.md`）：① tag↔宿主 package.json version → ② 内核已发 npm → ③ format:check → typecheck → lint → 串行 test → build 内核 dist → `pnpm install --offline`（刷宿主镜像，否则测到上一代内核硬链接副本）→ package vsix → GitHub Release 自动挂 asset（`memora-vscode-x.y.z.vsix`，幂等 `--clobber`）。
   - 无 npm 2FA 审批（宿主不发 npm；内核那段已在发内核时批过）。

### Step 5：手动分发（宿主专属，CI 不做）
1. **① GitHub Release**：`host-release.yml` 已自动创建/更新 Release 并挂 `.vsix` asset。核对 Release 存在 + asset 名正确。
2. **② Open VSX**：首次须已在 open-vsx.org 拿到 **namespace ownership** 并手动首发第一版；之后追加 `npx ovsx publish --trusted-publishing`（OIDC 零密钥）。
   - 🔴 **Trusted Publisher 按 workflow 文件名匹配**（`host-release.yml`，非数字 ID）⇒ 本文件**不得改名**（改名须删掉 Open VSX 注册重来）。
3. **③ VS Code Marketplace**：🔒 **定案保持手动上传**（全局 PAT 2026-12-01 退役；稳的 Entra ID 路线需 Azure 订阅 = 国外银行卡拦路石；干净路线 `vsce publish --oidc` 尚未进稳定版且 Marketplace 侧无策略注册 UI）。每版传一次 `.vsix`，成本可忽略 ⇒ 手动最优。

### Step 6：发版后订正
1. 将 Step 3 的「待上架」订正为「已发布」：`tasks/archive/<x.y.z>-host.md` 文件头 + 主台账对应区（归档文件不在 `files` 白名单，订正在 tag 之后不影响已发 `.vsix`）。
2. 核对三市场上架状态：GitHub Release（asset）/ Open VSX / VS Code Marketplace 均可见目标版本。
3. `git show --stat` 核对本次提交文件归属 ↔ 标题（PowerShell 回显中文乱码是显示层，勿据此重提交；字节用 `git log -1 --format=%B | od -c` 校验）。

## 已知坑（对抗式核查清单）
- 🔴 **内核未先行**：宿主 bundle 内联内核 dist，内核未发 npm 会在市场出现「依赖不存在的内核版本」（host-release.yml gate ② 拦，但 tag 前人工跑更省一次 CI 往返）。
- 🔴 **tag 格式**：`vscode@X.Y.Z`，非 `vX.Y.Z`（内核轴）、非 `memora@`（不触发任何链）。
- 🔴 **宿主 package.json 路径**：`hosts/memora-vscode/package.json`，别改根 `package.json`。
- 🔴 **CHANGELOG 双区**：宿主发版只动 `## [Unreleased] · 宿主` 区，内核区（`## [5.0.0] …`）不动。
- 🔴 **host-release.yml 不含 `verify:changelog` / `verify:publish-docs`** ⇒ 须人工跑/核对（内核有、宿主无，这是两链最易踩的差异）。
- 🔴 **Open VSX Trusted Publisher 绑定 workflow 文件名** ⇒ `host-release.yml` 不得改名。
- 🔴 **Windows 上 Bash 跑 git 写操作会污染索引**（曾致 `tasks/` 十余文件被误标删除）——归档/提交/打 tag 用 PowerShell 直接命令或 `node -e`，忌用 Bash 流。

## 验收门槛
GitHub Release 存在 + Open VSX / VS Code Marketplace 上架状态正确 + 归档文件 `tasks/archive/<x.y.z>-host.md` 存在且 ✅ 项全迁、开放项留主台账 + 主台账指针齐全 + CHANGELOG 宿主区无「未发布」+ 门禁全绿 = 完成。
