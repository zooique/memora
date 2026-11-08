/**
 * 路径白名单 + 审计日志
 * 4 类允许根 + 28 类禁止规则。
 * 写入需二次确认 + 审计日志：未注入 confirmationHandler 时 fail-closed 拒绝写入。
 * 内核纯逻辑库不依赖交互式终端 I/O，宿主应通过 onWriteConfirmation() 注入自己的确认 UI。
 */
import { resolve, sep, dirname, basename, join } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { logger } from '@/logging/logger.js';
import { securityError } from '@/utils/errors.js';
import { toError } from '@/utils/toError.js';
import { expandHome } from '@/utils/path.js';
import { nowIso } from '@/utils/time.js';
// 白名单上限与配置校验共用同一常量（config 是基础层，security 可依赖；禁止同值手抄两份）
import { MAX_ALLOWED_PATHS } from '@/config/loader.js';

/**
 * 解析符号链接后的真实绝对路径（**导出**：安全判据面的一部分）。
 *
 * 安全考量：不解析符号链接时，攻击者可用项目内指向 /etc 的符号链接绕过白名单前缀匹配访问任意系统目录（路径穿越逃逸）。
 * 不存在时（写新文件）逐级向上解析已存在父目录再拼接；全程不存在时回退 resolve()（白名单/黑名单仍兜底校验）。
 *
 * 为什么导出：其他安全闸（如常驻规则读盘前的符号链接逃逸复核）必须复用**这一份实现**；
 * 复制第二份 realpath 实现 = 双真源，两份语义从落笔那刻起就会漂移。
 *
 * @param p 待解析的路径（可非绝对，内部先 resolve）
 * @returns 解析后的绝对路径；路径/祖先均不存在时返回逐级回退拼接的结果
 */
export function resolveRealpath(p: string): string {
  const resolved = resolve(p);
  try {
    return realpathSync(resolved);
  } catch {
    // 路径不存在：递归解析已存在的父目录
    const parent = dirname(resolved);
    // 终止条件：已到根且根也不存在（未挂载盘符 `Z:\` / 不可达 UNC 共享）。
    // Windows 根的 dirname 自指（`dirname('Z:\\') === 'Z:\\'`），不判等会无限递归直至栈溢出
    // ——配置里写一个不存在的盘符即可触发，判据是「dir 不再变短」而非「存在性」。
    if (parent === resolved) return resolved;
    const base = basename(resolved);
    try {
      const realParent = realpathSync(parent);
      return join(realParent, base);
    } catch {
      // 父目录也不存在：继续向上递归
      const realGrandParent = resolveRealpath(parent);
      return join(realGrandParent, base);
    }
  }
}

/** 凭据 / 系统敏感路径黑名单（**唯一真源**；对外只经下方判据函数使用，禁止复制第二份） */
const BLOCKED_PATTERNS = [
  // 系统凭证文件（跨平台，路径段匹配）
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.gnupg([\\/]|$)/i,
  /(^|[\\/])\.netrc$/i,
  /(^|[\\/])\.pgpass$/i,
  // 包管理器凭证：多为明文存储，可含推发令牌
  /(^|[\\/])\.gitconfig$/i,
  /(^|[\\/])\.git-credentials$/i,
  /(^|[\\/])\.npmrc$/i,
  /(^|[\\/])\.pypirc$/i,
  /(^|[\\/])\.gem[\\/]credentials$/i,
  /(^|[\\/])\.composer[\\/]auth\.json$/i,
  /(^|[\\/])\.htpasswd$/i,
  // Linux/macOS 系统账户文件
  /[\\/]etc[\\/]passwd/i,
  /[\\/]etc[\\/]shadow/i,
  /[\\/]etc[\\/]gshadow/i,
  /[\\/]etc[\\/]sudoers/i,
  // 云服务与容器凭证
  /(^|[\\/])\.aws([\\/]|$)/i,
  /(^|[\\/])\.azure([\\/]|$)/i,
  /(^|[\\/])\.docker([\\/]|$)/i,
  /(^|[\\/])\.kube([\\/]|$)/i,
  /(^|[\\/])\.config[\\/]gcloud([\\/]|$)/i,
  // 环境变量文件（.env / .env.local / .env.production.local 等多段后缀；.envrc 独立于 .env.* 后缀模式）
  /(^|[\\/])\.env(\.[^\\/]+)?$/i,
  /(^|[\\/])\.envrc$/i,
  // Windows 系统目录
  /[\\/]Windows([\\/]|$)/i,
  /[\\/]Program Files([\\/]|$)/i,
  /[\\/]Program Files \(x86\)([\\/]|$)/i,
  /[\\/]ProgramData([\\/]|$)/i,
  // Linux/macOS 系统目录（根目录锚定 ^/，避免误伤项目内同名目录）
  /^\/(etc|usr|bin|sbin|var|root|home|lib|lib64|opt)([\\/]|$)/i,
  // 虚拟文件系统 + 启动目录（根目录锚定）
  /^\/(proc|sys|boot)([\\/]|$)/i,
];

/**
 * 凭据 / 系统敏感路径判据（**唯一匹配点**，导出供其他安全闸复用）
 *
 * 入参必须是**已经 NFKC 规范化 + realpath 解析**的路径（本函数不再做这两步，
 * 因为调用方 SecurityGuard 需要复用同一个 resolved 值落审计、避免二次磁盘 IO）。
 * 需要「从任意绝对路径直接判定」的场景用 `isBlockedPath`。
 *
 * @param resolvedPath 已规范化的真实绝对路径
 * @returns 命中的黑名单模式；未命中返回 undefined（调用方据此落审计原因）
 */
