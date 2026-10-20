/**
 * problemsCollector — `@problems` 诊断的**有界采集**（HOST-CTX-4 第一笔）
 *
 * 为什么存在：`HOST-CTX-0` 定案是引用模式（只挂指针、模型自取），但 VS Code 诊断是
 * **瞬态派生数据**——内核 17 个内置工具里没有 diagnostics（实测 `builtinTools.ts`
 * `BUILTIN_TOOLS` 顶层 17 项无此项），模型无从自取 ⇒ 定案为该三类开了**有界注入**的例外
 * （四条硬约束真源 = 台账 HOST-CTX-0「定案例外清单」）。本模块就是「有界」这一条的落点。
 *
 * 四条硬约束在本模块的落点：
 *   ① **有界** —— 条数上限（`PROBLEMS_LIMIT`）+ 单条文案上限 + 正文总长上限，命中即**明示**
 *      截断（静默截断 = 静默失败族，本项目已三次踩：CTX-5 贡献点被忽略 / CTX-11 findFiles
 *      静默截断 / CTX-12 未知消息静默丢弃）；
 *   ② **计预算** —— 正文交由调用方用内核 `estimateTokensText` 估算（本模块不估 token，
 *      宿主自估即第二真理源）；
 *   ③ **明示** —— UI 侧由注入 chip 负责（形状 + 颜色双通道可辨），本模块只保证正文如实；
 *   ④ **不泛化** —— 本模块只做诊断一类；未来 diff / 终端各自另立采集器，不塞进本模块
 *      （三类语义不等价：诊断是 IDE 面板数据、diff 是 git 语义、终端是进程输出）。
 *
 * 采集时机（HOST-CTX-4 ④）：**发送时刻**才调用 `getDiagnostics()`。挂载只记通道标记，
 * 本模块不做缓存、不持有状态——缓存的快照 ≠ 发送时刻的真相（CTX-3 的 `_docContext`
 * 缓存撒谎就是死在这上面）。
 *
 * ⚠️ 返回值只有正文一个字段：条数 / 是否截断**都在正文里明写**，不再另出结构化字段——
 * 另出即同一事实的第二处表达（两处必然漂移），且调用方无处消费它们（chip 发送即清）。
 *
 * 依赖全部注入式（诊断分组 / 源码行读取 / 首根路径），本文件零 `vscode` 依赖 ⇒ 可单测
 * （同 `refProbe` 的 stat 注入先例）。
 */
import { relativeUnderPrimaryRoot } from './refPath.js';

/** 单条诊断（VS Code `Diagnostic` 的最小结构面，只取需要的字段，避免依赖 vscode 类型） */
export type DiagnosticLike = {
  message: string;
  /** VS Code `DiagnosticSeverity`：0=Error 1=Warning 2=Information 3=Hint */
  severity: number;
  /** 0-based（VS Code 语义）；本模块输出前统一 +1 转成 1-based（与人读习惯 / 编辑器一致） */
  range: { start: { line: number; character: number } };
};

/** 一个文件下的诊断组（`uri` 取源码行用，`fsPath` 投影首根用） */
export type DiagnosticGroup = {
  uri: string;
  fsPath: string;
  diagnostics: readonly DiagnosticLike[];
};

export type ProblemsCollectInput = {
  /** 全工作区诊断（生产：`vscode.languages.getDiagnostics()` 的逐项映射） */
  groups: readonly DiagnosticGroup[];
  /**
   * 首个工作区根的绝对路径（`workspaceFolders[0].uri.fsPath`）
   *
   * ⚠️ **首根 SSOT**：模型 `read_file` 的 cwd 恒为首个根，引用解析（`refPath`）与
   * 打开定位（`openRefInEditor`）同样恒取首根 ⇒ 诊断路径必须投影到**同一个根**，
   * 否则模型按路径读不到。非首根文件**整体忽略**（fail-closed）并如实标注条数，
   * 不静默丢弃。
   */
  rootFsPath?: string;
  /**
   * 取源码行（注入式、可选）：诊断带上**那一行的源码**才有可操作性（Roo Code 的
   * `diagnosticsToProblemsString` 同款；只给「第 42 行有错」模型还得再读一次文件）。
   * 未注入时降级为不带源码行（功能不残，只是少一点上下文）。
   */
  readLine?: (uri: string, line: number) => Promise<string | undefined>;
};

/** 条数上限（硬约束①「有界」的第一道闸） */
export const PROBLEMS_LIMIT = 20;

/** 单条消息正文上限（诊断消息可能极长，如编译器整段报错） */
const MESSAGE_MAX_CHARS = 200;

/** 单行源码上限（压缩 / 超长行保护） */
const CODE_LINE_MAX_CHARS = 200;

/** 正文总长上限（纵深：条数上限之外的第二道闸，防逐条都顶格的极端组合） */
const BODY_MAX_CHARS = 12_000;

const SEVERITY_LABELS: readonly string[] = ['错误', '警告', '信息', '提示'];

