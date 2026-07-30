// utils.js - 共享工具：通知推送（企业微信群机器人主 / Bark备选）、状态分类、登录态检测、日志、时间格式化

import { GLM, KIMI, STATUS, STORAGE_KEYS, DEFAULT_CONFIG, SCHEDULE } from './constants.js';

// ============================================================
// 配置读写
// ============================================================
export async function getConfig() {
  const obj = await chrome.storage.local.get(STORAGE_KEYS.CONFIG);
  const saved = obj[STORAGE_KEYS.CONFIG] || {};
  // 深合并默认配置
  return {
    ...DEFAULT_CONFIG,
    ...saved,
    glm: { ...DEFAULT_CONFIG.glm, ...(saved.glm || {}) },
    kimi: { ...DEFAULT_CONFIG.kimi, ...(saved.kimi || {}) }
  };
}

export async function setConfig(cfg) {
  await chrome.storage.local.set({ [STORAGE_KEYS.CONFIG]: cfg });
}

export async function getState() {
  const obj = await chrome.storage.local.get(STORAGE_KEYS.STATE);
  return obj[STORAGE_KEYS.STATE] || {
    glm: {},        // { lite: {status, text, restockAt, lastSeen}, pro: {...}, max: {...} }
    kimi: {},       // { Andante: {status, lastSeen}, ... }
    glmLogin: 'unknown',
    kimiLogin: 'unknown',
    lastGlmCheck: 0,
    lastKimiCheck: 0,
    glmTabId: null  // 自动打开的 GLM tab id
  };
}

export async function setState(state) {
  await chrome.storage.local.set({ [STORAGE_KEYS.STATE]: state });
}

// 原子读-改-写：串行化，避免多个 handler 并发读同一份旧 state 后互相覆盖。
// updater 收到当前 state（深拷贝），返回修改后的 state 或 undefined（放弃写入）。
let _stateChain = Promise.resolve();
export async function updateState(updater) {
  const run = _stateChain.then(async () => {
    const cur = await getState();
    const next = await updater(cur);
    if (next) await setState(next);
    return next;
  });
  // 串行：下一个 updateState 等本次真正完成（含异常）才执行
  _stateChain = run.catch(() => {});
  return run;
}

// ============================================================
// 日志环（最近 100 条）
// ============================================================
// 日志环（最近 100 条）。用链式锁串行化，避免并发读-改-写丢条目。
// 自动在消息前加时间戳。extra.front=true 表示前端可见（关键事件），否则仅后台调试。
let _logChain = Promise.resolve();
export async function pushLog(level, msg, extra = {}) {
  const ts = Date.now();
  const tStr = new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
  const front = extra.front === true;
  const run = _logChain.then(async () => {
    const obj = await chrome.storage.local.get(STORAGE_KEYS.LOG);
    const log = obj[STORAGE_KEYS.LOG] || [];
    log.unshift({ ts, level, msg: `[${tStr}] ${msg}`, front, ...extra });
    await chrome.storage.local.set({ [STORAGE_KEYS.LOG]: log.slice(0, 500) });
  });
  _logChain = run.catch(() => {});
  console.log(`[TSM ${tStr}] [${level}] ${msg}`);
  await run;
}

// ============================================================
// 通知推送：企业微信群机器人（主）/ Bark（备选）
// ============================================================
export async function pushNotify(cfg, title, body, url = '') {
  const channel = cfg.notifyChannel || 'wecom';
  if (channel === 'wecom') {
    return pushWecom(cfg, title, body, url);
  }
  return pushBark(cfg, title, body, url);
}

