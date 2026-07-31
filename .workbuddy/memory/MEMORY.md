# 项目长期记忆（memora）

## 架构与质量基线
- 内核 `src/`（零 native/第三方依赖，仅暴露 `"."` 子路径，不可深导入）；桌面端 `hosts/memora-sprite/`（Electron 40 + electron-builder 26，当前 sprite 版本 1.5.0，渲染 `appVersion` 走 `package.json` 而非 `process.versions.electron`）。内核经 `scripts/sync-memora.mjs` 以 cpSync 覆盖同步进 `node_modules/memora` 并打进 asar——**内核随客户端打包冻结，运行期不单独更新**。
- 真实质量门 = `tsc --noEmit` + `eslint` + `lint:css`(stylelint) + vitest；prettier --check 非门（勿批量 write 制造无关 diff）。

## 设计令牌（ADR）
- 三层 scope：L1 foundation/ 全局基础 · L2 面板前缀 · L3 组件；BEM；单文件单真理源。
- 双主题：`:root` 浅 / `[data-theme="dark"]` 深；颜色/阴影/z-index 100% token 化。
- 控件收口：`.card`、按钮、`.input`/`.input--pill`/`.input-with-action`、标签均在 `foundation/controls.css`（L1 单一真理源）。

## 样式审计方法论（可复用，避免误报）
- 统计硬编码色须排除 `tokens.css` 定义值：先 `var_re.sub('','text')` 去 `var(...)`(含 fallback)，遍历跳过 `foundation/tokens.css`，否则把定义值误计为泄露。
- stylelint 插件 `stylelint-value-no-unknown-custom-properties`@6 **不跨 glob 聚合 `:root`**：跨文件 token 必须用 `importFrom` 绝对路径（`.mjs` 用 `fileURLToPath`）。整目录 glob 会误报合法 token（曾 3260 条）。验证守卫须注入幻影 token 确认能抓到（防假绿）。注：npm 无 `@csstools/` 作用域包，注册名是 `csstools/value-no-unknown-custom-properties`。
- CSS 批量迁移脚本必须保留 `/* */` 注释定界符：按 `/*` 切分，注释段原样保留，仅对 code 段替换，跨行维护 in_comment 状态。

## sprite 测试与集成模式（可复用）
- `inputAreaManager.test.ts` 的 QuickInputCompletion mock 是字面量对象，补全类新增公开方法须手动补进 mock 工厂，否则 TypeError。Vitest 走 esbuild 不做 type-check：抽象类仅 `export type` 时注入桩用 `implements X`（剥离 `extends`+`super()`）+ 补 readonly 成员。
- 内核未导出 Manager（ProjectManager/UserProfile/DedupManager/WorkProjectionManager）只能经真实 `Agent` 实例驱动（getter 返 `|null` 用 `!` 断言），不可直接 `new`。
- 集成测试接真实实例时易暴露宿主层 Bug（如 SqliteStorage.upsert 展开 `Memory` 含 `metadata` 致 `Unknown named parameter`）——upsert 须显式绑定已知列、忽略 metadata。
- **双写不同步判据**：JSON 配置某字段恰等于默认值但其他字段是真实用户值 → 必有一路径部分写入（读合并）、另一路径完整写入（内存快照）覆盖前者。统一走单一写入入口（如 sprite.updateConfig）。

## 代码孤儿/死导出分析（可复用）
- 遍历 `src/**/*.ts` 建「模块→引用」「符→import」图，排除入口（main/cli/renderer/server/preload*/index 桶）。
- 坑：NodeNext 显式 `.js` 扩展名须 `replace(/\.(js|ts|mjs|cjs)$/,'')` 再 resolve；Electron 多入口（preload.cjs / HTML script / preloadWeb esbuild / type barrel）须手工核对；类型导出删除一律人工确认（误报率高）。真死导出铁律：导出值且全仓（含 __tests__）零词边界引用。

## 感知/通知架构约定
- 分级通知 `priority: normal|high|critical`：high 绕过节奏抑制，critical 绕过节奏+冷却。里程碑/健康警告→high。
- 可选接口方法向后兼容：`setErrorCallback?(cb)`，调用方 `if(x.setErrorCallback)` 检测后调用。
- 配置损坏保护：catch 内先 `rename` 备份 `.corrupted.{timestamp}` 再返默认，区分 ENOENT(首次) 与解析错误(损坏)。
- vi.mock 工厂须覆盖所有被 import 的函数，新增 import 须同步补 mock，否则运行期 `undefined` TypeError。

