/**
 * 会话工具 · 主控装配面（托管模式 v0）
 *
 * 职责（只做主控会话的工具面）：
 *   - 装配层判定「这个 Agent 是主控」时，为它注册九个工具：`list_work_sessions` /
 *     `send_to_session` / `create_session` / `stop_work_session` / `pause_work_session` /
 *     `resume_work_session` / `answer_session_question` / `list_role_packs` /
 *     `read_memory_summary`（后两者只读；回调缺项时对应工具不注册）；
 *   - 普通会话不注册 ⇒ 模型侧「工具不存在」，不是「调用报错」。
 *
 * 边界（刻意如此，勿扩）：
 *   - 三个业务工具都只做参数校验 + 调注入回调；**不持有面板实例**，也不读编辑器 / problems / git。
 *   - 会话数据来源 = 注入的 `ISessionStore.listSessionMetas()`（宿主已有的会话元数据真源）；
 *     角色包来源 = 注入的 `listRolePacks`（装配期从内核 `RolePackManager.listMeta()` 单点取，
 *     不另建列表、不加缓存）。
 *   - 嵌套开会话由工具面缺席挡住：只有用户亲自选择的托管会话按 `managed` 装配并拿到本文件
 *     的工具集；代理开出的子会话按 `self` 装配（出生来源仍记 `hosted`），它没有这组工具，
 *     不需要关系表 / `E_LIMIT` / 深度闸 / 父字段 / 层级树（这些已被明确砍掉，不要复活）。
 *   - 主控身份**不落盘、不进 `SessionMeta`**：`SessionMeta.mode` 已作废。
 */
import type { Agent, ISessionStore, Memory, SessionMeta, ToolDefinition } from '@zooique/memora';
import { getSessionDisplayName } from '@zooique/memora';
import {
  projectCreatedBy,
  resolveListCoverage,
  type AgentCreatedBy,
} from '../../shared/sessionStatus.js';
import type { WorkbenchJobStatus } from '../../shared/workbenchDto.js';
// 角色包名的读侧归一化与「会话记录的角色包」同一判据（不在这里另写 trim / 空串判断）
import { normalizeRolePackName } from './rolePackName.js';
// 开活范围声明（判据 4）：规范化与重叠判定的单点实现（纯函数，无锁）
import { findScopeOverlap, normalizeScopePaths } from './sessionScope.js';
// 范围扫描 + 回执文案（同域外置，避免工具文件超 max-lines）
import {
  buildScopeCheck,
  collectActiveScopes as collectActiveScopesFrom,
  occupiesScopeFor,
  type ActiveScopeScan,
  type ScopeCheck,
} from './workSessionScope.js';
// 代答子会话提问的工具面（定义 / 参数解析 / 回执类型）：独立闭环外置，注册仍在本文件
import {
  ANSWER_SESSION_QUESTION_DEFINITION,
  ANSWER_SESSION_QUESTION_TOOL_NAME,
  parseAnswerQuestionArgs,
  type HostedQuestionAnswerer,
} from './answerSessionQuestionTool.js';

/**
 * 主控工具的岗位纪律（HOSTED-CONFIRM-SOFT-1 判据 ④ · 「岗位三层」第②层：工具契约不可换）
 *
 * 三条沿用 SOFT-1 定案原文，不在此另造判据：不推送、不发布；遇到先提醒；用户明确要求 = 授权。
 * 真相链：设计 = 定案 §4.2 P1 / B7；待办 = `HOSTED-CONFIRM-SOFT-1` ④。
 * 唯一消费面 = `create_session` / `send_to_session` 的 description——模型每次调用前读到。
 * 刻意不进 `Agent.chat()` 的 input：input 会原样落盘成轮的用户消息，注入纪律会让
 * live 投影（原文）与重启后的落盘历史（带纪律）显示漂移；Worker 侧送达需内核提示词注入位，
 * 不在宿主批内夹带（见台账补记）。
 * P2 Hand back 两句同在本常量（Worker 交回格式 + Router 三选一），不另造第二份纪律真源。
 * 第五句（派活状态以成功回执为准）出自 `ASSISTANT-EMPTY-ACK-1`：真机见助手 thought 写了
 * 「Send to session」却未发 tool_call、正文照抄上一轮「已接受」话术（软约束偶发幻觉）。
 * 该句是事实陈述（定义「已安排」的真值条件），不是禁令式；不进 input、不动内核终态判据
 * （内核 done 判据只认结构化标志），只让模型生成话术前读到「没回执就不算已安排」。
 */
const WORK_SESSION_TOOL_DISCIPLINE =
  '岗位纪律（不可违反）：不推送、不发布；遇到先提醒；用户明确要求 = 授权。' +
  '开活 / 派活时把边界写进 mandate；不把推送 / 发布 / 发版这类不可逆操作交给 Worker。' +
  'Worker 发现超出 mandate 时，把交回消息作为本轮唯一输出，首字符写 [HAND_BACK] reason: <一句话>。' +
  '收到交回后你决定转新活（create_session）/ 合并到现有活（send_to_session）/ 转述用户。' +
  '派活 / 开活的状态以工具成功回执为准：拿到回执才算已安排 / 已接受，未拿到时是已发起、等待受理。';

/**
 * 会话清单工具名（装配点、单测、后续切片共用的唯一字面量）
 *
 * 与设计文档 §13.11.1 的四个路由工具之一同名；本片只落地这一个。
 */
export const LIST_WORK_SESSIONS_TOOL_NAME = 'list_work_sessions';

/**
 * 派发工具名（与设计文档 §13.11.1 同名）
 *
 * 合法用途 = 主控把一条输入交给指定会话继续处理；不建会话、不代替目标会话作答。
 */
export const SEND_TO_SESSION_TOOL_NAME = 'send_to_session';

/**
 * 建会话工具名（与设计文档 §13.11.1 同名）
 *
 * 合法用途 = 主控开一个合适的会话并让它开始第一轮；创建走宿主既有新建路径，不另造链路。
 */
export const CREATE_SESSION_TOOL_NAME = 'create_session';

/**
 * 停止会话工具名（台账 HOST-MANAGED-MODE-V0-1 判据 6 的「停止」半）
 *
 * 只允许停「当前仍由代理驱动」的活（判据 = 注入的读盘闭包，与工作台清单 / 中断通知
 * 同一处）；用户自己建的、用户接管中或盘读异常的一律 E_DENIED。
 * 停止复用用户停止的同一条实现，终态与原因仍由既有轮投影给出，不新增通知类型。
 */
export const STOP_WORK_SESSION_TOOL_NAME = 'stop_work_session';

/**
 * 角色包只读清单工具名
 *
 * 为什么要单独一个出口：主控要「按名选包」，就得先知道有哪些名字；
 * 让模型猜包名只会得到一串 `E_ROLE_PACK`。只读、无副作用。
 */
export const LIST_ROLE_PACKS_TOOL_NAME = 'list_role_packs';

/**
 * 记忆摘要窄工具名（判据 5 记忆收口）
 *
 * 只读「会话级摘要 + 关键主题 + 最近若干轮摘要」，**不暴露 `roundId`**：
 * 内核原始 `trace_summary` 带 `roundId` 时会回读该轮原始对话，等于给主控开 `read_file`
 * 后门；主控职责是管会话，不是翻子会话正文。两件事必须同做（窄工具 + 主控 deny 原始工具），
 * 只注册窄工具而原始工具仍在 `DEFAULT_EXPOSED_TOOLS` 里，等于没做。
 *
 * 不叫 `read_session_summary`：它读的是记忆条目里的轮次摘要，不是能力 5 列表里的会话摘要
 * （会话摘要走 `list_work_sessions` 的 `summary` 字段），名字相撞会让模型选错工具。
 */
export const READ_MEMORY_SUMMARY_TOOL_NAME = 'read_memory_summary';

/** 单次返回的轮摘要条数上限（与内核 `traceSummary` 的无 roundId 分支同口径） */
export const MEMORY_SUMMARY_ROUND_LIMIT = 5;

/** 单条轮摘要的字符上限（与内核 `traceSummary` 的单条预览同口径） */
export const MEMORY_SUMMARY_TEXT_CHARS = 120;

/**
 * 暂停 / 恢复工具名（判据 6）
 *
 * 必须成对：暂停是「想继续」，恢复是唯一出口。只给暂停 = 把子会话停在一个
 * 代理自己解不开的状态，用户还得手工去点继续，托管语义就断在半路。
 */
export const PAUSE_WORK_SESSION_TOOL_NAME = 'pause_work_session';
export const RESUME_WORK_SESSION_TOOL_NAME = 'resume_work_session';

/**
 * 宝的完整工具面（HOSTED-ROUTER-TOOL-SURFACE-1 · 封闭白名单唯一真源）
 *
 * 定案 §一 / §五「Router 不配技术工具」：宝只有会话管理 + 两个只读查询，零读文件 /
 * 跑命令 / 改代码 / 内核基建。名单从上方九个工具名常量逐项派生（含代答工具名，
 * 它住在独立模块），装配层只引用本常量、不另抄字面量——抄一份就是第二真源，
 * 内核新增工具或本模块改名时必漂移。
 *
 * 为什么不用 deny 补集：deny 是「全集减名单」，内核新出的工具默认漏进宝面
 * （危险方向是漏）。allow-only 是「全集即名单」，新工具默认不进，与设计硬约束同向。
 *
 * ⚠️ 名单只控制暴露面，不控制注册：`registerWorkSessionTools` 按回调到位情况注册，
 * 缺回调的工具本就不在装配产物里，allow-only 过滤对不存在的名字零副作用。
 */
