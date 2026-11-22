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
 * 会话派发工具名（宿主装配面与 webview 业务受理判据共用的单点真源）
 *
 * 为什么放 shared：`send_to_session` / `create_session` 的**业务受理**要在 webview 侧从
 * `tool_result` 摘要判定（DISPATCH-RECEIPT-1），宿主工具定义也用同一名字——两处各写字面量
 * 必漂移（旧写法靠注释约定「两侧同改」，属 stale mirror）。这里只放名字，不放工具定义。
 *
 * 语义：
 *   - `send_to_session` = 主控把一条输入交给指定会话继续处理；不建会话、不替代目标会话作答；
 *   - `create_session` = 主控开一个会话并让它开始第一轮；走宿主既有新建路径，不另造链路。
 * 工具语义与参数校验见 `extension/host/workSessionTools.ts`。
 */
export const SEND_TO_SESSION_TOOL_NAME = 'send_to_session';
export const CREATE_SESSION_TOOL_NAME = 'create_session';
/**
 * 代答在途提问的工具名（ASK-ANSWER-RECEIPT-1）
 *
 * 与上面两个名字同理：唤醒种子（webview 侧）与工具定义 / 注册（宿主侧）必须共用同一字面量。
 * 真机 2026-11-22：种子只说「解除阻塞」不点名工具，模型两次在正文写「已代答」却没作答，
 * 会话卡住；点名工具后两处不能各写一份，故名字落到本表。
 */
export const ANSWER_SESSION_QUESTION_TOOL_NAME = 'answer_session_question';

/**
 * 未发送输入草稿在 `workspaceState` 里的键（`Record<sessionId | 空白页标记, string>`）
 *
 * 归属**按会话走**：草稿是「那条会话还没发出去的话」，不是全局一坨。空白草稿页
 * （「＋」后还没有会话 id）用固定标记 `DRAFT_PAGE_OWNER`（见 composerDrafts）落盘，
 * **不借用任何 sessionId**——借用会让重启后的旧字落到一条无关会话上。
 *
 * 三条纪律：① 空文本一律删键，不留垃圾；② 会话被删除时同步 `forget`，否则会随会话数量
 * 无限累积；③ 空白页的键在「页面变成真会话」那一刻立即清掉（文本已发出，没有迁移价值）。
 * 它不是 `composer_state`（那是「有没有字」的翻转信号），文本只走这条键与
 * `composer_draft` / `composer_draft_restore` 两条消息。
 */
export const UI_COMPOSER_DRAFTS_KEY = 'memora.composerDrafts';

/**
 * 「上次关闭时停在空白草稿页」的标记（`workspaceState`，布尔）
 *
 * 为什么必须单独记一个布尔：会话停留指针（`lastActiveAt`）只描述**真会话**，空白页没有
 * 会话身份，不写这一位就无法区分「上次停在空白页」与「上次停在真会话」——
 * 前者要回到空白页并把草稿放回；后者绝不能被空白页的草稿抢戏。
 *
 * 写入点只有两个（草稿控制器的 enter / exit）：进空白页写 true，一旦有了会话 id
 * 立即写 undefined（与 `composerDrafts` 清空白页键同一时刻，见面板发送分支）。
 */
export const UI_DRAFT_PAGE_KEY = 'memora.composerDraftPage';

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

/**
 * 内部汇报种子轮的发送者名标记（HOSTED-INTERNAL-SEED-1 · 2026-11-18 真机缺陷）
 *
 * `wakeNoticeTurn`（托管事实送达 → 唤醒接收方主动处置）用 `agent.chat(seedText)` 造的
 * 轮以 `role:'user'` 落盘，重启重放时 `renderReplayRound` 把它当用户输入画成气泡——
 * 用户真机看到"输入区多了一条不是我输入的内容"。按 Claude Code 主流做法，内部注入的
 * 触发指令只进模型上下文、不进用户 timeline，故用本标记让重放跳过该 user 气泡。
 *
 * 落点 = `RoundMessage.name`（既有字段，`RoundView.userMessage.name` 原样透出，实时 / 重放
 * 同一份），零协议 type / 零内核 / 零存储迁移。真正的用户托管输入 senderName =
 * `HOSTED_SENDER_NAME`（'memora宝'），与本值不同，故不误伤。
 *
 * 真源唯一：宿主写端（chatRunControlOps 的 seed）与 webview 读端（chatView 重放）均 import 本常量。
 */
export const INTERNAL_SEED_SENDER = '__internal_settlement_seed__';

/**
 * 助手对外身份名 —— **全仓唯一取值点**（2026-11-20 用户拍板「盖章要叫 memora宝」）
 *
 * 消费面：托管轮落盘 `RoundMessage.name`、实时回声发送者名、装配侧 `orchestratorSenderName`
 * / `agentName`、以及 webview 侧「助手主动开口」的身份标注。任何 UI、任何模块都不得再写
 * 第二份名字字面量（写死一处散文就是第二真相源）。
 *
 * 放在 shared：扩展宿主与 webview 两个 bundle 都要读它（原在 extension/host，webview 无法 import）。
 */
export const HOSTED_SENDER_NAME = 'memora宝';

/**
 * 这条 user 输入的发送者是否为「内部种子」——**「该不该画成用户气泡」的唯一判据**
 *
 * 为什么必须收成一个函数：同一事实有两个展示消费者——实时（`advanceTurnBoundary` 产回声）
 * 与重放（`renderReplayRound` 跳过 user 气泡）。2026-11-20 真机的「内部提示词上屏」正是
 * 因为实时消费者只判了 origin、没继承这条排除判据；两处各写一次 `name === 常量` 迟早再漂。
 *
 * 判据输入用的是**落盘/协议同一份**的 `RoundMessage.name`（实时 seed.name / 重放
 * `RoundView.userMessage.name`），不新增协议字段、不新增内部标记。
 *
 * @param senderName 该条 user 输入的发送者名（缺省 = 普通用户输入，不命中）
 */
export function isInternalSeedSender(senderName: string | undefined): boolean {
  return senderName === INTERNAL_SEED_SENDER;
}
