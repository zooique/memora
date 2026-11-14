/**
 * 会话工具 · 主控装配面（托管模式 v0）
 *
 * 职责（只做主控会话的工具面）：
 *   - 装配层判定「这个 Agent 是主控」时，为它注册 `list_work_sessions` / `send_to_session` /
 *     `create_session` / `list_role_packs`；
 *   - 普通会话不注册 ⇒ 模型侧「工具不存在」，不是「调用报错」。
 *
 * 边界（刻意如此，勿扩）：
 *   - 三个业务工具都只做参数校验 + 调注入回调；**不持有面板实例**，也不读编辑器 / problems / git。
 *   - 会话数据来源 = 注入的 `ISessionStore.listSessionMetas()`（宿主已有的会话元数据真源）；
 *     角色包来源 = 注入的 `listRolePacks`（装配期从内核 `RolePackManager.listMeta()` 单点取，
 *     不另建列表、不加缓存）。
 *   - 关系表 / `E_LIMIT` / 深度限制明确后置：v0 **不限制嵌套深度**——派发与建会话工具对每个托管
 *     会话都可见（只有 self 会话没有），没有「子会话拿不到工具」的结构性保证；本文件
 *     **不预留**对应参数或字段，深度闸等关系表落地后再加。
 *   - 主控身份**不落盘、不进 `SessionMeta`**：`SessionMeta.mode` 已作废。
 */
import type { Agent, ISessionStore, SessionMeta, ToolDefinition } from '@zooique/memora';
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
 * 只允许停调用方自己开的活（创建者账本 ∪ 历史重建判归 `agent`）；
 * 用户自己建的会话一律 E_DENIED。停止复用用户停止的同一条实现，
 * 终态与原因仍由既有轮投影给出，不新增通知类型。
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
 * 派发回调可产生的业务结果（**唯一**真源 = `chatPanel.dispatchHostedInput` 的返回面）
 *
 * 只含派发层真实会判的两档：调用方非托管 `E_DENIED`、目标会话在跑 `E_BUSY`。
 * 参数校验（`E_ARGS`）、会话存在性（`E_NOT_FOUND`）、宿主异常兜底（`E_HOST`）都在
 * 工具层产生，**不属于**派发契约——写进这里就等于让实现承诺一个永远不会返回的码。
 */
export type HostedDispatchResult =
  { ok: true; accepted: true } | { ok: false; code: 'E_DENIED' | 'E_BUSY'; message: string };

/**
 * `send_to_session` 的返回信封（业务失败一律 `{ ok:false }`，不 throw）
 *
 * 码集按**产生位置**分三层（不承诺与设计文档逐字相等，文档更新滞后时以本类型为准）：
 *   - 工具层自判：`E_ARGS`（未知键 / 非字符串 / 空白串）、`E_NOT_FOUND`（会话不存在）；
 *   - 派发层业务判定：`E_DENIED` 非托管调用 / `E_BUSY` 目标会话正在跑（真实运行态，不排队）；
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
 * 只取工具要用的四件事：覆盖状态、创建记录、总轮数、实扫轮数。
 * 注意：它只用来**认领旧会话**（范围功能上线前开的、没有声明的活），不再用来反推范围声明。
 */
export interface SessionHistoryFacts {
  /** complete / partial / unreadable（`partial` = 超上限或有记录读不到） */
  coverage: 'complete' | 'partial' | 'unreadable';
  /** 历史里的 `create_session` 记录（sid + 创建时标题） */
  children: readonly { sessionId: string; title?: string }[];
  /** 代理会话总轮数 */
  totalRounds: number;
  /** 本次实际扫描的轮数（< total 即「上限截断」） */
  scannedRounds: number;
}

