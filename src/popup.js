// popup.js - 配置面板逻辑

const STATUS_LABEL = {
  sold_out: '售罄', busy: '繁忙', available: '✅可购买', unknown: '未知',
  waitlisted: '候补中', subscribed: '已订阅', logged_out: '登录失效', no_cards: '页面异常'
};

// ============================================================
// 加载配置与状态
// ============================================================
async function loadAll() {
  // popup 是普通脚本（非 module），通过消息 + storage 拿配置和状态
  const cfg = await getConfigViaMsg();
  const state = await getStateViaMsg();
  renderConfig(cfg);
  renderStatus(state);
  renderLog();
}

async function getConfigViaMsg() {
  return new Promise((resolve) => {
    chrome.storage.local.get('tsm_config', (obj) => {
      const saved = obj.tsm_config || {};
      const def = {
        enabled: true, wecomKey: '', notifyChannel: 'wecom',
        glm: { enabled: true, targets: { lite: false, pro: true, max: false }, restockHour: 10, restockMinute: 0, prepMinutes: 5, autoOpenPage: true },
        kimi: { enabled: true, targets: { Andante: true, Moderato: true, Allegretto: true, Allegro: true } }
      };
      resolve({
        ...def, ...saved,
        glm: { ...def.glm, ...(saved.glm || {}) },
        kimi: { ...def.kimi, ...(saved.kimi || {}) }
      });
    });
  });
}

async function getStateViaMsg() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'get_state' }, (resp) => {
      resolve(resp?.state || {});
    });
  });
}

// ============================================================
// 渲染配置
// ============================================================
function renderConfig(cfg) {
  $('#enabled').checked = cfg.enabled;
  $('#wecomKey').value = cfg.wecomKey || '';
  $('#glmEnabled').checked = cfg.glm.enabled;
  $('#kimiEnabled').checked = cfg.kimi.enabled;

  const restock = `${String(cfg.glm.restockHour || 10).padStart(2,'0')}:${String(cfg.glm.restockMinute || 0).padStart(2,'0')}`;
  $('#glmRestock').value = restock;
  $('#glmPrep').value = cfg.glm.prepMinutes ?? 5;

  document.querySelectorAll('.glm-target').forEach(el => {
    el.checked = !!cfg.glm.targets[el.dataset.plan];
  });
  document.querySelectorAll('.kimi-target').forEach(el => {
    el.checked = !!cfg.kimi.targets[el.dataset.plan];
  });
  $('#kimiInterval').value = cfg.kimi.fetchIntervalMin ?? 10;
}

// ============================================================
// 渲染状态
// ============================================================
function renderStatus(state) {
  // GLM 登录状态 + 账户信息
  const glmLoginEl = $('#glmLogin');
  if (state.glmLogin === 'logged_out') {
    glmLoginEl.className = 'login-status bad';
    glmLoginEl.textContent = '登录已失效，请重新登录智谱';
  } else if (state.glmLogin === 'logged_in') {
    glmLoginEl.className = 'login-status ok';
    glmLoginEl.textContent = state.glmAccount ? `已登录：${state.glmAccount}` : '已登录';
  } else {
    glmLoginEl.className = 'login-status unknown';
    glmLoginEl.textContent = '登录状态：未知（点立即检查）';
  }

  // GLM 套餐状态
  const glmEl = $('#glmStatus');
  const glmLines = [];
  for (const [plan, info] of Object.entries(state.glm || {})) {
    if (plan.startsWith('_')) continue;
    const label = STATUS_LABEL[info.status] || info.status;
    const restock = info.restockAt ? ` (${info.restockAt}补货)` : '';
    glmLines.push(`${plan}: ${label}${restock}`);
  }
  glmEl.className = 'status';
  glmEl.textContent = glmLines.length ? glmLines.join(' | ') : '尚无数据（放货窗口自动开页检查）';

  // Kimi 登录状态
  const kimiLoginEl = $('#kimiLogin');
  if (state.kimiLogin === 'logged_out') {
    kimiLoginEl.className = 'login-status bad';
    kimiLoginEl.textContent = '登录已失效，请重新登录 Kimi';
  } else if (state.kimiLogin === 'logged_in') {
    kimiLoginEl.className = 'login-status ok';
    kimiLoginEl.textContent = '已登录';
  } else {
    kimiLoginEl.className = 'login-status unknown';
    kimiLoginEl.textContent = '登录状态：未知（点立即检查）';
  }

  // Kimi 套餐状态
  const kimiEl = $('#kimiStatus');
  const kimiLines = [];
  for (const [plan, info] of Object.entries(state.kimi || {})) {
    if (plan.startsWith('_')) continue;  // 跳过内部标记字段
    const label = STATUS_LABEL[info.status] || info.status;
    kimiLines.push(`${plan}: ${label}`);
  }
  const last = state.lastKimiCheck ? `上次检查: ${new Date(state.lastKimiCheck).toLocaleTimeString()}` : '';
  kimiEl.className = 'status';
  kimiEl.textContent = (kimiLines.length ? kimiLines.join(' | ') : '尚无数据') + (last ? `\n${last}` : '');
}

