/**
 * 渲染层 i18n：DOM 自动翻译
 * 思路：界面源码保持中文原文，渲染后按「中文原文 -> 英文」词典翻译文本节点与提示属性。
 * 好处：不必在 250+ 处调用点插函数，漏翻也能通过 collectCJK() 一次性扫出来。
 */
(function () {
  const lib = window.WFMI18N;
  if (!lib) return;

  let lang = 'zh';
  let observer = null;
  const ATTRS = ['placeholder', 'title', 'aria-label'];
  const CJK = /[\u4e00-\u9fa5]/;
  // 记录原文，切回中文时把静态节点还原（index.html 里的文字不会被重绘覆盖）
  const textOriginals = new Map();
  const attrOriginals = new Map();

  function translateString(s) {
    if (!CJK.test(s)) return null;
    const out = lib.translate(s, lang);
    return out === s ? null : out;
  }

  function walkText(node) {
    const raw = node.nodeValue;
    if (!raw || !CJK.test(raw)) return;
    const trimmed = raw.trim();
    const out = lib.translate(trimmed, lang);
    if (out === trimmed) return;
    if (!textOriginals.has(node)) textOriginals.set(node, raw);
    node.nodeValue = raw.replace(trimmed, out);
  }

  function walkAttrs(el) {
    for (const attr of ATTRS) {
      const v = el.getAttribute && el.getAttribute(attr);
      if (!v || !CJK.test(v)) continue;
      const out = translateString(v);
      if (out) {
        const rec = attrOriginals.get(el) || {};
        if (!(attr in rec)) rec[attr] = v;
        attrOriginals.set(el, rec);
        el.setAttribute(attr, out);
      }
    }
  }

  /** 把翻译过的节点还原成中文原文 */
  function restore() {
    for (const [node, raw] of textOriginals) {
      try {
        if (node && node.isConnected) node.nodeValue = raw;
      } catch (_) {}
    }
    textOriginals.clear();
    for (const [el, rec] of attrOriginals) {
      try {
        if (el && el.isConnected) for (const [a, v] of Object.entries(rec)) el.setAttribute(a, v);
      } catch (_) {}
    }
    attrOriginals.clear();
  }

  function walk(node) {
    if (!node) return;
    if (node.nodeType === 3) {
      walkText(node);
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;
    if (node.hasAttribute && node.hasAttribute('data-no-i18n')) return;
    walkAttrs(node);
    const kids = node.childNodes;
    for (let i = 0; i < kids.length; i += 1) walk(kids[i]);
  }

  function apply(root) {
    if (lang === 'zh') return;
    walk(root || document.body);
  }

  function startObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver((muts) => {
      if (lang === 'zh') return;
      for (const m of muts) {
        if (m.type === 'childList') {
          for (const n of m.addedNodes) walk(n);
        } else if (m.type === 'characterData') {
          walk(m.target);
        } else if (m.type === 'attributes' && m.attributeName) {
          const el = m.target;
          if (el.nodeType === 1) walkAttrs(el);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  function setLang(next) {
    const target = next === 'en' ? 'en' : 'zh';
    if (target === 'zh' && lang === 'en') restore();
    lang = target;
    document.documentElement.setAttribute('lang', lang === 'en' ? 'en' : 'zh-CN');
  }

  /** 扫描当前 DOM 里还残留的中文（调试用：确认没有漏翻） */
  function collectCJK() {
    const out = new Set();
    const scan = (node) => {
      if (node.nodeType === 3) {
        const t = node.nodeValue.trim();
        if (t && CJK.test(t)) out.add(t);
        return;
      }
      if (node.nodeType !== 1) return;
      if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(node.tagName)) return;
      for (const a of ATTRS) {
        const v = node.getAttribute && node.getAttribute(a);
        if (v && CJK.test(v)) out.add(`@${a}: ${v}`);
      }
      for (const c of node.childNodes) scan(c);
    };
    scan(document.body);
    return [...out];
  }

  window.WFMi18nEngine = { setLang, apply, collectCJK, getLang: () => lang, startObserver };
})();