// 企业微信群机器人
// webhook: https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=XXX
export async function pushWecom(cfg, title, body, url = '') {
  if (!cfg.wecomKey) {
    console.warn('[TSM] 企业微信 key 未配置，跳过推送');
    return false;
  }
  try {
    const webhook = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${cfg.wecomKey}`;
    // 用 markdown 格式，标题加粗，内容带可点击链接
    const content = url
      ? `**${title}**\n${body}\n[点击前往](${url})`
      : `**${title}**\n${body}`;
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: { content }
      })
    });
    const data = await res.json().catch(() => ({}));
    return data.errcode === 0;
  } catch (e) {
    console.error('[TSM] 企业微信推送失败:', e);
    return false;
  }
}

// Bark 推送（备选）
export async function pushBark(cfg, title, body, url = '') {
  if (!cfg.barkKey) {
    console.warn('[TSM] Bark key 未配置，跳过推送');
    return false;
  }
  try {
    // Bark URL 格式：https://api.day.app/{key}/{title}/{body}?url=xxx
    const base = (cfg.barkServer || 'https://api.day.app').replace(/\/$/, '');
    const t = encodeURIComponent(title);
    const b = encodeURIComponent(body);
    const pushUrl = `${base}/${cfg.barkKey}/${t}/${b}?group=TokenStockMonitor&sound=glass&isArchive=1${url ? `&url=${encodeURIComponent(url)}` : ''}`;
    const res = await fetch(pushUrl, { method: 'GET' });
    const data = await res.json().catch(() => ({}));
    return data.code === 200;
  } catch (e) {
    console.error('[TSM] Bark 推送失败:', e);
    return false;
  }
}

// ============================================================
// Chrome 桌面通知（兜底）
// ============================================================
export async function desktopNotify(title, message, url = '') {
  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message,
      priority: 2
    });
  } catch (e) {
    // 图标缺失时通知可能失败，忽略
  }
}

// ============================================================
// GLM 按钮状态分类
// 输入按钮 textContent 和 disabled，返回状态枚举
// ============================================================
export function classifyGlmButton(text, disabled) {
  const t = (text || '').trim();
  if (!t) return { status: STATUS.UNKNOWN, text: t };
  if (GLM.BUSY_RE.test(t)) return { status: STATUS.BUSY, text: t };
  if (GLM.SOLD_OUT_RE.test(t) || disabled) return { status: STATUS.SOLD_OUT, text: t };
  if (GLM.PURCHASABLE_TEXTS.some(p => t.includes(p)) && !disabled) {
    return { status: STATUS.AVAILABLE, text: t };
  }
  return { status: STATUS.UNKNOWN, text: t };
}

// 提取补货时间，如 "暂时售罄 ｜07月30日 10:00 补货" -> "07月30日 10:00"
export function extractGlmRestock(text) {
  if (!text) return null;
  const m = text.match(GLM.RESTOCK_RE);
  if (m) return `${parseInt(m[1])}月${parseInt(m[2])}日 ${parseInt(m[3])}:${m[4]}`;
  return null;
}

// ============================================================
// Kimi 商品状态分类
// 输入 ListGoods 返回的 goods[]，按套餐名归类状态
// ============================================================
export function classifyKimiGoods(goodsArray) {
  // 同一套餐可能有月付/年付多条记录，合并判断：
  // 只要任一条是候补中，整体就算候补中（保守，避免误报开放）
  // 只有所有非订阅记录都"非候补"时才算开放
  const byPlan = {};  // { Andante: [{g}, {g}], ... }
  for (const g of goodsArray || []) {
    const title = g.title;
    if (!KIMI.PLANS.includes(title)) continue;
    if (!byPlan[title]) byPlan[title] = [];
    byPlan[title].push(g);
  }

  const result = {};
  const now = Date.now();
  for (const [title, items] of Object.entries(byPlan)) {
    // 已订阅：任一条 subscribed 即算已订阅
    if (items.some(g => g.subscribed === true)) {
      result[title] = { status: STATUS.SUBSCRIBED, lastSeen: now };
      continue;
    }
    // 候补中：任一条 reason 以 REASON_SUBSCRIPTION_ 开头即算候补
    // 实测 reason 值：REASON_SUBSCRIPTION_NEED_APPLY（需要申请/已候补）
    const anyWaitlisted = items.some(g => {
      const reason = g.transitionSummary?.reason;
      return reason && reason.startsWith(KIMI.WAITLIST_REASON_PREFIX);
    });
    if (anyWaitlisted) {
      result[title] = { status: STATUS.WAITLISTED, lastSeen: now };
    } else {
      // 所有记录都非候补且非订阅 = 开放
      const reasons = items.map(g => g.transitionSummary?.reason || null);
      result[title] = { status: STATUS.AVAILABLE, reasons, lastSeen: now };
    }
  }
  return result;
}

// ============================================================
// 判断 fetch 响应是否登录态有效
// 返回 true=登录有效，false=登录失效
// ============================================================
export function isLoginOk(status, contentType, body) {
  if (status === 401 || status === 403) return false;
  // 响应是 HTML 登录页而非 JSON = 未登录
  if (contentType && contentType.includes('text/html')) return false;
  if (typeof body === 'string') {
    if (body.includes('login') && body.includes('<!DOCTYPE')) return false;
    if (body.includes('"code":1001') && body.includes('authenticate')) return false;
  }
  return true;
}

// ============================================================
// 时间工具
// ============================================================
export function fmtTime(ts) {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(x => String(x).padStart(2, '0'))
    .join(':');
}

export function fmtDateTime(ts) {
  const d = new Date(ts);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 当前是否在 GLM 放货高频窗口内
// prepMinutes 提前进入，持续到放货后 GLM_BURST_AFTER_MIN 分钟（默认 9:55-10:05）
export function isInGlmBurstWindow(cfg, now = new Date()) {
  const restock = new Date(now);
  restock.setHours(cfg.glm.restockHour, cfg.glm.restockMinute, 0, 0);
  const prepStart = restock.getTime() - cfg.glm.prepMinutes * 60 * 1000;
  const burstEnd = restock.getTime() + SCHEDULE.GLM_BURST_AFTER_MIN * 60 * 1000;
  const t = now.getTime();
  return t >= prepStart && t <= burstEnd;
}

// 防抖
export function debounce(fn, wait) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}
