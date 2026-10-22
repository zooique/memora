/**
 * 系统 toast 单测（HOST-ATTN-1 离屏层）
 *
 * 本文件守的不是「toast 好不好看」，而是**通知永不反噬主链路**这件事：
 *   - XML 转义错 ⇒ PowerShell 侧 `LoadXml` 抛异常 ⇒ 脚本静默死掉 ⇒ 用户以为「没提醒」；
 *   - 数据拼进命令位 ⇒ 中文编码坑 + 注入面；
 *   - spawn 异常冒泡 ⇒ 确认卡建立（安全关键路径）被一条装饰性通知拖挂。
 *
 * 逐面设计（不是只断言「调用过」）：
 *   转义面 / 截断面 / 模板面 / 命令位面 / 平台面 / 失败面 / 句柄面。
 */
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TOAST_APP_ID,
  TOAST_LOG_FILENAME,
  buildToastScript,
  createSystemToastSender,
  encodeCommand,
  escapeXml,
  type SpawnLike,
  type SystemToastPayload,
} from '../systemToast.js';

const PAYLOAD: SystemToastPayload = {
  title: 'Memora 需要你确认',
  body: 'write_file：src/foo.ts',
  launchUri: 'vscode://zooique.memora/attention',
};

/** spawn 替身：记录调用、暴露监听器表，便于断言「error 有人接」与「unref 被调」 */
function makeFakeSpawn(behavior: 'ok' | 'throw' = 'ok') {
  const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
  const listeners = new Map<string, Array<(err?: unknown) => void>>();
  let unreffed = 0;
  const spawnFn: SpawnLike = (command, args, options) => {
    if (behavior === 'throw') throw new Error('spawn EINVAL');
    calls.push({ command, args, options });
    return {
      on: (event, listener) => {
        const bucket = listeners.get(event) ?? [];
        bucket.push(listener);
        listeners.set(event, bucket);
      },
      unref: () => {
        unreffed += 1;
      },
    };
  };
  return { spawnFn, calls, listeners, unreffed: () => unreffed };
}

describe('escapeXml —— 数据进 XML 前必须转义', () => {
  it('五个 XML 敏感字符各自转义', () => {
    expect(escapeXml('<')).toBe('&lt;');
    expect(escapeXml('>')).toBe('&gt;');
    expect(escapeXml('"')).toBe('&quot;');
    expect(escapeXml("'")).toBe('&apos;');
    expect(escapeXml('&')).toBe('&amp;');
  });

  it('`&` 最先替换：`<` 只被转义一次，不得产出 &amp;lt;', () => {
    // 若实现把 & 放在最后替换，`<` → `&lt;` 里的 & 会被二次转义成 &amp;lt;，
    // 系统显示字面量 `&lt;`（用户看到一堆实体码）
    expect(escapeXml('<')).toBe('&lt;');
    expect(escapeXml('<a>')).toBe('&lt;a&gt;');
    expect(escapeXml('a&b<c')).toBe('a&amp;b&lt;c');
  });

  it('输入里本来就是实体字面量 ⇒ & 照常转义（不做「已转义」猜测）', () => {
    // 文案里出现 `&amp;` 字样时，它只是四个普通字符；正确输出是 &amp;amp;
    expect(escapeXml('&amp;')).toBe('&amp;amp;');
  });

  it('按原始长度硬截断（300），防 XML 体积而不是展示策略', () => {
    const long = 'a'.repeat(400);
    expect(escapeXml(long)).toHaveLength(300);
    // 截断发生在转义前：转义后长度可超过 300（如 300 个 `&` → 1500 字符）——
    // 这是实测行为，不是缺陷：上限守的是「喂进 XML 的原文体积」
    expect(escapeXml('&'.repeat(400))).toHaveLength(1500);
  });

  it('不截断边界：恰好 300 原样保留', () => {
    const exact = 'b'.repeat(300);
    expect(escapeXml(exact)).toBe(exact);
  });
});

