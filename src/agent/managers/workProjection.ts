/**
 * 作品投影管理 — 用户作品的「极简指针索引」（JSON 单文件存储）
 *
 * 定位：AI 工作前的项目地图——告诉 AI 项目里有哪些关键文件。
 * 存储：<memoraDir>/work-projections.json，JSON 数组。
 * 逻辑：只做索引，不存内容。source 指向真实文件，AI 按需 read_file 读取。
 */
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { logger } from '@/logging/logger.js';
import { getBaseName } from '@/utils/path.js';
import { resolveSafePath } from '@/utils/scanner.js';
import { atomicWriteFile } from '@/utils/atomicWrite.js';
// 常驻判据（单点，勿在本文件重写 `resident === true`）：注入块剔除常驻项需要同一把尺子
import {
  isResidentEntry,
  isResidentLayerEnabled,
  readResidentSource,
  evaluateResidentSegment,
  MAX_RESIDENT_SINGLE_CHARS,
  MAX_RESIDENT_TOTAL_CHARS,
} from './residentRules.js';

/** 投影文件名（位于 memoraDir 下） */
const PROJECTIONS_FILE = 'work-projections.json';

/** 装配注入块的标题前缀（常量，便于统一修改与国际化扩展） */
const CONTEXT_BLOCK_HEADER = '【项目索引】';

/** 装配注入块的提示文本（常量，便于统一修改与国际化扩展） */
const CONTEXT_BLOCK_FOOTER =
  '（项目关键文件指针。如需详细内容，请使用 read_file 读取对应 source 路径。）';

/**
 * 投影写队列（键 = 绝对文件路径，值 = 该路径上最后一次写入的链尾）
 *
 * 为什么必须放**模块级**：manager 实例按会话装配（每会话一个），实例级队列等于没锁——
 * 同一项目目录的两个会话仍会并发读改写同一文件，后写方静默覆盖先写方。
 *
 * 射程（定稿已明确，不自行扩）：仅覆盖**本 extension host 进程内**的写入方；
 * 跨进程（多窗口 / 用户手工编辑器改写）不在覆盖范围，仍按「最后落盘者胜」处理。
 */
const writeQueues = new Map<string, Promise<void>>();

/**
 * 在「按绝对文件路径」的进程内互斥队列上执行写入临界区
 *
 * 语义：同一路径的写入串行化，不同路径互不阻塞；前序任务失败**不阻断**本次，
 * 本次失败也**不毒化**后续（链上只保留顺序保证，失败由各任务自身的 try/catch 承担）。
 *
 * @param filePath 目标文件路径（内部统一 resolve 为绝对路径作锁键）
 * @param task 临界区任务（读盘 → 合并 → 落盘），必须自己吞掉业务失败
 * @returns 临界区任务的返回值（任务抛错时按原样抛给调用方处理）
 */
async function withFileWriteQueue<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  // 锁键：绝对路径——同一文件的不同写法（相对 / 符号链接前的写法）应共用同一队列
  const key = resolve(filePath);
  // 前序链尾（首次写入时为空队列）
  const previousTail = writeQueues.get(key) ?? Promise.resolve();
  // 前序失败只吞不传：失败不阻断本次（否则一次写失败会让该文件后续写入永久挂死）
  const start = previousTail.then(
    () => undefined,
    () => undefined,
  );
  // 本次任务（返回值给调用方，异常也原样交给调用方）
  const run = start.then(task);
  // 链尾：本次失败亦不毒化下一次
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  writeQueues.set(key, tail);
  // 空闲后回收 Map 条目（防长期运行下路径无限累积；仅当尾节点仍是本次登记的那一个）
  void tail.finally(() => {
    if (writeQueues.get(key) === tail) writeQueues.delete(key);
  });
  return run;
}

/**
 * 作品投影的极简结构（纯元数据指针）
 *
 * 同一实体两个消费面（不是两个实体）：`resident === true` ⇒ 条目正文进「项目常驻规则」固定段，
 * 且**不进**【项目索引】注入块；其余值 ⇒ 原作品投影（只进索引，模型按需 read_file）。
 * 设计锚：`hosts/memora-vscode/docs/resident-layer-design.md` §3.2 / §4.4。
 */
