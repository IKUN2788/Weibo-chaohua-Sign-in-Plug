(() => {
  const UI = {
    loginStatus: document.getElementById('loginStatus'),
    enableDaily: document.getElementById('enableDaily'),
    dailyTime: document.getElementById('dailyTime'),
    saveSettingsBtn: document.getElementById('saveSettingsBtn'),
    nextRunText: document.getElementById('nextRunText'),
    openLoginBtn: document.getElementById('openLoginBtn'),
    checkLoginBtn: document.getElementById('checkLoginBtn'),
    clearStorageBtn: document.getElementById('clearStorageBtn'),
    autoCheckinBtn: document.getElementById('autoCheckinBtn'),
    analyzeBtn: document.getElementById('analyzeBtn'),
    stopBtn: document.getElementById('stopBtn'),
    progress: document.getElementById('progress'),
    topicsTableBody: document.querySelector('#topicsTable tbody'),
    log: document.getElementById('log'),
    statTotal: document.getElementById('statTotal'),
    statChecked: document.getElementById('statChecked'),
    statNew: document.getElementById('statNew'),
    statFailed: document.getElementById('statFailed'),
    statRate: document.getElementById('statRate'),
    previewNote: document.getElementById('previewNote'),
  };

  const isExtension = typeof chrome !== 'undefined' && !!chrome.tabs;
  const isPreview = !isExtension;
  if (isPreview) {
    UI.previewNote.hidden = false;
  }

  let loginSuccess = false;
  let running = false;
  let analyzing = false;

  let totalTopics = 0;
  let checkedInBefore = 0;
  let newlyCheckedIn = 0;
  let failedCheckin = 0;

  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'MWeibo-Pwa': '1',
    'Referer': 'https://m.weibo.cn/p/tabbar?containerid=100803_-_recentvisit&page_type=tabbar',
    'User-Agent': navigator.userAgent,
  };

  function ts() {
    const d = new Date();
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
  }

  function log(msg) {
    UI.log.value += `[${ts()}] ${msg}\n`;
    UI.log.scrollTop = UI.log.scrollHeight;
  }

  function setLoginStatus(text, cls) {
    UI.loginStatus.textContent = text;
    UI.loginStatus.className = `status ${cls}`;
  }

  // Storage helpers
  async function storageGet(keys) {
    if (isExtension) {
      return new Promise(resolve => chrome.storage.local.get(keys, resolve));
    }
    const obj = {};
    (Array.isArray(keys) ? keys : [keys]).forEach(k => {
      const v = localStorage.getItem(k);
      obj[k] = v ? JSON.parse(v) : undefined;
    });
    return obj;
  }

  async function storageSet(obj) {
    if (isExtension) {
      return new Promise(resolve => chrome.storage.local.set(obj, resolve));
    }
    Object.entries(obj).forEach(([k, v]) => {
      localStorage.setItem(k, JSON.stringify(v));
    });
  }

  function toNextRunMs(timeStr) {
    const [hh, mm] = (timeStr || '09:00').split(':').map(n => parseInt(n, 10));
    const now = new Date();
    const target = new Date();
    target.setHours(hh, mm, 0, 0);
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
    return target.getTime();
  }

  function updateStats() {
    UI.statTotal.textContent = String(totalTopics);
    UI.statChecked.textContent = String(checkedInBefore);
    UI.statNew.textContent = String(newlyCheckedIn);
    UI.statFailed.textContent = String(failedCheckin);
    const rate = ((checkedInBefore + newlyCheckedIn) / Math.max(totalTopics, 1)) * 100;
    UI.statRate.textContent = `${rate.toFixed(1)}%`;
  }

  function clearTable() {
    UI.topicsTableBody.innerHTML = '';
  }

  function addRow(name, status, level, action) {
    const tr = document.createElement('tr');
    [name, status, level || '', action || ''].forEach(text => {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    });
    UI.topicsTableBody.appendChild(tr);
  }

  async function openLoginPage() {
    const loginUrl = 'https://passport.weibo.com/sso/signin?entry=wapsso&source=wapssowb&url=' +
      encodeURIComponent('https://m.weibo.cn/p/tabbar?containerid=100803_-_recentvisit');
    if (isExtension) {
      chrome.tabs.create({ url: loginUrl });
    } else {
      window.open(loginUrl, '_blank');
    }
    log('请在新打开的页面完成登录后，返回并点击“检查登录”。');
  }

  async function checkLogin() {
    setLoginStatus('检查中...', 'status-warn');
    log('正在检查登录状态...');
    try {
      if (isPreview) {
        await new Promise(r => setTimeout(r, 300));
        loginSuccess = true;
        setLoginStatus('登录有效（预览）', 'status-good');
        log('预览模式：模拟已登录。');
        return;
      }

      const resp = await fetch('https://m.weibo.cn/api/config', {
        credentials: 'include',
        headers,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (data && data.data && data.data.login) {
        loginSuccess = true;
        setLoginStatus('登录有效', 'status-good');
        log('Cookies验证成功，已登录。');
      } else {
        setLoginStatus('未登录', 'status-bad');
        log('尚未登录，请在登录页面完成登录后再试。');
      }
    } catch (e) {
      setLoginStatus('检查失败', 'status-bad');
      log(`检查登录状态出错：${e.message}`);
    }
  }

  async function getSupertopicList() {
    if (!loginSuccess && !isPreview) {
      log('请先完成登录。');
      return null;
    }

    if (isPreview) {
      await new Promise(r => setTimeout(r, 200));
      return {
        ok: 1,
        data: {
          cards: [
            {
              card_group: [
                {
                  title_sub: '示例超话A',
                  desc1: 'LV.5 今日可签到',
                  buttons: [
                    { name: '签到', scheme: '/api/container/button?containerid=100803&extparam=foo' }
                  ]
                },
                {
                  title_sub: '示例超话B',
                  desc1: 'LV.8 今日已签到',
                  buttons: [
                    { name: '已签到' }
                  ]
                }
              ]
            }
          ],
          cardlistInfo: { total_pages: 1, total_cards: 2 }
        }
      };
    }

    const allCards = [];
    let pageCount = 1;
    let sinceId = undefined;
    try {
      while (running || analyzing) {
        const params = new URLSearchParams({ containerid: '100803_-_followsuper' });
        if (sinceId) params.set('since_id', sinceId);

        log(`正在获取第${pageCount}页超话数据...`);
        const url = `https://m.weibo.cn/api/container/getIndex?${params.toString()}`;
        const resp = await fetch(url, { credentials: 'include', headers });
        if (!resp.ok) {
          log(`获取第${pageCount}页失败，状态码：${resp.status}`);
          break;
        }
        const data = await resp.json();
        if (data.ok !== 1) {
          log(`第${pageCount}页获取失败：${data.msg || '未知错误'}`);
          break;
        }
        const cards = data?.data?.cards || [];
        allCards.push(...cards);
        log(`第${pageCount}页获取成功，包含${cards.length}个卡片`);
        const info = data?.data?.cardlistInfo || {};
        sinceId = info.since_id;
        if (!sinceId) {
          log('since_id为空，已到达最后一页');
          break;
        }
        pageCount += 1;
        await new Promise(r => setTimeout(r, 300));
      }
    } catch (e) {
      log(`获取超话列表失败：${e.message}`);
      return null;
    }

    if (allCards.length) {
      log(`总共获取了${pageCount}页数据，包含${allCards.length}个卡片`);
      return { ok: 1, data: { cards: allCards, cardlistInfo: { total_pages: pageCount, total_cards: allCards.length } } };
    }
    log('没有获取到任何超话数据');
    return null;
  }

  async function performCheckin(topicName, scheme) {
    try {
      if (!scheme || !scheme.startsWith('/api/container/button')) return false;
      if (isPreview) {
        await new Promise(r => setTimeout(r, 300));
        return true; // 预览直接视为成功
      }
      if (isExtension) {
        const res = await new Promise(resolve => {
          chrome.runtime.sendMessage({ type: 'pagePerformCheckin', scheme }, r => resolve(r || {}));
        });
        return !!res.ok;
      }
      // 备用：直接发起请求（预览或非扩展环境）
      const fullUrl = `https://m.weibo.cn${scheme}`;
      const resp = await fetch(fullUrl, { credentials: 'include' });
      if (!resp.ok) return false;
      const result = await resp.json();
      return result?.ok === 1;
    } catch (e) {
      return false;
    }
  }

  async function startAutoCheckin() {
    if (!loginSuccess && !isPreview) {
      alert('请先登录后再进行签到操作！');
      return;
    }
    running = true;
    UI.autoCheckinBtn.disabled = true;
    UI.stopBtn.disabled = false;
    UI.progress.classList.remove('hidden');
    clearTable();
    totalTopics = 0; checkedInBefore = 0; newlyCheckedIn = 0; failedCheckin = 0; updateStats();
    log('=== 开始自动签到 ===');

    const data = await getSupertopicList();
    if (!data) { log('获取超话列表失败'); finishRun(); return; }

    const cards = data?.data?.cards || [];
    for (const card of cards) {
      if (!running) break;
      const groups = card?.card_group || [];
      for (const item of groups) {
        if (!running) break;
        if (!item?.title_sub || !item?.buttons) continue;
        totalTopics += 1;
        const topicName = item.title_sub;
        const desc1 = item.desc1 || '';
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
            log(`✓ ${topicName} - 今日已签到`);
            break;
          }
        }

        let actionResult = '';
        if (canCheckin && checkinScheme) {
          const success = await performCheckin(topicName, checkinScheme);
          if (success) {
            newlyCheckedIn += 1;
            actionResult = '签到成功';
            log(`✓ ${topicName} - 签到成功`);
          } else {
            failedCheckin += 1;
            actionResult = '签到失败';
            log(`✗ ${topicName} - 签到失败`);
          }
          await new Promise(r => setTimeout(r, 500));
        } else if (buttonStatus === '已签到') {
          actionResult = '已签到';
        } else {
          actionResult = '无需签到';
        }

        addRow(topicName, buttonStatus, desc1, actionResult);
        updateStats();
      }
    }

    log('=== 签到完成统计 ===');
    log(`总共关注超话：${totalTopics}个`);
    log(`之前已签到：${checkedInBefore}个`);
    log(`本次新签到：${newlyCheckedIn}个`);
    log(`签到失败：${failedCheckin}个`);
    const completionRate = ((checkedInBefore + newlyCheckedIn) / Math.max(totalTopics, 1)) * 100;
    log(`总签到完成率：${completionRate.toFixed(1)}%`);
    finishRun();
  }

  async function analyzeStatus() {
    if (!loginSuccess && !isPreview) {
      alert('请先登录后再进行分析操作！');
      return;
    }
    analyzing = true;
    UI.analyzeBtn.disabled = true;
    UI.stopBtn.disabled = false;
    UI.progress.classList.remove('hidden');
    clearTable();
    totalTopics = 0; checkedInBefore = 0; newlyCheckedIn = 0; failedCheckin = 0; updateStats();
    log('开始分析超话签到状态...');

    const data = await getSupertopicList();
    if (!data) { log('获取超话列表失败'); finishAnalyze(); return; }

    let total = 0, checked = 0, can = 0;
    const cards = data?.data?.cards || [];
    for (const card of cards) {
      if (!analyzing) break;
      const groups = card?.card_group || [];
      for (const item of groups) {
        if (!analyzing) break;
        if (!item?.title_sub || !item?.buttons) continue;
        total += 1;
        const topicName = item.title_sub;
        const desc1 = item.desc1 || '';
        let buttonStatus = '未知';
        for (const btn of item.buttons) {
          const name = btn?.name || '';
          if (name === '签到') { buttonStatus = '可签到'; can += 1; break; }
          else if (name === '已签到' || name.includes('已签')) { buttonStatus = '已签到'; checked += 1; break; }
          else if (name === '明日再来') { buttonStatus = '今日已签到'; checked += 1; break; }
        }
        addRow(topicName, buttonStatus, desc1, '分析完成');
      }
    }
    totalTopics = total; checkedInBefore = checked; newlyCheckedIn = 0; failedCheckin = 0; updateStats();
    const completionRate = (checked / Math.max(total, 1)) * 100;
    log('=== 超话签到状态分析 ===');
    log(`总共关注超话：${total}个`);
    log(`今日已签到：${checked}个`);
    log(`可以签到：${can}个`);
    log(`签到完成率：${completionRate.toFixed(1)}%`);
    finishAnalyze();
  }

  function finishRun() {
    running = false;
    UI.autoCheckinBtn.disabled = false;
    UI.stopBtn.disabled = true;
    UI.progress.classList.add('hidden');
  }

  function finishAnalyze() {
    analyzing = false;
    UI.analyzeBtn.disabled = false;
    UI.stopBtn.disabled = true;
    UI.progress.classList.add('hidden');
  }

  function stopAll() {
    running = false;
    analyzing = false;
    UI.stopBtn.disabled = true;
    UI.progress.classList.add('hidden');
    log('用户停止了当前操作');
  }

  function clearStorage() {
    try {
      localStorage.clear();
      log('已清除本地缓存（localStorage）');
    } catch {}
  }

  // Settings UI
  async function loadSettingsUI() {
    if (isPreview) {
      UI.enableDaily.checked = true;
      UI.dailyTime.value = '09:00';
      const nextMs = toNextRunMs(UI.dailyTime.value);
      UI.nextRunText.textContent = new Date(nextMs).toLocaleString();
      return;
    }
    const { settings, nextRun } = await new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'getSettings' }, (res) => resolve(res || {}));
    });
    const s = settings || { enableDaily: false, dailyTime: '09:00' };
    UI.enableDaily.checked = !!s.enableDaily;
    UI.dailyTime.value = s.dailyTime || '09:00';
    UI.nextRunText.textContent = nextRun ? new Date(nextRun).toLocaleString() : '未设置';
  }

  async function saveSettings() {
    const settings = { enableDaily: UI.enableDaily.checked, dailyTime: UI.dailyTime.value || '09:00' };
    await storageSet({ settings });
    if (isPreview) {
      const nextMs = toNextRunMs(settings.dailyTime);
      UI.nextRunText.textContent = new Date(nextMs).toLocaleString();
      log('预览模式：已保存设置（本地），不会真正创建闹钟。');
      return;
    }
    const res = await new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'updateSchedule', settings }, (r) => resolve(r || {}));
    });
    if (res.ok) {
      const { nextRun } = await new Promise(resolve => {
        chrome.runtime.sendMessage({ type: 'getSettings' }, (r) => resolve(r || {}));
      });
      UI.nextRunText.textContent = nextRun ? new Date(nextRun).toLocaleString() : '未设置';
      log('已保存每日自动签到设置并更新闹钟。');
    } else {
      log('保存设置失败：' + (res.error || 'unknown'));
    }
  }

  // Event bindings
  UI.openLoginBtn.addEventListener('click', openLoginPage);
  UI.checkLoginBtn.addEventListener('click', checkLogin);
  UI.clearStorageBtn.addEventListener('click', clearStorage);
  UI.autoCheckinBtn.addEventListener('click', startAutoCheckin);
  UI.analyzeBtn.addEventListener('click', analyzeStatus);
  UI.stopBtn.addEventListener('click', stopAll);
  UI.saveSettingsBtn.addEventListener('click', saveSettings);

  // Initial
  setLoginStatus('未登录', 'status-bad');
  updateStats();
  loadSettingsUI();
})();