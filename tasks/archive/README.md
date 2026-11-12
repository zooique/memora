# 归档目录（tasks/archive）

## 归档纪律（2026-10-09 确立 · 用户拍板；2026-10-10 增补单台账收敛）

1. **一发一版，归一次档**：每真发一版（内核 `npm publish` / 宿主 `vsce publish` + tag 跑完）后，把该版**已关闭**项迁入本目录。
2. **内核 / 宿主分离**：文件名 `<version>-<kernel|host>.md`，双线互不混（ADR-033 双轨）。
3. **只迁已关闭项**：主台账（`待完成任务.md`）的开放项、观察项、明确不做项**一律留主台账**；只搬 ✅ 销项 / 证伪关闭 / 全案闭合 的收据，不丢「开放信号」。
   - 🔴 **订正（2026-10-26 · 死锁修复）**：「留主台账」**≠**「留在**版本区**」。观察/挂起项版本未定，按纪律 6 永不随发版归档 ⇒ 留在已发布版本区会让该区**永远清不空**，且已发布区里堆着「还没做的事」本身即口径污染（实证：0.2.0 已发布区曾滞留过半观察项）。**观察/挂起项一律归位主台账顶层 `## 观察 / 待拍板` 区**（2026-10-26 自 5.0.0 内核区 / 宿主 0.2.0 区 / 内核 5.1.0 区整批归位；同日 `ledger:hygiene` 门机检后再补归位一批——条目明细以主台账该区为准），触发后按主台账头部「升档规则」**改状态标记升档**（⏳/👁 → 📌，补完成判据），**不再写「升到某版本区」**——主台账自 2026-10-26 归元后无版本区，条目落点恒为观察区，只有真发版才整批归档。此后「留主台账」= 留**观察区**，版本区只装该版已做的事。
   - 🔴 **删除前置动作（2026-11-11 立 · `LEDGER-ARCHIVE-CONFLICT-1` 定案 C）**：从主台账**删 / 折任一顶层条目**前，先 `grep -rn '<ID>' .` 清算 docs / ADR / 源码注释里的引用，再跑 `npm run ledger:fold`。理由：fold 只判「消失的 ID 在 archive 有无副本」，**不判「还有谁在指着它」**——实证 `KERNEL-6.0.0-BATCH-1` 归档后仍被四份文档当现行真源引用，闸全绿而指针已指空。
4. **版本号以真值为准**：以 `package.json` / `CHANGELOG` / registry 实值为准。条目 **ID 沿用不改**（防跨文档引用断裂），文件头注明「ID → 版本」映射即可。
5. **未真发标「待上架」**：版本已定档但未实际上架时标「待上架」而非「已发布」，发版动作跑完后再订正（实证：0.1.0 宿主曾标「待上架」，2026-10-14 真发后随归档一并订正——例子会过期，判据不会，勿据本表历史状态推论当前版本轴）。
6. **单台账 + 按版本归档（2026-10-10 确立 · 用户拍板，原第 6 条「已完成任务.md 不再逆向重排」随之废止）**：`已完成任务.md` 已整体退役为历史记录（迁入本目录 `completed-history.md`，不再更新）。任务追踪**唯一台账 = `待完成任务.md`**；条目销项后标 ✅ 留原区在册，**每真发一版**时随版本号整区迁入本目录 `<version>-<kernel|host>.md`。销项不即迁、发版才归档；新销项**不再写入**历史合集。
7. **主台账留指针（2026-10-26 归元后形态）**：迁出后**不再逐条留指针**——主台账的「版本索引」区每版只留**一行**（版本 + 发布日期 + 归档链接），条目级溯源一律查归档文件（文件头带 ID 映射与发布收据）。理由：逐条「首行 + 指针」回抄 = 净重复（曾占主台账约 250 行），真正待办的开放项被「做过的事」淹没。**已发版若再有收口动作**（如 Marketplace 手动上传），完成后直接把带日期的收据补进该版归档，不经「下一版区」中转。
8. **收据完整性：漏登的功能永远没有收据（2026-11-01 立 · 用户拍板）**：任何**已落地并随版本发布**的功能 / 修复，都必须在主台账留下一条可追溯的账（登记 → 销项 → 发版归档，链路见纪律 6）。**跳过台账直接做的功能，在本目录里永远不存在**——归档是本仓唯一可查的收据库，缺了这条账，跨版本追溯、回归定位、版本归属核对全部无从查起，而且是**静默**的（没有任何门会红）。
   - **实证（2026-11-01 回源复核）**：宿主侧自定义搜索引擎（`memora.searchEngine` 预设 + 自定义引擎清单）2026-10-13/14 直接落地并随宿主 0.2.0 发布，**从未在主台账登记过**，归档区也无收据——只在 `0.2.0-host.md` 的 `PKG-NEGATIVE-1`「版本归属」旁注里被顺带提一次。补记收据 → [0.2.0-host.md](./0.2.0-host.md) 的 `SEARCH-ENGINE-1`。
   - **补救形态**：按 `SEARCH-ENGINE-1` 的样子补一条完整收据，且**必须写「补记缘由」**（为何漏登 + 线索从哪找到 + 提交可复算命令）。缺这段，读者无从判断这条补记的可信度，补记本身就成了第二类不可信证据。
   - ⚠️ **本条的机检面是空的**：`ledger:hygiene` 只判台账**结构**（区 / ID / 日期 / 体量），`ledger:receipt` 只判「提交 vs 台账同步」且是**告警档**——两者都**区分不了「这次代码改动该不该有账」**。⇒ 本条现阶段靠**代码审查 / 排雷时人工执行**，不得因为「没有门拦」就当它不存在（与 `single-truth-source-mindset.md`「静默失效 = 假阴性」同族）。

