'use strict';

/**
 * 远程指令解析
 * 只认白名单里的动词，避免正文里随便一句话被当成命令。
 */

const COMMANDS = [
  { id: 'check', re: /^(全部检查|检查|查一下|刷新|check|checkall|check all|refresh|run)$/i },
  { id: 'status', re: /^(状态|行情|汇总|status|report|list)$/i },
  { id: 'help', re: /^(帮助|指令|命令|help|commands|\?|？)$/i },
];

/** 去掉常见前缀/标点，避免「检查。」「#检查」这类匹配不上 */
function normalizeLine(line) {
  return String(line || '')
    .replace(/^[\s>#*\-·•]+/, '')
    .replace(/[\s。！!？?，,、；;：:]+$/g, '')
    // 「检查一下」「check please」这类口语尾缀去掉再匹配
    .replace(/(一下|下|吧|啦|呀|谢谢|thanks|please)[\s。！!？?，,]*$/i, '')
    .replace(/^["'「『【\[]+|["'」』】\]]+$/g, '')
    .trim();
}

/**
 * @param {string} text 邮件正文（已去掉口令）
 * @returns {{id:string, raw:string}|null}
 */
function parseCommand(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(normalizeLine)
    .filter(Boolean);
  for (const line of lines) {
    // 只取前 40 个字符做匹配，避免超长正文误判
    const probe = line.slice(0, 40);
    for (const c of COMMANDS) {
      if (c.re.test(probe)) return { id: c.id, raw: line };
    }
  }
  return null;
}

const HELP_ZH = [
  '可用指令（写在邮件正文里，一封一封处理）：',
  '  检查 / check       触发一次全部检查，并返回所有目标的价格汇总',
  '  状态 / status      只读，返回当前所有目标的价格与达标情况',
  '  帮助 / help        显示这条说明',
  '',
  '说明：',
  '  · 无达标时也会回复汇总，不会静默',
  '  · 已停用的目标不参与检查，但会列在汇总里',
].join('\n');

const HELP_EN = [
  'Available commands (put one per email, in the body):',
  '  check         Run a full check and reply with a price summary',
  '  status        Read-only snapshot of all monitors',
  '  help          Show this message',
  '',
  'Notes:',
  '  · A summary is always returned, even when nothing hit the target',
  '  · Disabled monitors are skipped by checks but still listed',
].join('\n');

function helpText(lang) {
  return lang === 'en' ? HELP_EN : HELP_ZH;
}

module.exports = { parseCommand, helpText, normalizeLine, COMMANDS };