export interface WorkProjectionEntry {
  /** 作品名（默认取源文件名去扩展名） */
  name: string;
  /** 一句话说明（告诉 AI 这个文件是干什么的）；常驻后只服务清单展示，不进注入块 */
  description: string;
  /** 源文件路径（相对项目根，指向真实文件） */
  source: string;
  /**
   * 项目规则常驻标记（可选，新增）；**只有严格 `=== true` 才算常驻**（fail-closed）。
   * 判据唯一实现 = `residentRules.ts` 的 `isResidentEntry`，禁止在此或消费点写成 `Boolean(...)`
   * （`"false"` 字符串会变 true）。字段缺失 = 原作品投影，读取过滤器**不得**把缺失变成「记录消失」。
   */
  resident?: boolean;
}

/**
 * `setResident` 的粗粒度结果码（**固定七态**，宿主按它给可读文案）
 *
 * 与「单条读取失败」的细粒度原因（`ResidentSourceFailure`）分工：
 * - 细粒度原因只进内核日志与 message，**不暴露为返回码**；
 * - 公开面只保留「不存在 / 存在但被判据拒绝使用」这个二分（`source-missing` vs `source-rejected`），
 *   `source-rejected` 内部覆盖四类原因（工作区外 / 凭据文件 / 非文本 / 读取失败），message 各不相同。
 *
 * ⚠️ 已知折中：清单**写入失败**（磁盘只读 / 权限不足）在七态里没有独立槽位，折进 `source-rejected`
 * 并在 message 标注「可重试」——若后续需要独立态，须与设计文档同步修订并更新公开面基线。
 */
export type SetResidentReason =
  /** 已置为项目规则（成功；含「本来就是」的幂等成功，不重复写盘） */
  | 'enabled'
  /** 已取消项目规则（成功；含「本来就不是」的幂等成功，不重复写盘） */
  | 'disabled'
  /** 清单里没有该条目的登记记录（**绝不新建条目**；清单损坏导致无法定位也归此态，靠 message 区分） */
  | 'not-found'
  /** 工作区未受信任（`workspaceTrusted` 非布尔 `true`）：先拒且**不读正文** */
  | 'untrusted'
  /** 单条或合计超出注入上限（`MAX_RESIDENT_SINGLE_CHARS` / `MAX_RESIDENT_TOTAL_CHARS`） */
  | 'too-long'
  /** 源文件不存在（读盘 ENOENT）——「不存在」与「存在但不可用」刻意分开 */
  | 'source-missing'
  /** 源文件存在但被判据拒绝使用（工作区外 / 凭据 / 非文本 / 读取失败）；message 区分四类 */
  | 'source-rejected';

/**
 * `setResident` 返回面
 *
 * 只有 `enabled` / `disabled` 是成功（其余均为「未写入」）。判定一律走 `reason`，
 * 不提供独立的 `ok` 布尔——两套真假源必然漂移。
 */
export interface SetResidentResult {
  /** 粗粒度结果码（七态） */
  reason: SetResidentReason;
  /** 人读文案（宿主直接展示；`source-rejected` 的 message 已是四类细分） */
  message: string;
}

/**
 * `unregisterWork` 的结果码（语义：**只删清单条目，不删源文件**）
 *
 * 命名与 `registerWork` 成对——撤销的是「登记」，不是磁盘上的文件本身；
 * 文案里也必须显式写「未删除任何文件」，让「删条目」与「删文件」不可能混淆。
 */
export type UnregisterWorkReason =
  /** 已从清单移除（成功） */
  | 'removed'
  /** 清单里没有该条目（未写盘、不删文件） */
  | 'not-found'
  /** 清单文件格式错误（fail-safe，绝不改写原文件） */
  | 'list-malformed'
  /** 落盘失败（可重试；原文件可能未被改动） */
  | 'write-failed';

/** `unregisterWork` 返回面（成功唯一 = `removed`；判定走 `reason`，不设 `ok` 布尔） */
export interface UnregisterWorkResult {
  /** 粗粒度结果码（四态） */
  reason: UnregisterWorkReason;
  /** 人读文案（宿主原样展示） */
  message: string;
}

/**
 * 管理面条目快照：`resident` 已按 SSOT 判据（`isResidentEntry`）归一为布尔
 *
 * 宿主 QuickPick / 右键状态只许读这个字段，**不得**自行判 `entry.resident === true`
 * （字符串 `"true"` 会被 `Boolean` 误认成常驻，与内核判据分叉）。
 */
