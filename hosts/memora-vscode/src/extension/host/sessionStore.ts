/**
 * 工作区会话存储 — ISessionStore 实现（JSON 文件落盘）
 *
 * 存储模型（round-based 单一模式，SSOT）：
 *   - 会话仅持有 Round ID 列表（roundIdsStore）；消息内容只存在于 RoundStore（物理真相源）
 *   - 消息读写经 roundIds → RoundStore 展开 / 成 Round 写入，绝无 legacy 扁平消息列表
 *   - 与设计文档 §3.2 对齐：SessionMeta 不含 storageMode 之类的模式标识字段
 * 职责：
 *   - 将 memora 对话 Round ID 列表持久化到工作区（6.0.0 起**每会话一文件**）
 *   - 实现 ISessionStore 接口，注入 Agent，让跨会话对话记录可回溯（traceSummary 依赖）
 *   - 承载「留存区」分组标签与会话级「上次停留时刻」——两者都是**会话自身属性**，
 *     随会话文件落盘，见 `archivedIdsSet` / `lastActiveAtStore` 声明处语义边界
 *   - 原子写入：每个文件都经 atomicWriteFileSync（.tmp → rename）防崩溃半截
 *
 * 落盘布局（拆文件的目的：原来整文件读改写 ⇒ 跨进程各写一个会话也会整份互相覆盖）：
 *   - `sessions/<encodeURIComponent(sessionId)>.json`：
 *     `{ sessionId, meta, roundIds, archived?, lastActiveAt? }`
 *     （roundIds 随会话文件走，会话内容仍只存在于 RoundStore）
 *   - **没有全局共享文件**：归档标记与停留时刻都写进会话自己的文件，写一个会话只触碰该文件
 *   - 旧 `sessions.json` 全量摊平后改名 `sessions.json.migrated` 保留（作回退副本）
 *   - 旧 `_global.json`（step 2 过渡形态）的归档标记 / 停留会话摊进会话文件后改名
 *     `_global.json.migrated`（作回退副本）；**此后不再读取它**
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildSessionId,
  defaultSessionTitle,
  isRoundSettled,
  LOOP_CONSTANTS,
  type IRoundStore,
  type ISessionStore,
  type SessionMessage,
  type SessionMeta,
} from '@zooique/memora';
import { atomicWriteFileSync } from './atomicWriteSync.js';
import { resolveProjectDataDir } from './projectDataDir.js';
import { WorkspaceRoundStore } from './workspaceRoundStore.js';

/** 会话目录名（相对 `.memora`）：每会话一文件，写一个会话不触碰其他会话 */
const SESSIONS_DIR_NAME = 'sessions';
/** 旧单文件（迁移源） */
const LEGACY_FILE_NAME = 'sessions.json';
/** 旧单文件迁移完成后的保留名（回退副本，不自动删除） */
const LEGACY_MIGRATED_NAME = 'sessions.json.migrated';
/** step 2 过渡期的全局态文件（迁移源；归档标记 / 停留会话在此，迁移后不再读取） */
const LEGACY_GLOBAL_FILE_NAME = '_global.json';
/** 全局态迁移完成后的保留名（回退副本，不自动删除） */
const LEGACY_GLOBAL_MIGRATED_NAME = '_global.json.migrated';

/**
 * 单会话文件形态
 *
 * `meta` 可为 null（内核分叉先 setRoundIds 后 updateSessionMeta 的时序窗口内只有 roundIds）；
 * `sessionId` 写在内容里而**不是**从文件名反解——会话名可能含路径分隔符等不安全字符。
 *
 * `archived` / `lastActiveAt` 是**会话自身属性**（不是全局清单的两个条目）：
 *   - `archived`：留存区分组标签；缺省（不写 key）= 归属近期列表
 *   - `lastActiveAt`：该会话最后一次被浏览的时刻（ISO）；缺省 = 从未停留过
 * 两者都不参与任何数据判据（见字段声明处语义边界），丢了只影响界面分组 / 默认落点。
 */
interface SessionFileShape {
  sessionId: string;
  meta: SessionMeta | null;
  roundIds: string[];
  /** 留存区标记（true = 留存区；省略 = 近期列表） */
  archived?: boolean;
  /** 上次停留时刻（ISO 8601；`getInitialSessionId` 取最大者） */
  lastActiveAt?: string;
}

/** 旧单文件形态（迁移源，字段名沿用旧版） */
interface LegacySessionFileShape {
  metas?: Record<string, SessionMeta>;
  roundIdsStore?: Record<string, string[]>;
  archivedIds?: string[];
  lastActiveSessionId?: string;
}

/** step 2 全局态形态（迁移源；`schemaVersion` 无消费者，迁移时直接丢弃） */
interface LegacyGlobalStateShape {
  lastActiveSessionId?: string;
  archivedIds?: string[];
}

/**
 * 截断结果（truncateFrom 返回值）：ok = 锚点命中并完成截断；
 * removedIds = 被物理删除（引用归零的孤儿）的 Round 列表，供调用方联动软删其记忆摘要（⑥）；
 * removedUserText = 截断起点 Round 的 user 原文（regenerate 重新生成重发用——真源 = 随轮
 * 落盘的 store，webview 的 DOM dataset 只是投影不作为重发文本；删除场景忽略此字段）
 */
export interface RoundTruncateResult {
  ok: boolean;
  removedIds: string[];
  removedUserText?: string;
}

/**
 * 工作区会话存储
 */
export class WorkspaceSessionStore implements ISessionStore {
  /** 会话标题元数据：sessionId → SessionMeta */
  private metas = new Map<string, SessionMeta>();
  /** Round ID 列表存储：sessionId → roundId[]（round-based 唯一真相源） */
  private roundIdsStore = new Map<string, string[]>();
  /** 会话级「上次停留时刻」：sessionId → ISO（落盘于会话文件 `lastActiveAt`） */
  private lastActiveAtStore = new Map<string, string>();
  /** 问答闭环物理存储（IRoundStore 实现，文件落盘） */
  private readonly roundStore: IRoundStore;
  /** 会话目录绝对路径（`sessions/`，每会话一文件） */
  private readonly sessionsDir: string;
  /** 旧单文件绝对路径（迁移源） */
  private readonly legacyFilePath: string;
  /** 迁移完成后的旧文件保留路径（回退副本） */
  private readonly legacyMigratedPath: string;
  /** step 2 全局态文件绝对路径（迁移源，迁移后改名不再读取） */
  private readonly legacyGlobalPath: string;
  /** 全局态迁移完成后的保留路径（回退副本） */
  private readonly legacyGlobalMigratedPath: string;