export const ORCHESTRATOR_ALLOWED_TOOLS: readonly string[] = [
  LIST_WORK_SESSIONS_TOOL_NAME,
  SEND_TO_SESSION_TOOL_NAME,
  CREATE_SESSION_TOOL_NAME,
  STOP_WORK_SESSION_TOOL_NAME,
  LIST_ROLE_PACKS_TOOL_NAME,
  READ_MEMORY_SUMMARY_TOOL_NAME,
  PAUSE_WORK_SESSION_TOOL_NAME,
  RESUME_WORK_SESSION_TOOL_NAME,
  ANSWER_SESSION_QUESTION_TOOL_NAME,
];

/**
 * 派发回调可产生的业务结果（**唯一**真源 = `chatPanel.dispatchHostedInput` 的返回面）
 *
 * 只含派发层真实会判的四档：调用方非托管 `E_DENIED`、目标会话在跑 `E_BUSY`、
 * 目标会话被另一个窗口占用（拿不到写锁）`E_LOCKED`、目标会话引用的轮文件在盘上缺失
 * 或读不全 `E_UNREADABLE`（存在但历史残缺，拒绝再追加、不落新轮）。
 * 参数校验（`E_ARGS`）、会话存在性（`E_NOT_FOUND`）、宿主异常兜底（`E_HOST`）都在
 * 工具层产生，**不属于**派发契约——写进这里就等于让实现承诺一个永远不会返回的码。
 */
export type HostedDispatchResult =
  | { ok: true; accepted: true }
  | { ok: false; code: 'E_DENIED' | 'E_BUSY' | 'E_LOCKED' | 'E_UNREADABLE'; message: string };

/**
 * `send_to_session` 的返回信封（业务失败一律 `{ ok:false }`，不 throw）
 *
 * 码集按**产生位置**分三层（不承诺与设计文档逐字相等，文档更新滞后时以本类型为准）：
 *   - 工具层自判：`E_ARGS`（未知键 / 非字符串 / 空白串）、`E_NOT_FOUND`（会话不存在）；
 *   - 派发层业务判定：`E_DENIED` 非托管调用 / `E_BUSY` 目标会话正在跑（真实运行态，不排队）
 *     / `E_LOCKED` 目标会话被另一个窗口占用（拿不到写锁，不排队）；
 *   - 宿主兜底：`E_HOST`（装配失败 / 面板抛错等），**不得**冒名 `E_NOT_FOUND`。
 */
export type SendToSessionResult =
  | HostedDispatchResult
  | {
      ok: false;
      code: 'E_ARGS' | 'E_NOT_FOUND' | 'E_HOST';
      message: string;
    };

/**
 * 派发回调（装配期注入，工具 handler 不持有面板实例）
 *
 * @param callingSessionId 发起派发的会话（E_DENIED 判据）
 * @param targetSessionId 目标会话
 * @param text 要投递的用户输入（不注入任何宿主上下文）
 * @param senderName 落 `RoundMessage.name` 的发送者名（装配期传入，handler 不自带字面量）
 */
export type HostedInputDispatcher = (
  callingSessionId: string,
  targetSessionId: string,
  text: string,
  senderName: string,
) => Promise<HostedDispatchResult>;

/** 派发工具的运行期依赖（缺省 ⇒ 只注册 list 工具；装配层负责在缺失时记警告） */
export interface WorkSessionToolDeps {
  /** 本次装配归属的会话（= 调用方） */
  callingSessionId: string;
  /** 装配期确定的发送者名（不是工具内字面量） */
  senderName: string;
  /** 派发到目标会话的实现（由宿主面板提供；缺省 ⇒ 不注册 send 工具） */
  dispatch?: HostedInputDispatcher;
  /** 新建会话并投递首轮（由宿主面板提供；缺省 ⇒ 不注册 create 工具） */
  createSession?: HostedSessionCreator;
  /** 停止目标会话的当前轮（由宿主面板提供；缺省 ⇒ 不注册 stop 工具） */
  stopSession?: HostedSessionStopper;
  /** 暂停目标会话（由宿主面板提供；缺省 ⇒ 不注册 pause 工具） */
  pauseSession?: HostedSessionPauser;
  /** 恢复目标会话（由宿主面板提供；缺省 ⇒ 不注册 resume 工具） */
  resumeSession?: HostedSessionResumer;
  /**
   * 代答目标会话的在途提问（由宿主面板提供；缺省 ⇒ 不注册 answer_session_question）
   *
   * 缺省不注册而不是注册空壳：与 send / create 同一条降级纪律（宁可不给工具，
   * 也不给一个永远失败的）。只取目标会话既有实例与既有提问快照，不新建。
   */
  answerQuestions?: HostedQuestionAnswerer;
  /**
   * 会话摘要读口（判据 5 的窄工具；缺省 ⇒ 不注册 `read_memory_summary`）
   *
   * 只读会话级摘要 / 关键主题 / 轮摘要，不读原始对话；与主控 deny `trace_summary`
   * 必须同批生效（装配层负责 deny，本文件负责窄工具）。
   */
  readMemorySummary?: MemorySummaryReader;
  /** 角色包只读清单（装配期从内核 `listMeta()` 单点取，带来源标记） */
  listRolePacks: () => RolePackBrief[];
  /**
   * 单会话状态读口（**必须**与工作台共用 `shared/sessionStatus.projectSessionStatus`）
   *
   * 缺省时清单项一律标 `unreadable`——宁可说「不知道」，也不让代理把没读到当成空闲。
   */
  readStatus?: (sessionId: string) => WorkbenchJobStatus;
  /** 本进程创建者账本（与工作台同一真源 `HostedSessionNotifier`；重启后为空） */
  agentCreated?: (orchestratorId: string) => readonly string[];
  /**
   * 当前是否由代理驱动的唯一判据（停止 / 暂停 / 恢复的目标归属）
   *
   * 与出生账本分开：账本只回答「谁开的」；用户接管中或盘读异常时本读口即为 false，一律拒绝。
   * 缺省按「不可确认 ⇒ 拒绝」处理——宁可不给操作，也不拿出生记录当权限。
   */
  isAgentDriven?: (sessionId: string) => boolean;
  /** 调用方历史重建（重启后账本为空时补来源归属；读盘有上限，结果自带覆盖状态） */
  readHistory?: (orchestratorId: string) => SessionHistoryFacts;
  /**
   * 工作区根绝对路径（把 `paths` 里的绝对路径截成相对；缺省时只按原样规范化）
   *
   * 只用于比较，不写盘、不建索引。
   */
  workspaceRoot?: string;
  /**
   * 全部会话的声明范围读口（**真源 = 会话元数据** `SessionMeta.declaredPaths`）
   *
   * 为什么不从历史反推：历史只扫最近 60 轮，窗口一满就读不到声明，等于把「核不清」变成常态。
   * `paths` 缺省 = 该会话创建于范围功能上线之前（老会话），读侧按「没有声明」如实降级。
   * 缺省整个读口 = 无法核对任何声明 ⇒ 回执按「核不清」告知。
   */
  readDeclaredScopes?: () => readonly {
    sid: string;
    title?: string;
    paths?: readonly string[];
  }[];
}

/**
 * 调用方历史重建的消费形状（`WorkbenchHistoryResult` 结构上直接满足）
 *
 * 只取工具要用的五件事：覆盖状态、创建记录、派发记录、总轮数、实扫轮数。
 * 注意：它只用来**认领旧会话**（范围功能上线前开的、没有声明的活）与回忆「派过什么」，
 * 不再用来反推范围声明。
 */
export interface SessionHistoryFacts {
  /** complete / partial / unreadable（`partial` = 超上限或有记录读不到） */
  coverage: 'complete' | 'partial' | 'unreadable';
  /** 历史里的 `create_session` 记录（sid + 创建时标题） */
  children: readonly { sessionId: string; title?: string }[];
  /**
   * 历史里的 `send_to_session` 成功派发记录（每个目标 sid 只保留最近一次）
   *
   * 空数组 ≠ 「从未派过」：窗口截断 / 读不到时由 `coverage` 说明。
   */
  dispatches: readonly { sessionId: string; excerpt: string; at: string | null }[];
  /** 代理会话总轮数 */
  totalRounds: number;
  /** 本次实际扫描的轮数（< total 即「上限截断」） */
  scannedRounds: number;
  /**
   * 反查「被派过活」的口径（可选：历史实现没提供时 = 不知道，不臆造）
   *
   * 结构上是 `WorkbenchHistoryResult.dispatchScan` 的子集：`truncated > 0` 说明有会话的
   * 轮数超过回看上限，更早的派发可能没读到 —— 覆盖判据据此把 partial 的理由说清。
   */
  dispatchScan?: { truncated: number };
}

/** 角色包来源层（与角色页 / 设置页同一口径：内置 < 用户 < 项目） */
export type RolePackSource = 'builtin' | 'user' | 'project';

/**
 * 一条轮次摘要的对外形状（窄工具 `read_memory_summary` 的列表项）
 *
 * 只放摘要内容与它的身份，不放原始对话、不放 `processEvents`——那是 `trace_summary`
 * 的能力，主控刻意不给。
 */
export interface RoundSummaryBrief {
  /** 轮次标识（只用于让代理说「哪几轮」；窄工具不接受它作为入参） */
  roundId: string;
  /** 摘要类型（preference / fact / decision / intent / general；缺省 general） */
  summaryType: string;
  /** 摘要正文（已按 `MEMORY_SUMMARY_TEXT_CHARS` 截断） */
  summary: string;
  /** 生成时间（ISO 8601，列表按此降序） */
  createdAt: string;
}

