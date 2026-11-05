/**
 * 工作区会话存储 — ISessionStore 实现（JSON 文件落盘）
 *
 * 存储模型（round-based 单一模式，SSOT）：
 *   - 会话仅持有 Round ID 列表（roundIdsStore）；消息内容只存在于 RoundStore（物理真相源）
 *   - 消息读写经 roundIds → RoundStore 展开 / 成 Round 写入，绝无 legacy 扁平消息列表
 *   - 与设计文档 §3.2 对齐：SessionMeta 不含 storageMode 之类的模式标识字段
 *   - `archivedIds`（宿主扩展字段）：会话列表的**分组标签**，见 `archivedIdsSet` 声明处语义边界
 *
 * 职责：
 *   - 将 memora 对话 Round ID 列表持久化到工作区 `.memora/sessions.json`
 *   - 实现 ISessionStore 接口，注入 Agent，让跨会话对话记录可回溯（traceSummary 依赖）
 *   - 承载「留存区」分组标签（`archivedIdsSet`）——纯展示态，会话记录可分两组显示
 *   - 承载「上次停留的会话」导航指针（`lastActiveSessionId`）——**启动判据输入**，
 *     与 updatedAt（写入最近）是两个不同事实，见字段声明处语义边界
 *   - 原子写入：save() 使用 atomicWriteFileSync 防崩溃损坏
 */
