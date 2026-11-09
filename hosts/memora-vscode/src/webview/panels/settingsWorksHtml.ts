/**
 * 设置面板「作品和规则」选项卡 HTML 主体片段
 *
 * 为什么独立成文件（同 `settingsMcpHtml.ts` / `settingsSecurityHtml.ts`）：
 * `settingsPanel.ts` 与 `settingsPanelHtml.ts` 都在行数闸下，而选项卡骨架是典型的
 * 线性增长域；按 tab 前缀分文件才不会把「加一页」变成压线工程。
 *
 * 职责边界：**只给静态 DOM 骨架，零逻辑、零动态插值**。行数据、失效徽标、动作回执
 * 全由 `work_projection` 消息驱动 `scripts/worksView.ts` 渲染。
 *
 * ⚠️ 本片段**不带外层 root 容器**：`buildHtml()` 用 `settingsRootId('works')` 统一生成
 * `works-root` 并按是否默认首页决定 `hidden`。故本文件不得写 `#works-root` 的 `display`
 * ——给 root 写 display 会覆盖 `hidden` 属性（UI 一致性规则 10 的结构性假绿）。
 * 页头 / 说明 / 页尾用的是共享类名，其布局规则在 `styles/worksStyles.ts` 以
 * `#works-root` 前缀接管，不在这里写内联样式。
 */

/** 作品和规则子视图主体（works 选项卡：清单 + 项目规则装配诊断 + 单击打开原文件） */
export const WORKS_BODY_HTML = `
  <!-- 作品和规则子视图（works 选项卡：作品投影清单与项目规则求值） -->
    <div class="header">
      <h2>作品和规则</h2>
      <span id="worksCount" class="stat-bar" hidden></span>
      <div class="header-actions">
        <button id="btnRefreshWorks" class="btn btn-secondary btn-icon-solo" type="button" title="重新读取清单（徽标是最近一次装配求值的结果，改完清单需下一轮对话才重算）">
          <span class="btn-icon" data-icon="refresh"></span>
        </button>
      </div>
    </div>
    <div class="hint"><code>work-projections.json</code> 里登记的都是作品；点行内<strong>「设为项目规则」</strong>即可升级为每轮自动注入的红线。<strong>单击一行打开原文件</strong>可直接修改，保存后下一轮装配重读。</div>
    <div id="worksNotice" class="works-notice" hidden></div>
    <div id="worksList" class="works-list">
      <p class="loading-hint">加载中…</p>
    </div>
    <p class="footer-hint">行尾标出当前是不是项目规则、上一轮装配有没有真的注入；清单改动即时可见，失效原因由内核在每轮装配时重算，改完文件后需发起一轮对话才会刷新。</p>`;
