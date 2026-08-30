// ============================================================
//  KAIRON AI PANEL — v2.0
//  Conversation history, streaming feel, lightweight markdown,
//  page-context awareness, keyboard-first UX.
// ============================================================

// ── LIGHTWEIGHT MARKDOWN ─────────────────────────────────────
function _md(text) {
  // SECURITY: Escape HTML entities in the entire input FIRST so that any
  // user/API-controlled text is neutralized before markdown syntax is applied.
  // Markdown syntax chars (*, #, [, etc.) are unaffected by HTML escaping,
  // so regex matching still works.  Generated HTML elements (<strong>, <a>,
  // etc.) are safe because they come from our regex replacements, not from
  // untrusted input.
  const safe = _escHtml(text);

  return safe
    // Code blocks (must come before inline code)
    .replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) =>
      `<pre style="background:var(--ai-code-bg);border:1px solid var(--ai-code-border);border-radius:8px;padding:10px 12px;overflow-x:auto;font-family:var(--font-mono);font-size:11.5px;line-height:1.6;margin:6px 0"><code>${code.trim()}</code></pre>`
    )
    // Inline code
    .replace(/`([^`]+)`/g, (_, c) =>
      `<code style="background:var(--ai-inline-code-bg);border-radius:4px;padding:1px 5px;font-family:var(--font-mono);font-size:11.5px">${c}</code>`
    )
    // Links — reject URLs containing double-quote (appears as &amp;quot; after
    // escaping) which could break out of the href attribute.  The https?://
    // regex already blocks javascript:/data: protocols.
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g,
      (_, linkText, url) => {
        if (/&quot;/.test(url)) return linkText;
        return `<a href="${url}" style="color:var(--text-accent);text-decoration:none;border-bottom:1px solid var(--ai-link-underline)" target="_blank" rel="noopener">${linkText}</a>`;
      }
    )
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Unordered list items
    .replace(/^[\*\-] (.+)$/gm, '<li style="margin-left:14px;margin-top:3px">$1</li>')
    // Numbered list items
    .replace(/^\d+\. (.+)$/gm, '<li style="margin-left:14px;margin-top:3px">$1</li>')
    // Headings h3/h2/h1
    .replace(/^### (.+)$/gm, '<p style="font-size:13px;font-weight:700;color:var(--text-primary);margin:10px 0 4px">$1</p>')
    .replace(/^## (.+)$/gm,  '<p style="font-size:14px;font-weight:700;color:var(--text-primary);margin:12px 0 5px">$1</p>')
    .replace(/^# (.+)$/gm,   '<p style="font-size:15px;font-weight:700;color:var(--text-primary);margin:14px 0 6px">$1</p>')
    // Horizontal rule
    .replace(/^---$/gm, '<hr style="border:none;border-top:1px solid var(--ai-hr-border);margin:12px 0"/>')
    // Line breaks → paragraph breaks
    .replace(/\n\n/g, '</p><p style="margin-top:6px">')
    .replace(/\n/g, '<br/>');
}

function _escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── AI ICONS ─────────────────────────────────────────────────
const AVATAR_AI = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none">
  <circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1"/>
  <circle cx="6" cy="6" r="2" fill="currentColor"/>
</svg>`;

const AVATAR_USER = 'U';

// ── TYPING INDICATOR ─────────────────────────────────────────
const TYPING_HTML = `
  <span style="display:inline-flex;gap:4px;align-items:center;padding:2px 0">
    <span style="width:5px;height:5px;border-radius:50%;background:var(--text-tertiary);animation:aiDot 1.2s 0s ease-in-out infinite"></span>
    <span style="width:5px;height:5px;border-radius:50%;background:var(--text-tertiary);animation:aiDot 1.2s 0.2s ease-in-out infinite"></span>
    <span style="width:5px;height:5px;border-radius:50%;background:var(--text-tertiary);animation:aiDot 1.2s 0.4s ease-in-out infinite"></span>
  </span>`;