  /**
   * 「留存区」会话标记（**视图层分组标签，不是数据状态**）
   *
   * 语义边界（易与第一直觉相反，务必先读）：
   *   - 打标的会话**什么都没变**：Round 文件原地不动、**引用计数不减**（保持 refCount > 0，
   *     `WorkspaceRoundStore.sweepOrphans` 天然不碰 ⇒ 24h 保洁不会吃掉留存数据），
   *     会话仍出现在 `listSessions()` 结果里；变的只有「显示在哪个分组」。
   *   - 因此本集合**只能供给 UI 分屏显示**，**不得**被任何数据层判据消费
   *     （不得作为「能否删除 / 能否写入 / 是否参与 GC」的条件）。若将来有人想拿它做判据，
   *     那是新需求，须单独拍板——因为那会把「视图标签」升格为「数据状态」，本文件的
   *     所有不变式随之改变。
   *
   * 为什么存在：会话原文（Round）是摘要记忆的**溯源原文**——删了等于只留结论、烧掉证据。
   * 留存区解决「要保留，但不该污染近期列表」。
   *
   * 落盘位置：**该会话自己的文件**（`archived: true`），不是全局清单——归档只写一个文件，
   * 不存在跨进程共享写点。迁移自 step 2 的 `_global.json.archivedIds`，见 `migrateLegacyGlobal()`。
   *
   * 可退出路径：本字段是可丢弃的纯数据（删掉整个字段 + 三个读写点即回到无留存区形态），
   * 且不影响既有会话的任何现有语义（此处未改任何既有判据，只新增能力面）。
   */
  private archivedIdsSet = new Set<string>();

  /**
   * 内存态「上次停留的会话」（**只服务本进程内读，不落盘**）
   *
   * 由 `setLastActiveSession` 更新、`getInitialSessionId` 读取；重启后为空 ⇒ 退回
   * `lastActiveAt` / `updatedAt`。保留内存字段是为了不把「停留」退化成纯磁盘事件，
   * 但**它的持久化真源已迁到会话文件的 `lastActiveAt`**。
   */
  private lastActiveSessionId = '';

  /**
   * @param workspacePath 工作区路径（落盘目录 `.memora`）
   * @param roundStore 问答闭环存储；缺省时在同工作区新建文件级 WorkspaceRoundStore 并 load()
   */
  constructor(workspacePath: string, roundStore?: IRoundStore) {
    // 落盘目录经单点推导（唯一计算点 = projectDataDir.ts，禁就地拼字面量）
    const dataDir = resolveProjectDataDir(workspacePath);
    this.sessionsDir = join(dataDir, SESSIONS_DIR_NAME);
    this.legacyFilePath = join(dataDir, LEGACY_FILE_NAME);
    this.legacyMigratedPath = join(dataDir, LEGACY_MIGRATED_NAME);
    this.legacyGlobalPath = join(this.sessionsDir, LEGACY_GLOBAL_FILE_NAME);
    this.legacyGlobalMigratedPath = join(this.sessionsDir, LEGACY_GLOBAL_MIGRATED_NAME);
    if (roundStore) {
      this.roundStore = roundStore;
    } else {
      const rs = new WorkspaceRoundStore(workspacePath);
      rs.load();
      this.roundStore = rs;
    }
    // 引用真源单点注入：RoundStore 不持有会话，孤儿判定必须回读本存储的 roundIds。
    // 由此内核定时 GC 与宿主启动清扫都读同一套引用集合（不再读 Round.refCount）。
    if (this.roundStore instanceof WorkspaceRoundStore) {
      this.roundStore.setReferencedIdsProvider(() => new Set(this.referencedIds()));
    }
  }

  /**
   * 当前被任意会话引用的 Round ID 全集（**引用真源**）
   *
   * 供孤儿判定现场派生（内核 GC / 宿主启动清扫都经 `WorkspaceRoundStore.setReferencedIdsProvider`
   * 回读本方法）。返回「此刻真实被引用」的集合，不是缓存计数。
   */
  referencedIds(): string[] {
    const ids = new Set<string>();
    for (const roundIds of this.roundIdsStore.values()) {
      for (const id of roundIds) ids.add(id);
    }
    return Array.from(ids);
  }

  /**
   * 从磁盘加载会话（目录不存在则空）
   *
   * 顺序固定：先补摊旧单文件 → 再摊旧全局态 → 最后扫会话文件。
   * 两步迁移都必须先于扫描：扫描只认 `sessions/*.json`，旧数据不摊进来就永远看不见。
   */
  load(): void {
    this.metas.clear();
    this.roundIdsStore.clear();
    this.archivedIdsSet.clear();
    this.lastActiveAtStore.clear();
    this.lastActiveSessionId = '';
    try {
      mkdirSync(this.sessionsDir, { recursive: true });
    } catch (err) {
      // 目录都建不出来 ⇒ 后续读写全部降级为空（不阻塞插件启动）
      console.warn('Memora 会话目录创建失败，降级为空', err);
      return;
    }
    this.migrateLegacyFile();
    this.migrateLegacyGlobal();
    this.loadSessionFiles();
  }