export function matchBlockedPathPattern(resolvedPath: string): RegExp | undefined {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(resolvedPath)) return pattern;
  }
  return undefined;
}

/**
 * 凭据 / 系统敏感路径组合判据（任意绝对路径 → NFKC + realpath + 黑名单）
 *
 * 供**不持有 SecurityGuard** 的安全闸复用（如常驻规则读盘前的凭据路径拒绝）。
 * 判据实现全部委托给 `resolveRealpath` 与 `matchBlockedPathPattern`，
 * 本函数只做组合——禁止在此复制正则表或 realpath 逻辑（双真源）。
 *
 * ⚠️ 射程：只匹配**路径**；文件正文里写死的 token / 私钥不在本判据内。
 *
 * @param absolutePath 待判定的绝对路径（可含符号链接）
 * @returns true = 命中黑名单（应拒绝读取 / 写入）
 */
export function isBlockedPath(absolutePath: string): boolean {
  // NFKC 规范化：与 assertPathAllowed 同款，防全角字符绕过正则
  const normalized = absolutePath.normalize('NFKC');
  // 符号链接真实化：保证判定的是实际访问目标
  const resolved = resolveRealpath(normalized);
  return matchBlockedPathPattern(resolved) !== undefined;
}

/**
 * 额外白名单最大条数 = `config/loader.ts` 的 `MAX_ALLOWED_PATHS`（同一常量，非同值副本）。
 *
 * ⚠️ 超限**如实报错**（不静默截断）：截断会让用户以为目录已放行、实际写入被拒，
 * 一句不成立的假承诺比直接失败更坏。
 *
 * 白名单射程（2026-11-03 起）：`allowedPaths` 只含项目级路径——LLM 只写项目级；
 * 用户级资产仅保留**读取**（仍进池、可选中），写权限已收回。
 * **不承诺**用户级资产受保护：`run_code` / `run_skill_script` / `run_project_script`
 * 等代码执行面仍可绕过路径判据。
 */

// ─── 命令裁决（run_command 安全边界，§13.2）───

/** 命令裁决三档 */
export type CommandVerdict =
  /** 恒拦：无正当 agent 场景的破坏性命令 */
  | 'deny'
  /** 恒弹确认：正当但不可逆（git 写操作、发布类），不可被豁免 */
  | 'always-ask'
  /** 普通：走常规确认判据（guest / confirmScripts） */
  | 'normal';

/**
 * 命令黑名单（**恒拦**，不进确认流程）
 *
 * 收录标准：不存在「agent 正当使用」场景的破坏性命令——拦掉不影响任何合理任务，
 * 漏掉则不可逆（数据/系统级）。可逆或有正当场景的写操作走 ALWAYS_ASK，不在此列。
 *
 * 匹配形态：**全文 test**（不锚定开头）——shell 复合命令（`echo hi && rm -rf /`）
 * 里真正执行的是后半段，锚定开头等于给绕过送路。
 */
const BLOCKED_COMMAND_PATTERNS: RegExp[] = [
  // 递归强删根目录 / 家目录 / 通配符（项目内受限删除由用户自行确认，不在此列）
  /rm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+(\/|\*|~|~\/)/i,
  /rm\s+-rf\s+(\/|\*|~)/i,
  // PowerShell 递归强删。两个前瞻断言**顺序无关**——写成
  // `-Recurse.*-Force` 会漏掉 `-Force -Recurse`（选项顺序由用户决定，不由我们决定）
  /Remove-Item(?=[^;&|]*-Recurse)(?=[^;&|]*-Force)/i,
  // 磁盘格式化 / 覆写
  /format\s+[a-z]:/i,
  /mkfs(\.[a-z0-9]+)?\b/i,
  /dd\s+if=/i,
  // fork bomb（:(){ :|:& };:）
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/,
];

/**
 * 恒询问前缀（ALWAYS_ASK）：正当但不可逆
 *
 * 定案理由（§13.2）：deny 会让 agent 从此无法 `git commit`（高频正当操作）；
 * 本仓血训（Windows git 写操作污染索引）的正确对策是**每次都问且不可豁免**，
 * 不是永远禁跑。故这类进 ALWAYS_ASK 而非 deny。
 *
 * ⚠️ 清单**只增不减**（回归测试锁定内容）。
 */
const ALWAYS_ASK_COMMAND_PREFIXES: string[] = [
  'git commit',
  'git push',
  'git reset',
  'git rebase',
  'git merge',
  'git checkout --',
  /**
   * `git clean`（2026-10-25 补）：**删除未跟踪文件**——与 reset / checkout -- 同量级的
   * 不可逆操作，此前**不在清单内** ⇒ 落 `normal` 档 = owner 默认直接执行（真洞，不是定案）。
   * 补进来后 `-fd` / `-fxd` 各形态均恒弹（两段式条目允许插入全局选项）。
   */
  'git clean',
  'npm publish',
];

