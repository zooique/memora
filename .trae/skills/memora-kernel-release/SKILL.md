---
name: memora-kernel-release
description: "内核（@zooique/memora）npm 发版的端到端执行流程：发版前文档对齐（CHANGELOG 日期 + 随包文档去发布态陈述）→ 版本号三方核对 → 台账归档 → 打 tag 触发 release.yml（OIDC 免令牌暂存发布 + 本人 2FA 审批）→ 发版后订正。触发场景：用户说『发内核版 / 走发版流程 / 内核 X.Y.Z 发版 / 内核发布』，或 memora-kernel-release-readiness 确认就绪后要执行发布动作时。"
agent_created: true
---

# 内核发版执行（memora-kernel-release）

> 把 `@zooique/memora` 内核从「就绪」推到「已发布 npm」的端到端执行流程。
> 与 `memora-kernel-release-readiness`（发布前就绪度核查）互补：readiness 管「能不能发」，本技能管「怎么发」。
> 与 `memora-host-release` 互补：本技能管内核 npm 发版（tag `vX.Y.Z`），那个管宿主 marketplace 发版（tag `vscode@X.Y.Z`）；双轴互不复用 workflow（ADR-033）。
> 设计依据：tarball 不可变 + 已发布版本不可重发 ⇒ **tag 是发布动作的唯一不可逆点**；文档/版本/归档须在 tag 前定稿。

## 头号铁律（违反即永久瑕疵）

**tag 是不可逆点，一切须在打 `git tag vX.Y.Z` 前定稿并提交到该 tag 指向的 commit。**
- npm tarball 不可变、已发布版本不可重发。5.0.0 实证：CHANGELOG 标题漏改「未发布」、`待发布` 陈述进随包文档，都随第一版 tarball **永久带伤**（台账 `RELEASE-CHLOG-DATE-1` / `RELEASE-DOCS-STATE-1`）。
- 故：CHANGELOG 日期/内容、随包文档去发布态陈述、版本号、台账归档 —— **全部在 tag 之前提交**。tag 触发 `release.yml` 从该 commit 构建，构建产物即上架物。

## tag 格式真源（已订正；ADR-033 决策 2 偏离注释）

- **内核 tag = `vX.Y.Z`**（如 `v5.0.0`）。内核 `release.yml` 触发条件 = `v[0-9]*`（`v` 后必须紧跟数字，与宿主 `vscode@*` 互斥）。
- ✅ 内核 tag 一律用 `vX.Y.Z`。ADR-033 决策 2 原案写 `memora@X.Y.Z`，已于 2026-10-23 订正为 `vX.Y.Z`（详见 ADR-033 决策 2「偏离原案」注释）；`memora-kernel-release-readiness` 技能末尾「发布动作链」亦同步订正。**`memora@` 不会触发发布链（静默不发版）**，勿再用。
- 宿主 tag = `vscode@X.Y.Z`（另一条 workflow，勿混）。

## 五步法

### Step 0：确认就绪（前置，不重复 readiness）
调用 `memora-kernel-release-readiness` 完成发布前核查：门禁全绿、宿主 dist 同代、测试零失败、变异验证通过、包清单核对。未过就绪度不动本流程。

### Step 1：对齐发版文档到最新版（必须在 tag 前提交）
1. **CHANGELOG.md**：目标版本标题须为 `## [X.Y.Z] · YYYY-MM-DD`（合法日历日期，落在发布日 ±1 天窗口）。删除开发期合法存在的「未发布」「Unreleased」字样（仅该版本区，历史区不动）。
2. **随包文档去发布态陈述**：`files` 白名单内任何 md（含 `docs/memora-api-reference.md` / `docs/memora-接入指南.md`）不得写「最新已发布为 X」「Y 待发布」类发布态**值**。改法 = 指向真源：「最新已发布版本以 npm registry 为准（`npm view @zooique/memora dist-tags.latest`），不在包内复述」。
   - ⚠️ 解释段里**不要引用反例**（如「v5.0.0 待发布」会被 `verify-publish-docs` 命中误伤）——解释出包，只落台账。
   - CHANGELOG 历史区保留，不走此闸。
3. `git` 提交文档改动。

