/**
 * MCP 连接管理器（**客户端侧**）— stdio 传输 + 协议协商 + 工具发现（含分页）
 *
 * 职责边界（方案-MCP工具接入 §6）：
 *   - 只做「拉起子进程 / 握手 / 拉工具清单 / 转发调用 / 订阅清单变更 / 关闭」几件事；
 *   - **不**决定审批档位（切片 2 的 policy）、**不**决定结果文案（切片 3 的 resultNormalizer）、
 *     **不**决定工具进不进模型列表（toolRegistry 的事）、**不**决定清单变了怎么改注册集
 *     （runtime 的 resync——本文件只把「通知到了」传出去）。
 *
 * 三条硬约束：
 *   1. SDK 只在宿主依赖里 —— 内核零第三方运行时依赖不被触碰（方案 §0 红线 1）；
 *   2. 审批意图一律经内核 `ToolDefinition.confirmPolicy` 表达，本文件不碰任何内核安全方法（红线 2 / D3）；
 *   3. 单个 server 失败**只影响它自己**：连接失败/断开只注销该 server 的工具，不阻断宿主其余功能。
 *
 * ⚠️ 方向别搞反：`hosts/memora-mcp` 是 MCP **server**（对外暴露 memora 记忆）；本文件是 **client**
 * （连接外部 server、把其工具注册进内核）。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  ToolListChangedNotificationSchema,
  type Tool as McpTool,
} from '@modelcontextprotocol/sdk/types.js';
import type { ILogger } from '@zooique/memora';
// 配置形状真源在 shared（webview 要画编辑表单，不能 import 本模块——会把 MCP SDK 拖进
// webview bundle）⇒ 本接口只 extends、不重复定义字段，加字段必两边同源。
import type { McpServerDraftDto } from '../../../shared/protocol.js';

/** 连接握手超时（毫秒）：首次 `npx` 拉起常有数秒冷启动，给足余量；超时即判失败并杀子进程 */
const CONNECT_TIMEOUT_MS = 20_000;

/** 单页 `tools/list` 超时（毫秒）：server 卡死时不得拖住宿主装配 */
const LIST_TOOLS_TIMEOUT_MS = 20_000;

/**
 * 单次工具调用转发超时（毫秒）
 *
 * 工具可正当慢（构建 / 检索 / 浏览器自动化），故比握手宽松；但 server 卡死不得挂死
 * agent turn——内核 custom 分支 `await custom.handler(args, ctx)` 无超时包裹
 * （toolExecutor.ts），LLM 超时管不到工具执行面。超时 = 本次调用失败（执行器包成
 * 工具错误），**不**断连接：在途请求 server 侧继续跑，中止传播归 §10 P5 登记项。
 */
const TOOL_CALL_TIMEOUT_MS = 60_000;

/** 分页上限（页数）：server 若返回重复 cursor 或无限分页，到此为止（否则装配死循环） */
const MAX_TOOL_PAGES = 50;

/**
 * 分页收口原因（重复 cursor / 撞页数上限——两者都不是正常取完，调用方须告警）
 */
export type PaginationStopReason = 'duplicate-cursor' | 'page-limit';

/** `collectAllTools` 的返回：工具清单 + 收口原因（正常取完 = null，供调用方告警） */
export interface ToolCollection {
  tools: McpTool[];
  stopped: { reason: PaginationStopReason; pages: number } | null;
}

/**
 * 单个 MCP server 的用户配置形态
 *
 * 全部字段由 `memora.mcpServers`（用户级设置）读出，宿主不另存副本、不写回。
 * 刻意**不支持**工作区级 `.mcp.json`：他人提交的配置文件可自动拉起任意命令，
 * 信任来源未拍板前只认用户级设置（方案 §10「server 配置来源与信任」登记项）。
 */
export interface McpServerConfig extends McpServerDraftDto {
  /** server 名（进工具名前缀，须唯一；重复配置在启动时按先到先得并告警） */
  name: string;
  /** 可执行命令（如 `node` / `npx` / `python`） */
  command: string;
}

/** 一页 `tools/list` 的结果（分页循环的最小单元） */
export interface McpToolPage {
  tools: McpTool[];
  nextCursor?: string;
}

/**
 * 超时包装：超时抛错，调用方负责清理（关连接）
 *
 * @param promise 被守护的异步动作
 * @param ms 超时毫秒
 * @param label 超时文案里的动作名（便于日志定位）
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // 定时器句柄：settle 后立刻清掉，避免进程被挂起的 timer 拖住
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * 拉全分页工具清单（P1）
 *
 * 只取第一页 = 工具多的 server 静默漏工具，故必须循环 `nextCursor` 直到缺省。
 * cursor 用 Set 去重：server 若把同一 cursor 反复返回（实现有 bug），此处在
 * 上限页数处收口并**返回收口原因**（调用方负责告警——本函数无日志通道，
 * 承诺与实现必须同源，勿只在注释里写「告警」）。
 *
 * @param fetchPage 取一页（cursor 缺省 = 第一页）
 * @returns 全部工具（按 server 返回顺序拼接）+ 收口原因
 */