  /**
   * 旧单文件 → 每会话文件（可重入 / 可断点续摊）
   *
   * 触发判据 = **旧 `sessions.json` 仍存在**（未被改名为 `.migrated`），与会话目录空不空无关：
   * 摊到一半崩溃时，`sessions/` 已非空但旧文件仍在 ⇒ 下次启动继续补摊缺失的会话，
   * 已存在的一律跳过（**以每会话文件为准，不覆盖**）。全部补齐后才改名 `.migrated`。
   * 这样最坏结果是「暂时少看见」，不是「永久少看见」。
   *
   * 旧档里的 `archivedIds` 是**最老形态**（归档标记还写在会话清单里）：摊平会话文件时
   * 顺带把标记写进对应会话文件的 `archived` 字段，不另起一套迁移。
   */
  private migrateLegacyFile(): void {
    if (!existsSync(this.legacyFilePath)) return;
    let legacy: LegacySessionFileShape;
    try {
      legacy = JSON.parse(readFileSync(this.legacyFilePath, 'utf8')) as LegacySessionFileShape;
    } catch (err) {
      // 坏档不删（保留可人工修复），只告警；本次启动只见已有会话文件
      console.warn('Memora 旧会话单文件损坏，跳过迁移（文件保留）', err);
      return;
    }
    const archivedIds = new Set(
      Array.isArray(legacy.archivedIds)
        ? legacy.archivedIds.filter((id): id is string => typeof id === 'string')
        : [],
    );
    const ids = new Set<string>([
      ...Object.keys(legacy.metas ?? {}),
      ...Object.keys(legacy.roundIdsStore ?? {}),
    ]);
    // 旧档的导航指针（若有）落到目标会话文件：取迁移时刻，使其在这次迁移后仍胜出
    const migratedAt = new Date().toISOString();
    for (const sessionId of ids) {
      const target = this.sessionFilePath(sessionId);
      // 已存在即视为「本次（或上次）已摊过」：以会话文件为准，不覆盖
      if (existsSync(target)) continue;
      const meta = legacy.metas?.[sessionId] ?? null;
      const roundIds = legacy.roundIdsStore?.[sessionId] ?? [];
      if (!meta && roundIds.length === 0) continue;
      const body: SessionFileShape = {
        sessionId,
        meta,
        roundIds,
        ...(archivedIds.has(sessionId) ? { archived: true } : {}),
        ...(legacy.lastActiveSessionId === sessionId ? { lastActiveAt: migratedAt } : {}),
      };
      atomicWriteFileSync(target, JSON.stringify(body, null, 2));
    }
    // 全部补齐后才落幕：改名保留（回退副本）。Windows 下目标已存在 rename 会失败，先清旧副本
    try {
      if (existsSync(this.legacyMigratedPath)) unlinkSync(this.legacyMigratedPath);
      renameSync(this.legacyFilePath, this.legacyMigratedPath);
    } catch (err) {
      // 改名失败不影响可读性（下次启动重试；本轮已补齐全部会话）
      console.warn('Memora 旧会话单文件改名失败，下次启动重试', err);
    }
  }

  /**
   * step 2 全局态 → 会话自身属性（可重入 / 可断点续摊，复用同一套「已存在跳过」纪律）
   *
   * 触发判据 = **`_global.json` 仍存在**（未改名 `.migrated`），与文件内容无关：
   * 摊到一半崩溃时 `_global.json` 仍在 ⇒ 下次启动继续补摊；已打标字段的文件跳过
   * （`archived` 已存在 / `lastActiveAt` 已存在 = 上次已写过，以会话文件为准不覆盖）。
   * 全部补齐后才改名 `.migrated`。
   *
   * 两个字段的去向：
   *   - `archivedIds` → 对应会话文件的 `archived: true`（归档是会话自身属性）
   *   - `lastActiveSessionId` → 对应会话文件的 `lastActiveAt`（取迁移时刻，使旧指针仍胜出）
   * 目标会话文件不存在 ⇒ 跳过（幽灵 id 不再落盘，界面对照会话列表自然看不见）。
   * `schemaVersion` 无任何消费者 ⇒ 直接丢弃，不再落盘。
   */
  private migrateLegacyGlobal(): void {
    if (!existsSync(this.legacyGlobalPath)) return;
    let legacy: LegacyGlobalStateShape;
    try {
      legacy = JSON.parse(readFileSync(this.legacyGlobalPath, 'utf8')) as LegacyGlobalStateShape;
    } catch (err) {
      console.warn('Memora 旧全局态文件损坏，跳过迁移（文件保留）', err);
      return;
    }
    const archivedIds = new Set(
      Array.isArray(legacy.archivedIds)
        ? legacy.archivedIds.filter((id): id is string => typeof id === 'string')
        : [],
    );
    const lastActive =
      typeof legacy.lastActiveSessionId === 'string' ? legacy.lastActiveSessionId : '';
    const patch = (sessionId: string, add: Partial<SessionFileShape>): void => {
      const path = this.sessionFilePath(sessionId);
      if (!existsSync(path)) return;
      try {
        const data = JSON.parse(readFileSync(path, 'utf8')) as Partial<SessionFileShape>;
        // 已有字段 = 上次迁移已写过（会话文件是更新的事实），不覆盖
        const next: SessionFileShape = {
          sessionId: typeof data.sessionId === 'string' ? data.sessionId : sessionId,
          meta: (data.meta as SessionMeta | null) ?? null,
          roundIds: Array.isArray(data.roundIds) ? data.roundIds : [],
          ...(typeof data.archived === 'boolean' ? { archived: data.archived } : {}),
          ...(typeof data.lastActiveAt === 'string' ? { lastActiveAt: data.lastActiveAt } : {}),
        };
        if (typeof data.archived !== 'boolean' && add.archived) next.archived = true;
        if (typeof data.lastActiveAt !== 'string' && add.lastActiveAt) {
          next.lastActiveAt = add.lastActiveAt;
        }
        atomicWriteFileSync(path, JSON.stringify(next, null, 2));
      } catch (err) {
        console.warn(`Memora 全局态迁移失败，跳过：${sessionId}`, err);
      }
    };
    for (const sessionId of archivedIds) patch(sessionId, { archived: true });
    if (lastActive) patch(lastActive, { lastActiveAt: new Date().toISOString() });
    // 全部补齐后才落幕（回退副本；此后不再读取）
    try {
      if (existsSync(this.legacyGlobalMigratedPath)) unlinkSync(this.legacyGlobalMigratedPath);
      renameSync(this.legacyGlobalPath, this.legacyGlobalMigratedPath);
    } catch (err) {
      console.warn('Memora 旧全局态文件改名失败，下次启动重试', err);
    }
  }