/**
 * 命令分隔符边界（shell 复合命令的切分点）
 *
 * 用途：把「命令是否**以** X 开头」升级为「命令**是否包含** X」——判据本身没变
 * （这条命令会不会做 git 写操作），变的是**匹配形态**。前缀锚定在复合命令下形同虚设：
 * `echo hi && git push` / `cd /tmp && git reset --hard` 会整条落到 normal 档直接放行。
 *
 * ⚠️ 不做完整 shell 词法解析（引号 / 转义 / 变量展开）：那会把裁决链变成半个 shell 解释器，
 * 复杂度和出错面都不可控。此处只做**保守匹配**——宁可多弹一次确认（偏保守方向），
 * 也不可漏判。已知代价：`echo "git push"` 会被多问一次（误报方向安全）。
 */
const COMMAND_SEGMENT_BOUNDARY = String.raw`(?:^|[\n;&|]|\(|\)|\{|\})`;

/**
 * 恒询问清单 → 判据用模式（**构造级派生**，唯一匹配点）
 *
 * 由 `ALWAYS_ASK_COMMAND_PREFIXES` 派生而非另写一张正则表：两份清单必然漂移
 * （改一处忘另一处 = 安全边界出现静默缺口，且没有任何测试会红）。
 * 构造期一次性生成，运行时零成本。清单**只增不减**由回归测试锁定。
 *
 * **两段式条目允许插入全局选项**（`git -C /other/repo push`）：git 的 `-C <path>` /
 * `-c k=v` / `--git-dir=<p>` 插在子命令前是常规用法，不留这个口子等于本仓血训
 * （Windows git 写操作）照旧可绕。三段式及以上（`git checkout --`）原样匹配——
 * 其尾部 token（`--`）本身是语义标记，插 gap 会让模式失真。
 */
const ALWAYS_ASK_COMMAND_PATTERNS: RegExp[] = ALWAYS_ASK_COMMAND_PREFIXES.map((prefix) => {
  const escape = (token: string): string => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const [program, ...rest] = prefix.split(' ');
  const allowGlobalOptions = rest.length === 1;
  // 全局选项段：`-{1,2}<flag>` 后可跟一个独立参数（`-C <path>`）或 `=` 值（`--git-dir=<p>`）
  const gap = allowGlobalOptions ? String.raw`(?:\s+-{1,2}\S+(?:=\S+|\s+\S+)?)*` : '';
  const body = allowGlobalOptions
    ? String.raw`\s+${escape(rest[0]!)}`
    : String.raw`\s+${rest.map(escape).join(String.raw`\s+`)}`;
  return new RegExp(
    String.raw`${COMMAND_SEGMENT_BOUNDARY}\s*${escape(program!)}${gap}${body}(?![A-Za-z0-9_-])`,
    'i',
  );
});

/**
 * 命令裁决（纯函数，命令安全边界的**唯一判据**；§13.2）
 *
 * 顺序不可颠倒：deny 优先于 always-ask（一条命令同时命中时以最严为准）。
 * NFKC 规范化与路径黑名单同款，防全角字符绕过正则。
 */
export function classifyCommand(command: string): CommandVerdict {
  const normalized = command.normalize('NFKC').trim();
  for (const pattern of BLOCKED_COMMAND_PATTERNS) {
    if (pattern.test(normalized)) return 'deny';
  }
  for (const pattern of ALWAYS_ASK_COMMAND_PATTERNS) {
    if (pattern.test(normalized)) return 'always-ask';
  }
  return 'normal';
}

export type Permission = 'owner' | 'guest';
export type WriteDecision = 'confirmed' | 'declined' | 'auto-approved' | 'auto-denied';

export interface AuditEvent {
  /**
   * 事件类型：路径允许/拒绝；确认决策（写入 / 命令 / 代码 / 脚本执行 / 自定义工具）。
   * `write-*` 三值是历史命名：confirmGate 承载全部五类确认，非写入类请求同样落这三值
   * （见 confirmGate）；改名 = 破坏性公共面变更，收益仅为命名纯度 ⇒ 保留旧名。
   */
  type: 'path-allow' | 'path-deny' | 'write-confirm' | 'write-decline' | 'write-auto';
  /** 被裁决对象标识：写入类 = 目标文件绝对路径；命令/代码/脚本 = 命令字面量或目标标识；自定义工具 = 调用摘要 */
  path: string;
  /** 工具名（read_file / write_file / 自定义工具名） */
  tool?: string;
  /** 调用链来源，标记安全检查的触发方 */
  source?: 'builtin' | 'custom' | 'system';
  /** 用户决策（写入二次确认场景） */
  decision?: WriteDecision;
  /** 拒绝原因 */
  reason?: string;
  /** 时间戳（ISO 8601） */
  timestamp: string;
}

/** 审计日志订阅器：默认经内核 logger 单例输出，可被业务层重定向到独立审计文件 */
export type AuditListener = (event: AuditEvent) => void;

/**
 * 确认请求：宿主在非交互式环境（WebUI/桌宠/无终端）注入自定义确认 UI，
 * 走此回调而非直接读 stdin。返回 true 确认 / false 拒绝；抛错视为拒绝（fail-closed）。
 *
 * ⚠️ 类型名 `WriteConfirmation*` 是**历史命名**：该回调承载全部确认
 * （写入 / 命令 / 代码 / 脚本执行 / 自定义工具），非写入类请求同样走它（见 `confirmGate`）。
 * 改名 = 破坏性公共面变更，收益仅为命名纯度 ⇒ 保留旧名 + 此注释说明。
 */
export type WriteConfirmationRequest = (info: WriteConfirmationInfo) => Promise<boolean>;