export async function collectAllTools(
  fetchPage: (cursor?: string) => Promise<McpToolPage>,
): Promise<ToolCollection> {
  const all: McpTool[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    const { tools, nextCursor } = await fetchPage(cursor);
    all.push(...tools);
    if (!nextCursor) return { tools: all, stopped: null };
    if (seen.has(nextCursor)) {
      return { tools: all, stopped: { reason: 'duplicate-cursor', pages: page + 1 } };
    }
    seen.add(nextCursor);
    cursor = nextCursor;
  }
  return { tools: all, stopped: { reason: 'page-limit', pages: MAX_TOOL_PAGES } };
}

/** MCP 连接（一个 server 一条；连接失败时由调用方丢弃实例） */
export class McpConnection {
  /** server 名（工具名前缀来源，也是日志与注销的寻址键） */
  readonly name: string;

  /** 原始配置（连接与重连共用同一份，运行期不改） */
  private readonly config: McpServerConfig;

  /** 日志（缺省 console 兜底：装配早期 logger 可能未注入） */
  private readonly logger?: ILogger;

  /** 客户端标识里的版本号（取扩展版本，仅用于 server 侧遥测，不参与任何判据） */
  private readonly clientVersion: string;

  /** SDK 客户端（connect 时创建） */
  private client: Client | null = null;

  /** 本 server 当前可见的工具清单（每次 listTools 重建 = 派生缓存，不是配置） */
  private tools: McpTool[] = [];

  /**
   * 传输意外断开（子进程退出 / 不可恢复错误）回调
   *
   * 由 runtime 注入：断线时注销该 server 的全部工具，避免模型继续调用已死连接（僵尸工具）。
   * 主动 close() 也会触发底层 onclose，因此置 `closing` 标记让回调自行忽略。
   */
  onClosed?: () => void;

  /**
   * 工具清单变更通知（`notifications/tools/list_changed`，P2）
   *
   * 由 runtime 注入：server 声明 `capabilities.tools.listChanged` 时订阅，收到通知即
   * 回调（runtime 负责重取清单并整换注册集）。未声明该能力的 server 不订阅——协议上
   * 它不会发这个通知，订阅了也是空转。
   */
  onToolsChanged?: () => void;

  /** 是否处于主动关闭流程（区分「我关的」与「它自己死的」） */
  private closing = false;

  constructor(config: McpServerConfig, logger?: ILogger, clientVersion = '0.0.0') {
    this.name = config.name;
    this.config = config;
    this.logger = logger;
    this.clientVersion = clientVersion;
  }