## 当前归档

| 文件 | 版本 | 线 | 状态 | 迁出来源 |
| --- | --- | --- | --- | --- |
| `completed-history.md` | （历史合集 · 非版本归档） | 双线 | 已退役（2026-10-10 整体迁入，不再更新） | 原 `tasks/已完成任务.md` 全文（3.0.0 / 3.0.1 及更早批次详表） |
| `4.0.0-kernel.md` | 4.0.0 | 内核 npm | 已发布（2026-10-10 · npm latest） | `待完成任务.md`：SCRIPT-1 / SCRIPT-2 / MEM-1（部分）+ 观察区 5 条闭合收据（READ-DEDUP-REALDEVICE-1 / METRICS-XFLOW-1 / METRICS-BGTASK-1 / METRICS-PREFIX-1 / RESUME-FAIL-FEEDBACK-1）+ 4.0.0 区定案归档整节（2026-10-10 · 分流表 + 原文快照） |
| `5.0.0-kernel.md` | 5.0.0 | 内核 npm | 已发布（2026-10-23 · npm latest = 5.0.0，OIDC staged + 本人 2FA Approve 上架） | `待完成任务.md` 5.0.0 区已关闭 19 条（CHLOG-TRIM-1 / CTX-OCC-1 / CHKPT-1 / CHKPT-2 / CHKPT-3 / CHKPT-4 / TERM-FDBK-1 / LEDGER-RECEIPT-1 / PROMPT-1 / DRIFT-PAUSE-1 / 脚本安全设计固化 / MEM-RECALL-3 / MEM-EVENT-1 / ARCH-GAP-1 / ARCH-GAP-2 / SKILL-CWD-1 / GUARD-SEARCH-1 / SEARCH-QUALITY-1 / ASK-TIMEOUT-1）；开放观察项留主台账 |
| `5.1.0-kernel.md` | 5.1.0 | 内核 npm | ✅ 已发布（2026-10-25 · 按 tag 日；订正原「待上架」；tag `v5.1.0` → `7e200363`，npm `dist-tags.latest` = 5.1.0；上架时刻 2026-10-26 05:03 北京时区） | `待完成任务.md` 内核 5.1.0 区已关闭 3 条（CMD-1-CONTENT / GUARD-WRITE-PROGRESS-1 / IDEM-TASK-TABLE-1）+ 附「切片 0（K1/K2/K3）实施收据」（D1-MCP 的已落地子切片，顶层条目仍留主台账 🔄）；开放 4 条留主台账（D1-MCP / ENV-COV-1 / ㉘ 发版前审计 / SEARCH-DEDUP-1） |
| `5.2.0-kernel.md` | 5.2.0 | 内核 npm | ✅ 已发布（2026-10-29，订正原「待上架」；tag `v5.2.0` → `53dd8399`，npm `dist-tags.latest` = 5.2.0，上架时刻 2026-10-29T11:02:17Z；GitHub Actions run 40860204089 success · OIDC staged + 本人 2FA Approve） | `待完成任务.md` 5.2.0 区已关闭 11 条（RUNTIME-TIER-1 / PUB-SNAPSHOT-1 / PUB-REACHABLE-1 / ONBOARD-MIN-1 / GUIDE-AUDIT-1 / GUIDE-GUARD-1 / FFFD-GUARD-1 / LEDGER-DUP-GUARD-1 / IMG-1 / IMG-3 / REL-REV-1）；观察项（PROV-CAP-1 / ENV-COV-1 等）与内核轴内 4 条宿主面条目（㉘ / CHATVIEW-SLIM-1 / IMG-12 / IMG-13）留主台账待归位 |
| `5.3.0-kernel.md` | 5.3.0 | 内核 npm | ✅ 已发布（2026-10-31，订正原「待上架」；tag `v5.3.0` → `689bb828`，npm `dist-tags.latest` = 5.3.0，上架时刻 2026-10-31T12:29:41Z · OIDC staged + 本人 2FA Approve；Actions run id 本机未验——gh 不可用） | `待完成任务.md` 内核轴已关闭且内核面 3 条（ASK-MULTI-Q-1 / ASK-BATCH-IDENTITY-1 / TURN-EXISTENCE-1，ADR-043/044 收口）；4 条宿主/仓库面条目（ASK-PARTIAL-ANSWER-1 / ASK-STOP-UI-1 / ENV-COV-1 / ENV-PNPM-1）发版前归位宿主轴；基建漏登补登 LEDGER-GATE-2（先例 5.2.0 的 LEDGER-GATE-1）；观察项留主台账 |
| `5.4.0-kernel.md` | 5.4.0 | 内核 npm | ✅ 已发布（2026-11-02 订正原「待上架」；tag `v5.4.0` → `a2ff80e8`，npm `dist-tags.latest` = 5.4.0，上架时刻 2026-11-02T01:59:07.234Z · OIDC staged + 本人 2FA Approve） | `待完成任务.md` 内核轴迁出 4 条已关闭项（SKILL-DISPLAYNAME-1 / DISKWRITE-CUSTOM-1 / BG-ESCALATE-1 / LEDGER-GATE-3）；开放/观察项一律留主台账（DISKWRITE-DEFAULT-1 / WRITECAP-SSOT-1 / GUARD-TEST-PAIR-1 / APISURF-GUARD-1 / DEPRECATE-1）；宿主面条目（SKILL-SLASH-1 / UI-CONFIRM-P13 等）随宿主 0.6.0 归档 |
| `5.5.0-kernel.md` | 5.5.0 | 内核 npm | ✅ 已发布（2026-11-03 · 按 tag 日；订正原「待上架」；tag `v5.5.0` = annotated tag，tag 对象 `61072562` → `002573de`，npm `dist-tags.latest` = 5.5.0，上架时刻 2026-11-03T21:43:43.436Z · OIDC staged + 本人 2FA Approve） | `待完成任务.md` 内核轴迁出 6 条已关闭项（ASSET-PROJECT-SCOPE-1 / ASSET-WRITE-SCOPE-1 / SKILL-REFRESH-1 / ROLEPACK-RELOAD-1 / READONLY-CUSTOM-1 / READONLY-BUILTIN-1）；留守项 = `NOOVERWRITE-WORD-1`（📌 待执行 · 5.5.1 订正；措辞残留的 5 处产物面 + 1 处宿主面已在本版归档「已知残留（措辞面 · 5.5.1 订正）」段登记），其余开放/观察项一律留主台账 |
| `6.0.0-kernel.md` | 6.0.0 | 内核 npm | ✅ 已发布（2026-11-07 · 按 tag 日；订正原「待上架」；tag `v6.0.0` = annotated tag，tag 对象 `6681c2ba` → `56b13b5a`，npm `dist-tags.latest` = 6.0.0，上架时刻 2026-11-07T21:35:18.700Z · OIDC staged + 本人 2FA Approve） | `待完成任务.md` 内核轴迁出 12 条已关闭项（LOOP-1 / T1-TOOL-SELECTION-1 / NOOVERWRITE-WORD-1 / CAP-TRISTATE-1 / SEMVER-GATE-1 / EXPOSURE-GATE-1 / LLM-TOOLSNAPSHOT-1 / ROUND-HISTORY-READONLY-1 / ROUND-IDX-REBUILD-1 / ROUND-ID-COLLIDE-1 / ROUND-CHECKPOINT-1 / ARCHIVER-META-LOCKLESS-1）；开放/观察项一律留主台账（ROUND-IDX-GATE-1 / ROUND-CACHE-NOINVALIDATE-1 / ROUNDSIDX-SHARED-1 / ROUNDS-INDEX-XPROC-1 / HISTORY-BYPASS-1 / READONLY-MODE-1 / READONLY-RUNTIME-1 / UNAVAILABLE-WRITE-HINT-1 / TOOL-ABORT-KILL-1 / SESSION-LOCK-STALE-1 / TEST-PROBE-FALSE-GREEN-1 / MODEL-META-SEMANTIC-1）；未校准项与已知限制见该文件「未校准项与已知限制」段 |
| `7.0.0-kernel.md` | 7.0.0 | 内核 npm | ✅ 已发布（2026-11-10 · tag `v7.0.0` = annotated tag，tag 对象 `8fe9af30` → `5ea960bc`，npm `dist-tags.latest` = 7.0.0，上架时刻 2026-11-10T10:51:53.815Z · OIDC staged + 本人 2FA Approve；首推 tag 曾指向 `f795d623` 触发 release.yml run 42797381075 失败（POSIX-only 红），产品侧修复后重指，run 42801761355 绿） | `待完成任务.md` 内核轴迁出 4 条已关闭项（KERNEL-I18N-CLOSE-1 / LIVE-ROUND-BLOCK-LOST-1 / PREPARE-EVENT-LOST-1 / GATE-LINTSTAGED-NOOP-1）；未搬项与逐条理由见该文件「Step 5 台账清理候选判定」段（DEPRECATE-1 观察态不销项 / 宿主轴 4 条等宿主真发版 / HOST-0.10.0-DEBT-1 未到落态）；已知限制见该文件「已知限制（本版不修，发版后另批）」段 |
| `7.1.0-kernel.md` | 7.1.0 | 内核 npm | ✅ 已发布（2026-11-12 · 按 tag 日；tag `v7.1.0` = annotated tag，tag 对象 `11708fec` → commit `39bb6f8b`；npm 上架由用户确认为「2FA 通过、公开发布」，上架时刻本批次未回源核实 registry） | `待完成任务.md` 内核轴迁出 7 条已关闭项（SUBAGENT-DENY-1 / SUBAGENT-DELEGATE-1 / UNDERSTANDING-CONFIRM-DRIFT-1 / DISKWRITE-DEFAULT-1 / WRITECAP-SSOT-1 / REGISTER-TOOL-DEAD-PROMISE-1 / IMAGE-TOOL-MESSAGE-1）；Step 0.3 发版前审查收据段由发版线另管，本文件手工补建时未随文落盘 |
| `0.3.0-host.md` | 0.3.0 | 宿主 vsce | ✅ 已发布（2026-10-26 · 订正原「待上架」；tag `vscode@0.3.0` → `2f5f19dc`；GitHub Release asset `memora-vscode-0.3.0.vsix` 1,809,494 字节 / 177 条目 / 零夹带；Open VSX 已生效；VS Code Marketplace 手动上传已执行（2026-10-27）） | `待完成任务.md` 内核 5.1.0 区内宿主轴已落地实施收据（小步 §A–§AG 共 32 小节：切片 1/2/3a/3b/4、设置页第 1–16 步、真机验收、Cut2 导入通道、拆域、⑰–㉗、S1 远程 HTTP 传输、提交前审查）+ 2026-10-26 发版收口批（H1–H6 · 出包 → 打 tag → 分发；H6 只迁已完成部分，Marketplace 手动上传留主台账）；各条开放/观察项一律留主台账 |
| `0.4.0-host.md` | 0.4.0 | 宿主 vsce | ✅ 已发布（2026-10-29 订正原「待上架」；tag `vscode@0.4.0` → `1002dcf9`；GitHub Release asset `memora-vscode-0.4.0.vsix` 1,937,155 字节 / sha256 b7013f0397d59c2ee352ccb3a23ee475a211db9f62df1a3bb96ffa6591895e7a / 27 条目 / 零夹带；Open VSX version=0.4.0 已生效；host-release.yml run 40887277966 绿；VS Code Marketplace 手动上传已执行（2026-10-30）） | `待完成任务.md` 宿主 0.4.0 区已关闭 27 条（IMG-2 / IMG-4~13 / IMG-3（宿主面）/ COPY-1 / VERIFY-REVERSECASE-1 / HOST-DATA-DIR-1 / MCP-ATTACH-1 / RESET-OBS-1 / REL-TAG-FIRSTRUN-1 / PKG-NEGATIVE-1 / UI-NARROW-1 / OCC-STALE-1 / CHATVIEW-SLIM-1/2 / TERM-REASON-1 / CAPB-1 / FORMAT-1 / MEMO-BADGE-1）；各条开放/观察项一律留主台账 |
| `0.5.0-host.md` | 0.5.0 | 宿主 vsce | ✅ 已发布（2026-11-01；tag `vscode@0.5.0` → `20e43200`；GitHub Release asset `memora-vscode-0.5.0.vsix` 2,020,850 字节 / sha256 8d024ff1b68973012daabcabd8740cf0502ec79c6c04412a99d61e938de9647e / 28 条目；Open VSX version=0.5.0 已生效（2026-11-01T01:41:40Z · Trusted Publishing）；VS Code Marketplace 手动上传已执行（2026-11-01，上传物 = 同一 asset，解包逐文件对账通过；扩展列表索引 01:59:05Z 已刷新为 0.5.0）） | `待完成任务.md` 宿主轴迁出 28 条已关闭项（SESSION-RESUME-1 / GITIGNORE-UNIFY-1 / ASK 族 / ENV 族 / LEDGER 族 / ACTIONS-SSOT-1 / INTERRUPT-SETTLE-1 / FLOW-ROW-MUT-1 / TERMINUS-SSOT-1 / COPY-2 族 / TEST-ENV-DISPOSE-1 / ICON-REFRESH-SCALE-1 / E2E 族 / HOST-I18N-1 / INTERRUPT-MULTI-1 / DELETE-ANCHOR-1 / REPLAY-EMPTY-INTERRUPT-1）；开放/观察项一律留主台账 |
| `0.6.0-host.md` | 0.6.0 | 宿主 vsce | ✅ 已发布（2026-11-02 订正原「待上架」；tag `vscode@0.6.0` → `b449adec`；GitHub Release asset `memora-vscode-0.6.0.vsix` 2,036,700 字节 / sha256 4918b404…；Open VSX version=0.6.0 已生效（2026-11-02T02:25:52Z）；VS Code Marketplace 手动上传已执行（2026-11-02，上传物 = 同一 asset，未本地重出包）） | `待完成任务.md` 宿主轴迁出 2 条已关闭项（SKILL-SLASH-1 / UI-CONFIRM-P13）；随包内核 5.4.0 的内核面条目（SKILL-DISPLAYNAME-1 / DISKWRITE-CUSTOM-1 等 4 条）已由 `5.4.0-kernel.md` 归档，不在本文件重复登记；宿主轴开放/观察/挂起项一律留主台账（以主台账「宿主轴」区为准） |
| `0.7.0-host.md` | 0.7.0 | 宿主 vsce | ✅ 已发布（2026-11-04；tag `vscode@0.7.0` → `d50ca301`（轻量 tag）；本机产物 `memora-vscode.vsix` 2,115,592 字节 / 232 条目 / sha256 9AF2509B…；GitHub Release asset `memora-vscode-0.7.0.vsix` 2,115,910 字节 / sha256 96E9B717…（与 Open VSX 同一件，逐条目对账见归档）；Open VSX version=0.7.0 已生效（2026-11-04T00:24:20Z · Trusted Publishing）；host-release.yml run 41746181696 success；VS Code Marketplace **已上架**（2026-11-04，依据用户通知 + 独立核验公开页版本列表首项 = 0.7.0；上架时刻未提供）） | `待完成任务.md` 宿主轴迁出 12 条已关闭项（ASSET-TRUST-GATE-1 / ASSET-ZIP-IMPORT-1 / ASSET-COPY-USER-1 / ASSET-PACKAGE-ROOT-1 / MODAL-DUP-CANCEL-1 / SKILL-CREATE-1 / ROLEPACK-CREATE-1 / ROLEPACK-FMTVER-1 / UI-CREATE-PRUNE-1 / UI-INPUT-CTL-1 / UI-STATUS-DIVIDE-1 / UI-CTL-BORDER-1）；留守 `NOOVERWRITE-WORD-1`（📌 待执行 · 随 5.5.1 订正）；随包内核 5.5.0 的内核面条目已由 `5.5.0-kernel.md` 归档，不在此重复；宿主轴开放/观察项一律留主台账 |
| `0.8.0-host.md` | 0.8.0 | 宿主 vsce | ✅ 已发布（2026-11-08；tag `vscode@0.8.0` → `253e63f9`（轻量 tag，删 `b7cfd389` 旧 tag 后重打）；市场 vsix `zooique.memora-vscode-0.8.0.vsix` 2,265,421 字节 / sha256 `c9c8e3dd…` / 261 条目；Open VSX version=0.8.0 已生效（2026-11-08T00:19:51.005562Z；发布路径判定为 `host-release.yml` 自动发布=推断，run 详情本机不可查实——`api.github.com` / `github.com` 连接失败）；VS Code Marketplace 由**用户手动上传**、自述成功（本机 `marketplace.visualstudio.com` 不可达，未查实）；首推 CI 两条 POSIX 用例红 → 修复 `253e63f9` 后重打） | `待完成任务.md` 宿主轴迁出 20 条已关闭项（TEAM-HOTUPDATE-FANOUT-1 / ROLEPACK-SESSION-PERSIST-1 / SESSIONLOCK-TEXT-TRUTH-1 / SESSION-VIEW-BGTASK-1 / ROLE-BADGE-FAKE-1 / FORK-ROLE-INHERIT-1 / PANEL-STATE-CLEANUP-1 / ROLE-FALLBACK-NOTICE-1 / ASSEMBLY-DEPS-DOC-1 / MULTI-SESS-1 / BG-SESS-RUN-1 / AGENTREGISTRY-PREEMPT-1 / PROJECTLOCK-SHARED-1 / ROLEPACK-PERSESSION-1 / BGTASK-DISMISS-CROSSTALK-1 / SESSION-ZOMBIE-CLEANUP-1 / BGTASK-SWITCH-REPUSH-1 / DEADCODE-1 / SETTINGS-AGENT-STALE-1 / CMD-1-KILL）；开放/观察项一律留主台账（`KILLTREE-ESRCH-1` 明确推至内核 6.0.1，不随本版销项） |
| `0.9.0-host.md` | 0.9.0 | 宿主 vsce | ✅ 已发布（2026-11-11；tag `vscode@0.9.0` → `1addd625`（轻量 tag）；`host-release.yml` run `42920762742` = success（19 步全过）；GitHub Release asset `memora-vscode-0.9.0.vsix` 2,531,530 字节 / 非 draft 非 prerelease；Open VSX version=0.9.0 已生效（2026-11-10T23:11:19Z）；VS Code Marketplace 由**用户手工上传并确认上架**（2026-11-11；本仓无机器证据，不写成流水线完成）） | `待完成任务.md` 宿主轴迁出 5 条已关闭项（HOST-I18N-LLM-1 / HOST-I18N-LLM-2 / HOST-VERIFY-NLS-COMMENT-DRIFT-1 / WORK-PROJECTION-MOVE-1 / DEFAULT-ROLEPACK-1）；开放/观察项一律留主台账 |
| `0.1.0-host.md` | 0.1.0 | 宿主 vsce | 已发布（2026-10-14 · Marketplace 上架） | `待完成任务.md`：首批复迁 10 条宿主 ✅ 项（UI-CONFIRM-P10/P10B/P10C/P14/P15、插话「吸收时上屏」、SCROLL-JUMP-1、RELEASE-HOST-0.1.0、LEDGER-SSOT-1、TEST-ENV-TIMEOUT-1）+ 2026-10-14 发布收口批再迁（发布硬闸 ROADMAP-PLUGIN-1·MKT / ·REL / HOST-BUG-2、复盘 ROLEPACK-BODY-1 / ROUND-ANALYTICS-1、打磨残项全部 ✅❌ 闭合项——完整迁入清单见归档文件「2026-10-14 发布收口批迁入」批次引言）+ 2026-10-14 收尾闭合批再迁 3 条（HOST-BUG-1 真机点验通过 / UI-SSOT-2 / UI-HOST-0 终态拍板关闭），UI-ICON-1 移主台账观察区，0.1.0 全线收口 |
| `0.2.0-host.md` | 0.2.0 | 宿主 vsce | 已发布（2026-10-23 · GitHub Release 挂 asset memora-vscode-0.2.0.vsix；Marketplace 手动上传同日执行完毕） | `待完成任务.md` 0.2.0 区已关闭 31 条（HOST-S3-1~3 / MEM-UI-1 / HOST-HIST-PIN-1 / HOST-OBS-2 / HOST-REF-1 / HOST-MENU-1~2 / HOST-CTX-0,1,2,3,5~14,16~18 / DOC-CTX-1 / HOST-NAV-1 / HOST-ATTN-1 / HOST-SPLIT-1 / UI-CONFIRM-FIT-1）；挂起（HOST-ATT-1 / HOST-SEARCH-1 / HOST-PIN-1）、纪律条目（HOST-CTX-15）留主台账（原「待复验 HOST-CTX-4」已于 2026-10-23 整体复验通过，在主台账关账） |
| `0.2.0-host.md`（2026-10-26 补批） | 0.2.0 | 宿主 vsce | 同上（补批不改发布状态） | `ledger:hygiene` 门机检抓出 0.2.0 已发布区滞留 7 条开放态条目 ⇒ **5 条归位**主台账「观察 / 待拍板」区（HOST-I18N-1 / CURSOR-CHANNEL-1 / HOST-S8 / HOST-S10 / HOST-S15，版本未定、触发制）+ **2 条判为已闭合、整块迁入本文件**（HOST-PIN-1：Phase 2 经 D6 预支否决明载「不预建」；GATE-AUDIT-1：2026-10-23 全量盘点实证证伪、结论＝不做），原位留指针行。批次引言见本文件「2026-10-26 补批」节 |

