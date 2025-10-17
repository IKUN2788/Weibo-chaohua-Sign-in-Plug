// 背景脚本：定时与补签逻辑
(function() {
  const ALARM_NAME = 'dailyCheckin';
  const STORAGE_KEYS = {
    settings: 'settings', // { enableDaily: boolean, dailyTime: 'HH:MM' }
    lastRunDate: 'lastRunDate', // 'YYYY-MM-DD'
    lastResult: 'lastResult', // { ts, totalTopics, checkedInBefore, newlyCheckedIn, failedCheckin }
  };

  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'MWeibo-Pwa': '1',
    'Referer': 'https://m.weibo.cn/p/tabbar?containerid=100803_-_recentvisit&page_type=tabbar',
    'User-Agent': typeof navigator !== 'undefined' ? navigator.userAgent : 'Mozilla/5.0',
  };
  const WEIBO_TAB_URL = 'https://m.weibo.cn/p/tabbar?containerid=100803_-_recentvisit';

  function fmtDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function parseTimeToNextMs(timeStr) {
    // timeStr: 'HH:MM' 本地时区
    const [hh, mm] = (timeStr || '09:00').split(':').map(n => parseInt(n, 10));
    const now = new Date();
    const target = new Date();
    target.setHours(hh, mm, 0, 0);
    if (target.getTime() <= now.getTime()) {
      // 明天
      target.setDate(target.getDate() + 1);
    }
    return target.getTime();
  }

  async function getFromStorage(key) {
    return new Promise(resolve => chrome.storage.local.get([key], items => resolve(items[key])));
  }

  async function setInStorage(obj) {
    return new Promise(resolve => chrome.storage.local.set(obj, resolve));
  }

  async function loadSettings() {
    const s = await getFromStorage(STORAGE_KEYS.settings);
    return s || { enableDaily: false, dailyTime: '09:00' };
  }

  async function setupAlarm() {
    const settings = await loadSettings();
    await chrome.alarms.clear(ALARM_NAME);
    if (settings.enableDaily) {
      const when = parseTimeToNextMs(settings.dailyTime);
      chrome.alarms.create(ALARM_NAME, { when, periodInMinutes: 24 * 60 });
      await setInStorage({ nextRun: when });
    } else {
      await setInStorage({ nextRun: null });
    }
  }

  async function checkLogin() {
    try {
      const resp = await fetch('https://m.weibo.cn/api/config', { credentials: 'include', headers });
      if (!resp.ok) return false;
      const data = await resp.json();
      return !!(data && data.data && data.data.login);
    } catch (e) {
      return false;
    }
  }

  async function getSupertopicList() {
    const allCards = [];
    let pageCount = 1;
    let sinceId = undefined;
    try {
      while (true) {
        const params = new URLSearchParams({ containerid: '100803_-_followsuper' });
        if (sinceId) params.set('since_id', sinceId);
        const url = `https://m.weibo.cn/api/container/getIndex?${params.toString()}`;
        const resp = await fetch(url, { credentials: 'include', headers });
        if (!resp.ok) break;
        const data = await resp.json();
        if (data.ok !== 1) break;
        const cards = data?.data?.cards || [];
        allCards.push(...cards);
        const info = data?.data?.cardlistInfo || {};
        sinceId = info.since_id;
        if (!sinceId) break;
        pageCount += 1;
        await new Promise(r => setTimeout(r, 300));
      }
    } catch (e) {
      return null;
    }
    if (allCards.length) {
      return { ok: 1, data: { cards: allCards, cardlistInfo: { total_pages: pageCount, total_cards: allCards.length } } };
    }
    return null;
  }

  // 在页面上下文中执行代码，确保请求携带页面的 Cookie/Referer/Sec-Fetch 等头部
  async function ensureWeiboTab() {
    const tabs = await chrome.tabs.query({ url: 'https://m.weibo.cn/*' });
    if (tabs && tabs.length > 0) return tabs[0].id;
    const tab = await chrome.tabs.create({ url: WEIBO_TAB_URL, active: false });
    return tab.id;
  }

  async function execInWeibo(tabId, func, args = []) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func,
      args,
    });
    return results && results[0] ? results[0].result : null;
  }

  async function pagePerformCheckin(scheme) {
    const tabId = await ensureWeiboTab();
    const result = await execInWeibo(tabId, async (s) => {
      try {
        const resp = await fetch(`https://m.weibo.cn${s}`, { credentials: 'include' });
        const data = await resp.json();
        if (data && data.ok === 1) {
          return { ok: true };
        }
        return { ok: false, data };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }, [scheme]);
    return result;
  }

  async function performCheckin(topicName, scheme) {
    try {
      if (!scheme || !scheme.startsWith('/api/container/button')) return false;
      const result = await pagePerformCheckin(scheme);
      return !!(result && result.ok);
    } catch (e) {
      return false;
    }
  }

  async function autoCheckin() {
    const ok = await checkLogin();
    if (!ok) {
      await setInStorage({ lastResult: { ts: Date.now(), error: 'not_logged_in' } });
      return false;
    }
    let totalTopics = 0;
    let checkedInBefore = 0;
    let newlyCheckedIn = 0;
    let failedCheckin = 0;
    const data = await getSupertopicList();
    if (!data) {
      await setInStorage({ lastResult: { ts: Date.now(), error: 'list_failed' } });
      return false;
    }
    const cards = data?.data?.cards || [];
    for (const card of cards) {
      const groups = card?.card_group || [];
      for (const item of groups) {
        if (!item?.title_sub || !item?.buttons) continue;
        totalTopics += 1;
        const topicName = item.title_sub;
        let canCheckin = false;
        let checkinScheme = '';
        let buttonStatus = '未知';
        for (const btn of item.buttons) {
          const name = btn?.name || '';
          if (name === '签到') {
            canCheckin = true;
            checkinScheme = btn?.scheme || '';
            buttonStatus = '可签到';
            break;
          } else if (['已签', '已签到', '明日再来'].includes(name)) {
            checkedInBefore += 1;
            buttonStatus = '已签到';
            break;
          }
        }
        if (canCheckin && checkinScheme) {
          const success = await performCheckin(topicName, checkinScheme);
          if (success) newlyCheckedIn += 1; else failedCheckin += 1;
          await new Promise(r => setTimeout(r, 400));
        }
      }
    }
    const lastRunDate = fmtDate(new Date());
    await setInStorage({
      [STORAGE_KEYS.lastRunDate]: lastRunDate,
      lastResult: {
        ts: Date.now(),
        totalTopics, checkedInBefore, newlyCheckedIn, failedCheckin,
      }
    });
    return true;
  }

  async function checkMakeup() {
    const settings = await loadSettings();
    if (!settings.enableDaily) return;
    const todayStr = fmtDate(new Date());
    const lastRunDate = await getFromStorage(STORAGE_KEYS.lastRunDate);
    const nextRunMs = parseTimeToNextMs(settings.dailyTime);
    const now = Date.now();
    // 如果今天的计划时间已过，并且今天没有跑过，则补签
    const targetToday = (() => {
      const [hh, mm] = settings.dailyTime.split(':').map(n => parseInt(n, 10));
      const d = new Date(); d.setHours(hh, mm, 0, 0); return d.getTime();
    })();
    if ((!lastRunDate || lastRunDate !== todayStr) && now > targetToday) {
      await autoCheckin();
    }
    // 重置闹钟到下一次
    await setupAlarm();
  }

  // 消息交互
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        if (msg?.type === 'updateSchedule') {
          await setInStorage({ [STORAGE_KEYS.settings]: msg.settings });
          await setupAlarm();
          sendResponse({ ok: true });
        } else if (msg?.type === 'getSettings') {
          const s = await loadSettings();
          const nextRun = await getFromStorage('nextRun');
          sendResponse({ ok: true, settings: s, nextRun });
        } else if (msg?.type === 'runCheckinNow') {
          const ok = await autoCheckin();
          sendResponse({ ok });
        } else if (msg?.type === 'pagePerformCheckin') {
          const { scheme } = msg;
          const result = await pagePerformCheckin(scheme);
          sendResponse(result || { ok: false });
        } else if (msg?.type === 'getLastResult') {
          const r = await getFromStorage('lastResult');
          sendResponse({ ok: true, result: r });
        } else {
          sendResponse({ ok: false, error: 'unknown_message' });
        }
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true; // async
  });

  // 闹钟触发
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm && alarm.name === ALARM_NAME) {
      await autoCheckin();
      await setupAlarm(); // 更新下一次
    }
  });

  // 启动与首次安装时的补签检查
  chrome.runtime.onStartup.addListener(() => { checkMakeup(); });
  chrome.runtime.onInstalled.addListener(() => { checkMakeup(); });
})();