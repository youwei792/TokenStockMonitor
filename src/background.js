// background.js - Service Worker (MV3)
// 职责：chrome.alarms 调度、Kimi 后台 fetch、GLM 自动开/关页、通知触发、状态存储
// 关键：所有 listener 必须在顶层同步注册，SW 唤醒后才能收到事件

import {
  STORAGE_KEYS, SCHEDULE, STATUS, MSG, GLM, KIMI
} from './constants.js';
import {
  getConfig, setConfig, getState, setState, updateState, pushLog,
  pushNotify, desktopNotify, classifyKimiGoods, isLoginOk,
  isInGlmBurstWindow
} from './utils.js';

// ============================================================
// 顶层 listener 注册（MV3 SW 唤醒后必须能立即绑定）
// ============================================================

chrome.alarms.onAlarm.addListener(handleAlarm);
chrome.runtime.onMessage.addListener(handleMessage);
chrome.runtime.onInstalled.addListener(onInstalled);

// SW 启动时确保 alarms 存在（alarms 持久，但首次安装/SW 重启兜底）
// 用 chrome.alarms.get 检查，避免重复创建刷日志
ensureAlarms();
// SW 重启后 setTimeout 定时器会丢失，重置标志让放货窗口可重新启动秒级刷新
updateState(state => { state.glmBurstTimerStarted = false; return state; });

async function onInstalled() {
  await pushLog('info', '插件已安装/更新，初始化调度');
  const cfg = await getConfig();
  await setupAlarms(cfg);
}

// 仅在 alarm 不存在时创建，避免每次 SW 唤醒都刷日志
async function ensureAlarms() {
  const heartbeat = await chrome.alarms.get('tsm_heartbeat');
  const kimi = await chrome.alarms.get('tsm_kimi');
  if (!heartbeat || !kimi) {
    const cfg = await getConfig();
    await setupAlarms(cfg);
  }
}

// ============================================================
// Alarm 调度
// ============================================================
async function setupAlarms(cfg) {
  cfg = cfg || await getConfig();
  // 先清除旧的，避免刷新扩展后重复堆积
  await chrome.alarms.clearAll();
  // 心跳：每分钟唤醒 SW，保活 + 触发 GLM 窗口判断 + 预检登录态
  await chrome.alarms.create('tsm_heartbeat', { delayInMinutes: SCHEDULE.HEARTBEAT_MIN, periodInMinutes: SCHEDULE.HEARTBEAT_MIN });
  // Kimi 定时 fetch：间隔可配置（fetch 本身兼做 Kimi 保活）
  const kimiMin = Math.max(1, cfg.kimi.fetchIntervalMin ?? SCHEDULE.KIMI_FETCH_MIN);
  await chrome.alarms.create('tsm_kimi', { delayInMinutes: kimiMin, periodInMinutes: kimiMin });
  // 登录态保活：每 30 分钟静默访问 GLM 页面，触发 cookie 续期
  await chrome.alarms.create('tsm_keepalive', { delayInMinutes: SCHEDULE.KEEPALIVE_MIN, periodInMinutes: SCHEDULE.KEEPALIVE_MIN });
  await pushLog('info', `alarms 已建立：心跳 ${SCHEDULE.HEARTBEAT_MIN}min / Kimi ${kimiMin}min / 保活 ${SCHEDULE.KEEPALIVE_MIN}min`);
}

// Kimi 间隔变更时单独重建 Kimi alarm（不影响其他 alarm 的周期）
async function rescheduleKimi(cfg) {
  const kimiMin = Math.max(1, cfg.kimi.fetchIntervalMin ?? SCHEDULE.KIMI_FETCH_MIN);
  await chrome.alarms.clear('tsm_kimi');
  await chrome.alarms.create('tsm_kimi', { delayInMinutes: kimiMin, periodInMinutes: kimiMin });
  await pushLog('info', `Kimi 检查间隔已更新为 ${kimiMin}min`);
}