  /** 扫描会话目录：只认 `*.json`，排除 `_global.json` 与 `*.tmp`（否则临时/全局文件会被当会话） */
  private loadSessionFiles(): void {
    let names: string[];
    try {
      names = readdirSync(this.sessionsDir);
    } catch (err) {
      console.warn('Memora 会话目录读取失败，降级为空', err);
      return;
    }
    for (const name of names) {
      // 白名单判据：必须以 .json 结尾；排除迁移残留的 `_global.json` 与原子写的 .tmp 中间态
      // （`.migrated` 不以 .json 结尾，天然被上一行排除）
      if (!name.endsWith('.json') || name.endsWith('.tmp')) continue;
      if (name === LEGACY_GLOBAL_FILE_NAME) continue;
      try {
        const data = JSON.parse(
          readFileSync(join(this.sessionsDir, name), 'utf8'),
        ) as Partial<SessionFileShape>;
        // **以文件内 sessionId 为准，不靠文件名反解**（会话名可能含分隔符，文件名是编码形态）
        const sessionId = data.sessionId;
        if (typeof sessionId !== 'string' || sessionId.length === 0) continue;
        if (data.meta && typeof data.meta === 'object') {
          this.metas.set(sessionId, data.meta as SessionMeta);
        }
        if (Array.isArray(data.roundIds) && data.roundIds.length > 0) {
          this.roundIdsStore.set(
            sessionId,
            data.roundIds.filter((id): id is string => typeof id === 'string'),
          );
        }
        // 会话自身属性：归档标记 / 上次停留时刻（缺省即未归档 / 从未停留）
        if (data.archived === true) this.archivedIdsSet.add(sessionId);
        if (typeof data.lastActiveAt === 'string' && data.lastActiveAt.length > 0) {
          this.lastActiveAtStore.set(sessionId, data.lastActiveAt);
        }
      } catch (err) {
        // 单文件坏只丢这一个会话，不连坐其他会话（旧实现是整份清空）
        console.warn(`Memora 会话文件损坏，跳过：${name}`, err);
      }
    }
  }

  /** 会话文件的物理路径（文件名 = encodeURIComponent(sessionId)，避免分隔符污染目录树） */
  private sessionFilePath(sessionId: string): string {
    return join(this.sessionsDir, `${encodeURIComponent(sessionId)}.json`);
  }

  /** 原子写单个会话文件（只触碰该会话，不重写其他会话） */
  private writeSessionFile(sessionId: string): void {
    const meta = this.metas.get(sessionId) ?? null;
    const roundIds = this.roundIdsStore.get(sessionId) ?? [];
    if (!meta && roundIds.length === 0) {
      // 会话已无任何内容 ⇒ 不落空壳文件
      this.removeSessionFile(sessionId);
      return;
    }
    const archived = this.archivedIdsSet.has(sessionId);
    const lastActiveAt = this.lastActiveAtStore.get(sessionId);
    const body: SessionFileShape = {
      sessionId,
      meta,
      roundIds,
      ...(archived ? { archived: true } : {}),
      ...(lastActiveAt ? { lastActiveAt } : {}),
    };
    atomicWriteFileSync(this.sessionFilePath(sessionId), JSON.stringify(body, null, 2));
  }

  /** 删除单个会话文件（不存在则忽略） */
  private removeSessionFile(sessionId: string): void {
    try {
      const path = this.sessionFilePath(sessionId);
      if (existsSync(path)) unlinkSync(path);
    } catch (err) {
      console.warn(`Memora 会话文件删除失败：${sessionId}`, err);
    }
  }

  /** 加载指定会话的完整消息列表（从 roundIds → RoundStore 展开） */
  loadMessages(date: string, session: string): SessionMessage[] {
    // 组装 sessionId（SSOT 契约 buildSessionId，date+session 双向一致）
    const sessionId = buildSessionId(date, session);
    const roundIds = this.getRoundIds(sessionId);
    if (roundIds.length === 0) return [];
    const rounds = this.roundStore.getByIds(roundIds);
    const messages: SessionMessage[] = [];
    // 历史图片窗口衰减（真机验收 IMG-2 第 13 子块断点B修复）：与内核
    // `messageHistory.loadRoundBasedMessages` / `inMemorySessionStore.loadMessages`
    // **三处同判据同构**（含 `indexOf` 取位方式）——本方法是 restoreHistory 生产路径
    // 唯一上游，漏带 attachments = 重启后历史图全灭（模型只见纯文本，连占位都没有）；
    // 不带衰减则窗口外图片灌爆上下文。索引以 roundIds 序为准（getByIds 会跳过缺失项）。
    const currentIdx = roundIds.length - 1;
    for (const round of rounds) {
      const idx = roundIds.indexOf(round.id);
      const withImages = currentIdx - idx < LOOP_CONSTANTS.RETAIN_IMAGE_ROUNDS;
      const userAttachments = withImages ? round.userMessage.attachments : undefined;
      messages.push({
        role: round.userMessage.role,
        content: round.userMessage.content,
        timestamp: round.userMessage.timestamp,
        roundId: round.id,
        ...(userAttachments ? { attachments: userAttachments } : {}),
      });
      // 判据收口 isRoundSettled：中断轮（interrupted）同样计入——本方法是 LLM 历史注入
      // （restoreHistory）唯一上游，漏计会让中断轮回复从上下文消失（与内核
      // inMemorySessionStore.loadMessages 逐字同构，勿单侧改判据）
      if (round.assistantMessage && isRoundSettled(round.status)) {
        messages.push({
          role: round.assistantMessage.role,
          content: round.assistantMessage.content,
          timestamp: round.assistantMessage.timestamp,
          roundId: round.id,
        });
      }
    }
    return messages;
  }

