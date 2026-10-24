'use strict';

/** 异常分类验证：错误代理 / 错误域名，检查错误种类与建议是否可读 */

const path = require('path');
const fs = require('fs');
const { App } = require('../src/core/app');

const dataDir = path.join(__dirname, '..', '_tmp', 'udata-err');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

(async () => {
  const app = new App({ dataDir, hooks: { showDesktop: async () => {} } });
  await app.init();
  app.saveSettings({ global: { proxyUrl: 'http://127.0.0.1:9' }, network: { retries: 0, timeoutMs: 6000 } });

  try {
    await app.client.request('/v2/items/ash_prime_set', { retries: 0, timeoutMs: 6000 });
    console.log('❌ 预期失败但成功了');
  } catch (e) {
    const j = e.toJSON ? e.toJSON() : { kind: 'unknown', message: e.message, advice: '' };
    console.log('kind    :', j.kind);
    console.log('message :', j.message);
    console.log('advice  :', j.advice);
    const ok = j.kind === 'proxy';
    console.log(ok ? '✅ 代理故障被正确识别' : '⚠️ 分类为 ' + j.kind);
  }

  const d = await app.diagnose();
  console.log('\n自检汇总:', d.summary);
  d.results.forEach((r) => console.log(` ${r.ok ? '✓' : '✗'} ${r.step}: ${r.detail}`));

  await app.shutdown();
  process.exit(0);
})();
