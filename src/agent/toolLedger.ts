/**
 * 文件覆盖度台账（大文本统一通道：账本与占用解耦的"账本"侧）
 *
 * `toolResultCache` 记「同参是否发生过」；本台账按文件记**读到第几行 + 轻量摘要（替身）
 * + 产出覆盖的那次调用 id/指纹**（后者供 loop 实测「原文是否仍在上下文」）。二者粒度不同
 * （一个按调用入账、一个按文件记覆盖），故非 SSOT 并列。
 *
 * 用途：read_file 重读且**原文仍在上下文**时，loop 拦截分支②据此回显摘要 + 覆盖度
 * （防「重读→压→重读」永动机）；原文已被压缩链清出 → 分支②判 stillInContext=false 放行真读
 * （替身只有顶头摘要，是死路，见 `shouldEchoLedgerStub`）。
 *
 * 写侧触发（loop 结果处理循环，两路）：① 返回分段脚注（文件确实大/被截断）→ 记覆盖区间；
 * ② 整读无脚注（读到末尾）→ 按**请求起点**记覆盖区间（handler 不变量：无脚注 = 从请求 offset
 * 读到末尾，coverStart=offset 而非 1——错记成 1 会把早段未覆盖误当已覆盖，真机
 * round-1791507775404 假拦根因即此）。提示性返回（`READ_FILE_NOTICE_PREFIX` 开头）非正文 → 不进台账。
 *
 * 生命周期：闭环内（每轮 resetTurnState 清），与 `toolResultCache` 同；跨闭环不复用。
 */

/** 摘要替身长度（字符）：够让 LLM 回想"这文件顶头 / 已读段讲了什么"，又不重新撑大上下文 */
export const READ_DIGEST_CHARS = 400;

/**
 * read_file 提示性返回的文案前缀（生成侧 = `builtinToolHandlers` 越界提示，
 * 识别侧 = loop 台账写入分支）：**单一真理源**，两侧同引防前缀漂移。
 *
 * 语义：该返回是提示串（「共 N 行；offset 超出末尾」）**不是文件正文**——进台账会把
 * 「读过 200 行处」记成覆盖，随后再次越界读命中归一判据被假拦。故识别后不记账：宁少记放行。
 */
export const READ_FILE_NOTICE_PREFIX = '[read_file] ';

/** 覆盖度条目：此文件已读到的行区间 + 一段轻量替身文本 */
export interface FileCoverage {
  /** 文件总行数 */
  totalLines: number;
  /** 已覆盖起始行（1-based） */
  coverStart: number;
  /** 已覆盖结束行（含） */
  coverEnd: number;
  /** 轻量摘要（替身正文）：已读正文前 READ_DIGEST_CHARS 字符，替代原文供分支②回显 */
  digest: string;
  /** 首次记录时的迭代序号（提示文案用） */
  cachedAtIteration: number;
  /** 产出本次覆盖的那次工具调用 id（判「原文是否仍在上下文」的定位锚；禁 optional——缺它则
   *  分支②无法核前置，回退语义 = 永远当「在」→ 死路回放复发，宁编译期报错也不留这个口子） */
  lastToolCallId: string;
  /** 进入上下文的最终内容指纹（对 wrapped 后消息内容算，与 toolResultCache 的 fingerprint 同口径
   *  同源计算；比对实现 = loop 的 isMessageStillUnmodified，本条目只承载数据） */
  fingerprint: string;
}

/** 从 read_file 原始结果解析出的覆盖度（无脚注 = 未截断 = 无需/无摘要） */
export interface ReadFileExposure {
  /** 已读到正文（不含脚注） */
  content: string;
  totalLines: number;
  coverStart: number;
  coverEnd: number;
}

/** 分段脚注正则（与 `formatSegmentationFooter` 同模块，单一真理源：生成与解析不各自漂移） */
const FOOTNOTE_RE = /\[read_file 分段\] 已显示第 (\d+)–(\d+) 行（共 (\d+) 行）。/;

/**
 * read_file 分段脚注格式（**单一真理源**）：生成侧 = `builtinToolHandlers.sliceFileByLineBudget`，
 * 解析侧 = 本模块 `parseReadFileCoverage`（引用 `FOOTNOTE_RE`）。两处同源，改格式只改这里。
 */
