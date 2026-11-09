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

/** 插话已生效但本轮历史未写入的提示（INTERJECT-PERSIST-1）
 *  🔴 文案**不得**写成「请重发」：插话已在 loop 队列生效（step 边界必注入），
 *  重发会让同一条被注入两次（双执行）。此处只如实告知「历史里没有它」。 */
export const INTERJECT_UNSAVED_NOTICE =
  'Memora：这条补充已生效（本轮会看到），但未能写入历史——本轮记录已不存在，回看历史时不会出现它。无需重发。';

/** 回收站保留期（天）：`memora.cleanupMemories` 命令与设置面板「清理过期」共用的单一真理源，
 *  改保留期只改此处。内核不持定时器，保留期策略归宿主，
 *  且只在用户显式触发清理时生效（无自动清理）。 */
export const MEMORY_RECYCLE_RETENTION_DAYS = 30;

/** 用户级 globalState 键前缀（「初始化」清空判据）：
 *  globalState 是 VS Code **跨扩展共享**存储库，无脑枚举全清会删其他扩展的键
 *  ⇒ 初始化只清本前缀的键。本插件全部 globalState 键（rolePackTeams/
 *  confirmScripts）均带此前缀；新增用户级 globalState 键时自动纳入清空范围，
 *  无需维护第二份清单（SSOT：清空判据从存储真源派生，不手写枚举）。 */
export const USER_STATE_KEY_PREFIX = 'memora.';

/** globalStorageUri 下的用户技能目录名（用户级）：extension 激活期创建、
 *  「初始化」清空目标，三处（创建 / 打开目录 / 清空）共用本常量，禁散落字面量。 */
export const USER_SKILLS_DIR_NAME = 'skills';

/** globalStorageUri 下的用户角色包目录名（用户级）：同上，与技能目录对偶。 */
export const USER_ROLE_PACKS_DIR_NAME = 'role-packs';

/** 用户主输入长度上限（INPUT-LIMIT-1）：在**输入框阶段**以原生 maxLength 截断——
 *  超出部分进不了输入框，用户所见即所发；发送链路不做二次截断（发送时静默砍内容
 *  = 背刺，禁）。主输入框（#input textarea）= 任务指令语义，长档。 */
export const MAX_INPUT_CHARS = 20000;

/** ask/clarify 回答长度上限（INPUT-LIMIT-1）：回答「一个问题」的短语义。
 *  消费点：ask-inline 每题输入框（askInlineView 创建处）+ clarifyBar 兜底输入框。
 *  取 4000 的依据：ask 回答的常见超档场景是粘贴报错/日志，而栈回溯的关键信息
 *  （异常行 / Caused by）在尾部，maxLength 保留头部砍尾部 ⇒ 档位必须容得下单段
 *  日志（4000 字符 ≈ 1000+ token，10 问最坏 ≈ 1 万 token，内核默认窗口（真源 = AGENT_CONSTANTS.DEFAULT_MAX_CONTEXT_TOKENS）仍安全）；
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
