// content-glm.js - 注入到 bigmodel.cn/glm-coding 页面
// 职责：DOM 监听 + 定时扫描套餐按钮状态，状态变化上报 background
// 纯只读：只读按钮状态，不点击不抢购
// 判断逻辑经真实样本验证：按钮 "暂时售罄 ｜07月30日 10:00 补货" [disabled] = 售罄

(() => {
  // 内联常量（content script 不能 import module，需内联）
  const GLM_BTN_SELECTOR = (n) => `.glm-coding-package-list > div:nth-child(${n}) > div > .package-card-btn-box > button`;
  const PLAN_INDEX = { lite: 1, pro: 2, max: 3 };
  const SOLD_OUT_RE = /售罄|补货|暂时/;
  const BUSY_RE = /抢购人数过多|请刷新/;
  const PURCHASABLE_TEXTS = ['特惠订阅', '立即订阅', '立即购买', '购买'];
  const RESTOCK_RE = /(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/;
  const NORMAL_SEC = 10;
  const BURST_SEC = 3;

  let CONFIG = { glm: { targets: { lite: false, pro: true, max: false } } };
  let lastReport = {};   // { lite: {status, text, restockText}, ... } 上次上报状态，用于去重
  let scanTimer = null;
  let observer = null;
  let loginReported = false;  // 登录失效是否已上报过（避免重复通知）

  // ============================================================
  // 登录态检测
  // 已登录：导航栏有"工作台/控制台/用户中心"或头像，无"登录"按钮
  // 未登录：导航栏出现"登录"按钮
  // ============================================================
  function checkLogin() {
    // 智谱未登录时，导航/页面会出现"登录"文案的按钮或链接
    // 只扫 header/nav 区域（避免每秒遍历全文档 600+ 元素），找不到再兜底全文档
    const SCOPE = document.querySelector('header, nav, [class*="header"], [class*="nav"]') || document;
    const loginLink = Array.from(SCOPE.querySelectorAll('a, button, span'))
      .find(el => {
        const t = (el.textContent || '').trim();
        return t === '登录' || t === '登 录' || t === 'Log in' || t === 'Login';
      });
    if (loginLink) return false;
    // 兜底：套餐列表完全不存在且页面有登录引导
    if (!document.querySelector('.glm-coding-package-list')) {
      const pageText = document.body?.innerText || '';
      if (/请先登录|立即登录|前往登录/.test(pageText)) return false;
    }
    return true;
  }

  // 抓取登录账户信息：头像 alt、用户中心入口文字、手机号等
  function extractAccount() {
    // 1. 头像图片的 alt（常为用户名）
    const avatar = document.querySelector('img[class*="avatar"], img[class*="user"], img[alt]:not([alt=""])');
    if (avatar && avatar.alt && avatar.alt.length > 0 && avatar.alt.length < 30) {
      return { name: avatar.alt };
    }
    // 2. 用户中心/工作台入口的文字
    const userEls = document.querySelectorAll('[class*="user-name"], [class*="username"], [class*="user-info"], [class*="account-name"], .el-dropdown span');
    for (const el of userEls) {
      const t = (el.textContent || '').trim();
      if (t && t.length > 0 && t.length < 30 && !/登录|注册/.test(t)) {
        return { name: t };
      }
    }
    // 3. 手机号脱敏格式（如 138****8888）
    const bodyText = document.body?.innerText || '';
    const phoneMatch = bodyText.match(/1\d{2}\*{4}\d{4}/);
    if (phoneMatch) return { name: phoneMatch[0] };
    return null;
  }

  // ============================================================
  // 按钮状态分类（与 utils.js classifyGlmButton 一致）
  // ============================================================
  function classifyButton(btn) {
    if (!btn) return { status: 'unknown', text: '' };
    const text = (btn.textContent || '').trim();
    const disabled = btn.disabled || btn.classList.contains('is-disabled') || btn.classList.contains('disabled');
    if (BUSY_RE.test(text)) return { status: 'busy', text };
    if (SOLD_OUT_RE.test(text) || disabled) return { status: 'sold_out', text };
    if (PURCHASABLE_TEXTS.some(t => text.includes(t)) && !disabled) return { status: 'available', text };
    return { status: 'unknown', text };
  }

  function extractRestock(text) {
    if (!text) return null;
    const m = text.match(RESTOCK_RE);
    if (m) return `${parseInt(m[1])}月${parseInt(m[2])}日 ${parseInt(m[3])}:${m[4]}`;
    return null;
  }

  // ============================================================
  // 扫描所有套餐卡片
  // ============================================================
  function scanCards() {
    // 登录态检测：未登录立即上报，不判断库存（避免误报放货）
    const loggedIn = checkLogin();
    if (!loggedIn) {
      if (!loginReported) {
        loginReported = true;
        reportState('_login', 'logged_out', 'GLM 登录已失效', null);
      }
      return;
    }
    // 恢复登录后重置标记
    if (loginReported) loginReported = false;

    // 抓取账户信息，变化时上报（单独用 _account 上报，不与套餐状态绑定）
    const account = extractAccount();
    if (account && JSON.stringify(account) !== JSON.stringify(lastAccount)) {
      lastAccount = account;
      reportState('_account', 'available', account.name || '', null, account);
    }

    const found = {};
    let anyButton = false;
    for (const [planKey, idx] of Object.entries(PLAN_INDEX)) {
      const btn = document.querySelector(GLM_BTN_SELECTOR(idx));
      if (!btn) continue;
      anyButton = true;
      const cls = classifyButton(btn);
      if (cls.status === 'unknown') continue;
      found[planKey] = {
        planKey,
        status: cls.status,
        buttonText: cls.text,
        restockText: extractRestock(btn.textContent || '')
      };
    }

    // 页面无套餐卡片：可能页面结构变了
    if (!anyButton && !document.querySelector('.glm-coding-package-list')) {
      if (!loginReported) {
        loginReported = true;
        reportState('_page_state', 'no_cards', location.href, null);
      }
      return;
    }

    // 比对并上报变化
    for (const [planKey, info] of Object.entries(found)) {
      const prev = lastReport[planKey];
      const changed = !prev
        || prev.status !== info.status
        || prev.buttonText !== info.buttonText
        || prev.restockText !== info.restockText;
      if (changed) {
        lastReport[planKey] = info;
        reportState(planKey, info.status, info.buttonText, info.restockText);
      }
    }
  }

  let lastAccount = null;  // 缓存账户信息，避免每次扫描都上报

  function reportState(planKey, status, buttonText, restockText, account) {
    try {
      chrome.runtime.sendMessage({
        type: 'glm_state_changed',
        payload: { planKey, status, buttonText, restockText, account }
      }).catch(() => {});
    } catch (e) {
      // SW 可能休眠，忽略
    }
  }

  // ============================================================
  // DOM 监听：套餐区域变化即重扫
  // ============================================================
  function startObserver() {
    const list = document.querySelector('.glm-coding-package-list');
    if (!list) return false;
    observer = new MutationObserver(() => {
      scanCards();
    });
    observer.observe(list, { childList: true, subtree: true, characterData: true, attributes: true });
    return true;
  }

  // ============================================================
  // 定时扫描：平时 10s，放货窗口 3s
  // ============================================================
  function getIntervalSec() {
    // 放货窗口：用配置的放货时间（与 background isInGlmBurstWindow 一致）
    // prepMinutes 提前进入高频，持续到放货后 5 分钟（9:55-10:05）
    const now = new Date();
    const restock = new Date(now);
    restock.setHours(CONFIG.glm.restockHour ?? 10, CONFIG.glm.restockMinute ?? 0, 0, 0);
    const prep = (CONFIG.glm.prepMinutes ?? 5) * 60 * 1000;
    const prepStart = restock.getTime() - prep;
    const burstEnd = restock.getTime() + 5 * 60 * 1000;
    const t = now.getTime();
    return (t >= prepStart && t <= burstEnd) ? BURST_SEC : NORMAL_SEC;
  }

  function startHeartbeat() {
    const tick = () => {
      scanCards();
      scanTimer = setTimeout(tick, getIntervalSec() * 1000);
    };
    tick();
  }

  // ============================================================
  // 初始化
  // ============================================================
  async function init() {
    // 拉取配置
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'glm_get_config' });
      if (resp?.ok) CONFIG = resp.config;
    } catch (e) {
      console.warn('[TSM] init getConfig failed', e);
    }

    // 等套餐列表渲染
    let tries = 0;
    const waitAndStart = () => {
      if (document.querySelector('.glm-coding-package-list')) {
        startObserver();
        startHeartbeat();
        // 首扫
        setTimeout(scanCards, 500);
        console.log('[TSM] GLM 监控已启动');
      } else if (tries++ < 20) {
        setTimeout(waitAndStart, 500);
      } else {
        // 页面结构异常，仍启动心跳兜底
        startHeartbeat();
        console.warn('[TSM] 未找到套餐列表，启动心跳兜底');
      }
    };
    waitAndStart();
  }

  init();
})();