/**
 * 会话摘要事实（判据 5：主控读摘要不读原文）
 *
 * 「没有」与「读不到」必须分开，且不许伪造：
 *   - `summary` / `keyTopics` 为 `null` = 该会话**没有归档过**（不是空串、不是标题）；
 *   - `coverage` 为 `unreadable` = 记忆库读不到轮摘要（**不是**「没有轮摘要」）；
 *     `rounds` 此时为空数组，调用方不得据此断定「这条会话没干过活」。
 */
export interface MemorySummaryFacts {
  /** 会话标题（展示用；与清单同一回退链，只用于给模型指认） */
  title: string;
  /** 会话级归档摘要；`null` = 没归档过 */
  summary: string | null;
  /** 归档时生成的关键主题；`null` = 没归档过 */
  keyTopics: string[] | null;
  /** 最近若干轮摘要（按生成时间降序，最多 `MEMORY_SUMMARY_ROUND_LIMIT` 条） */
  rounds: RoundSummaryBrief[];
  /** 轮摘要读取覆盖：complete = 读全了；unreadable = 记忆库读不到 */
  coverage: 'complete' | 'unreadable';
}

/**
 * 会话摘要读口（装配层注入；`null` = 会话不存在）
 *
 * 只允许同步读既有事实（会话元数据 + 记忆库里的 round-summary），不读原始对话。
 */
export type MemorySummaryReader = (sessionId: string) => MemorySummaryFacts | null;

/**
 * 角色包只读摘要（只给「按名挑包」所需的事实）
 *
 * 刻意**不含**「隐藏 / 不可选 / 托管不可用」这类字段：现状没有这套概念，
 * 主控能看到的包 = 用户自己能选的包，不为托管扩接口。
 */
export interface RolePackBrief {
  /** 角色包名（唯一标识，`create_session` 的 rolePack 用它） */
  name: string;
  /** 展示名（缺省 = name，由消费方回退） */
  displayName?: string;
  /** 角色包描述（可选） */
  description?: string;
  /** 来源层（内置 / 用户 / 项目） */
  source: RolePackSource;
}

/**
 * 建会话结果（业务失败一律 `{ ok:false }`，不 throw）
 *
 * 码集按产生位置：
 *   - 工具层：`E_ARGS`（未知键 / 缺键 / 空白串 / paths 非法）；
 *   - 工具层（范围门禁）：`E_SCOPE_CONFLICT` 声明范围与在跑的活有交集（专门码，不复用其它码）；
 *   - 面板业务判定：`E_DENIED` 调用方非托管 / `E_ROLE_PACK` 角色包不存在或编目不可用；
 *   - 宿主兜底：`E_HOST`（拿锁失败 / 装配失败等），**不得**冒名 `E_NOT_FOUND`。
 */
export type CreateSessionResult =
  | { ok: true; sid: string; title: string; scopeCheck?: ScopeCheck }
  | {
      ok: false;
      code: 'E_DENIED' | 'E_ROLE_PACK' | 'E_HOST';
      message: string;
    }
  | {
      ok: false;
      code: 'E_SCOPE_CONFLICT';
      message: string;
      /** 撞上了哪些活、各撞在哪（按发现顺序；同一会话只报第一处交集） */
      conflicts: readonly ScopeConflict[];
    };

/**
 * 一次范围冲突（回给代理的「撞上哪条活、撞在哪」）
 *
 * 只放可执行信息，不放宿主的内部判断：代理据此决定「等它收场」还是「缩小 paths」。
 */
export interface ScopeConflict {
  /** 占着这条范围的在跑活（列表 / 历史里的 sid） */
  sid: string;
  /** 该活的标题（取不到就省略，不编一个） */
  title?: string;
  /** 对方声明的路径（规范化后；整仓显示为 `.`） */
  declared: string;
  /** 本次想动的路径（规范化后；整仓显示为 `.`） */
  requested: string;
}

/**
 * 建会话回调（装配期注入，工具 handler 不持有面板实例）
 *
 * @param callingSessionId 发起创建的会话（E_DENIED 判据）
 * @param rolePackName 角色包名（工具层已要求必填；`undefined` 形态仅留给宿主内部既有解析链，
 *   代理工具不会传——代理没有「切换角色包」能力，`parseCreateArgs` 缺键即拒）
 * @param title 会话标题（展示给用户，落 `SessionMeta.displayName`）
 * @param text 首轮输入（由新会话自己处理）
 * @param senderName 落首轮 `RoundMessage.name` 的发送者名（装配期传入）
 * @param declaredPaths 已规范化的开活范围声明（创建时与标题同批写入会话元数据）
 */
export type HostedSessionCreator = (
  callingSessionId: string,
  rolePackName: string | undefined,
  title: string,
  text: string,
  senderName: string,
  declaredPaths: readonly string[],
  mandate?: string,
) => Promise<CreateSessionResult>;

/**
 * 暂停会话的宿主结果（工具 `pause_work_session` 的末段返回值）
 *
 * `paused:false` 不是错误：目标已收场 / 本来就无活可暂停（空闲守卫作废）。
 * `already:true` = 目标已在暂停态或暂停申请已在途（幂等，不重复提交）。
 * 归属裁决不在这里做（面板只判托管门禁），由工具层用创建者账本 + 历史判。
 */
export type HostedPauseResult =
  | { ok: true; paused: boolean; already: boolean }
  | { ok: false; code: 'E_DENIED' | 'E_UNREADABLE' | 'E_HOST'; message: string };

/**
 * 恢复会话的宿主结果（工具 `resume_work_session` 的末段返回值）
 *
 * `resumed:false` 不是错误：目标不在暂停态（可能在等用户回答 / 已收场），没有可恢复的活。
 */
export type HostedResumeResult =
  | { ok: true; resumed: boolean }
  | { ok: false; code: 'E_DENIED' | 'E_UNREADABLE' | 'E_HOST'; message: string };

/**
 * 暂停会话回调（面板实现；工具 handler 不持有面板实例）
 *
 * 实现必须**按目标 sid 取既有实例**，再调该实例的无参公开方法 `requestPause`——
 * 不给内核加目标形参、不改内核签名（停止已按同一路径按 sid 寻址）。
 */
export type HostedSessionPauser = (
  callingSessionId: string,
  targetSessionId: string,
) => Promise<HostedPauseResult>;

/**
 * 恢复会话回调（面板实现；工具 handler 不持有面板实例）
 *
 * 实现必须按目标 sid 取既有实例，复用该实例的 `resumeExecution` 与宿主既有 runFlow 通路，
 * 不另造续跑逻辑，也不改内核签名。
 */
export type HostedSessionResumer = (
  callingSessionId: string,
  targetSessionId: string,
) => Promise<HostedResumeResult>;

/**
 * 停止会话的宿主结果（工具 `stop_work_session` 的末段返回值）
 *
 * `stopped:false` 不是错误：目标当前没有流 / 不是 paused，说明活已经收场或无活可停。
 * 归属裁决不在这里做（面板只判托管门禁），由工具层用创建者账本 + 历史判。
 */
export type HostedStopResult =
  { ok: true; stopped: boolean } | { ok: false; code: 'E_DENIED' | 'E_HOST'; message: string };

/**
 * 停止会话回调（面板实现；工具 handler 不持有面板实例）
 *
 * 实现必须复用用户停止的同一条路径（`_runOps.handleStop(sessionId)`），
 * 不许为工具另造一套 abort / 收场逻辑。
 */
export type HostedSessionStopper = (
  callingSessionId: string,
  targetSessionId: string,
) => Promise<HostedStopResult>;

/**
 * 最近一次派给某会话的任务摘录（主控自己的工作记录，单向）
 *
 * 来源 = 主控会话自己轮里的 `send_to_session` 调用：目标 sid 与内容取自
 * `tool_start.args`，是否真派成功由同 `toolCallId` 的 `tool_result.ok` 确认。
 * 这只是读代理自己的历史，**不写目标会话任何字段**，目标不感知自己被派过。
 */
export interface WorkSessionLastDispatch {
  /** 派发内容摘录（超长截断，不是全文；全文在主控自己的轮里） */
  excerpt: string;
  /** 派发时间（ISO 8601；`null` = 记录里没有可用时间戳） */
  at: string | null;
}

/**
 * 单个会话的对外摘要（代理判断「该复用还是该新开」的最小字段集）
 *
 * 八个事实：标识、标题、**归档摘要**、最后更新时间、**当前状态**、**归属**（谁开的）、
 * **角色包**（能力面）、**最近一次派给它什么**。前七项全部来自既有事实的读侧投影，
 * 第八项来自主控自己轮里的派发记录——不新增持久化、不建关系表。
 */
