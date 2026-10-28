/**
 * 聊天记录缩略图条测试（`helpers/attachmentStrip.ts`）
 *
 * 覆盖四个判据：有 URL 出图 / 无 URL 落文字态 / 加载失败降级（`error` 只表达「这次没取到」）/
 * 无附件零 DOM。
 */
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import type { ImageRef } from '@zooique/memora';
import { renderAttachmentStrip, attachmentFailedText } from '../helpers/attachmentStrip.js';

const SHA = 'a1b2c3d4e5f6';

function ref(sha = SHA, name = '照片.png'): ImageRef {
  return { sha256: sha, mime: 'image/png', width: 4000, height: 3000, bytes: 2048, name };
}

function container(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

describe('renderAttachmentStrip：正文缩略图', () => {
  it('有 URL ⇒ 出 img，带 alt/title/宽高占位 + lazy/async', () => {
    const host = container();
    renderAttachmentStrip(host, {
      attachments: [ref()],
      attachmentUris: { [SHA]: 'memora-resource://x.png' },
    });
    const img = host.querySelector<HTMLImageElement>('.msg-attachments .msg-attachment');
    expect(img).not.toBeNull();
    expect(img!.src).toContain('memora-resource://x.png');
    expect(img!.alt).toBe('照片.png');
    expect(img!.title).toBe('照片.png');
    // 宽高属性 = 原始像素（只为让浏览器预留比例位，实际展示由 CSS 上限收敛）
    expect(img!.getAttribute('width')).toBe('4000');
    expect(img!.getAttribute('height')).toBe('3000');
    expect(img!.loading).toBe('lazy');
    expect(img!.decoding).toBe('async');
  });

  it('缺 URL ⇒ 直接落文字态，不出 img、不编造地址', () => {
    const host = container();
    renderAttachmentStrip(host, { attachments: [ref()], attachmentUris: {} });
    expect(host.querySelector('img')).toBeNull();
    const failed = host.querySelector<HTMLElement>('.msg-attachment-failed');
    expect(failed?.textContent).toBe('预览加载失败（a1b2c3d4）');
    // 文件名仍在（读屏/悬停可定位是哪一张）
    expect(failed?.title).toBe('照片.png');
  });

  it('加载失败 ⇒ 原位换成文字态（消息与其余缩略图不受牵连）', () => {
    const host = container();
    const okSha = 'ffffffffffff';
    renderAttachmentStrip(host, {
      attachments: [ref(), ref(okSha, '另一张.png')],
      attachmentUris: { [SHA]: 'memora-resource://a.png', [okSha]: 'memora-resource://b.png' },
    });
    const [first] = host.querySelectorAll<HTMLImageElement>('.msg-attachment');
    first!.dispatchEvent(new Event('error'));

    expect(host.querySelectorAll('.msg-attachment-failed')).toHaveLength(1);
    expect(host.querySelector('.msg-attachment-failed')?.textContent).toBe(
      attachmentFailedText(SHA),
    );
    // 另一张仍在（逐个降级，不整条清空）
    expect(host.querySelectorAll('img.msg-attachment')).toHaveLength(1);
  });

  it('无附件 ⇒ 零 DOM（纯文字消息形状与升级前逐字一致）', () => {
    const host = container();
    renderAttachmentStrip(host, { attachments: [] });
    renderAttachmentStrip(host, {});
    expect(host.childNodes).toHaveLength(0);
  });

  it('多图保持声明顺序', () => {
    const host = container();
    const a = 'aaaa';
    const b = 'bbbb';
    renderAttachmentStrip(host, {
      attachments: [ref(a, 'a.png'), ref(b, 'b.png')],
      attachmentUris: { [a]: 'memora-resource://a.png', [b]: 'memora-resource://b.png' },
    });
    const alts = Array.from(host.querySelectorAll('img')).map((i) => i.alt);
    expect(alts).toEqual(['a.png', 'b.png']);
  });
});
