(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const out = { screens: {}, checks: [] };
  // 图/bp、套/set 是有意保留的中文别名示例；Mag Prime 一套 是卡片副标题里的「对照名」
  const ALLOW = ['图/bp', '套/set', 'Mag Prime 一套'];

  const collect = (name) => {
    const list = (window.WFMi18nEngine?.collectCJK() || []).filter((x) => !ALLOW.some((a) => x.includes(a)));
    out.screens[name] = list;
  };

  for (let i = 0; i < 60; i += 1) {
    if ($('#btn-add')) break;
    await sleep(250);
  }
  await sleep(600);

  // 1. 中文下的空状态（作为对照，应为中文）
  out.zhEmptyCount = (window.WFMi18nEngine?.collectCJK() || []).length;
  collect('zh-empty');

  // 2. 通过设置页真实路径切到英文
  $('.tab[data-tab="settings"]').click();
  await sleep(500);
  const langSel = $('#s-ui-lang');
  langSel.value = 'en';
  langSel.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(1600);
  out.checks.push(['lang switched', S.lang === 'en']);
  out.checks.push(['html lang', document.documentElement.getAttribute('lang') === 'en']);
  out.checks.push(['title localized', /Market Monitor/.test(document.title)]);

  // 3. 英文空状态
  $('.tab[data-tab="detail"]').click();
  await sleep(500);
  collect('en-empty');

  // 4. 新建监控 → 保存 → 提示
  $('#btn-add').click();
  await sleep(500);
  const s = $('#m-search');
  s.value = 'mag prime';
  s.dispatchEvent(new Event('input'));
  for (let i = 0; i < 40; i += 1) {
    await sleep(200);
    if ($$('#m-results .result').length) break;
  }
  $$('#m-results .result')[0].click();
  await sleep(1200);
  const price = $('#f-price');
  if (price) { price.value = '60'; price.dispatchEvent(new Event('input', { bubbles: true })); }
  $('#m-save').click();
  await sleep(1800);
  out.checks.push(['monitor created', (S.targets || []).length === 1]);
  collect('en-after-create');

  // 5. 删除确认框（改成应用内弹窗后应可读）
  const del = $('#btn-del');
  if (del) {
    del.click();
    await sleep(600);
    const dlg = $('.dlg');
    out.dialogText = dlg ? dlg.innerText.replace(/\n+/g, ' | ') : '';
    collect('en-delete-dialog');
    const dangerBtn = dlg ? [...dlg.querySelectorAll('.dlg-btns button')].find((b) => /Delete/i.test(b.textContent)) : null;
    if (dangerBtn) dangerBtn.click();
    await sleep(1200);
  }
  out.checks.push(['monitor deleted', (S.targets || []).length === 0]);
  collect('en-after-delete');

  // 6. 其它标签页
  $('.tab[data-tab="events"]').click();
  await sleep(500);
  collect('en-events');
  $('.tab[data-tab="diag"]').click();
  await sleep(500);
  collect('en-diag');
  $('.tab[data-tab="settings"]').click();
  await sleep(600);
  collect('en-settings');

  // 汇总
  out.totalLeftover = Object.values(out.screens).reduce((n, arr) => n + arr.length, 0);
  return out;
})();
