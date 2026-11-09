/**
 * MCP 配置判据（语法合法性 + 可启动集收敛）
 *
 * **为什么单独成文件**：`runtime.ts` 贴 eslint `max-lines` 1000 的硬闸门；而这两个函数是
 * **纯判据**（不碰运行态、不碰连接），被三个地方共用——启动（`startMcpServers`）、热更
 * （`applyConfigChangeInner`）、设置面板保存（`mcpServerOps`）。判据和编排放一个文件时，
 * 面板为了复用一句校验不得不 import 整个运行时（连带 MCP SDK 进 webview 风险）；拆开后
 * 依赖方向变成「面板 → 判据」，不再反向依赖运行时。
 *
 * **判据只到语法层**：「命令在不在 PATH 里 / 路径指向什么」属于可执行性，归
 * `commandProbe.ts`（要碰文件系统）。两层分开的理由：语法判据要能在 webview 侧复用，
 * 不能带 I/O；可执行性判据只在宿主侧跑。
 */
import type { ILogger } from '@zooique/memora';
// 值导入：问题文案要进面板（用户可见），一律走 l10n 键面，键 = 英文源文案
import * as vscode from 'vscode';
import type { McpServerConfig } from './connectionManager.js';
// 形态取值集合的真源在 shared：类型与本函数的运行期校验都从 MCP_TRANSPORTS 取，
// 不在这里再写一遍 'stdio' | 'http' 字面量（否则加形态时两处各改一半 = 判据散点）。
import { MCP_TRANSPORTS, type McpTransport } from '../../../shared/protocol.js';

/**
 * server 名的**唯一**归一化点（trim；非字符串一律为空）
 *
 * **为什么必须单点**（2026-10-24 实测的 P1）：name 同时充当三样东西——运行态表的键、
 * `appliedConfigs` 的查找键、工具名前缀 `mcp__<server>__<tool>` 的 `<server>`。原先
 * 「写侧用原名、读侧 `trim()`」两边各归一化一半，`{name:"fs "}` 的实际结果是：
 * 连接**建立成功**（`connectCount=1`），状态面却查不到这个键 ⇒ 面板显示「启动失败」，
 * 并给出「可能被重名规则跳过」这句与事实无关的原因。用户会去排查一台好服务器。
 *
 * 归一化只动**内存副本**，不改写用户配置：`indexValidConfigs` 返回的是 `{...config}`
 * 派生的可启动集，落盘原值由 `appliedConfigs` / 面板 DTO 各自保留（面板 DTO 走同一函数，
 * 所以显示与寻址一致）。
 *
 * @param raw 配置里的 name（可能不是字符串）
 * @returns 归一化后的名；非法 = 空串（调用方按「缺 name」处理）
 */