### Step 2：核对版本号（三方一致 + 本地预检）
- **三方一致**：`package.json` `version` = CHANGELOG 标题版本 = 即将推送的 tag `vX.Y.Z`。
- **本地预检**（这些闸只在 `release.yml` 跑、**不进** local-ci/pre-push，故须手动在 tag 前跑，避免 tag 推上去才红）：
  - `npm run verify:changelog`（`scripts/verify-changelog-version.mjs`：标题须含合法日期 + 发布日窗口）
  - `npm run verify:publish-docs`（`scripts/verify-publish-docs.mjs`：随包 md 无发布态陈述）
  - `npm run format:check`（prettier）
  - 另跑 `npm run typecheck` / `npm run lint` / `npm test` 兜底（虽 local-ci 会跑，tag 前确认省一次 CI 往返）。
- 任一项失败 ⇒ 修完重跑，勿带伤打 tag。

### Step 3：归档台账（必须在 tag 前提交，状态标「待上架」）
按 `tasks/archive/README.md` 七条纪律（详见 `references/archive-discipline.md`）：
1. 新建 `tasks/archive/<X.Y.Z>-kernel.md`，迁入主台账 `待完成任务.md` 中**该版已关闭（✅）项**（开放项/观察项/明确不做项留主台账）。
2. 条目 **ID 沿用不改**（防跨文档引用断裂）。
3. 主台账原位置留指针行：`→ 见 tasks/archive/<X.Y.Z>-kernel.md`。
4. 归档文件头 + 主台账对应区标 **「待上架」**（未真发不写「已发布」；发版跑完再订正）。
> 加速：用 `scripts/archive-kernel-release.mjs --version X.Y.Z --ids ID1,ID2,... --dry-run` 先预览切片，核对逐字节无损后去掉 `--dry-run`（即加 `--apply`）落盘。**首次使用须人工 diff 确认**再提交。

### Step 4：发版（打 tag 触发流水线）
1. 确认 Step 1–3 全部已提交到当前 HEAD。
2. `git tag vX.Y.Z && git push origin vX.Y.Z`。
   - ⚠️ 仓库 origin 双推 gitee+github，GitHub 收到 tag 触发 `release.yml`；gitee 端无对应 workflow，不重复发。
   - 数字带口径：`git rev-parse vX.Y.Z` 返回 **annotated tag object** 的 sha（**非** commit）；查 tag 指向哪个 commit 用 `git rev-parse 'vX.Y.Z^{commit}'`。
3. 流水线（`release.yml`，详见 `references/release-gates.md`）：校验 tag↔version → `verify:changelog` → `verify:publish-docs` → `format:check` → typecheck → lint → 串行 test → build → `npx npm@latest stage publish`（**OIDC 免令牌暂存**）。
4. **本人 2FA 审批**：登录 npmjs.com → Staged Packages → Approve（硬前提：npm 账号已启用 2FA；Trusted Publisher 已登记 `release.yml`）。
   - ⚠️ 不要在 npm 勾「允许 npm 发布」= 跳过审批直接上架（供应链风险）；本流程走 staged + 2FA 拦截。

### Step 5：发版后订正（发版跑完才做）
1. 确认 `npm view @zooique/memora version` = `X.Y.Z`、`dist-tags.latest` = `X.Y.Z`。
2. 将 Step 3 的「待上架」订正为「已发布」：`tasks/archive/<X.Y.Z>-kernel.md` 文件头 + 主台账对应区（归档文件不在 `files` 白名单，订正在 tag 之后不影响已发 tarball）。
3. `git show --stat` 核对本次提交文件归属 ↔ 标题（PowerShell 回显中文乱码是显示层，勿据此重提交；字节用 `git log -1 --format=%B | od -c` 校验）。
4. 若需重发同版本：已 staged 版本**不可再 stage**（npm 规则），须先在 npm 网页 Reject 排队中的版本，再重打同 tag 到修复 commit。

## 已知坑（对抗式核查清单）
- 🔴 **Windows 上 Bash 跑 git 写操作会污染索引**（曾致 `tasks/` 十余文件被误标删除）——归档/提交/打 tag 用 PowerShell 直接命令或 `node -e`，忌用 Bash 流。
- 🔴 **`memora@` 漂移**（见上）：内核 tag 用 `vX.Y.Z`，勿照抄 ADR-033 / readiness 技能旧写法。
- 🔴 **已 staged 不可再 stage**：重发同版本前必须 npm 网页 Reject。
- `npx` 子进程无 bash 环境 EXIT=127——发布脚本宁可 `node -e`。
- 宿主更新要锁定 bundle 内核版本 + `verify:dist-contract` 同代（内核先行、宿主跟进；宿主发版走 `host-release.yml`）。

## 验收门槛
`npm latest = X.Y.Z` + 归档文件存在且 ✅ 项全迁、开放项留主台账 + 主台账指针齐全 + 文档无发布态陈述 + 门禁全绿 = 完成。