import { existsSync, readFileSync } from 'node:fs';
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
  /** 问答闭环物理存储（IRoundStore 实现，文件落盘） */
  private readonly roundStore: IRoundStore;
  /** 会话文件绝对路径 */
  private readonly filePath: string;

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
   * 可退出路径：本字段是可丢弃的纯数据（删掉整个字段 + 三个读写点即回到无留存区形态），
   * 且不影响既有会话的任何现有语义（此处未改任何既有判据，只新增能力面）。
   */
  private archivedIdsSet = new Set<string>();

  /**
   * 「上次停留的会话」导航指针（宿主扩展字段，**是判据输入，不是纯展示态**）
   *
   * 与 `archivedIdsSet` 的语义分界（别照抄上面那句「不参与任何数据判据」）：本字段被
   * `getInitialSessionId` 消费，直接决定插件启动时打开哪个会话 ⇒ 它是判据本身。
   *
   * 为什么不能复用 `SessionMeta.updatedAt`：那个字段的真源是 `updateRoundBasedMessageCount`，
   * 只在「有一轮落盘」时刷新。「切到某会话翻历史但没发消息」在磁盘上零痕迹 ⇒ 启动时按
   * updatedAt 取 [0] 必然回到「最近写过消息的会话」，而不是「你最后看的会话」。
   * 两个事实（写入最近 / 停留最近）必须两个字段，合并即语义腐化。
   *
   * 可丢弃性（退役路径）：删掉本字段 + 三个读点（load / getInitialSessionId / setLastActiveSession）
   * 即回到旧行为（启动取 updatedAt [0]），不丢任何会话数据。
   */
  private lastActiveSessionId = '';

  /**
   * @param workspacePath 工作区路径（落盘目录 `.memora`）
   * @param roundStore 问答闭环存储；缺省时在同工作区新建文件级 WorkspaceRoundStore 并 load()
   */
  constructor(workspacePath: string, roundStore?: IRoundStore) {
    // 落盘目录经单点推导（唯一计算点 = projectDataDir.ts，禁就地拼字面量）
    this.filePath = join(resolveProjectDataDir(workspacePath), 'sessions.json');
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
   * 从文件加载会话（文件不存在则空）
   *
   * 存储模型：仅 metas（标题元数据）+ roundIdsStore（Round 指针）。
   * 无检查点持久化，本文件不涉及 checkpoint。
   */
  load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const data = JSON.parse(raw) as {
        metas: Record<string, SessionMeta>;
        roundIdsStore: Record<string, string[]>;
        archivedIds?: string[];
        lastActiveSessionId?: string;
      };
      for (const [k, v] of Object.entries(data.metas ?? {})) this.metas.set(k, v);
      // 加载 round-based 模式的 Round ID 列表（唯一内容来源）
      for (const [k, v] of Object.entries(data.roundIdsStore ?? {})) this.roundIdsStore.set(k, v);
      // 留存区标记：旧档无该字段 → 缺省空集（向后兼容，不做迁移分发）
      this.archivedIdsSet = new Set(data.archivedIds ?? []);
      // 导航指针：旧档无该字段 → 空串 ⇒ 启动走「最近写入」兜底（与加字段前行为一致，无迁移）
      this.lastActiveSessionId = data.lastActiveSessionId ?? '';
    } catch (err) {
      // 会话文件损坏时降级为空（不阻塞插件启动）
      console.warn('Memora 会话文件读取失败，降级为空', err);
      this.metas.clear();
      this.roundIdsStore.clear();
      this.archivedIdsSet.clear();
      this.lastActiveSessionId = '';
    }
  }

  /** 将内存原子写回文件（先写 .tmp 再 rename，防崩溃损坏） */
  private save(): void {
    const data = {
      metas: Object.fromEntries(this.metas),
      roundIdsStore: Object.fromEntries(this.roundIdsStore),
      archivedIds: [...this.archivedIdsSet],
      lastActiveSessionId: this.lastActiveSessionId,
    };
    atomicWriteFileSync(this.filePath, JSON.stringify(data, null, 2));
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
    this.save();

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
    this.save();
    return true;
  }

  /**
   * 把会话移回归属列表（留存区标记的逆操作，同样只动视图层）
   *
   * @returns 是否移回成功（false = 本就不在留存区）
   */
  unarchiveSession(sessionId: string): boolean {
    if (!this.archivedIdsSet.delete(sessionId)) return false;
    this.save();
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
    this.save();

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
    this.save();
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
    this.save();
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
    this.save();
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
    this.save();
  }

  /**
   * 创建新会话元数据（round-based 模式）
   *
   * @param meta - 会话元数据
   */
  createSession(meta: SessionMeta): void {
    // SSOT：SessionMeta 为纯展示 DTO（无 roundIds），设置轮次请走 setRoundIds 真源
    this.metas.set(meta.sessionId, { ...meta });
    this.save();
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

  // ─── 导航指针（宿主扩展能力，非 ISessionStore 契约） ───

  /**
   * 启动初始会话 = **唯一判据点**（chatPanel 构造时消费）
   *
   * 优先级：上次停留的会话 → 不可用则退回「最近写入」的会话（updatedAt 降序 [0]）→ 再无则空串
   * （空串的语义 = 从未有过会话，由宿主 `ensureInitialSession` 建首个会话）。
   *
   * 为何必须做存在性校验：内核 `switchToSession` 对**不存在的会话不报错**（加载消息返空、
   * 循环工作记忆清空）⇒ 陈旧指针的后果是「静默切到一个空会话」，用户看到空屏却零报错，
   * 比抛错更难排查。故指针必须能在本地解析出实体（有 meta 或有 roundIds）才采信。
   *
   * 为何不记住空会话：新建后未发消息的会话在 sessions.json 里既无 meta 也无 roundIds
   * ⇒ 重启后无法与「已被删除的会话」区分。不赌，统一退回最近写入的会话；
   * 用户丢的只是一个还没写东西的空壳，而赌输的代价是空屏（不带伤优先）。
   */
  getInitialSessionId(): string {
    const persisted = this.lastActiveSessionId;
    if (persisted && (this.metas.has(persisted) || this.roundIdsStore.has(persisted))) {
      return persisted;
    }
    return this.listSessionMetas()[0]?.sessionId ?? '';
  }

  /**
   * 记录「用户正停在这个会话」——宿主在切会话 / 新建 / 分叉三条路径上调用
   *
   * 幂等：同值不落盘。切会话在 UI 上可能被重复触发（含 `switchToSession` 的提前返回路径），
   * 每次整文件重写毫无收益，且会放大写入失败面。
   *
   * 同步落盘（非异步排队）：这是「关掉插件前排最后发生的事」，异步写会在进程退出瞬间丢。
   */
  setLastActiveSession(sessionId: string): void {
    if (!sessionId || this.lastActiveSessionId === sessionId) return;
    this.lastActiveSessionId = sessionId;
    this.save();
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
