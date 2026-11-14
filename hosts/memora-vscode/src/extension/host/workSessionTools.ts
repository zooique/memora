/**
 * 会话工具 · 主控装配面（托管模式 v0）
 *
 * 职责（只做两件事）：
 *   - 装配层判定「这个 Agent 是主控」时，为它注册 `list_work_sessions` / `send_to_session`；
 *   - 普通会话不注册 ⇒ 模型侧「工具不存在」，不是「调用报错」。
 *
 * 边界（刻意如此，勿扩）：
 *   - `send_to_session` 只做参数校验 + 会话存在性判定 + 调注入的派发回调；
 *     它**不持有面板实例**，也不读编辑器 / problems / git（派发实现归 chatPanel，见其 JSDoc）。
 *   - 数据来源 = 注入的 `ISessionStore.listSessionMetas()`（宿主已有的会话元数据真源）。
 *   - 关系表 / `E_LIMIT` / 深度限制明确后置（v0 = 深度 1）：本文件**不预留**对应参数或字段。
 *   - 主控身份**不落盘、不进 `SessionMeta`**：`SessionMeta.mode` 已作废。
 */
import type { Agent, ISessionStore, SessionMeta, ToolDefinition } from '@zooique/memora';
import { getSessionDisplayName } from '@zooique/memora';

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
 * `send_to_session` 的返回信封（业务失败一律 `{ ok:false }`，不 throw）
 *
 * 码集按**产生位置**分三档（不承诺与设计文档逐字相等，文档更新滞后时以本类型为准）：
 *   - 工具层自判：`E_ARGS`（未知键 / 非字符串 / 空白串）；
 *   - 派发层业务判定：`E_DENIED` 非托管调用 / `E_NOT_FOUND` 会话不存在 /
 *     `E_BUSY` 目标会话正在跑（真实运行态，不排队）；
 *   - 宿主兜底：`E_HOST`（装配失败 / 面板抛错等），**不得**冒名 `E_NOT_FOUND`。
 */
export type SendToSessionResult =
  | { ok: true; accepted: true }
  | {
      ok: false;
      code: 'E_ARGS' | 'E_DENIED' | 'E_NOT_FOUND' | 'E_BUSY' | 'E_HOST';
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
) => Promise<SendToSessionResult>;

/** 派发工具的运行期依赖（缺省 ⇒ 只注册 list 工具；装配层负责在缺失时记警告） */
export interface WorkSessionToolDeps {
  /** 本次装配归属的会话（= 调用方） */
  callingSessionId: string;
  /** 装配期确定的发送者名（不是工具内字面量） */
  senderName: string;
  /** 派发到目标会话的实现（由宿主面板提供） */
  dispatch: HostedInputDispatcher;
}

/**
 * 单个会话的对外摘要（本片最小字段集）
 *
 * 只给「认会话」所需的三个事实：标识、标题、最后更新时间。
 * 进度 / 待批 / 父子关系等字段留给后续切片（需要宿主运行态，不在本片射程）。
 */
export interface WorkSessionBrief {
  /** 会话标识（YYYY-MM-DD-sessionName，与 sessionStore 同口径） */
  sid: string;
  /** 展示标题（displayName 优先，回退 autoName，再回退会话标识） */
  title: string;
  /** 最后更新时间（ISO 8601，排序依据；store 已按此降序） */
  updatedAt: string;
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
    '列出当前工作区已知的会话（会话标识、标题、最后更新时间），用于判断是否已有相关会话、避免重复新建。' +
    '只返回元数据，不含对话正文。',
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
 * 会话元数据 → 对外摘要（纯函数，便于单测）
 *
 * 标题回退链复用内核 `getSessionDisplayName`（displayName → autoName），
 * 两者皆空时退回会话标识——列表里不能出现「无名行」。
 *
 * @param meta 会话元数据（store 真源）
 * @returns 对外摘要
 */
export function toWorkSessionBrief(meta: SessionMeta): WorkSessionBrief {
  return {
    sid: meta.sessionId,
    title: getSessionDisplayName(meta) || meta.sessionId,
    updatedAt: meta.updatedAt,
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
 * 为主控会话注册会话工具
 *
 * 幂等性：本函数只做一次性装配注册；`registerTool` 对同名重复注册会抛错——
 * 这是有意的（重复装配 = 装配层 bug，不该被静默吞掉）。
 *
 * @param agent 已 init 的内核 Agent（注册面 = `agent.tools`）
 * @param sessionStore 宿主会话存储（数据真源 = `listSessionMetas()`）
 * @param deps 派发依赖（调用方 / 发送者名 / 派发回调）；缺省 = 只注册 list 工具
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
  tools.registerTool(LIST_WORK_SESSIONS_DEFINITION, async () => {
    // 结果形态对齐设计文档的 `{ ok, sessions }` 信封；本片不含 workspaceRoot（未到需要时）
    const sessions = sessionStore.listSessionMetas().map(toWorkSessionBrief);
    return JSON.stringify({ ok: true, sessions }, null, 2);
  });
  if (deps) {
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
        const result = await deps.dispatch(
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
  return true;
}
