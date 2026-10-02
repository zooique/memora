/**
 * 插件共享常量 — extension host 与 webview 面板共用的单个真理源
 *
 * 跨两侧引用的常量（激活角色包键等）统一定义于此，两侧直接引用，禁止各自另立副本
 * （即使注释标注"保持同值"也是 stale mirror），消除手工同步的漂移风险。
 */

/** 激活角色包的持久化键（vscode globalState）：
 *  用户切换角色包时写入，Agent 装配时读取并优先激活，实现"重启后记住用户选择"。
 *  作用域为用户级（globalState），
 *  符合"角色选择是用户偏好，跨项目共享"的语义。 */
export const ACTIVE_ROLE_PACK_KEY = 'memora.activeRolePack';

/** 角色包组（会议名单）的持久化键（vscode globalState）：
 *  组 = 组长角色包 + 组员名单（{leader, members[]}[]），用户级数据（会议名单容器）。
 *  用户在建组/改组成员时写入，Agent 装配时经 AgentOptions.rolePackTeams 注入内核；
 *  运行时修改经 agent.rolePackManager.setRolePackTeams 热更新。 */
export const ROLE_PACK_TEAMS_KEY = 'memora.rolePackTeams';

/** 写入二次确认开关的持久化键（vscode globalState）：
 *  用户在设置面板开启/关闭时写入，Agent 装配时读取决定是否传 confirmWrites=true，
 *  运行时切换时直接调 agent.security.setConfirmWrites() 热更新。
 *  作用域为用户级（globalState）——安全偏好是用户级设置，跨项目共享。 */
export const CONFIRM_WRITES_KEY = 'memora.confirmWrites';

/** 脚本/代码执行确认开关的持久化键（vscode globalState）：
 *  与写入二次确认同模式：用户在设置面板开启/关闭时写入，Agent 装配时读取决定是否传
 *  confirmScripts=true，运行时切换时直接调 agent.security.setConfirmScripts() 热更新。
 *  作用域为用户级（globalState）——安全偏好是用户级设置，跨项目共享。
 *  注意：这是「执行前是否询问」开关，不是脚本能力总开关（run_project_script 始终默认开放）。 */
export const CONFIRM_SCRIPTS_KEY = 'memora.confirmScripts';

/** 回收站保留期（天）：`memora.cleanupMemories` 命令与设置面板「清理过期」共用的单一真理源，
 *  改保留期只改此处。内核不持定时器，保留期策略归宿主，
 *  且只在用户显式触发清理时生效（无自动清理）。 */
export const MEMORY_RECYCLE_RETENTION_DAYS = 30;

/** 用户主输入长度上限（INPUT-LIMIT-1）：在**输入框阶段**以原生 maxLength 截断——
 *  超出部分进不了输入框，用户所见即所发；发送链路不做二次截断（发送时静默砍内容
 *  = 背刺，禁）。主输入框（#input textarea）= 任务指令语义，长档。 */
export const MAX_INPUT_CHARS = 20000;

/** ask/clarify 回答长度上限（INPUT-LIMIT-1）：回答「一个问题」的短语义。
 *  消费点：ask-inline 每题输入框（renderAskInline 创建处）+ clarifyBar 兜底输入框。
 *  取 4000 的依据：ask 回答的常见超档场景是粘贴报错/日志，而栈回溯的关键信息
 *  （异常行 / Caused by）在尾部，maxLength 保留头部砍尾部 ⇒ 档位必须容得下单段
 *  日志（4000 字符 ≈ 1000+ token，10 问最坏 ≈ 1 万 token，120K 窗口仍安全）；
 *  更长的内容语义上属「材料」，应走主输入框或存文件（agent 有读文件工具）。 */
export const MAX_ASK_ANSWER_CHARS = 4000;

/** 运行期待并入插话条数上限（INPUT-LIMIT-1）：**镜像常量**——值真源 = 内核
 *  `LOOP_CONSTANTS.MAX_PENDING_INTERJECTIONS`（loop.interject 达上限整条拒收并返回 false，
 *  extension 侧直接消费内核常量与返回值）。本常量仅供 webview 预检消费（webview 无法
 *  import 内核包），与内核真源的同值关系由 chatPanelInput 守卫测试锁定，改值须两处同步。 */
export const MAX_PENDING_INTERJECTIONS = 5;