  /**
   * 删除整条会话（历史浮层垃圾桶触发）：Round ID 列表 + 元数据 + 检查点。
   *
   * @param sessionId 会话标识（YYYY-MM-DD-sessionName）
   * @returns 被移入回收站的 Round ID 列表，供调用方联动软删其记忆摘要（⑥）
   */
  deleteSession(sessionId: string): string[] {
    const roundIds = this.roundIdsStore.get(sessionId) ?? [];
    // ① 先注销会话（引用真源 = roundIds；引用消失必须先于物理回收，派生结果才准确）
    this.roundIdsStore.delete(sessionId);
    this.metas.delete(sessionId);
    // 留存区标记同步摘除（**唯一清理点**）：会话已不存在，若留着标记会让留存区分组出现
    // 无标题的幽灵条目（标记是挂载在 sessionId 上的视图标签，随会话删除一并失效）。
    // 由此本方法对「近期列表条目」与「留存区条目」是同一条删除链路，不需要第二个删除 API。
    this.archivedIdsSet.delete(sessionId);
    // 导航指针同步失效（**防御性清理**）：指针指向的会话已不存在时若留着它，下次启动
    // 会静默切到一个空会话（内核 switchToSession 对不存在会话不报错，见 getInitialSessionId）。
    // 宿主 UI 有「当前会话不可删」守卫，故正常路径走不到这里——本行兜的是手工删数据 /
    // 换机同步 / 旧档残留等外部入口。
    if (this.lastActiveSessionId === sessionId) this.lastActiveSessionId = '';
    this.lastActiveAtStore.delete(sessionId);
    // 只删该会话文件（不碰其他会话；没有任何全局共享文件需要重写）
    this.removeSessionFile(sessionId);

    // ② 现场重算引用集合：仍被其他会话（含分叉）引用的轮保留，无人引用才移入回收站。
    // 这替代了旧的 refCount 递减 + 删轮循环——计数不是真源，派生才是。
    const referenced = new Set(this.referencedIds());
    const removedIds: string[] = [];
    for (const roundId of roundIds) {
      if (referenced.has(roundId)) continue;
      if (this.roundStore.delete(roundId)) removedIds.push(roundId);
    }
    return removedIds;
  }

  // ─── 留存区分组标签（宿主扩展能力，非 ISessionStore 契约） ───

  /**
   * 把会话移入留存区（纯视图改位，**不动任何数据**）
   *
   * 刻意不改的东西（这是本方法的核心不变式，改动前必读）：
   *   - **不收缩会话 `roundIds`**：引用真源是 roundIds，留存区保留引用，轮就不会成为孤儿；
   *     `WorkspaceRoundStore.sweepOrphans`（宿主启动清理，默认 24h 存活保护）按引用集合
   *     现场派生候选，故「存了但 24 小时后被自家保洁清空」不会发生——与立项目的
   *     （保住记忆溯源的原文）一致。
   *   - **不移 files、不改 Round 内容**：Round 原地留在 `.memora/rounds/`，记忆里的 roundId
   *     依旧可指到原文。
   *
   * 幂等：重复打标无副作用（Set 语义）。
   *
   * @param sessionId 会话标识（YYYY-MM-DD-sessionName）
   * @returns 是否为本次新增标记（false = 已在留存区，或会话不存在）
   */
  archiveSession(sessionId: string): boolean {
    if (!this.roundIdsStore.has(sessionId) && !this.metas.has(sessionId)) return false;
    if (this.archivedIdsSet.has(sessionId)) return false;
    this.archivedIdsSet.add(sessionId);
    // 归档只写该会话自己的文件（`archived: true`），不存在跨进程共享写点
    this.writeSessionFile(sessionId);
    return true;
  }

  /**
   * 把会话移回归属列表（留存区标记的逆操作，同样只动视图层）
   *
   * @returns 是否移回成功（false = 本就不在留存区）
   */
  unarchiveSession(sessionId: string): boolean {
    if (!this.archivedIdsSet.delete(sessionId)) return false;
    // 只写该会话自己的文件（`archived` 键随之移除）
    this.writeSessionFile(sessionId);
    return true;
  }

  /** 该会话是否在留存区（供 host 侧渲染分组，纯查询） */
  isArchived(sessionId: string): boolean {
    return this.archivedIdsSet.has(sessionId);
  }

  /**
   * 留存区标记全集（**单一真源**，webview 侧据此给列表分组）
   *
   * 为何只下发 id 集合、不下发「近期 / 留存」两份列表：同一份会话数据切成两个数组 = 两份真相源，
   * 一旦某会话的标记与数组归属不同步就会出现「两边都有 / 两边都没有」。故保持单数据源 +
   * 前端按本集合过滤，任何时刻的出入口都是本方法。
   */
  listArchivedIds(): string[] {
    return [...this.archivedIdsSet];
  }