> 注：3.0.0 / 3.0.1 已真发（`registry latest = 3.0.1`），其关闭项已在 `completed-history.md`（原 `已完成任务.md`）按用户约定保留、不入版本归档。

> **例外登记（2026-10-25 · 用户拍板）**：`5.1.0-kernel.md` 的「切片 0 收据」与 `0.3.0-host.md` 全量属**提前迁入**（内核 `v5.1.0` tag 未打、宿主 `package.json` 仍 `0.2.0` 未 bump），**破纪律 3「只迁已关闭项」与纪律 6「发版才归档」**。例外理由：5.1.0 区宿主轴 32 小节收据占主台账净 309 行、开放项被长流水账淹没；迁入判据收紧为「只迁已落地（✅）的实施收据，开放/观察/明确不做项一律留主台账」。**本例外只对这两份文件生效，不构成对纪律 3/6 的修改**——后续版本仍按「销项不即迁、发版才归档」执行。
>
> **例外前提已消除（2026-10-26）**：内核 `v5.1.0` 与宿主 `vscode@0.3.0` 均已真发（上表两行状态已订正「已发布」），两份文件自此属正常归档；本段保留为历史留痕，**当前无生效中的例外**。

## 非版本归档（过时零引用审查报告）· `tasks/archive/reviews/`

