/**
 * emptyStateView — 空状态呈现域（自 chatView 单闭包外置）
 *
 * 职责 = 空状态的显隐开关、角色化标题/提示、示例提问 chips、未配置模型 onboarding 引导。
 * 零自有状态：全部读注入节点；角色态（name / packs）由调用方传参，不持第二份镜像
 * （currentRoleName / currentRolePacks 真源仍在 chatView 的协议消息处理器）。
 * chips 点击委托仍在 chatView（读 dataset.prompt 填输入框，属输入域不属空态域）。
 */
import * as l10n from '@vscode/l10n';
import type { WebviewToExtensionMessage } from '../../shared/protocol.js';

/** 空状态示例提问项（点击填入输入框） */
interface Suggestion {
  /** 填入输入框的完整提问 */
  prompt: string;
  /** chip 展示文案 */
  label: string;
}

/**
 * 空状态示例提问集（SSOT）
 *
 * ROLE_SUGGESTION_SETS 按角色显示名特化示例提问：命中展示专属示例，未命中回退通用。
 * showcase 角色（白话方案设计师）展示"种子收敛"引导——让用户一键体验 memora 最吸引人的
 * 「给模糊想法 → 引导收敛最小单元」设计魅力；其余角色保持通用打磨引导，
 * 避免为每条角色特化造成维护成本（新增 showcase 角色时在此追加映射即可）。
 *
 * 文案在**调用时**经 `l10n.t` 取（不用模块级常量）：模块加载早于语言包就绪，
 * 顶层求值会把默认语言永久写死。
 */
function defaultSuggestions(): Suggestion[] {
  return [
    {
      prompt: l10n.t('Review the architectural soundness of the current document'),
      label: l10n.t('Review architecture'),
    },
    { prompt: l10n.t('Trim redundant wording in the document'), label: l10n.t('Trim wording') },
    {
      prompt: l10n.t('Check whether the documentation matches the implementation'),
      label: l10n.t('Align implementation'),
    },
  ];
}

/**
 * showcase 角色显示名（角色包 manifest 的**身份串**，非 UI 文案，不得翻译）
 *
 * 它既是对映射表的键、也是与 `packs[].displayName` 比较的值；翻译即命中失效。
 * Unicode 转义只消源码 CJK，运行期字符串与 manifest 完全一致。
 */
const SHOWCASE_ROLE_NAME = '\u767d\u8bdd\u65b9\u6848\u8bbe\u8ba1\u5e08';

/** 角色特化示例提问（工厂同 defaultSuggestions：调用时取译文） */
const ROLE_SUGGESTION_SETS: Record<string, () => Suggestion[]> = {
  [SHOWCASE_ROLE_NAME]: () => [
    {
      prompt: l10n.t('I want to build a personal knowledge base; help me design a plan'),
      label: l10n.t('Design a knowledge base'),
    },
    {
      prompt: l10n.t('I want to build a memory system; help me find the minimal unit'),
      label: l10n.t('Design a memory system'),
    },
    {
      prompt: l10n.t('I want to build a to-do tool; help me find the minimal feature set'),
      label: l10n.t('Find the minimal unit'),
    },
  ],
};

/** 空态域反向依赖（chatView 构造时注入，节点均为其 getElementById 单次取值） */
export interface EmptyStateViewDeps {
  /** webview document（DOM 构造） */
  document: Document;
  /** 空状态容器（显隐开关 + onboarding 按钮挂载） */
  emptyState: HTMLElement;
  /** 空状态标题（角色化文案写入点） */
  emptyTitle: HTMLElement;
  /** 空状态提示（角色描述 / onboarding 文案写入点） */
  emptyHint: HTMLElement;
  /** 示例提问 chips 容器 */
  emptySuggestions: HTMLElement;
  /** 消息滚动区（空态判据：有无 .msg 消息） */
  messages: HTMLElement;
  /** 消息投递单点（onboarding 按钮 post open_settings_tab） */
  postMessage: (msg: WebviewToExtensionMessage) => void;
}

/**
 * 空状态呈现域工厂
 *
 * @param deps 注入的节点与投递面（chatView 持有真源引用，本域只读不建状态）
 */
