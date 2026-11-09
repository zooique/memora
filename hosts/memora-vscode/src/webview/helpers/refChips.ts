/**
 * 引用 chip 构建（附件行成员）——从 chatView.ts 外置的自足渲染单元
 *
 * 为什么外置：chatView.ts 物理行数已贴死 eslint max-lines 上限（只降不升），而「一条引用
 * 渲染成什么 DOM、点哪儿干什么」本来就是一段自足逻辑。本模块**只产 DOM、不持状态**：
 * `currentRefs` 仍是 chatView 的唯一真源（SSOT），交互一律经回调回流（与 `skillPickerView`
 * 把技能域外置同构，不造第二份引用状态）。
 *
 * 钉住语义（🔒）：
 * - 🔒 只切「发送后是否保留」，✕ 才是移除；两者语义二分，互不替代。
 * - 钉住的排最前（「锁定在顶部」），稳定排序保同组内插入序；排序只影响渲染，不改真源本体。
 * - 失效（`missing`，宿主下发投影）= 灰色「已失效」+ 不可静默消失：条目仍在、仍可 ✕ 移除。
 *
 * @module refChips
 */

import * as l10n from '@vscode/l10n';
import type { ChatRef } from '../../shared/protocol.js';
import { formatRefRange, normalizeRefRange } from '../../shared/refKey.js';
import { getIconSvg } from '../scripts/icons.js';

/** 引用 chip 的交互出口（状态归调用方，本模块不写 `currentRefs`） */
export interface RefChipHandlers {
  /** 点击路径/行号：在编辑器打开并定位（载荷只带协议字段 path/kind/range） */
  onOpen(ref: ChatRef): void;
  /** 切换会话级钉住（🔒）：只切「发送后是否保留」 */
  onTogglePin(ref: ChatRef): void;
  /** 移除单条（✕）：按身份键过滤（同文件不同选区是两条） */
  onRemove(ref: ChatRef): void;
  /** 清空全部引用（含钉住的） */
  onClearAll(): void;
}

/**
 * 引用 chip 的**可见**文件名（HOST-CTX-17：全路径降噪）
 *
 * 真机反馈「气泡显示完整相对路径噪音太多」——可见文本只留文件名（`a/b/foo.ts` → `foo.ts`）。
 * 这不是把路径信息删掉，完整路径仍在三处：① chip title（hover 即见，同名文件可辨）；
 * ② pin/remove 的 aria-label（屏幕阅读器要全量信息）；③ open_ref 上行载荷与发送信封
 * （功能面，本就不随显示形态改）。
 * 已知限制：同一批引用里两个同名文件（如两个 `index.ts`）可见标签相同，靠 title 区分——
 * 刻意不做 VS Code 式「父目录消歧」：附件行通常个位数 chip，hover 成本低于维护歧义判据。
 *
 * 路径形态 = `relativeUnderPrimaryRoot` 的规范形（POSIX `/`、无冗余段）⇒ 按 `/` 切末段即可；
 * webview 包不引 node:path，一个 split 不造依赖。
 *
 * @param path 规范化的相对路径
 * @returns 末段文件名（路径异常为空时回退原串）
 */
export function refDisplayName(path: string): string {
  const segs = path.split('/');
  return segs[segs.length - 1] || path;
}

/**
 * 把引用 chip（及批量清空出口）追加到附件行
 *
 * 调用方负责行内其它成员（活动文件 / 注入 / 引用回复胶囊）的先后顺序；本函数只接在它们之后。
 *
 * @param row 附件行容器（已清空、非隐藏）
 * @param refs 当前引用全量（唯一真源在调用方）
 * @param handlers 交互出口
 */