> ⚠️ 本区**不**走「一发一版归一次档」纪律，属**文档瘦身**性质归档，与版本收口无关。

- **迁出原因（2026-10-22 批）**：2026-10-22 全量引用扫描确认，该批文档无任何文件反向引用（含自身标题外的外部链接），且内容已过时，属零引用历史审查/方案文档；2026-10-23 批判据不同（零真相链消费但有报告裸名互引），见下方各批次自己的迁出依据。
- **不登记主台账指针**：主台账 `待完成任务.md` 本就未引用这些文件，故迁出后不在主台账留指针（纪律第 7 条「主台账留指针」仅针对版本归档的已关闭项，此处不适用）。
- **非版本信号**：本区归档**不代表任何版本收口**，仅释放仓库噪音（原「5.0.0 尚未发版、npm latest = 4.0.0」为 2026-10-22 归档时点快照，已在 2026-10-23 上架后失效并删去；勿据历史快照推论当前版本轴）。
- **删除拍板（2026-10-23 · 用户）**：原纪律「仅迁移，不删源文件」经用户拍板**整体推翻**——区累计迁入的 **11 份**（10-22 批 6 + 10-23 批 5）已全部 `git rm`，git 历史即档案；区目录保留作后续过时零引用报告的迁入位，将来是否再删按次拍板。