async function handleAlarm(alarm) {
  const cfg = await getConfig();
  if (!cfg.enabled) return;

  if (alarm.name === 'tsm_heartbeat') {
    // 心跳：处理 GLM 放货窗口（自动开页/关页）+ 放货前预检登录态
    await handleGlmWindow(cfg);
    await handlePrecheckLogin(cfg);
  } else if (alarm.name === 'tsm_kimi') {
    // Kimi 定时 fetch（兼做 Kimi 保活）
    if (cfg.kimi.enabled) {
      await fetchKimiGoods(cfg);
    }
  } else if (alarm.name === 'tsm_keepalive') {
    // 登录态保活：静默访问两个站点触发 cookie 续期
    await keepAlive(cfg);
  }
}

// ============================================================
// 登录态保活：静默访问页面触发 cookie 自动续期
// 不打开可见页面，用 tabs.create 后台加载再关闭
// ============================================================
async function keepAlive(cfg) {
  // GLM 保活：静默访问 GLM 页面
  if (cfg.glm.enabled) {
    try {
      const tab = await chrome.tabs.create({ url: GLM.PAGE_URL, active: false });
      // 等 8 秒让页面加载完成、cookie 续期请求发出
      setTimeout(async () => {
        try { await chrome.tabs.remove(tab.id); } catch (e) {}
      }, 8000);
      await pushLog('info', 'GLM 保活：已静默访问');
    } catch (e) {
      await pushLog('warn', `GLM 保活失败: ${e.message}`);
    }
  }
  // Kimi 保活：静默访问 Kimi 页面（fetch 接口已兼做保活，这里补一次页面访问）
  if (cfg.kimi.enabled) {
    try {
      const tab = await chrome.tabs.create({ url: KIMI.PAGE_URL, active: false });
      setTimeout(async () => {
        try { await chrome.tabs.remove(tab.id); } catch (e) {}
      }, 8000);
      await pushLog('info', 'Kimi 保活：已静默访问');
    } catch (e) {
      await pushLog('warn', `Kimi 保活失败: ${e.message}`);
    }
  }
}

// ============================================================
// 放货前预检登录态：提前 30 分钟检查，过期提前通知
// 比等到 9:55 开页才发现过期更早，给你时间重新登录
// ============================================================
async function handlePrecheckLogin(cfg) {
  if (!cfg.glm.enabled) return;
  const now = new Date();
  const restock = new Date(now);
  restock.setHours(cfg.glm.restockHour, cfg.glm.restockMinute, 0, 0);
  const precheckStart = restock.getTime() - SCHEDULE.PRECHECK_MIN * 60 * 1000;
  const precheckEnd = restock.getTime() - cfg.glm.prepMinutes * 60 * 1000; // 到开页窗口就停（开页后会自然检测）

  // 只在预检窗口内（放货前30分 ~ 前5分）执行，且每天只通知一次
  if (now.getTime() < precheckStart || now.getTime() > precheckEnd) return;

  // 预检窗口内才执行，且每天只通知一次（flag 读写放进 updateState，避免与套餐上报并发覆盖）
  const todayKey = `precheck_${now.getMonth()}_${now.getDate()}`;
  // 原子声明本次预检（置 'checking'），已被声明过则跳过
  const claimed = await updateState(state => {
    if (state[todayKey]) return undefined; // 今天已预检过，放弃
    state[todayKey] = 'checking';
    return state;
  });
  if (claimed === undefined) return; // 已预检过

  // 静默访问 GLM 页面检查登录态
  try {
    const tab = await chrome.tabs.create({ url: GLM.PAGE_URL, active: false });
    // 等 6 秒让页面加载
    await new Promise(r => setTimeout(r, 6000));
    // 向 content script 要当前状态（如果 content 上报了 logged_out 说明失效）
    // 这里简单处理：检查 tab 是否被重定向到登录页
    const tabInfo = await chrome.tabs.get(tab.id).catch(() => null);
    let loginOk = true;
    if (tabInfo && tabInfo.url && /login|signin/i.test(tabInfo.url)) {
      loginOk = false;
    }
    try { await chrome.tabs.remove(tab.id); } catch (e) {}

    if (!loginOk) {
      await updateState(state => { state[todayKey] = 'expired'; return state; });
      await pushLog('warn', `GLM 预检：登录已过期（提前${SCHEDULE.PRECHECK_MIN}分钟发现）`, { front: true });
      await pushNotify(cfg, '⚠️【GLM登录过期-预检】', `距放货还有约${SCHEDULE.PRECHECK_MIN}分钟，检测到登录已失效！请尽快重新登录智谱`, GLM.PAGE_URL);
      await desktopNotify('⚠️ GLM 登录过期', `距放货还有约${SCHEDULE.PRECHECK_MIN}分钟，请尽快重新登录`);
    } else {
      await updateState(state => { state[todayKey] = 'ok'; return state; });
      await pushLog('info', `GLM 预检：登录态正常`, { front: true });
    }
  } catch (e) {
    // 异常时清掉 'checking' 标记，下次心跳可重试（否则当天预检被永久阻塞）
    await updateState(state => { if (state[todayKey] === 'checking') delete state[todayKey]; return state; });
    await pushLog('warn', `GLM 预检失败: ${e.message}`, { front: true });
  }
}

