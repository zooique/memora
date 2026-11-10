/**
 * 会话级钉住清单的宿主侧映射（协议载荷 ⇄ 会话元数据 ⇄ 切会话回种）
 *
 * 为什么外置：chatPanel 行数已贴死 eslint max-lines 上限，而「写进元数据 / 从元数据回种」
 * 是一段自足的双向映射，放这里与 chatPanel 的装配职责分离（同 `skillAggregation` 的外置理由）。
 *
 * 本模块**不持有状态、不读正文**：
 * - 写侧只把协议载荷里的指针映射成 {@link SessionPinnedItem}（绝不把文件/技能正文写进元数据）；
 * - 读侧只把元数据映射回 `ChatRef` 投影，失效判定由调用方注入（真实文件系统 / 技能清单）。
 * 正文真源不在本模块：文件正文按路径现读、技能正文按名现解析（都在内核/宿主既有链路）。
 *
 * @module pinnedContext
 */

import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import type { ChatRef, ExtensionToWebviewMessage } from '../../shared/protocol.js';
import type { SessionMeta, SessionPinnedItem } from '@zooique/memora';
import { resolveUnderPrimaryRoot } from './refPath.js';

/**
 * 把一次输入/钉住上报的载荷映射成会话元数据里的钉住清单
 *
 * @param refs 当前引用 chip 全量（含未钉住的；本函数只挑 `pinned === true`）
 * @param skillName 技能单槽当前选择（技能保持单槽，不改成清单）
 * @param skillPinned 技能是否钉住（缺省 = 未钉住 ⇒ 发完即清）
 * @returns 只含指针的钉住清单（空数组 = 用户清空了钉住，写入后即为新真源）
 */
export function toPinnedItems(
  refs: ChatRef[] | undefined,
  skillName?: string,
  skillPinned?: boolean,
): SessionPinnedItem[] {
  // 引用条目：只留钉住的，且只搬指针三件套（path / kind / range?）
  const items: SessionPinnedItem[] = [];
  for (const ref of refs ?? []) {
    if (ref.pinned !== true) continue;
    items.push({
      kind: ref.kind,
      path: ref.path,
      ...(ref.range ? { range: { start: ref.range.start, end: ref.range.end } } : {}),
    });
  }
  // 技能条目：单槽语义 ⇒ 至多一条；未钉住 / 未选中都不落盘
  if (skillName && skillPinned === true) items.push({ kind: 'skill', name: skillName });
  return items;
}

/**
 * 钉住清单形状校验（落盘面 = 系统边界，fail-closed）
 *
 * 为什么必须校验：元数据文件可被手改 / 被外部工具写坏，条目形状一旦不对，
 * `existsSync(item.path)` 会因非字符串参数抛 TypeError ⇒ `replaySession` 整体失败
 * （连会话都不显示）。故读侧先过一道形状闸：坏条目**跳过并计数**（调用方据此给可见提示），
 * 好条目照常回种。
 *
 * 严进宽出口径：
 * - `file` / `folder`：`path` 必须是非空字符串；`range` 形状不对**只丢 range**（保留条目按
 *   整文件注入）——`path` 才是条目身份，按错行注入比整文件更危险；
 * - `skill`：`name` 必须是非空字符串，且只认第一条（单槽语义，多出来的算坏条目）；
 * - 非对象 / `kind` 未知 / 缺必填字段 ⇒ 计入 `invalid`。
 *
 * @param raw 元数据里的原始值（类型上声明为数组，运行时可能是任意形状）
 * @returns 可安全使用的条目 + 被跳过的坏条目数
 */
function parsePinnedItems(raw: unknown): { items: SessionPinnedItem[]; invalid: number } {
  const items: SessionPinnedItem[] = [];
  let invalid = 0;
  let skillTaken = false;
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (entry === null || typeof entry !== 'object') {
      invalid++;
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (e.kind === 'skill') {
      if (skillTaken || typeof e.name !== 'string' || e.name.length === 0) {
        invalid++;
        continue;
      }
      skillTaken = true;
      items.push({ kind: 'skill', name: e.name });
      continue;
    }
    if (e.kind !== 'file' && e.kind !== 'folder') {
      invalid++;
      continue;
    }
    if (typeof e.path !== 'string' || e.path.length === 0) {
      invalid++;
      continue;
    }
    const r = e.range as Record<string, unknown> | undefined;
    const rangeOk =
      typeof r === 'object' &&
      r !== null &&
      typeof r.start === 'number' &&
      typeof r.end === 'number' &&
      Number.isFinite(r.start) &&
      Number.isFinite(r.end);
    items.push({
      kind: e.kind,
      path: e.path,
      ...(rangeOk ? { range: { start: r!.start as number, end: r!.end as number } } : {}),
    });
  }
  return { items, invalid };
}

/**
 * 从钉住清单里取技能槽名（没有则 undefined）
 *
 * 形状校验在此收口：损坏的 name（非字符串 / 空 / 重复槽）一律视为无钉住技能，
 * 不让脏值经 `skills_loaded.pinnedSkillName` 漏到 webview。
 *
 * @param items 会话元数据里的钉住清单
 * @returns 钉住的技能名（供 `skills_loaded.pinnedSkillName` 单向回种）
 */
export function pinnedSkillNameOf(items: SessionPinnedItem[]): string | undefined {
  return parsePinnedItems(items).items.find((item) => item.kind === 'skill')?.name;
}