  /**
   * 截断会话：删除指定轮及其之后的所有轮（`delete_turn` / `regenerate` 共用唯一截断面）。
   *
   * 锚 = `roundId`（**轮身份**）：`roundIds` 本就是有序真源，`indexOf` 即定位；未命中 ⇒
   * `ok:false` 且一轮不删（陈旧 DOM / 该轮已被别处删除），调用方如实回「删除失败」。
   *
   * 为什么不按 ts：旧实现用「首条 assistant ts >= 锚」作下界匹配，再对无 assistant 的
   * 中断轮做**单层**折回——两支都是在时间窗上猜身份。相邻两个中断轮时折回只退一层，仍落在
   * 更靠后的完成轮上（DELETE-ANCHOR-1 实测：点第一轮的删除，第三轮被删、第一轮原地不动）。
   * ts 是 Round 的投影（一次落盘时刻），不能反过来当身份用。
   *
   * @param date 会话日期 YYYY-MM-DD
   * @param session 会话标识
   * @param roundId 目标轮 `Round.id`（底栏 / 菜单从容器 dataset.roundId 取，非时间戳）
   * @returns 截断结果（ok = 锚点命中并完成；removedIds = 引用归零被物理删除的 Round，供联动软删记忆摘要）
   */
  truncateFrom(date: string, session: string, roundId: string): RoundTruncateResult {
    // 组装 sessionId（SSOT 契约 buildSessionId）
    const sessionId = buildSessionId(date, session);
    const roundIds = this.roundIdsStore.get(sessionId);
    if (!roundIds || roundIds.length === 0) return { ok: false, removedIds: [] };
    const idx = roundIds.indexOf(roundId);
    if (idx === -1) return { ok: false, removedIds: [] };
    // 截断起点 Round 的 user 原文（regenerate 重发真源；在删除循环前取，防对象状态歧义）。
    // 只取该轮而非整批 `getByIds(roundIds)`：后者会跳过缺失项（见 loadMessages 注释），
    // 整批下标与 roundIds 不同源，按下标取位会错轮。
    const removedUserText = this.roundStore.getByIds([roundId])[0]?.userMessage?.content;
    // 截断 [idx, 末尾) 的全部 Round：**先收缩 roundIds 真源**，再派生引用集合判 0
    const kept = roundIds.slice(0, idx);
    this.roundIdsStore.set(sessionId, kept);
    // 同步元数据（roundIds 真源为 roundIdsStore，读时派生；此处仅更新 messageCount）
    const existing = this.metas.get(sessionId);
    if (existing) {
      this.metas.set(sessionId, { ...existing, messageCount: this.deriveMessageCount(sessionId) });
    }
    // 只重写本会话文件（先收缩 roundIds 真源再落盘）
    this.writeSessionFile(sessionId);

    const removed = roundIds.slice(idx);
    // 现场重算：被其他会话（分叉）仍引用的轮保留；无人引用才移入回收站
    const referenced = new Set(this.referencedIds());
    const removedIds: string[] = [];
    for (const id of removed) {
      if (referenced.has(id)) continue;
      if (this.roundStore.delete(id)) removedIds.push(id);
    }
    return { ok: true, removedIds, removedUserText };
  }

  listSessions(): string[] {
    // 收集 round-based 模式的会话
    const sessions = new Set<string>(this.roundIdsStore.keys());
    // 收集有元数据的会话（可能没有消息但有 meta）
    for (const sessionId of this.metas.keys()) {
      sessions.add(sessionId);
    }
    return [...sessions];
  }

  /**
   * 读取会话标题元数据
   *
   * round-based 单一模式：会话仅持 roundIds，无 legacy 扁平消息；占位元数据按 roundIds 推导。
   * 仅当会话存在 roundIds 或 meta 时才返回，否则视为会话不存在（如已删除）返回 undefined，
   * 避免删除后又被占位元数据「复活」（deleteSession 契约：删除后 getSessionMeta 应为 undefined）。
   */
  getSessionMeta(sessionId: string): SessionMeta | undefined {
    // SSOT：SessionMeta 为纯展示 DTO（无 roundIds），Round ID 需经 getRoundIds() 真源读取
    const meta = this.metas.get(sessionId);
    if (meta) {
      // 计数读值一律现场派生（O(1)）：与下方占位兜底路径同口径，读值不信任缓存副本——
      // 派生真源 = deriveMessageCount（单一真源，见其注释），副本仅服务持久化形态
      return { ...meta, messageCount: this.deriveMessageCount(sessionId) };
    }
    // round-based 会话兜底：如果有 Round ID 列表，创建占位元数据
    const roundIds = this.roundIdsStore.get(sessionId);
    if (roundIds && roundIds.length > 0) {
      return {
        sessionId,
        displayName: defaultSessionTitle(),
        // updatedAt **不得取 now()**：占位 meta 每次查询都重新生成，用 now() 等于把该会话
        // 永久标成「刚刚活跃」⇒ 在 listSessionMetas 的 updatedAt 降序里恒排第一，启动时
        // 抢走「最近写入」位把用户带进无关会话。而「新会话首轮刚落盘、SessionNamer 尚未
        // 回写 autoName」正是缺 meta 的常态窗口。
        // 取会话 id 前缀日期（buildSessionId 契约编码的真实数据，非编造）的当日零点：
        // 同日排最后（零点是最早时刻），跨日仍落在自己那一天，语义 = 「具体时刻未知」。
        updatedAt: `${sessionId.slice(0, 10)}T00:00:00.000Z`,
        messageCount: this.deriveMessageCount(sessionId),
      };
    }
    return undefined;
  }