export function createEmptyStateView(deps: EmptyStateViewDeps): {
  /** 空状态开关（消息区有 .msg 则隐藏空态） */
  update(): void;
  /** 角色化空态：标题/提示随激活角色生长，chips 随 showcase 角色特化 */
  updateRole(name: string, packs: { displayName: string; description?: string }[]): void;
  /** LLM 未配置时的 onboarding 引导（一键跳配置页） */
  onboarding(): void;
  /** onboarding 按钮移除（配置就绪恢复普通空态，幂等） */
  clearOnboardBtn(): void;
} {
  const { document, emptyState, emptyTitle, emptyHint, emptySuggestions, messages } = deps;

  /** 空状态开关：消息区无 .msg 时显示空状态提示，有消息则隐藏 */
  function update(): void {
    emptyState.hidden = messages.querySelector('.msg') !== null;
  }

  /**
   * P3（空状态角色化）：空状态标题/提示随激活角色包动态生成
   *
   * 原空状态文案硬编码「开始打磨你的设计文档」（doc-review 定位），切换角色包后错位。
   * 改为标题用角色显示名、提示用角色定位描述（manifest.description，可选），随角色生长。
   */
  function updateRole(name: string, packs: { displayName: string; description?: string }[]): void {
    emptyTitle.textContent = l10n.t('Chat with {0}', name || 'AI');
    // 角色定位描述优先；无描述时回退默认引导文案（textContent 赋值防注入）
    const activePack = packs.find((p) => p.displayName === name);
    emptyHint.textContent =
      activePack?.description ||
      l10n.t('Type your idea below, or click a sample prompt to get started');
    // 示例提问随 showcase 角色特化（白话方案设计师展示"种子收敛"引导，其余回退通用）
    renderSuggestions(name || 'AI');
  }

  /**
   * LLM 未配置时的空态 onboarding
   *
   * 无 Provider 时切换空状态为「去配置模型」引导（首次使用关键路径）；配置就绪后调用方
   * 走 updateRole + clearOnboardBtn 恢复普通引导（幂等，按钮 querySelector 复用）。
   * 文案一律 textContent 赋值防注入；按钮事件创建处绑定（随空态 DOM 常驻，无需委托）。
   */
  function onboarding(): void {
    emptyTitle.textContent = l10n.t('No LLM configured yet');
    emptyHint.textContent = l10n.t(
      'Configure an LLM to start chatting (OpenAI-compatible APIs supported)',
    );
    emptySuggestions.textContent = '';
    // 防重复追加（配置后回普通空态再触发时幂等）
    let btn = emptyState.querySelector<HTMLButtonElement>('.empty-onboard-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'empty-onboard-btn';
      btn.textContent = l10n.t('Configure a model');
      btn.addEventListener('click', () => {
        deps.postMessage({ type: 'open_settings_tab', tab: 'config' });
      });
      emptyState.appendChild(btn);
    }
  }

  /** onboarding 按钮移除（onboarding 的逆操作，域内闭环——配置就绪时调用） */
  function clearOnboardBtn(): void {
    emptyState.querySelector('.empty-onboard-btn')?.remove();
  }

  /**
   * 空状态示例提问 Chips：随激活角色动态渲染（SSOT，事件委托兼容动态元素）。
   *
   * 命中 ROLE_SUGGESTION_SETS 的角色展示专属示例（showcase，如白话方案设计师的"种子收敛"
   * 引导）；未命中回退 defaultSuggestions() 通用打磨引导（避免为每条角色特化造成维护成本）。
   * textContent 赋值防注入。
   */
  function renderSuggestions(name: string): void {
    if (!emptySuggestions) return;
    const factory = ROLE_SUGGESTION_SETS[name];
    const set = factory ? factory() : defaultSuggestions();
    emptySuggestions.textContent = '';
    set.forEach((s) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'suggestion-chip';
      chip.dataset.prompt = s.prompt;
      chip.textContent = s.label;
      emptySuggestions.appendChild(chip);
    });
  }

  return { update, updateRole, onboarding, clearOnboardBtn };
}