// ============================================================
// 渲染日志
// ============================================================
async function renderLog() {
  chrome.storage.local.get('tsm_log', (obj) => {
    // 前端只显示关键日志（front=true）；旧日志无 front 字段，按关键日志显示
    const log = (obj.tsm_log || []).filter(e => e.front !== false);
    const el = $('#log');
    if (!log.length) { el.innerHTML = '<div class="entry"><span class="t">暂无关键日志</span></div>'; return; }
    el.innerHTML = log.slice(0, 30).map(e => {
      const t = new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false });
      return `<div class="entry"><span class="t">${t}</span><span class="lvl-${e.level}">${e.msg}</span></div>`;
    }).join('');
  });
}

// ============================================================
// 保存配置
// ============================================================
async function saveConfig() {
  const cfg = await getConfigViaMsg();
  cfg.enabled = $('#enabled').checked;
  cfg.wecomKey = $('#wecomKey').value.trim();
  cfg.glm.enabled = $('#glmEnabled').checked;
  cfg.kimi.enabled = $('#kimiEnabled').checked;

  const [h, m] = $('#glmRestock').value.split(':').map(Number);
  cfg.glm.restockHour = h || 10;
  cfg.glm.restockMinute = m || 0;
  cfg.glm.prepMinutes = parseInt($('#glmPrep').value) || 5;
  cfg.kimi.fetchIntervalMin = Math.max(1, parseInt($('#kimiInterval').value) || 10);

  document.querySelectorAll('.glm-target').forEach(el => {
    cfg.glm.targets[el.dataset.plan] = el.checked;
  });
  document.querySelectorAll('.kimi-target').forEach(el => {
    cfg.kimi.targets[el.dataset.plan] = el.checked;
  });

  chrome.runtime.sendMessage({ type: 'update_config', config: cfg }, (resp) => {
    flashHint($('#barkResult'), '已保存', 'ok');
  });
}

// ============================================================
// 事件绑定
// ============================================================
function flashHint(el, text, cls) {
  el.textContent = text;
  el.className = 'hint ' + (cls || '');
  setTimeout(() => { el.textContent = ''; }, 2000);
}

function $(sel) { return document.querySelector(sel); }

document.addEventListener('DOMContentLoaded', () => {
  loadAll();

  $('#testBark').addEventListener('click', () => {
    // 先保存再测试
    saveConfig().then(() => {
      chrome.runtime.sendMessage({ type: 'test_bark' }, (resp) => {
        if (resp?.ok) flashHint($('#barkResult'), '✅ 推送成功，查看企业微信群', 'ok');
        else flashHint($('#barkResult'), '❌ 推送失败，检查 Key', 'fail');
      });
    });
  });

  $('#kimiCheckNow').addEventListener('click', () => {
    $('#kimiStatus').textContent = '检查中…';
    chrome.runtime.sendMessage({ type: 'kimi_check_now' }, () => {
      setTimeout(loadAll, 1500);
    });
  });

  $('#glmCheckNow').addEventListener('click', () => {
    $('#glmStatus').textContent = '检查中…（打开/刷新 GLM 页面）';
    chrome.runtime.sendMessage({ type: 'glm_check_now' }, (resp) => {
      // GLM 靠页面 DOM，扫描结果要等页面加载，延迟刷新
      setTimeout(loadAll, 4000);
    });
  });

  // 任意配置变更即保存
  ['enabled', 'wecomKey', 'glmEnabled', 'kimiEnabled', 'glmRestock', 'glmPrep', 'kimiInterval'].forEach(id => {
    $('#' + id).addEventListener('change', saveConfig);
  });
  document.querySelectorAll('.glm-target, .kimi-target').forEach(el => {
    el.addEventListener('change', saveConfig);
  });

  // 每 5 秒刷新状态（popup 打开时）
  setInterval(() => { getStateViaMsg().then(renderStatus); renderLog(); }, 5000);
});
