/**
 * 技能选择器域（触发器标签 / 菜单 / 输入盒 chip）渲染与状态
 *
 * 自 `chatView.ts` 外置。域内自持三份状态（`currentSkill` / `skillOptions` /
 * `skillSearchQuery`），view 侧只经窄接口读写——与 `historyMenuView` 同构：
 * 交互状态归 `initDropdowns`（开合 / 外部收起 / Escape / 条目委托），
 * 本域只管「清单与选中态怎么渲染」。
 *
 * 三条约束（chatView 内联时期已定案，随域迁移，不在两处重述）：
 *   ① **菜单只重建列表容器**：搜索框恒驻 `skillPickerMenu` 直下、绝不被清空重建。
 *      曾随全量 `innerHTML=''` 重建被 detach 再插回，聚焦中被摘即失焦 ⇒ 打一个字
 *      第二个字进不去（中文 IME 更明显）。
 *   ② **id 恒为 `name`**：`displayName` 只作展示，选中回传 / 高亮比对 / 发送载荷
 *      一律用 `name`（模型按 name 寻址 `read_skill`，用显示名寻址必失败）。
 *   ③ **禁用标记只作显示**：判据真源在 host（`isSkillDisabled`），本域若自行拦截
 *      会在 reload 后变成假拒绝。
 *
 * @module skillPickerView
 */

import type { SkillDto } from '../../shared/protocol.js';
import { closeOtherDropdowns, setDropdownOpen } from '../components/dropdown.js';
import { bindSingleTrackRow, syncRowEdges } from '../helpers/chipRow.js';
import { getIconSvg } from './icons.js';

/** 当前选中技能 = 整条 DTO 快照 + pinned（禁逐字段拷贝：displayName 随行带到 chip 与标题） */
export type SelectedSkill = SkillDto & { pinned: boolean };

/** 「未选择技能」清除项的 id（菜单首项，与真实技能名不可能冲突） */
const CLEAR_ID = '__clear_skill';

export interface SkillPickerViewDeps {
  /** webview 文档对象（构造唯一 DOM 入口；禁在模块内读全局 document） */
  document: Document;
  /** 选择器根（`.skill-picker`，同时是 `.treedd` 开合容器） */
  root: HTMLElement | null;
  /** 菜单容器（`.treedd__menu`） */
  menu: HTMLElement | null;
  /** 触发器（`.treedd__trigger`） */
  trigger: HTMLElement | null;
  /** 输入盒内 chip 行容器（`#skillChips`） */
  chipRow: HTMLElement | null;
  /** 正文输入框（斜杠触发的宿主：本域只观测它，不改它的其它语义） */
  input: HTMLTextAreaElement | null;
}

/** 技能选择器窄接口：chatView 仅经此驱动 */
export interface SkillPickerView {
  /** 菜单项选中（含 `CLEAR_ID` 清除项） */
  select(id: string): void;
  /** 宿主推送技能清单（`skills_loaded`）→ 全量重建菜单 */
  setSkills(skills: SkillDto[]): void;
  /** 当前选中技能（含 pinned）；无选择返回 null */
  getSelected(): SelectedSkill | null;
  /** 发送后处置：未钉住（`pinned=false`）即清除，钉住常驻 */
  afterSend(): void;
  /** 按当前宽度重算 chip 行边缘渐隐（窗口尺寸变化时由调用方驱动） */
  refreshEdges(): void;
}