/**
 * 从会话元数据取钉住技能名（无会话 / 无钉住 ⇒ undefined）
 *
 * 读点收口于此：避免每个调用方各自拼 `pinnedItems ?? []`（第二份判据）。
 *
 * @param store 会话存储（只需 getSessionMeta 一个能力）
 * @param sessionId 当前会话（空串 = 无会话）
 */
export function pinnedNameOfStore(
  store: { getSessionMeta(sessionId: string): SessionMeta | undefined },
  sessionId: string | undefined,
): string | undefined {
  if (!sessionId) return undefined;
  return pinnedSkillNameOf(store.getSessionMeta(sessionId)?.pinnedItems ?? []);
}

/**
 * 把钉住清单里的引用条目映射成回种用的 `ChatRef` 投影（含失效标记）
 *
 * @param items 会话元数据里的钉住清单（技能条目会被忽略，由 `skills_loaded` 负责回种）
 * @param exists 指针是否仍存在（调用方注入：真实文件系统判定，便于测试替换）
 * @returns `pinned: true` 的引用；已失效的带 `missing: true`（**不静默过滤**）
 */
export async function seedPinnedRefs(
  items: SessionPinnedItem[],
  exists: (path: string) => Promise<boolean>,
): Promise<ChatRef[]> {
  const refs: ChatRef[] = [];
  // 形状闸在此再收口一次（本函数是公开入口，调用方可能直接喂元数据原值）
  for (const item of parsePinnedItems(items).items) {
    if (item.kind === 'skill') continue;
    // 失效判定在宿主（webview 无文件系统）；失效 = 灰显「已失效」，不是不显示
    const missing = !(await exists(item.path));
    refs.push({
      kind: item.kind,
      path: item.path,
      ...(item.range ? { range: item.range } : {}),
      pinned: true,
      ...(missing ? { missing: true } : {}),
    });
  }
  return refs;
}

/**
 * 钉住清单落盘（chatPanel 的唯一写点，`kind='pin'` 与 send 草稿补落共用）
 *
 * 落盘位置 = **会话元数据**（不是轮记录：轮 append-only 且可被多会话引用，
 * 钉住是「本会话的显示态」）。草稿态无会话 id ⇒ 静默忽略（首条 send 会补落）。
 *
 * @param store 会话存储（只需 updateSessionMeta 一个能力）
 * @param sessionId 当前会话（草稿态 / 无会话为 undefined ⇒ 不写）
 * @param msg 上行载荷（引用全量 + 技能单槽 + 钉住标记）
 */
export function writePinnedItems(
  store: { updateSessionMeta(sessionId: string, meta: Partial<SessionMeta>): void },
  sessionId: string | undefined,
  msg: { refs?: ChatRef[]; skillName?: string; skillPinned?: boolean },
): void {
  if (!sessionId) return;
  store.updateSessionMeta(sessionId, {
    pinnedItems: toPinnedItems(msg.refs, msg.skillName, msg.skillPinned),
  });
}

/**
 * 切会话回种：按元数据把钉住**引用**单向投影回 composer（技能走 `skills_loaded.pinnedSkillName`）
 *
 * 失效判定在本模块（宿主才有文件系统）：路径越界 / 不存在 ⇒ `missing:true`（webview 灰显
 * 「已失效」），**不静默过滤**——静默消失会让用户以为「自己没锁」。
 *
 * @param store 会话存储（只需 getSessionMeta 一个能力）
 * @param sessionId 当前会话
 * @param post 下行通道（`addRef` 回种 + 坏条目提示 `notice`）
 */
export async function pushPinnedRefsTo(
  store: { getSessionMeta(sessionId: string): SessionMeta | undefined },
  sessionId: string | undefined,
  post: (msg: ExtensionToWebviewMessage) => void,
): Promise<void> {
  if (!sessionId) return;
  // 基准 = 首个工作区根，不是漏判、也无需遍历 workspaceFolders：
  // 元数据里的相对路径**只可能由首根产出** —— 两条 chip 产出面（命令 `addToChat.ts` 的
  // 右键「添加到对话」、`chatPanel.openMentionQuickPick` 的 @ 选择）都在生成侧用
  // `relativeUnderPrimaryRoot` fail-closed 拒挂第二根 / 根外目标，@ 列表期更是连项都不列。
  // 因此第二根路径进不了 `pinnedItems`；此处若按「逐根尝试」改判，反而是在生成侧契约之外
  // 造第二份根归属判据（与 refPath 的「首根唯一基准」冲突）。
  const rootFsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const { items, invalid } = parsePinnedItems(store.getSessionMeta(sessionId)?.pinnedItems);
  const refs = await seedPinnedRefs(items, async (relPath) => {
    // 首根基准 + 规范形复核：非规范形 / 越界路径一律按失效处理（不打开任意文件）
    const abs = resolveUnderPrimaryRoot(rootFsPath, relPath);
    return abs ? existsSync(abs) : false;
  });
  if (refs.length > 0) post({ type: 'addRef', refs });
  // 坏条目**跳过但必须可见**：不静默吞掉——否则用户只会看到「锁的东西少了几条」却无解释
  if (invalid > 0) {
    post({
      type: 'notice',
      level: 'error',
      message: vscode.l10n.t(
        'This session has {0} corrupted pinned item(s) (metadata was changed externally); they were skipped — pin them again to restore the list',
        invalid,
      ),
    });
  }
}