export interface ManagedWorkEntry {
  /** 作品名 */
  name: string;
  /** 一句话说明 */
  description: string;
  /** 源文件路径（相对项目根） */
  source: string;
  /** 是否常驻（已归一；判据唯一实现 = `isResidentEntry`） */
  resident: boolean;
}

/**
 * 作品投影管理器：极简索引读写
 *
 * 并发说明：**进程内**写入已按绝对文件路径串行化（模块级 `withFileWriteQueue`，
 * 见上方队列注释）——所有写入方经 `registerWork` 汇入同一临界区：
 * 锁 → `refresh()` 重读盘 → 合并 → `atomicWriteFile`，消除「读-改-写」竞态。
 * 跨进程（多窗口 / 用户手工改写）不覆盖，仍按「最后落盘者胜」（定稿射程）。
 */
export class WorkProjectionManager {
  /** 投影文件路径（<memoraDir>/work-projections.json） */
  private readonly filePath: string;
  /** 项目根目录（用于路径穿越防御，可选） */
  private readonly projectDir?: string;
  /**
   * 工作区信任态快照（宿主传入；**非布尔 `true` 一律按未信任**，与 `AgentOptions.workspaceTrusted`
   * 同一句判据，不另写一套措辞）
   *
   * 唯一消费面 = `setResident` 的第一道闸（置 true 前置检查）。注入块渲染不读它——
   * 渲染侧的闸在 `ResidentRulesManager`（同一判据函数 `isResidentLayerEnabled`）。
   */
  private readonly workspaceTrusted?: boolean;
  /** 投影登记回调（宿主通知用，可选） */
  private readonly onGenerated?: (sourcePath: string, description: string) => void;
  /** 已加载投影缓存（refresh() 同步自磁盘，contextBlock() 读取此缓存） */
  private entries: WorkProjectionEntry[] = [];
  /** 最近一次 refresh 是否检出「文件存在但格式错误」（非数组根/损坏），用于 registerWork fail-safe 防覆盖 */
  private fileWasMalformed = false;

  /**
   * @param memoraDir 项目级 .memora/ 目录
   * @param onGenerated 投影登记回调（宿主通知用，可选）
   * @param projectDir 项目根目录（用于路径穿越防御，可选）
   * @param workspaceTrusted 工作区信任态快照（**非 `true` 一律按未信任**，与
   *   `AgentOptions.workspaceTrusted` 同一句判据；缺省 = 未信任，置常驻一律拒绝）
   */
  constructor(
    memoraDir: string,
    onGenerated?: (sourcePath: string, description: string) => void,
    projectDir?: string,
    workspaceTrusted?: boolean,
  ) {
    this.filePath = join(memoraDir, PROJECTIONS_FILE);
    this.onGenerated = onGenerated;
    this.projectDir = projectDir;
    this.workspaceTrusted = workspaceTrusted;
  }

  /**
   * 查询投影文件格式是否异常（只读状态）
   *
   * 用于调用方区分「无投影条目」与「投影文件格式错误被跳过」两种情况：
   * - true：文件存在但格式非顶层 JSON 数组或损坏，registerWork 会拒绝写入以防覆盖
   * - false：文件格式正常或不存在（空项目）
   */
  get isFileMalformed(): boolean {
    return this.fileWasMalformed;
  }

