// Diagnostic logging is gated so the overlay performs no unnecessary console
// output (or forced-layout measurement) in production.
const OVERLAY_DIAG = false;

const suggestions = document.getElementById('address-suggestions');

function renderSuggestions({ items, rect, selectedIndex = -1 }) {
  if (!suggestions) return;

  suggestions.innerHTML = '';
  const top = Math.round(rect.bottom);
  const left = Math.round(rect.left);
  const width = Math.round(rect.width);

  if (OVERLAY_DIAG) {
    console.info('[OVERLAY-DIAG] renderSuggestions rect from payload:', JSON.stringify(rect));
    console.info('[OVERLAY-DIAG] applying suggestions style:', { top, left, width });
  }

  suggestions.style.top = `${top}px`;
  suggestions.style.left = `${left}px`;
  suggestions.style.width = `${width}px`;
  suggestions.style.maxWidth = `${width}px`;
  suggestions.style.right = 'auto';
  suggestions.style.boxSizing = 'border-box';

  // After render, measure actual position (diagnostic only — avoids a forced
  // layout read in production)
  if (OVERLAY_DIAG) {
    requestAnimationFrame(() => {
      const actualRect = suggestions.getBoundingClientRect();
      console.info('[OVERLAY-DIAG] suggestions actual getBoundingClientRect after render:', JSON.stringify({
        left: Math.round(actualRect.left),
        right: Math.round(actualRect.right),
        top: Math.round(actualRect.top),
        bottom: Math.round(actualRect.bottom),
        width: Math.round(actualRect.width),
      }));
      console.info('[OVERLAY-DIAG] overlay window info:', {
        devicePixelRatio: window.devicePixelRatio,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
      });
    });
  }

  items.forEach((value, index) => {
    const btn = document.createElement('button');
    btn.className = 'address-suggestion-item';
    btn.type = 'button';
    btn.setAttribute('role', 'option');
    if (index === selectedIndex) btn.setAttribute('aria-selected', 'true');

    const isSearch = index === items.length - 1 && value.includes('search.brave.com');
    let displayText = value;
    let iconElement;

    if (isSearch) {
      try {
        const url = new URL(value);
        const query = url.searchParams.get('q');
        if (query) {
          displayText = decodeURIComponent(query);
        }
      } catch {}
      btn.style.color = 'rgba(255,255,255,0.6)';
      iconElement = `<img src="https://brave.com/favicon.ico" width="16" height="16" style="flex-shrink:0">`;
    } else {
      iconElement = `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" style="flex-shrink:0;opacity:0.5">
          <circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1.2"/>
          <path d="M1 6h10M6 1C4.5 3 4.5 9 6 11M6 1c1.5 2 1.5 8 0 10" stroke="currentColor" stroke-width="1.2"/>
         </svg>`;
    }

    btn.innerHTML = `
      <span>
        ${iconElement}
        <span style="text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${sanitizeText(displayText)}</span>
      </span>`;

    btn.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      window.kairon.navigateToSuggestion(value);
    });

    suggestions.appendChild(btn);
  });

  if (items.length) suggestions.style.display = 'block';
  else suggestions.style.display = 'none';
}

function sanitizeText(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

window.kairon.on('overlay-suggestions', (payload) => {
  if (!payload || !payload.items) return;
  renderSuggestions(payload);
});

window.kairon.on('overlay-hide', () => {
  suggestions.innerHTML = '';
  suggestions.style.display = 'none';
  suggestions.style.right = '';
  suggestions.style.maxWidth = '';
  suggestions.style.boxSizing = '';
});