export interface WorkSessionBrief {
  /** 会话标识（YYYY-MM-DD-sessionName，与 sessionStore 同口径） */
  sid: string;
  /**
   * 展示标题（displayName 优先，回退 autoName，再回退会话标识）
   *
   * ⚠️ 只能用于初筛：标题是首轮 LLM 摘要、之后永不更新，任务漂移后稳定误导；
   * 复用定夺必须看 `summary` / 状态 / `updatedAt`。
   */
  title: string;
  /**
   * 会话级归档摘要（`SessionMeta.summary`，由 SessionArchiver 归档时生成）
   *
   * `null` = 这条会话**没有归档过摘要**（还没离场 / 归档没写成）——**不是**标题，
   * 也**不是**空串。判据 1 的数据面：没有摘要的会话不许被路由（拿不到就新建）。
   */
  summary: string | null;
  /** 最后更新时间（ISO 8601，排序依据；store 已按此降序） */
  updatedAt: string;
  /**
   * 状态（与工作台同一投影：在跑 / 等你 / 完成 / 被中止 + 边缘事实）
   *
   * ⚠️ `unreadable` = 读不到，**不是**空闲；调用方不得据此判断「可以再开一个」。
   */
  status: WorkbenchJobStatus;
  /**
   * 归属：`agent` = 你开的 / `user` = 用户自己建的 / `unknown` = 无法确认
   *
   * ⚠️ `unknown` 不等于「不是你的」；只表示现有事实不足以判定。
   */
  createdBy: AgentCreatedBy;
  /**
   * 该会话挂的角色包名（能力面的既有事实，取 `SessionMeta.activeRolePackName`）
   *
   * `null` = 该会话**没有记录**角色包（旧会话 / 从未选过）——不是空串，也**不是**默认包；
   * 默认包由装配链兜底，读侧不得把兜底值写成这条会话的选择记录。
   */
  rolePack: string | null;
  /**
   * 最近一次派给它的任务摘录（`null` = 本次可读历史窗口里没读到派给它的记录）
   *
   * ⚠️ `null` **不等于**「从未派过」：窗口有上限（顶层 `scan.truncated`）或部分读不到
   * （`coverage !== 'complete'`）时，只能说「这次没看到」。不许用占位词冒充事实。
   */
  lastDispatch: WorkSessionLastDispatch | null;
}

/**
 * 工具定义（声明面）
 *
 * - `readonly: true` / `diskWrite: 'none'`：只读元数据，不写盘 ⇒ 不参与写串行闸；
 * - `confirmPolicy: 'audit'`：免弹窗但落审计（内核契约：宿主注册工具应显式声明，
 *   缺省 = 静默不审批不审计，这里刻意不走进那条缺省路径）。
 */
const LIST_WORK_SESSIONS_DEFINITION: ToolDefinition = {
  name: LIST_WORK_SESSIONS_TOOL_NAME,
  description:
    '列出当前工作区已知的会话（sid、标题、归档摘要、最后更新时间、状态、归属、角色包），' +
    '用于判断是否已有相关会话、避免重复新建。不含对话正文。' +
    'summary 是该会话归档时生成的摘要（判断复用与否的主依据）；null = 没有归档过摘要，' +
    '不是标题、也不是空串——没有摘要的会话不许被路由。' +
    'title 只用于初筛：它是首轮生成后永不更新的旧标题，任务漂移后会误导，不能拿它做定夺。' +
    'status.kind：running 在跑 / waiting 等你（用户要先处理）/ completed 已完成 / ' +
    'stopped 被中止（stop 给原因）/ unsettled 上次未正常结束 / queued 尚未开始 / unreadable 状态读不到。' +
    'createdBy：agent = 你开的 / user = 用户自己建的 / unknown = 无法确认。' +
    'rolePack：该会话挂的角色包名（能力面依据）；null = 会话没有记录角色包，不是默认包。' +
    'lastDispatch：你最近一次派给它的任务摘录（来自你自己轮里的 send_to_session 调用）；' +
    'null = 本次可读历史窗口里没读到派给它的记录，不等于从未派过——窗口上限与截断见顶层 scan。' +
    '⚠️ unreadable、unknown、或顶层 coverage 不为 complete 都表示「不确定」，' +
    '不得当成「这条活没在跑、可以再开一个」；不确定时先向用户确认，不要盲目新建或派活。',
  parameters: {
    type: 'object',
    // 本片无参数：切片 1 接入扫盘后再按需扩展（不预留空壳参数）
    properties: {},
    required: [],
  },
  readonly: true,
  diskWrite: 'none',
  confirmPolicy: 'audit',
};

/**
 * 派发工具定义（声明面）
 *
 * - `readonly: false`：会让目标会话进入一轮可能写文件的流程，只读模式（review/plan）应拦住它；
 * - `diskWrite: 'none'`：工具本身不直接改项目磁盘（真正落盘发生在目标会话自己的内核流程里），
 *   不能按 `'opaque'` 与一切写互斥——那会把「派发」误当成写盘屏障；
 * - `confirmPolicy: 'audit'`：托管模式下免弹窗但留审计（与 list 工具同档）。
 *
 * 参数封闭：只有 sid / text；未知键在 handler 里判 `E_ARGS`（ToolDefinition 的参数表
 * 不支持 `additionalProperties`，判据必须落在代码而不是 schema 声明）。
 */
const SEND_TO_SESSION_DEFINITION: ToolDefinition = {
  name: SEND_TO_SESSION_TOOL_NAME,
  description:
    '向指定会话发送一条输入，由该会话继续处理。sid 必须来自 list_work_sessions。' +
    '目标会话正在运行时返回 E_BUSY（不排队）；被另一个窗口占用时返回 E_LOCKED（不排队）。' +
    WORK_SESSION_TOOL_DISCIPLINE,
  parameters: {
    type: 'object',
    properties: {
      sid: { type: 'string', description: '目标会话标识（list_work_sessions 返回的 sid）' },
      text: { type: 'string', description: '要发送的输入文本' },
    },
    required: ['sid', 'text'],
  },
  readonly: false,
  diskWrite: 'none',
  confirmPolicy: 'audit',
};

/**
 * 停止会话工具定义（声明面）
 *
 * - `readonly: false`：会中断目标会话的当前轮，属于会改变状态的动作；
 * - `diskWrite: 'none'`：工具本身不写项目磁盘（落盘发生在目标会话自己的内核收场里）；
 * - `confirmPolicy: 'audit'`：与 list / send / create 同档（免弹窗但留审计）。
 *
 * 参数封闭：只有 sid；未知键在 handler 判 `E_ARGS`。
 */
const STOP_WORK_SESSION_DEFINITION: ToolDefinition = {
  name: STOP_WORK_SESSION_TOOL_NAME,
  description:
    '停止一条**当前仍由代理驱动**的会话正在跑的活（复用用户停止的同一条路径）。' +
    '目标正由用户接管、或本来就是用户自己建的，返回 E_DENIED（判据是当前驱动权，不是出生记录）；' +
    '状态读不到（unreadable）时返回 E_UNREADABLE，不猜着停。' +
    '返回 stopped=true 表示停止信号已发出；stopped=false 表示目标已收场 / 本来没跑。' +
    '终态与原因用 list_work_sessions 再看（completed / stopped + stop）。',
  parameters: {
    type: 'object',
    properties: {
      sid: { type: 'string', description: '目标会话标识（list_work_sessions 返回的 sid）' },
    },
    required: ['sid'],
  },
  readonly: false,
  diskWrite: 'none',
  confirmPolicy: 'audit',
};

/**
 * 暂停会话工具定义（声明面 · 判据 6）
 *
 * - `readonly: false`：会改变目标会话的运行态（软暂停，不中断生成流）；
 * - `diskWrite: 'none'`：暂停只翻宿主 / 内核内存状态，落盘发生在目标会话自己的检查点；
 * - `confirmPolicy: 'audit'`：与 stop / send / create 同档。
 *
 * 参数封闭：只有 sid；未知键在 handler 判 `E_ARGS`。
 * 与 `resume_work_session` **成对**：只给暂停会把子会话停在代理自己解不开的状态。
 */
const PAUSE_WORK_SESSION_DEFINITION: ToolDefinition = {
  name: PAUSE_WORK_SESSION_TOOL_NAME,
  description:
    '暂停一条**当前仍由代理驱动**的会话（软暂停：当前步骤结束后生效，历史保留，可再恢复）。' +
    '目标正由用户接管、或本来就是用户自己建的，返回 E_DENIED（判据是当前驱动权，不是出生记录）；' +
    '状态读不到（unreadable）时返回 E_UNREADABLE，不猜着暂停。' +
    'paused=true 表示已在暂停态 / 申请已被受理；paused=false 表示目标已收场或本来没跑。' +
    '恢复用 resume_work_session（同一套归属门禁）。',
  parameters: {
    type: 'object',
    properties: {
      sid: { type: 'string', description: '目标会话标识（list_work_sessions 返回的 sid）' },
    },
    required: ['sid'],
  },
  readonly: false,
  diskWrite: 'none',
  confirmPolicy: 'audit',
};

/**
 * 恢复会话工具定义（声明面 · 判据 6）
 *
 * - `readonly: false`：会让目标会话继续跑（可能写文件），只读模式（review/plan）应拦住它；
 * - `diskWrite: 'none'`：续跑落盘发生在目标会话自己的内核流程里，不按 `opaque` 与一切写互斥；
 * - `confirmPolicy: 'audit'`：与 pause / stop 同档。
 *
 * 参数封闭：只有 sid；未知键在 handler 判 `E_ARGS`。
 */
const RESUME_WORK_SESSION_DEFINITION: ToolDefinition = {
  name: RESUME_WORK_SESSION_TOOL_NAME,
  description:
    '恢复一条**当前仍由代理驱动**的会话（复用宿主既有续跑路径，不新造流）。' +
    '目标正由用户接管、或本来就是用户自己建的，返回 E_DENIED（判据是当前驱动权，不是出生记录）；' +
    '状态读不到（unreadable）时返回 E_UNREADABLE，不猜着恢复。' +
    'resumed=true 表示续跑已启动；resumed=false 表示目标不在暂停态' +
    '（可能在等用户回答 / 已收场），没有可恢复的活。',
  parameters: {
    type: 'object',
    properties: {
      sid: { type: 'string', description: '目标会话标识（list_work_sessions 返回的 sid）' },
    },
    required: ['sid'],
  },
  readonly: false,
  diskWrite: 'none',
  confirmPolicy: 'audit',
};