/** 写入确认请求的载荷 */
export interface WriteConfirmationInfo {
  /** 目标文件绝对路径 */
  targetPath: string;
  /** 工具名（如 write_file） */
  tool: string;
  /** 人类可读描述（"写入 100 字符到 foo.md"） */
  description?: string;
  /** 权限模式（owner / guest） */
  permission: Permission;
  /** 是否需确认（owner+confirmWrites=false 时为 false，宿主可跳过弹窗） */
  needsConfirm: boolean;
  /** 文件当前内容预览（截断到 10KB，null 表示新文件）——供宿主 UI 展示 diff */
  beforeContent?: string | null;
  /** 写入后内容预览（截断到 10KB）——供宿主 UI 展示 diff */
  afterContent?: string;
  /**
   * 本确认卡是否有 diff 对比域（判据归内核，宿主不猜——2026-10-03 实锤：宿主用
   * truthy 判据猜「diff 域空不空」属措辞折叠型带伤，判据归位内核单点）。
   * true 仅写入场景（confirmGate 的 diff 参数唯一传入点）；命令/代码/脚本执行三类恒 false。
   */
  hasDiff: boolean;
}

/** diff 内容最大长度（10KB），防大文件撑爆 IPC 传输和 UI 渲染。宿主 UI 展示上限从本常量 import 对齐（唯一真源） */
export const MAX_DIFF_CONTENT_LENGTH = 10240;

/** 截断 diff 内容到长度上限并追加标记；重载签名保持 beforeContent(null)/afterContent(undefined) 语义一致 */
function truncateForDiff(content: string | null): string | null;
function truncateForDiff(content: string | undefined): string | undefined;
function truncateForDiff(content: string | null | undefined): string | null | undefined;
function truncateForDiff(content: string | null | undefined): string | null | undefined {
  if (content === null || content === undefined) return content;
  if (content.length <= MAX_DIFF_CONTENT_LENGTH) return content;
  // 超限截断并追加标记，让用户知道内容被裁剪
  return content.slice(0, MAX_DIFF_CONTENT_LENGTH) + `\n...（已截断，共 ${content.length} 字符）`;
}

/**
 * 禁止改写判据的用户提示（single source）：`assertNotOverwrite` 抛出与
 * `builtinToolHandlers` 包装 `toolError` 共用，防两处各写一份而漂移（B7）。
 * 中性措辞：本判据是泛型选项，不点名任何具体目录。
 */
export const NO_OVERWRITE_HINTS: Record<'overwrite' | 'delete', string[]> = {
  overwrite: ['请换名写入（同名已存在的一律拒写）'],
  delete: ['已存在的目标文件不允许通过对话删除', '如需删除，请在文件管理器中手动删除'],
};

export class SecurityGuard {
  private readonly listeners: AuditListener[] = [];
  /**
   * 注入式写入确认回调：宿主注册后走自定义 UI；不注册时回退到终端 readline（CLI 场景）。
   */
  private confirmationHandler: WriteConfirmationRequest | null = null;

  /** 基准信任根（projectPath/memoraDir/configDir/agentDataDir，构造器固化，运行时不可移除） */
  private readonly baseRoots: string[];
  /** 用户额外白名单（运行时经 setAllowedPaths 热更新） */
  private extraRoots: string[];
  /** 允许访问的根目录列表（白名单）= baseRoots + extraRoots（派生，断言时遍历） */
  private allowedRoots: string[];
  /**
   * 禁止覆盖根（泛型选项，运行时经 setNoOverwriteRoots 热更新）。
   *
   * 与 allowedPaths 并列的第二条判据：白名单回答「能不能写」，本字段回答
   * 「能不能**覆盖已存在的文件**」。两者必须分开——`write_file` 的确认档是
   * `idempotent-key`（owner 默认不弹窗），无本判据即直接写入、不拦覆盖。
   * ⚠️ 现状（2026-11-05 · 6.0.0 · `DEPRECATE-1`）：`AgentOptions.noOverwriteRoots` 装配期
   * 配置键已移除，本判据与 `setNoOverwriteRoots` **保留**，入口改为运行期热更新
   * （`agent.security.setNoOverwriteRoots(paths)`）；未显式启用时该字段为空 = 判据空转。
   * 宿主已撤回用户目录的白名单注入（`mergeAllowedPathsWithUserAssets` 生产零调用）⇒
   * 不得据此声称「保护用户资产目录」。
   * ⚠️ 射程：只约束 `write_file` / `delete_file` 两个内置写入工具（二者共用
   * `assertNotOverwrite`）；**不约束代码执行**——`run_code` / `run_skill_script` /
   * `run_project_script` 与进程同权限，应用层路径判据对它们无效。
   */
  private noOverwriteRoots: string[];

  /** owner 是否启用写入二次确认；guest 强制开启（可运行时切换） */
  public confirmWrites: boolean;

  /** 是否对脚本/代码执行启用确认（owner 模式；guest 强制开启；默认 false = 默认不弹窗） */
  public confirmScripts: boolean;

