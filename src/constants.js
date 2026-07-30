// constants.js - 常量定义：接口URL、套餐配置、状态判断规则、存储key
// 所有判断逻辑均经真实登录态样本验证

// ============================================================
// 存储键
// ============================================================
export const STORAGE_KEYS = {
  CONFIG: 'tsm_config',
  STATE: 'tsm_state',
  LOG: 'tsm_log'
};

// ============================================================
// 默认配置
// ============================================================
export const DEFAULT_CONFIG = {
  enabled: true,
  // 通知渠道：wecom = 企业微信群机器人
  notifyChannel: 'wecom',
  wecomKey: '',                         // 企业微信群机器人 webhook key（https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=XXX 中的 XXX）
  barkKey: '',                          // Bark 推送 key（备选，留空不用）
  barkServer: 'https://api.day.app',    // Bark 服务器地址（自建可改）
  glm: {
    enabled: true,
    targets: { lite: false, pro: true, max: false },   // 监控哪些套餐
    autoOpenPage: true,                 // 放货窗口前自动打开 GLM 页面
    autoCloseMinutes: 10,              // 放货后多少分钟自动关页面（10:00 + 10 = 10:10）
    restockHour: 10,                    // 放货时间-小时
    restockMinute: 0,                   // 放货时间-分钟
    prepMinutes: 5,                     // 提前几分钟打开页面/进入高频
    scanNormalSec: 10,                  // 平时页面扫描间隔（秒），过快可能触发风控
    scanBurstSec: 3                     // 放货窗口页面扫描间隔（秒），过快可能触发风控
  },
  kimi: {
    enabled: true,
    targets: { Andante: true, Moderato: true, Allegretto: true, Allegro: true },
    fetchIntervalMin: 10                 // 后台检查间隔（分钟），MV3 alarms 最小 1 分钟
  }
};

// ============================================================
// GLM 配置（来自 glmhelp 源码 + 真实样本验证）
// 真实样本：按钮 "暂时售罄 ｜07月30日 10:00 补货" [disabled]
// ============================================================
export const GLM = {
  PAGE_URL: 'https://bigmodel.cn/glm-coding',

  // 套餐卡片按钮选择器（nth-child: 1=Lite, 2=Pro, 3=Max）
  BTN_SELECTOR: (n) => `.glm-coding-package-list > div:nth-child(${n}) > div > .package-card-btn-box > button`,
  PLAN_INDEX: { lite: 1, pro: 2, max: 3 },
  PLAN_NAMES: { lite: 'Lite', pro: 'Pro', max: 'Max' },

  // 按钮状态判断正则（glmhelp 验证过）
  SOLD_OUT_RE: /售罄|补货|暂时/,
  BUSY_RE: /抢购人数过多|请刷新/,
  PURCHASABLE_TEXTS: ['特惠订阅', '立即订阅', '立即购买', '购买'],

  // 补货时间提取：如 "07月30日 10:00 补货"
  RESTOCK_RE: /(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/
};

// ============================================================
// Kimi 配置（本次实测摸到）
// 接口：POST https://www.kimi.com/apiv2/kimi.gateway.order.v1.GoodsService/ListGoods
// 真实样本：付费套餐 transitionSummary.reason = "REASON_SUBSCRIPTION_APPLYING"（候补中）
// ============================================================
export const KIMI = {
  PAGE_URL: 'https://www.kimi.com/code?from=membership',
  LIST_GOODS_API: 'https://www.kimi.com/apiv2/kimi.gateway.order.v1.GoodsService/ListGoods',

  // 候补/未开放的 reason 值（实测：REASON_SUBSCRIPTION_NEED_APPLY）
  // 凡 reason 以 REASON_SUBSCRIPTION_ 开头且非明确可购买，都算候补中
  WAITLIST_REASON_PREFIX: 'REASON_SUBSCRIPTION_',

  // 付费套餐（排除 Adagio 免费档）
  PLANS: ['Andante', 'Moderato', 'Allegretto', 'Allegro']
};

// ============================================================
// 调度间隔
// ============================================================
export const SCHEDULE = {
  HEARTBEAT_MIN: 1,         // SW 心跳，每分钟
  KIMI_FETCH_MIN: 10,       // Kimi 后台 fetch 间隔（分钟）
  GLM_NORMAL_SEC: 10,       // GLM 页面内扫描间隔-平时（秒）
  GLM_BURST_SEC: 3,         // GLM 页面内扫描间隔-放货窗口（秒）
  GLM_BURST_AFTER_MIN: 5,   // 放货后高频窗口持续时长（分钟）：9:55-10:05
  GLM_FETCH_RETRY_MS: 5000, // 登录失效重试间隔
  KEEPALIVE_MIN: 30,        // 登录态保活间隔：每30分钟静默访问一次（分钟）
  PRECHECK_MIN: 30          // 放货前预检登录态：提前30分钟（分钟）
};

// ============================================================
// 状态枚举
// ============================================================
export const STATUS = {
  SOLD_OUT: 'sold_out',
  BUSY: 'busy',
  AVAILABLE: 'available',
  UNKNOWN: 'unknown',
  WAITLISTED: 'waitlisted',
  SUBSCRIBED: 'subscribed',
  LOGGED_OUT: 'logged_out',
  NO_CARDS: 'no_cards'
};

// ============================================================
// 消息类型（content <-> background）
// ============================================================
export const MSG = {
  GLM_STATE_CHANGED: 'glm_state_changed',
  GLM_GET_CONFIG: 'glm_get_config',
  GLM_CHECK_NOW: 'glm_check_now',
  KIMI_CHECK_NOW: 'kimi_check_now',
  GET_STATE: 'get_state',
  TEST_BARK: 'test_bark',
  UPDATE_CONFIG: 'update_config'
};
