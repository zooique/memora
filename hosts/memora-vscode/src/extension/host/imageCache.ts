/**
 * 图片字节缓存 —— `ImageResolver` 的宿主实现 + 会话加载期预读（IMG-2 §5.4 / §5.4.1）
 *
 * ## 为什么需要它
 * 内核 `formatMessages` 手里只有 `ImageRef`（sha256 / mime / 宽高 / 字节数 / 文件名），
 * **没有字节**；而模型要的是 `data:{mime};base64,...`。`ImageResolver` 是内核定下的
 * **同步**端口（异步化会把时序往下游整条扩散），所以宿主必须在序列化**之前**把字节
 * 准备好——这件事放到「会话加载期」：那里本来就是同步语义，且每次切会话/重开面板必过。
 *
 * ## 四条判据（方案 §5.4.1，逐条对应代码）
 * 1. **只预读窗口内的**：窗口 = 内核 `LOOP_CONSTANTS.RETAIN_IMAGE_ROUNDS`，与
 *    `messageHistory.loadRoundBasedMessages` 的图片衰减**同源同值**（窗口外的图内核
 *    本就不会序列化，预读它们纯占内存）；
 * 2. **封顶**：条目 ≤ 32、总字节 ≤ 128 MiB，LRU 淘汰（D25）；无上限 = 内存随历史线性涨；
 * 3. **预读失败不阻断**：文件被删 / 损坏 / 超长 ⇒ 跳过该条，序列化期走 D7 二级降级占位；
 * 4. **不改内核契约**：`ImageResolver` 仍是同步纯查表，内核不知道「预读」存在。
 *
 * ## 为什么零 vscode 依赖
 * 只用 `node:*` + 纯函数 ⇒ 可在 vitest 里用真实临时目录完整机测（命中/未命中/三值不符/
 * 缺文件/淘汰），无需 mock 宿主 API。与 `imageIngest.ts` 同一范式。
 */
import { readFileSync } from 'node:fs';
import {
  LOOP_CONSTANTS,
  type ImageRef,
  type ImageResolver,
  type ISessionViewLoader,
  type Round,
} from '@zooique/memora';
import { resolveAttachmentFilePath } from './projectDataDir.js';

/**
 * 单条缓存内容：**只存原始字节**，不常驻 base64。
 *
 * 常驻 base64 会让内存多付 33%，而 `data:` URL 只在 `formatMessages` 逐次生成——
 * 同一张图一轮内被序列化几次，就拼几次（低频、可接受），换来常驻内存省三分之一。
 */
interface CachedImage {
  /** 原图字节（已按 D20 校验过长度，与 ref.bytes 一致） */
  bytes: Buffer;
  /** MIME（与 ref.mime 同源，命中时再做一次三值比对） */
  mime: string;
}

/** 缓存容量上限（D25 定案值；仅供测试注入更小的上限，生产不要传） */
export interface ImageCacheLimits {
  /** 条目数上限（超出按 LRU 淘汰最久未用） */
  maxEntries: number;
  /** 总字节上限（同上） */
  maxTotalBytes: number;
}

/** 生产上限：32 条 / 128 MiB（D25；32 × 5 MiB 单图上限 ≈ 160 MiB，故字节闸通常先于条目闸触发） */
const DEFAULT_LIMITS: ImageCacheLimits = {
  maxEntries: 32,
  maxTotalBytes: 128 * 1024 * 1024,
};

/**
 * 图片字节缓存（LRU）+ 同步 `ImageResolver`。
 *
 * 生命周期 = 扩展激活期单例（extension.ts 创建），跨会话复用：切回来时缓存通常已热，
 * 同一张图在多个会话里共享一份字节。会话切换只**追加**预读，不做清理——清理交给 LRU。
 */
export class ImageCache {
  /**
   * 缓存表：`Map` 的插入序即 **LRU 序**（队首 = 最久未用，队尾 = 最近使用）。
   * 命中/写入都把键搬到队尾，淘汰时从队首取。
   */
  private readonly entries = new Map<string, CachedImage>();
  /** 当前缓存字节总数（逐条增减维护，避免淘汰时反复遍历求和） */
  private totalBytes = 0;

  constructor(private readonly limits: ImageCacheLimits = DEFAULT_LIMITS) {}

