// VSCode 宿主独立 ESLint 配置
// 根 eslint.config.mjs 排除了 hosts/**，宿主需自建质量门
// 目标：捕获死导入、未使用变量、类型不安全等常见问题
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'prefer-const': 'warn',
      eqeqeq: ['warn', 'always'],
      // 防腐：宿主文件体量红线（HOST-SPLIT-1 第 0 步）。
      // 阈值 1000 **不是本仓新造的数**——同源自 .trae/rules/generic/progressive-refactor-rules.md §1
      // 「软观察阈值 = 文件 > 1000 行」，此处只是把该软阈值机械化成闸门。
      // 口径 = **有效行**（skipBlankLines + skipComments），与内核 eslint.config.mjs 同一口径；
      // 该口径与规则 §1 的「>1000 行软观察阈值」同义——物理行不再是判据，
      // 避免「有效行 / 物理行」两套数并存造成第二判据。
      'max-lines': ['error', { max: 1000, skipBlankLines: true, skipComments: true }],
    },
  },
  // 存量超标清单（HOST-SPLIT-1 第 0 步 · 2026-10-21 闭环为「只降不升」闸）。
  // 集中式配置 ≠ 文件内 disable：清单在配置里可见、可审计、可收敛；
  // ❌ 严禁在超标文件内写 `/* eslint-disable max-lines */`——那会把债务埋进文件、
  //    永久不可见且无人回收（内核侧 agent.ts/loop.ts 走的就是集中豁免，形态对齐）。
  //
  // 两类分野（勿一刀切）：
  // - TARGET/观察 → **按文件具体 max = 基线**：行数只降不升，涨回即 lint 红。
  //   瘦身达标（≤1000）后把该条删掉，回到上一块通用 1000 闸；中途减完一段也可**调低 max**。
  // - DOC/DATA → 维持 off：物理行**不是**这两个文件的债务判据（protocol.ts 71% 是契约注释、
  //   chatStyles.ts 主体是一个模板字符串），给它们套下降闸会逼「削契约注释」凑数 = 造伤。
  //   标注为 DOC/DATA 而非 TARGET，即防误拆。
  //
  // 数字三件套（描述性计数纪律）：
  // - **取数口径 = 本闸门自报**：把该条 max 临时改成 1 跑 `npm run lint`，报错消息
  //   「File has N lines」即该文件基线（与闸门判定同源，杜绝手数/ wc 第二口径）。
  // - 时点：2026-10-31 复测（ACTIONS-SSOT-1 轮级动作真源外置：段级 footer 退役 + 底栏/菜单双面派生，
  //   净减 123 行；取数同上，闸门自报）。
  // - 重算指引：瘦身提交后按上法刷新该条 max 调低；**禁止只更新数字不改行数**（无判据作用的
  //   描述性行数已从注释清除，此处仅留闸门阈值）。
  // ⚠️ 口径迁移（2026-11-14）：本块 TARGET 基线统一改为**有效行**（skipBlankLines + skipComments），
  // 与内核 eslint.config.mjs 对齐；下方历史注释里的旧基线与净减数是**当时物理行口径**的存档，
  // 不再与当前阈值直接可比。阈值按闸门自报的有效行实测值重订（留约 5% 余量），不是抬额度。
  {
    files: ['src/webview/scripts/chatView.ts'], // TARGET（单闭包；计划栏域、历史菜单域、占用域、活动抽屉域、状态条域、过程流单元格域、下拉选择器域、问答回顾行域、工具行动作面域、角色徽章行域、轮级动作底栏域、重放时间线域、技能选择器域、附件行渲染域已外置）
    // REPLAY-EMPTY-INTERRUPT-1（2026-11-01）：空过程事件中断轮渲染（判据/复位/时间兜底/问答行
    // 归位）+ 同轮外置重放时间线交织到 helpers/replayTimeline.ts ⇒ 净减 4（4960→4956）。
    // **当时的动作**：基线按闸门自报下调（不留虚空余量）；**现状**：此后外置使文件变小，
    // 余量已接受，见下方 CHATPANEL-MARGIN-1 说明。
    // SKILL-PICKER-SPLIT-1（2026-11-01）：技能选择器域（选中态 / 菜单渲染 / 搜索 / chip 构建）
    // 整体外置到 scripts/skillPickerView.ts（净减 215），基线按闸门自报同步下调。
    // HOST-I18N-2 C-3（2026-11-09）：提问卡 / 写确认卡两域整体外置为
    // scripts/askInlineView.ts + scripts/writeConfirmCardView.ts（净减 384），
    // 剩余 CJK 文案全量走 l10n.t；基线按闸门自报（max 临时置 1 读数）同步下调。
    // CHATPANEL-MARGIN-1 第一刀（2026-11-11）：附件行渲染域（活动文件 chip / 注入 chip /
    // 引用回复胶囊 + 引用 chip 编排 + 注入回执）整体外置为 scripts/attachmentRowView.ts，
    // 闸门自报 4353 → 4118（净减 235）。**当时的动作**：按要求留出 82 行可用余量
    // （后续 UI 项不再一写就红），基线 = 4118 + 82，仍低于原 4353（只降不升未破）。
    // **现状**：此后外置使文件变小、基线按闸门自报下调后余量仍留着 —— 该余量已接受
    // （不是待清的虚空余量），见 `tasks/archive/0.10.0-host.md` 的 CHATPANEL-MARGIN-1 条目。
    rules: { 'max-lines': ['error', { max: 2600, skipBlankLines: true, skipComments: true }] },
  },
  {
    // FORMAT-1 清零（2026-10-29）：prettier --write 还原折行欠账，物理行 4515→4529（+14 全为
    // 折行展开，AST 结构指纹证明语义零变化）。「只降不升」约束的是代码增长，非格式还原；
    // 基线取闸门自报数如实上调，涨回即红。
    // HOST-SPLIT-1 切片（2026-10-31）：过程事件 / 指标段级合并（mergeMetricsPayload +
    // mergeProcessEvents，两函数原为类内私有、无 this 依赖）整体外置为纯函数模块
    // `helpers/processEventMerge.ts`，三条调用面（step 检查点 / 流尾落盘 / live 重放）共用同一实现。
    // 净减 80 行（语义零变化），基线按闸门自报（max 临时置 1 读数）同步下调。
    // 随后同一批 P4 把 metrics.success 判据切到内核 `isRoundSuccessful`（+4 行 import 注释与
    // 兜底注释），基线再按闸门自报刷新为 4453——相对原 4529 仍净减 76 行。
    // E4 批 4 会话活跃度（+64）撞顶格 ⇒ 顺带外置纯静态 HTML 骨架到 `panels/chatPanelHtml.ts`
    // （零 this / 零运行时状态，与 settingsPanelHtml 同型），净减 210；
    // 基线按闸门自报下调为 4243（**当时的动作**：不留虚空余量）；**现状**：此后外置使文件变小，
    // 余量已接受，见 `tasks/archive/0.10.0-host.md` 的 CHATPANEL-MARGIN-1 条目。
    // BGTASK-SWITCH-REPUSH-1 撞顶格 ⇒ 历史会话列表投影外置 `helpers/sessionList.ts`
    // （store → DTO 纯映射），基线按闸门自报再降为 4242（只降不升）。
    files: ['src/webview/panels/chatPanel.ts'], // TARGET（类体 / 多字段 / 多方法；诊断聚合 + thought 折叠域 + 过程事件合并域 + HTML 骨架 + 会话列表投影已外置）
    rules: { 'max-lines': ['error', { max: 2200, skipBlankLines: true, skipComments: true }] },
  },
  {
    // WORK-PROJECTION-MOVE-1（2026-11-09）：接入第 7 页前先外置三条「读配置 → 推消息」与
    // 自定义引擎清单读写到 helpers/settingsStatusPush.ts（先腾行、后加功能，未抬阈值）；
    // 落完新页接线后闸门自报 2032 ⇒ 基线同步下调（**当时的动作**：不留虚空余量，只降不升）。
    // **现状**：此后外置使文件变小、基线未跟降，余量已接受，见 `tasks/待完成任务.md` 的
    // B10-E-组3 记录（`settingsPanel.ts` 余量不外置的裁决）与 HOST-S15 条目（最新行数）。
    files: ['src/webview/panels/settingsPanel.ts'], // TARGET（七页合一；安全页骨架 / 状态推送已外置）
    rules: { 'max-lines': ['error', { max: 1250, skipBlankLines: true, skipComments: true }] },
  },
  // fileChangeView 的专属 override 已于 2026-11-01 退役：实测 948 行 ≤ 1000 ⇒ 已达「瘦身达标」
  // 退出条件（见本块头部规则 TARGET 条：达标后删该条、回到下方通用 1000 闸）。
  {
    files: ['src/shared/protocol.ts'], // DOC（契约注释型，物理行非判据 → off）
    rules: { 'max-lines': 'off' },
  },
  {
    files: ['src/webview/styles/chatStyles.ts'], // DATA（纯数据模板字符串 → off）
    rules: { 'max-lines': 'off' },
  },
  // 宿主根的构建脚本与配置也在门内——
  // 上一块只匹配 `src/**/*.ts`，而 `esbuild.config.mjs` 恰恰是产出「用户实际运行的
  // dist/extension/extension.js」的那支脚本。门禁边界画在「源码可测性」而非「运行物」，
  // 与内核的 scripts/*.mjs 缺口同根，故同批补齐。
  {
    files: ['*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'prefer-const': 'warn',
      eqeqeq: ['warn', 'always'],
    },
  },
  // 宿主根的 TS 配置（vitest.config.ts）——同理，同样在门内
  {
    files: ['*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: {
      'prefer-const': 'warn',
      eqeqeq: ['warn', 'always'],
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'src/**/__tests__/**'],
  },
];
