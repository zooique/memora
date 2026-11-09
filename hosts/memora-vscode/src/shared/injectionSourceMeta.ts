/**
 * injectionSourceMeta — 注入源的 UI 命名与信封标记（宿主与 webview 共用，零依赖）
 *
 * **为什么独立成文件**：宿主（@ 下拉 / 信封）与 webview（chip / 回执）都要**值导入**它，
 * 而它零依赖 ⇒ 放进 `shared/protocol.ts` 会把协议的运行时常量一并打进 webview bundle
 * （protocol.ts 顶部「值导入不进协议」纪律）；`shared/refKey.ts` 同款先例。
 *
 * **为什么要有单点**：`problems` 的可见名字曾活在 **4 处独立字面量**——@ 下拉
 * label / description（chatPanel）、placeholder 内嵌的同一句 label、chip / 回执短名
 * （chatView）、信封块头（docContext），均无编译器跨模块检查。第一笔落地后已为
 * 「短名双写」（chip 叫 A、回执叫 B）付过一次代价（2026-10-21 合并）；本模块把四处
 * 收敛为**一处登记**——修模式，而非把已修过一次的漂移模式再复制一遍。
 *
 * **分组判据**（两张同源表，不是散面）：
 *   - `INJECTION_SEGMENT_LABELS`（全源）：回执按源归因，`active-file` 也是一源；
 *   - `MOUNTABLE_INJECTION_META`（仅用户可挂载源）：`active-file` 是宿主自动附加
 *     （CTX-3），没有下拉项 / chip / 信封块 ⇒ 不在该表，不给不存在的交互造文案。
 * 加源时两张表都由 `Record<…>` 穷尽性强制补齐——漏一张 = tsc 红，运行期
 * `undefined` 文案比编译期红难发现得多。
 *
 * **只登记已落地的源**（protocol.ts D6：不预建未落地的源）：`git-changes` 已随
 * 第 3.1 笔接线落地追加；`terminal` 待各自拍板落地那笔再追加，勿提前写——给未拍板的
 * 语义发身份证即预支。
 *
 * 守卫面（本模块自 2026-10-21 回填起，新旧值逐字相同、零行为变更）：
 * chatPanelMention 断言下拉 label / description、chatViewInjections 断言 chip note 与
 * 回执短名、docContext 测试断言信封块头 ⇒ 改本模块任一值，预期这些测试红。
 *
 * **本地化口径（B9-E-4 起）**：本模块仍是**零依赖**——UI 字段（段名 / 下拉项 / chip 说明）
 * 的值 = **英文源键**，由**消费侧**过各自本地化器（宿主 `vscode.l10n.t`、webview `l10n.t`）；
 * 在表内写死任一侧的本地化调用都会让另一侧失效（两侧共用本模块，同 `helpers/toolNameMap` 范式）。
 * 键源登记用 `// @nls-keys` 让 verify-nls 判据⑮ 把动态 `t(值)` 的键收进 bundle 键面。
 *
 * `envelope` 是**例外中的红线**：它是持久化数据 + 剥离契约锚点（`stripInjectedContextPrefix`
 * 以闭标签为锚），值一字不改、**不翻译**——Unicode 转义只消源码 CJK，运行期字符串不变。
 */
import type { InjectionSource } from './protocol.js';

/** 用户可挂载的注入源（`active-file` 是宿主自动附加，不在其列；与协议 `add_injection` 同形） */
export type MountableInjectionSource = Exclude<InjectionSource, 'active-file'>;

/**
 * 注入源的显示短名（**唯一真源**：chip 可见名与回执分项名同读这一张表）
 *
 * 各写一套必然出现「chip 叫 A、回执里叫 B」的漂移（2026-10-21 审查合并过一次）。
 */
// @nls-keys
export const INJECTION_SEGMENT_LABELS: Record<InjectionSource, string> = {
  'active-file': 'Current file content',
  problems: 'Workspace diagnostics',
  'git-changes': 'Uncommitted git changes',
};

/**
 * 用户可挂载源的专属字段（@ 下拉关键字项 / chip 说明 / 信封成对标记）
 *
 * 三字段全必填（`Record` 兜底）：漏配任一项 = 该源接线缺一环，tsc 当场红。
 * chip 的**短名不在此表**——它在 `INJECTION_SEGMENT_LABELS`，两表各写一次「工作区诊断」
 * 即同一事实的第二处表达。
 */
export const MOUNTABLE_INJECTION_META: Record<
  MountableInjectionSource,
  {
    /** @ 提及下拉关键字项（恒置顶，不与文件项混排——Roo / Cursor 同款手势） */
    quickPick: { label: string; description: string };
    /** 注入 chip 的 note / title（说明句须与引用 chip 语义相反：内容已注入、占预算） */
    chip: { note: string; title: string };
    /** 信封成对标记（剥离侧 `stripInjectedContextPrefix` 以**闭标签**为锚点） */
    envelope: { open: string; close: string };
  }
> = {
  problems: {
    // @nls-keys
    quickPick: {
      label: 'Diagnostics (Problems panel)',
      description:
        'Inject errors / warnings from the current workspace (latest at send time, uses budget)',
    },
    // @nls-keys
    chip: {
      note: 'Content injected',
      title:
        'Content injected into this turn (not a pointer); latest errors / warnings are taken at send time, uses budget; cleared automatically after sending',
    },
    // 协议信封标记：持久化 + 剥离锚点，值不得翻译（转义只消源码 CJK）
    envelope: {
      open: '[\u5de5\u4f5c\u533a\u8bca\u65ad]',
      close: '[/\u5de5\u4f5c\u533a\u8bca\u65ad]',
    },
  },
  'git-changes': {
    // @nls-keys
    quickPick: {
      label: 'Uncommitted git changes',
      description:
        'Inject uncommitted git changes (read-only status/diff, latest at send time, uses budget)',
    },
    // @nls-keys
    chip: {
      note: 'Content injected',
      title:
        'Content injected into this turn (not a pointer); latest uncommitted changes (read-only status/diff) are taken at send time, uses budget; cleared automatically after sending',
    },
    // 协议信封标记：同上，值不得翻译
    envelope: {
      open: '[git \u672a\u63d0\u4ea4\u6539\u52a8]',
      close: '[/git \u672a\u63d0\u4ea4\u6539\u52a8]',
    },
  },
};
