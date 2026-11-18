/**
 * 聊天记录缩略图条测试（`helpers/attachmentStrip.ts`）
 *
 * 覆盖四个判据：有 URL 出图 / 无 URL 落文字态 / 加载失败降级（`error` 只表达「这次没取到」）/
 * 无附件零 DOM；外加 HOSTED-IMAGE-1 判据②「点开预览」：单例 / 三条关闭路径 / 点图不关。
 */
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import type { ImageRef } from '@zooique/memora';
import {
  renderAttachmentStrip,
  attachmentFailedText,
  IMAGE_LIGHTBOX_ID,
  closeImageLightbox,
} from '../helpers/attachmentStrip.js';

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
    expect(failed?.textContent).toBe('Preview failed to load (a1b2c3d4)');
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

describe('点开预览（HOSTED-IMAGE-1 判据② · 单例浮层）', () => {
  afterEach(() => {
    const overlay = document.getElementById(IMAGE_LIGHTBOX_ID);
    if (overlay) {
      const host = document.createElement('div');
      closeImageLightbox(host);
      overlay.remove();
    }
  });

  const withImages = () => {
    const host = container();
    const a = 'aaaa';
    const b = 'bbbb';
    renderAttachmentStrip(host, {
      attachments: [ref(a, 'a.png'), ref(b, 'b.png')],
      attachmentUris: { [a]: 'memora-resource://a.png', [b]: 'memora-resource://b.png' },
    });
    return host;
  };

  it('点缩略图 ⇒ 开全屏浮层、显示大图 + 文件名，同真源 URL', () => {
    const host = withImages();
    host.querySelector<HTMLImageElement>('.msg-attachment')!.click();
    const overlay = document.getElementById(IMAGE_LIGHTBOX_ID)!;
    expect(overlay).not.toBeNull();
    expect(overlay.hidden).toBe(false);
    expect(overlay.getAttribute('role')).toBe('dialog');
    const image = overlay.querySelector<HTMLImageElement>('.msg-image-lightbox__image')!;
    expect(image.src).toContain('memora-resource://a.png');
    expect(image.alt).toBe('a.png');
    expect(overlay.querySelector('.msg-image-lightbox__caption')?.textContent).toBe('a.png');
  });

  it('重挂两条消息后再点 ⇒ 仍只有一个浮层，切图不留上一张位图', () => {
    const first = withImages();
    first.querySelector<HTMLImageElement>('.msg-attachment')!.click();
    const second = withImages();
    const thumbs = second.querySelectorAll<HTMLImageElement>('.msg-attachment');
    thumbs[1].click();
    const overlays = document.querySelectorAll(`#${IMAGE_LIGHTBOX_ID}`);
    expect(overlays).toHaveLength(1);
    const image = overlays[0].querySelector<HTMLImageElement>('.msg-image-lightbox__image')!;
    expect(image.src).toContain('memora-resource://b.png');
  });

  it('三条关闭路径（按钮 / 点遮罩 / ESC）收敛到同一出口，关闭即清 src', () => {
    const host = withImages();
    host.querySelector<HTMLImageElement>('.msg-attachment')!.click();
    const overlay = document.getElementById(IMAGE_LIGHTBOX_ID)!;
    const image = () => overlay.querySelector<HTMLImageElement>('.msg-image-lightbox__image')!;

    overlay.querySelector<HTMLButtonElement>('.msg-image-lightbox__close')!.click();
    expect(overlay.hidden).toBe(true);
    expect(image().getAttribute('src')).toBeNull();

    host.querySelector<HTMLImageElement>('.msg-attachment')!.click();
    overlay.click();
    expect(overlay.hidden).toBe(true);
    expect(image().getAttribute('src')).toBeNull();

    host.querySelector<HTMLImageElement>('.msg-attachment')!.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(overlay.hidden).toBe(true);
    expect(image().getAttribute('src')).toBeNull();
  });

  it('点大图本身不关闭（防误触）；非 ESC 键不关闭', () => {
    const host = withImages();
    host.querySelector<HTMLImageElement>('.msg-attachment')!.click();
    const overlay = document.getElementById(IMAGE_LIGHTBOX_ID)!;
    overlay.querySelector<HTMLImageElement>('.msg-image-lightbox__image')!.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(overlay.hidden).toBe(false);
  });

  it('无 URL 落文字态 ⇒ 无可点缩略图，不开浮层', () => {
    const host = container();
    renderAttachmentStrip(host, { attachments: [ref()], attachmentUris: {} });
    expect(host.querySelector('.msg-attachment')).toBeNull();
    expect(document.getElementById(IMAGE_LIGHTBOX_ID)).toBeNull();
  });
});