// ============================================================
// GLM 放货窗口管理：自动开页 / 关页
// ============================================================
async function handleGlmWindow(cfg) {
  if (!cfg.glm.enabled) return;

  const now = new Date();
  const inBurst = isInGlmBurstWindow(cfg, now);

  // 读 glmTabId（纯读，不进锁；写操作才需 updateState 串行）
  const state0 = await getState();
  let glmTabId = state0.glmTabId ?? null;

  // 进入高频准备窗口 -> 自动打开 GLM 页面
  if (inBurst && cfg.glm.autoOpenPage) {
    // 检查是否已打开
    let alreadyOpen = false;
    let needLoginCheck = false;
    if (glmTabId) {
      try {
        const tab = await chrome.tabs.get(glmTabId);
        if (tab && tab.url && tab.url.includes('bigmodel.cn/glm-coding')) {
          alreadyOpen = true;
        }
      } catch (e) {
        // tab 已关闭
      }
    }
    if (!alreadyOpen) {
      try {
        const tab = await chrome.tabs.create({ url: GLM.PAGE_URL, active: false });
        await updateState(state => { state.glmTabId = tab.id; state.glmLoginChecked = false; state.glmLastReload = 0; state.glmBurstTimerStarted = false; return state; });
        await pushLog('info', `已自动打开 GLM 监控页（tab ${tab.id}），进入放货窗口`, { front: true });
        await pushNotify(cfg, '【GLM监控启动】', `已打开 GLM 页面，准备监控 ${cfg.glm.restockHour}:${String(cfg.glm.restockMinute).padStart(2,'0')} 放货`, GLM.PAGE_URL);
      } catch (e) {
        await pushLog('error', `自动打开 GLM 页面失败: ${e.message}`, { front: true });
      }
    } else {
      // 页面已开：确认登录态（仅首次）
      if (!state0.glmLoginChecked) {
        await checkGlmTabLogin(cfg, glmTabId);
      }
      // 启动秒级刷新定时器（仅启动一次，靠 glmBurstTimerStarted 去重）
      // 9:59-10:05 每 5 秒刷新一次；10:00:00 强制刷新，确保放货瞬间抓到
      if (!state0.glmBurstTimerStarted) {
        await startGlmBurstReload(cfg, glmTabId);
      }
    }
  }

  // 离开放货窗口超过 autoCloseMinutes -> 自动关闭页面
  if (!inBurst && glmTabId) {
    const restock = new Date(now);
    restock.setHours(cfg.glm.restockHour, cfg.glm.restockMinute, 0, 0);
    const closeAfter = restock.getTime() + cfg.glm.autoCloseMinutes * 60 * 1000;
    if (now.getTime() > closeAfter) {
      try {
        await chrome.tabs.remove(glmTabId);
        await pushLog('info', `放货窗口结束，已自动关闭 GLM 监控页`, { front: true });
      } catch (e) { /* tab 可能已关 */ }
      await updateState(state => { state.glmTabId = null; return state; });
    }
  }
}

