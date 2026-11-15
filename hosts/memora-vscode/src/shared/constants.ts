/**
 * 插件共享常量 — extension host 与 webview 面板共用的单个真理源
 *
 * 跨两侧引用的常量（脚本确认开关键等）统一定义于此，两侧直接引用，禁止各自另立副本
 * （即使注释标注"保持同值"也是 stale mirror），消除手工同步的漂移风险。
 */

/** ⚠️ 激活角色包的全局键（`memora.activeRolePack`）已于 2026-11-06（方案 A）退役：
 *  角色包激活改为**会话级**（每会话 Agent 各持 `rolePackManager.activeName`），宿主不再
 *  读/写该键；新会话默认角色来自内核 §4.1 单链兜底包。旧 globalState 残留值无消费面。 */

/** 角色包组（会议名单）的持久化键（vscode globalState）：
 *  组 = 组长角色包 + 组员名单（{leader, members[]}[]），用户级数据（会议名单容器）。
 *  用户在建组/改组成员时写入，Agent 装配时经 AgentOptions.rolePackTeams 注入内核；
 *  运行时修改经 agent.rolePackManager.setRolePackTeams 热更新。 */
export const ROLE_PACK_TEAMS_KEY = 'memora.rolePackTeams';

/** 脚本/代码执行确认开关的持久化键（vscode globalState）：
 *  用户在设置面板开启/关闭时写入，Agent 装配时读取决定是否传 confirmScripts=true，
 *  运行时切换时直接调 agent.security.setConfirmScripts() 热更新。
 *  作用域为用户级（globalState）——安全偏好是用户级设置，跨项目共享。
 *  注意：这是「执行前是否询问」开关，不是脚本能力总开关（run_project_script 始终默认开放）。
 *  ⚠️ 写入二次确认键（memora.confirmWrites）已于 2026-11-06（E4 批 4）退役：
 *  写文件一律直接落盘（前后台一致），宿主不再读/写该键；旧用户 globalState 里的残留值无消费面。 */
export const CONFIRM_SCRIPTS_KEY = 'memora.confirmScripts';

/**
 * 未发送输入草稿在 `workspaceState` 里的键（`Record<sessionId, string>`）
 *
 * 归属**按会话走**：草稿是「那条会话还没发出去的话」，不是全局一坨。**空白草稿页
 * （「＋」后还没有会话 id）不落盘**——它没有归属，存下来会在重启后落到一条无关的新会话上。
 *
 * 两条纪律：① 空文本一律删键，不留垃圾；② 会话被删除时同步 `forget`，否则会随会话数量
 * 无限累积。它不是 `composer_state`（那是「有没有字」的翻转信号），文本只走这条键与
 * `composer_draft` / `composer_draft_restore` 两条消息。
 */
export const UI_COMPOSER_DRAFTS_KEY = 'memora.composerDrafts';

/**
 * 侧栏形态 + 座位绑定（`{ form, seatSessionId }`）在 `workspaceState` 里的键
 *
 * 作用域**故意是工作区级**：形态属于「这个项目窗口怎么开着」。用 globalState 会把 A 项目的
 * 托管形态带到 B 项目（那边没有对应会话，恢复出来是空壳）；也不写 `.memora`——那是项目数据，
 * UI 偏好不该混进去。
 *
 * ⚠️ 只当**种子**：构造期读一次，运行期真源仍是 `assistantFormOps` 的内存值，回写单向发出。
 * 若哪天有人在运行期再读一次本键，那就是第二真相源。
 */
export const UI_FORM_STATE_KEY = 'memora.uiForm';

/**
 * 持久化的形态状态（`UI_FORM_STATE_KEY` 的值形状）
 *
 * 脏数据（缺字段 / 非法 form）一律**整体**回落 `self`，不猜半个值。
 */
export interface PersistedUiFormState {
  /** 关闭时面板所处的形态 */
  form: 'self' | 'assistant';
  /**
   * 助手形态绑定的座位会话 id
   *
   * 空串 = 当时在**托管草稿**里（还没有会话）。恢复时若本字段为空但存在「上次停留会话」，
   * 只有该会话出生来源是 `hosted` 才认它（见 `uiFormPersistence` 的注释）。
   */
  seatSessionId: string;
}