  constructor(
    projectPath: string,
    memoraDir: string,
    extraAllowedPaths: string[] = [],
    confirmWrites: boolean = false,
    /** 权限模式 */
    public readonly permission: Permission = 'owner',
    /** 脚本执行确认开关（独立于写入确认，供对 run_code/run_project_script 单独收紧） */
    confirmScripts: boolean = false,
    /** Agent 级配置目录（role-packs/rules/skills 所在目录） */
    configDir?: string,
    /** Agent 级数据目录（宿主传入；内核不假设其下的文件形态） */
    agentDataDir?: string,
    /**
     * 禁止覆盖根（可选，泛型）：目标文件落在这些目录内且已存在 ⇒ 写入工具拒绝覆盖。
     * 内核不在工具里硬编码路径字面量；构造参数 = 初始值，运行期经 `setNoOverwriteRoots` 热更新。
     * 现状（2026-11-05 · 6.0.0）：`AgentOptions.noOverwriteRoots` 装配期入口已移除，
     * 本判据与 setter 保留——消费者在 Agent 构造后经 `agent.security.setNoOverwriteRoots(paths)` 启用。
     */
    noOverwriteRoots: string[] = [],
  ) {
    // 基准信任根用真实路径（resolveRealpath），与 assertPathAllowed 对齐，避免前缀匹配错位
    this.baseRoots = [
      resolveRealpath(expandHome(projectPath)),
      resolveRealpath(expandHome(memoraDir)),
    ];
    if (configDir) {
      this.baseRoots.push(resolveRealpath(expandHome(configDir)));
    }
    if (agentDataDir) {
      this.baseRoots.push(resolveRealpath(expandHome(agentDataDir)));
    }
    this.confirmWrites = confirmWrites;
    // 脚本执行确认开关（独立于写入确认）
    this.confirmScripts = confirmScripts;
    // 用户额外白名单（构造器注入），基准根与额外项分离以便 setAllowedPaths 仅改额外项
    this.extraRoots = this.normalizeExtraRoots(extraAllowedPaths, 'allowedPaths');
    this.allowedRoots = [...this.baseRoots, ...this.extraRoots];
    // 禁止覆盖根（与白名单并列的第二条判据，见字段注释）
    this.noOverwriteRoots = this.normalizeNoOverwriteRoots(noOverwriteRoots);
  }

