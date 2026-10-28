/**
 * 附件预览 URL 派生 —— 历史/即时两个消费面的**唯一实现**
 *
 * ## 为什么单独成文件
 * 同一份事实（本轮附件）有两条投递通道：运行时回声（`user` 消息）与 rounds 投影
 * （`RoundView.attachmentUris`）。若两处各写一遍「取路径 → asWebviewUri → 建表」，
 * 迟早漂移成两套键规则。此处收口为纯函数，宿主只注入两个依赖（项目根 / `toUri`）。
 *
 * ## 三条判据
 * 1. **不编造地址**：`resolveAttachmentFilePath` 返回 undefined（mime 不在支持集、
 *    历史脏数据）或 `toUri` 返回 undefined（视图已销毁）⇒ 该条不进表，而不是塞空串；
 * 2. **空结果即 undefined**（不是空对象）：调用方用条件展开挂字段，无图历史/纯文字轮
 *    的载荷形状与升级前**逐字一致**（与 `attachments` 可选字段同一取向）；
 * 3. **零 vscode 依赖**：`toUri` 由 chatPanel 注入（`asWebviewUri` 只有宿主拿得到），
 *    本模块可用真临时目录在 vitest 里完整机测，无需宿主替身。
 */
import type { ImageRef } from '@zooique/memora';
import type { ExtensionToWebviewMessage, RoundView } from '../../shared/protocol.js';
import { resolveAttachmentFilePath } from './projectDataDir.js';

/** `user` 回声消息（形状由协议 Extract 收窄，本模块不复述字段） */
type UserEcho = Extract<ExtensionToWebviewMessage, { type: 'user' }>;

/** 落盘绝对路径 → webview 可加载 URL（宿主注入；视图未解析/已销毁时返回 undefined） */
export type ToWebviewUri = (file: string) => string | undefined;

/**
 * `user` 回声消息的附件载荷
 *
 * 两个字段都缺省 = 本条无图（形状与升级前一致）。刻意不返回空对象/空数组，
 * 让「无图」在 wire 上真的不存在，而不是靠消费方判空。
 */
export interface AttachmentPayload {
  attachments?: readonly ImageRef[];
  attachmentUris?: Record<string, string>;
}

/**
 * 附件数组 → `sha256` → webview URL 的映射
 *
 * 键取 sha256 而非下标：附件次序不是契约，sha 是落盘文件名 / 字节缓存键 / 去重键
 * 共用的同一把钥匙（同一张图挂两次也只有一条）。
 *
 * @param refs 附件引用（可为空/缺省；此时返回 undefined）
 * @param projectPath 项目/工作区根（目录推导归 `projectDataDir.ts` 单点）
 * @param toUri 宿主注入的 URL 构造器（视图未解析时返回 undefined ⇒ 该条跳过）
 * @returns 非空映射，或 undefined（无附件 / 全部取不到地址）
 */
export function attachmentUrisOf(
  refs: readonly ImageRef[] | undefined,
  projectPath: string,
  toUri: ToWebviewUri,
): Record<string, string> | undefined {
  if (!refs || refs.length === 0) return undefined;
  let table: Record<string, string> | undefined;
  for (const ref of refs) {
    // 同一 sha 重复出现（用户连粘两次 / 历史多轮复用一张图）：一次解析足够
    if (table && table[ref.sha256] !== undefined) continue;
    const file = resolveAttachmentFilePath(projectPath, ref.sha256, ref.mime);
    if (!file) continue;
    const uri = toUri(file);
    if (!uri) continue;
    table ??= {};
    table[ref.sha256] = uri;
  }
  return table;
}

/**
 * `user` 回声消息的附件载荷（`sendInput` 上屏处调用）
 *
 * 与 {@link attachmentUrisOf} 是同一实现的两种包装：本函数只决定**字段挂不挂**，
 * 不产生第二套键规则。
 */
export function attachmentPayload(
  refs: readonly ImageRef[] | undefined,
  projectPath: string,
  toUri: ToWebviewUri,
): AttachmentPayload {
  if (!refs || refs.length === 0) return {};
  const uris = attachmentUrisOf(refs, projectPath, toUri);
  return uris ? { attachments: refs, attachmentUris: uris } : { attachments: refs };
}

/**
 * 组装运行时回声消息（`sendInput` 上屏的唯一出口）
 *
 * 为什么整条消息都由本模块产出、而不是在面板里拼字段：附件两字段必须**同批派生**，
 * 若调用方自己拼，很容易只带 `attachments` 忘了 URL 表（表现 = 刚发出的图没有缩略图，
 * 且刷新后才正常，属于不报错的半修）。
 *
 * @param text 用户原始输入（裸输入，不含注入信封——上屏与落盘刻意不同形）
 * @param ts 上屏时刻（与 live 轮 seed 的时间戳同源）
 */
export function userEcho(
  text: string,
  ts: string,
  refs: readonly ImageRef[] | undefined,
  projectPath: string,
  toUri: ToWebviewUri,
): UserEcho {
  return { type: 'user', text, ts, ...attachmentPayload(refs, projectPath, toUri) };
}

/**
 * 给整批 rounds 盖上 `attachmentUris`（`postTurnUpdate` 投影处调用）
 *
 * 必须作用在 **`mergeLiveRound` 之后**：live 轮的 `userMessage` 来自 webview 上行 seed
 * （只有 ref，没有 URL），若只在历史分支盖，刚发完的消息重绘一次就会掉图。
 *
 * 不可变：返回新对象（只换 `attachmentUris`），入参数组与其元素**原样不动**——
 * 投影产物可能被多条路径持有，就地改写属隐性副作用。无图的轮不产生该字段。
 *
 * @param rounds 合并后的轮次投影（顺序不变）
 * @returns 同长度新数组；未变更的轮沿用原引用（零拷贝）
 */
export function stampRoundAttachmentUris(
  rounds: readonly RoundView[],
  projectPath: string,
  toUri: ToWebviewUri,
): RoundView[] {
  return rounds.map((round) => {
    const uris = attachmentUrisOf(round.userMessage.attachments, projectPath, toUri);
    return uris ? { ...round, attachmentUris: uris } : round;
  });
}
