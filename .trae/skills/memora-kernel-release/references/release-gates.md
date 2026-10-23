# 发布门禁与认证（内核发版 Step 4 详解）

> 真源 = `.github/workflows/release.yml`（内核 Release 流水线）。本文件是其针对「发版执行」的提炼，冲突以真源为准。

## 触发

- 推送形如 `vX.Y.Z` 的 tag（如 `v5.0.0`）；触发条件 = `v[0-9]*`。
- 仓库 origin 双推 gitee+github：GitHub 收到 tag 即触发；gitee 端无对应 workflow，不重复发。
- 两轴互斥：内核 `v[0-9]*` 一轴、宿主 `vscode@*` 一轴（宿主误触发内核会被 tag↔version 护栏 fail-closed 拦下，不误发，但留噪音红 run）。

## 流水线步序（release.yml，9 步）

| # | 步 | 命令 / 校验 | 备注 |
|---|---|---|---|
| 1 | 校验 tag ↔ package.json version | `TAG="${GITHUB_REF_NAME#v}"` 必须等于 `package.json` version | **第二道防线**；第一道是 `v[0-9]*` 触发收紧，两道都要 |
| 2 | 校验 CHANGELOG 标题带发布日期 | `scripts/verify-changelog-version.mjs` | 标题须含合法日历日期 + 发布日 ±1 天窗口；**只挂本流程，不进 local-ci**（开发期版本区合法写「未发布」） |
| 3 | 校验随包文档无发布态陈述 | `scripts/verify-publish-docs.mjs` | 从 `package.json` `files` 白名单自动发现 md；CHANGELOG 走上一道专用闸 |
| 4 | 格式检查 | `npm run format:check` | 2026-10-23 补；此前缺此步致 b6bb727a 发布时 format 红未拦 |
| 5 | TypeScript 类型检查 | `npm run typecheck` | `tsc --noEmit` 双配置 |
| 6 | ESLint | `npm run lint` | `--max-warnings 0` |
| 7 | 单元测试（串行） | `npm test -- --no-file-parallelism` | 贴合本地真形态，避 I/O 假红 |
| 8 | 生产构建验证 | `npm run build` | dist 由 `prepack`(build:clean) 在 publish 前自动重建，幂等 |
| 9 | 暂存发布 | `npx -y npm@latest stage publish` | **OIDC 免令牌**；进入 staging，待本人 2FA 审批后才公开 |

> 门禁范围对齐本地：typecheck / lint / 测试 / 构建 / format。本地 `local-ci --preset=full` 的步数**不写死**于技能（门禁自身声明「步数由运行时打印」），以 `scripts/local-ci.mjs` 为唯一真源。

## 认证：npm Trusted Publisher（OIDC，免长期令牌）

- 背景：npm 2026-07-08 公告弃用 2FA-bypass（Automation）长期发布令牌，发布类能力 ~2027-01 失效，官方推荐 OIDC Trusted Publisher。本流程**不用 NPM_TOKEN Secret**。
- 前置（闸门会跑的前提）：必须在 npm 网页把本 workflow 登记为可信发布者——
  `包设置 → Access → Automation → Trusted Publishers → Add Trusted Publisher`
  - Publisher：GitHub Actions
  - Repository：`zooique/memora`
  - **Workflow file name：`release.yml`（只填文件名，不要带 `.github/workflows/` 前缀）**
  - Environment name：（留空，与 workflow 未声明 environment 一致）
  - `@zooique/memora` 已发过 4.0.0，用 package-level 即可；若包尚未存在则需先手动发一版或用 organization-level。
- `permissions: id-token: write` 供 OIDC 向 npm 证明身份（Trusted Publisher 必需）。

## 「允许的行动」怎么勾

- **不勾「允许 npm 发布」** = 走分阶段发布 staged（本流程默认）。npm 页面会提示「不推荐」，那是针对「给 CI 直接发布权的风险」，不是报错。
  - 勾 = CI 可直接 push 版本上架，仓库/CI 一旦被攻破即可投毒，无人拦截。
  - 不勾 = CI 只能 `npm stage publish` 进暂存区，须本人 2FA 审批后才公开。
  - 代价仅「发版后去 npmjs.com 的 Staged Packages 点一次 Approve」。
- 硬前提：npm 账号必须**已启用 2FA**（staged publishing 的前置条件）。
- 若更想一步到位（接受供应链风险）：勾上「允许 npm 发布」并把发布步换回 `npm publish --provenance`。

## 重发同版本（已 staged 不可再 stage）

- npm 规则：已 staged 的版本不可再 stage（staged 与 published 共享同一 semver 命名空间）。
- 重发路径：先在 npm 网页 **Reject** 排队中的版本 → 重打 `vX.Y.Z` 到修复 commit → CI 重跑 → 再 Approve 一次。
- 已 published 的版本**不可重发、不可再 stage**——要出包前务必跑完本地预检（Step 2）。
