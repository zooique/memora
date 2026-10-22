/**
 * 交互提醒**接线守卫**（HOST-ATTN-1）
 *
 * 为什么需要本文件：提醒的判据与文案已由 `attentionNotice.test.ts` 全覆盖，但「判据正确」
 * 不等于「判据被接上线」。三处接线分别落在：
 *   - `extension.ts`   —— vscode URI handler（import vscode，node 环境不可加载，测不了行为）
 *   - `chatPanel.ts`   —— ask / done 两个触发点（同上，且受 max-lines 闸门约束不宜为测试改造）
 *   - `package.json`   —— `onUri` 激活事件（冷启动承接面）
 * 故用源码文本锚定这三处。红线：**这类守卫只锚「契约串」，不锚实现细节**——前者改了必须
 * 同步改测试（正是意图），后者重构时会误红。
 *
 * 🔴 本文件守的两个实测踩过的坑（2026-10-22）：
 *   ① URI authority 必须是**扩展 ID = `publisher.name`**（官方 registerUriHandler 契约）。
 *      写成短名 `zooique.memora` 会被路由到不存在的扩展 ⇒ 点 toast 静默空转、无任何报错。
 *   ② 缺 `onUri` 激活事件 ⇒ 冷启动（VS Code 未激活）时 URI 到达但 handler 未注册 ⇒ 同样空转。
 */
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ATTENTION_PATH, ATTENTION_URI, ATTENTION_URI_AUTHORITY } from '../attentionNotice.js';

const HOST_ROOT = join(__dirname, '..', '..', '..', '..');
const read = (...segments: string[]) => readFileSync(join(HOST_ROOT, ...segments), 'utf8');

/**
 * 去注释后再断言
 *
 * 守卫要锁的是「**代码里**没有」，而注释里写「原 L2 `showInformationMessage` 已删」是必要
 * 记录（不写就没人知道为什么只剩一条通道）。不剥离注释 ⇒ 守卫把说明文字当违规，实测踩过。
 */
const codeOf = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

const pkg = JSON.parse(read('package.json')) as {
  publisher: string;
  name: string;
  activationEvents?: string[];
  contributes: { views: Record<string, Array<{ id: string }>> };
};

describe('URI 契约：authority 必须是扩展 ID', () => {
  it('ATTENTION_URI = vscode://<publisher>.<name><path>（与 package.json 同源）', () => {
    const expected = `vscode://${pkg.publisher}.${pkg.name}${ATTENTION_PATH}`;
    expect(ATTENTION_URI).toBe(expected);
    // 反面锚：扩展 name 是 memora-vscode，短名 memora 不是合法 ID
    expect(ATTENTION_URI_AUTHORITY).toBe(`${pkg.publisher}.${pkg.name}`);
    expect(ATTENTION_URI_AUTHORITY).not.toBe(`${pkg.publisher}.memora`);
  });

  it('uri 能被标准 URL 解析，authority/path 各就各位', () => {
    const parsed = new URL(ATTENTION_URI);
    expect(parsed.protocol).toBe('vscode:');
    expect(parsed.host).toBe(ATTENTION_URI_AUTHORITY);
    expect(parsed.pathname).toBe(ATTENTION_PATH);
  });
});

describe('冷启动承接面：onUri 激活事件', () => {
  it('package.json 声明 onUri（否则扩展未激活时 handler 不存在）', () => {
    expect(pkg.activationEvents ?? []).toContain('onUri');
  });

  it('views 里有 memora.chat（extension.ts 回跳用的 `<viewId>.focus` 命令来源）', () => {
    const ids = (pkg.contributes.views.memora ?? []).map((v) => v.id);
    expect(ids).toContain('memora.chat');
  });
});

describe('extension.ts：URI handler 接线', () => {
  const src = read('src', 'extension', 'extension.ts');

  it('注册了 registerUriHandler', () => {
    expect(src).toContain('vscode.window.registerUriHandler(');
  });

  it('比对 ATTENTION_PATH（单点），不抄字面量 /attention', () => {
    expect(src).toContain('ATTENTION_PATH');
    // 反面锚：路径字面量不得散落在 extension.ts（改路径只改一处）
    expect(src).not.toMatch(/['"]\/attention['"]/);
  });

  it('回跳优先聚焦对话视图，命令失败退回展开容器（两级承接）', () => {
    expect(src).toContain("executeCommand('memora.chat.focus')");
    expect(src).toContain("executeCommand('workbench.view.extension.memora')");
  });
});

describe('chatPanel.ts：三个触发点接线', () => {
  const src = read('src', 'webview', 'panels', 'chatPanel.ts');

  it('confirm：onConfirmShown 注入确认协调器', () => {
    expect(src).toContain('onConfirmShown: (info) => this._attention.onConfirmShown(info)');
  });

  it('ask：两个写入源各一处提醒（事件驱动 + 流尾兜底）', () => {
    // ⚠️ 计数是**故意的绊线**：ask 的写入源固定在两处（见 chatPanel 内注释）。新增写入源
    // 必须同步加提醒——本条会红，届时更新数字而不是删断言。
    const count = src.match(/_attention\.onAskWaiting\(/g)?.length ?? 0;
    expect(count).toBe(2);
  });

  it('done：本轮正常收场时提醒', () => {
    expect(src).toContain('this._attention.onRoundSettled({ roundId: latestRoundId })');
  });

  it('实例无参构造（判据只看窗口聚焦态，不再依赖视图实例）', () => {
    expect(src).toContain('createVscodeAttention()');
    expect(src).not.toContain('createVscodeAttention(() => this._view)');
  });
});

describe('分层纪律：纯逻辑层不碰 vscode', () => {
  it('attentionNotice.ts 零 vscode 依赖（判据可单测的前提）', () => {
    const src = read('src', 'extension', 'host', 'attentionNotice.ts');
    expect(src).not.toMatch(/from ['"]vscode['"]/);
    expect(src).not.toMatch(/require\(['"]vscode['"]\)/);
  });

  it('vscodeAttention.ts 只做适配：不出现判据/文案字面量', () => {
    const src = read('src', 'extension', 'host', 'vscodeAttention.ts');
    // 判据与文案的真源在 attentionNotice.ts；这里出现这些字样说明逻辑漏到了适配层
    expect(src).not.toContain('isWindowFocused() &&');
    expect(src).not.toContain('Memora 需要你确认');
    // 系统 toast 走工厂（平台闸/静默失败在工厂内）
    expect(src).toContain('showSystemToast: createSystemToastSender()');
  });
});

describe('workbench 通知已整体移除（用户要求收敛到面板内按钮）', () => {
  const notice = codeOf(read('src', 'extension', 'host', 'attentionNotice.ts'));
  const adapter = codeOf(read('src', 'extension', 'host', 'vscodeAttention.ts'));

  it('纯逻辑层不再注入 showInformationMessage', () => {
    expect(notice).not.toContain('showInformationMessage');
    expect(notice).not.toContain('showInfoMessage');
  });

  it('适配层不再注入 showInformationMessage（回归会立刻红）', () => {
    expect(adapter).not.toContain('showInformationMessage');
  });

  it('不再有「去处理」按钮文案常量（连按钮都不存在，就不可能有审批位）', () => {
    expect(notice).not.toContain('去处理');
  });
});