/**
 * 建会话工具定义（声明面）
 *
 * - `readonly: false`：首轮会让新会话进入可能写文件的流程，只读模式（review/plan）应拦住它；
 * - `diskWrite: 'none'`：会话元数据 / 轮次写的是 `.memora` 数据目录，不是项目磁盘；
 *   真正落盘发生在新建会话自己的内核流程里，不能按 `'opaque'` 与一切写互斥；
 * - `confirmPolicy: 'audit'`：与 list / send 同档（免弹窗但留审计）。
 *
 * 参数封闭：rolePack / title / text / paths **全部必填**；`rolePack` 由代理在开活前定死
 * （代理没有切换角色包的能力，省了或给不存在的包名都拒——后者由宿主角色包目录回
 * `E_ROLE_PACK`），`paths` **必填**（开活前必须声明打算动哪些路径），未知键在 handler 判
 * `E_ARGS`（schema 不支持 additionalProperties）。
 */
const CREATE_SESSION_DEFINITION: ToolDefinition = {
  name: CREATE_SESSION_TOOL_NAME,
  description:
    '创建一个新会话，并让它开始处理第一轮任务。rolePack **必填**：必须是 list_role_packs 返回的' +
    'name（代理没有「切换角色包」的能力，开活前先定清楚，省了或包名不存在都会被拒）。' +
    'title 是给用户看的会话标题，text 是第一轮输入。' +
    'paths **必填**：声明这条活打算动的文件或目录（相对工作区根；传 ["."] 表示整个工作区，' +
    '等于自愿独占）。与当前在跑的活的声明范围有交集时返回 E_SCOPE_CONFLICT，' +
    '并告诉你撞上哪条活、撞在哪，你可决定等它收场或缩小 paths。' +
    'mandate（可选）= 这条活的语义边界（要解决什么问题、不解决什么问题，≤200字），用于约束 Worker 的工作范围。' +
    '与 text 的区别：text 是交给 Worker 的第一轮具体指令，mandate 是更高层的整体边界。' +
    '返回新会话的 sid 与 title；角色包不存在或不可用时返回 E_ROLE_PACK。' +
    WORK_SESSION_TOOL_DISCIPLINE,
  parameters: {
    type: 'object',
    properties: {
      rolePack: {
        type: 'string',
        description: '角色包名（必填；list_role_packs 返回的 name，不存在或不可用会被拒）',
      },
      title: { type: 'string', description: '会话标题（展示给用户，不是会话标识）' },
      text: { type: 'string', description: '要交给新会话处理的第一轮输入' },
      paths: {
        type: 'array',
        // 内核 ToolDefinition 的 items 形参要求带 properties / required（历史形态），照填空壳
        items: { type: 'string', properties: {}, required: [] },
        description:
          '这条活打算动的文件或目录（相对工作区根，如 ["src/agent", "docs/a.md"]）；' +
          '传 ["."] 表示整个工作区（自愿独占）。必填，不能为空。',
      },
      mandate: {
        type: 'string',
        description:
          '这条活的语义边界（要解决什么问题、不解决什么问题），≤200字。可选。' +
          '与 text 的区别：text 是交给 Worker 的第一轮具体指令（如"写一个 PermissionManager 类"），' +
          'mandate 是这条活的整体边界（如"解决用户权限校验绕过问题，不做权限系统重构"）。' +
          'mandate 落盘为该会话的 workOrder（会话清单 / 审计可读），首轮只把 text 交给 Worker；' +
          '不要把要 Worker 立刻执行的指令塞进 mandate。',
      },
    },
    required: ['rolePack', 'title', 'text', 'paths'],
  },
  readonly: false,
  diskWrite: 'none',
  confirmPolicy: 'audit',
};

/**
 * 角色包只读清单定义（声明面）
 *
 * - `readonly: true` / `diskWrite: 'none'`：只读内存里的清单，不写盘；
 * - 无参数：清单规模靠 L1 阈值控制，不做过滤参数（需要再扩时不预留空壳）。
 */
const LIST_ROLE_PACKS_DEFINITION: ToolDefinition = {
  name: LIST_ROLE_PACKS_TOOL_NAME,
  description:
    '列出当前可用的角色包（名称、展示名、描述、来源：内置 / 用户 / 项目），用于给 create_session 挑包。' +
    '主控能选的包与用户自己能选的完全相同，没有额外授权。',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  readonly: true,
  diskWrite: 'none',
  confirmPolicy: 'audit',
};

/**
 * 记忆摘要窄工具定义（声明面 · 判据 5）
 *
 * - `readonly: true` / `diskWrite: 'none'`：只读元数据与记忆索引，不写盘；
 * - `confirmPolicy: 'audit'`：与其它会话工具同档；
 * - 参数封闭：只接受 `sid` 一个键，**不暴露 `roundId`**（暴露它就能绕回原始对话）。
 */
const READ_MEMORY_SUMMARY_DEFINITION: ToolDefinition = {
  name: READ_MEMORY_SUMMARY_TOOL_NAME,
  description:
    '读取指定会话的记忆摘要：会话级归档摘要、关键主题、最近若干轮的摘要（不含原始对话）。' +
    'sid 必须来自 list_work_sessions；不接受 roundId，也不返回任何轮的原始对话。' +
    'summary / keyTopics 为 null = 该会话没有归档过摘要；' +
    'coverage 为 unreadable = 记忆库读不到轮摘要（不是「没有轮摘要」）。' +
    '要更细的结论，派一个只读会话去查，不要在这里找原文。',
  parameters: {
    type: 'object',
    properties: {
      sid: { type: 'string', description: '目标会话标识（list_work_sessions 返回的 sid）' },
    },
    required: ['sid'],
  },
  readonly: true,
  diskWrite: 'none',
  confirmPolicy: 'audit',
};

/**
 * 把既有事实投影成窄工具的回执事实（纯函数，便于单测）
 *
 * @param input.title 会话标题（展示用，不参与判断）
 * @param input.summary 会话级归档摘要（缺省 = 没归档过）
 * @param input.keyTopics 归档关键主题（缺省 = 没归档过）
 * @param input.memories 已按会话过滤的 round-summary 记忆；`null` = 记忆库读不到
 * @returns 窄工具事实（`coverage` 区分「没有」与「读不到」）
 */
export function buildMemorySummaryFacts(input: {
  title: string;
  summary?: string;
  keyTopics?: string[];
  memories: readonly Memory[] | null;
}): MemorySummaryFacts {
  // 记忆库读不到 ⇒ coverage 如实标 unreadable，`rounds` 空数组不等于「没有轮摘要」
  if (input.memories === null) {
    return {
      title: input.title,
      summary: input.summary && input.summary.trim() !== '' ? input.summary : null,
      keyTopics: input.keyTopics && input.keyTopics.length > 0 ? [...input.keyTopics] : null,
      rounds: [],
      coverage: 'unreadable',
    };
  }
  const rounds = [...input.memories]
    // 最近生成的在前（与内核 traceSummary 的降序口径一致）
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, MEMORY_SUMMARY_ROUND_LIMIT)
    .map((memory) => ({
      roundId: memory.roundId ?? 'unknown',
      summaryType: memory.summaryType ?? 'general',
      // 截断只影响预览长度，不改写内容
      summary:
        memory.content.length > MEMORY_SUMMARY_TEXT_CHARS
          ? `${memory.content.slice(0, MEMORY_SUMMARY_TEXT_CHARS)}…`
          : memory.content,
      createdAt: memory.createdAt,
    }));
  return {
    title: input.title,
    summary: input.summary && input.summary.trim() !== '' ? input.summary : null,
    keyTopics: input.keyTopics && input.keyTopics.length > 0 ? [...input.keyTopics] : null,
    rounds,
    coverage: 'complete',
  };
}

/**
 * 校验 `read_memory_summary` 的参数（只接受 { sid }）
 *
 * 与 stop / pause / resume 共用同一份解析：窄工具的「窄」由这份键集封闭保证，
 * 多一个 `roundId` 就会退回成 `trace_summary` 的入口。
 *
 * @param args 工具执行器传入的已解析参数
 * @returns 合法载荷；undefined = 未知键 / 缺键 / 类型不对（调用方统一回 `E_ARGS`）
 */
function parseReadMemorySummaryArgs(args: Record<string, unknown>): { sid: string } | undefined {
  return parseSidOnlyArgs(args);
}

/**
 * 会话元数据 → 对外摘要（纯函数，便于单测）
 *
 * 标题回退链复用内核 `getSessionDisplayName`（displayName → autoName），
 * 两者皆空时退回会话标识——列表里不能出现「无名行」。
 *
 * @param meta 会话元数据（store 真源）
 * @param status 状态投影（缺读口时由调用方传 `unreadable`，不猜空闲）
 * @param createdBy 归属三档（缺事实时 `unknown`）
 * @param lastDispatch 最近一次派给它的任务摘录（没有 / 本次窗口内没读到 = `null`）
 * @returns 对外摘要
 */
export function toWorkSessionBrief(
  meta: SessionMeta,
  status: WorkbenchJobStatus,
  createdBy: AgentCreatedBy,
  lastDispatch: WorkSessionLastDispatch | null,
): WorkSessionBrief {
  return {
    sid: meta.sessionId,
    title: getSessionDisplayName(meta) || meta.sessionId,
    // 摘要只取归档结果：没有归档 = null（不拿标题 / 空串冒充「这条会话有摘要」）
    summary: meta.summary && meta.summary.trim() !== '' ? meta.summary : null,
    updatedAt: meta.updatedAt,
    status,
    createdBy,
    // 读侧只取「会话记录过的名字」：没有记录 = null，不拿装配兜底的默认包冒充
    rolePack: normalizeRolePackName(meta.activeRolePackName) ?? null,
    // 派发记录来自主控自己的历史；没读到就如实 null，不用占位词冒充
    lastDispatch,
  };
}