  /**
   * 更新 LLM 生成只读元数据（双层命名单一写点）：
   * autoName/keyTopics/summary 由内核 SessionNamer/SessionArchiver 写入；displayName
   * 由用户手动改名（renameSession）写入。setSessionTitle 亦收口于此，避免双路径分叉
   * （缺此实现时内核 updateSessionMeta 调用静默 no-op，自动命名/改名失效）。
   *
   * 合并语义 = **既有 meta 基底 + 传入 Partial 覆盖**（与内核
   * `inMemorySessionStore.updateSessionMeta` 同构），使非本次入参字段（`createdAt` 等）
   * 一并留存——纯白名单式重建会静默丢弃它们，而内核在分叉路径显式传 `createdAt`
   * （`messageHistory.forkSession` 内的 `updateSessionMeta(newSessionId, { createdAt })`），
   * 丢一次即永久不可恢复（本文件是落盘真相源）。
   *
   * 末位显式覆盖三项（不用纯 spread 的理由与语义）：
   *   - autoName/displayName/keyTopics/summary：调用方可传显式 `undefined`（`Partial` 允许）
   *     → 语义是「缺省 = 保留既有」，`?? existing` 才是该语义；纯 spread 会把既有值抹掉
   *   - updatedAt：改名/命名都不是活跃事件 → 保留既有，不刷新
   *   - messageCount：命名不重置计数 → 保留既有；**无既有 meta 时由
   *     `deriveMessageCount` 派生，禁写 0**
   *
   * ⚠️ 无既有 meta 分支为何必须派生：内核
   * `messageHistory.forkSession` 是「先 `setRoundIds(newSessionId, ...)` 再
   * `updateSessionMeta(newSessionId, {createdAt})`」——调用时刻 roundIds 已就位而 meta
   * 尚不存在（`setRoundIds` 内的计数回写因 `if (!meta) return` 提前退出）。写 0 会让
   * 分叉会话在 meta 上留下假值 0，而 `getSessionMeta` 见 meta 即直接返回（不走
   * roundIds 占位兜底），于是 `getMessageCount()` 对它返回 0（真值 N*2）。
   *
   * @param sessionId 会话标识（YYYY-MM-DD-sessionName）
   * @param meta 部分元数据（autoName/displayName/keyTopics/summary/createdAt）
   */
  updateSessionMeta(sessionId: string, meta: Partial<SessionMeta>): void {
    const existing = this.metas.get(sessionId);
    const updated: SessionMeta = {
      // 基底 + 覆盖：非本次入参字段（createdAt 等）随基底留存，不被白名单重建丢弃
      ...existing,
      ...meta,
      sessionId,
      // 以下显式行：入参未给时回退既有值（而非被 spread 抹成 undefined）
      autoName: meta.autoName ?? existing?.autoName,
      displayName: meta.displayName ?? existing?.displayName ?? defaultSessionTitle(),
      keyTopics: meta.keyTopics ?? existing?.keyTopics,
      summary: meta.summary ?? existing?.summary,
      // 归档防重快照（同族保护）：调用方显式传 `undefined` 不抹既有值——与上方
      // autoName/keyTopics/summary 同语义（缺省 = 保留既有）。⚠ 被抹的后果不是丢个展示值，
      // 而是**跨进程防重失效**：重启后内核回退读本字段拿到 undefined ⇒ 判「无归档记录」
      // ⇒ 对「内容未变、早归档过」的会话又烧一次 LLM——正是该字段要治的那个重复烧。
      archivedMessageCount: meta.archivedMessageCount ?? existing?.archivedMessageCount,
      // 改名/命名非活跃事件：不重置 updatedAt 与计数
      updatedAt: existing?.updatedAt ?? new Date().toISOString(),
      messageCount: existing?.messageCount ?? this.deriveMessageCount(sessionId),
    };
    this.metas.set(sessionId, updated);
    this.writeSessionFile(sessionId);
  }

  /**
   * 修改会话标题：手动改名不改 updatedAt，收口到 updateSessionMeta 单一写点
   */
  setSessionTitle(sessionId: string, title: string): void {
    this.updateSessionMeta(sessionId, { displayName: title });
  }

