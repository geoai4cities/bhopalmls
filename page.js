// Page chrome shared by the three versions (loaded as a classic script, deferred):
//   - theme toggle (the viewer, gallery and results listen for 'themeChanged')
//   - sticky section bar: marks the section in view (scroll-spy)
//   - BibTeX copy button
(function () {
  'use strict';

  // ---- theme toggle -------------------------------------------------------
  function paintThemeButton(theme) {
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    const dark = theme === 'dark';
    const use = btn.querySelector('use');
    if (use) use.setAttribute('href', dark ? '#i-sun' : '#i-moon');
    const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
    btn.setAttribute('aria-label', label);
    btn.title = label;
  }
  window.toggleTheme = function () {
    const doc = document.documentElement;
    const next = (doc.getAttribute('data-theme') || 'light') === 'dark' ? 'light' : 'dark';
    doc.setAttribute('data-theme', next);
    paintThemeButton(next);
    document.dispatchEvent(new CustomEvent('themeChanged', { detail: next }));
  };
  paintThemeButton(document.documentElement.getAttribute('data-theme') || 'light');

  // ---- sticky bar: section in view ---------------------------------------
  const links = Array.from(document.querySelectorAll('.topbar-links a[href^="#"]'));
  const targets = links
    .map((a) => ({ a, el: document.getElementById(a.getAttribute('href').slice(1)) }))
    .filter((t) => t.el);
  let ticking = false;
  function markActive() {
    ticking = false;
    const y = window.scrollY + 110;           // just under the bar
    let current = null;
    for (const t of targets) {
      if (t.el.getBoundingClientRect().top + window.scrollY <= y) current = t;
    }
    // at the foot of the page the last section counts even if it is short
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) {
      current = targets[targets.length - 1] || current;
    }
    for (const t of targets) {
      const on = t === current;
      t.a.classList.toggle('is-active', on);
      if (on) t.a.setAttribute('aria-current', 'location'); else t.a.removeAttribute('aria-current');
    }
    if (current) {
      // keep the active chip visible when the row scrolls sideways (phones)
      const row = current.a.parentElement;
      const r = current.a.getBoundingClientRect(), rr = row.getBoundingClientRect();
      if (r.left < rr.left || r.right > rr.right) {
        row.scrollTo({ left: current.a.offsetLeft - rr.width / 2 + r.width / 2, behavior: 'smooth' });
      }
    }
  }
  function onScroll() {
    if (!ticking) { ticking = true; requestAnimationFrame(markActive); }
  }
  if (targets.length) {
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    markActive();
  }

  // ---- BibTeX copy --------------------------------------------------------
  const copyBtn = document.getElementById('copy-bibtex');
  const bib = document.getElementById('bibtex-text');
  if (copyBtn && bib) {
    const labelEl = copyBtn.querySelector('span') || copyBtn;
    const idle = labelEl.textContent;
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(bib.textContent);
        labelEl.textContent = 'Copied';
        copyBtn.classList.add('done');
      } catch (e) {
        // no clipboard permission (file://, old browsers): select the text instead
        const range = document.createRange();
        range.selectNodeContents(bib);
        const sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(range);
        labelEl.textContent = 'Select & copy';
      }
      setTimeout(() => { labelEl.textContent = idle; copyBtn.classList.remove('done'); }, 1600);
    });
  }
})();