### 已迁入清单（2026-10-22 · 全部已删 2026-10-23）

| 原路径 | 字节 |
| --- | --- |
| `tasks/审查报告-2026-10-07-发版就绪与版本裁定.md` | 7.0K |
| `tasks/审查报告-2026-10-12-UI落地质量审查与设计优化方案.md` | 12.7K |
| `tasks/审查报告-2026-10-19-本会话工作报告核实与落地质量审查.md` | 18.0K |
| `tasks/审查报告-memora-vscode组合评价-20261012.md` | 18.0K |
| docs 下《方案-角色包编辑UI-键面查看与编辑》（2026-10-01） | 9.0K |
| docs 下《审查-CMD1-CMD2落地质量》（2026-10-03） | 15.3K |

### 已迁入清单（2026-10-23 · DOC-GOV 收口下轮候选拍板 · 全部已删 2026-10-23）

- **迁出依据**：`npm run scan:docs:refs:check` 实测无 archive 收据的 9 份 tasks 根目录报告，逐份核入边后分档——本批 5 份**零真相链消费**（入边全为报告互引裸名，零台账 path、零 archive/rules/src 引用），仅报告互引 ⇒ 迁本区。
- **留 tasks 根 4 份（有真相链 path 消费，不迁）**：`审查报告-2026-10-11-宿主UI质量回顾与优化路线.md`（台账 L287 真源指针）、`方案-HOST-CTX-4-二笔git-changes三路径拍板-20261021.md`（台账 L338/L355 拍板材料）、`审查报告-2026-10-15-会话报告核实与落地质量审查.md`（台账 L746 评估真源）、`审查报告-2026-10-11-SSOT审计弧总账.md`（已降指针档，README 规矩 4）。此行即 4 份的留根收据全名（`--check` 据此消音）。
- **不登记主台账指针**：同上批，主台账未引用本批 5 份。