## HEAL-16 UIManager 渐进重构
- 协调器模式（Perception/Chat/Memory/Settings）已落地：委托群改经协调器转发，ui.ts 字段 ~29→~25。
- 教训：提取协调器后须同步更新委托测试断言路径（mock.X→mock.coordinator.X），否则深 Proxy mock 记在协调器路径、断言查旧路径→全 "0 calls" 误报。协调器初始化须前置到 panel.init() 之前。

## 发布/分发约定（闭源桌面端）
- 主仓 Gitee，已配 **Gitee→GitHub 私有 push 镜像**（代码+tags 自动同步，作备份；**必须保持 private**，否则同步上去的源码泄露破闭源）。
- **CI 全自动发版**：`build.yml` 监听 `v*` tag（经镜像同步到 GitHub）→ **仅 Windows** 构建（`electron-builder --win`）→ `Publish Release` job 用 secret `RELEASE_TOKEN`（细粒度 PAT，仅授权公开仓 `memora-sprite-releases` 的 Contents:write）自动在公开仓建 Release+传 exe。开发者零手动建 Release。
- exe 分发 + 版本检测走 **GitHub Releases（独立公开发布仓 `memora-sprite-releases`，只放 exe 不含源码）**：GitHub 单文件 <2GiB 限额对 ~130MB 充裕；公开仓 `GET /repos/{o}/{r}/releases/latest` **免鉴权**（匿名限速 60 次/小时/IP，按钮点击足够），客户端检测不必内嵌 token。
- 客户端检查用 `fetch` + `User-Agent` 头，取 `tag_name` 数值比较、`html_url` 打开发布页。
- 版本：宿主 `memora-sprite` 当前 `1.4.0`、内核 `@zooique/memora` `2.0.2`，**独立维护**——发版只升宿主版本（如 1.4.0→1.5.0），内核无需同步升号。
- ⚠️ **内核同步铁律**：sprite 不通过 `file:` 依赖内核（避免 Junction 把全仓打进 asar）；`scripts/sync-memora.mjs` 把内核 `dist/`+`package.json`+`LICENSE`+`README.md` cpSync 进 `hosts/memora-sprite/node_modules/memora/`。**改内核源码后必须 `npm run sync-memora`（编译+同步）再打包**，否则 exe 含旧内核（`node_modules/memora/dist/` 是独立副本）。
- 内核打进 asar 随客户端冻结，"改内核免重装"对终端用户不成立（仅开发者发版流程成立）。
- CI 构建在私有镜像仓跑，消耗私有仓 Actions 分钟（Free 2000/月，仅 Windows 余量足）；`RELEASE_TOKEN` 须最小权限、只存 Actions secret。
- 国内加速备选：COS/OSS/R2 另放 exe 直链作「国内高速下载」（非必须）。
- 详见 `tasks/发布流程-gitee-20260722.md` §1/§4/§5 + `tasks/归档/STEP-发版前置-PRIVACY与更新检查.md`。

## Git 操作安全红线（2026-07-31 血训）
- **禁止从 Bash 执行 git 写操作**（`git mv`/`git rm`/`git restore`/`git checkout --`）。Bash 工具运行在 POSIX 沙箱，其文件系统视图与 Windows 真实 FS 不同步——已两度导致 `tasks/` 中 11 个文件被沙箱视为"已删除"，污染 git 索引并触发用户的误报与恐慌。
- **文件状态以 Read/Glob 工具（Windows API）为准**。Bash `ls` 与 Read/Glob 矛盾时：采信 Read/Glob，立即停止所有 Bash 操作。
- **git 命令改用 PowerShell**：`Get-ChildItem`/`git mv`/`git rm`/`git status` 等走真实 Windows FS，不经 POSIX 沙箱挂载层。
- **阶段完成后立即 `git add -A && git commit`**。不攒暂存改动。已提交的 HEAD 才是可恢复锚点；沙箱异常下暂存区不可靠。
- **不可逆操作前双重核验**：移动/删除文件前，先用 Read/Glob 确认源和目标均存在，不做任何"看起来应该存在"的假设。