/**
 * 校验 `send_to_session` 的参数（只有 sid / text，且都必须是非空字符串）
 *
 * @param args 工具执行器传入的已解析参数
 * @returns 合法载荷；undefined = 缺键 / 多键 / 类型不对（调用方统一回 `E_ARGS`）
 */
function parseSendArgs(args: Record<string, unknown>): { sid: string; text: string } | undefined {
  const keys = Object.keys(args);
  // 键集必须**恰好**是 {sid,text}：多一个未知键就拒（不忽略、不透传）
  if (keys.length !== 2 || !keys.includes('sid') || !keys.includes('text')) return undefined;
  const { sid, text } = args;
  if (typeof sid !== 'string' || typeof text !== 'string') return undefined;
  if (sid.trim() === '' || text.trim() === '') return undefined;
  return { sid, text };
}

/**
 * 校验「只接受 { sid }」类工具的参数（stop / pause / resume / read_memory_summary 共用）
 *
 * 四个入口的入参形态完全相同，共用一份解析，避免某一处悄悄放宽（例如给 resume 加个
 * roundId）却没人发现。
 *
 * @param args 工具执行器传入的已解析参数
 * @returns 合法载荷；undefined = 未知键 / 缺键 / 类型不对（调用方统一回 `E_ARGS`）
 */
function parseSidOnlyArgs(args: Record<string, unknown>): { sid: string } | undefined {
  const keys = Object.keys(args);
  // 键集必须恰好是 {sid}：多一个未知键就拒（不忽略、不透传）
  if (keys.length !== 1 || keys[0] !== 'sid') return undefined;
  const { sid } = args;
  if (typeof sid !== 'string' || sid.trim() === '') return undefined;
  return { sid };
}

/**
 * 校验 `create_session` 的参数（rolePack / title / text / paths 全部必填且 title / text 非空）
 *
 * @param args 工具执行器传入的已解析参数
 * @returns 合法载荷；undefined = 未知键 / 缺键 / 类型不对（调用方统一回 `E_ARGS`）
 */
function parseCreateArgs(
  args: Record<string, unknown>,
):
  { rolePack: string; title: string; text: string; paths: string[]; mandate?: string } | undefined {
  const keys = Object.keys(args);
  // 键集只允许这五键；多一个未知键就拒（不忽略、不透传）
  const allowed = new Set(['rolePack', 'title', 'text', 'paths', 'mandate']);
  if (keys.some((key) => !allowed.has(key))) return undefined;
  const { rolePack, title, text, paths, mandate } = args;
  if (typeof title !== 'string' || typeof text !== 'string') return undefined;
  if (title.trim() === '' || text.trim() === '') return undefined;
  // rolePack 必填：代理侧没有「切换角色包」能力，开活前必须定包；省了/空串一律拒。
  // 包名是否存在不在这里判——那属于宿主角色包目录的判据（E_ROLE_PACK）。
  if (typeof rolePack !== 'string' || rolePack.trim() === '') return undefined;
  // paths 必填：声明范围是开活的前置条件，不许省（省了就无法判重叠）
  if (!Array.isArray(paths) || paths.length === 0) return undefined;
  if (paths.some((item) => typeof item !== 'string' || item.trim() === '')) return undefined;
  const normalizedPaths = paths as string[];
  // mandate 可选：语义边界，不强制；有值时校验是字符串且 ≤200 字
  const normalizedMandate =
    mandate !== undefined && mandate !== null
      ? typeof mandate === 'string' && mandate.trim() !== '' && mandate.length <= 200
        ? mandate.trim()
        : undefined
      : undefined;
  return {
    rolePack,
    title,
    text,
    paths: normalizedPaths,
    ...(normalizedMandate ? { mandate: normalizedMandate } : {}),
  };
}

/**
 * 序列化 `create_session` 的结果（工具对外文本的**唯一**产生点）
 *
 * 🔒 互锁（WORKBENCH-SID-1）：工作台重启后会从 `tool_result.summary`（内核截到 100 字符）
 * 里解析 sid，解析实现在 `webview/helpers/workbenchHistory.ts` 的 `parseCreateSessionSid`。
 * 本函数产出的**前缀与 sid 位置**就是那份解析的输入契约：
 *   `{\n  "ok": true,\n  "sid": "<sid>", …`
 * 改缩进、改键序、把 sid 挪出前 100 字符，都必须同步改解析侧与互锁测试
 * `src/webview/__tests__/workbenchSidContract.test.ts`；否则工作台会**静默变成空清单**
 * （看起来像「一条活都没有」，实为解析断了）。
 *
 * 为什么走文本互锁而不是结构化通道：内核持久化的 `tool_result` 只有通用 `summary` 与
 * delegate 专用回执，没有给自定义工具的通用结构化载荷；为此新增字段等于新增持久化字段，
 * 超出本切片边界（见任务约束「不为此新增持久化字段」）。
 *
 * @param result 建会话结果（成功带 sid / title / scopeCheck；业务失败带错误码）
 * @returns 缩进 2 空格的 JSON 文本（与既有对外形态逐字一致）
 */
export function serializeCreateSessionResult(result: CreateSessionResult): string {
  // 键序固定 ok → sid → title；sid 落在第 3 行，100 字符窗口内可稳定命中。
  // scopeCheck 只追加在 title 之后，不挪 sid 的位置（互锁契约见上）
  return JSON.stringify(result, null, 2);
}

/**
 * 读「这条会话是不是调用方开的」所需的既有事实（stop / pause / resume 三条入口共用）
 *
 * 账本 = 本进程创建者记录（重启后为空）；历史 = 每次按需重建（有上限）。
 * 两处都读不到时返回 unreadable / 空集，由 `projectCreatedBy` 判 unknown，不猜。
 *
 * @param deps 装配期注入的依赖（可能整体缺省）
 * @returns 历史（可缺省）+ 创建者账本 + 历史事实（缺省时 unreadable 兜底）
 */
function readHostedCreatedFacts(deps: WorkSessionToolDeps | undefined): {
  history?: SessionHistoryFacts;
  ledger: readonly string[];
  historyFacts: SessionHistoryFacts;
} {
  const callingSessionId = deps?.callingSessionId;
  // 历史重建每次调用做一次（读盘有上限，结果自带覆盖状态）；没有读口 ⇒ 如实 unreadable
  const history =
    callingSessionId && deps?.readHistory ? deps.readHistory(callingSessionId) : undefined;
  // 创建者账本仅本进程（重启后为空），与历史并集由 `projectCreatedBy` 判归属
  const ledger = callingSessionId && deps?.agentCreated ? deps.agentCreated(callingSessionId) : [];
  return {
    history,
    ledger,
    historyFacts: history ?? {
      coverage: 'unreadable',
      children: [],
      dispatches: [],
      totalRounds: 0,
      scannedRounds: 0,
    },
  };
}

/**
 * 归属门禁的统一话术（stop / pause / resume 三条入口同一套，语义不放宽）
 *
 * 判据是「当前是否由代理驱动」，不是出生记录：用户自己建的、用户接管中或盘读异常的会话
 * 都不由代理驱动，拒绝理由相同（不再区分「账本没记」这类内部推导）。
 *
 * @param verb 被拒的动作（停 / 暂停 / 恢复），只影响文案
 * @returns 给模型看的拒绝原因
 */
function agentDrivenDeniedMessage(verb: string): string {
  return `该会话当前不由代理驱动（用户自己建的、用户接管中或盘读异常），代理不许${verb}。`;
}

/**
 * 状态是否已经「没有活可暂停 / 恢复」
 *
 * 与 stop 同一组判据：已收场、从未跑起来的状态不当作可操作活，如实回 false 而不是报错。
 *
 * @param kind 工作台状态投影
 * @returns true = 没有活（调用方直接回 false，不调用宿主回调）
 */
function hasNoLiveRun(kind: WorkbenchJobStatus['kind']): boolean {
  return kind === 'completed' || kind === 'stopped' || kind === 'unsettled' || kind === 'queued';
}

/**
 * 为主控会话注册会话工具
 *
 * 幂等性：本函数只做一次性装配注册；`registerTool` 对同名重复注册会抛错——
 * 这是有意的（重复装配 = 装配层 bug，不该被静默吞掉）。
 *
 * @param agent 已 init 的内核 Agent（注册面 = `agent.tools`）
 * @param sessionStore 宿主会话存储（数据真源 = `listSessionMetas()`）
 * @param deps 运行期依赖（调用方 / 发送者名 / 派发 / 建会话 / 角色包清单）；
 *   缺省 = 只注册 list 工具（不注册永远失败的空壳）
 * @returns true = 已注册；false = 工具执行器不可用（未 init），调用方负责记日志
 */
