/**
 * 文件改动清单「悬浮独立窗口」形态守卫（FILE-CHANGES-FLOAT-1 · 2026-11-21 真机反馈）
 *
 * 真机伤：改文件后对话区常驻条点开清单，原形态 `.file-changes-bar__list` 是
 * `flex:1 0 100%` 的流内子项——展开即增大 bar 流高 → #messages(flex:1) 被挤压 →
 * 对话记录跳动，且清单向下展开盖不住会话区。用户拍板「向上展开 + 悬浮在会话记录
 * 上方、不顶动对话」，参照历史弹窗的绝对定位浮层范式。
 *
 * 判据（源码级因果链，jsdom 无布局引擎，几何真值只能靠规则链断言）：
 *   ① bar 是浮层定位锚（position:relative），且不再是 flex-wrap 流内铺开容器；
 *   ② list 脱离流（position:absolute）+ 向上弹出（bottom:calc(100% + …)）+ 无流内间距；
 *   ③ bar 显式 z-index:z-menu 从根上下文压过消息区——层叠真因：bar 带
 *      animation-fill-mode:both 的 transform 动画，自成层叠上下文会困住浮层 z-index，
 *      不抬 bar 则对话文字反而盖在浮层上（前两轮误诊为透明、换 token 无效的根因）；
 *   ④ list 用浮层四件套（z-menu 层级 + translateZ 独立合成层 + 不透明底 + toast 阴影）；
 *      ⚠️ 背景不透明只是保险，不是根因——根因是③的层级，勿再本末倒置；
 *   ⑤ 尺寸：left:0 + right:0 与确认栏严格等宽 + max-height 视口兜底；
 *   ⑥ 交互链路逐字不动（三 postMessage type + 三写契约 + __list 类名）；
 *   ⑦ 单文件确认/回退按钮：每行一个、带 path 分流，打开链路逐字不动。
 *   ⑧ 单文件按钮文案走宿主多语言：源码 t() 调用 + 两份 bundle 键面/译文对齐
 *      （2026-11-21 真机唯一瑕疵：行内「Revert」漏译文，中文界面回落英文源键）。
 *
 * 变异靶标：删 bar 的 z-index（层级真因）/ list 的 position 改 static / 删 bottom /
 * 恢复 flex:1 0 100% / 背景退回 surface-card / 删 right:0 / 删单文件回退按钮 ⇒ 对应用例红；
 * 恢复后全绿、字节一致。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const STYLES = readFileSync(join(HERE, '..', 'styles', 'chatStyles.ts'), 'utf8');
const STATUS_BARS = readFileSync(join(HERE, '..', 'scripts', 'statusBarsView.ts'), 'utf8');
const HOST_ROOT = join(HERE, '..', '..', '..');
const L10N_KEYS = [
  'Confirm',
  'Revert',
  'Confirm this file change (clears this notice only; file is not modified)',
  'Revert this file to before the agent ran (irreversible; asks for confirmation)',
] as const;
const readBundle = (name: string): Record<string, string> =>
  JSON.parse(readFileSync(join(HOST_ROOT, 'l10n', name), 'utf8')) as Record<string, string>;

/** 取选择器规则块（样式为平铺模板字符串，块内无嵌套花括号） */
function blockFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = STYLES.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  expect(m, `missing CSS block: ${selector}`).not.toBeNull();
  return m![1]!;
}

