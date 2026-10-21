/**
 * gitCollector — `@git-changes` 未提交改动的**有界采集**（HOST-CTX-4 第二笔）
 *
 * 为什么存在：`@problems`（诊断）之后，CTX-4 定案的第二个注入源 = **git 未提交改动**。
 * 场景实证（Roo Code `@git` / Cursor `@Commit` 同款）：「帮我的改动写提交信息」「解释我
 * 改了啥」「审一遍我的改动」——改动清单在 fileChangeView 面板可见，但模型够不着，用户得
 * 手敲文件名。缺口是「让模型直接作用于改动」，不是「看见改动」。
 *
 * ⚠️ **语义边界（台账二笔边界订正段的教训）**：本模块采集的是 **git 真相**（未提交改动），
 * 不是 fileChangeTracker 的「助手经工具落盘的改动」——用户手敲的编辑 tracker 里根本没有。
 * 标签叫 `@git-changes` 就必须给 git 语义的数据；贴错标签 = 对模型撒谎。
 *
 * 🔴 **信任类声明（拍板记录第 6 项，C 路径成立的前提，勿删）**：本采集由**用户挂载 chip
 * 显式触发**、只跑三条只读子命令、不经裁决链（`classifyCommand` / `confirmCommandRun`
 * 一概不经过）——「用户挂载触发的只读采集 ≠ 代理发起命令」。wrapper 侧仍须守白名单守卫
 * （见文件尾契约），防后世审查者按「宿主 exec = 该管」误伤，也防真的被塞进写操作。
 *
 * HOST-CTX-0 四条硬约束在本模块的落点（与 `collectProblemsText` 同族口径）：
 *   ① **有界** —— 文件数 / 单文件 diff 行数 / 正文总长三道闸，命中即**明示**（静默截断 =
 *      静默失败族，本项目已三次踩：CTX-5 贡献点被忽略 / CTX-11 findFiles 静默截断 /
 *      CTX-12 未知消息静默丢弃）；
 *   ② **计预算** —— 模块内按**字符**设结构闸；token 估算交由调用方用内核
 *      `estimateTokensText`（宿主自估即第二真理源，与 problemsCollector 的
 *      `BODY_MAX_CHARS` 同口径同量级）；
 *   ③ **明示** —— 正文如实：零改动 / 非 git 仓库 / git 缺失 / 段执行失败都在正文里说，
 *      永不返回空串；
 *   ④ **不泛化** —— 本模块只做 git 改动一类；诊断 / 终端各自另立采集器（三类语义不等价：
 *      诊断是 IDE 面板数据、diff 是 git 语义、终端是进程输出）。
 *
 * 采集时机（HOST-CTX-4 ④）：**发送时刻**才执行（挂载只记通道标记）。不缓存、不持有状态——
 * 缓存的快照 ≠ 发送时刻的真相（CTX-3 的 `_docContext` 缓存撒谎就是死在这上面）。
 *
 * 返回值只有正文一个字段（与 `collectProblemsText` 同纪律）：条数 / 截断都在正文里明写，
 * 不另出结构化字段——另出即同一事实的第二处表达，且调用方无处消费（chip 发送即清）。
 *
 * 本文件零 `vscode` 依赖（exec 注入式）⇒ 可纯 node 单测（同 problemsCollector /
 * refProbe 的 stat 注入先例）。真正的 spawn wrapper 属第 3 笔接线，契约见
 * `GIT_COMMAND_WHITELIST` 注释。
 */

/**
 * 每次 git 调用的**固定开关前缀**（值真源：三组命令共享派生，勿在各组里各写一遍）
 *
 * 每条开关都挡一类**实测**形态（2026-10-22 临时仓实测，git 2.55.0.windows.3）：
 *   ① `core.quotePath=false` —— 默认 `quotePath=true` 把中文路径输出成八进制转义
 *      **字面量**（`"\"\\344\\270\\255…\""`），模型照它 `read_file` 必然失败；
 *   ② `core.fsmonitor=false` —— 仓库 config 的 `core.fsmonitor` 会让 `git status`
 *      **执行仓库指定的外部程序**（实测命中）；置 false 即不启用。
 *
 * 🔴 **红线：本数组只许整体替换，禁止参数化**（如按配置拼 `-c <key>=<value>`）。
 * 参数化 = 允许覆盖任意 git 配置 = 可把 `core.quotePath` 换成 `core.fsmonitor`，
 * 于是「只读采集」在陌生仓库里变成「执行仓库指定的程序」——信任类声明当场作废。
 * 白名单靠「整组逐项相等」守卫（`gitExec.isWhitelisted`），固定前缀**不是**开放的 `-c` 口子。
 */