describe('buildToastScript —— 固定模板 + 转义数据', () => {
  it('activationType 必须是 protocol（扩展唯一可行的激活方式）', () => {
    const script = buildToastScript(PAYLOAD, DEFAULT_TOAST_APP_ID);
    // foreground 需要应用注册 COM activator，扩展没有 ⇒ 用错就是点击无反应
    expect(script).toContain('activationType="protocol"');
    expect(script).not.toContain('activationType="foreground"');
  });

  it('title / body / launch 三处数据都来自入参且已转义', () => {
    const script = buildToastScript(
      { title: 'A&B', body: '<c>', launchUri: 'vscode://x.y/attention' },
      DEFAULT_TOAST_APP_ID,
    );
    expect(script).toContain('<text>A&amp;B</text>');
    expect(script).toContain('<text>&lt;c&gt;</text>');
    expect(script).toContain('launch="vscode://x.y/attention"');
  });

  it('必须给 ToastGeneric 模板（缺 template 新版 Windows 不渲染）', () => {
    const script = buildToastScript(PAYLOAD, DEFAULT_TOAST_APP_ID);
    expect(script).toContain('template="ToastGeneric"');
  });

  /**
   * `scenario="reminder"` = **可用性前提**，不是样式偏好
   *
   * 普通 toast 的横幅约 5 秒自行消失。2026-10-22 真机实证：用户切到浏览器后本轮收场，
   * 通知**确实发了**（`wpndatabase.db` 里 ArrivalTime 14:37:37、载荷 XML 完整），但他
   * 什么都没看到——横幅早没了。「发出去了」不等于「被看到了」，而本模块的全部价值在后半句。
   * reminder 场景下横幅常驻到用户手动关闭。
   */
  it('必须是 scenario="reminder"（否则横幅 5 秒消失 = 白发一条）', () => {
    const script = buildToastScript(PAYLOAD, DEFAULT_TOAST_APP_ID);
    expect(script).toContain('scenario="reminder"');
    // 反面锚：普通 toast 就是没有 scenario；写明 duration 也不能救（reminder 以外仍会溜走）
    expect(script).not.toContain('scenario="alarm"'); // alarm 需要循环音频，会变成闹钟骚扰
  });

  it('空 body ⇒ 不产出第二个 text 节点（空 text 会撑出一行空行）', () => {
    const script = buildToastScript({ title: 'T', body: '', launchUri: 'vscode://a' }, 'app');
    expect(script).toContain('<text>T</text>');
    expect(script).not.toContain('<text></text>');
    expect(script.match(/<text>/g)).toHaveLength(1);
  });

  it('appId 先落到变量、再由变量传给 CreateToastNotifier（缺省值可被覆盖）', () => {
    const script = buildToastScript(PAYLOAD, 'Some.Custom.App');
    expect(script).toContain("$appId='Some.Custom.App'");
    expect(script).toContain('CreateToastNotifier($appId)');
  });

  it('输出全文不含裸单引号 ⇒ 整体安全嵌在 PowerShell 单引号串内', () => {
    // 危险形态：文案含 `'` 未转义 ⇒ 单引号串被提前闭合 ⇒ 剩余内容被当命令执行
    const script = buildToastScript(
      { title: "it's", body: "don't", launchUri: "vscode://a'b" },
      DEFAULT_TOAST_APP_ID,
    );
    // 脚本自身的定界符有 3 处（LoadXml、CreateToastNotifier 两处 + 1）——
    // 断言方式是「撇号数量与固定模板一致」，故先算模板基线
    const baseline = buildToastScript({ title: 'x', body: 'y', launchUri: 'z' }, DEFAULT_TOAST_APP_ID);
    const countQuotes = (s: string) => s.split("'").length - 1;
    expect(countQuotes(script)).toBe(countQuotes(baseline));
    expect(script).toContain('&apos;');
  });

  it('三条纪律之「数据走 LoadXml」：脚本里必须出现 LoadXml 赋值', () => {
    const script = buildToastScript(PAYLOAD, DEFAULT_TOAST_APP_ID);
    expect(script).toContain('$xml.LoadXml(');
  });
});

