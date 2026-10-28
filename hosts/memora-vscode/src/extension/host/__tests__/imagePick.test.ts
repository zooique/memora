/**
 * 原生文件选择框适配层（`host/imagePick.ts`）单元测试
 *
 * 用注入 picker 而非真 vscode：被测行为 = 选项构造 / 取消语义 / 编排分发，
 * mock 掉 vscode 后这些才是可断言的；落盘行为归 `imageIngest.test.ts`
 * （真临时目录已覆盖），此处用真临时目录 + 真 PNG 走通端到端编排即可，不重复断言落盘细节。
 */
import { describe, it, expect, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionToWebviewMessage } from '../../../shared/protocol.js';
import { makeTempDir } from '../../../__tests__/helpers/tmpDir.js';
import { pngBytes } from '../../../__tests__/helpers/imageTestBytes.js';
import { pickAndIngestImages, type ImageFilePicker } from '../imagePick.js';

/** 拾取回执类型（与生产同源） */
type PickedResult = Extract<ExtensionToWebviewMessage, { type: 'image_picked' }>;

/** 构造被测依赖：picker 可按用例替换，post 收集全部回执 */
function makeDeps(overrides: Partial<Parameters<typeof pickAndIngestImages>[0]> = {}) {
  const post = vi.fn<(msg: PickedResult) => void>();
  const notify = vi.fn<() => void>();
  const picker = vi.fn<ImageFilePicker>();
  return {
    post,
    notify,
    picker,
    deps: {
      hasPanel: true,
      picker,
      projectPath: '',
      post,
      notifyPanelUnavailable: notify,
      ...overrides,
    },
  };
}

describe('pickAndIngestImages — 入口闸门', () => {
  it('面板未解析（命令入口无视图）→ 不开框、只给引导，绝不落盘造孤儿', async () => {
    const { deps, picker, notify } = makeDeps({ hasPanel: false });

    await pickAndIngestImages(deps);

    expect(picker).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe('pickAndIngestImages — 选项与取消语义', () => {
  it('开框选项单点下发：多选 + 中文图片过滤器 + 所有文件兜底（扩展名不可信的立身前提）', async () => {
    const { deps, picker } = makeDeps();

    await pickAndIngestImages(deps);

    expect(picker).toHaveBeenCalledTimes(1);
    const opts = picker.mock.calls[0]![0];
    expect(opts.canSelectMany).toBe(true);
    expect(opts.title).toContain('图片');
    expect(opts.filters['图片']).toContain('png');
    // 兜底必须存在：锁死扩展名 = 自打「扩展名不可信」的嘴
    expect(opts.filters['所有文件']).toEqual(['*']);
  });

  it('取消（undefined）→ 不回执、不落盘（「没有发生任何事」不产生事件）', async () => {
    const { deps, picker, post } = makeDeps({ projectPath: makeTempDir('memora-pick-') });
    picker.mockResolvedValueOnce(undefined);

    await pickAndIngestImages(deps);

    expect(post).not.toHaveBeenCalled();
  });

  it('空选（[]）→ 同取消，零回执', async () => {
    const { deps, picker, post } = makeDeps({ projectPath: makeTempDir('memora-pick-') });
    picker.mockResolvedValueOnce([]);

    await pickAndIngestImages(deps);

    expect(post).not.toHaveBeenCalled();
  });
});

describe('pickAndIngestImages — 多选编排', () => {
  it('多选 N 张 → 每张独立走读盘落盘，各得一条 ok 回执（单张失败不拖累其余）', async () => {
    const root = makeTempDir('memora-pick-');
    const a = join(root, 'a.png');
    const b = join(root, 'b.png');
    writeFileSync(a, pngBytes(4, 4));
    writeFileSync(b, pngBytes(8, 8));
    writeFileSync(join(root, 'bad.png'), Buffer.from('not an image'));
    const { deps, picker, post } = makeDeps({ projectPath: root });
    picker.mockResolvedValueOnce([a, join(root, 'bad.png'), b]);

    await pickAndIngestImages(deps);

    // 三张全有回执（坏的那张是**可见** rejected，不是静默消失）。
    // ⚠️ 并发落盘 ⇒ 到达顺序不保证（无写盘的 rejected 必然最快）——webview 逐条独立
    // 消费，回执间无序依赖，断言必须按 name 归位而不是按位置。
    expect(post).toHaveBeenCalledTimes(3);
    const byName = new Map(post.mock.calls.map((c) => [c[0].name, c[0].status]));
    expect(byName.get('a.png')).toBe('ok');
    expect(byName.get('bad.png')).toBe('rejected');
    expect(byName.get('b.png')).toBe('ok');
  });
});