  /**
   * 拉起子进程并完成握手 + 首次工具发现
   *
   * 能力断言（P4）：SDK 承担 `initialize` 协商，但「server 有没有 tools 能力」必须显式读——
   * 不能假设所有 server 都暴露工具。没有该能力直接判失败，避免注册出 0 工具的空壳。
   *
   * @returns 发现到的工具清单
   * @throws 连接/握手/发现任一环节失败（含超时）；抛出前已关闭连接，不留孤儿进程
   */
  async connect(): Promise<McpTool[]> {
    // env 合并默认安全环境：只给用户 env 会丢掉 PATH（子进程直接 ENOENT），
    // 故以 getDefaultEnvironment() 为底、用户键覆盖其上。
    const transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args ?? [],
      cwd: this.config.cwd,
      env: { ...getDefaultEnvironment(), ...(this.config.env ?? {}) },
      // stderr 接管为管道：server 的诊断输出进宿主日志（用户可在 Memora 输出面板看到），
      // 不污染扩展宿主的 stderr
      stderr: 'pipe',
    });
    // 客户端能力声明为空对象 = 明确不声明 elicitation / sampling / roots（方案 §7 P6：不支持即不声明）
    const client = new Client(
      { name: 'memora-vscode', version: this.clientVersion },
      { capabilities: {} },
    );
    this.client = client;

    // 子进程 stderr 逐行进日志（debug 级：server 正常也会打印启动信息）
    transport.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trimEnd();
      if (text) this.logger?.debug(`[MCP:${this.name}] ${text}`);
    });

    try {
      await withTimeout(
        client.connect(transport),
        CONNECT_TIMEOUT_MS,
        `MCP server「${this.name}」握手`,
      );
      // P4 能力断言：没有 tools 能力的 server 无工具可注册，按失败处理（不静默注册空清单）
      const capabilities = client.getServerCapabilities();
      if (!capabilities?.tools) {
        throw new Error(
          `server 未声明 tools 能力（capabilities=${JSON.stringify(capabilities ?? {})}）`,
        );
      }
      await this.fetchAllTools(client);

      // P2 订阅工具清单变更：server 显式声明了才订（未声明 = 协议上不会发，订了空转）。
      // 回调只负责「通知到了」，重取与注册集整换是 runtime 的事（本文件不碰注册面）。
      if (capabilities.tools.listChanged === true) {
        client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
          this.onToolsChanged?.();
        });
      }
    } catch (err) {
      // 失败即清理：握手失败/超时后子进程仍在跑，不关就是孤儿
      await this.close().catch(() => undefined);
      throw err;
    }

    // 断线回调：主动 close 时由 closing 标记过滤，仅「它自己死的」才通知注销
    transport.onclose = () => {
      if (this.closing) return;
      this.logger?.warn(`[MCP:${this.name}] 连接意外断开，其工具将从模型可见列表注销`);
      this.onClosed?.();
    };

    return this.tools;
  }

  /** 当前工具清单（派生缓存，只读） */
  listTools(): readonly McpTool[] {
    return this.tools;
  }

  /**
   * 重取工具清单并更新缓存（P2：`list_changed` 通知后由 runtime 调用）
   *
   * 与 connect 的首发现共用同一条拉取链路（分页 / 超时 / 收口告警），失败抛错——
   * 调用方（runtime 的 resync）负责保留旧注册集，本方法不半吊子更新。
   *
   * @returns 新清单（同时写进 this.tools 缓存）
   */
  async refreshTools(): Promise<McpTool[]> {
    const client = this.client;
    if (!client || this.closing) {
      throw new Error(`MCP server「${this.name}」连接不可用`);
    }
    return this.fetchAllTools(client);
  }

  /**
   * 拉全分页工具清单 + 同步缓存（connect 首发现与 refreshTools 重取共用）
   *
   * 收口告警也在这里：重复 cursor / 撞页数上限都记日志（事后审查发现 ③：
   * JSDoc 承诺「告警」必须有实现通道，勿只在注释里写）。
   *
   * @param client 已连接的 SDK 客户端
   */
  private async fetchAllTools(client: Client): Promise<McpTool[]> {
    const collected = await collectAllTools(async (cursor) => {
      const page = await withTimeout(
        cursor ? client.listTools({ cursor }) : client.listTools(),
        LIST_TOOLS_TIMEOUT_MS,
        `MCP server「${this.name}」tools/list`,
      );
      return { tools: page.tools, nextCursor: page.nextCursor };
    });
    if (collected.stopped) {
      this.logger?.warn(
        `[MCP:${this.name}] tools/list 分页异常收口（${collected.stopped.reason}，` +
          `共 ${collected.stopped.pages} 页 / ${collected.tools.length} 个工具，可能未拉全）`,
      );
    }
    this.tools = collected.tools;
    return collected.tools;
  }

  /**
   * 转发一次工具调用
   *
   * 用 server 原始工具名（派生名只在宿主内部用于寻址与展示）。
   * 返回 `unknown`：SDK 的返回是「标准結果 / 兼容旧格式」的联合类型，形状收窄交给
   * resultNormalizer.normalizeToolResult（那里按内容逐项判别，不在这里断言）。
   *
   * 超时守护（切片 3a）：`withTimeout` 包住转发，超时抛错 = 本次调用失败（内核包成
   * 工具错误），连接不断（server 卡死不应顺带杀掉它其余能力）。
   *
   * @param originalName server 侧的原始工具名
   * @param args 已由内核校验/修正过的参数
   * @param timeoutMs 超时覆盖——**仅测试传小值**；生产一律走缺省 `TOOL_CALL_TIMEOUT_MS`，
   *   调用方（runtime）不传第三参
   */
  async callTool(
    originalName: string,
    args: Record<string, unknown>,
    timeoutMs: number = TOOL_CALL_TIMEOUT_MS,
  ): Promise<unknown> {
    const client = this.client;
    if (!client || this.closing) {
      throw new Error(`MCP server「${this.name}」连接不可用`);
    }
    return withTimeout(
      client.callTool({ name: originalName, arguments: args }),
      timeoutMs,
      `MCP server「${this.name}」调用 ${originalName}`,
    );
  }

  /** 关闭连接并杀掉子进程（幂等；任何失败都吞掉——退出路径不因清理失败而卡住） */
  async close(): Promise<void> {
    this.closing = true;
    const client = this.client;
    this.client = null;
    if (client) {
      await client.close().catch((err: unknown) => {
        this.logger?.warn(`[MCP:${this.name}] 关闭连接失败：${String(err)}`);
      });
    }
  }
}