describe('AUMID 与失败可诊断 —— 真机「什么都不弹」的两个根因', () => {
  it('默认 AUMID 是真值 Microsoft.VisualStudioCode（中间不带点）', () => {
    expect(DEFAULT_TOAST_APP_ID).toBe('Microsoft.VisualStudioCode');
    // 反面锚：按扩展 ID 拼法想当然写出的 Microsoft.VisualStudio.Code 是**静默不显示**的错值
    expect(DEFAULT_TOAST_APP_ID).not.toBe('Microsoft.VisualStudio.Code');
  });

  it('AUMID 不匹配时按开始菜单发现 AppID 重试一次（便携版 / Insiders 的 AUMID 不同）', () => {
    const script = buildToastScript(PAYLOAD, DEFAULT_TOAST_APP_ID);
    expect(script).toContain('Get-StartApps');
    expect(script).toContain('*Visual Studio Code*');
    expect(script).toContain('$appId=$alt');
    // 重试必须在「首次尝试」的 catch 分支里，否则等于没兜底
    expect(script.indexOf('catch{')).toBeLessThan(script.indexOf('$appId=$alt'));
  });

  it('最终失败写日志到 %TEMP%（时间 / appId / 异常消息三要素齐全）', () => {
    const script = buildToastScript(PAYLOAD, DEFAULT_TOAST_APP_ID);
    expect(script).toContain(TOAST_LOG_FILENAME);
    expect(script).toContain('Out-File -Append');
    expect(script).toContain('appId=$appId');
    expect(script).toContain('Get-Date -Format o');
    expect(script).toContain('$($_.Exception.Message)');
  });

  it('顶层 try 覆盖「加载 WinRT → 建 XML → 显示」全程', () => {
    const script = buildToastScript(PAYLOAD, DEFAULT_TOAST_APP_ID);
    const tryAt = script.indexOf('try{');
    expect(tryAt).toBeGreaterThan(-1);
    for (const step of ['ContentType=WindowsRuntime', 'LoadXml(', 'Show($toast)']) {
      expect(script.indexOf(step)).toBeGreaterThan(tryAt);
    }
  });

  it('多行脚本（-EncodedCommand 收整段，不必压成一行）', () => {
    expect(buildToastScript(PAYLOAD, DEFAULT_TOAST_APP_ID)).toContain('\n');
  });

  it("appId 含单引号 ⇒ 按 PowerShell 规则双写，不破串", () => {
    expect(buildToastScript(PAYLOAD, "we'ird")).toContain("$appId='we''ird'");
  });
});

describe('encodeCommand —— PowerShell -EncodedCommand 口径', () => {
  it('UTF-16LE + Base64（不是 UTF-8；口径错了 PowerShell 解出乱码脚本）', () => {
    expect(encodeCommand('a')).toBe(Buffer.from('a', 'utf16le').toString('base64'));
    // `a` 的 UTF-16LE 是 61 00 ⇒ base64 "YQA="，UTF-8 口径会是 "YQ=="
    expect(encodeCommand('a')).toBe('YQA=');
  });

  it('中文往返一致（脚本里含中文时唯一可靠的编码口径）', () => {
    const script = buildToastScript(PAYLOAD, DEFAULT_TOAST_APP_ID);
    const decoded = Buffer.from(encodeCommand(script), 'base64').toString('utf16le');
    expect(decoded).toBe(script);
    expect(decoded).toContain('Memora 需要你确认');
  });
});