| 原路径 | 字节 |
| --- | --- |
| `tasks/审查报告-2026-10-07-宿主UI风格统一与体验打磨.md` | 11.6K |
| `tasks/审查报告-2026-10-11-WebviewUIDiffusion审计.md` | 5.2K |
| `tasks/审查报告-2026-10-11-WebviewUI审查增量甄别.md` | 9.0K |
| `tasks/审查报告-2026-10-11-WebviewUI排雷推进落地.md` | 4.3K |
| `tasks/审查报告-2026-10-11-宿主UI设计与SSOT审查.md` | 22.3K |

## 台账头部沿革（2026-10-30 自主台账头部迁出 · 历史记录，非现行纪律）

> 迁出理由：台账头部是**每个会话都要读**的第一屏，却堆着 20 行历史沿革
> （分级方式变更 / 归元说明 / 开工闸门已解除 / 第五次整理形态说明）。
> 这些是**已发生的事实**，不是**要执行的指令** ⇒ 留归档可溯，头部只留现行指令 + 登记规范。
> ⚠️ 现行纪律以主台账头部为准；本节仅供溯源，**不得据此执行**。

> 唯一真理源：内核 + VSCode 插件宿主的任务追踪**唯一台账**（单台账机制，
> 2026-10-10 用户拍板）。**销项流程**：条目销项后标 ✅ 留原区在册，**每真发一版**
> 时随版本号**整区迁入** [archive/](./) 对应版本文件。⚠️ **「整区」口径限定**：
> 迁入的**只有该版已销项条目**——开放项 / 观察项 / 明确不做项**一律留本台账**（纪律见
> [archive/README.md](./README.md) §3）；已归并某版本区但**未落地**的条目，
> 发版时按 4.0.0 先例**分流回观察区**，避免「已发版区仍挂开放项」的语义混淆；原 `已完成任务.md` 已整体退役为
> 历史记录 → [archive/completed-history.md](./completed-history.md)
> （更早批次详表已随 2026-09-04 tasks 目录整理删除，git 历史可溯）。
>
> **分级方式变更（2026-09-11，第四次整理）**：由「语义类别」（A 待拍板 /
> B 触发驱动观察 / C 纯观察 /
> D 注记）改为**「版本时点」分级**——问题只有四个去向：**4.0.0（已发版 2026-10-10）/ 4.1.0（内核待定档 → 2026-10-15 取消）→
> 观察（版本未定，触发后升档）→ 明确不做（记录底部）**。不再有 P0/P1 优先级概念，只有「要不要做 + 什么时候做」。编号（G35/ME-8 等）**全部保留**，跨文档引用安全；观察项若想拍板落实，**按上方「升档规则」就地改状态标记**（⏳/👁 → 📌 待执行，**不得再写「提升到某版本区」**——当前无在册未发版区：内核 5.1.0 与宿主 0.3.0 均已于 2026-10-26 发布；已发行版本只在下方「版本索引」留一行、条目级真源在 `archive/`；下一版区开区须先拍板目标轴——**2026-10-27 已拍板：内核攒 5.2.0（不做 5.1.1）；宿主轴同日二次订正：当前待发内容为零（P4 修复与自定义搜索引擎均已随 0.2.0 发布、MCP 接入已随 0.3.0 发布），0.4.0 不预支——下次宿主发版由真功能/真修复触发，版本号届时按内容语义定，PKG-NEGATIVE-1 等开发基建不进安装包、不构成发版理由**，两轴互不阻塞；各自真发版时按升档规则建 archive 文件 + 版本索引加行，**此前不预开区、不预占 CHANGELOG 未发布区**）。
>
> **升档规则（2026-10-27 重写 · 容器→状态，取代「升到某个在册未发版区」的旧口径）**：主台账自 2026-10-26 归元后**不再按版本分区**（已发行版本区已折叠为下方「版本索引」表的一行）⇒ **坐标只认「归档文件 + 条目 ID」，区名不得用作跨文件引用坐标**（2026-10-26 那次折叠把所有以区名定位的行内引用一次性打断，`rules-B2` 险些永久消失）。观察区条目的一生只改**状态标记**、不改落点：⏳/👁 **观察**（版本未定，触发条件写在条目内）→ 📌 **待执行**（已拍板、待人/机落地，**必须写明一行「完成判据：」**）→ ✅ **完成**，随**下一次真发版**整批迁入 `archive/<version>-<kernel|host>.md`，本区不留副本。只有真开新版时才按版本号新建归档文件并在「版本索引」加一行（**开前先拍板目标轴**：内核 npm / 宿主 vsce）。明确不做 → 落「明确不推进」区。
>
> **排序原则**（自上而下 = 时点紧迫度）：**版本索引（已发行版本 → 归档）→ 观察（未定档）→ 注记（防误判）→ 明确不做（防重提）**。
> **双轨规则（S0 对齐 2026-10-01，ADR-033）**：内核条目占 **npm 版本轴**、宿主条目挂 **宿主 vsce 轴**（不占内核版本号，CHANGELOG 双区同构）。两轴**已发行版本与归档链接统一见下方「版本索引」**，此处不再重复枚举（防双写漂移）。
> **开工闸门（2026-10-10 用户拍板）✅ 已解除（2026-10-14）**：宿主 0.1.0 发布前内核区（当时 4.1.0，现 5.0.0）「只登记不落地」的限制随 0.1.0 真发（Marketplace 上架）解除——宿主首版已依赖稳定的内核 4.0.0（已发 npm）发布完毕；本区自此按触发逐条升档落地。
>
> **形态说明（2026-10-05 第五次整理 · 大清洗瘦身）**：4.0.0 区与观察区由 markdown 表格转**列表形态**（`- **ID** — 标题｜状态` + 缩进说明）——表格形态曾被 prettier 按显示宽度对齐填充（存量 93.6% 为填充空格，见 `archive/completed-history.md` 2026-10-05 节），列表根治；md 已全域 ignore prettier，填充不会复发。条目说明保留「一句话实锤 + 触发条件」，长论证 git 历史可溯。