// ============================================================
// 放货窗口秒级刷新 GLM 页面（突破 MV3 alarms 最小 1 分钟限制）
// 用 setTimeout：放货时刻精确刷新一次 + 放货后每 3 秒刷新持续到 burstEnd
// 前提：放货窗口内 GLM 页面常开，tab 活跃会保活 SW，setTimeout 可持续运行
// ============================================================
async function startGlmBurstReload(cfg, tabId) {
  await updateState(state => { state.glmBurstTimerStarted = true; return state; });
  await pushLog('info', '放货窗口：启动秒级刷新定时器', { front: true });

  const restockTs = (() => {
    const r = new Date();
    r.setHours(cfg.glm.restockHour, cfg.glm.restockMinute, 0, 0);
    return r.getTime();
  })();
  const burstEnd = restockTs + SCHEDULE.GLM_BURST_AFTER_MIN * 60 * 1000;

  // 阶段1：放货时刻精确刷新（核心！10:00:00 那一刻刷新，秒级抢购靠这个）
  const msToRestock = restockTs - Date.now();
  if (msToRestock > 0) {
    setTimeout(async () => {
      try {
        await chrome.tabs.reload(tabId);
        await pushLog('success', `【放货时刻】已精确刷新 GLM 页面`, { front: true });
      } catch (e) { /* tab 可能已关 */ }
    }, msToRestock);
    await pushLog('info', `已排定放货时刻精确刷新（${Math.round(msToRestock/1000)}秒后）`, { front: true });
  }

  // 阶段2：放货后每 3 秒刷新一次，持续到 burstEnd（抓放货后状态变化）
  // 放货前不频繁刷新（页面一直售罄，刷了也没用，还给服务器压力）
  const POST_RELOAD_INTERVAL = 3000;
  const postTick = async () => {
    const now = Date.now();
    if (now > burstEnd) {
      await pushLog('info', '放货窗口秒级刷新结束');
      return;
    }
    // 只在放货时刻之后才刷新
    if (now >= restockTs) {
      try {
        await chrome.tabs.reload(tabId);
      } catch (e) { /* tab 可能已关 */ }
    }
    setTimeout(postTick, POST_RELOAD_INTERVAL);
  };
  // 从放货时刻前 10 秒开始轮询，确保放货后第一时间刷新
  const postStart = Math.max(0, msToRestock - 10000);
  setTimeout(postTick, postStart);
}

// ============================================================
// 检查已打开的 GLM tab 登录态（放货窗口主动确认，留痕）
// 覆盖 content-glm 未注入（被重定向到登录页）导致 background 收不到信号的情况
// ============================================================
async function checkGlmTabLogin(cfg, tabId) {
  try {
    // 若 content-glm 已上报失效（glmLogin=logged_out），不再重复检查/推送
    const st = await getState();
    if (st.glmLogin === 'logged_out') {
      await updateState(state => { state.glmLoginChecked = true; return state; });
      return;
    }
    // 页面刚开/刷新需要时间加载，等 6 秒再查 URL 是否被重定向到登录页
    await new Promise(r => setTimeout(r, 6000));
    const tabInfo = await chrome.tabs.get(tabId).catch(() => null);
    let loginOk = true;
    if (!tabInfo || (tabInfo.url && /login|signin/i.test(tabInfo.url))) {
      loginOk = false;
    }
    await updateState(state => { state.glmLoginChecked = true; return state; });

    if (!loginOk) {
      await pushLog('warn', 'GLM 放货窗口：检测到登录已失效（开页确认）', { front: true });
      await pushNotify(cfg, '⚠️【GLM登录过期】', '放货窗口已开，但检测到登录已失效！请立即重新登录智谱，否则无法监控放货', GLM.PAGE_URL);
      await desktopNotify('⚠️ GLM 登录过期', '放货窗口检测到登录失效，请立即重新登录智谱');
    } else {
      await pushLog('info', 'GLM 放货窗口：开页确认登录态正常', { front: true });
    }
  } catch (e) {
    await pushLog('warn', `GLM 放货窗口登录态检查失败: ${e.message}`, { front: true });
  }
}