export function registerWorkSessionTools(
  agent: Agent,
  sessionStore: ISessionStore,
  deps?: WorkSessionToolDeps,
): boolean {
  const tools = agent.tools;
  // 未初始化时 getter 返回 null：本片不抛错（装配层继续跑，调用方记一条警告即可）
  if (!tools) return false;
  /**
   * 当前占写面的活 + 这次核清了多少（扫描实现外置在 `workSessionScope.ts`）
   *
   * 调用方由扫描内部统一排除（与冲突判定同一判据）；没有声明的活按状态分档计数，
   * 不把「已派发未开跑」「状态读不到」混进「在跑的活」。
   */
  const collectActiveScopes = (): ActiveScopeScan =>
    collectActiveScopesFrom({
      ...(deps?.callingSessionId ? { callingSessionId: deps.callingSessionId } : {}),
      ...(deps?.workspaceRoot ? { workspaceRoot: deps.workspaceRoot } : {}),
      ...(deps?.readDeclaredScopes ? { readDeclaredScopes: deps.readDeclaredScopes } : {}),
      ...(deps?.readStatus ? { readStatus: deps.readStatus } : {}),
      ...(deps?.readHistory ? { readHistory: deps.readHistory } : {}),
    });
  /**
   * 读「这条会话是不是调用方开的」所需的既有事实（单一实现见模块级 `readHostedCreatedFacts`）
   */
  const readCreatedFacts = () => readHostedCreatedFacts(deps);
  tools.registerTool(LIST_WORK_SESSIONS_DEFINITION, async () => {
    // 结果形态对齐设计文档的 `{ ok, sessions }` 信封；本片不含 workspaceRoot（未到需要时）
    const metas = sessionStore.listSessionMetas();
    const callingSessionId = deps?.callingSessionId;
    const { history, ledger, historyFacts } = readCreatedFacts();
    // 派发记录按目标 sid 索引（历史重建已按轮序只保留最近一次）
    const dispatchBySid = new Map(
      (history?.dispatches ?? []).map((item) => [item.sessionId, item] as const),
    );
    const sessions = metas.map((meta) => {
      const latest = dispatchBySid.get(meta.sessionId);
      return toWorkSessionBrief(
        meta,
        // 缺读口 = 不知道，绝不写成 queued / completed（那会让代理以为可以再开一个）
        deps?.readStatus?.(meta.sessionId) ?? { kind: 'unreadable' },
        projectCreatedBy(meta, meta.sessionId, { ledger, history: historyFacts }),
        // 没读到 = null（不是 unknown 占位，也不是空串）；窗口边界见顶层 scan
        latest ? { excerpt: latest.excerpt, at: latest.at } : null,
      );
    });
    // 判据只此一处（工作台同源）：结论 + 理由一起回给代理，不让它从 partial 一个词去猜
    const listed = resolveListCoverage({
      history: history ?? { coverage: 'unreadable' },
      // 调用方自己都不在清单里 ⇒ 清单不可信（会话被删 / 存储加载失败），不能说「一条都没有」
      seatExists: callingSessionId
        ? metas.some((meta) => meta.sessionId === callingSessionId)
        : false,
      // 反查窗口截断：更早的派发可能没读到（历史缺读口时按 0，不编截断）
      dispatchTruncated: history?.dispatchScan?.truncated ?? 0,
    });
    return JSON.stringify(
      {
        ok: true,
        coverage: listed.coverage,
        // 为什么 partial：四类理由之一或若干（措辞由读的人决定，结论不由他重判）
        coverageReasons: listed.reasons,
        // 扫描口径：scannedRounds < totalRounds 即「上限截断」，来源归属可能因此为 unknown
        ...(history
          ? {
              scan: {
                totalRounds: history.totalRounds,
                scannedRounds: history.scannedRounds,
                truncated: history.scannedRounds < history.totalRounds,
              },
            }
          : {}),
        sessions,
      },
      null,
      2,
    );
  });
  if (deps) {
    if (deps.dispatch) {
      const dispatch = deps.dispatch;
      tools.registerTool(SEND_TO_SESSION_DEFINITION, async (args) => {
        const parsed = parseSendArgs(args);
        if (!parsed) {
          return JSON.stringify(
            {
              ok: false,
              code: 'E_ARGS',
              message: '参数必须且只能是 { sid, text }，两者均为非空字符串。',
            },
            null,
            2,
          );
        }
        // 存在性用会话清单判（含老数据占位补全），不用 getSessionMeta——后者对未写 meta 的旧会话会误判缺失
        if (!sessionStore.listSessionMetas().some((meta) => meta.sessionId === parsed.sid)) {
          return JSON.stringify(
            { ok: false, code: 'E_NOT_FOUND', message: `未知会话：${parsed.sid}` },
            null,
            2,
          );
        }
        try {
          // E_DENIED / E_BUSY 由派发回调按真实运行态与调用方身份判；工具层不自造判据
          const result = await dispatch(
            deps.callingSessionId,
            parsed.sid,
            parsed.text,
            deps.senderName,
          );
          return JSON.stringify(result, null, 2);
        } catch (err) {
          // 业务契约：不 throw（throw 会让模型只看到工具失败，读不到可判读的错误码）。
          // 码 = E_HOST：装配 / 面板等**宿主侧**异常，与「sid 不存在」是两回事，
          // 不许冒名 E_NOT_FOUND——那会让模型误以为换一个 sid 就能成功。
          return JSON.stringify(
            {
              ok: false,
              code: 'E_HOST',
              message: `宿主派发失败：${err instanceof Error ? err.message : String(err)}`,
            },
            null,
            2,
          );
        }
      });
    }
    if (deps.createSession) {
      const createSession = deps.createSession;
      tools.registerTool(CREATE_SESSION_DEFINITION, async (args) => {
        const parsed = parseCreateArgs(args);
        if (!parsed) {
          return JSON.stringify(
            {
              ok: false,
              code: 'E_ARGS',
              message:
                '参数必须是 { rolePack, title, text, paths }：rolePack 为非空角色包名，' +
                'title / text 必须是非空字符串，' +
                'paths 必须是非空字符串数组（传 ["."] 表示整个工作区）。',
            },
            null,
            2,
          );
        }
        // ① 范围门禁（判据 4）：规范化本次声明，与当前占写面的活逐条比交集
        const requested = normalizeScopePaths(parsed.paths, deps.workspaceRoot);
        const scan = collectActiveScopes();
        const conflicts: ScopeConflict[] = [];
        for (const active of scan.scopes) {
          // 与计数共用同一判据：调用方自己 / 不占写面的状态都不参与冲突比对
          if (!occupiesScopeFor(active.sid, deps.callingSessionId, active.status)) continue;
          const overlap = findScopeOverlap(requested, active.paths);
          if (!overlap) continue;
          conflicts.push({
            sid: active.sid,
            ...(active.title ? { title: active.title } : {}),
            declared: overlap.declared,
            requested: overlap.requested,
          });
        }
        if (conflicts.length > 0) {
          // 专门码：不排队、不自动重试（排队会替代理做决定；缩小范围也可能同样是代理该拍的板）
          return JSON.stringify(
            {
              ok: false,
              code: 'E_SCOPE_CONFLICT',
              message:
                `声明范围与 ${conflicts.length} 条在跑的活重叠，未开新会话。` +
                '可等它收场后重试（用 list_work_sessions 看状态），或缩小 paths 再试；' +
                '若这条活确实要独占整个工作区，可显式传 ["."]。',
              conflicts,
            },
            null,
            2,
          );
        }
        try {
          // E_DENIED / E_ROLE_PACK 由创建回调按调用方身份与角色包编目判；工具层不自造判据。
          // 角色包缺失**绝不**折算成 E_NOT_FOUND：那是「会话不存在」的语义，混用会让模型换 sid。
          const result = await createSession(
            deps.callingSessionId,
            parsed.rolePack,
            parsed.title,
            parsed.text,
            deps.senderName,
            // 范围随创建写进会话元数据（标题同一批）：后续同轮 / 重启后都直接读，不再反推历史
            requested,
            // 语义边界（可选）：mandate 约束 Worker 的工作范围，不写技术方向
            parsed.mandate,
          );
          if (result.ok) {
            // 回执必带「这次核清了多少」：核不清时这句随结果给模型看，
            // 不把「核不清」冒充成「没有冲突」（与 E_SCOPE_CONFLICT 用不同的话）
            return serializeCreateSessionResult({ ...result, scopeCheck: buildScopeCheck(scan) });
          }
          return serializeCreateSessionResult(result);
        } catch (err) {
          // 业务契约：不 throw；宿主侧异常单独一码，与角色包 / 会话语义分开
          return JSON.stringify(
            {
              ok: false,
              code: 'E_HOST',
              message: `宿主建会话失败：${err instanceof Error ? err.message : String(err)}`,
            },
            null,
            2,
          );
        }
      });
    }
    if (deps.stopSession) {
      const stopSession = deps.stopSession;
      tools.registerTool(STOP_WORK_SESSION_DEFINITION, async (args) => {
        const parsed = parseSidOnlyArgs(args);
        if (!parsed) {
          return JSON.stringify(
            { ok: false, code: 'E_ARGS', message: '参数必须且只能是 { sid }，sid 为非空字符串。' },
            null,
            2,
          );
        }
        const meta = sessionStore.listSessionMetas().find((m) => m.sessionId === parsed.sid);
        if (!meta) {
          return JSON.stringify(
            { ok: false, code: 'E_NOT_FOUND', message: `未知会话：${parsed.sid}` },
            null,
            2,
          );
        }
        // ① 归属门禁：只看「当前是否仍由代理驱动」（收回后即拒绝，不看出生账本）
        if (!deps.isAgentDriven?.(parsed.sid)) {
          return JSON.stringify(
            { ok: false, code: 'E_DENIED', message: agentDrivenDeniedMessage('停') },
            null,
            2,
          );
        }
        // ② 真实状态：读当前轮（索引优先、整轮兜底），不拿清单快照停一个已经收场的轮
        const status = deps.readStatus?.(parsed.sid) ?? { kind: 'unreadable' as const };
        if (status.kind === 'unreadable') {
          // 读不到 ≠ 空闲：不敢停，先让调用方确认，避免误杀或误判「已收场」
          return JSON.stringify(
            {
              ok: false,
              code: 'E_UNREADABLE',
              message: '该会话的状态读不到，未执行停止；请稍后重试或让用户处理。',
            },
            null,
            2,
          );
        }
        // 已经收场 / 从没跑起来：没有活可停，如实回 stopped=false（不是错误）
        if (hasNoLiveRun(status.kind)) {
          return JSON.stringify({ ok: true, stopped: false, status }, null, 2);
        }
        try {
          // ③ 复用用户停止的同一条路径（面板内 _runOps.handleStop），不另造 abort / 收场
          const result = await stopSession(deps.callingSessionId, parsed.sid);
          if (!result.ok) return JSON.stringify(result, null, 2);
          // 面板没停到（如检查与执行之间刚好收场）→ 重读真实状态，不拿停前快照回话
          const finalStatus = result.stopped ? status : (deps.readStatus?.(parsed.sid) ?? status);
          return JSON.stringify(
            { ok: true, stopped: result.stopped, status: finalStatus },
            null,
            2,
          );
        } catch (err) {
          // 业务契约：不 throw；宿主侧异常单独一码，与「没有这条会话」分开
          return JSON.stringify(
            {
              ok: false,
              code: 'E_HOST',
              message: `宿主停止失败：${err instanceof Error ? err.message : String(err)}`,
            },
            null,
            2,
          );
        }
      });
    }
    if (deps.pauseSession) {
      const pauseSession = deps.pauseSession;
      tools.registerTool(PAUSE_WORK_SESSION_DEFINITION, async (args) => {
        // ①②③ 与 stop 同一套：参数封闭 → 归属门禁（账本 + 历史）→ 状态可读性
        const parsed = parseSidOnlyArgs(args);
        if (!parsed) {
          return JSON.stringify(
            { ok: false, code: 'E_ARGS', message: '参数必须且只能是 { sid }，sid 为非空字符串。' },
            null,
            2,
          );
        }
        const meta = sessionStore.listSessionMetas().find((m) => m.sessionId === parsed.sid);
        if (!meta) {
          return JSON.stringify(
            { ok: false, code: 'E_NOT_FOUND', message: `未知会话：${parsed.sid}` },
            null,
            2,
          );
        }
        // 归属门禁：当前是否由代理驱动（与 stop 同一判据，不看出生账本）
        if (!deps.isAgentDriven?.(parsed.sid)) {
          return JSON.stringify(
            { ok: false, code: 'E_DENIED', message: agentDrivenDeniedMessage('暂停') },
            null,
            2,
          );
        }
        const status = deps.readStatus?.(parsed.sid) ?? { kind: 'unreadable' as const };
        if (status.kind === 'unreadable') {
          // 读不到 ≠ 空闲：不猜着暂停，先让调用方确认
          return JSON.stringify(
            {
              ok: false,
              code: 'E_UNREADABLE',
              message: '该会话的状态读不到，未执行暂停；请稍后重试或让用户处理。',
            },
            null,
            2,
          );
        }
        // 已收场 / 从没跑起来：没有活可暂停，如实回 paused=false（不是错误）
        if (hasNoLiveRun(status.kind)) {
          return JSON.stringify({ ok: true, paused: false, already: false, status }, null, 2);
        }
        try {
          // ④ 按目标 sid 取既有实例调 requestPause（宿主 helper，内核签名不变）
          const result = await pauseSession(deps.callingSessionId, parsed.sid);
          if (!result.ok) return JSON.stringify(result, null, 2);
          // 暂停在下一 step 边界才生效：此处保留申请前状态快照，不重读成「已暂停」的假象
          return JSON.stringify(
            {
              ok: true,
              paused: result.paused,
              ...(result.already ? { already: true } : {}),
              status,
            },
            null,
            2,
          );
        } catch (err) {
          return JSON.stringify(
            {
              ok: false,
              code: 'E_HOST',
              message: `宿主暂停失败：${err instanceof Error ? err.message : String(err)}`,
            },
            null,
            2,
          );
        }
      });
    }
    if (deps.resumeSession) {
      const resumeSession = deps.resumeSession;
      tools.registerTool(RESUME_WORK_SESSION_DEFINITION, async (args) => {
        // ①②③ 与 stop / pause 同一套门禁，不放宽
        const parsed = parseSidOnlyArgs(args);
        if (!parsed) {
          return JSON.stringify(
            { ok: false, code: 'E_ARGS', message: '参数必须且只能是 { sid }，sid 为非空字符串。' },
            null,
            2,
          );
        }
        const meta = sessionStore.listSessionMetas().find((m) => m.sessionId === parsed.sid);
        if (!meta) {
          return JSON.stringify(
            { ok: false, code: 'E_NOT_FOUND', message: `未知会话：${parsed.sid}` },
            null,
            2,
          );
        }
        // 归属门禁：当前是否由代理驱动（与 stop / pause 同一判据，不看出生账本）
        if (!deps.isAgentDriven?.(parsed.sid)) {
          return JSON.stringify(
            { ok: false, code: 'E_DENIED', message: agentDrivenDeniedMessage('恢复') },
            null,
            2,
          );
        }
        const status = deps.readStatus?.(parsed.sid) ?? { kind: 'unreadable' as const };
        if (status.kind === 'unreadable') {
          return JSON.stringify(
            {
              ok: false,
              code: 'E_UNREADABLE',
              message: '该会话的状态读不到，未执行恢复；请稍后重试或让用户处理。',
            },
            null,
            2,
          );
        }
        // 只有 waiting 可能是暂停态（paused 在工作台投影里就是 waiting）；其余没有可恢复的活
        if (status.kind !== 'waiting') {
          return JSON.stringify({ ok: true, resumed: false, status }, null, 2);
        }
        try {
          // ④ 宿主按目标 sid 复核实例态：等用户回答的暂停不代答，未在暂停态如实回 false
          const result = await resumeSession(deps.callingSessionId, parsed.sid);
          if (!result.ok) return JSON.stringify(result, null, 2);
          return JSON.stringify(
            {
              ok: true,
              resumed: result.resumed,
              ...(result.resumed
                ? {}
                : { note: '目标不在代理可恢复的暂停态（可能在等用户回答 / 已收场），未恢复。' }),
              status,
            },
            null,
            2,
          );
        } catch (err) {
          return JSON.stringify(
            {
              ok: false,
              code: 'E_HOST',
              message: `宿主恢复失败：${err instanceof Error ? err.message : String(err)}`,
            },
            null,
            2,
          );
        }
      });
    }
    if (deps.answerQuestions) {
      const answerQuestions = deps.answerQuestions;
      tools.registerTool(ANSWER_SESSION_QUESTION_DEFINITION, async (args) => {
        // 先过参数封闭：未知键 / 类型不对一律 E_ARGS（不绕过、不猜）
        const parsed = parseAnswerQuestionArgs(args);
        if (!parsed) {
          return JSON.stringify(
            {
              ok: false,
              code: 'E_ARGS',
              message:
                '参数只能是 { sid, answers? }：sid 为非空字符串；answers 省略 = 只查看题目，' +
                '传入时必须是与题目等长同序的字符串数组（空串 = 该题不答）。',
            },
            null,
            2,
          );
        }
        // 存在性用会话清单判（与 send / stop / pause / resume 同一判据，不用 getSessionMeta）
        if (!sessionStore.listSessionMetas().some((meta) => meta.sessionId === parsed.sid)) {
          return JSON.stringify(
            { ok: false, code: 'E_NOT_FOUND', message: `未知会话：${parsed.sid}` },
            null,
            2,
          );
        }
        try {
          // E_DENIED / E_ARGS（题数不符）由宿主回调判；工具层不自造第二套判据
          return JSON.stringify(
            answerQuestions(deps.callingSessionId, parsed.sid, parsed.answers),
            null,
            2,
          );
        } catch (err) {
          // 业务契约：不 throw；宿主侧异常单独一码，与「会话不存在」分开
          return JSON.stringify(
            {
              ok: false,
              code: 'E_HOST',
              message: `宿主代答失败：${err instanceof Error ? err.message : String(err)}`,
            },
            null,
            2,
          );
        }
      });
    }
    tools.registerTool(LIST_ROLE_PACKS_DEFINITION, async () => {
      // 只读透传装配期注入的清单（内核 listMeta 单点），不在这里二次过滤 / 加缓存
      return JSON.stringify({ ok: true, packs: deps.listRolePacks() }, null, 2);
    });
    if (deps.readMemorySummary) {
      const readMemorySummary = deps.readMemorySummary;
      tools.registerTool(READ_MEMORY_SUMMARY_DEFINITION, async (args) => {
        const parsed = parseReadMemorySummaryArgs(args);
        if (!parsed) {
          return JSON.stringify(
            { ok: false, code: 'E_ARGS', message: '参数必须且只能是 { sid }，sid 为非空字符串。' },
            null,
            2,
          );
        }
        try {
          // 只读会话元数据 + 记忆索引里的摘要条目；读不到原始对话是本工具的刻意边界
          const facts = readMemorySummary(parsed.sid);
          if (!facts) {
            return JSON.stringify(
              { ok: false, code: 'E_NOT_FOUND', message: `未知会话：${parsed.sid}` },
              null,
              2,
            );
          }
          return JSON.stringify({ ok: true, sid: parsed.sid, ...facts }, null, 2);
        } catch (err) {
          // 业务契约：不 throw；宿主侧异常单独一码，与「会话不存在」分开
          return JSON.stringify(
            {
              ok: false,
              code: 'E_HOST',
              message: `宿主读取摘要失败：${err instanceof Error ? err.message : String(err)}`,
            },
            null,
            2,
          );
        }
      });
    }
  }
  return true;
}