export function formatSegmentationFooter(
  startLine: number,
  endLine: number,
  totalLines: number,
): string {
  return (
    `[read_file 分段] 已显示第 ${startLine}–${endLine} 行（共 ${totalLines} 行）。` +
    `继续读用 offset=${endLine + 1}。`
  );
}

/**
 * 解析 read_file 结果里的分段脚注 → 覆盖度。
 *
 * @param result read_file 原始结果（进入 context 前，未 wrapped）
 * @returns 覆盖度；无脚注（未截断 / 越界提示）返回 undefined
 */
export function parseReadFileCoverage(result: string): ReadFileExposure | undefined {
  const m = FOOTNOTE_RE.exec(result);
  if (!m) return undefined;
  const coverStart = Number(m[1]);
  const coverEnd = Number(m[2]);
  const totalLines = Number(m[3]);
  // 已读正文 = 脚注之前的部分（脚注本身不算正文）；末尾紧跟脚注处的换行属分隔符，剥掉
  const idx = result.indexOf(m[0]);
  const content = idx > 0 ? result.slice(0, idx).replace(/\n$/, '') : '';
  return { content, totalLines, coverStart, coverEnd };
}

/**
 * 判定一次 read_file 请求是否应回显台账摘要（分支②语义的**单一真理源**）。
 *
 * 区分三类冗余：
 * - **原文不在上下文（stillInContext=false）→ 一律放行**：替身只服务「手边有原文可回顾」的
 *   语境；原文已被压缩清出时替身是死路（模型要的中段 token 永远不在顶头 400 字符里
 *   → 同参重读被同一判据反复拦 = 死路回放）。放行真读一次后，后续交给分支①（read_dedup）拦截。
 * - 该文件尚未覆盖过正文（coverEnd<=0）→ 不拦（无摘要可回显）。
 * - **无 limit 请求**：语义 =「从 offset 读到文件末尾」。起点落在已覆盖区间内 → 冗余 → 拦
 *   （由 `formatLedgerStub` 回显摘要 + 引导 `offset=coverEnd+1` 续读）；**起点超出已覆盖区间
 *   → 放行**（恰是上述引导的那一步，一并拦死则「照引导走仍被拦」成死循环，大文件永远读不到第二段）。
 * - **limit 变体整读**：`offset+limit-1 >= totalLines` = 物理读到末尾，再大的 limit 读到内容一致
 *   ⇒ 此前已覆盖到末尾（coverEnd >= totalLines）即视为同参整读 → 拦（封死「改 limit 从头重读」逃逸）。
 * - **offset/limit 续读**：整个请求区间落在已覆盖区间内才算冗余 → 拦；触及覆盖之外 → 放行
 *   （宁可多读不误拦）。
 *
 * @param subj read_file 去重主体的区间字段（offset/limit，缺省语义与 handler 一致）
 * @param cov 该文件已覆盖度台账条目
 * @param stillInContext 原文是否仍在上下文中（loop 侧按 lastToolCallId + fingerprint 实测，
 *   与分支①同源；本函数不自行翻消息数组）
 * @returns true = 应回显摘要（拦截分支②），false = 放行真实执行
 */
export function shouldEchoLedgerStub(
  subj: { offset?: number; limit?: number },
  cov: FileCoverage,
  stillInContext: boolean,
): boolean {
  // 前置：原文不在上下文 → 一律放行（死路回放不变式：整读→压缩→重读必须能拿回真内容）
  if (!stillInContext) return false;
  // 未覆盖过正文：无摘要可回显，放行
  if (cov.coverEnd <= 0) return false;
  // 无 limit 请求：语义 =「从 offset 读到文件末尾」（handler 缺省 limit 即读到底）。
  // 起点落在已覆盖区间内（含省略 offset 的整读）→ 截断后返回的仍是同一段已读头部 → 拦；
  // 起点超出已覆盖区间 → 真续读（`offset=coverEnd+1` 恰是 formatLedgerStub 引导的写法）→ 放行。
  // 此处若一律拦，拦据与引导互为死结：模型照着文案给出的 offset 续读，仍会被同一条判据再拦一次。
  if (subj.limit === undefined) return (subj.offset ?? 1) <= cov.coverEnd;
  const start = subj.offset ?? 1;
  const reqEnd = start + (subj.limit - 1);
  // limit 变体整读：请求覆盖到文件末尾（物理读完整段）→ 此前已覆盖到末尾即视为同参整读 → 拦。
  // （真机逃逸实证：LLM 改 limit 变体、offset 恒=1，对不同短文件导致重复整读被放行。）
  if (reqEnd >= cov.totalLines) return cov.coverEnd >= cov.totalLines;
  // 区间续读：完全落在已覆盖区间内才算冗余；触及覆盖之外（尚未读到末尾）放行
  if (start < cov.coverStart) return false;
  return reqEnd <= cov.coverEnd;
}