/**
 * severity → 排序权重（错误优先）
 *
 * 未知 / 越界值按「信息」级（权重 2）处置：既不臆造一个等级，也不让它挤到错误前面。
 * （与 `severityLabel` 的兜底同档，两处口径必须一致——否则会出现「标签说信息、却排在错误前」。）
 */
function severityRank(severity: number): number {
  return severity >= 0 && severity <= 3 ? severity : 2;
}

function severityLabel(severity: number): string {
  return SEVERITY_LABELS[severity] ?? '信息';
}

/** 压平为一行并限长（诊断消息自带换行，多行会打乱「一条一行」的列表结构） */
function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * 采集诊断正文（有界、发送时刻调用）
 *
 * 排序：**严重度升序（错误在前）→ 路径 → 行号**——用户挂 @problems 的首要诉求是
 * 「把错误修了」，错误被警告挤出列表是最坏的排序。
 *
 * @returns 注入给模型的块正文。**永不返回空字符串**（挂了就一定有话说）：零诊断 /
 *   无工作区根时返回一行**事实说明**，而不是空串——用户挂了 @problems 却什么都没送出去
 *   = 静默失败，模型只会答非所问。
 */
export async function collectProblemsText(input: ProblemsCollectInput): Promise<string> {
  const { groups, rootFsPath, readLine } = input;
  // 无首根 ⇒ 无任何可投影的诊断路径。不臆造相对路径（模型读不到 = 假指针），
  // 但也不静默：正文里明说「未打开工作区根」。
  if (!rootFsPath) {
    return '当前未打开工作区，无法定位诊断所在文件。';
  }

  // 展开为扁平条目并即时做首根投影（非首根 fail-closed，另计条数以便如实标注）。
  // 投影判据直接复用 refPath.relativeUnderPrimaryRoot——引用解析与诊断投影是同一条
  // 契约的两半，各写一套必然漂移（CTX-9 收口同款理由）。
  type Item = {
    relPath: string;
    uri: string;
    line: number;
    character: number;
    msg: string;
    sev: number;
  };
  const items: Item[] = [];
  let offRoot = 0;
  for (const g of groups) {
    const relPath = relativeUnderPrimaryRoot(rootFsPath, g.fsPath);
    if (!relPath) {
      offRoot += g.diagnostics.length;
      continue;
    }
    for (const d of g.diagnostics) {
      items.push({
        relPath,
        uri: g.uri,
        line: d.range.start.line,
        character: d.range.start.character,
        msg: d.message,
        sev: d.severity,
      });
    }
  }

  const offNote = offRoot > 0 ? `\n（另有 ${offRoot} 条诊断所在文件不在主工作区根下，已忽略）` : '';
  if (items.length === 0) {
    // 零诊断：**诚实的一行事实**，不是空串（用户挂了标签就有权知道「确实没有」）。
    return `当前工作区没有错误或警告诊断。${offNote}`.trim();
  }

  items.sort(
    (a, b) =>
      severityRank(a.sev) - severityRank(b.sev) ||
      a.relPath.localeCompare(b.relPath) ||
      a.line - b.line,
  );

  const truncatedByCount = items.length > PROBLEMS_LIMIT;
  const picked = items.slice(0, PROBLEMS_LIMIT);

  const lines: string[] = [];
  for (const it of picked) {
    const codeLine = readLine ? await readLine(it.uri, it.line) : undefined;
    const head = `- ${it.relPath}:${it.line + 1}:${it.character + 1} [${severityLabel(it.sev)}] ${clip(it.msg, MESSAGE_MAX_CHARS)}`;
    lines.push(codeLine ? `${head}\n    源码：${clip(codeLine, CODE_LINE_MAX_CHARS)}` : head);
  }

  // 总长上限：按条整体截断（不切半句）。预算先扣掉头部与附注——头部长度随条数只差
  // 1~2 字符，按**条数上限**算即够，不必迭代求解。
  const header = (n: number): string => `共 ${items.length} 条诊断，按严重度排序取前 ${n} 条：\n`;
  const budget = BODY_MAX_CHARS - header(PROBLEMS_LIMIT).length - offNote.length;
  let kept = lines;
  let truncatedByLength = false;
  if (lines.join('\n').length > budget) {
    truncatedByLength = true;
    kept = [];
    let size = 0;
    for (const ln of lines) {
      if (size + ln.length + 1 > budget) break;
      kept.push(ln);
      size += ln.length + 1;
    }
    // 单条就超预算时（理论上单条已被 MESSAGE/CODE_LINE 两道闸限到 ~460 字符）仍留第一条：
    // 「取前 0 条」是说不通的正文，宁可超一点预算也要有内容。
    if (kept.length === 0) kept = lines.slice(0, 1);
  }

  const truncated = truncatedByCount || truncatedByLength;
  const tail = truncated ? '\n（条目过多已截断，请缩小范围或先处理上述错误）' : '';
  return `${header(kept.length)}${kept.join('\n')}${offNote}${tail}`;
}