  /**
   * 归一化额外白名单（唯一判据）：元素校验 → realpath → 与基准根/已收项去重 → 上限校验。
   *
   * 去重口径与 `assertPathAllowed` 的前缀匹配同源（realpath 后比较），重复项不占额度；
   * 超限**抛错**而非截断（截断 = 用户以为已放行、实际被拒的静默失效）。
   *
   * @param paths 待归一化的额外白名单
   * @param label 错误文案用键名；当前唯一调用方 = `allowedPaths`
   *   （`noOverwriteRoots` 走 `normalizeNoOverwriteRoots`，不经过本函数、不设上限）
   */
  private normalizeExtraRoots(paths: string[], label: string): string[] {
    if (!Array.isArray(paths)) {
      throw securityError(`${label} 必须为数组`, `${label} 入参不是数组`, ['请传入字符串数组']);
    }
    // 基准根先入集合：与基准根重复的额外项不占额度（allowedRoots 是并集，语义等价）
    const seen = new Set<string>(this.baseRoots);
    const normalized: string[] = [];
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      if (typeof p !== 'string') {
        throw securityError(`${label} 每项必须为字符串`, `${label}[${i}] 不是字符串`, [
          `${label} 每项必须为字符串路径`,
        ]);
      }
      const real = resolveRealpath(expandHome(p));
      if (seen.has(real)) continue;
      seen.add(real);
      normalized.push(real);
    }
    if (normalized.length > MAX_ALLOWED_PATHS) {
      throw securityError(
        `${label} 超过上限（${MAX_ALLOWED_PATHS} 条）`,
        `收到 ${normalized.length} 条去重后路径，超出内核上限 ${MAX_ALLOWED_PATHS} 条`,
        [
          `删除 ${normalized.length - MAX_ALLOWED_PATHS} 条不再需要的允许路径`,
          '白名单上限防膨胀：内核不静默截断，超限立即报错',
        ],
      );
    }
    return normalized;
  }

  /**
   * 归一化禁止覆盖根：元素校验 + realpath + 去重（不设上限——它是收紧型判据，
   * 多一条只会多拦，不构成可用面膨胀）。
   */
  private normalizeNoOverwriteRoots(paths: string[]): string[] {
    if (!Array.isArray(paths)) return [];
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      if (typeof p !== 'string') {
        throw securityError(
          'noOverwriteRoots 每项必须为字符串',
          `noOverwriteRoots[${i}] 不是字符串`,
          ['noOverwriteRoots 每项必须为字符串路径'],
        );
      }
      const real = resolveRealpath(expandHome(p));
      if (seen.has(real)) continue;
      seen.add(real);
      normalized.push(real);
    }
    return normalized;
  }

  /** 注册自定义写入确认回调（宿主接入）；取消注册传入 null。WebUI/桌宠等无终端场景走此回调而非读 stdin */
  onWriteConfirmation(handler: WriteConfirmationRequest | null): void {
    this.confirmationHandler = handler;
  }

  /**
   * 运行时切换写入二次确认开关（宿主设置面板热更新）
   *
   * 开启后：owner 模式下写文件前会触发 confirmationHandler 弹窗审批；
   * 关闭后：owner 模式下写文件自动批准（审计仍会记录）。
   * guest 模式不受影响——始终需要确认。
   */
  setConfirmWrites(value: boolean): void {
    this.confirmWrites = value;
  }

  /**
   * 运行时切换脚本/代码执行确认开关（宿主设置面板热更新）
   *
   * 开启后：owner 模式下 run_code/run_project_script 执行前会触发 confirmationHandler 弹窗审批；
   * 关闭后：owner 模式下脚本自动批准（审计仍会记录）。
   * guest 模式不受影响——脚本执行始终需要确认。
   */
  setConfirmScripts(value: boolean): void {
    this.confirmScripts = value;
  }

  /**
   * 运行时设置「用户额外白名单」（宿主设置面板热更新）
   *
   * 仅操作额外项（extraRoots），基准信任根（baseRoots）永不被触碰——守住安全显式性：
   * 项目目录、memora 数据目录、配置/数据目录始终允许访问，用户无法误删。
   * 传空数组 = 清空额外项（仅留基准根，等价「重置」）。
   * 黑名单（BLOCKED_PATTERNS）对新增路径仍强制生效——白名单是允许列表，非绕过黑名单的通行证。
   */
  setAllowedPaths(extraPaths: string[]): void {
    this.extraRoots = this.normalizeExtraRoots(extraPaths, 'allowedPaths');
    this.allowedRoots = [...this.baseRoots, ...this.extraRoots];
  }

  /**
   * 运行时设置「禁止覆盖根」（宿主资产目录变更时热更新）
   *
   * 与 setAllowedPaths 并列但方向相反：白名单**放宽**可写面，本判据**收紧**覆盖面。
   * 传空数组 = 取消覆盖保护（仅用于宿主明确不需要该保护的场景）。
   */
  setNoOverwriteRoots(paths: string[]): void {
    this.noOverwriteRoots = this.normalizeNoOverwriteRoots(paths);
  }

  /**
   * 断言目标不得改写（禁止覆盖根内的已存在文件一律拒绝覆盖或删除）
   *
   * 判据顺序：不在任何禁止覆盖根 ⇒ 放行；文件不存在 ⇒ 放行（新建）；已存在 ⇒ 拒绝。
   * 覆盖与删除共用同一判据，仅错误文案 / 审计动作名不同（见 `action`）。
   * 与 `assertPathAllowed` 同源（realpath 前缀匹配、追加 sep 防兄弟目录绕过），
   * 但**不替代**白名单校验——调用方须先过白名单再问覆盖。
   *
   * @param absolutePath 目标绝对路径
   * @param tool 工具名（审计用）
   * @param source 调用链来源（审计用）
   * @param action 动作语义：「覆盖」或「删除」；只影响错误码位（title）、文案与审计动作名，
   *   判据本身（目标已存在 + 命中禁止覆盖根）完全相同。缺省 `'overwrite'` = 旧语义。
   */
  assertNotOverwrite(
    absolutePath: string,
    tool?: string,
    source?: 'builtin' | 'custom' | 'system',
    action: 'overwrite' | 'delete' = 'overwrite',
  ): void {
    if (this.noOverwriteRoots.length === 0) return;
    const resolved = resolveRealpath(absolutePath.normalize('NFKC'));
    // 新建文件不在本判据范围（本判据只回答「能不能覆盖」）
    if (!existsSync(resolved)) return;
    const hitRoot = this.noOverwriteRoots.find(
      (root) => resolved === root || resolved.startsWith(root + sep),
    );
    if (!hitRoot) return;
    // 动作名进审计 reason（AuditEvent 无 action 字段，不改公开接口）：
    // 同一条 path-deny 要能复盘是「写被拒」还是「删被拒」。
    // 目录定性用「禁止改写」而非「禁止覆盖 / 禁止删除」——根的性质不随动作改变，
    // 写成「禁止删除目录」会反向暗示「该目录可覆盖」（假话）。
    const verb = action === 'delete' ? '删除' : '覆盖';
    this.emitAudit({
      type: 'path-deny',
      path: resolved,
      tool,
      source,
      reason: `目标已存在且位于禁止改写目录 (${hitRoot})，动作=${action}`,
      timestamp: nowIso(),
    });
    throw securityError(
      `目标已存在，禁止${verb}`,
      `路径 ${resolved} 已存在且位于禁止改写目录 ${hitRoot}（动作=${action}）`,
      NO_OVERWRITE_HINTS[action],
    );
  }

  /** 订阅审计事件；@returns 取消订阅函数 */
  onAudit(listener: AuditListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /**
   * 断言路径允许访问（命中即拒绝）；黑名单优先，其次白名单前缀匹配（追加 sep 防兄弟目录绕过）。
   * @throws 不在白名单时
   */
  assertPathAllowed(
    absolutePath: string,
    tool?: string,
    source?: 'builtin' | 'custom' | 'system',
  ): void {
    // NFKC 规范化，防全角字符（如 ．．/）绕过黑名单正则
    const normalized = absolutePath.normalize('NFKC');
    // 解析符号链接，防项目内符号链接逃逸到系统目录
    const resolved = resolveRealpath(normalized);

    // 1. 黑名单优先（匹配点单点在 matchBlockedPathPattern，不在此复制正则循环）
    const blockedPattern = matchBlockedPathPattern(resolved);
    if (blockedPattern) {
      this.emitAudit({
        type: 'path-deny',
        path: resolved,
        tool,
        source,
        reason: `命中黑名单规则 (${blockedPattern})`,
        timestamp: nowIso(),
      });
      throw securityError(
        '禁止访问：路径命中黑名单',
        `路径 ${resolved} 命中黑名单规则 (${blockedPattern})`,
        ['检查路径是否正确', '如需访问该路径，请联系管理员添加白名单'],
      );
    }

    // 2. 白名单：严格前缀匹配（追加 sep 防兄弟目录绕过）
    for (const allowedRoot of this.allowedRoots) {
      if (resolved === allowedRoot || resolved.startsWith(allowedRoot + sep)) {
        this.emitAudit({
          type: 'path-allow',
          path: resolved,
          tool,
          source,
          timestamp: nowIso(),
        });
        return;
      }
    }

    this.emitAudit({
      type: 'path-deny',
      path: resolved,
      tool,
      source,
      reason: '路径越界，不在白名单内',
      timestamp: nowIso(),
    });
    throw securityError('路径越界', `${resolved} 不在白名单内`, [
      '检查路径是否在项目目录内',
      '在配置文件中添加该路径到 allowedPaths',
    ]);
  }

  /**
   * 写入前请求用户确认。guest 或 confirmWrites 需确认；未注入 confirmationHandler 时 fail-closed 拒绝（返回 false），
   * 理由：内核纯逻辑库不依赖交互式终端 I/O，宿主负责确认 UI；安全优先：未配置 = 拒绝。
   */
  async requestWriteConfirmation(
    targetPath: string,
    tool: string,
    description?: string,
    /** diff 内容选项（宿主 UI 变更预览用，自动截断到 10KB） */
    options?: { beforeContent?: string | null; afterContent?: string },
  ): Promise<boolean> {
    return this.confirmGate(
      targetPath,
      tool,
      description,
      // 写入确认判据：guest 或 confirmWrites
      this.permission === 'guest' || this.confirmWrites,
      // diff 预览（仅写入场景有；脚本执行无内容预览）
      {
        beforeContent: truncateForDiff(options?.beforeContent),
        afterContent: truncateForDiff(options?.afterContent),
      },
    );
  }

  /**
   * 脚本/代码执行前确认（run_code / run_project_script 的执行闸）
   *
   * 判据与写入确认同构：guest 模式或 confirmScripts 需确认；未注入 confirmationHandler 时
   * fail-closed 拒绝。owner + confirmScripts=false 自动批准（默认），审计仍记录。
   * target 为脚本绝对路径（run_project_script）或描述型标识（run_code 内联代码无落盘路径）。
   *
   * **内容裁决（2026-10-25 补齐，CMD-1-BYPASS）**：可选 `content` = 将被执行的脚本/代码正文。
   * 此前本闸**只看权限档位、不看执行内容** ⇒ 「git push」「rm -rf /」写进脚本即可绕过
   * `classifyCommand`（命令面的内容裁决）——恒弹清单成了纸墙。此处把正文喂给**同一个**
   * `classifyCommand`（判据仍单点，不新造第二套）：
   *   - `deny` ⇒ **恒拦**（不入确认流程，任何档位/权限都拦）；
   *   - `always-ask` ⇒ **恒弹**（owner + confirmScripts=false 也弹，与命令面同判据）；
   *   - `normal` ⇒ 回落到原判据（guest || confirmScripts）。
   *
   * 不传 `content`（拿不到正文的面 ⇒ 只判档位；如未注入解析回调的技能脚本执行）⇒
   * 行为与补齐前完全一致。
   *
   * @param content 将被执行的正文（**整份裁决，不做截断**——截断即裁决盲区）
   */
  async confirmScriptRun(
    targetPath: string,
    tool: string,
    description?: string,
    content?: string,
  ): Promise<boolean> {
    if (content) {
      const verdict = classifyCommand(content);
      if (verdict === 'deny') {
        this.emitAudit({
          type: 'write-decline',
          path: targetPath,
          tool,
          decision: 'auto-denied',
          reason: '脚本/代码内容命中命令黑名单（恒拦，不进确认流程）',
          timestamp: nowIso(),
        });
        return false;
      }
      if (verdict === 'always-ask') {
        // 恒弹：与 confirmCommandRun 的 always-ask 分支同判据（不可被档位豁免）
        return this.confirmGate(targetPath, tool, description, true);
      }
    }
    return this.confirmGate(
      targetPath,
      tool,
      description,
      // 脚本执行确认判据：guest 或 confirmScripts（独立于写入确认）
      this.permission === 'guest' || this.confirmScripts,
    );
  }

  /**
   * 命令执行确认（run_command 的执行闸，§13.2）
   *
   * 三档判据，与 `confirmScriptRun` **共用同一个 `confirmGate`**（不新造第二套确认路径）：
   *   1. deny 命中 → **恒拒**（不入确认流程，任何档位/权限都拦）；
   *   2. ALWAYS_ASK 命中 → **恒弹确认**（即使 owner + confirmScripts=false 也弹；
   *      将来的 allow 白名单对它无效——不可豁免，§13.2 定案）；
   *   3. 其余 → 与脚本执行同判据（guest 或 confirmScripts），未注入 handler 时 fail-closed。
   */
  async confirmCommandRun(command: string, tool: string, description?: string): Promise<boolean> {
    const verdict = classifyCommand(command);
    if (verdict === 'deny') {
      this.emitAudit({
        type: 'write-decline',
        path: command,
        tool,
        decision: 'auto-denied',
        reason: '命令命中黑名单（恒拦，不进确认流程）',
        timestamp: nowIso(),
      });
      return false;
    }
    return this.confirmGate(
      command,
      tool,
      description,
      verdict === 'always-ask' || this.permission === 'guest' || this.confirmScripts,
    );
  }

  /**
   * 自定义工具调用确认（自定义工具的执行闸；外部工具接入的唯一审批入口）
   *
   * 与 `confirmCommandRun` / `confirmScriptRun` 共用同一个 `confirmGate`（不新造第二套确认路径）。
   * 单一入口、两种模式（由 ToolExecutor 按 `ToolDefinition.confirmPolicy` 映射）：
   *   - `needConfirm=true`（'always'）：每次弹宿主确认 UI；
   *   - `needConfirm=false`（'audit'）：过闸自动放行，仍落 write-auto 审计。
   *
   * @param toolName 工具名（如 mcp__server__tool）
   * @param summary 调用摘要（被裁决对象标识，落审计 path 字段 + 确认卡文案，与 run_command 把命令塞 path 同构）
   * @param needConfirm 是否需要用户逐次确认（false = 自动放行 + 审计）
   * @returns true 放行（调用方才可执行 handler）/ false 拒绝（fail-closed 安全优先）
   */
  async requestToolCallConfirmation(
    toolName: string,
    summary: string,
    needConfirm: boolean,
  ): Promise<boolean> {
    return this.confirmGate(summary, toolName, summary, needConfirm, undefined, 'custom');
  }

  /**
   * 确认闸公共核心（SSOT：**全部确认**——写入 / 命令 / 代码 / 脚本执行 / 自定义工具——的唯一执行路径）
   *
   * needConfirm=false → 自动批准（审计 write-auto）；为 true 且未注入 confirmationHandler
   * → fail-closed 拒绝（审计 write-decline）；否则经 confirmViaHandler 走宿主确认 UI。
   * diff 仅写入场景有（`requestWriteConfirmation` 唯一传 diff），其余类别不传（域留空），
   * 宿主据此判「本卡无 diff 域」并跳过写入前后对比渲染。
   *
   * `source` 可选：标记本次确认的调用链来源，透传进全部审计出口；
   * 既有四类调用方不传 = undefined，审计事件缺省不带该字段，行为零变化。
   */
  private async confirmGate(
    targetPath: string,
    tool: string,
    description: string | undefined,
    needConfirm: boolean,
    diff?: { beforeContent?: string | null; afterContent?: string },
    source?: AuditEvent['source'],
  ): Promise<boolean> {
    // 无需确认：直接放行并记录审计
    if (!needConfirm) {
      this.emitAudit({
        type: 'write-auto',
        path: targetPath,
        tool,
        source,
        decision: 'auto-approved',
        timestamp: nowIso(),
      });
      return true;
    }

    // 构建确认信息（写入场景透传 diff 内容，供宿主 UI 展示变更预览）
    const info: WriteConfirmationInfo = {
      targetPath,
      tool,
      description,
      permission: this.permission,
      needsConfirm: needConfirm,
      beforeContent: diff?.beforeContent,
      afterContent: diff?.afterContent,
      // diff 域语义判定单点：写入场景传了 diff 参数 → 有域；命令/代码/脚本/自定义工具不传 → 无域
      hasDiff: diff !== undefined,
    };

    // 未注入 confirmationHandler 时 fail-closed 拒绝
    if (!this.confirmationHandler) {
      logger.warn(
        { targetPath, tool, permission: this.permission },
        '执行确认失败：未注入 confirmationHandler，fail-closed 拒绝',
      );
      this.emitAudit({
        type: 'write-decline',
        path: targetPath,
        tool,
        source,
        decision: 'declined',
        reason: '未注入 confirmationHandler（fail-closed）',
        timestamp: nowIso(),
      });
      return false;
    }

    // 走宿主注入的 confirmationHandler（此处 handler 必非空，上方已 fail-closed 拦截）
    return this.confirmViaHandler(info, targetPath, tool, source);
  }

  /**
   * 通过宿主注入的 confirmationHandler 执行确认（**全部确认**的唯一执行路径：
   * 写入 / 命令 / 代码 / 脚本执行 / 自定义工具）。抛错视为拒绝（fail-closed 安全优先）。
   */
  private async confirmViaHandler(
    info: WriteConfirmationInfo,
    targetPath: string,
    tool: string,
    source?: AuditEvent['source'],
  ): Promise<boolean> {
    try {
      const ok = await this.confirmationHandler!(info);
      this.emitAudit({
        type: ok ? 'write-confirm' : 'write-decline',
        path: targetPath,
        tool,
        source,
        decision: ok ? 'confirmed' : 'declined',
        timestamp: nowIso(),
      });
      return ok;
    } catch (err) {
      // 抛错视为拒绝（fail-closed 安全优先）
      logger.warn({ err, targetPath }, '写入确认回调异常，视为拒绝');
      this.emitAudit({
        type: 'write-decline',
        path: targetPath,
        tool,
        source,
        decision: 'declined',
        reason: `回调异常：${toError(err).message}`,
        timestamp: nowIso(),
      });
      return false;
    }
  }

  /** 触发审计事件：写日志 + 通知订阅者 */
  private emitAudit(event: AuditEvent): void {
    if (event.type === 'path-deny' || event.type === 'write-decline') {
      logger.warn({ audit: event }, '安全审计：拒绝');
    } else {
      logger.info({ audit: event }, '安全审计：通过');
    }

    // 通知订阅者（业务层可重定向到独立审计文件）
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        logger.error({ err }, '审计订阅者执行失败');
      }
    }
  }
}