/** 角色包来源层（与角色页 / 设置页同一口径：内置 < 用户 < 项目） */
export type RolePackSource = 'builtin' | 'user' | 'project';

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
 * 本次范围核对「核清了多少」（成功的派发回执里必带）
 *
 * ⚠️ 这不是错误码，也**不是**「撞上了」：`coverage !== 'complete'` 表示有在跑的活
 * **没有声明记录**（范围功能上线前创建的老会话），或读不到会话元数据——那些活无法判重叠。
 * `note` 是给模型看的一句话，随回执一起返回——**不能只写日志**。
 */
export interface ScopeCheck {
  /** `complete` = 所有在跑的活都有声明可核；其余都是「核不清」 */
  coverage: 'complete' | 'partial' | 'unreadable';
  /** 在跑但没有声明记录的活数量（老会话遗留；>0 即 partial） */
  unscopedRunning: number;
  /** 核不清时给模型看的一句话；`coverage === 'complete'` 时省略 */
  note?: string;
}

/**
 * 一次范围扫描的结果（声明来自会话元数据 + 老会话计数）
 *
 * `scopes` 只含**读得到声明**且在跑的活；老会话只进 `unscopedRunning` 计数，不猜范围。
 */
interface ActiveScopeScan {
  /** 参与重叠比对的活（声明已规范化） */
  scopes: {
    sid: string;
    title?: string;
    paths: readonly string[];
    status: WorkbenchJobStatus;
  }[];
  /** 是否有可用的元数据读口（没有 = unreadable，无法核对任何声明） */
  readable: boolean;
  /** 历史读口是否可用（用来认领「范围上线前开的老会话」；读不到就无法确认有没有此类活在跑） */
  historyReadable: boolean;
  /** 在跑但声明读不到的老会话数量 */
  unscopedRunning: number;
}

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
 * @param rolePackName 角色包名（undefined = 走宿主既有解析链：用户默认 → 兜底包）
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
) => Promise<CreateSessionResult>;

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
 * 单个会话的对外摘要（代理判断「该复用还是该新开」的最小字段集）
 *
 * 七个事实：标识、标题、**归档摘要**、最后更新时间、**当前状态**、**归属**（谁开的）、
 * **角色包**（能力面）。全部来自既有事实的读侧投影，不新增持久化、不建关系表。
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
    '目标会话正在运行时返回 E_BUSY（不排队）。',
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
    '停止一条**你自己开的**会话当前正在跑的活（复用用户停止的同一条路径）。' +
    'sid 必须来自 list_work_sessions，且该条目的 createdBy 必须是 agent。' +
    '用户自己建的会话（createdBy=user）不接受代理停止，返回 E_DENIED；' +
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
 * 建会话工具定义（声明面）
 *
 * - `readonly: false`：首轮会让新会话进入可能写文件的流程，只读模式（review/plan）应拦住它；
 * - `diskWrite: 'none'`：会话元数据 / 轮次写的是 `.memora` 数据目录，不是项目磁盘；
 *   真正落盘发生在新建会话自己的内核流程里，不能按 `'opaque'` 与一切写互斥；
 * - `confirmPolicy: 'audit'`：与 list / send 同档（免弹窗但留审计）。
 *
 * 参数封闭：rolePack / title / text / paths；`rolePack` 可省（走宿主既有解析链），
 * `paths` **必填**（开活前必须声明打算动哪些路径），未知键在 handler 判 `E_ARGS`
 * （schema 不支持 additionalProperties）。
 */