describe('文件改动清单悬浮浮层形态守卫（FILE-CHANGES-FLOAT-1）', () => {
  it('① bar 是浮层锚：position:relative，且移除流内 flex-wrap 铺开', () => {
    const bar = blockFor('.file-changes-bar');
    expect(bar).toMatch(/position:\s*relative/);
    expect(bar).not.toMatch(/flex-wrap/);
  });

  it('③ 层级真因：bar 显式 z-index:z-menu 从根上下文压过消息区（否则浮层 z-index 被困）', () => {
    // 真机第三次反馈坐实：不是透明度，是层叠上下文。bar 的 dockPanelOpen 动画
    // （fill-mode:both + to 帧 transform:translateX(0)）让 bar 自成层叠上下文，
    // 浮层的 z-index:100 出不去；bar 自身无 z-index(≈0) < #messages(z-base:1) ⇒ 对话盖住浮层。
    const bar = blockFor('.file-changes-bar');
    expect(bar).toMatch(/z-index:\s*var\(--z-menu\)/);
    // 因果链前提必须成立：进场动画确实带 transform + fill-mode both（否则这条判据是空转）
    expect(STYLES).toMatch(/@keyframes\s+dockPanelOpen[\s\S]*?transform:\s*translateX/);
    expect(STYLES).toMatch(/animation:\s*dockPanelOpen[^;]*both/);
  });

  it('② list 脱离流 + 向上弹出：absolute + bottom:calc(100% + …)，无流内 flex/margin/padding-top', () => {
    const list = blockFor('.file-changes-bar__list');
    expect(list).toMatch(/position:\s*absolute/);
    // 向上：锚点底边之上（bottom:calc(100% + 间距)），不是向下 top:100%
    expect(list).toMatch(/bottom:\s*calc\(100%\s*\+/);
    expect(list).not.toMatch(/top:\s*calc\(100%/);
    // 反流内：这三个是旧形态「flex:1 0 100% + margin-top + padding-top」的签名
    expect(list).not.toMatch(/flex:\s*1\s+0\s+100%/);
    expect(list).not.toMatch(/margin-top/);
    expect(list).not.toMatch(/padding-top/);
  });

  it('④ 浮层四件套：z-menu 层级 + translateZ 独立合成层 + 不透明底 + toast 阴影', () => {
    const list = blockFor('.file-changes-bar__list');
    expect(list).toMatch(/z-index:\s*var\(--z-menu\)/);
    expect(list).toMatch(/transform:\s*translateZ\(0\)/);
    // 不透明底是保险（surface-card 引自 editorWidget.background，部分主题带 alpha），
    // 但真机「糊成一片」的根因是③的层级，不是这条——两条都守，勿本末倒置。
    expect(list).toMatch(/background:\s*var\(--surface-page/);
    expect(list).not.toMatch(/background:\s*var\(--surface-card/);
    expect(list).toMatch(/box-shadow:\s*var\(--shadow-toast\)/);
  });

  it('⑤ 与确认栏严格等宽 + 视口兜底（left:0 + right:0，不再用 min-width 撑错位小窗）', () => {
    const list = blockFor('.file-changes-bar__list');
    expect(list).toMatch(/left:\s*0\b/);
    expect(list).toMatch(/right:\s*0\b/);
    // 等宽锚不应再出现旧的偏移下限/上限（它们会撑出与确认栏不等宽的小窗）
    expect(list).not.toMatch(/min-width/);
    expect(list).not.toMatch(/max-width/);
    const maxH = list.match(/max-height:\s*([^;]+)/)?.[1] ?? '';
    expect(maxH).toMatch(/min\(/);
    expect(list).toMatch(/overflow-y:\s*auto/);
  });

  it('⑥ 交互链路逐字不动：三 postMessage type + 三写契约 + __list 类名', () => {
    // 改形态不得顺手改逻辑：三条上行消息、aria-expanded + hidden 三写、清单类名原样
    expect(STATUS_BARS).toContain("type: 'open_changed_file', path: file");
    expect(STATUS_BARS).toContain("type: 'confirm_all_file_changes'");
    expect(STATUS_BARS).toContain("type: 'revert_all_file_changes'");
    expect(STATUS_BARS).toContain('file-changes-bar__list');
    expect(STATUS_BARS).toContain("setAttribute('aria-expanded', String(expanded))");
    expect(STATUS_BARS).toContain('list.hidden = !expanded');
  });

  it('⑦ 单文件确认/回退按钮：每行各一个、带 path 分流，打开链路逐字不动', () => {
    // 2026-11-21 用户诉求「每个文件增加独立确认改动按钮 + 回退按钮」：
    // 清单行 = 容器 + 打开 + 确认 + 回退四兄弟按钮
    expect(STATUS_BARS).toContain("row.className = 'file-changes-bar__row'");
    expect(STATUS_BARS).toContain("confirm.className = 'file-changes-bar__file-confirm'");
    expect(STATUS_BARS).toContain("revert.className = 'file-changes-bar__file-revert'");
    expect(STATUS_BARS).toContain("type: 'confirm_all_file_changes', path: file");
    expect(STATUS_BARS).toContain("type: 'revert_all_file_changes', path: file");
    // 打开链路与头部全量按钮逐字不动（改形态不得顺手改交互）
    expect(STATUS_BARS).toContain("type: 'open_changed_file', path: file");
    // 样式侧：行容器 flex + 两按钮右对齐，文件名可省略（等宽浮层不被长路径撑破）
    const row = blockFor('.file-changes-bar__row');
    expect(row).toMatch(/display:\s*flex/);
    const file = blockFor('.file-changes-bar__file');
    expect(file).toMatch(/min-width:\s*0/);
    const confirm = blockFor('.file-changes-bar__file-confirm,\n  .file-changes-bar__file-revert');
    expect(confirm).toMatch(/flex:\s*0\s+0\s+auto/);
  });

  it('⑧ 单文件按钮文案走宿主多语言：源码 t() + 两份 bundle 键面/译文对齐', () => {
    // 真机瑕疵根因不是 CSS：l10n.t('Revert') 包了但 bundle 无此键 ⇒ zh 回落英文源键。
    // 这里把「按钮文案」这一域的键面钉在本守卫里；全量键面仍由 verify-nls ⑨⑧⑩ 守。
    for (const key of L10N_KEYS) {
      // 源码里有换行写法（长 title），故正则允许 l10n.t( 与字面量之间有空白
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(STATUS_BARS, `源码缺 l10n.t(${key})`).toMatch(
        new RegExp(`l10n\\.t\\(\\s*'${escaped}'`),
      );
    }
    const en = readBundle('bundle.l10n.json');
    const zh = readBundle('bundle.l10n.zh-cn.json');
    for (const key of L10N_KEYS) {
      expect(en, `默认 bundle 缺键 ${key}`).toHaveProperty(key);
      expect(zh[key], `中文 bundle 缺译文 ${key}`).toBeTruthy();
      expect(zh[key]).not.toBe(key); // 照抄英文键 = 守卫绿而用户仍看英文
    }
    expect(zh['Revert']).toBe('回退');
    expect(zh['Confirm']).toBe('确认');
  });
});