// Inject typing keyframe once
(function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
    @keyframes aiDot {
      0%, 80%, 100% { opacity: 0.2; transform: scale(0.85); }
      40%            { opacity: 1;   transform: scale(1.1);  }
    }
  `;
  document.head.appendChild(style);
})();

// ── SUGGESTED PROMPTS ────────────────────────────────────────
const SUGGESTED_PROMPTS = [
  'Summarize this page',
  'Find key facts here',
  'Explain this to me simply',
  'What are the main points?',
];

// ── MAIN EXPORT ──────────────────────────────────────────────
export function initAiPanel(kairon) {
  const messagesEl = document.getElementById('messages');
  const chatInput  = document.getElementById('chat-input');
  const btnSend    = document.getElementById('btn-send');

  // ── CONVERSATION STATE ──────────────────────────────────────
  // history = [{ role: 'user'|'assistant', content: string }]
  let history = [];
  let isStreaming = false;

  // ── WELCOME STATE ────────────────────────────────────────────
  function _renderWelcome() {
    messagesEl.innerHTML = `
      <div style="
        flex:1;
        display:flex;
        flex-direction:column;
        align-items:center;
        justify-content:center;
        padding:32px 20px;
        gap:20px;
        text-align:center;
      ">
        <div style="
            width:48px;height:48px;border-radius:50%;
            background:var(--ai-welcome-avatar-bg);
            border:1px solid var(--ai-welcome-avatar-border);
            display:flex;align-items:center;justify-content:center;
          ">
            ${AVATAR_AI}
          </div>
        <div>
          <p style="font-size:14px;font-weight:600;color:var(--text-primary);margin-bottom:6px">Kairon AI</p>
          <p style="font-size:12px;color:var(--text-tertiary);line-height:1.6;max-width:220px">
            Ask anything about this page, or start a conversation.
          </p>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;width:100%">
          ${SUGGESTED_PROMPTS.map(p => `
            <button data-prompt="${_escHtml(p)}" style="
              border:1px solid var(--border-0);
              border-radius:10px;
              background:var(--surface-0);
              color:var(--text-secondary);
              padding:8px 12px;
              font-size:12px;
              font-family:var(--font-ui);
              cursor:pointer;
              text-align:left;
              transition:background 160ms ease,border-color 160ms ease,transform 160ms cubic-bezier(0.34,1.56,0.64,1);
            " onmouseover="this.style.background='var(--surface-2)';this.style.borderColor='var(--border-1)';this.style.transform='translateY(-1px)'"
               onmouseout="this.style.background='var(--surface-0)';this.style.borderColor='var(--border-0)';this.style.transform='none'"
            >${_escHtml(p)}</button>
          `).join('')}
        </div>
      </div>`;

    // Wire suggested prompts
    messagesEl.querySelectorAll('[data-prompt]').forEach(btn => {
      btn.addEventListener('click', () => {
        chatInput.value = btn.dataset.prompt;
        _sendMessage();
      });
    });
  }

  // ── MESSAGE HELPERS ──────────────────────────────────────────
  function _appendMsg(role, htmlContent) {
    // Remove welcome screen on first real message
    const welcome = messagesEl.querySelector('[data-prompt]')?.closest('div[style*="flex:1"]');
    if (welcome) welcome.remove();

    const isUser = role === 'user';
    const wrap = document.createElement('div');
    wrap.className = `msg${isUser ? ' user-msg' : ''}`;

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    if (isUser) {
      avatar.textContent = AVATAR_USER;
      avatar.style.background = 'var(--ai-user-avatar-bg)';
      avatar.style.borderColor = 'var(--ai-user-avatar-border)';
      avatar.style.color = 'var(--text-tertiary)';
    } else {
      avatar.innerHTML = AVATAR_AI;
      avatar.style.background = 'var(--ai-welcome-avatar-bg)';
      avatar.style.borderColor = 'var(--ai-welcome-avatar-border)';
      avatar.style.color = 'var(--ai-avatar-ai-color)';
    }

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.innerHTML = htmlContent;

    wrap.appendChild(avatar);
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    _scrollBottom();
    return { wrap, bubble };
  }

  function _appendTyping() {
    const { wrap, bubble } = _appendMsg('assistant', TYPING_HTML);
    return { wrap, bubble };
  }

  function _scrollBottom() {
    messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
  }

  // ── STREAMING SIMULATION ─────────────────────────────────────
  // Reveals text character-by-character for a "streaming" feel
  function _streamText(bubble, fullText) {
    return new Promise(resolve => {
      const html = _md(fullText);
      bubble.innerHTML = '';
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      const chars = tmp.textContent.split('');
      let i = 0;

      // For rich HTML, do a word-reveal approach instead
      const words = fullText.split(/(\s+)/);
      let revealed = '';
      let wi = 0;

      const tick = () => {
        if (wi >= words.length) { resolve(); return; }
        // Reveal 3-6 words per tick for natural feel
        const chunk = Math.floor(Math.random() * 4) + 3;
        revealed += words.slice(wi, wi + chunk).join('');
        wi += chunk;
        bubble.innerHTML = `<p style="margin:0;line-height:1.6">${_md(revealed)}${wi < words.length ? '<span style="opacity:0.4;animation:pulse 0.8s infinite">▋</span>' : ''}</p>`;
        _scrollBottom();
        // Variable speed: faster at start, slower towards end
        const delay = wi < words.length * 0.3 ? 28 : wi < words.length * 0.7 ? 35 : 42;
        setTimeout(tick, delay);
      };
      tick();
    });
  }

  // ── SEND MESSAGE ─────────────────────────────────────────────
  async function _sendMessage() {
    const text = chatInput.value.trim();
    if (!text || isStreaming) return;

    chatInput.value = '';
    chatInput.style.height = 'auto';
    isStreaming = true;
    _setSendState(false);

    // Add to history + render
    history.push({ role: 'user', content: text });
    _appendMsg('user', `<p style="margin:0">${_escHtml(text)}</p>`);

    // Get API key
    const apiKey = await kairon.getGroqApiKey().catch(() => null);
    if (!apiKey) {
      // Accurate BYOK guidance: this beta has no settings UI for the key yet.
      // The key lives in the internal store and can be set from the browser
      // window's DevTools console.
      const msg = 'No Groq API key configured. Kairon AI runs on **your own Groq API key** (bring-your-own-key). ' +
        'Key configuration is not available in this beta yet — to enable the panel, open the browser window\'s DevTools ' +
        'console and run: `window.kairon.setGroqApiKey(\'your-groq-api-key\')`.';
      history.push({ role: 'assistant', content: msg });
      const { bubble } = _appendMsg('assistant', '');
      await _streamText(bubble, msg);
      isStreaming = false;
      _setSendState(true);
      return;
    }

    // Typing indicator
    const { wrap: typingWrap } = _appendTyping();

    // Build messages array with system context
    const systemMsg = {
      role: 'system',
      content: [
        'You are Kairon AI, a fast and helpful browser assistant built into the Kairon browser.',
        'Be concise, direct, and clear. Use markdown formatting when it adds clarity.',
        'If asked to summarize the current page, acknowledge that you can help once the user shares the content.',
        'Never start responses with "I" as the first word.',
        'Avoid filler phrases like "Certainly!" or "Of course!".',
      ].join(' '),
    };

    // Trim history to last 12 turns to stay within context
    const trimmedHistory = history.slice(-12);

    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [systemMsg, ...trimmedHistory],
          max_tokens: 1024,
          temperature: 0.7,
          stream: false,
        }),
      });

      typingWrap.remove();

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const errMsg = `API error ${res.status}: ${err.error?.message || res.statusText}`;
        history.push({ role: 'assistant', content: errMsg });
        const { bubble } = _appendMsg('assistant', '');
        await _streamText(bubble, errMsg);
      } else {
        const data = await res.json();
        const content = data.choices?.[0]?.message?.content || 'No response received.';
        history.push({ role: 'assistant', content });
        const { bubble } = _appendMsg('assistant', '');
        await _streamText(bubble, content);
      }

    } catch (err) {
      typingWrap.remove();
      const errMsg = `Network error: ${err.message}`;
      history.push({ role: 'assistant', content: errMsg });
      const { bubble } = _appendMsg('assistant', '');
      await _streamText(bubble, errMsg);
    }

    isStreaming = false;
    _setSendState(true);
    chatInput.focus();
  }

  // ── SEND BUTTON STATE ────────────────────────────────────────
  function _setSendState(enabled) {
    btnSend.disabled = !enabled;
    btnSend.style.opacity = enabled ? '1' : '0.45';
    btnSend.style.transform = '';
  }

  // ── CLEAR CONVERSATION ────────────────────────────────────────
  function _clearHistory() {
    history = [];
    _renderWelcome();
  }

  // ── EVENT BINDING ─────────────────────────────────────────────
  function bindEvents() {
    // Send
    btnSend.addEventListener('click', _sendMessage);

    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        _sendMessage();
      }
    });

    // Auto-resize textarea
    chatInput.addEventListener('input', () => {
      chatInput.style.height = 'auto';
      chatInput.style.height = `${Math.min(chatInput.scrollHeight, 120)}px`;

      // Visual cue: show send button brighter when there's content
      btnSend.style.opacity = chatInput.value.trim() ? '1' : '0.6';
    });

    // Add a "New chat" button dynamically after first message.
    // The scroll handler is rAF-throttled so the layout reads (scrollHeight /
    // scrollTop / clientHeight) only happen once per frame instead of on every
    // scroll event — behavior is identical, just cheaper.
    let scrollFramePending = false;
    messagesEl.addEventListener('scroll', () => {
      if (scrollFramePending) return;
      scrollFramePending = true;
      requestAnimationFrame(() => {
        scrollFramePending = false;
        const atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
        _toggleScrollBtn(!atBottom);
      });
    });

    // Initial welcome
    _renderWelcome();
  }

  // ── SCROLL-TO-BOTTOM BUTTON ──────────────────────────────────
  let scrollBtn = null;

  function _toggleScrollBtn(show) {
    if (show && !scrollBtn) {
      scrollBtn = document.createElement('button');
      scrollBtn.setAttribute('aria-label', 'Scroll to bottom');
      scrollBtn.style.cssText = `
        position:absolute;
        bottom:80px;
        right:16px;
        width:30px;height:30px;
        border-radius:50%;
        border:1px solid var(--border-1);
        background:var(--ai-scroll-btn-bg);
        backdrop-filter:blur(12px);
        color:var(--text-secondary);
        display:inline-flex;
        align-items:center;
        justify-content:center;
        cursor:pointer;
        box-shadow:0 4px 12px rgba(0,0,0,0.35);
        transition:transform 150ms cubic-bezier(0.34,1.56,0.64,1),opacity 150ms ease;
        z-index:10;
      `;
      scrollBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 11 11" fill="none">
        <path d="M1 3.5L5.5 8 10 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`;
      scrollBtn.addEventListener('click', _scrollBottom);
      scrollBtn.addEventListener('mouseenter', () => { scrollBtn.style.transform = 'translateY(1px)'; });
      scrollBtn.addEventListener('mouseleave', () => { scrollBtn.style.transform = ''; });

      // Position relative to AI panel
      const aiPanel = document.getElementById('ai-panel');
      aiPanel.style.position = 'relative';
      aiPanel.appendChild(scrollBtn);

    } else if (!show && scrollBtn) {
      scrollBtn.remove();
      scrollBtn = null;
    }
  }

  return { bindEvents };
}