export const GIT_GLOBAL_ARGS: readonly string[] = [
  '-c',
  'core.quotePath=false',
  '-c',
  'core.fsmonitor=false',
];

/**
 * diff 两口的**输出形态开关**（与 `GIT_GLOBAL_ARGS` 同族：`GIT_COMMANDS` 派生用，只写一处）
 *
 * `status --porcelain` 是机器格式、实测不受 color 配置影响 ⇒ 不需要这三个开关。
 */
export const GIT_DIFF_OUTPUT_ARGS: readonly string[] = [
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
];

/**
 * 只读子命令白名单（拍板口径：同 Roo Code `@git-changes` 三口，只读、无写操作）
 *
 * 这是「memora 允许对 git 做什么」的**唯一真源**：采集器只构造这三组 args，
 * wrapper 只执行命中本清单的 args——双向收窄，写操作从结构上进不来。
 *
 * 三组都由 `GIT_GLOBAL_ARGS` 派生（前缀只写一处）。diff 两口另带三个**输出形态**开关，
 * 缺一即出真伤（同样实测）：
 *   - `--no-color`：ANSI 污染不止是花屏——行首不再是 `diff --git `，`splitDiffChunks`
 *     的切点整体失效（实测 3 文件 → 1 段）⇒ 被 200 行闸当「一个文件」截断且注记撒谎。
 *     ⚠️ `NO_COLOR=1` **挡不住**显式 `color.diff=always`（实测），故本开关不可省；
 *   - `--no-ext-diff` / `--no-textconv`：`.gitattributes` + 仓库 config 指定的外部
 *     diff 驱动 / textconv 程序会被 `git diff` 执行（实测命中）——「只读」名不副实。
 */
export const GIT_COMMANDS: Record<'status' | 'diffUnstaged' | 'diffStaged', readonly string[]> = {
  /** 文件清单（porcelain v1 机器格式：两列状态位 + 路径） */
  status: [...GIT_GLOBAL_ARGS, 'status', '--porcelain'],
  /** 未暂存改动 */
  diffUnstaged: [...GIT_GLOBAL_ARGS, 'diff', ...GIT_DIFF_OUTPUT_ARGS],
  /** 已暂存改动（提交候选，展示优先级高于未暂存） */
  diffStaged: [...GIT_GLOBAL_ARGS, 'diff', '--cached', ...GIT_DIFF_OUTPUT_ARGS],
};

/**
 * wrapper 守卫用：白名单扁平化
 *
 * 第 3 笔 spawn 实现必须：① spawn 前校验 args 命中本清单（逐项相等），不命中即拒绝；
 * ② env 带 `NO_COLOR: '1'`（**辅助**而非主力：实测挡不住显式 `color.diff=always`，
 * ANSI 主责由白名单里的 `--no-color` 承担——两者不是替代关系，别因前者「看起来没用」
 * 就删它，它对 `color.ui=auto` 形态仍有价值）；
 * ③ `windowsHide: true`（同 environmentProvider 的 `probeRuntime` 先例，禁弹控制台窗口）；
 * ④ 设超时并按超时失败处置（大仓库 status/diff 可能慢，勿照搬 --version 量级的 5s）；
 * ⑤ cwd = 首个工作区根（与 `read_file` 的 cwd 同根，模型按清单路径才读得到）。
 */
export const GIT_COMMAND_WHITELIST: readonly (readonly string[])[] = Object.values(GIT_COMMANDS);

/** 文件数上限（第一道闸）：每个输出（清单 / 已暂存段 / 未暂存段）各自 ≤ 该值 */
export const GIT_FILES_LIMIT = 20;

/** 单文件 diff 行数上限（第二道闸）：超出即整行截断并**明示**（不静默） */
export const GIT_FILE_DIFF_MAX_LINES = 200;

/** 正文总长上限（第三道闸，字符）——与 problemsCollector 的 BODY_MAX_CHARS 同口径同量级 */
export const GIT_BODY_MAX_CHARS = 12_000;

/** 单行清单上限：porcelain 行 = 状态位 + 路径，病态长路径会单独撑爆总闸 */
const GIT_STATUS_LINE_MAX_CHARS = 500;

/** 失败详情（stderr 首行 / spawn error）引用上限：防整段编译器式报错刷屏 */
const FAILURE_DETAIL_MAX_CHARS = 200;