  /**
   * 登记作品索引（register_work 工具数据源）
   *
   * 向 JSON 数组追加/更新一条记录。**同 source 为 upsert**：只覆盖 `name` / `description`，
   * 保留既有条目的**未知字段**（如 `resident` 及未来新增字段），不再整条替换。
   * 写入在**进程内按文件路径串行**的临界区中完成（锁 → 重读盘 → 合并 → 原子写）。
   *
   * @param sourcePath 源文件路径（相对项目根）
   * @param description 作品的一句话说明
   * @returns 登记成功的投影条目（含保留的既有字段）；失败返回 null
   */
  async registerWork(sourcePath: string, description: string): Promise<WorkProjectionEntry | null> {
    // 路径穿越防御：验证 sourcePath 不越界（纯校验，不触碰磁盘，放在临界区外）
    if (this.projectDir && resolveSafePath(this.projectDir, sourcePath) === null) {
      logger.warn({ sourcePath }, '作品投影登记失败：source 路径越界');
      return null;
    }

    // 提取作品名（文件名去扩展名；getBaseName 返回带扩展名末段，故需补一次去扩展名）
    const baseName = getBaseName(sourcePath).replace(/\.[^.]+$/, '') || 'unknown';

    // 本次登记要写入的字段（其余既有字段由临界区内的 upsert 合并保留）
    const incoming: WorkProjectionEntry = {
      name: baseName,
      description: normalizeDescription(description),
      source: toSingleLine(sourcePath),
    };

    try {
      // 所有写入方最终都汇到本临界区：锁 → refresh() 重读盘 → 合并 → atomicWriteFile
      return await withFileWriteQueue(this.filePath, async () => {
        // 临界区内重读盘：磁盘是真相源，缓存可能已被本实例或别的实例写脏
        await this.refresh();

        // fail-safe：预存文件格式错误（非数组根/损坏）时不覆盖写盘，避免丢失用户原索引
        // （与路径越界守卫同构：不可解析的文件不擅自改写）
        if (this.fileWasMalformed) {
          logger.warn(
            { file: this.filePath },
            '作品投影登记中止：预存文件格式错误，已跳过以免覆盖原索引；请修正为顶层 JSON 数组后重试',
          );
          return null;
        }

        // upsert：命中同 source 时只覆盖 name/description，保留既有条目的未知字段
        // （整条替换会静默丢弃后来写入的字段，且没有任何测试会红）
        const existingIndex = this.entries.findIndex((e) => e.source === incoming.source);
        // 实际落盘的条目（新登记 or 合并后的既有条目）
        let saved: WorkProjectionEntry;
        if (existingIndex >= 0) {
          saved = {
            // 既有条目（findIndex 已保证存在；展开它即保留全部未知字段）
            ...this.entries[existingIndex]!,
            name: incoming.name,
            description: incoming.description,
          };
          this.entries[existingIndex] = saved;
        } else {
          saved = incoming;
          this.entries.push(saved);
        }

        await mkdir(dirname(this.filePath), { recursive: true });
        await atomicWriteFile(this.filePath, JSON.stringify(this.entries, null, 2));

        logger.info({ file: sourcePath, name: saved.name }, '作品投影已登记');
        this.onGenerated?.(sourcePath, saved.description);

        return saved;
      });
    } catch (err) {
      logger.warn({ err, file: sourcePath }, '作品投影登记失败');
      return null;
    }
  }

  /**
   * 置 / 取消「项目常驻规则」（清单里已登记条目的**字段翻转**，绝不新建条目）
   *
   * 关键纪律（与设计 §5.4 / §6.1 对齐）：
   * 1. **置 true 先判信任**：`workspaceTrusted` 非布尔 `true` ⇒ 立即 `untrusted`，**不读正文**；
   * 2. **只翻字段**：命中条目后仅改 `resident`，保留 name/description/未知字段，不重建对象；
   * 3. **同一把尺子**：单条上限用 `readResidentSource` 产出的渲染块长度，合计上限用装配期同一个
   *    `evaluateResidentSegment`（禁止在此另写一套加总逻辑，否则两处判定必然漂移）；
   * 4. **同一把锁**：写入与 `registerWork` 共用 `withFileWriteQueue`（锁 → 重读盘 → 改字段 → 原子写）；
   * 5. **置 false 不做前置读盘/限额/信任检查**：用户必须随时能关掉（未信任时也能关）。
   *
   * @param sourcePath 清单里的源文件路径（相对项目根；按单行归一后精确匹配 `source`）
   * @param resident true = 置为项目规则；false = 取消
   * @returns 七态结果（只有 `enabled` / `disabled` 是写入成功）
   */
  async setResident(sourcePath: string, resident: boolean): Promise<SetResidentResult> {
    const source = toSingleLine(sourcePath);

    // 取消路径：不读正文、不判上限、不看信任态
    if (resident !== true) {
      return this.writeResidentFlag(source, false);
    }

    // 第一道闸：未信任 ⇒ 先拒且不读正文（fail-closed；判据与 AgentOptions.workspaceTrusted 同源）
    if (!isResidentLayerEnabled(this.workspaceTrusted)) {
      logger.warn({ source }, '置常驻被拒：工作区未受信任（非 true 一律按未信任）');
      return {
        reason: 'untrusted',
        message: '工作区未受信任，无法把文件置为项目规则；请先信任当前工作区',
      };
    }

    // 缺项目根 ⇒ 无法做路径守卫/读盘（装配期总会传；此处只防误用，一律拒绝）
    if (!this.projectDir) {
      logger.error({ source }, '置常驻被拒：未提供项目根目录，无法校验源文件');
      return {
        reason: 'source-rejected',
        message: `无法校验源文件（管理器未提供项目根目录）：${source}`,
      };
    }

    // 读盘 + 单条上限：临界区外（不依赖清单状态，且必须先证明「可用且不超单条」再落盘）
    const read = await readResidentSource(this.projectDir, source);
    if (!read.ok) {
      // 细粒度原因只进日志；公开面按「不存在 / 存在但被判据拒绝使用」二分
      logger.warn({ source, failure: read.failure }, '置常驻被拒：源文件不可用');
      return {
        reason: read.failure === 'missing' ? 'source-missing' : 'source-rejected',
        message: read.message,
      };
    }
    if (read.block.length > MAX_RESIDENT_SINGLE_CHARS) {
      const message =
        `该文件含标题行共 ${read.block.length} 字符，超过单条 ${MAX_RESIDENT_SINGLE_CHARS} 上限 ` +
        `${read.block.length - MAX_RESIDENT_SINGLE_CHARS} 字符；本次未写入：${source}`;
      logger.warn({ source, length: read.block.length }, '置常驻被拒：单条超出上限');
      return { reason: 'too-long', message };
    }

    return this.writeResidentFlag(source, true);
  }