/** 文件覆盖度台账（读账：谁读过、读到哪、顶头讲了什么） */
export class FileExposureLedger {
  /** 规范化路径（同 `toolResultCache` 的 `subject.path` 口径）→ 覆盖度条目 */
  private readonly store = new Map<string, FileCoverage>();

  /**
   * 记录一次已读到覆盖区间的文件。
   *
   * @param path 规范化路径（取自 read_file 去重主体 `subject.path`，口径一致）
   */
  record(path: string, entry: FileCoverage): void {
    this.store.set(path, entry);
  }

  /**
   * 取某文件已读覆盖度（供拦截分支②回显摘要）；未读过（或被失效）返回 undefined。
   */
  get(path: string): FileCoverage | undefined {
    return this.store.get(path);
  }

  /** 文件被 write/delete 修改后作废旧覆盖度（内容变了，旧替身失效；放行合法重读） */
  invalidate(path: string): void {
    this.store.delete(path);
  }

  /** 闭环结束清空（跨闭环不复用，避免上一轮已读文件误伤本轮合法重读） */
  clear(): void {
    this.store.clear();
  }

  /** 当前记录数（调试 / 监控用） */
  get size(): number {
    return this.store.size;
  }
}

/**
 * 组装分支②的拦截文案（替身回显，非空拦）。
 *
 * **两个消费语境共用本函数**（SSOT）：① 压缩链把 read_file 结果原位替换为台账摘要；
 * ② 变体/同参重读被分支②拦截时的回显。故文案**不得内嵌只对单一语境成立的状态断言**：
 * 「原文已在流程中被压缩」在压缩语境为真，回显语境原文却可能仍在上下文 ⇒ 即撒谎。
 * 文案只陈述两语境皆真的事实；「若原文仍在上文可直接引用」是**条件语气**，
 * 禁改回断言（toolLedger.test.ts 有真实性守卫）。
 *
 * @param cov 台账覆盖度条目
 * @returns 面向 LLM 的提示串
 */
export function formatLedgerStub(cov: FileCoverage): string {
  const range =
    cov.coverStart === cov.coverEnd
      ? `${cov.coverStart} 行`
      : `第 ${cov.coverStart}–${cov.coverEnd} 行`;
  // 已读到末尾时**不得**再给 `offset=coverEnd+1` 示例：那是越界行号（真机 round-1791449684099
  // 实证：89 行文件已整读，文案仍引导 offset=90）。文案给的每条出路必须可走通，否则即假出路。
  const guidance =
    cov.coverEnd >= cov.totalLines
      ? '该文件已读到末尾；如需重读某区间请用 read_file 的 offset/limit 指定'
      : `如需其它区间请用 read_file 的 offset/limit 指定（如 offset=${cov.coverEnd + 1}）`;
  return (
    `[ALREADY_READ] 该文件已读过（第 ${cov.cachedAtIteration} 步，覆盖 ${range} / 共 ${cov.totalLines} 行）。` +
    `要点：${cov.digest}\n` +
    `若原文仍在本次对话上文，可直接引用；${guidance}；不要无区间重读已覆盖部分。`
  );
}

/** 按请求区间切出的已读原文（供分支②回显，避免「拦了却给一段无关顶头摘要」） */
export interface CoveredSlice {
  /** 切片的起始行（文件绝对行号，1-based） */
  startLine: number;
  /** 切片的结束行（含） */
  endLine: number;
  /** 切片正文（按行拼回） */
  text: string;
}

