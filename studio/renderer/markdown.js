/* Reach Studio — minimal, XSS-safe markdown renderer.
 *
 * Escape-first: every character of input is HTML-escaped before any markdown
 * transform runs, so model output can never inject markup. Supported:
 *   fenced code blocks (```), inline code, **bold**, *italic*, # h1-h3,
 *   - lists, 1. lists, [links](https://…), paragraphs.
 * Exposed as window.ReachMarkdown.render(text) -> html string.
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function inline(s) {
    // inline code first (protect from further transforms)
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (_m, c) => {
      codes.push(c);
      return '\x00' + (codes.length - 1) + '\x00';
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/\x00(\d+)\x00/g, (_m, i) => '<code>' + codes[Number(i)] + '</code>');
    return s;
  }

  function render(text) {
    const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let inCode = false, codeBuf = [], listType = null;
    const closeList = () => {
      if (listType) { out.push(listType === 'ul' ? '</ul>' : '</ol>'); listType = null; }
    };
    const flushPara = (buf) => {
      if (buf.length) out.push('<p>' + inline(buf.join(' ')) + '</p>');
      return [];
    };
    let para = [];
    for (const line of lines) {
      const fence = /^```(\w*)\s*$/.exec(line);
      if (fence) {
        if (inCode) {
          out.push('<pre class="md-code"><button class="md-copy" type="button">copy</button><code>' + codeBuf.map(esc).join('\n') + '</code></pre>');
          codeBuf = []; inCode = false;
        } else {
          para = flushPara(para); closeList();
          inCode = true;
        }
        continue;
      }
      if (inCode) { codeBuf.push(line); continue; }

      const h = /^(#{1,3})\s+(.*)$/.exec(line);
      if (h) {
        para = flushPara(para); closeList();
        const level = h[1].length;
        out.push('<h' + (level + 1) + ' class="md-h">' + inline(h[2]) + '</h' + (level + 1) + '>');
        continue;
      }
      const ul = /^\s*[-*]\s+(.*)$/.exec(line);
      if (ul) {
        para = flushPara(para);
        if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
        out.push('<li>' + inline(ul[1]) + '</li>');
        continue;
      }
      const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
      if (ol) {
        para = flushPara(para);
        if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
        out.push('<li>' + inline(ol[1]) + '</li>');
        continue;
      }
      if (!line.trim()) { para = flushPara(para); closeList(); continue; }
      para.push(line);
    }
    if (inCode && codeBuf.length) {
      out.push('<pre class="md-code"><code>' + codeBuf.map(esc).join('\n') + '</code></pre>');
    }
    flushPara(para); closeList();
    return out.join('\n');
  }

  // Copy buttons inside rendered markdown.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('.md-copy');
    if (!btn) return;
    const code = btn.parentElement && btn.parentElement.querySelector('code');
    if (code) {
      navigator.clipboard.writeText(code.textContent || '');
      btn.textContent = 'copied';
      setTimeout(() => { btn.textContent = 'copy'; }, 1200);
    }
  });

  window.ReachMarkdown = { render };
})();