  /**
   * 常驻字段的落盘实现（`setResident` 的唯一写入口，置 true / false 共用）
   *
   * 临界区：锁 → `refresh()` 重读盘 → 定位条目 → （仅置 true）合计闸 → 翻字段 → 原子写。
   *
   * @param source 已单行归一的源路径
   * @param value 目标值
   * @returns 七态结果
   */
  private async writeResidentFlag(source: string, value: boolean): Promise<SetResidentResult> {
    try {
      return await withFileWriteQueue(this.filePath, async () => {
        // 临界区内重读盘：磁盘是真相源（别的会话实例可能刚写过）
        await this.refresh();

        // fail-safe：清单损坏 ⇒ 定位不到条目，绝不改写原文件（同 registerWork 的防线）
        if (this.fileWasMalformed) {
          logger.warn({ file: this.filePath }, '置常驻中止：清单文件格式错误，无法定位条目');
          return {
            reason: 'not-found',
            message: '作品投影清单文件格式错误，无法定位条目；请修正为顶层 JSON 数组后重试',
          };
        }

        const index = this.entries.findIndex((e) => e.source === source);
        if (index < 0) {
          logger.warn({ source }, '置常驻中止：清单无该条目（不新建条目）');
          return {
            reason: 'not-found',
            message: `作品投影清单中没有该文件的登记记录；请先登记再置为项目规则：${source}`,
          };
        }

        const entry = this.entries[index]!;
        // 幂等：目标态已成立 ⇒ 不重复写盘
        if (value === true && isResidentEntry(entry)) {
          return { reason: 'enabled', message: `该文件已是项目规则（未重复写入）：${source}` };
        }
        if (value === false && !isResidentEntry(entry)) {
          return { reason: 'disabled', message: `该文件本来就不是项目规则（未改写）：${source}` };
        }

        // 合计闸（仅置 true）：用装配期同一个求值函数算「加上本条之后」的合计渲染长度
        if (value === true && this.projectDir) {
          const candidateSources = this.entries
            .map((e, i) => (i === index ? { ...e, resident: true } : e))
            .filter(isResidentEntry)
            .map((e) => e.source);
          const evaluation = await evaluateResidentSegment(this.projectDir, candidateSources);
          // 兜底：本条在求值时被判 too-long（临界区外已查过一次，二次读盘后文件可能变长）
          const selfFailure = evaluation.failures.find((f) => f.source === source);
          if (selfFailure) {
            logger.warn({ source, reason: selfFailure.reason }, '置常驻被拒：求值判定本条不可注入');
            return { reason: 'too-long', message: selfFailure.message };
          }
          if (evaluation.segment.length > MAX_RESIDENT_TOTAL_CHARS) {
            const overflow = evaluation.segment.length - MAX_RESIDENT_TOTAL_CHARS;
            const message =
              `加入本条后常驻段合计 ${evaluation.segment.length} 字符，超过合计 ` +
              `${MAX_RESIDENT_TOTAL_CHARS} 上限 ${overflow} 字符；本次未写入：${source}`;
            logger.warn({ source, length: evaluation.segment.length }, '置常驻被拒：合计超出上限');
            return { reason: 'too-long', message };
          }
        }

        // 只翻字段：保留既有对象的全部字段（含未来新增字段），不重建条目
        entry.resident = value;

        await mkdir(dirname(this.filePath), { recursive: true });
        await atomicWriteFile(this.filePath, JSON.stringify(this.entries, null, 2));

        logger.info(
          { file: source, resident: value },
          value ? '已置为项目常驻规则' : '已取消项目常驻规则',
        );
        return {
          reason: value ? 'enabled' : 'disabled',
          message: value ? `已置为项目规则：${source}` : `已取消项目规则：${source}`,
        };
      });
    } catch (err) {
      // 已知折中：七态无「写失败」槽位 ⇒ 折进 source-rejected，message 标注可重试（见类型注释）
      logger.error({ err, file: source }, '置常驻失败：清单写入失败');
      return {
        reason: 'source-rejected',
        message: `作品投影清单写入失败（可重试）：${(err as Error)?.message ?? String(err)}`,
      };
    }
  }