const CREATE_SESSION_DEFINITION: ToolDefinition = {
  name: CREATE_SESSION_TOOL_NAME,
  description:
    '创建一个新会话，并让它开始处理第一轮任务。rolePack 可选（可先用 list_role_packs 查名字；' +
    '省略则按用户默认角色解析），title 是给用户看的会话标题，text 是第一轮输入。' +
    'paths **必填**：声明这条活打算动的文件或目录（相对工作区根；传 ["."] 表示整个工作区，' +
    '等于自愿独占）。与当前在跑的活的声明范围有交集时返回 E_SCOPE_CONFLICT，' +
    '并告诉你撞上哪条活、撞在哪，你可决定等它收场或缩小 paths。' +
    '返回新会话的 sid 与 title；角色包不存在或不可用时返回 E_ROLE_PACK。',
  parameters: {
    type: 'object',
    properties: {
      rolePack: { type: 'string', description: '角色包名（list_role_packs 返回的 name）' },
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
    },
    required: ['title', 'text', 'paths'],
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
 * 会话元数据 → 对外摘要（纯函数，便于单测）
 *
 * 标题回退链复用内核 `getSessionDisplayName`（displayName → autoName），
 * 两者皆空时退回会话标识——列表里不能出现「无名行」。
 *
 * @param meta 会话元数据（store 真源）
 * @param status 状态投影（缺读口时由调用方传 `unreadable`，不猜空闲）
 * @param createdBy 归属三档（缺事实时 `unknown`）
 * @returns 对外摘要
 */
export function toWorkSessionBrief(
  meta: SessionMeta,
  status: WorkbenchJobStatus,
  createdBy: AgentCreatedBy,
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
 * 校验 `stop_work_session` 的参数（只接受 { sid }，且 sid 非空）
 *
 * @param args 工具执行器传入的已解析参数
 * @returns 合法载荷；undefined = 未知键 / 缺键 / 类型不对（调用方统一回 `E_ARGS`）
 */
function parseStopArgs(args: Record<string, unknown>): { sid: string } | undefined {
  const keys = Object.keys(args);
  // 键集必须恰好是 {sid}：多一个未知键就拒（不忽略、不透传）
  if (keys.length !== 1 || keys[0] !== 'sid') return undefined;
  const { sid } = args;
  if (typeof sid !== 'string' || sid.trim() === '') return undefined;
  return { sid };
}

/**
 * 校验 `create_session` 的参数（rolePack 可省；title / text 必填且非空）
 *
 * @param args 工具执行器传入的已解析参数
 * @returns 合法载荷；undefined = 未知键 / 缺键 / 类型不对（调用方统一回 `E_ARGS`）
 */
function parseCreateArgs(
  args: Record<string, unknown>,
): { rolePack?: string; title: string; text: string; paths: string[] } | undefined {
  const keys = Object.keys(args);
  // 键集只允许这四键；多一个未知键就拒（不忽略、不透传）
  const allowed = new Set(['rolePack', 'title', 'text', 'paths']);
  if (keys.some((key) => !allowed.has(key))) return undefined;
  const { rolePack, title, text, paths } = args;
  if (typeof title !== 'string' || typeof text !== 'string') return undefined;
  if (title.trim() === '' || text.trim() === '') return undefined;
  if (rolePack !== undefined) {
    if (typeof rolePack !== 'string' || rolePack.trim() === '') return undefined;
  }
  // paths 必填：声明范围是开活的前置条件，不许省（省了就无法判重叠）
  if (!Array.isArray(paths) || paths.length === 0) return undefined;
  if (paths.some((item) => typeof item !== 'string' || item.trim() === '')) return undefined;
  const normalizedPaths = paths as string[];
  return rolePack === undefined
    ? { title, text, paths: normalizedPaths }
    : { rolePack, title, text, paths: normalizedPaths };
}

/**
 * 这条活是否「占着声明的写面」（判据 4 的重叠对象）
 *
 * - 占着：running（正在跑）/ waiting（等用户拍板，随时继续）/ queued（已派发、还没开始跑）
 *   / unreadable（读不到——**不得**当成空闲，否则会在可能正写的时候放行第二条活）；
 * - 不占：completed / stopped（已收场）/ unsettled（崩溃未打捞：进程已死，不会再写）。
 *
 * @param kind 状态投影的判别式
 */
function occupiesScope(kind: WorkbenchJobStatus['kind']): boolean {
  return kind === 'running' || kind === 'waiting' || kind === 'queued' || kind === 'unreadable';
}

/**
 * 把扫描事实转成回执里的 `scopeCheck`（给模型看，不只是给日志看）
 *
 * 「核不清」与「撞上了」是两件事：这里只描述前者，不伪造后者，也不在核不清时假装
 * 「没有冲突」。**不把「声明整仓」包装成安全建议**：整仓 = 自愿独占，会挡住其它活，
 * 该不该用由代理按任务实际范围自己定。
 *
 * @param scan 本次范围扫描结果
 * @returns 回执字段（`note` 在核不清时必有）
 */
function buildScopeCheck(scan: ActiveScopeScan): ScopeCheck {
  if (!scan.readable) {
    return {
      coverage: 'unreadable',
      unscopedRunning: scan.unscopedRunning,
      note:
        '读不到会话元数据，本次无法核到在跑活的声明范围。这不是「撞上了」，是「核不清」；' +
        '按这条活实际要动的范围声明即可（整仓 = 自愿独占，会挡住其它活）。',
    };
  }
  if (scan.unscopedRunning > 0) {
    return {
      coverage: 'partial',
      unscopedRunning: scan.unscopedRunning,
      note:
        `另有 ${scan.unscopedRunning} 条在跑的活是范围声明上线前开的，没有声明记录，无法判重叠。` +
        '这不是「撞上了」，是「核不清」；按这条活实际要动的范围声明即可' +
        '（整仓 = 自愿独占，会挡住其它活，不是更安全的做法）。',
    };
  }
  if (!scan.historyReadable) {
    return {
      coverage: 'unreadable',
      unscopedRunning: 0,
      note:
        '历史读不到，无法确认有没有范围上线前开的老活在跑。这不是「撞上了」，是「核不清」；' +
        '按这条活实际要动的范围声明即可（整仓 = 自愿独占，会挡住其它活）。',
    };
  }
  return { coverage: 'complete', unscopedRunning: 0 };
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
   * 当前还在占写面的活（**声明真源 = 会话元数据**）+ 这次到底核清了多少
   *
   * 声明随会话创建写进元数据 ⇒ 重启不用反推、不受 60 轮窗口影响。
   * 唯一核不清的是「声明上线前就在跑的老会话」：元数据里没有声明，只能计数如实告知；
   * 这类是有界遗留（活收场即消失），**不得**当成「没有冲突」，也不得据此引导一律声明整仓。
   * 历史重建在这里只用来认领「哪些会话是主控开的」，不用来读声明。
   */
  const collectActiveScopes = (): ActiveScopeScan => {
    const scopes: ActiveScopeScan['scopes'] = [];
    /** 已核对过状态的会话（老会话计数去重） */
    const seen = new Set<string>();
    let unscopedRunning = 0;
    const readable = typeof deps?.readDeclaredScopes === 'function';
    for (const entry of deps?.readDeclaredScopes?.() ?? []) {
      seen.add(entry.sid);
      // 状态读不到按「占着」处理（读不到 ≠ 空闲）
      const status = deps?.readStatus?.(entry.sid) ?? { kind: 'unreadable' as const };
      if (!occupiesScope(status.kind)) continue;
      if (!entry.paths || entry.paths.length === 0) {
        unscopedRunning += 1;
        continue;
      }
      scopes.push({
        sid: entry.sid,
        ...(entry.title ? { title: entry.title } : {}),
        // 元数据里存的已是规范化值；再归一一遍是幂等的，防旧数据 / 手改漏网
        paths: normalizeScopePaths(entry.paths, deps?.workspaceRoot),
        status,
      });
    }
    // 老会话认领：历史里主控开过、但元数据没有声明的在跑活（只计数，不猜范围）
    const history = deps?.callingSessionId ? deps.readHistory?.(deps.callingSessionId) : undefined;
    const historyReadable = !!history && history.coverage !== 'unreadable';
    for (const child of history?.children ?? []) {
      if (seen.has(child.sessionId)) continue;
      const status = deps?.readStatus?.(child.sessionId) ?? { kind: 'unreadable' as const };
      if (!occupiesScope(status.kind)) continue;
      unscopedRunning += 1;
    }
    return { scopes, readable, historyReadable, unscopedRunning };
  };
  /**
   * 读「这条会话是不是调用方开的」所需的既有事实
   *
   * 账本 = 本进程创建者记录（重启后为空）；历史 = 每次按需重建（有上限）。
   * 两处都读不到时返回 unreadable / 空集，由 `projectCreatedBy` 判 unknown，不猜。
   */
  const readCreatedFacts = (): {
    history?: SessionHistoryFacts;
    ledger: readonly string[];
    historyFacts: SessionHistoryFacts;
  } => {
    const callingSessionId = deps?.callingSessionId;
    // 历史重建每次调用做一次（读盘有上限，结果自带覆盖状态）；没有读口 ⇒ 如实 unreadable
    const history =
      callingSessionId && deps?.readHistory ? deps.readHistory(callingSessionId) : undefined;
    // 创建者账本仅本进程（重启后为空），与历史并集由 `projectCreatedBy` 判归属
    const ledger =
      callingSessionId && deps?.agentCreated ? deps.agentCreated(callingSessionId) : [];
    return {
      history,
      ledger,
      historyFacts: history ?? {
        coverage: 'unreadable',
        children: [],
        totalRounds: 0,
        scannedRounds: 0,
      },
    };
  };
  tools.registerTool(LIST_WORK_SESSIONS_DEFINITION, async () => {
    // 结果形态对齐设计文档的 `{ ok, sessions }` 信封；本片不含 workspaceRoot（未到需要时）
    const metas = sessionStore.listSessionMetas();
    const callingSessionId = deps?.callingSessionId;
    const { history, ledger, historyFacts } = readCreatedFacts();
    const sessions = metas.map((meta) =>
      toWorkSessionBrief(
        meta,
        // 缺读口 = 不知道，绝不写成 queued / completed（那会让代理以为可以再开一个）
        deps?.readStatus?.(meta.sessionId) ?? { kind: 'unreadable' },
        projectCreatedBy(meta, meta.sessionId, { ledger, history: historyFacts }),
      ),
    );
    const coverage = resolveListCoverage({
      history: history ?? { coverage: 'unreadable' },
      // 调用方自己都不在清单里 ⇒ 清单不可信（会话被删 / 存储加载失败），不能说「一条都没有」
      seatExists: callingSessionId
        ? metas.some((meta) => meta.sessionId === callingSessionId)
        : false,
    });
    return JSON.stringify(
      {
        ok: true,
        coverage,
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
                '参数只能是 { rolePack?, title, text, paths }；title / text 必须是非空字符串，' +
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
          // 主控自己不是被派发的活，不占写面
          if (active.sid === deps.callingSessionId) continue;
          // 状态读不到时按「占着」处理（读不到 ≠ 空闲，不能拿未知状态放行第二条活）
          if (!occupiesScope(active.status.kind)) continue;
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
        const parsed = parseStopArgs(args);
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
        // ① 归属门禁：只允许停「自己开的活」。用户自己建的 / 无法确认的一律拒绝。
        const { ledger, historyFacts } = readCreatedFacts();
        const createdBy = projectCreatedBy(meta, parsed.sid, { ledger, history: historyFacts });
        if (createdBy !== 'agent') {
          return JSON.stringify(
            {
              ok: false,
              code: 'E_DENIED',
              message:
                createdBy === 'user'
                  ? '这是用户自己建的会话，代理不许停。'
                  : '无法确认这条会话是你开的（账本没记、历史也没扫到），代理不许停。',
            },
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
        if (
          status.kind === 'completed' ||
          status.kind === 'stopped' ||
          status.kind === 'unsettled' ||
          status.kind === 'queued'
        ) {
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
    tools.registerTool(LIST_ROLE_PACKS_DEFINITION, async () => {
      // 只读透传装配期注入的清单（内核 listMeta 单点），不在这里二次过滤 / 加缓存
      return JSON.stringify({ ok: true, packs: deps.listRolePacks() }, null, 2);
    });
  }
  return true;
}