/** 回收站保留期（天）：`memora.cleanupMemories` 命令与设置面板「清理过期」共用的单一真理源，
 *  改保留期只改此处。内核不持定时器，保留期策略归宿主，
 *  且只在用户显式触发清理时生效（无自动清理）。 */
export const MEMORY_RECYCLE_RETENTION_DAYS = 30;

/** 用户级 globalState 键前缀（「初始化」清空判据）：
 *  globalState 是 VS Code **跨扩展共享**存储库，无脑枚举全清会删其他扩展的键
 *  ⇒ 初始化只清 `startsWith(本前缀)` 的键。注意这层关系**只对清空判据成立**：
 *  各键（rolePackTeams / confirmScripts）仍以字面量书写，只是当前都以前缀开头——
 *  改前缀不会自动跟着改键名，新增用户级键时须自己保持该前缀。
 *  清空判据从存储真源派生、不维护第二份枚举清单（SSOT）。 */
export const USER_STATE_KEY_PREFIX = 'memora.';

/** globalStorageUri 下的用户技能目录名（用户级）：extension 激活期创建、
 *  「初始化」清空目标，三处（创建 / 打开目录 / 清空）共用本常量，禁散落字面量。 */
export const USER_SKILLS_DIR_NAME = 'skills';

/** globalStorageUri 下的用户角色包目录名（用户级） */
export const USER_ROLE_PACKS_DIR_NAME = 'role-packs';

/** 用户主输入长度上限（INPUT-LIMIT-1）：在**输入框阶段**以原生 maxLength 截断——
 *  超出部分进不了输入框，用户所见即所发；发送链路不做二次截断（发送时静默砍内容
 *  = 背刺，禁）。主输入框（#input textarea）= 任务指令语义，长档。 */
export const MAX_INPUT_CHARS = 20000;

/** ask/clarify 回答长度上限（INPUT-LIMIT-1）：回答「一个问题」的短语义。
 *  消费点：ask-inline 每题输入框（askInlineView 创建处）+ clarifyBar 兜底输入框。
 *  取 4000 的依据：ask 回答的常见超档场景是粘贴报错/日志，而栈回溯的关键信息
 *  （异常行 / Caused by）在尾部，maxLength 保留头部砍尾部 ⇒ 档位必须容得下单段
 *  日志（4000 字符 ≈ 1000+ token，按提问次数上界估算最坏 ≈ 1 万 token，内核默认窗口（真源 = AGENT_CONSTANTS.DEFAULT_MAX_CONTEXT_TOKENS）仍安全）；
 *  更长的内容语义上属「材料」，应走主输入框或存文件（agent 有读文件工具）。 */
export const MAX_ASK_ANSWER_CHARS = 4000;

/** 运行期待并入插话条数上限（INPUT-LIMIT-1）：**镜像常量**——值真源 = 内核
 *  `LOOP_CONSTANTS.MAX_PENDING_INTERJECTIONS`（loop.interject 达上限整条拒收并返回 false，
 *  extension 侧直接消费内核常量与返回值）。本常量仅供 webview 预检消费（webview 无法
 *  import 内核包），与内核真源的同值关系由 chatPanelInput 守卫测试锁定，改值须两处同步。 */
export const MAX_PENDING_INTERJECTIONS = 5;

/** webview l10n 译文注入元素 id（HOST-I18N-1 P1 基建）：宿主写端（helpers/htmlShell
 *  内联 `<script type="application/json">` 数据块）与 webview 读端（helpers/webviewL10n
 *  启动时 config）共用的跨侧契约键——两侧禁各写字面量：第二份即漂移，且漂移后
 *  读端拿到 null 静默不配置，译文全线回落原文、无任何测试会红。 */
export const L10N_BUNDLE_ELEMENT_ID = 'memora-l10n-bundle';