  /**
   * 从磁盘加载投影数据
   *
   * @returns 当前全部投影条目
   */
  async refresh(): Promise<WorkProjectionEntry[]> {
    try {
      const content = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(content);
      // 验证数据格式（必须是顶层数组，与作品投影设计约定一致）
      if (Array.isArray(parsed)) {
        this.fileWasMalformed = false;
        this.entries = parsed.filter((e) => e && e.source && e.name);
      } else {
        // 非数组根（如 {"entries":[...]} 错形态）→ 读路径不静默清空、显式告警；
        // 写路径由 registerWork 经 fileWasMalformed 标志 fail-safe 中止，不覆盖用户原索引
        logger.warn(
          { file: this.filePath },
          '作品投影文件根节点非数组，已忽略（预期顶层 JSON 数组；请改为 [...] 形态后重试）',
        );
        this.fileWasMalformed = true;
        this.entries = [];
      }
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'ENOENT') {
        // 文件不存在（尚未登记任何作品）→ 视为空，可安全写入
        logger.debug({ err }, '作品投影文件不存在，返回空');
      } else {
        // 文件存在但读取/解析失败（损坏或非法 JSON）→ 标记错形态，交 registerWork fail-safe 拦截，不覆盖原文件
        logger.warn({ err, file: this.filePath }, '作品投影文件读取或解析失败，暂不加载原内容');
        this.fileWasMalformed = true;
      }
      this.entries = [];
    }
    return this.entries;
  }

  /**
   * 获取全部作品投影
   *
   * @returns 全部投影条目的副本
   */
  async listWorks(): Promise<WorkProjectionEntry[]> {
    return this.refresh();
  }

  /**
   * 管理面清单（含归一后的常驻态）
   *
   * 供宿主 QuickPick / 右键状态展示：`resident` 由 `isResidentEntry` 判定一次，
   * 宿主不得再对原始字段做二次判断（否则 `"true"` 字符串会在两处得出不同答案）。
   *
   * @returns 条目快照（磁盘为准；调用即重读盘）
   */
  async listManagedWorks(): Promise<ManagedWorkEntry[]> {
    const entries = await this.refresh();
    return entries.map((e) => ({
      name: e.name,
      description: e.description,
      source: e.source,
      resident: isResidentEntry(e),
    }));
  }

  /**
   * 从清单移除一条登记（**只删条目，不删源文件**）
   *
   * 与 `setResident` / `registerWork` 共用同一条写队列（锁 → 重读盘 → 定位 → splice → 原子写）：
   * 多会话 / 多命令并发时不会把别人刚写的条目覆盖回去。
   *
   * 纪律：① 清单格式错误 ⇒ fail-safe，绝不改写原文件；② 未命中不新建、不写盘；
   * ③ 只动清单数组，**不触碰任何源文件**。
   *
   * @param sourcePath 清单里的源文件路径（相对项目根；单行归一后精确匹配 `source`）
   * @returns 四态结果（成功唯一 = `removed`）
   */
  async unregisterWork(sourcePath: string): Promise<UnregisterWorkResult> {
    const source = toSingleLine(sourcePath);
    try {
      return await withFileWriteQueue(this.filePath, async () => {
        // 临界区内重读盘：磁盘是真相源（别的会话实例可能刚写过）
        await this.refresh();

        // fail-safe：损坏清单定位不到条目，且改写会覆盖用户原内容（同 registerWork 的防线）
        if (this.fileWasMalformed) {
          logger.warn({ file: this.filePath }, '移除登记中止：清单文件格式错误');
          return {
            reason: 'list-malformed',
            message: '作品投影清单文件格式错误，未移除任何条目；请修正为顶层 JSON 数组后重试',
          };
        }

        const index = this.entries.findIndex((e) => e.source === source);
        if (index < 0) {
          logger.warn({ source }, '移除登记中止：清单无该条目（不删文件、不新建）');
          return {
            reason: 'not-found',
            message: `作品投影清单中没有该文件的登记记录（未删除任何文件）：${source}`,
          };
        }

        // 只删清单里的这一条；其余条目（含其未知字段）原样保留
        this.entries.splice(index, 1);
        await mkdir(dirname(this.filePath), { recursive: true });
        await atomicWriteFile(this.filePath, JSON.stringify(this.entries, null, 2));

        logger.info({ file: source }, '已从作品投影清单移除登记（源文件未删）');
        return {
          reason: 'removed',
          message: `已从清单移除登记（源文件未删除）：${source}`,
        };
      });
    } catch (err) {
      logger.error({ err, file: source }, '移除登记失败：清单写入失败');
      return {
        reason: 'write-failed',
        message: `作品投影清单写入失败（可重试）：${(err as Error)?.message ?? String(err)}`,
      };
    }
  }

  /**
   * 装配注入块（极简元数据清单）
   *
   * 仅注入 name + description + source 清单，不注入任何正文。
   * AI 根据 description 判断相关性，自主 read_file 读取原文。
   *
   * **常驻项剔除**（设计 §4.1-⑤ / §4.4）：`resident === true` 的条目正文已由常驻规则段承载，
   * 留在索引会形成「同一对象的两种描述」并诱导模型再 read_file 一次。剔除只作用于**注入块**；
   * 清单展示面（QuickPick / 右键状态）照常列出，用户必须看得见、能取消。
   *
   * 注意：此方法读取内存缓存（上一次 refresh() 同步的结果）。
   * 若需从磁盘强制刷新，请使用 loadAndGetContextBlock()。
   *
   * @returns 装配注入文本块；无投影（或全部为常驻项）时为空串
   */
  contextBlock(): string {
    // 判据走 residentRules 的 isResidentEntry（SSOT），不在此重写 `=== true`
    const listed = this.entries.filter((e) => !isResidentEntry(e));
    if (listed.length === 0) return '';

    const parts: string[] = [CONTEXT_BLOCK_HEADER];
    for (const e of listed) {
      parts.push(`- ${e.name}：${e.description} (源: ${e.source})`);
    }
    parts.push('');
    parts.push(CONTEXT_BLOCK_FOOTER);

    return parts.join('\n');
  }

  /**
   * SSOT 读取路径：从磁盘刷新后返回装配注入块
   *
   * 将 refresh() + contextBlock() 合为单一操作，消除调用方"先刷新再读取"的时序依赖。
   * 装配层和需要实时数据的场景应使用此方法，而非分别调用 refresh() 和 contextBlock()。
   *
   * @returns 装配注入文本块；刷新失败或无投影时为空串
   */
  async loadAndGetContextBlock(): Promise<string> {
    try {
      await this.refresh();
    } catch (err) {
      // 刷新失败（如文件损坏/权限异常）时记录日志并降级为空串，不阻断装配主流程
      // refresh() 内部已将 entries 重置为空 + 标记 fileWasMalformed，此处仅补充上下文日志
      logger.warn({ err, file: this.filePath }, '作品投影 SSOT 读取路径刷新失败，降级为空索引');
    }
    return this.contextBlock();
  }
}

/**
 * 单行化处理：折叠换行为空格，防止格式注入
 */
function toSingleLine(value: string): string {
  return value.replace(/\r?\n/g, ' ').trim();
}

/**
 * 描述归一化：单行化 + 限长截断
 *
 * 内核统一归一层，防止 system prompt 膨胀。不在此调 LLM（内核零三方依赖、不持 provider），
 * 超长仅硬截断并加省略号。
 */
const MAX_DESCRIPTION_LENGTH = 100;

function normalizeDescription(value: string): string {
  const single = toSingleLine(value);
  if (single.length <= MAX_DESCRIPTION_LENGTH) return single;
  return single.slice(0, MAX_DESCRIPTION_LENGTH) + '…';
}
