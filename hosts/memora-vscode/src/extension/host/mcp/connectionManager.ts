/**
 * MCP 连接管理器（**客户端侧**）— stdio / Streamable HTTP 双传输 + 协议协商 + 工具发现（含分页）
 *
 * 职责边界（方案-MCP工具接入 §6）：
 *   - 只做「拉起子进程 / 连接远程 / 握手 / 拉工具清单 / 转发调用 / 订阅清单变更 / 关闭」几件事；
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
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  ToolListChangedNotificationSchema,
  type Tool as McpTool,
} from '@modelcontextprotocol/sdk/types.js';
import type { ILogger } from '@zooique/memora';
import { probeCommand } from './commandProbe.js';
import { resolveTransportMode } from './mcpConfigGuard.js';
// 配置形状真源在 shared（webview 要画编辑表单，不能 import 本模块——会把 MCP SDK 拖进
// webview bundle）⇒ 本接口只 extends、不重复定义字段，加字段必两边同源。
import type { McpServerDraftDto, McpTransport } from '../../../shared/protocol.js';

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
 * 授权定案只认用户级设置（方案 §4.4，2026-10-25；重开须先改该章判据）。
 *
 * `command` 不再覆写为必填：远程（`transport: http`）配置没有命令。完整性判据
 * 统一在 `configProblem`，本接口不重复声明（避免「类型说必填、判据说可选」的双真源）。
 */
export interface McpServerConfig extends McpServerDraftDto {
  /** server 名（进工具名前缀，须唯一；重复配置在启动时按先到先得并告警） */
  name: string;
}

/**
 * 传输工厂（**仅测试注入**）
 *
 * 生产缺省按 `transport` 分派真实 stdio / HTTP 传输。测试用假工厂可以只验证「分派到了哪个
 * 形态」，而不必真起子进程或真连远端——两件事都比分派判据贵得多，且会把网络/环境噪声
 * 带进单测。
 */
export type McpTransportFactory = (mode: McpTransport) => Transport;

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

/** 失败原因里附带的 stderr 尾部行数（面板单行展示；runtime 侧还会截到 300 字符） */
const STDERR_TAIL_LINES = 3;
/** stderr 单行保留上限（防止一行巨型堆栈把原因撑爆） */
const STDERR_TAIL_LINE_MAX = 200;

/**
 * 把 stderr 尾部拼进失败原因
 *
 * 原地改 `err.message` 而不是包一层新 Error：SDK 的 `McpError` 带 `code = -32000`，
 * 换壳会丢 code（将来要按码分流就没得用）。面板只读 message，拼接不影响其余语义。
 *
 * @param err 原始错误（SDK / spawn / 超时）
 * @param tail stderr 尾部行
 */
function withStderrTail(err: unknown, tail: readonly string[]): Error {
  if (tail.length === 0) return err instanceof Error ? err : new Error(String(err));
  const suffix = `｜子进程输出：${tail.join(' │ ')}`;
  if (err instanceof Error) {
    err.message = `${err.message}${suffix}`;
    return err;
  }
  return new Error(`${String(err)}${suffix}`);
}

/**
 * 判断失败是否由「服务器要求授权」引起（HTTP 401）
 *
 * SDK 在没有 `authProvider` 时把 401 抛成普通 HTTP 错误（`StreamableHTTPError.code = 401`），
 * 文案若照抄会变成 `Error POSTing to endpoint: ...` ⇒ 用户去查 url 拼写，而真正该做的是登录。
 * 只认 401：403 可能是权限不足而非未授权，收进来会把两类原因混成一个。
 *
 * @param err 连接/握手抛出的错误
 */
function isUnauthorizedError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return code === 401 || code === '401';
}