describe('createSystemToastSender —— fire-and-forget，失败静默', () => {
  it('非 Windows 平台直接 no-op（不 spawn，不抛错）', () => {
    const spy = makeFakeSpawn();
    const send = createSystemToastSender({ spawnFn: spy.spawnFn, platform: 'darwin' });
    send(PAYLOAD);
    expect(spy.calls).toHaveLength(0);
  });

  it('win32：走 powershell.exe -EncodedCommand，脚本里数据永不占命令位', () => {
    const spy = makeFakeSpawn();
    const send = createSystemToastSender({ spawnFn: spy.spawnFn, platform: 'win32' });
    send(PAYLOAD);

    expect(spy.calls).toHaveLength(1);
    const [call] = spy.calls;
    expect(call.command).toBe('powershell.exe');
    expect(call.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    // 反面锚：绝不出现 -Command（数据拼进命令位 = 注入面 + 中文编码坑）
    expect(call.args).not.toContain('-Command');
    expect(call.args).not.toContain('-c');
    // 载荷内容整体不在任何参数明文里出现
    expect(call.args.join(' ')).not.toContain('Memora');

    const decoded = Buffer.from(call.args[3], 'base64').toString('utf16le');
    expect(decoded).toContain('Memora 需要你确认');
    expect(decoded).toContain('vscode://zooique.memora/attention');
  });

  it('spawn 选项：stdio ignore + windowsHide（不弹黑窗）', () => {
    const spy = makeFakeSpawn();
    createSystemToastSender({ spawnFn: spy.spawnFn, platform: 'win32' })(PAYLOAD);
    expect(spy.calls[0].options).toEqual({ stdio: 'ignore', windowsHide: true });
  });

  it("spawn 同步抛错 ⇒ 吞掉，绝不冒泡到调用方（确认卡不能被通知拖挂）", () => {
    const spy = makeFakeSpawn('throw');
    const send = createSystemToastSender({ spawnFn: spy.spawnFn, platform: 'win32' });
    expect(() => send(PAYLOAD)).not.toThrow();
  });

  it("'error' 事件必须有人接（无人接 = Node 进程级未捕获异常）", () => {
    const spy = makeFakeSpawn();
    createSystemToastSender({ spawnFn: spy.spawnFn, platform: 'win32' })(PAYLOAD);
    const handlers = spy.listeners.get('error') ?? [];
    expect(handlers).toHaveLength(1);
    // 处理器自身不得再抛（ENOENT：PowerShell 不在 PATH）
    expect(() => handlers[0](new Error('spawn powershell.exe ENOENT'))).not.toThrow();
  });

  it('unref 被调用（不拖住宿主退出）', () => {
    const spy = makeFakeSpawn();
    createSystemToastSender({ spawnFn: spy.spawnFn, platform: 'win32' })(PAYLOAD);
    expect(spy.unreffed()).toBe(1);
  });

  it('unref 缺失的替身也不炸（可选链兜底）', () => {
    const calls: string[] = [];
    const spawnFn: SpawnLike = (command) => {
      calls.push(command);
      return { on: () => undefined }; // 无 unref
    };
    const send = createSystemToastSender({ spawnFn, platform: 'win32' });
    expect(() => send(PAYLOAD)).not.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('自定义 appId 贯穿到脚本（默认值可被覆盖）', () => {
    const spy = makeFakeSpawn();
    createSystemToastSender({ spawnFn: spy.spawnFn, platform: 'win32', appId: 'My.App' })(PAYLOAD);
    const decoded = Buffer.from(spy.calls[0].args[3], 'base64').toString('utf16le');
    expect(decoded).toContain("$appId='My.App'");
    expect(decoded).not.toContain(DEFAULT_TOAST_APP_ID);
  });

  it('同一 payload 可重复发送（无内部状态；去重责任在 attentionNotice）', () => {
    const spy = makeFakeSpawn();
    const send = createSystemToastSender({ spawnFn: spy.spawnFn, platform: 'win32' });
    send(PAYLOAD);
    send(PAYLOAD);
    expect(spy.calls).toHaveLength(2);
  });
});
