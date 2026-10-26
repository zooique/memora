/**
 * settingsTabs — 设置面板选项卡的标识、顺序与可见名（宿主面板 / webview / 协议共用，零依赖）
 *
 * **为什么独立成文件**：宿主侧 `settingsPanel.ts` 与 webview 侧 `settingsView.ts` 都要
 * **值导入** tab 表，两侧各自打进不同 bundle；放进 `protocol.ts` 会把协议运行时常量一并
 * 拖进 webview（`shared/injectionSourceMeta.ts` 里的同一理由，protocol.ts 顶部「值导入
 * 不进协议」纪律）。文件本身零依赖，不引入第二层抽象。
 *
 * **为什么要有单点（改前事实，留档防回退）**：这一组标识此前在 **5 处各自抄写**，其中
 * 2 处已漂移：
 *   - `protocol.ts` 的 `settings_switch_tab.tab`
 *   - `settingsView.ts` 的 `SettingsTab` 联合类型
 *   - `settingsPanel.ts` 的 `_pendingTab` 字段类型（**漏 `security`**）
 *   - `settingsPanel.ts` 的 `switchTab()` 形参类型（**漏 `security`**）
 *   - `settingsPanel.ts` buildHtml 的 tab 按钮列表（测试夹具 HTML 又抄了第 6 遍）
 * 漂移的实际后果：`switchTab('security')` 编译不过 ⇒ 安全页无法从任何命令 / 提示跳过去，
 * 也就是说「加 tab」这件事的成本在此之前是「找齐 6 个地方手抄」。
 *
 * ⚠️ **加一页的真实改动面（2026-10-26 L3 审查订正，勿按旧注释估算成本）**：
 * 本文件收口的只是「标识 / 顺序 / 可见名」这一层，漏补两张 `Record` 确实 tsc 红，但
 * **「加一页 = 只改这里」是错的**（旧注释如此声称，实际差 5 处）。完整清单：
 *   ① 本文件：`SETTINGS_TABS` 一行 + `SETTINGS_TAB_LABELS` / `SETTINGS_TAB_ARIA_LABELS`；
 *   ② `webview/panels/settingsPanelHtml.ts` 的 body 骨架表（缺该页 root ⇒ 整页空白）；
 *   ③ `webview/scripts/<新页>View.ts`：新视图文件（`createXxxView`，签名须匹配 `MountFactory`）；
 *   ④ `webview/scripts/settingsView.ts` 的 `SETTINGS_VIEW_MOUNTS` 表一行（顺序 = 初始化时序）；
 *   ⑤ `webview/styles/` 该页样式（按 root 前缀分文件，共享类只许复用不许追加）；
 *   ⑥ `webview/panels/settingsPanel.ts`：`loadXxx` + `handleMessage` 分支 + `refreshAll` 补一行。
 * ①-③ 缺即红（类型 / 运行时异常）；④ 缺亦红（`SETTINGS_VIEW_MOUNTS` 与 `SETTINGS_TABS` 集合
 * 相等由 `settingsView.test.ts` 断言，2026-10-26 由「静默半残」转为可红）；⑤-⑥ 缺则
 * **静默半残**（有按钮无内容），只有真机能发现。
 * 导航侧已无成本：`memora.openSettings(tab)` 收任意 `SettingsTab`，webview 发
 * `open_settings_tab` 即可直达，不必新增命令或映射表（2026-10-26 收口）。
 *
 * **顺序 = UI 顺序**：数组下标决定按钮排列顺序，**下标 0 即默认首页**（右下不应另有一处
 * 写死是谁是首页）。
 */
export const SETTINGS_TABS = ['memory', 'roles', 'config', 'skills', 'mcp', 'security'] as const;

/** 单个选项卡标识（其余各处一律 `import type`，不得再手写联合） */
export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** 默认首页（= 下标 0） */
export const DEFAULT_SETTINGS_TAB: SettingsTab = SETTINGS_TABS[0];

/**
 * 选项卡可见名（`Record` 穷尽：加 tab 忘写按钮文案 ⇒ 编译红，不会出现空白按钮）
 *
 * 同时是 tab 按钮文案与子视图 `aria-label` 的唯一来源（此前按钮写「大模型」、
 * root 的 aria-label 写「大模型配置」两份文案并列）。
 */
export const SETTINGS_TAB_LABELS: Record<SettingsTab, string> = {
  memory: '记忆',
  roles: '角色',
  config: '大模型',
  skills: '技能',
  // 不写作「工具」：用户找不到 MCP 配置 UI 的第一手反馈就是「搜不到 MCP 这个词」，
  // 按钮文案必须是用户会搜的那个词（技能页讲的是插件自带技能，两者混用会再次误导）。
  mcp: 'MCP',
  security: '安全',
};

/**
 * 子视图 panel 的无障碍名（`Record` 穷尽，同 {@link SETTINGS_TAB_LABELS}）
 *
 * **为什么与可见名分成两张表（不是多余的一层）**：重构前两者确实不同源——按钮写
 * 「大模型」，而 config 面板的 `aria-label` 写「大模型配置」。可见名与无障碍名回答的是
 * 两个问题（按钮空间受限 vs 面板语义完整），且在既有代码里已有分歧 ⇒ 收敛为两张表 +
 * 都由编译器强制补齐，而不是把 `config` 的无障碍名悄悄改成短文（那是行为变更，不是重构）。
 */
export const SETTINGS_TAB_ARIA_LABELS: Record<SettingsTab, string> = {
  memory: '记忆',
  roles: '角色',
  config: '大模型配置',
  skills: '技能',
  mcp: 'MCP 工具服务器',
  security: '安全',
};

/** 子视图根容器 id（此前 5 个 id 在 HTML / webview 脚本 / CSS 三处各自硬写） */
export function settingsRootId(tab: SettingsTab): string {
  return `${tab}-root`;
}

/**
 * 收窄 `data-tab` 属性值（`Record<SettingsTab, …>` 查询前的唯一入口）
 *
 * 替代原先 `tab === 'roles' || tab === 'config' || …` 的五路手写判定——那种写法漏一个
 * tab 不报错、只是点了没反应（静默失效）。
 */
export function isSettingsTab(value: unknown): value is SettingsTab {
  return typeof value === 'string' && (SETTINGS_TABS as readonly string[]).includes(value);
}