/** 一次 git 命令的执行结果（进程级事实，不做解释） */
export type GitExecResult = {
  /** 退出码；进程启动失败（ENOENT = 未安装 git）为 null */
  code: number | null;
  stdout: string;
  stderr: string;
  /** 进程级错误（spawn error，如 ENOENT）；与 code = null 同时出现 */
  error?: string;
};

/**
 * 注入式命令执行器（生产 = 第 3 笔 node spawn wrapper；测试 = 假执行器）
 *
 * @param args 只允许 `GIT_COMMANDS` 三组之一（wrapper 侧白名单守卫）
 * @param cwd git 运行目录（生产 = 首个工作区根；省略则 git 自行向上找 .git）
 */
export type GitExec = (args: readonly string[], cwd?: string) => Promise<GitExecResult>;

export type GitCollectInput = {
  exec: GitExec;
  /** git 运行目录（生产 = 首个工作区根；省略则 git 自行向上找 .git） */
  cwd?: string;
};

/** 单行限长（诊断模块的 clip 同款；此处不压空白——porcelain / stderr 首行本就是单行） */
function clipLine(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 取首行非空内容（stderr 可能多段，取第一行即可定位失败原因） */
function firstLine(text: string): string | undefined {
  return text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

/**
 * 执行结果 → 失败描述；成功返回 null
 *
 * 三类失败分开措辞：ENOENT（未安装）/ 无退出码（进程异常）/ 非零退出（git 自己的报错，
 * 如 128 + `fatal: not a git repository`）。混为一句「执行失败」会丢定位信息。
 */
function describeFailure(res: GitExecResult): string | null {
  if (res.error) {
    return `未能启动 git（${clipLine(res.error, FAILURE_DETAIL_MAX_CHARS)}）`;
  }
  if (res.code === null) {
    return 'git 进程异常终止（无退出码）';
  }
  if (res.code !== 0) {
    const detail = firstLine(res.stderr) ?? firstLine(res.stdout) ?? `退出码 ${res.code}`;
    return `执行失败（${clipLine(detail, FAILURE_DETAIL_MAX_CHARS)}）`;
  }
  return null;
}

/**
 * 把 `git diff` 输出切成**每文件一段**
 *
 * 切点 = 行首 `diff --git `（unified diff 的每文件起始标记）。段内正文行必带前缀字符
 * （' ' / '+' / '-' / '\'），不存在行首恰为 `diff --git ` 的内容行 ⇒ 误切只是理论情况。
 * 切不动时（如 merge 冲突态的 `diff --cc`）退化为单段，仍受单段行数闸约束，不会无界。
 */
function splitDiffChunks(output: string): string[] {
  const normalized = output.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  return normalized
    .split(/\n(?=diff --git )/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
}

/** 单文件段裁到行数上限；命中即**明示**（静默截断 = 静默失败族） */
function clipChunk(chunk: string): string {
  const lines = chunk.split('\n');
  if (lines.length <= GIT_FILE_DIFF_MAX_LINES) {
    return chunk;
  }
  const kept = lines.slice(0, GIT_FILE_DIFF_MAX_LINES).join('\n');
  return `${kept}\n…（该文件 diff 超过 ${GIT_FILE_DIFF_MAX_LINES} 行已截断）`;
}

/** 一个 diff 段的组装结果（段标签 / 裁剪后的文件段 / 省略数 / 段级失败） */
type DiffSection = {
  label: string;
  /** 已裁剪的文件段（每段一个文件的 diff，保持 git 原始输出） */
  chunks: string[];
  /** 因每段文件数上限被省略的文件数 */
  omitted: number;
  /** 段级失败事实行（status 已成功、仅该段命令失败时；段内其余内容让位给这句实话） */
  failure?: string;
};

function buildDiffSection(label: string, res: GitExecResult): DiffSection {
  const failure = describeFailure(res);
  if (failure) {
    return { label, chunks: [], omitted: 0, failure };
  }
  const all = splitDiffChunks(res.stdout);
  return {
    label,
    chunks: all.slice(0, GIT_FILES_LIMIT).map(clipChunk),
    omitted: Math.max(0, all.length - GIT_FILES_LIMIT),
  };
}

/**
 * 采集 git 未提交改动正文（有界、发送时刻调用）
 *
 * 执行顺序 = 展示优先级：文件清单 → 已暂存 diff → 未暂存 diff。已暂存在前是因为它是
 * 「提交候选」——「帮我的改动写提交信息」场景里它信息量最高。
 *
 * @returns 注入给模型的块正文。**永不返回空字符串**（挂了就一定有话说）：零改动 /
 *   非 git 仓库 / git 缺失 / 段执行失败都返回一行**事实说明**——用户挂了标签却什么都
 *   送不出去 = 静默失败，模型只会答非所问。
 */
export async function collectGitChangesText(input: GitCollectInput): Promise<string> {
  const { exec, cwd } = input;

  // ① 文件清单先行：status 失败 ⇒ 整体 fail-closed（连有哪些文件都不知道，
  //    后面两口 diff 没有运行意义）。fail-fast 同时省掉两次无用执行。
  const statusRes = await exec(GIT_COMMANDS.status, cwd);
  const statusFailure = describeFailure(statusRes);
  if (statusFailure) {
    return `git status ${statusFailure}，无法采集未提交改动。`;
  }

  const entries = statusRes.stdout
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim().length > 0);
  if (entries.length === 0) {
    // 零改动 = 诚实事实行（用户挂了标签就有权知道「确实干净」）
    return '当前没有未提交的改动（git status --porcelain 为空）。';
  }

  const untracked = entries.filter((line) => line.startsWith('??')).length;
  const listed = entries.slice(0, GIT_FILES_LIMIT);
  const statusSection = [
    `共 ${entries.length} 个文件有未提交改动（含 ${untracked} 个未跟踪项，git diff 不含未跟踪内容）：`,
    '（清单格式：两列状态位 + 路径；第一列 = 已暂存，第二列 = 未暂存，?? = 未跟踪）',
    ...listed.map((line) => clipLine(line, GIT_STATUS_LINE_MAX_CHARS)),
    entries.length > GIT_FILES_LIMIT
      ? `（清单仅列前 ${GIT_FILES_LIMIT} 个，共 ${entries.length} 个）`
      : '',
  ]
    .filter((part) => part.length > 0)
    .join('\n');

  // ② 两口 diff（已暂存在前，理由见函数头）
  const stagedRes = await exec(GIT_COMMANDS.diffStaged, cwd);
  const unstagedRes = await exec(GIT_COMMANDS.diffUnstaged, cwd);
  const staged = buildDiffSection('已暂存改动（git diff --cached）', stagedRes);
  const unstaged = buildDiffSection('未暂存改动（git diff）', unstagedRes);

  // ③ 组装单位（顺序即优先级）：清单（不可丢）→ 已暂存块 → 未暂存块。
  //    段标签缝在首块上：首块被丢时标签一并消失，由尾部注记交代丢了什么。
  type Unit = { text: string; section: string; droppable: boolean };
  const units: Unit[] = [{ text: statusSection, section: '', droppable: false }];
  for (const section of [staged, unstaged]) {
    if (section.failure) {
      units.push({ text: `${section.label}：${section.failure}`, section: '', droppable: false });
      continue;
    }
    section.chunks.forEach((chunk, index) => {
      units.push({
        text: index === 0 ? `${section.label}\n${chunk}` : chunk,
        section: section.label,
        droppable: true,
      });
    });
  }

  // ④ 总闸：严格尾部丢（一旦某块放不下，其后可丢块全丢）——简单可预期，注记如实交代。
  //    不可丢单元（清单 / 段失败事实行）永不被丢：事实比预算重要；其体量各有结构上限
  //    （清单 ≤ 20 行 × 500 字符），合计不会触及总闸。
  const notes: string[] = [];
  for (const section of [staged, unstaged]) {
    if (section.omitted > 0) {
      notes.push(
        `${section.label}省略 ${section.omitted} 个文件（超出每段 ${GIT_FILES_LIMIT} 个文件上限）`,
      );
    }
  }
  const kept: string[] = [];
  const budgetDropped = new Map<string, number>();
  let size = 0;
  let overflowing = false;
  for (const unit of units) {
    if (!unit.droppable) {
      kept.push(unit.text);
      size += unit.text.length + 1;
      continue;
    }
    const cost = unit.text.length + 1;
    if (!overflowing && size + cost <= GIT_BODY_MAX_CHARS) {
      kept.push(unit.text);
      size += cost;
      continue;
    }
    overflowing = true;
    budgetDropped.set(unit.section, (budgetDropped.get(unit.section) ?? 0) + 1);
  }
  for (const [section, count] of budgetDropped) {
    notes.push(`${section}省略 ${count} 个文件（正文总长超出 ${GIT_BODY_MAX_CHARS} 字符上限）`);
  }

  return [...kept, ...notes.map((note) => `（${note}）`)].join('\n');
}