  /**
   * 列出全部会话标题元数据：按 updatedAt 降序（最新在前）
   *
   * 覆盖所有已持久化会话：先取 metas，再补全有 roundIds 但无 meta 的会话。
   */
  listSessionMetas(): SessionMeta[] {
    const all = new Map(this.metas);
    // 补全 round-based 模式的会话（有 roundIds 但无 meta）
    for (const key of this.roundIdsStore.keys()) {
      if (!all.has(key)) {
        const derived = this.getSessionMeta(key);
        if (derived) all.set(key, derived);
      }
    }
    return [...all.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  // ─── Round-based 模式方法 ─────────────────────────────────

  /**
   * 追加 Round ID 到会话（round-based 模式）
   *
   * @param sessionId - 会话 ID
   * @param roundId - 要追加的 Round ID
   */
  appendRoundId(sessionId: string, roundId: string): void {
    const roundIds = this.roundIdsStore.get(sessionId) ?? [];
    roundIds.push(roundId);
    this.roundIdsStore.set(sessionId, roundIds);

    // 更新元数据（roundIds 真源为 roundIdsStore，读时派生）
    this.updateRoundBasedMessageCount(sessionId);
    // 只写本会话文件：跨进程写不同会话互不覆盖（本步的核心收益）
    this.writeSessionFile(sessionId);
  }

  /**
   * 批量追加 Round ID 到会话（round-based 模式）
   *
   * @param sessionId - 会话 ID
   * @param roundIds - 要追加的 Round ID 数组
   */
  appendRoundIds(sessionId: string, roundIds: string[]): void {
    const existing = this.roundIdsStore.get(sessionId) ?? [];
    const merged = [...existing, ...roundIds];
    this.roundIdsStore.set(sessionId, merged);

    // 更新元数据（roundIds 真源为 roundIdsStore，读时派生）
    this.updateRoundBasedMessageCount(sessionId);
    this.writeSessionFile(sessionId);
  }

  /**
   * 获取会话的 Round ID 列表（round-based 模式）
   *
   * @param sessionId - 会话 ID
   * @returns Round ID 数组（按顺序）
   */
  getRoundIds(sessionId: string): string[] {
    return this.roundIdsStore.get(sessionId) ?? [];
  }

  /**
   * 设置会话的 Round ID 列表（round-based 模式）
   *
   * 用于创建新会话或完整替换（如分叉操作）
   *
   * @param sessionId - 会话 ID
   * @param roundIds - 新的 Round ID 列表
   */
  setRoundIds(sessionId: string, roundIds: string[]): void {
    this.roundIdsStore.set(sessionId, [...roundIds]);

    // 更新元数据（roundIds 真源为 roundIdsStore，读时派生）
    this.updateRoundBasedMessageCount(sessionId);
    this.writeSessionFile(sessionId);
  }

  /**
   * 创建新会话元数据（round-based 模式）
   *
   * @param meta - 会话元数据
   */
  createSession(meta: SessionMeta): void {
    // SSOT：SessionMeta 为纯展示 DTO（无 roundIds），设置轮次请走 setRoundIds 真源
    this.metas.set(meta.sessionId, { ...meta });
    this.writeSessionFile(meta.sessionId);
  }

  // ─── 私有辅助方法 ─────────────────────────────────────

  /**
   * 更新 round-based 会话的消息计数
   *
   * SSOT 边界（与 inMemorySessionStore 同口径）：*2 是「每个已收场轮 = User+AI」的固有语义缓存，
   * 在 append 时点轮已收场，与精确 countMessagesInRounds 等价（两者判据同为 isRoundSettled）；
   * 免加载物理 Round（O(1)）。真源取自 roundIdsStore（meta 不持有 roundIds）。
   */
  private updateRoundBasedMessageCount(sessionId: string): void {
    const meta = this.metas.get(sessionId);
    if (!meta) return;

    this.metas.set(sessionId, {
      ...meta,
      messageCount: this.deriveMessageCount(sessionId),
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * 派生会话消息数（round-based 固有语义：`roundIds.length * 2`）——**单一真源**。
   *
   * 与内核 `inMemorySessionStore.deriveMessageCount` 同款（内核注释明示「派生逻辑单一真源
   * = deriveMessageCount」）：本文件四处消费（`getSessionMeta` 占位兜底、`truncateFrom`
   * 截断同步、`append/setRoundIds` 计数回写、`updateSessionMeta` 无 meta 兜底）一律经本
   * 方法，**禁止各写一遍 `length * 2`**——派生口径一旦变化（如改为只计已收场轮），
   * 散落实现必漏改其一，meta 与 roundIds 立刻分叉。
   */
  private deriveMessageCount(sessionId: string): number {
    const roundIds = this.roundIdsStore.get(sessionId) ?? [];
    return roundIds.length * 2;
  }

  // ─── 上次停留时刻（会话级属性，宿主扩展能力，非 ISessionStore 契约） ───

  /**
   * 启动初始会话 = **唯一判据点**（chatPanel 构造时消费）
   *
   * 优先级：本进程内刚停留的会话 → 会话文件里 `lastActiveAt` 最大者 → 不可用则退回
   * 「最近写入」的会话（updatedAt 降序 [0]）→ 再无则空串（空串的语义 = 从未有过会话，
   * 由宿主 `ensureInitialSession` 建首个会话）。
   *
   * 为何必须做存在性校验：内核 `switchToSession` 对**不存在的会话不报错**（加载消息返空、
   * 循环工作记忆清空）⇒ 陈旧记录的后果是「静默切到一个空会话」，用户看到空屏却零报错，
   * 比抛错更难排查。故停留记录必须能在本地解析出实体（有 meta 或有 roundIds）才采信。
   *
   * 为何不记住空会话：新建后未发消息的会话在其会话文件里既无 meta 也无 roundIds
   * ⇒ 重启后无法与「已被删除的会话」区分。不赌，统一退回最近写入的会话；
   * 用户丢的只是一个还没写东西的空壳，而赌输的代价是空屏（不带伤优先）。
   */
  getInitialSessionId(): string {
    // 本进程内的停留（setLastActiveSession 刚写过的情况）优先，且必须能解析出实体
    const inMemory = this.lastActiveSessionId;
    if (inMemory && (this.metas.has(inMemory) || this.roundIdsStore.has(inMemory))) {
      return inMemory;
    }
    // 持久化真源 = 会话文件里的 `lastActiveAt`（会话自身属性，取最大者）；同样只采信可解析的会话
    let latestSessionId = '';
    let latestAt = '';
    for (const [sessionId, at] of this.lastActiveAtStore) {
      if (!this.metas.has(sessionId) && !this.roundIdsStore.has(sessionId)) continue;
      if (at > latestAt) {
        latestSessionId = sessionId;
        latestAt = at;
      }
    }
    if (latestSessionId) return latestSessionId;
    // 旧数据 / 从未停留过：退回「最近写入」（updatedAt 降序的 [0]）
    return this.listSessionMetas()[0]?.sessionId ?? '';
  }

  /**
   * 记录「用户正停在这个会话」——宿主在切会话 / 新建 / 分叉三条路径上调用
   *
   * 幂等：同值不重复落盘。切会话在 UI 上可能被重复触发（含 `switchToSession` 的提前返回
   * 路径），每次重写会话文件毫无收益，且会放大写入失败面。
   *
   * 落盘位置 = **该会话自己的文件**（`lastActiveAt`），不是全局共享文件：导航只触碰被停留
   * 的那个会话文件；两进程停在不同会话时互不覆盖。空壳会话（无 meta/roundIds）不落盘。
   *
   * 同步写（非异步排队）：这是「关掉插件前排最后发生的事」，异步写会在进程退出瞬间丢。
   * 本字段**非数据路径**：丢了只退回「最近写入」会话，不影响任何会话 / 轮次可见性。
   */
  setLastActiveSession(sessionId: string): void {
    if (!sessionId || this.lastActiveSessionId === sessionId) return;
    this.lastActiveSessionId = sessionId;
    this.lastActiveAtStore.set(sessionId, new Date().toISOString());
    this.writeSessionFile(sessionId);
  }
}

/**
 * 聊天面板消费的会话存储契约（**宿主扩展面的单一真源**）
 *
 * 迁自 chatPanel 内联定义：该文件已贴 `max-lines` 闸门（新增必先腾等量行），而本类型描述的
 * 正是本文件实现的类，放这里语义更近、面板也不必为契约变更反复腾行。
 *
 * 组成 = 内核 `ISessionStore` + 宿主扩展能力（删会话返回被回收轮 / 截断 / 标题元数据 /
 * 留存分组 / 导航指针）。`Omit<ISessionStore,'deleteSession'>` 的理由：避免内核契约
 * `void` 签名与宿主扩展 `string[]` 签名做方法交集导致返回类型坍缩。
 */
export type HostSessionStore = Omit<ISessionStore, 'deleteSession'> & {
  deleteSession: (sessionId: string) => string[];
  truncateFrom: (date: string, session: string, roundId: string) => RoundTruncateResult;
  listSessionMetas: () => SessionMeta[];
  getSessionMeta: (sessionId: string) => SessionMeta | undefined;
  archiveSession: (sessionId: string) => boolean;
  unarchiveSession: (sessionId: string) => boolean;
  isArchived: (sessionId: string) => boolean;
  listArchivedIds: () => string[];
  /** 启动初始会话（导航指针优先，见 `getInitialSessionId`）：SESSION-RESUME-1 */
  getInitialSessionId: () => string;
  /** 记录上次停留会话：切会话 / 新建 / 分叉三条路径的单一写点 */
  setLastActiveSession: (sessionId: string) => void;
};