export function createSkillPickerView(deps: SkillPickerViewDeps): SkillPickerView {
  const { document, root, menu, trigger, chipRow, input } = deps;

  let currentSkill: SelectedSkill | null = null;
  /** 动态技能清单（SSOT 收紧）：不硬编码预设，由 host 推 `skills_loaded` 填充，与设置面板同一来源。
   * 整条协议 DTO 直通（不另建投影）：`disabled` 供下拉弱化 + 「已禁用」标注（纯显示、不拦截），
   * `displayName` 供人类可读名，`description` 供菜单顶部搜索匹配。 */
  let skillOptions: SkillDto[] = [];
  /** 菜单搜索词：跨 `skills_loaded` 全量重建保留——数据下发不清词（用户常在搜索结果上
   * 连续操作，同会话搜索 FD-3-A 纪律） */
  let skillSearchQuery = '';

  const searchInput = document.createElement('input');
  searchInput.className = 'treedd__search';
  searchInput.type = 'search';
  searchInput.placeholder = '搜索技能（名称/描述）';
  searchInput.setAttribute('aria-label', '搜索技能');
  searchInput.title = '按名称或描述过滤技能列表';
  searchInput.addEventListener('input', () => {
    skillSearchQuery = searchInput.value;
    renderMenu();
  });

  /** 列表容器：唯一重建区（清除项/分隔线/过滤项/空态都在这），搜索框在其外恒驻 */
  const list = document.createElement('div');
  list.className = 'treedd__list';

  /** 更新选择器标签 + 盒内附件行 chip：
   * 入口触发器 ⚡（accent 边框表示已启用）+ 菜单内 is-active 高亮 + title/aria 兜底；
   * 输入盒内文字上方由 renderChip 呈现「名称 + × 可移除」的状态 chip。 */
  function syncLabel(): void {
    if (trigger) {
      if (currentSkill) {
        const label = currentSkill.displayName ?? currentSkill.name; // 显示名回退（无 H1 时露出英文 id）
        trigger.setAttribute('title', '当前 Skill：' + label);
        trigger.setAttribute('aria-label', '当前 Skill：' + label);
      } else {
        trigger.setAttribute('title', '选择 Skill');
        trigger.setAttribute('aria-label', '选择 Skill');
      }
      root?.classList.toggle('active', !!currentSkill);
    }
    if (menu) {
      menu.querySelectorAll<HTMLElement>('.treedd__item').forEach((it) => {
        // 未选择技能时高亮「未选择技能」（CLEAR_ID），选中时高亮对应项
        const on = currentSkill
          ? it.dataset.treeddId === currentSkill.name
          : it.dataset.treeddId === CLEAR_ID;
        it.classList.toggle('is-active', on);
      });
    }
    renderChip();
  }

  /** 在输入盒内、textarea 上方构建/清空「名称 + × 可移除」的技能 chip（附件行成员）。
   * 用 textContent 逐节点构建（技能名来自用户文件 / 角色包，禁 innerHTML 拼接）；
   * × 点击移除 = 清空 currentSkill 并刷新（保持与菜单触发器同源，单一真理源）。 */
  function renderChip(): void {
    if (!chipRow) return;
    chipRow.textContent = '';
    if (!currentSkill) {
      chipRow.hidden = true;
      return;
    }
    chipRow.hidden = false;
    // 闭包内 let 的 narrowing 失效 → 取局部副本供 🔒 处理器读取当前挂载态
    const skill = currentSkill;
    const label = skill.displayName ?? skill.name; // 显示名回退：chip 文本 / 锁与移除按钮 aria 共用
    const chip = document.createElement('span');
    chip.className = 'skill-chip';
    // 钉住（常驻锁）= 发送后保留不消失。chip 级 .is-pinned **无视觉职责**，仅作状态标记
    // 与测试锚点——视觉交给 pin 按钮的 is-on + 图标形状（chip 底色会被 .is-disabled 吃掉）
    if (skill.pinned) {
      chip.classList.add('is-pinned');
    }
    // 选中的技能已禁用 → 标记 chip。否则用户以为「已挂载」，实际发送时不注入。
    // 术语沿用设置页同一词汇「已禁用」，不新增概念。
    if (skill.disabled) {
      chip.classList.add('is-disabled');
      chip.setAttribute('title', '该技能已禁用，发送时不会注入');
    }
    const icon = document.createElement('span');
    icon.className = 'skill-chip__icon';
    // 图标语言唯一 = icons.ts 柔和线条 SVG
    icon.innerHTML = getIconSvg('bolt', 11, 11);
    icon.setAttribute('aria-hidden', 'true');
    chip.appendChild(icon);
    const name = document.createElement('span');
    name.className = 'skill-chip__name';
    name.textContent = label;
    chip.appendChild(name);
    if (skill.disabled) {
      const note = document.createElement('span');
      note.className = 'skill-chip__note';
      note.textContent = '已禁用';
      chip.appendChild(note);
    }
    // 常驻锁切换（🔒）：与 ✕ 语义二分——🔒 只切「发送后是否保留」，✕ 才是移除。
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'skill-chip__pin';
    // 二态落在 pin 按钮自身（class + 图标形状），**不依赖 chip 底色**——chip 底色会被
    // .is-disabled 覆盖吃掉（禁用技能钉住后视觉归零），按钮自己的着色不受其影响。
    if (skill.pinned) {
      pin.classList.add('is-on');
    }
    // 图标 = 状态投影（SSOT）：闭合锁 = 已钉住常驻，开口锁 = 未钉住发送后清除。
    // 曾写死为常量 'lock' ⇒ 两态同图标、用户无法分辨钉住与否（真机实测缺陷）。
    pin.innerHTML = getIconSvg(skill.pinned ? 'lock' : 'lock-open', 11, 11);
    pin.setAttribute('aria-pressed', String(skill.pinned));
    pin.setAttribute('title', skill.pinned ? '取消常驻（发送后清除）' : '常驻（发送后保留）');
    pin.setAttribute('aria-label', (skill.pinned ? '取消常驻：' : '常驻：') + label);
    pin.addEventListener('click', () => {
      currentSkill = { ...skill, pinned: !skill.pinned };
      renderChip();
    });
    chip.appendChild(pin);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'skill-chip__remove';
    remove.innerHTML = getIconSvg('close', 11, 11);
    remove.setAttribute('title', '移除 Skill');
    remove.setAttribute('aria-label', '移除 Skill：' + label);
    remove.addEventListener('click', () => {
      currentSkill = null;
      syncLabel();
    });
    chip.appendChild(remove);
    chipRow.appendChild(chip);
    // 重建后 scrollLeft 归零、内容宽度也变了：边缘渐隐必须按新尺寸重算
    syncRowEdges(chipRow);
  }

  /** 菜单匹配（空词恒真、大小写不敏感）：**name（id）/ 显示名 / 描述**任一命中即匹配。
   *
   * id 必须留在匹配面：展示层已全面改显 `displayName`，只记得英文 id（技能文件 frontmatter、
   * `memora.disabledSkills`、read_skill 日志里都只有 id）的用户否则搜不到自己那条技能；更根本的是
   * 「有 H1 按中文匹、无 H1 按 id 匹」= 同一列表两套判据，随数据形态漂移。
   * （形状同历史菜单的元数据匹配，见 historyMenuView；列表仅数十条，同步过滤不引入防抖） */
  function matchesSearch(s: SkillDto, q: string): boolean {
    if (!q) return true;
    const haystack = `${s.name} ${s.displayName ?? ''} ${s.description ?? ''}`;
    return haystack.toLowerCase().includes(q);
  }

  /** 重建 Skill 菜单（初始装配 + skills_loaded 刷新 + 搜索过滤共用单点）：
   * 顶部常驻搜索框（恒驻，出重建区）→ 列表容器内：恒显「未选择技能」清除项 + 分隔线
   * （逃逸舱，不参与过滤）→ 过滤后的技能项（禁用标记随行、不因过滤隐藏）→ 空态「无匹配技能」。
   * 🔴 只清 list 容器，绝不清 menu —— 内含恒驻的搜索框，
   * 全量清空会把它 detach 致失焦（真机「打一个字就进不去」根因）。 */
  function renderMenu(): void {
    if (!menu) return;
    // 首次装配：搜索框 + 列表容器入菜单，此后永不再动（重建只清列表容器）
    if (searchInput.parentElement !== menu) {
      menu.appendChild(searchInput);
      menu.appendChild(list);
    }
    list.innerHTML = '';
    searchInput.value = skillSearchQuery;
    const clearItem = document.createElement('button');
    clearItem.type = 'button';
    clearItem.className = 'treedd__item';
    clearItem.setAttribute('role', 'menuitem');
    // 顶部项语义 = 「普通对话、不挂载技能」——用中性「未选择技能」替代原「不使用 Skill」：
    // 原文字易被误读为「禁用技能」（禁用另属设置页禁用清单），且暗示「提及技能名即自动
    // 命中」（当前机制是显式选择，见 title 提示）。
    clearItem.textContent = '未选择技能';
    clearItem.title =
      '未挂载任何技能，进行普通对话（技能需从下方显式选择；提示词提及技能名不会自动加载）';
    clearItem.dataset.treeddId = CLEAR_ID;
    list.appendChild(clearItem);
    const divider = document.createElement('div');
    divider.className = 'treedd__divider';
    list.appendChild(divider);
    const q = skillSearchQuery.trim().toLowerCase();
    let visible = 0;
    for (const s of skillOptions) {
      if (!matchesSearch(s, q)) continue;
      visible++;
      // 菜单项必须是 `button`：`.treedd__item` 的键盘导航（`bindMenuKeyboardNav`）靠
      // `items[i].focus()` 移焦；`div` 不可聚焦（tabIndex=-1，focus() 后 activeElement 仍是
      // body）⇒ 方向键与 Enter 全失效。声明式渲染器（`buildDropdownHtml`）本就产出 button，
      // 两条渲染路径在此对齐，不再「一套对一套错」。
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'treedd__item';
      item.setAttribute('role', 'menuitem');
      item.textContent = s.displayName ?? s.name;
      item.dataset.treeddId = s.name; // id 恒为 name：显示名只作展示，选中回传 / 高亮比对都用 name
      if (s.disabled) {
        // 已禁用：弱化 + 后缀徽记（复用设置面板同一语义词汇，非隐蔽、不隐藏条目）
        item.classList.add('is-disabled');
        const note = document.createElement('span');
        note.className = 'treedd__item-note';
        note.textContent = '已禁用';
        item.appendChild(note);
      }
      list.appendChild(item);
    }
    // 空态：有技能但无命中才显示（不带 .treedd__item = 不参与选择委托）
    if (skillOptions.length > 0 && visible === 0) {
      const empty = document.createElement('div');
      empty.className = 'treedd__empty';
      empty.textContent = '无匹配技能';
      list.appendChild(empty);
    }
    syncLabel();
  }

  /**
   * SKILL-SLASH-1：斜杠触发点（输入框里 `/` 的落点；`null` = 当前不在斜杠态）
   *
   * 判据是**文本事实**而非按键事实（同 HOST-CTX-13 的 @ 结论）：中文输入法或粘贴进来的 `/`
   * 未必产生 keydown，故只在 input 事件里判定；keydown 只负责 Escape 退出。
   *
   * **焦点刻意留在输入框**：若打开菜单后 `searchInput.focus()`，用户刚打的字就进不了正文，
   * 而斜杠态的语义是「边写正文边挑技能」。代价是搜索框只作镜像：它显示 token 的实时过滤词，
   * 键盘焦点仍在正文。选中路径因此保持点击（Enter 归发送，不抢）。
   */
  let slashTriggerOffset: number | null = null;

  /** 斜杠 token 的合法起点：行首 或 前一字符是空白。
   * `A/B`、`1/2`、`2026/11/01`、URL 里的 `/` 一律不触发——这是本特性的硬边界。 */
  function isSlashTokenStart(value: string, at: number): boolean {
    if (at === 0) return true;
    return /\s/.test(value[at - 1] ?? '');
  }

  /** 撤掉斜杠 token（选中技能后调用）：只删「`/` 到当前光标」这一段。
   * 斜杠态下该区间必然是连续非空白字符（输入分支遇空白即退出），故不会吃掉后面的正文。
   * 落点已变（用户删过 `/`）时原样不动——与 `removeMentionAt` 同一条纪律：只认落点。 */
  function consumeSlashToken(): void {
    const at = slashTriggerOffset;
    slashTriggerOffset = null; // 一次性：撤完即清，防后续选择误删同一位置
    if (!input || at === null || at < 0 || at >= input.value.length) return;
    if (input.value[at] !== '/') return; // 落点已变（用户编辑过）：不猜
    const caret = input.selectionStart;
    const end = Math.max(at + 1, caret); // 至少吃掉 `/` 本身
    input.value = input.value.slice(0, at) + input.value.slice(end);
    input.focus();
    input.setSelectionRange(at, at);
    // 复用**既有** input 监听重算高度 / 按钮语义 / 发送可用态——不在这里复制那三连调用
    //（复制即漂移）。程序化 Event 没有 inputType，故 @ 与斜杠两条 inputType 分支都不会误触发。
    input.dispatchEvent(new Event('input'));
  }

  if (input) {
    input.addEventListener('keydown', (e) => {
      // 斜杠态 Esc 收起菜单并退出——`/` 与已打的字**留在正文**
      //（与 @ 的「取消无扰动」同一条纪律：取消不该擦掉用户已输入的内容）。
      if (e.isComposing) return;
      if (e.key === 'Escape' && slashTriggerOffset !== null) {
        slashTriggerOffset = null;
        // 斜杠 token 不算「用户主动搜索」：退出即清词，否则下次点开菜单会带着上次的过滤结果
        skillSearchQuery = '';
        renderMenu();
        if (root) setDropdownOpen(root, false);
      }
    });

    input.addEventListener('input', (e) => {
      const ie = e as InputEvent;
      // 只认 insert 家族：删除同样触发 input，若光标恰停在 `/` 后会把「删到 / 前面」误判成
      // 「插入 /」（同 HOST-CTX-13 的 inputType 判据）。
      if (typeof ie.inputType !== 'string' || !ie.inputType.startsWith('insert')) return;
      const caret = input.selectionStart;
      if (
        caret > 0 &&
        input.value[caret - 1] === '/' &&
        isSlashTokenStart(input.value, caret - 1)
      ) {
        slashTriggerOffset = caret - 1;
        skillSearchQuery = '';
        renderMenu();
        // 互斥规则与触发器点击共用同一函数（不在这里再写一遍 .treedd.is-open 选择器）
        if (root) {
          closeOtherDropdowns(document, root);
          setDropdownOpen(root, true);
        }
        return;
      }
      if (slashTriggerOffset === null) return;
      const start = slashTriggerOffset;
      const token = input.value.slice(start + 1, caret);
      // 三个退出条件：`/` 已不在原位 / 光标退回 token 之前 / token 内出现空白（用户开始写正文）
      if (input.value[start] !== '/' || caret <= start || /\s/.test(token)) {
        slashTriggerOffset = null;
        // 退出斜杠态 = 放弃过滤：不清词的话菜单会停在上一次 token 的结果上（用户以为列表缺项）
        skillSearchQuery = '';
        renderMenu();
        // 退出即收起菜单（与 Escape 同纪律）：否则菜单赖在输入框上方，用户继续打字时仍浮着
        // 全部技能项，体感「输入被打断」。选中路径不走这里——点击项由 dropdown 的 click 委托收起。
        if (root) setDropdownOpen(root, false);
      } else if (root?.classList.contains('is-open')) {
        skillSearchQuery = token;
        renderMenu();
      } else {
        // 菜单被外部点击收起 ⇒ 斜杠态一并结束（否则后续输入会继续喂给已关闭的菜单）
        slashTriggerOffset = null;
      }
    });
  }

  // 行元素在脚本加载时已存在：单轨滚动绑定归本域（chip 行随本域重建）
  bindSingleTrackRow(chipRow);
  // 初始装配：空清单（搜索框 + 清除项 + 分隔线），具体清单由 skills_loaded 动态填充
  renderMenu();

  return {
    select(id: string): void {
      const found = id === CLEAR_ID ? undefined : skillOptions.find((s) => s.name === id);
      if (found) {
        // 随行带出 disabled（选择时刻的快照）——仅供 chip 显示提示，
        // 发送时的**判定**仍由 host 真源（`isSkillDisabled`）负责，webview 不拦截。
        // 新挂载 = 锁预开常驻（pinned 默认 true，与「skill 发送后不消失」的既有行为一致）
        currentSkill = { ...found, pinned: true };
      } else if (id === CLEAR_ID) {
        currentSkill = null;
      } else {
        // 未知 id（清单在选中瞬间已被重推替换）：不动现状，避免静默清空用户选择
        return;
      }
      syncLabel();
      // 选中后用 token 换 chip：`/su` 留在正文里就是一条伪造的用户输入
      consumeSlashToken();
    },
    setSkills(skills: SkillDto[]): void {
      skillOptions = skills;
      renderMenu();
    },
    getSelected(): SelectedSkill | null {
      return currentSkill;
    },
    afterSend(): void {
      // 发送即收场：斜杠 token 已成正文的一部分，斜杠态不得越过本条消息
      //（否则下次输入会按旧落点删字）
      slashTriggerOffset = null;
      // 技能同一 pinned 判据：默认钉住常驻（锁预开）⇒ 发送不清除；syncLabel 内含重绘
      if (currentSkill && !currentSkill.pinned) {
        currentSkill = null;
        syncLabel();
      }
    },
    refreshEdges(): void {
      syncRowEdges(chipRow);
    },
  };
}