export function normalizeServerName(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * 传输形态解析（**缺省 = stdio**，全库唯一的「缺省值」判据）
 *
 * 单独导出是为了让运行侧（`connectionManager` 分派物理传输）、断线文案（runtime）与
 * 判据（本文件的 `configProblem`）用同一个「缺省 stdio」口径——三处各写一次 `?? 'stdio'`
 * 就是判据散点的起点。
 *
 * @param raw 配置里的 transport 原值（读取点不裁剪 ⇒ 可能是任意脏值）
 * @returns `'stdio'` / `'http'`；未知值（含 `sse`）返回 null（由 `configProblem` 给具体文案）
 */
export function resolveTransportMode(raw: unknown): McpTransport | null {
  if (raw === undefined || raw === null) return 'stdio';
  // 取值集合从 shared 的 MCP_TRANSPORTS 取（区分大小写：'HTTP' 属未知值，不是拼写宽容）
  if (typeof raw !== 'string') return null;
  return MCP_TRANSPORTS.find((mode) => mode === raw) ?? null;
}

/**
 * 值是否「实质填写」（判互斥时用）
 *
 * 空串 / 空数组 / 空对象一律视为「没填」：表单与导入会产出 `args: []` 这类与缺省等价的
 * 噪音，若把它们判成「http 填了 args」，用户会拿到一条自己没写过的错误原因。
 *
 * @param value 任意字段值
 */
function isFilled(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}

/** 回环主机名（`http:` 只对这些地址放行，便于本地网关 / 内网调试） */
const LOOPBACK_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i;

/**
 * 远程 url 的形态校验
 *
 * 三条：必须是合法 URL、只认 http/https、非回环地址强制 https。
 * 「非回环强制 https」不是审美偏好：远程明文传输会把工具参数与结果整段暴露给链路上的
 * 任何人；本地回环没有链路，才允许 http。
 *
 * @param raw 配置里的 url 原值
 * @returns 问题文案；合法返回 null
 */
function urlProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return vscode.l10n.t('Missing url (transport "http" requires a server address)');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return vscode.l10n.t('Invalid url: {0}', raw);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return vscode.l10n.t('url only supports http / https (current: {0})', parsed.protocol);
  }
  if (parsed.protocol === 'http:' && !LOOPBACK_HOST.test(parsed.hostname)) {
    return vscode.l10n.t(
      'Non-loopback addresses must use https (http is allowed only for localhost / 127.0.0.1 / ::1)',
    );
  }
  return null;
}

/**
 * `headers` 的形态校验（对象 + 值均为字符串 + 不含 CR/LF）
 *
 * 为什么必须校验：`readMcpServers` 不做字段裁剪（既有定案），用户手写 settings.json 时
 * 这里可能是任意 JSON —— 直接透传给 `fetch` 会得到难排查的运行时错误。CR/LF 单独禁止
 * 是因为它们能注入额外请求头（头拆分），属于要去掉的形态而不是留给 SDK 兜底。
 *
 * @param raw 配置里的 headers 原值
 * @returns 问题文案；合法（含缺省）返回 null
 */
function headersProblem(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return vscode.l10n.t('headers must be an object of { "name": "value" } pairs');
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (/[\r\n]/.test(key)) {
      return vscode.l10n.t('headers name must not contain line breaks: {0}', JSON.stringify(key));
    }
    if (typeof value !== 'string') {
      return vscode.l10n.t('headers value must be a string ({0} is not)', key);
    }
    if (/[\r\n]/.test(value)) {
      return vscode.l10n.t('headers value must not contain line breaks ({0})', key);
    }
  }
  return null;
}

/**
 * 校验一条配置的**语法**是否完整（能不能进运行时）
 *
 * **导出理由（判据单点）**：设置面板的「保存」校验与启动侧的跳过判据必须是同一句
 * （`mcpServerOps` 直接复用本函数）。各写一份 = 面板能存进一条永远起不来的配置，
 * 或者反过来挡住一条合法配置——两种都是判据散点。
 *
 * 判据按传输形态分派（J2：一份配置一种形态）：
 *   - `transport` 缺省 = stdio；`stdio` 必填 `command`，禁填 `url` / `headers`；
 *   - `http` 必填 `url`（形态见 {@link urlProblem}），禁填 `command` / `args` / `env` / `cwd`；
 *   - 跨形态字段**报错而不是静默忽略**：忽略会让用户以为字段生效了；
 *   - 未知 `transport`（含 `sse`）点名说清，不退化成「语法错误」。
 *
 * 注意：名字/命令的**前后空白**在这里判为空（`'  '` 算缺），但不会帮你 trim 后写回——
 * 归一化不是判据的职责，见 {@link normalizeServerName}。
 *
 * @param config 用户配置项
 * @returns 不可用原因；可用时返回 null
 */