export function appendRefChips(
  row: HTMLElement,
  refs: readonly ChatRef[],
  handlers: RefChipHandlers,
): void {
  // 钉住的排最前（「锁定在顶部」）：稳定排序保同组内插入序；只影响渲染顺序，不改真源本体
  const ordered = [...refs].sort((a, b) => Number(b.pinned) - Number(a.pinned));
  for (const ref of ordered) {
    // 身份键取自协议字段（去重判据 SSOT 在 shared/refKey，本模块不重算）
    const chip = document.createElement('span');
    chip.className = 'skill-chip';
    // .is-pinned 只是 chip 级状态标记与测试锚点，视觉在 pin 按钮上
    if (ref.pinned) {
      chip.classList.add('is-pinned');
    }
    const icon = document.createElement('span');
    icon.className = 'skill-chip__icon';
    icon.innerHTML = getIconSvg(ref.kind === 'folder' ? 'folder' : 'file', 11, 11);
    icon.setAttribute('aria-hidden', 'true');
    chip.appendChild(icon);
    // 区间先归一再渲染：非法区间（start>end / 非整数）不渲染行号 span、不上行，
    // 视觉与协议两处同时降级为「整文件引用」，不产生 `#Lundefined` 这类脏标签。
    const markedRange = normalizeRefRange(ref.range);
    // aria-label 用**全路径**+行号（屏幕阅读器要全量信息）；可见文本用文件名——两个受众两种形态
    const label = `${ref.path}${formatRefRange(markedRange)}`;
    // 点击跳转（open_ref，W→E）：路径与行号两个 span 都可点。载荷只带协议字段，
    // webview 私有的钉住态不随上行；行号保持 1-based 原样上行，逆转换归宿主单点。
    const openRef = (): void => {
      handlers.onOpen({
        path: ref.path,
        kind: ref.kind,
        ...(markedRange ? { range: markedRange } : {}),
      });
    };
    const name = document.createElement('span');
    name.className = 'skill-chip__name';
    name.textContent = refDisplayName(ref.path);
    // 定位提示是**成句提示**而非协议标签，故不复用 formatRefRange（两者语言不同、不可共享）；
    // 但端点同样取归一化结果，避免出现「第 NaN 行」。
    const rangeHint = markedRange
      ? l10n.t(
          ' and locates line {0}',
          `${markedRange.start}${markedRange.start === markedRange.end ? '' : `-${markedRange.end}`}`,
        )
      : '';
    // CTX-6①：指针语义提示放最前（用户 hover 的第一问是「这挂的是啥、占不占」）——引用只挂
    // 指针不注入内容，目录更是只给模型一张目录地图（内容按需 list_dir）。与信封侧
    // buildRefContextBlock 的「按需读取」标注同义：信封说给模型听，这里说给用户听。
    // HOST-CTX-17：全路径附在末尾括号——可见文本降噪后，同名文件的区分靠 hover 这一眼。
    name.title = ref.missing
      ? l10n.t(
          'This reference is no longer valid (the file no longer exists); it can still be removed. Original path: {0}',
          ref.path,
        )
      : l10n.t(
          'Pointer only; the model reads the content on demand (no budget cost). Click to open in the editor{0} ({1})',
          rangeHint,
          ref.path,
        );
    // 键盘可达：span 非原生按钮，补 role/tabindex/Enter-Space 与鼠标同构
    name.setAttribute('role', 'button');
    name.tabIndex = 0;
    name.addEventListener('click', openRef);
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openRef();
      }
    });
    chip.appendChild(name);
    if (markedRange) {
      // 行号独立 span：语义与可点性与路径对等，但**不继承 name 的 ellipsis 截断**
      const rng = document.createElement('span');
      rng.className = 'skill-chip__range';
      rng.textContent = formatRefRange(markedRange);
      rng.title = name.title;
      rng.setAttribute('role', 'button');
      rng.tabIndex = 0;
      rng.addEventListener('click', openRef);
      rng.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openRef();
        }
      });
      chip.appendChild(rng);
    }
    // 失效灰显：宿主判定的失效投影（webview 无文件系统）。**不静默丢弃**——
    // 静默消失会让用户以为自己没锁，故条目仍在、灰显标注、仍可移除。
    if (ref.missing) {
      chip.classList.add('is-missing');
      const missingNote = document.createElement('span');
      missingNote.className = 'skill-chip__note';
      missingNote.textContent = l10n.t('Invalid (file no longer exists)');
      chip.appendChild(missingNote);
    }
    // 常驻锁切换（🔒）：与 ✕ 语义二分——🔒 只切「发送后是否保留」，✕ 才是移除。
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'skill-chip__pin';
    // 与 skill chip 同一组二态规则：class + 图标形状都由 pinned 投影
    if (ref.pinned) {
      pin.classList.add('is-on');
    }
    pin.innerHTML = getIconSvg(ref.pinned ? 'lock' : 'lock-open', 11, 11);
    pin.setAttribute('aria-pressed', String(ref.pinned));
    pin.setAttribute(
      'title',
      // 与 skill chip 复用同一组钉住键（同一「发送后是否保留」语义，不另造近似措辞）
      ref.pinned ? l10n.t('Unpin (cleared after sending)') : l10n.t('Pinned (kept after sending)'),
    );
    pin.setAttribute(
      'aria-label',
      ref.pinned ? l10n.t('Unpin: {0}', label) : l10n.t('Pin: {0}', label),
    );
    pin.addEventListener('click', () => handlers.onTogglePin(ref));
    chip.appendChild(pin);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'skill-chip__remove';
    remove.innerHTML = getIconSvg('close', 11, 11);
    remove.setAttribute('title', l10n.t('Remove reference: {0}', label));
    remove.setAttribute('aria-label', l10n.t('Remove reference: {0}', label));
    remove.addEventListener('click', () => handlers.onRemove(ref));
    chip.appendChild(remove);
    row.appendChild(chip);
  }
  // CTX-7：批量出口「清空全部引用」——同一 chip 行缺同类批量出口（挂 6 条要逐个点 ✕ 六次）。
  // 范式照抄 pending-queue-bar__clear，但**不走上行消息**：引用 SSOT = 调用方的 currentRefs，
  // 单删 ✕ 同为纯本地过滤——批量移除只是同一过滤的全量版，上行反而让宿主镜像一份引用状态
  // （第二真理源）。显隐与范式一致：有引用即在（单条也无害）。
  // 范围只清引用：活动文件 chip / 注入 chip 是另一语义（各有自己的 ✕），不牵连。
  if (refs.length > 0) {
    const clearAll = document.createElement('button');
    clearAll.type = 'button';
    clearAll.className = 'ref-chips__clear';
    clearAll.innerHTML = getIconSvg('close', 11, 11);
    clearAll.setAttribute('title', l10n.t('Clear all references (including pinned)'));
    clearAll.setAttribute('aria-label', l10n.t('Clear all references'));
    clearAll.addEventListener('click', () => handlers.onClearAll());
    row.appendChild(clearAll);
  }
}