/**
 * 从**已读正文**里按请求区间切出原文（分支②回显的取材真源）。
 *
 * 为什么需要它（生产实证 round-1791449684099）：判据拦的是「请求区间 ⊆ 已覆盖区间」，但旧回显
 * 给的是**文件顶头 400 字符**替身，与模型请求的区间（offset=30 limit=35 / offset=75）零重叠。
 * 模型拿不到它要的内容只能绕道（写临时脚本 → `run_project_script`），8 个 step 换 2 次本该极便宜的
 * read_file——防重净收益为负，还把模型推向裁决链最弱的执行面。原文既仍在上下文，切片零额外成本。
 *
 * **不变量不动**：本函数只提供取材，不参与「拦不拦」的判据（判据由 `shouldEchoLedgerStub` 独占）；
 * 切不出来 → undefined → 调用方退化 `formatLedgerStub`，行为同旧。
 *
 * @param wrappedBody 已读正文（经 `unwrapToolResultBody` 剥壳；含分段脚注亦可，脚注在此剥掉）
 * @param cov 该文件覆盖度台账条目（提供 coverStart/coverEnd 行号平移基准）
 * @param subj 本次 read_file 请求的 offset/limit（缺省语义与 handler 一致）
 * @returns 切片；请求区间未完整落在已覆盖区间内 / 正文行数不足 / 切片为空 → undefined
 */
export function sliceCoveredLines(
  wrappedBody: string,
  cov: FileCoverage,
  subj: { offset?: number; limit?: number },
): CoveredSlice | undefined {
  // 已读正文：整读无脚注时 parseReadFileCoverage 返回 undefined → 用原串（脚注剥除的单一真源）
  const parsed = parseReadFileCoverage(wrappedBody);
  const lines = (parsed ? parsed.content : wrappedBody).split('\n');
  const start = subj.offset ?? 1;
  const reqEnd = subj.limit === undefined ? cov.totalLines : start + subj.limit - 1;
  // 只回显已覆盖区间内的行：超出部分尚未读到，硬切即撒谎（宁退化顶头替身也不编造）
  if (start < cov.coverStart || reqEnd > cov.coverEnd) return undefined;
  // 已读正文首行 = 文件第 coverStart 行 → 行索引平移
  const from = start - cov.coverStart;
  const to = reqEnd - cov.coverStart + 1;
  if (from < 0 || to > lines.length) return undefined;
  const text = lines.slice(from, to).join('\n');
  if (text.trim() === '') return undefined;
  return { startLine: start, endLine: reqEnd, text };
}

/**
 * 分支②回显文案 · **区间命中版**（单一真理源：`handleToolCalls` 分支②唯一调用点）。
 *
 * 与 `formatLedgerStub` 的关系：判据命中后优先按**请求区间**回显原文；切不出来（原文已不在
 * 上下文 / 区间越出覆盖 / 正文不足）→ 退化顶头替身版，行为与旧版逐字一致。
 *
 * 文案真实性纪律（对齐 `formatLedgerStub`）：「回显自已读内容，未重新读取文件」是两语境皆真的
 * **事实陈述**（内容确从上下文 tool 消息切出，未执行工具），不是状态断言。
 *
 * @param wrappedBody 已读正文（undefined = 拿不到 → 直接退化）
 */
export function formatLedgerStubRange(
  cov: FileCoverage,
  subj: { offset?: number; limit?: number },
  wrappedBody: string | undefined,
): string {
  if (wrappedBody === undefined) return formatLedgerStub(cov);
  const slice = sliceCoveredLines(wrappedBody, cov, subj);
  if (!slice) return formatLedgerStub(cov);
  const range =
    cov.coverStart === cov.coverEnd
      ? `${cov.coverStart} 行`
      : `第 ${cov.coverStart}–${cov.coverEnd} 行`;
  const req =
    slice.startLine === slice.endLine
      ? `${slice.startLine} 行`
      : `第 ${slice.startLine}–${slice.endLine} 行`;
  return (
    `[ALREADY_READ] 该文件已读过（第 ${cov.cachedAtIteration} 步，覆盖 ${range} / 共 ${cov.totalLines} 行）。` +
    `你请求的 ${req} 原文如下（回显自已读内容，未重新读取文件）：\n${slice.text}\n` +
    `如需其它区间请用 read_file 的 offset/limit 指定；不要无区间重读已覆盖部分。`
  );
}