  /**
   * 内核 `ImageResolver` 端口实现 —— **同步纯查表**（零 IO、零异步）。
   *
   * D20 三值交叉校验：`sha256` 是缓存键，`mime` 与 `bytes` 必须与落盘时一致；
   * 任一不符视为未命中（宁可降级占位，不可把错图发给模型）。
   * 未命中返回 `null`，由内核给最短兜底文案（`[图片不可用 <sha 前 8 位>]`）。
   *
   * 命中时刷新 LRU 位次（把键搬到队尾）：这是 LRU 语义的内部记账，不改变本函数的
   * 「无外部 IO / 同步」契约。
   */
  readonly resolver: ImageResolver = (ref) => {
    const hit = this.entries.get(ref.sha256);
    if (!hit) return null;
    // 三值交叉校验：mime 不符（同 sha 换了格式）或字节数不符（文件被截断/替换）都不认
    if (hit.mime !== ref.mime || hit.bytes.length !== ref.bytes) return null;
    this.touch(ref.sha256);
    return { url: `data:${hit.mime};base64,${hit.bytes.toString('base64')}` };
  };

  /**
   * 预读一个附件：读盘 → D20 校验 → 入缓存。**任何失败都静默跳过**（判据 3）。
   *
   * @param ref 附件引用（sha256 为键；mime 决定文件扩展名；bytes 为长度校验基准）
   * @param projectPath 项目/工作区根（目录推导归 `projectDataDir.ts` 单点）
   */
  preload(ref: ImageRef, projectPath: string): void {
    // 已在缓存：刷新位次即可。不重读盘——同一 sha 的字节内容按定义只有一份，
    // 若历史 ref 的 mime/bytes 与缓存不符，`resolver` 的三值校验会在消费侧拦下
    if (this.entries.has(ref.sha256)) {
      this.touch(ref.sha256);
      return;
    }
    const file = resolveAttachmentFilePath(projectPath, ref.sha256, ref.mime);
    // 不支持的 mime（旧数据/未知类型）：没有对应文件可读，跳过
    if (!file) return;
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch {
      // 文件被删 / 无权限：预读失败不阻断会话加载，序列化期走可见占位（D7 二级）
      return;
    }
    // D20 读盘侧校验：键 = sha256（文件名）、mime = 扩展名（映射已保证）、bytes = 实际长度。
    // 长度不符 = 文件被截断/替换，宁可不缓存（让模型看到占位）也不发坏图
    if (bytes.length !== ref.bytes) return;
    this.put(ref.sha256, { bytes, mime: ref.mime });
  }

  /**
   * 会话加载期预读：只取**最近窗口内**轮次的 user 附件，逐条 `preload`。
   *
   * 只在「会话被打开/切回」时调用（chatPanel.replayHistory），**不得**挂到每步投影的
   * 热路径（那里每个 step 都会读一次历史，读盘会变成对话期的同步抖动源）。
   *
   * @param loader 会话视图加载器（只依赖 `loadView`，测试可给最小替身）；
   *   未注入（legacy 模式无 viewLoader）时直接跳过
   * @param projectPath 项目/工作区根
   * @param sessionId 目标会话
   */
  preloadSession(
    loader: Pick<ISessionViewLoader, 'loadView'> | undefined,
    projectPath: string,
    sessionId: string,
  ): void {
    if (!loader) return;
    let rounds: Round[];
    try {
      rounds = loader.loadView(sessionId).rounds;
    } catch {
      // 会话不存在（新建空会话 / 刚被删）：不是错误，静默跳过，不产生任何用户可见噪音
      return;
    }
    // 窗口切片：与内核图片衰减同源（判据 1）。窗口外的轮次内核不会带图，预读无意义
    const start = Math.max(0, rounds.length - LOOP_CONSTANTS.RETAIN_IMAGE_ROUNDS);
    for (let i = start; i < rounds.length; i++) {
      for (const ref of rounds[i].userMessage.attachments ?? []) {
        this.preload(ref, projectPath);
      }
    }
  }

  /** 把键搬到队尾（= 最近使用） */
  private touch(sha256: string): void {
    const hit = this.entries.get(sha256);
    if (!hit) return;
    this.entries.delete(sha256);
    this.entries.set(sha256, hit);
  }

  /** 写入缓存并累计字节数，随后按上限淘汰（D25） */
  private put(sha256: string, image: CachedImage): void {
    this.entries.set(sha256, image);
    this.totalBytes += image.bytes.length;
    // 淘汰：队首是最久未用。条目上限与字节上限任一超出即继续淘汰——
    // 循环而非 if：一个超大条目可能一次性把总量顶穿（虽 5 MiB 单图上限下不会发生）
    while (
      this.entries.size > this.limits.maxEntries ||
      this.totalBytes > this.limits.maxTotalBytes
    ) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }

  /** 移除一条并扣减字节数 */
  private remove(sha256: string): void {
    const hit = this.entries.get(sha256);
    if (!hit) return;
    this.entries.delete(sha256);
    this.totalBytes -= hit.bytes.length;
  }
}