export function configProblem(config: McpServerConfig): string | null {
  if (normalizeServerName(config.name).length === 0) {
    return vscode.l10n.t('Missing name');
  }

  // 手写 `type` 的指路：本仓只认 transport（别名只在导入通道映射一次）。
  // 必须读原始对象：`type` 刻意不在 DTO 上，写上来就是用户手改 settings.json 的形态。
  const rawType = (config as unknown as Record<string, unknown>).type;
  if (rawType !== undefined) {
    return vscode.l10n.t(
      'Unknown field type: this setting only accepts transport ("stdio" / "http"); paste external fragments via "Import from JSON" in the panel',
    );
  }

  const rawTransport: unknown = config.transport;
  const mode = resolveTransportMode(rawTransport);
  if (mode === null) {
    if (typeof rawTransport === 'string' && rawTransport.trim().toLowerCase() === 'sse') {
      return vscode.l10n.t(
        'SSE transport is not supported (decided against, see design doc §5.5-1); use transport: "http" for remote servers',
      );
    }
    return vscode.l10n.t(
      'Unknown transport value {0} (only "stdio" / "http" are supported)',
      JSON.stringify(rawTransport),
    );
  }

  if (mode === 'http') {
    const problem = urlProblem(config.url);
    if (problem) return problem;
    if (isFilled(config.command)) {
      return vscode.l10n.t(
        'http config must not set command (a remote server spawns no local process)',
      );
    }
    if (isFilled(config.args)) {
      return vscode.l10n.t(
        'http config must not set args (a remote server spawns no local process)',
      );
    }
    if (isFilled(config.cwd)) {
      return vscode.l10n.t(
        'http config must not set cwd (a remote server spawns no local process)',
      );
    }
    if (isFilled(config.env)) {
      return vscode.l10n.t(
        'http config must not set env (environment variables take no effect for a remote server)',
      );
    }
    return headersProblem(config.headers);
  }

  // stdio（缺省形态）：原有判据一字未改，只补「远程字段不许混进来」
  if (typeof config.command !== 'string' || config.command.trim().length === 0) {
    return vscode.l10n.t('Missing command');
  }
  if (isFilled(config.url)) {
    return vscode.l10n.t(
      'stdio config must not set url (use transport: "http" to connect to a remote server)',
    );
  }
  if (isFilled(config.headers)) {
    return vscode.l10n.t(
      'stdio config does not support headers (request headers only apply to transport: "http")',
    );
  }
  return null;
}

/**
 * 把用户配置收敛为「可启动集」（首装与热更共用的单点）
 *
 * 三条规则与首装历史口径一致：非法配置（缺 name/command）跳过并告警；`enabled: false`
 * 不启动（静默——用户显式停用，不该每次激活都告警）；重名**先到先得**
 * （工具名前缀按 server 名派生，后到的会与先到的撞名 → 直接跳过更诚实）。
 *
 * **键与下传的 config.name 都取 {@link normalizeServerName}**：运行态表、失败表、状态面
 * 三处寻址同一个键。返回的是派生副本（`name` 已归一化），用户落盘配置不被改写。
 * 归一化后 `"fs"` 与 `"fs "` 算重名——这正是先到先得要覆盖的情形（原先两者键不同，
 * 都会启动，但状态面只显示一条，另一条成了看不见的幽灵子进程）。
 *
 * @param configs 用户配置原值
 * @param logger 告警通道（缺省不记）
 * @returns name → 配置（保序：配置顺序即启动顺序）
 */
export function indexValidConfigs(
  configs: readonly McpServerConfig[],
  logger?: ILogger,
): Map<string, McpServerConfig> {
  const valid = new Map<string, McpServerConfig>();
  for (const config of configs) {
    const problem = configProblem(config);
    if (problem) {
      logger?.warn(`[MCP] 跳过非法配置（${problem}）：${JSON.stringify(config)}`);
      continue;
    }
    if (config.enabled === false) continue;
    const name = normalizeServerName(config.name);
    if (valid.has(name)) {
      logger?.warn(`[MCP] server 名重复，跳过后者：${name}`);
      continue;
    }
    valid.set(name, { ...config, name });
  }
  return valid;
}
