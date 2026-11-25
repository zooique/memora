/**
 * 内置工具候选选择器 — 给 `disableTools` 文本框配一个「点选填入」面板（纯构造，无面板状态）
 *
 * 为什么外置：`rolesView.ts` 贴 max-lines 1000 红线，本段是独立自足的 DOM 构造，
 * 与卡片列表/弹窗状态零共享。（同 roleCardActions.ts 的外置理由。）
 *
 * 设计要点（SSOT / 不带伤）：
 *   - **展示名零第二真源**：复用 `getToolDisplayName`（工具展示名唯一真源，值为 l10n 键），
 *     调用侧过本地化器；不在此另造名字映射，也不从内部名猜中文。
 *   - **选中态唯一真源 = 文本框的值**：checkbox 只是文本框的便捷编辑器，每次渲染从
 *     input.value 反推选中集，点选后回写 input.value；不另存 Set，杜绝两处状态漂移。
 *   - **开放集不封死**：本面板只列内核内置工具（宿主/MCP/包内工具不在内），手输通道照旧——
 *     面板声明里明说"清单外工具仍可手输"，不造成"表外关不掉"的 fail-open 误导。
 *
 * 消费方：`rolesView.ts` 的 `disableTools` text 行；宿主无需改协议（数据源 = roles_loaded
 * 已下发的 builtinToolFaces）。
 */
import * as l10n from '@vscode/l10n';
import { getToolDisplayName } from './toolNameMap.js';

/** 工具面候选（rolesView 的 BuiltinToolFaceItem 结构子集） */
export interface ToolFaceCandidate {
  readonly name: string;
  readonly group: string;
}

/** 分组标题的本地化（rolesView 注入；值为 l10n 键，与 disableGroups.optionLabels 同源） */
export type GroupLabeler = (group: string) => string;

/** 把逗号串工具名归一为集合（去空/去空白，兼容中英文逗号） */
function parseNames(raw: string): Set<string> {
  return new Set(
    raw
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter((s) => s !== ''),
  );
}

/**
 * 追加一个「内置工具候选」面板到目标行，并把复选框与文本框双向绑定。
 *
 * @param document DOM 文档（由 rolesView 注入，便于测试）
 * @param row text 行的容器（面板插在输入框之后）
 * @param input disableTools 的文本框（选中态唯一真源）
 * @param tools 内核透传的内置工具面清单
 * @param groupLabel 分组标题本地化器（rolesView 传 `l10n.t` + disableGroups.optionLabels 映射）
 */
export function appendToolPicker(
  document: Document,
  row: HTMLElement,
  input: HTMLInputElement,
  tools: readonly ToolFaceCandidate[],
  groupLabel: GroupLabeler,
): void {
  if (tools.length === 0) return;

  const box = document.createElement('div');
  box.className = 'role-detail-tool-picker';
  const hint = document.createElement('div');
  hint.className = 'team-modal-hint';
  hint.textContent = l10n.t('Built-in tools (click to add; type names outside this list too)');
  box.appendChild(hint);

  // 按 group 稳定分组（保留清单原有顺序，不引入字典序排序——顺序是内核真源的呈现）
  const byGroup = new Map<string, ToolFaceCandidate[]>();
  for (const tool of tools) {
    const list = byGroup.get(tool.group) ?? [];
    list.push(tool);
    byGroup.set(tool.group, list);
  }

  for (const [group, members] of byGroup) {
    const section = document.createElement('div');
    section.className = 'role-detail-tool-group';
    const title = document.createElement('div');
    title.className = 'role-detail-tool-group-title';
    title.textContent = groupLabel(group);
    section.appendChild(title);
    for (const tool of members) {
      const label = document.createElement('label');
      label.className = 'role-detail-check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = tool.name;
      // 初值：从 input.value 反推（唯一真源），不另存选中集
      cb.checked = parseNames(input.value).has(tool.name);
      const txt = document.createElement('span');
      // 展示名复用唯一真源（返回 l10n 键），本地化后附内部名——用户既看得懂又知道填什么
      txt.textContent = `${l10n.t(getToolDisplayName(tool.name))} (${tool.name})`;
      cb.addEventListener('change', () => {
        const selected = parseNames(input.value);
        if (cb.checked) selected.add(tool.name);
        else selected.delete(tool.name);
        // 回写唯一真源；顺序按内核清单稳定（不按点击顺序，避免同一份配置呈现漂移）
        input.value = tools
          .filter((t) => selected.has(t.name))
          .map((t) => t.name)
          .join(', ');
      });
      // 外部手输改变文本框时同步勾选态（保持"文本框是唯一真源"）
      input.addEventListener('input', () => {
        cb.checked = parseNames(input.value).has(tool.name);
      });
      label.appendChild(cb);
      label.appendChild(txt);
      section.appendChild(label);
    }
    box.appendChild(section);
  }
  row.appendChild(box);
}