/**
 * 解码子进程 stderr
 *
 * 中文 Windows 的 cmd 报错是 **GBK**（`'xxx' 不是内部或外部命令`），按 utf8 解会得到满屏
 * `U+FFFD` —— 用户看到的"错误原因"等于没有（2026-10-24 实测：路径写错时 stderr 全是乱码，
 * 而面板上只有 `MCP error -32000: Connection closed`）。utf8 解出替换字符时改用 gbk 重解
 * （Node 22 内置 ICU 支持，实测 `d6 d0 ce c4` → 「中文」）。
 *
 * @param chunk 子进程 stderr 原始字节
 */
function decodeStderr(chunk: Buffer): string {
  const utf8 = chunk.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gbk').decode(chunk);
  } catch {
    return utf8;
  }
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

  /** stderr 尾部环形缓冲（失败时附进原因；成功路径不读它） */
  private readonly stderrTail: string[] = [];

  constructor(
    config: McpServerConfig,
    logger?: ILogger,
    clientVersion = '0.0.0',
    /**
     * 相对路径基准（工作区根）
     *
     * 只有本类（真连接）需要它：`connect` 开头用 {@link probeCommand} 把相对 `command` /
     * 相对 `cwd` 解析成绝对路径，并把「必然失败」翻译成人话。测试注入的假连接忽略此参。
     */
    private readonly baseDir?: string,
    /**
     * 传输工厂（**仅测试注入**）
     *
     * 缺省 = 按 `transport` 分派真实 stdio / HTTP 传输。注入后仍走同一条「握手 → 能力断言 →
     * 拉工具 → 订阅」的共用链路，只有物理传输被替换——分派判据不因测试而分叉。
     */
    private readonly transportFactory?: McpTransportFactory,
  ) {
    this.name = config.name;
    this.config = config;
    this.logger = logger;
    this.clientVersion = clientVersion;
  }

  /** 本连接的传输形态（判据单点 = `resolveTransportMode`；未知值属不可达状态，直接拒连） */
  private transportMode(): McpTransport {
    const mode = resolveTransportMode(this.config.transport);
    if (mode === null) {
      throw new Error(`配置无法启动：未知的 transport 值（server「${this.name}」）`);
    }
    return mode;
  }

  /**
   * 按形态创建物理传输（**连接层唯一分派点**）
   *
   * 握手之后的逻辑（能力断言 / 分页 / 订阅 / 断线回调）两个分支完全共用，不复制第二份——
   * 复制会让「远程少订阅一次」「远程漏分页」这类差异静默存在。
   *
   * @param mode 已解析的传输形态
   */
  private createTransport(mode: McpTransport): Transport {
    if (this.transportFactory) return this.transportFactory(mode);
    return mode === 'http' ? this.createHttpTransport() : this.createStdioTransport();
  }

  /**
   * stdio 分支：命令预检 → 拉起子进程 → 接管 stderr
   *
   * 预检刻意留在**分支内**而不是 `connect` 开头：远程没有「命令在不在 PATH」这回事，
   * 上提后每一台远程 server 都会先过一遍本地命令检查（必然误报）。
   */
  private createStdioTransport(): Transport {
    const config = this.asStdioConfig();
    // 拉起前预检：命令/路径不对时**先别 spawn**。
    // 不预检的后果（2026-10-24 实测）：命令不存在、把脚本当命令、脚本路径写错、漏写 node
    // 前缀，SDK 一律抛 `MCP error -32000: Connection closed`，真原因只在 stderr。
    // 预检同时产出**解析后的**可执行形态——判据与实现用同一份解析结果，不允许
    // 「判的时候按工作区根解析、拉的时候按进程 cwd 解析」（那是「校验通过却起不来」的成因）。
    const probe = probeCommand({
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      ...(this.baseDir ? { baseDir: this.baseDir } : {}),
    });
    if (!probe.ok) {
      throw new Error(`配置无法启动：${probe.problem}`);
    }

    // env 合并默认安全环境：只给用户 env 会丢掉 PATH（子进程直接 ENOENT），
    // 故以 getDefaultEnvironment() 为底、用户键覆盖其上。
    const transport = new StdioClientTransport({
      command: probe.resolved.command,
      args: [...probe.resolved.args],
      cwd: probe.resolved.cwd,
      env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
      // stderr 接管为管道：server 的诊断输出进宿主日志（用户可在 Memora 输出面板看到），
      // 不污染扩展宿主的 stderr
      stderr: 'pipe',
    });

    // 子进程 stderr 逐行进日志（debug 级：server 正常也会打印启动信息）
    //
    // 同时留尾部几行：spawn 失败 / 脚本路径写错时，SDK 只抛 `MCP error -32000: Connection
    // closed`，真原因（`Cannot find module ...` / `'xxx' 不是内部或外部命令`）**只出现在
    // stderr**。不留尾部 ⇒ 面板上永远是一句「连接已关闭」，用户无从判断是路径问题。
    //
    // ⚠️ 这段只能在 stdio 分支：HTTP transport 上没有 stderr 字段，若写成共用段并对
    // `transport` 做 `as StdioClientTransport` 断言，远程接上去的那一刻就是 TypeError。
    transport.stderr?.on('data', (chunk: Buffer) => {
      const text = decodeStderr(chunk).trimEnd();
      if (!text) return;
      this.logger?.debug(`[MCP:${this.name}] ${text}`);
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.stderrTail.push(
          trimmed.length > STDERR_TAIL_LINE_MAX
            ? `${trimmed.slice(0, STDERR_TAIL_LINE_MAX)}…`
            : trimmed,
        );
        if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
      }
    });
    return transport;
  }

  /**
   * HTTP 分支：连接远程 Streamable HTTP 服务器
   *
   * `headers` 是用户自填、随设置落盘的静态请求头（J3）；OAuth 令牌**不**走这里（S2 的
   * `authProvider` 从 SecretStorage 取）。空对象不下传——与缺省等价，避免给 SDK 一个假配置。
   */
  private createHttpTransport(): Transport {
    const config = this.asHttpConfig();
    const headers = config.headers;
    return new StreamableHTTPClientTransport(
      new URL(config.url),
      headers && Object.keys(headers).length > 0
        ? { requestInit: { headers: { ...headers } } }
        : {},
    );
  }

  /**
   * 类型收窄 + **存在性守卫**（不是第二套判据）
   *
   * 完整性裁决只归 `configProblem`；这里只保证「直接 new 的连接」不会把 `undefined` 塞进
   * SDK（那会得到一句与真实原因无关的 `Invalid URL` / `spawn undefined`）。刻意不重复
   * 校验 url 协议、headers 形态等——两套判据迟早给出两套结论。
   */
  private asStdioConfig(): McpServerConfig & { command: string } {
    if (typeof this.config.command !== 'string' || this.config.command.trim().length === 0) {
      throw new Error(`配置无法启动：缺少 command（server「${this.name}」）`);
    }
    return this.config as McpServerConfig & { command: string };
  }

  /** `asStdioConfig` 的远程对应物（只守 url 在不在） */
  private asHttpConfig(): McpServerConfig & { url: string } {
    if (typeof this.config.url !== 'string' || this.config.url.trim().length === 0) {
      throw new Error(`配置无法启动：缺少 url（server「${this.name}」）`);
    }
    return this.config as McpServerConfig & { url: string };
  }

  /**
   * 失败归因（按形态分派文案，禁一套说法通吃两种代价）
   *
   * - stdio：把子进程 stderr 尾部拼进原因（`-32000: Connection closed` 单独出现等于没说话）；
   * - http：401 归「要求授权」（S2 才有 OAuth），其余原样——远程没有子进程，不存在 stderr。
   *
   * @param err 原始错误
   * @param mode 传输形态
   */
  private connectFailure(err: unknown, mode: McpTransport): Error {
    if (mode === 'stdio') return withStderrTail(err, this.stderrTail);
    if (isUnauthorizedError(err)) {
      return new Error('服务器要求授权（OAuth 支持在后续版本）');
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  /**
   * 连接并完成握手 + 首次工具发现（stdio 拉起子进程 / http 连接远程）
   *
   * 能力断言（P4）：SDK 承担 `initialize` 协商，但「server 有没有 tools 能力」必须显式读——
   * 不能假设所有 server 都暴露工具。没有该能力直接判失败，避免注册出 0 工具的空壳。
   *
   * @returns 发现到的工具清单
   * @throws 连接/握手/发现任一环节失败（含超时）；抛出前已关闭连接，不留孤儿进程
   */
  async connect(): Promise<McpTool[]> {
    // 尾部缓冲每次连接从零开始（同一实例重复 connect 时不累积上一次的输出）
    this.stderrTail.length = 0;

    const mode = this.transportMode();
    // 传输创建可能抛（stdio 预检 / 字段缺失）——此时还没有 client，无需清理
    const transport = this.createTransport(mode);
    // 客户端能力声明为空对象 = 明确不声明 elicitation / sampling / roots（方案 §7 P6：不支持即不声明）
    const client = new Client(
      { name: 'memora-vscode', version: this.clientVersion },
      { capabilities: {} },
    );
    this.client = client;

    try {
      await withTimeout(
        client.connect(transport),
        CONNECT_TIMEOUT_MS,
        `MCP server「${this.name}」握手`,
      );
      // P4 能力断言：本宿主只接 tools 能力（resources / prompts 未接入 = 已登记边界，
      // 见方案 §10）。没有 tools 的 server 无工具可注册，仍按失败处理（不静默注册空清单）；
      // 但归因必须落在宿主——纯资源 server 是合法形态，说成「server 未声明能力」会让人
      // 去查一台没坏的 server（2026-10-25 归因订正，谎报成因与谎报能力同族）。
      const capabilities = client.getServerCapabilities();
      if (!capabilities?.tools) {
        const declared = Object.keys(capabilities ?? {});
        const nonTool = declared.filter((key) => key !== 'tools');
        throw new Error(
          nonTool.length > 0
            ? `本宿主当前只接 tools 能力；该 server 只提供 ${nonTool.join(' / ')}，暂不支持（不是 server 故障）`
            : '该 server 未声明任何能力（本宿主当前只接 tools）',
        );
      }
      // 未消费能力不静默：每台 server 连上时记一次，否则用户只会看到「资源/提示没出现」。
      const unhandledCapabilities = (['resources', 'prompts'] as const).filter(
        (key) => capabilities[key] !== undefined,
      );
      if (unhandledCapabilities.length > 0) {
        this.logger?.info(
          `[MCP:${this.name}] 本宿主未接入 ${unhandledCapabilities.join(' / ')} 能力（只接 tools），工具清单照常注册`,
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
      // 远程首连记一条 info：连接目标（域名）与本地子进程不同质，用户事后审计要能定位
      // 数据发去了哪里；stdio 分支的「已接入」日志由 runtime 统一打，不在这里重复。
      if (mode === 'http') {
        this.logger?.info(`[MCP:${this.name}] 已连接远程服务器 ${this.config.url ?? ''}`);
      }
    } catch (err) {
      // 失败即清理：握手失败/超时后子进程仍在跑，不关就是孤儿
      await this.close().catch(() => undefined);
      throw this.connectFailure(err, mode);
    }

    // 断线回调：主动 close 时由 closing 标记过滤，仅「它自己死的」才通知注销。
    // S1 **不自动重连**：远程断流即失败 + 注销工具（恢复入口 = 改配置或重载窗口，S3 给按钮）。
    transport.onclose = () => {
      if (this.closing) return;
      this.logger?.warn(
        mode === 'http'
          ? `[MCP:${this.name}] 与远程服务器的连接已断开，其工具将从模型可见列表注销`
          : `[MCP:${this.name}] 连接意外断开，其工具将从模型可见列表注销`,
      );
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