// ============================================================
// Kimi 后台 fetch ListGoods
// ============================================================
async function fetchKimiGoods(cfg) {
  let res, body;
  try {
    res = await fetch(KIMI.LIST_GOODS_API, {
      method: 'POST',
      credentials: 'include',   // 自动带浏览器 cookie
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    body = await res.text();
  } catch (e) {
    await pushLog('error', `Kimi fetch 网络错误: ${e.message}`, { front: true });
    return;
  }

  const ct = res.headers.get('content-type') || '';

  // 登录态健康检查
  if (!isLoginOk(res.status, ct, body)) {
    await handleKimiLoginExpired(cfg);
    return;
  }

  let data;
  try {
    data = JSON.parse(body);
  } catch (e) {
    await pushLog('error', `Kimi 响应非 JSON: ${body.slice(0, 200)}`, { front: true });
    return;
  }

  const goods = data.goods || [];
  const newStatus = classifyKimiGoods(goods);

  // 原始 reason 记到后台 console（不进日志环，避免刷屏）
  const debugReasons = {};
  for (const g of goods) {
    if (KIMI.PLANS.includes(g.title)) {
      const key = `${g.title}(${g.billingCycle?.timeUnit === 'TIME_UNIT_YEAR' ? '年' : '月'})`;
      debugReasons[key] = g.transitionSummary?.reason || '(无)';
    }
  }
  console.debug('[TSM] Kimi reasons:', JSON.stringify(debugReasons));

  // 原子读-改-写：比对 + 写入串行化，避免与 GLM 上报并发覆盖
  const toNotify = [];
  const statusChanges = [];  // [{plan, from, to}] 复盘用
  let wasFirstCheck = false;
  await updateState(state => {
    const prev = state.kimi || {};
    const first = Object.keys(prev).length === 0 || !prev.__initialized;
    wasFirstCheck = first;

    for (const [plan, info] of Object.entries(newStatus)) {
      if (!cfg.kimi.targets[plan]) continue; // 未勾选监控
      const prevInfo = prev[plan];
      const nowAvailable = info.status === STATUS.AVAILABLE;

      // 记录状态变化（复盘用）
      if (!first && prevInfo && prevInfo.status !== info.status) {
        statusChanges.push({ plan, from: prevInfo.status, to: info.status });
      }

      if (first) continue; // 首次只建基线，不通知

      // 只有明确从候补变为可购买才通知
      const wasWaiting = prevInfo?.status === STATUS.WAITLISTED;
      if (wasWaiting && nowAvailable) {
        toNotify.push(plan);
      }
    }

    state.kimi = { ...newStatus, __initialized: true };
    state.kimiLogin = 'logged_in';
    state.lastKimiCheck = Date.now();
    return state;
  });

  // 记录 Kimi 状态变化（复盘关键）
  const kimiStatusLabel = { waitlisted: '候补中', available: '✅开放', subscribed: '已订阅', unknown: '未知' };
  if (wasFirstCheck) {
    const summary = Object.entries(newStatus).map(([p, i]) => `${p}=${kimiStatusLabel[i.status] || i.status}`).join('，');
    await pushLog('info', `Kimi 首次检查：${summary}`, { front: true });
  } else {
    for (const c of statusChanges) {
      await pushLog('info', `Kimi ${c.plan} 状态变化：${kimiStatusLabel[c.from] || c.from} -> ${kimiStatusLabel[c.to] || c.to}`, { front: true });
    }
  }

  // 写完 state 再发通知（通知不阻塞 state 写入，也避免在 updater 里做重操作）
  for (const plan of toNotify) {
    await notifyKimiOpen(cfg, plan);
  }
  if (!wasFirstCheck && statusChanges.length === 0) {
    const summary = Object.entries(newStatus).map(([p, i]) => `${p}=${kimiStatusLabel[i.status] || i.status}`).join('，');
    await pushLog('info', `Kimi 检查完成：${summary}`, { front: true });
  }
}

async function handleKimiLoginExpired(cfg) {
  // 在 updater 内捕获 wasLoggedIn，写回后据其决定是否通知
  let wasLoggedIn = false;
  await updateState(state => {
    wasLoggedIn = state.kimiLogin !== 'logged_out';
    state.kimiLogin = 'logged_out';
    return state;
  });
  if (wasLoggedIn) {
    await pushLog('warn', `Kimi 登录态失效`, { front: true });
    await pushNotify(cfg, '⚠️【Kimi登录过期】', '请重新登录 Kimi，否则无法监控订阅开放', KIMI.PAGE_URL);
    await desktopNotify('⚠️ Kimi 登录过期', '请重新登录 Kimi，否则无法监控订阅开放');
  }
}

async function notifyKimiOpen(cfg, plan) {
  const title = `【Kimi开放】${plan} 套餐已对你开放订阅！`;
  const body = `点开立即购买 -> ${KIMI.PAGE_URL}`;
  await pushLog('success', `Kimi ${plan} 开放订阅！`, { front: true });
  await pushNotify(cfg, title, body, KIMI.PAGE_URL);
  await desktopNotify(title, body);
}

// ============================================================
// GLM 状态变化处理（来自 content-glm.js 的消息）
// ============================================================
async function handleGlmStateChanged(cfg, payload) {
  const { planKey, status, buttonText, restockText, account } = payload;

  // 账户信息上报：存到 state，不触发通知
  if (planKey === '_account' && account) {
    let firstAccount = false;
    await updateState(state => {
      state.glm = state.glm || {};
      firstAccount = !state.glmAccount;
      state.glmAccount = account.name || '';
      state.glmLogin = 'logged_in';
      return state;
    });
    if (firstAccount) {
      await pushLog('info', `GLM 账户：${account.name || '(未知)'}（登录态正常）`);
    }
    return;
  }

  // 登录失效 / 页面异常：单独处理，发通知，不涉及套餐库存判断
  if (planKey === '_login' || status === STATUS.LOGGED_OUT) {
    let wasLoggedIn = false;
    await updateState(state => {
      state.glm = state.glm || {};
      wasLoggedIn = state.glmLogin !== 'logged_out';
      state.glmLogin = 'logged_out';
      state.glm['_login'] = { status, text: buttonText, lastSeen: Date.now() };
      return state;
    });
    if (wasLoggedIn) {
      await pushLog('warn', `GLM 登录态失效，已通知用户`, { front: true });
      await pushNotify(cfg, '⚠️【GLM登录过期】', '检测到登录已失效！请尽快重新登录智谱，否则无法监控放货', GLM.PAGE_URL);
      await desktopNotify('⚠️ GLM 登录过期', '请尽快重新登录智谱，否则无法监控放货');
    }
    return;
  }

  if (planKey === '_page_state') {
    await pushLog('warn', `GLM 页面异常: ${buttonText}`, { front: true });
    return;
  }

  // 正常套餐状态变化：原子读-改-写（关键！多个套餐几乎同时上报，
  // 必须串行化，否则各自读同一份旧 state 后互相覆盖，只留最后一个）
  let shouldNotify = false;
  let prevStatus = null;
  let isFirstSeen = false;
  await updateState(state => {
    state.glm = state.glm || {};
    const prev = state.glm[planKey];
    prevStatus = prev?.status || null;
    isFirstSeen = !prev;
    const wasSoldOut = prev?.status === STATUS.SOLD_OUT || prev?.status === STATUS.BUSY || !prev;
    const nowAvailable = status === STATUS.AVAILABLE;

    // 先存状态（不管是否勾选，都要存+显示）
    state.glm[planKey] = { status, text: buttonText, restockAt: restockText, lastSeen: Date.now() };
    state.glmLogin = 'logged_in';

    // 售罄/繁忙 -> 可购买：标记通知（仅勾选的套餐才通知），通知在 updater 外发
    shouldNotify = wasSoldOut && nowAvailable && cfg.glm.targets[planKey];
    return state;
  });

  const name = GLM.PLAN_NAMES[planKey] || planKey;
  const statusLabel = { sold_out: '售罄', busy: '繁忙', available: '✅可购买', unknown: '未知' }[status] || status;

  // 记录每次状态变化（复盘关键！能看到几点几分扫到什么状态）
  if (isFirstSeen) {
    await pushLog('info', `GLM ${name} 首次扫描：${statusLabel}${restockText ? `（${restockText}补货）` : ''} | 按钮: ${buttonText}`, { front: true });
  } else if (prevStatus !== status) {
    const prevLabel = { sold_out: '售罄', busy: '繁忙', available: '可购买', unknown: '未知' }[prevStatus] || prevStatus;
    await pushLog('info', `GLM ${name} 状态变化：${prevLabel} -> ${statusLabel} | 按钮: ${buttonText}`, { front: true });
  }

  if (shouldNotify) {
    const title = `【GLM放货】${name} 套餐已可购买！`;
    const body = restockText ? `${restockText} 补货已到，立即抢` : '套餐已可购买，立即抢';
    await pushLog('success', `GLM ${name} 放货！${body}`, { front: true });
    await pushNotify(cfg, title, body, GLM.PAGE_URL);
    await desktopNotify(title, body);
  }
}

// ============================================================
// GLM 立即检查：打开/复用 GLM 页面，触发 content script 扫描
// ============================================================
async function checkGlmNow(cfg, sendResponse) {
  try {
    // 查找已打开的 GLM tab
    const tabs = await chrome.tabs.query({ url: '*://*.bigmodel.cn/glm-coding*' });
    let tab = tabs[0];

    if (!tab) {
      // 没有打开，新建一个（前台打开，方便看到）
      tab = await chrome.tabs.create({ url: GLM.PAGE_URL, active: true });
      await pushLog('info', `GLM 立即检查：已打开 GLM 页面，等待加载后自动扫描`, { front: true });
      // 页面加载后 content-glm.js 会自动扫描，记录 tab id
      await updateState(state => { state.glmTabId = tab.id; return state; });
      sendResponse({ ok: true, msg: '已打开 GLM 页面，加载后自动扫描' });
      return;
    }

    // 已有 tab，刷新并触发扫描
    await chrome.tabs.reload(tab.id);
    await pushLog('info', `GLM 立即检查：已刷新 GLM 页面，等待扫描结果`, { front: true });
    sendResponse({ ok: true, msg: '已刷新 GLM 页面，扫描结果稍后更新' });
  } catch (e) {
    await pushLog('error', `GLM 立即检查失败: ${e.message}`, { front: true });
    sendResponse({ ok: false, error: e.message });
  }
}

// ============================================================
// 消息处理
// ============================================================
function handleMessage(msg, sender, sendResponse) {
  (async () => {
    try {
      const cfg = await getConfig();
      switch (msg.type) {
        case MSG.GLM_STATE_CHANGED:
          await handleGlmStateChanged(cfg, msg.payload);
          sendResponse({ ok: true });
          break;

        case MSG.GLM_GET_CONFIG:
          // content-glm.js 启动时拉取配置
          sendResponse({ ok: true, config: cfg });
          break;

        case MSG.KIMI_CHECK_NOW:
          // popup 手动触发立即检查
          await fetchKimiGoods(cfg);
          sendResponse({ ok: true });
          break;

        case MSG.GLM_CHECK_NOW:
          // popup 手动触发 GLM 立即检查：打开/复用 GLM 页面并触发扫描
          await checkGlmNow(cfg, sendResponse);
          return; // checkGlmNow 内部异步 sendResponse

        case MSG.GET_STATE:
          sendResponse({ ok: true, state: await getState() });
          break;

        case MSG.TEST_BARK: {
          const ok = await pushNotify(cfg, '【测试】TokenStockMonitor', '推送测试成功！如果你看到这条消息，说明企业微信配置正常。');
          sendResponse({ ok });
          break;
        }

        case MSG.UPDATE_CONFIG: {
          const oldCfg = await getConfig();
          const oldInterval = oldCfg.kimi?.fetchIntervalMin ?? 10;
          await setConfig(msg.config);
          // Kimi 检查间隔变了，重建 alarm 让新间隔立即生效
          if ((msg.config.kimi?.fetchIntervalMin ?? 10) !== oldInterval) {
            await rescheduleKimi(msg.config);
          }
          await pushLog('info', '配置已更新');
          sendResponse({ ok: true });
          break;
        }

        default:
          sendResponse({ ok: false, error: 'unknown msg type' });
      }
    } catch (e) {
      console.error('[TSM] handleMessage error:', e);
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // 异步响应
}