> **2026-11-01 二次迁出（5.3.0 内核 + 0.5.0 宿主发版后清洗 · 原主台账四处历史段）**：
> 迁出理由 —— 四段都是**已发生的事实**，却占着「每会话必读」的位置：三段在台账头部（第一屏），
> 一段夹在宿主轴条目流中段（把列表从中间劈开，且其正文含 `完成判据：` 字样，
> **会污染任何按条目切片扫描的工具** —— 2026-11-01 实测：状态一致性扫描器把 `GOAL-DRIFT-2` 误报为
> 「⏳ 却写了完成判据」，真凶就是夹在它后面的这段规则块）。
> 迁入时只做一件事：跨文件链接的路径基准从 `tasks/` 改为本节所在目录（markdown 链接基准 = 源文件目录），
> 其余原文逐字不改。

> **旧已发版区的未闭合项去向（2026-10-26 · 原主台账「版本索引」区末）**：`MEM-GOV-1` → 观察 / 待拍板 内核轴；
> `MARKETPLACE-0.3.0` 已于 2026-10-27 上架收口（收据 → [0.3.0-host.md](./0.3.0-host.md) H6），该 ID 保留仅为跨文档引用不断链；
> `PHRASE-SCAN-1` / `MCP-SERVER-1` → 同区宿主轴；
> `REL-TAG-AUTO` 的首次实跑验证由宿主 0.3.0 发版触发完成，已在 [0.2.0-host.md](./0.2.0-host.md) 内收口；
> `resources` / `prompts` 原语零接入 → 并入观察区 `D1-MCP` 的未做清单。
> **为什么已发版区不留开放项**：开放项永不随发版归档 ⇒ 留在已发版区会让该区**永远清不空**（归档纪律 3 的 2026-10-26 订正）。

> **观察区来源（2026-10-26 归位迁出 · 原主台账观察区头）**：原散落在已发布版本区的开放/观察项整批归位主台账观察区
> （逐条来源见各条目标题后的「自 … 归位」标注）。
> **为什么迁出**：归档纪律 3「观察项留主台账」不等于「留在**已发布**版本区」——观察项版本未定，按纪律 6 永不随发版归档
> ⇒ 留在已发布区会让该区**永远清不空**（结构性死锁）。迁出后已发行版本只留版本索引一行。

> **2026-10-10 归并说明（原主台账观察区宿主轴中段）**：内核侧遗留任务（含子 agent 落地）已整批升档至内核轴
> （当时 `4.1.0 · 内核`，现 `5.0.0 · 内核`——2026-10-15 取消 4.1.0 后区名随版本轴改）；
> 观察区宿主轴仅留**宿主侧 + 跨轴项**（hosts/memora-vscode 改动、双轴共用规则/文档、已闭合指针等）。

> **折叠结清门的立闸实证（2026-10-27 · 原主台账「版本索引」区）**：`1b30669d` 那次折叠移走 105 条，
> 复盘发现整条「0.3.0 发布前置阻塞项清零收据」**从未落任何归档**（已补迁 0.3.0 归档）；
> `rules-B2` 则是靠人工复读才捞回来的。**教训：把「迁档」做成只删不搬的折叠 ⇒ 事实蒸发且无人知晓。**
> ⇒ 由此立的 `verify-ledger-fold.mjs` 判据是「**移走的**每条都能在归档找到」，不是「留下的每条都还在」。

> **「发版前逐行核对」废止 + 存量复核排日（2026-11-01 · 原主台账观察区头）**：
> 2026-10-15 立的纪律要求「每真发一版的 Go/No-Go 必须设观察项核对节，逐行重读触发条件并把结论写回条目末行」。
> 事实核查：Go/No-Go 文档只在 3.0.0 / 4.0.0 存在过（`deliverables/engineering-assurance/` 两份），
> 两个发版技能的 Step 3 都没有产出该文档的动作 ⇒ **4.0.0 之后 8 个版本 0 次执行**。
> 同一缺口的更早出处是 2026-10-06 审查 G3「观察区无定期复扫节奏」，它给了两条候选（条目补复扫到期日 / 季度复扫批次），
> 10-15 却选了第三条（挂文档）；真正能跑的机检闸是 2026-10-30 的 ⑬⑭（到期复查格式 + 过期即红，已硬挂 `local-ci` full），
> 但它当时**刻意只判新登记**、存量豁免 ⇒ 存量永远不响。
> **2026-11-01 拍板**：废止文档路径，改喂已有的闸——存量按五波补「到期复查」（2026-11-10 / 12-01 / 12-22 / 2027-01-12 / 02-02，
> 每波约 18 条，按台账现有顺序切、不重排），此后 ⑭ 是观察区**唯一**的复核消费机制。
> 同步订正同一挂载点的另两处：`legacy-contract-audit-rules.md` §7.1「挂载节律」改指向台账 `§7-V` 的到期复查；
> `§7-V` 从注记类迁入观察区内核轴（注记类不在 ⑭ 扫描面内 = 义务行放在那儿没有时钟）。
> **教训：把义务挂在一个不存在、或不必然发生的产物上，等于没挂**——与上面折叠闸那条同型（挂载点必须先存在）。

