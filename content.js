/* ================================================================
   Ticket Analyser — Content Script
   Runs on: Jira (cloud), GitHub Issues/PRs, Linear
   Responsibilities:
     1. Detect which ticket platform is active
     2. Extract ticket data (title, type, scope, dev notes, Figma URLs)
     3. Inject the floating "Copilot" button on every ticket page
     4. Render the analysis sidebar panel
     5. Forward GET_TICKET_DATA requests from the popup
   ================================================================ */

(() => {
  'use strict';

  // ── Platform detection ──────────────────────────────────────
  function detectPlatform() {
    const h = window.location.hostname;
    const p = window.location.pathname;
    if (h.includes('atlassian.net') && (p.includes('/browse/') || p.includes('/issues/'))) return 'jira';
    if (h === 'github.com' && (/\/issues\/\d+/.test(p) || /\/pull\/\d+/.test(p))) return 'github';
    if (h === 'linear.app' && /\/issue\//.test(p)) return 'linear';
    return null;
  }

  const PLATFORM = detectPlatform();
  if (!PLATFORM) return;

  // ── State ───────────────────────────────────────────────────
  let panelOpen = false;
  let ticketData = null;
  let lastUrl = window.location.href;
  let pendingPanelTab = null;
  let spGh = { token: '', owner: '', repo: '', branches: [], defaultBranch: 'master', allRepos: [], loaded: false };

  // ── SPA navigation watcher ──────────────────────────────────
  const navObserver = new MutationObserver(
    debounce(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        onNavigate();
      }
    }, 600)
  );
  navObserver.observe(document.body, { childList: true, subtree: true });

  function onNavigate() {
    document.getElementById('tc-fab')?.remove();
    closePanel();
    ticketData = null;
    spGh.loaded = false;
    // Only re-inject if we're still on a ticket page
    if (detectPlatform()) {
      setTimeout(maybeInjectButton, 2500);
    }
  }

  // ── FAB injection ───────────────────────────────────────────
  const pageObserver = new MutationObserver(debounce(maybeInjectButton, 800));
  pageObserver.observe(document.body, { childList: true, subtree: true });
  setTimeout(maybeInjectButton, 2000);

  function maybeInjectButton() {
    if (document.getElementById('tc-fab')) return;
    // Only inject when we're on a recognized ticket page
    if (!detectPlatform()) return;
    // Gate: ensure there's actual ticket content (title) on the page
    const data = extractTicketData();
    if (!data || !data.title) return;
    injectFAB();
  }

  function injectFAB() {
    const fab = document.createElement('button');
    fab.id = 'tc-fab';
    fab.className = 'tc-fab';
    fab.title = 'Open Ticket Analyser';
    fab.setAttribute('aria-label', 'GitHub Copilot — Analyze ticket');
    fab.innerHTML = `
      <svg class="tc-fab-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
        <path d="M12 .5C5.37.5 0 5.78 0 12.292c0 5.211 3.438 9.63 8.205 11.188.6.111.82-.254.82-.567 0-.28-.01-1.022-.015-2.005-3.338.711-4.042-1.582-4.042-1.582-.546-1.361-1.333-1.723-1.333-1.723-1.09-.731.083-.716.083-.716 1.205.082 1.838 1.215 1.838 1.215 1.07 1.803 2.809 1.282 3.495.981.108-.763.417-1.282.76-1.577-2.665-.295-5.466-1.309-5.466-5.827 0-1.287.465-2.339 1.235-3.164-.135-.298-.54-1.497.105-3.121 0 0 1.005-.316 3.3 1.209A11.616 11.616 0 0 1 12 6.32c1.02.005 2.047.136 3.006.398 2.28-1.525 3.285-1.209 3.285-1.209.645 1.624.24 2.823.12 3.121.765.825 1.23 1.877 1.23 3.164 0 4.53-2.805 5.527-5.475 5.817.42.354.81 1.077.81 2.182 0 1.578-.015 2.846-.015 3.229 0 .309.21.678.825.56C20.565 21.917 24 17.495 24 12.292 24 5.78 18.627.5 12 .5z"/>
      </svg>
      <span>Auto ticket analyser</span>
    `;
    fab.addEventListener('click', openExtensionPopup);
    document.body.appendChild(fab);
  }

  function openExtensionPopup() {
    // Store flag so extension popup also navigates to Workflows if it opens
    chrome.storage.local.set({ tc_fab_open: { ts: Date.now(), tab: 'github' } });
    // Open the side panel (always works) and switch to Workflows tab
    pendingPanelTab = 'github';
    if (panelOpen) {
      switchPanelTab('github');
    } else {
      openPanel();
    }
  }

  function switchPanelTab(pane) {
    const body = document.getElementById('tc-panel-body');
    if (!body) return;
    const target = body.querySelector(`.tc-tab[data-pane="${pane}"]`);
    if (target) target.click();
  }

  // ── Panel lifecycle ─────────────────────────────────────────
  function togglePanel() {
    panelOpen ? closePanel() : openPanel();
  }

  function openPanel() {
    let panel = document.getElementById('tc-panel');
    if (!panel) panel = createPanel();
    panel.classList.add('tc-panel--open');
    document.getElementById('tc-fab')?.classList.add('tc-fab--active');
    panelOpen = true;
    startAnalysis(panel);
  }

  function closePanel() {
    document.getElementById('tc-panel')?.classList.remove('tc-panel--open');
    document.getElementById('tc-fab')?.classList.remove('tc-fab--active');
    panelOpen = false;
  }

  function createPanel() {
    const panel = document.createElement('div');
    panel.id = 'tc-panel';
    panel.className = 'tc-panel';
    panel.innerHTML = `
      <div class="tc-panel-header">
        <div class="tc-panel-logo">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d="M12 .5C5.37.5 0 5.78 0 12.292c0 5.211 3.438 9.63 8.205 11.188.6.111.82-.254.82-.567 0-.28-.01-1.022-.015-2.005-3.338.711-4.042-1.582-4.042-1.582-.546-1.361-1.333-1.723-1.333-1.723-1.09-.731.083-.716.083-.716 1.205.082 1.838 1.215 1.838 1.215 1.07 1.803 2.809 1.282 3.495.981.108-.763.417-1.282.76-1.577-2.665-.295-5.466-1.309-5.466-5.827 0-1.287.465-2.339 1.235-3.164-.135-.298-.54-1.497.105-3.121 0 0 1.005-.316 3.3 1.209A11.616 11.616 0 0 1 12 6.32c1.02.005 2.047.136 3.006.398 2.28-1.525 3.285-1.209 3.285-1.209.645 1.624.24 2.823.12 3.121.765.825 1.23 1.877 1.23 3.164 0 4.53-2.805 5.527-5.475 5.817.42.354.81 1.077.81 2.182 0 1.578-.015 2.846-.015 3.229 0 .309.21.678.825.56C20.565 21.917 24 17.495 24 12.292 24 5.78 18.627.5 12 .5z"/>
          </svg>
          <span>Ticket Analyser</span>
        </div>
        <button id="tc-panel-close" class="tc-icon-btn" aria-label="Close panel">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
            <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.06 1.06L9.06 8l3.22 3.22a.749.749 0 0 1-1.06 1.06L8 9.06l-3.22 3.22a.749.749 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.751.751 0 0 1 0-1.06z"/>
          </svg>
        </button>
      </div>
      <div class="tc-panel-body" id="tc-panel-body">
        <div class="tc-loading">
          <div class="tc-spinner"></div>
          <p>Analyzing ticket…</p>
        </div>
      </div>
    `;
    document.body.appendChild(panel);
    document.getElementById('tc-panel-close').addEventListener('click', closePanel);
    enablePanelDrag(panel);
    return panel;
  }

  // ── Make panel draggable by header ──────────────────────────
  function enablePanelDrag(panel) {
    const header = panel.querySelector('.tc-panel-header');
    let dragging = false, startX, startY, startLeft, startTop;

    header.addEventListener('mousedown', (e) => {
      // Don't drag when clicking buttons inside header
      if (e.target.closest('button')) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      // Switch from right/top positioning to left/top for free movement
      panel.style.left = startLeft + 'px';
      panel.style.top = startTop + 'px';
      panel.style.right = 'auto';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      let newLeft = startLeft + dx;
      let newTop = startTop + dy;
      // Keep panel within viewport
      newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - 100));
      newTop = Math.max(0, Math.min(newTop, window.innerHeight - 50));
      panel.style.left = newLeft + 'px';
      panel.style.top = newTop + 'px';
    });

    document.addEventListener('mouseup', () => { dragging = false; });
  }

  // ── Ticket data extraction ──────────────────────────────────
  function extractTicketData() {
    if (PLATFORM === 'jira') return extractJira();
    if (PLATFORM === 'github') return extractGitHub();
    if (PLATFORM === 'linear') return extractLinear();
    return {};
  }

  function extractJira() {
    const pathMatch =
      window.location.pathname.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/i) ||
      window.location.pathname.match(/\/issues\/([A-Z][A-Z0-9]+-\d+)/i);
    const id = pathMatch?.[1] || '';

    const titleEl =
      document.querySelector('[data-testid="issue.views.issue-base.foundation.summary.heading"] h1') ||
      document.querySelector('h1[data-testid*="summary"]') ||
      document.querySelector('#summary-val') ||
      document.querySelector('h1.issue-title');
    const title = titleEl?.textContent?.trim() || document.title.split(' - ')[0].trim();

    const typeImgEl =
      document.querySelector('[data-testid*="issue-type"] img') ||
      document.querySelector('[data-testid*="change-issue-type"] img') ||
      document.querySelector('.issue-type-icon img');
    const type =
      typeImgEl?.getAttribute('alt') ||
      typeImgEl?.title ||
      guessTypeFromTitle(title);

    const descEl =
      document.querySelector('[data-testid="issue.views.field.rich-text.description"]') ||
      document.querySelector('#description-val') ||
      document.querySelector('[data-componenttype="description"]');
    const description = descEl?.innerText?.trim() || '';

    let scope = '';
    let devNotes = '';
    let keyDetails = '';
    let qaAcceptance = '';
    document
      .querySelectorAll('[data-testid*="customfield"], .customfield, .field-group, [class*="sc-custom-field"]')
      .forEach((field) => {
        const label = (
          field.querySelector('label, [class*="label"], [data-testid*="label"]')?.textContent || ''
        ).toLowerCase();
        const value = (
          field.querySelector('p, [class*="value"], [data-testid*="value"]')?.innerText || ''
        ).trim();
        if (/\bscope\b/.test(label) && value) scope = value;
        if (/dev\s*notes?|developer\s*notes?|implementation\s*notes?/.test(label) && value) devNotes = value;
        if (/key\s*details?|general\s*details?|general\b/.test(label) && value) keyDetails = value;
        if (/qa\s*accept(ance|ence)?|quality\s*assurance|test\s*criteria|qa\s*criteria/.test(label) && value) qaAcceptance = value;
      });

    const allText = [description, scope, devNotes, keyDetails, qaAcceptance].join(' ');
    const figmaUrls = extractFigmaUrls(allText);

    const attachmentImageUrls = [
      ...extractImgSrcs(descEl),
      ...extractImgSrcs(document.querySelector('.attachments, [data-testid*="attachment-panel"]')),
    ];
    const comments = extractJiraComments();

    return { platform: 'jira', id, title, type, description, scope, devNotes, keyDetails, qaAcceptance, figmaUrls, attachmentImageUrls, comments, url: window.location.href };
  }

  function extractGitHub() {
    const pathMatch = window.location.pathname.match(/\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)/);
    const owner = pathMatch?.[1] || '';
    const repoName = pathMatch?.[2] || '';
    const num = pathMatch?.[3] || '';
    const id = num ? `#${num}` : '';
    const isPR = window.location.pathname.includes('/pull/');

    const titleEl =
      document.querySelector('.js-issue-title') ||
      document.querySelector('bdi.js-issue-title') ||
      document.querySelector('[data-testid="issue-title"]') ||
      document.querySelector('h1 bdi');
    const title = titleEl?.textContent?.trim() || '';

    const labels = [
      ...document.querySelectorAll('.IssueLabel, [data-component="LabelGroup"] span, .labels a'),
    ].map((l) => l.textContent.trim().toLowerCase());

    let type = isPR ? 'pull-request' : 'feature';
    if (labels.some((l) => /\bbug\b|\bfix\b/.test(l))) type = 'bug';
    else if (labels.some((l) => /enhancement|feature/.test(l))) type = 'feature';
    else if (labels.some((l) => /doc(s|umentation)?/.test(l))) type = 'documentation';
    else if (labels.some((l) => /refactor|chore/.test(l))) type = labels.find((l) => /refactor|chore/.test(l));

    const bodyEl =
      document.querySelector('.js-comment-body') ||
      document.querySelector('[data-testid="issue-body"] .markdown-body') ||
      document.querySelector('.comment-body .markdown-body');
    const description = bodyEl?.innerText?.trim() || '';

    const scope = extractSection(description, 'scope|acceptance criteria');
    const devNotes = extractSection(description, 'dev notes|developer notes|implementation notes|technical notes|notes for dev');
    const keyDetails = extractSection(description, 'key details|general details|general|details');
    const qaAcceptance = extractSection(description, 'qa accept(ance|ence)|quality assurance|test criteria|qa criteria|qa');

    const figmaUrls = extractFigmaUrls(description);

    const attachmentImageUrls = extractImgSrcs(bodyEl);
    const comments = extractGitHubComments(bodyEl);

    return { platform: 'github', id, title, type, description, scope, devNotes, keyDetails, qaAcceptance, figmaUrls, attachmentImageUrls, comments, url: window.location.href, owner, repo: repoName };
  }

  function extractLinear() {
    const pathMatch = window.location.pathname.match(/\/issue\/([^/]+)/);
    const id = pathMatch?.[1] || '';

    const titleEl =
      document.querySelector('h1[data-testid="issue-title"]') ||
      document.querySelector('[class*="IssueTitle"] h1') ||
      document.querySelector('h1');
    const title = titleEl?.textContent?.trim() || '';

    const bodyEl =
      document.querySelector('[data-testid="issue-description"]') ||
      document.querySelector('.tiptap') ||
      document.querySelector('[class*="IssueBody"]');
    const description = bodyEl?.innerText?.trim() || '';

    const scope = extractSection(description, 'scope|acceptance criteria');
    const devNotes = extractSection(description, 'dev notes|developer notes|implementation|technical');
    const keyDetails = extractSection(description, 'key details|general details|general|details');
    const qaAcceptance = extractSection(description, 'qa accept(ance|ence)|quality assurance|test criteria|qa criteria|qa');

    const figmaUrls = extractFigmaUrls(description);

    const attachmentImageUrls = extractImgSrcs(bodyEl);
    const comments = extractLinearComments();

    return { platform: 'linear', id, title, type: guessTypeFromTitle(title), description, scope, devNotes, keyDetails, qaAcceptance, figmaUrls, attachmentImageUrls, comments, url: window.location.href };
  }

  // ── Comment & image extraction helpers ─────────────────────
  function extractImgSrcs(el) {
    if (!el) return [];
    return [...el.querySelectorAll('img')]
      .map((img) => img.src || img.getAttribute('data-src') || '')
      .filter((src) => src && !src.startsWith('data:'));
  }

  function extractJiraComments() {
    const comments = [];
    document
      .querySelectorAll(
        '[data-testid="ak-comment"], [data-testid*="comment-container"], ' +
        '.issue-comment-block, [data-testid*="comment-wrapper"]'
      )
      .forEach((el) => {
        const bodyEl = el.querySelector(
          '.ak-renderer-document, [data-testid="comment-body"], .user-content-block'
        );
        const text = bodyEl?.innerText?.trim() || '';
        const imageUrls = extractImgSrcs(el);
        if (text || imageUrls.length) comments.push({ text, imageUrls });
      });
    return comments;
  }

  function extractGitHubComments(firstBodyEl) {
    const comments = [];
    const allBodies = [
      ...document.querySelectorAll(
        '.js-comment-body, [data-testid="issue-body"] .markdown-body, ' +
        '.edit-comment-hide .comment-body, .timeline-comment-wrapper .comment-body'
      ),
    ];
    // Skip the first one — that's the issue/PR description, already captured in description field
    allBodies.filter((el) => el !== firstBodyEl).forEach((el) => {
      const text = el.innerText?.trim() || '';
      const imageUrls = extractImgSrcs(el);
      if (text || imageUrls.length) comments.push({ text, imageUrls });
    });
    return comments;
  }

  function extractLinearComments() {
    const comments = [];
    document
      .querySelectorAll('[data-testid*="comment"], [class*="ActivityFeed"]')
      .forEach((el) => {
        const bodyEl = el.querySelector('.tiptap, .ProseMirror, [class*="CommentBody"]');
        const text = bodyEl?.innerText?.trim() || '';
        const imageUrls = extractImgSrcs(el);
        if (text || imageUrls.length) comments.push({ text, imageUrls });
      });
    return comments;
  }

  const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

  async function fetchImagesAsBase64(urls, maxImages = 4) {
    const results = [];
    for (const url of urls.slice(0, maxImages)) {
      try {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) continue;
        const blob = await res.blob();
        // Only send formats accepted by the vision API: png, jpeg, webp, gif
        const mimeType = blob.type.split(';')[0].trim().toLowerCase();
        if (!SUPPORTED_IMAGE_TYPES.has(mimeType)) continue;
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        results.push({ url, base64 });
      } catch {
        // skip inaccessible images silently
      }
    }
    return results;
  }

  // ── Cache helpers (mirrors popup.js / background.js) ───────
  const TC_CACHE_PREFIX = 'tc_cache_';
  const TC_CACHE_TTL = 60 * 60 * 1000;
  const TC_TASKS_PREFIX = 'tc_tasks_';

  function getCacheKey(td) {
    const raw = td.url || `${td.platform}::${td.id}`;
    return TC_CACHE_PREFIX + raw.replace(/[^a-zA-Z0-9_:/-]/g, '_').slice(0, 200);
  }

  function getTasksKey(td) {
    const raw = td.url || `${td.platform}::${td.id}`;
    return TC_TASKS_PREFIX + raw.replace(/[^a-zA-Z0-9_:/-]/g, '_').slice(0, 200);
  }

  function peekCache(td) {
    return new Promise((resolve) => {
      const key = getCacheKey(td);
      chrome.storage.local.get(key, (items) => {
        const entry = items[key];
        if (!entry || !entry.cachedAt || !entry.analysis) return resolve(null);
        if (Date.now() - entry.cachedAt > TC_CACHE_TTL) return resolve(null);
        resolve({ ...entry.analysis, _fromCache: true, _cachedAt: entry.cachedAt });
      });
    });
  }

  function loadTaskStates(td) {
    return new Promise((resolve) => {
      chrome.storage.local.get(getTasksKey(td), (items) => {
        resolve(items[getTasksKey(td)] || {});
      });
    });
  }

  function saveTaskStates(td, states) {
    chrome.storage.local.set({ [getTasksKey(td)]: states });
  }

  // ── Analysis & rendering ────────────────────────────────────
  async function startAnalysis(panel, forceRefresh = false) {
    ticketData = extractTicketData();
    spGh.loaded = false; // reset so Workflows tab re-initialises after re-render
    const body = document.getElementById('tc-panel-body');

    if (!ticketData.title) {
      renderError(body, 'Could not read ticket data. Ensure the page is fully loaded, then click Re-analyze.');
      return;
    }

    // Check cache first — skip AI call entirely if a fresh result exists
    if (!forceRefresh) {
      const cached = await peekCache(ticketData);
      if (cached) {
        ticketData._analysis = cached;
        const taskStates = await loadTaskStates(ticketData);
        applyTaskStates(cached, taskStates);
        renderResults(body, ticketData, cached);
        return;
      }
    }

    // Collect images from description/attachments and comments for vision analysis
    const allImageUrls = [
      ...(ticketData.attachmentImageUrls || []),
      ...(ticketData.comments || []).flatMap((c) => c.imageUrls || []),
    ];
    if (allImageUrls.length) {
      renderLoading(body, 'Reading images…');
      ticketData.images = await fetchImagesAsBase64(allImageUrls, 4);
    }

    renderLoading(body, ticketData.images?.length
      ? `Analyzing ticket with AI (${ticketData.images.length} image(s) included)…`
      : 'Analyzing ticket with AI…');

    try {
      const analysis = await chrome.runtime.sendMessage({
        type: 'ANALYZE_TICKET',
        payload: ticketData,
        forceRefresh: forceRefresh,
      });
      if (analysis.error) throw new Error(analysis.error);
      ticketData._analysis = analysis;
      const taskStates = await loadTaskStates(ticketData);
      applyTaskStates(analysis, taskStates);
      renderResults(body, ticketData, analysis);
    } catch (err) {
      renderError(body, err.message);
    }
  }

  // Apply persisted task done/pending states onto analysis object
  function applyTaskStates(analysis, states) {
    [...(analysis.uiTasks || []), ...(analysis.devTasks || [])].forEach((t) => {
      if (t.id in states) t.status = states[t.id];
    });
  }

  function renderLoading(body, msg) {
    body.innerHTML = `
      <div class="tc-loading">
        <div class="tc-spinner"></div>
        <p>${escHtml(msg)}</p>
      </div>`;
  }

  function renderError(body, msg) {
    body.innerHTML = `
      <div class="tc-error">
        <svg viewBox="0 0 16 16" width="22" height="22" fill="currentColor">
          <path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0M9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0"/>
        </svg>
        <p>${escHtml(msg)}</p>
        <button class="tc-btn tc-btn--sm tc-btn--outline" id="tc-settings-link">Open Settings</button>
        <button class="tc-btn tc-btn--sm tc-btn--primary tc-mt-sm" id="tc-retry-btn">Retry</button>
      </div>`;
    document.getElementById('tc-settings-link')?.addEventListener('click', () =>
      chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' })
    );
    document.getElementById('tc-retry-btn')?.addEventListener('click', () => {
      const panel = document.getElementById('tc-panel');
      if (panel) startAnalysis(panel);
    });
  }

  function renderResults(body, data, analysis) {
    const typeColors = {
      bug: '#f85149', feature: '#58a6ff', improvement: '#3fb950',
      documentation: '#bc8cff', chore: '#8b949e', refactor: '#d29922',
      'pull-request': '#58a6ff',
    };
    const typeColor = typeColors[analysis.ticketType] || '#8b949e';
    const complexityColors = { low: '#3fb950', medium: '#d29922', high: '#f85149' };
    const complexColor = complexityColors[analysis.complexity] || '#8b949e';

    const uiDone = (analysis.uiTasks || []).filter((t) => t.status === 'done').length;
    const devDone = (analysis.devTasks || []).filter((t) => t.status === 'done').length;
    const uiTotal = (analysis.uiTasks || []).length;
    const devTotal = (analysis.devTasks || []).length;

    const figmaNotice = analysis.hasFigma
      ? `<div class="tc-figma-notice">
          <svg viewBox="0 0 38 57" width="11" height="11"><path fill="#1abcfe" d="M19 28.5a9.5 9.5 0 1 1 19 0 9.5 9.5 0 0 1-19 0z"/><path fill="#0acf83" d="M0 47.5A9.5 9.5 0 0 1 9.5 38H19v9.5a9.5 9.5 0 1 1-19 0z"/><path fill="#ff7262" d="M19 0v19h9.5a9.5 9.5 0 1 0 0-19H19z"/><path fill="#f24e1e" d="M0 9.5A9.5 9.5 0 0 0 9.5 19H19V0H9.5A9.5 9.5 0 0 0 0 9.5z"/><path fill="#a259ff" d="M0 28.5A9.5 9.5 0 0 0 9.5 38H19V19H9.5A9.5 9.5 0 0 0 0 28.5z"/></svg>
          Figma design detected — UI tasks derived from design
        </div>`
      : '';

    body.innerHTML = `
      <div class="tc-ticket-card">
        <div class="tc-badges">
          <span class="tc-badge" style="background:${typeColor}22;color:${typeColor};border-color:${typeColor}55">${escHtml(analysis.ticketType)}</span>
          <span class="tc-badge" style="background:${complexColor}18;color:${complexColor};border-color:${complexColor}44">${escHtml(analysis.complexity)} complexity</span>
          ${!analysis.hasScope ? '<span class="tc-badge tc-badge--muted">no scope</span>' : ''}
        </div>
        <div class="tc-ticket-id">${escHtml(data.id)}</div>
        <div class="tc-ticket-title">${escHtml(data.title)}</div>
        <p class="tc-summary-text">${escHtml(analysis.summary)}</p>
        <div class="tc-feature-type">
          <span class="tc-label">Feature type</span>
          <span>${escHtml(analysis.featureType)}</span>
        </div>
      </div>

      <div class="tc-tabs" role="tablist">
        <button class="tc-tab tc-tab--active" data-pane="tasks" role="tab">Tasks</button>
        <button class="tc-tab" data-pane="skill" role="tab">Skill File</button>
        <button class="tc-tab" data-pane="suggestions" role="tab">Copilots</button>
        <button class="tc-tab" data-pane="github" role="tab"><svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" style="flex-shrink:0"><path d="M11.28 3.22a.749.749 0 0 1 0 1.06L7.56 8l3.72 3.72a.749.749 0 1 1-1.06 1.06L5.94 8.53a.749.749 0 0 1 0-1.06l4.25-4.25a.749.749 0 0 1 1.06 0M8.28 3.22a.749.749 0 0 1 0 1.06L4.56 8l3.72 3.72a.749.749 0 1 1-1.06 1.06L2.94 8.53a.749.749 0 0 1 0-1.06l4.25-4.25a.749.749 0 0 1 1.06 0"/></svg>Workflows</button>
      </div>

      <!-- Tasks pane -->
      <div class="tc-pane" id="tc-pane-tasks">
        ${figmaNotice}
        <div class="tc-section">
          <div class="tc-section-header">
            <span class="tc-section-title">
              <svg viewBox="0 0 16 16" width="12" height="12" fill="#58a6ff"><path d="M11.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm-2.25.75a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25zM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zM3.5 3.25a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0z"/></svg>
              UI Tasks
            </span>
            <span class="tc-progress" id="tc-ui-progress">${uiDone}/${uiTotal} done</span>
          </div>
          <div class="tc-task-list" id="tc-ui-tasks">
            ${(analysis.uiTasks || []).map((t) => renderTask(t)).join('') || '<p class="tc-empty">No UI tasks generated</p>'}
          </div>
        </div>

        <div class="tc-section">
          <div class="tc-section-header">
            <span class="tc-section-title">
              <svg viewBox="0 0 16 16" width="12" height="12" fill="#3fb950"><path d="M11.28 3.22a.749.749 0 0 1 0 1.06L7.56 8l3.72 3.72a.749.749 0 1 1-1.06 1.06L5.94 8.53a.749.749 0 0 1 0-1.06l4.25-4.25a.749.749 0 0 1 1.06 0M8.28 3.22a.749.749 0 0 1 0 1.06L4.56 8l3.72 3.72a.749.749 0 1 1-1.06 1.06L2.94 8.53a.749.749 0 0 1 0-1.06l4.25-4.25a.749.749 0 0 1 1.06 0"/></svg>
              Dev Tasks
            </span>
            <span class="tc-progress" id="tc-dev-progress">${devDone}/${devTotal} done</span>
          </div>
          <div class="tc-task-list" id="tc-dev-tasks">
            ${(analysis.devTasks || []).map((t) => renderTask(t)).join('') || '<p class="tc-empty">No dev tasks generated</p>'}
          </div>
        </div>
      </div>

      <!-- Skill file pane -->
      <div class="tc-pane tc-pane--hidden" id="tc-pane-skill">
        <!-- Detected codebase tech stack section -->
        ${buildCodebaseHtml(analysis._codebase)}

        <!-- Repo skill files section -->
        ${buildRepoSkillsHtml(analysis._repoSkillFiles || [])}

        <!-- Generated skill file -->
        <div class="tc-skill-gen-header">
          <span class="tc-label">Generated Skill File</span>
          <button class="tc-btn tc-btn--sm tc-btn--outline" id="tc-regen-skill">
            <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor"><path d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z"/></svg>
            Regenerate
          </button>
        </div>
        <div class="tc-skill-bar">
          <span class="tc-skill-name">${escHtml(analysis.skillFileName || 'feature')}.md</span>
          <div class="tc-skill-actions">
            <button class="tc-btn tc-btn--sm" id="tc-copy-skill">
              <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>
              Copy
            </button>
            <button class="tc-btn tc-btn--sm tc-btn--primary" id="tc-dl-skill">
              <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor"><path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14Z"/><path d="M7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.97a.749.749 0 1 1 1.06 1.061l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.061z"/></svg>
              Download
            </button>
          </div>
        </div>
        <pre class="tc-skill-preview" id="tc-skill-content">${escHtml(analysis.skillFileContent || '')}</pre>
      </div>

      <!-- Copilot suggestions pane -->
      <div class="tc-pane tc-pane--hidden" id="tc-pane-suggestions">
        <p class="tc-suggestions-intro">GitHub Copilot suggestions based on this ticket:</p>
        <div id="tc-suggestions-list">
          ${(analysis.suggestions || []).map((s) => renderSuggestion(s)).join('') || '<p class="tc-empty">No suggestions generated</p>'}
        </div>
      </div>

      <!-- Workflows pane — full GitHub UI -->
      <div class="tc-pane tc-pane--hidden" id="tc-pane-github">
        <div id="tc-gh-no-token" class="tc-gh-state">
          <svg viewBox="0 0 16 16" width="26" height="26" fill="currentColor" style="opacity:.35;margin-bottom:8px"><path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8z"/></svg>
          <p class="tc-gh-state-title">No GitHub token configured</p>
          <p class="tc-gh-state-sub">Add a Personal Access Token in Settings to connect your repositories.</p>
          <button class="tc-btn tc-btn--outline tc-btn--sm" id="tc-gh-open-settings">Open Settings</button>
        </div>
        <div id="tc-gh-picker" class="tc-gh-state tc-pane--hidden">
          <p class="tc-gh-state-title">Select a repository</p>
          <input class="tc-input" id="tc-gh-repo-search" type="text" placeholder="Search repositories…" autocomplete="off" spellcheck="false" />
          <div id="tc-gh-repo-list" class="tc-gh-repo-list"><p class="tc-empty">Loading…</p></div>
        </div>
        <div id="tc-gh-content" class="tc-pane--hidden">
          <div class="tc-gh-repo-bar">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" style="color:#8b949e;flex-shrink:0"><path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8z"/></svg>
            <span id="tc-gh-repo-name" class="tc-gh-repo-name-text"></span>
            <button class="tc-btn tc-btn--xs tc-btn--outline" id="tc-gh-change-repo">Change</button>
          </div>
          <div id="tc-gh-issue-action-bar" class="tc-gh-issue-action-bar tc-pane--hidden">
            <button class="tc-btn tc-btn--sm tc-btn--primary tc-btn--full" id="tc-gh-create-issue">
              <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"/><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0zM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0z"/></svg>
              Create GitHub Issue
            </button>
          </div>
          <div id="tc-gh-issue-created" class="tc-gh-issue-created tc-pane--hidden">
            <div class="tc-issue-created-top">
              <svg viewBox="0 0 16 16" width="13" height="13" fill="#3fb950"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.749.749 0 1 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"/></svg>
              <span>Issue created: </span><a id="tc-gh-issue-link" href="#" target="_blank" rel="noopener noreferrer" class="tc-gh-issue-created-link"></a>
            </div>
          </div>
          <div class="tc-gh-sub-tabs">
            <button class="tc-gh-sub-tab tc-gh-sub-tab--act" data-ghpanel="workflows">Workflows</button>
            <button class="tc-gh-sub-tab" data-ghpanel="issues">Issues</button>
            <button class="tc-gh-sub-tab" data-ghpanel="pullrequests">Pull Requests</button>
            <button class="tc-gh-sub-tab" data-ghpanel="branch">Branch</button>
          </div>
          <div id="tc-gh-panel-workflows" class="tc-gh-panel">
            <div class="tc-gh-toolbar">
              <span id="tc-gh-wf-count" class="tc-gh-count"></span>
              <button id="tc-gh-refresh-wf" class="tc-gh-icon-btn" title="Refresh workflows"><svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.001 7.001 0 0 1 14.95 7.16a.75.75 0 1 1-1.489.18A5.501 5.501 0 0 0 8 2.5M1.705 8.005a.75.75 0 0 1 .834.656 5.501 5.501 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.001 7.001 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834z"/></svg></button>
            </div>
            <div id="tc-gh-wf-list"><p class="tc-empty">Loading workflows…</p></div>
          </div>
          <div id="tc-gh-panel-issues" class="tc-gh-panel tc-pane--hidden">
            <div class="tc-gh-toolbar">
              <span id="tc-gh-issues-count" class="tc-gh-count"></span>
              <button id="tc-gh-refresh-issues" class="tc-gh-icon-btn" title="Refresh issues"><svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.001 7.001 0 0 1 14.95 7.16a.75.75 0 1 1-1.489.18A5.501 5.501 0 0 0 8 2.5M1.705 8.005a.75.75 0 0 1 .834.656 5.501 5.501 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.001 7.001 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834z"/></svg></button>
            </div>
            <div id="tc-gh-issues-list"><p class="tc-empty">Loading issues…</p></div>
          </div>
          <div id="tc-gh-panel-pullrequests" class="tc-gh-panel tc-pane--hidden">
            <div class="tc-gh-field">
              <label class="tc-gh-label">Base Branch</label>
              <select class="tc-input" id="tc-gh-pr-base"><option value="">Loading…</option></select>
            </div>
            <div class="tc-gh-field">
              <label class="tc-gh-label">Compare Branch</label>
              <select class="tc-input" id="tc-gh-pr-head"><option value="">Select compare…</option></select>
            </div>
            <div class="tc-gh-field">
              <label class="tc-gh-label">PR Title</label>
              <input class="tc-input" id="tc-gh-pr-title" type="text" placeholder="feat: implement feature" />
            </div>
            <div class="tc-gh-field">
              <label class="tc-gh-label">Description <span style="color:var(--tc-text3);font-weight:400">(optional)</span></label>
              <textarea class="tc-input tc-gh-textarea" id="tc-gh-pr-body" rows="3" placeholder="Describe the changes…"></textarea>
            </div>
            <button class="tc-btn tc-btn--primary tc-btn--full" id="tc-gh-create-pr">
              <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25m5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354M3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5m0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5m8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0"/></svg>
              Create Pull Request
            </button>
            <div class="tc-gh-divider">Open Pull Requests</div>
            <div id="tc-gh-pr-list"><p class="tc-empty">Loading PRs…</p></div>
          </div>
          <div id="tc-gh-panel-branch" class="tc-gh-panel tc-pane--hidden">
            <div class="tc-gh-field">
              <label class="tc-gh-label">New Branch Name</label>
              <input class="tc-input" id="tc-gh-new-branch" type="text" placeholder="feat/ticket-id-short-desc" spellcheck="false" />
            </div>
            <div class="tc-gh-field">
              <label class="tc-gh-label">Source Branch</label>
              <select class="tc-input" id="tc-gh-branch-base"><option value="">Loading…</option></select>
            </div>
            <button class="tc-btn tc-btn--primary tc-btn--full" id="tc-gh-create-branch">Create Branch</button>
          </div>
        </div>
      </div>

      <div class="tc-btn-row-split tc-mt">
        <button class="tc-btn tc-btn--outline tc-btn--full" id="tc-reanalyze">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.001 7.001 0 0 1 14.95 7.16a.75.75 0 1 1-1.489.18A5.501 5.501 0 0 0 8 2.5M1.705 8.005a.75.75 0 0 1 .834.656 5.501 5.501 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.001 7.001 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834z"/></svg>
          Re-analyze Ticket
        </button>
        <button class="tc-btn tc-btn--ghost tc-btn--icon" id="tc-clear-cache" title="Clear cached analysis for this ticket">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.748 1.748 0 0 1 10.595 15h-5.19a1.748 1.748 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15ZM6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25Z"/></svg>
        </button>
      </div>
    `;

    // Tab switching (scoped to panel body)
    body.querySelectorAll('.tc-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        body.querySelectorAll('.tc-tab').forEach((t) => t.classList.remove('tc-tab--active'));
        body.querySelectorAll('.tc-pane').forEach((p) => p.classList.add('tc-pane--hidden'));
        tab.classList.add('tc-tab--active');
        document.getElementById(`tc-pane-${tab.dataset.pane}`)?.classList.remove('tc-pane--hidden');
        if (tab.dataset.pane === 'github') initSidePanelGitHub();
      });
    });

    // Auto-switch to pending tab (e.g. Workflows when opened via FAB)
    if (pendingPanelTab) {
      switchPanelTab(pendingPanelTab);
      pendingPanelTab = null;
    }

    // Task checkboxes
    body.querySelectorAll('.tc-task-check').forEach((cb) => {
      cb.addEventListener('change', () => handleTaskToggle(cb, analysis));
    });

    // Copy skill file
    document.getElementById('tc-copy-skill')?.addEventListener('click', () => {
      navigator.clipboard.writeText(analysis.skillFileContent || '');
      showToast('Copied to clipboard!');
    });

    // Download skill file
    document.getElementById('tc-dl-skill')?.addEventListener('click', () => {
      downloadText(
        analysis.skillFileContent || '',
        `${sanitizeFilename(analysis.skillFileName || 'feature')}.md`
      );
      showToast('Skill file downloaded!');
    });

    // Regenerate skill file (force fresh analysis)
    document.getElementById('tc-regen-skill')?.addEventListener('click', () => {
      showToast('Regenerating skill file…');
      const panel = document.getElementById('tc-panel');
      if (panel) startAnalysis(panel, true);
    });

    // Copy suggestion code buttons
    body.querySelectorAll('.tc-copy-snippet').forEach((btn) => {
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(btn.dataset.code || '');
        showToast('Snippet copied!');
      });
    });

    // Re-analyze
    document.getElementById('tc-reanalyze')?.addEventListener('click', () => {
      const panel = document.getElementById('tc-panel');
      if (panel) startAnalysis(panel, true);
    });

    // Clear cache
    document.getElementById('tc-clear-cache')?.addEventListener('click', async () => {
      if (!ticketData) return;
      const key = getCacheKey(ticketData);
      await new Promise((r) => chrome.storage.local.remove([key], r));
      showToast('Cache cleared!');
      const panel = document.getElementById('tc-panel');
      if (panel) startAnalysis(panel, true);
    });
  }

  function buildCodebaseHtml(codebase) {
    if (!codebase || (!codebase.stack.length && !codebase.languages.length)) return '';
    const langTags = codebase.languages.slice(0, 5).map((l) =>
      `<span class="tc-cb-tag tc-cb-tag--lang">${escHtml(l.lang)} <small>${l.pct}%</small></span>`
    ).join('');
    const stackTags = codebase.stack.map((s) =>
      `<span class="tc-cb-tag tc-cb-tag--fw">${escHtml(s)}</span>`
    ).join('');
    const fileTypeTags = (codebase.fileTypes || []).slice(0, 10).map((ft) =>
      `<span class="tc-cb-tag tc-cb-tag--ft">${escHtml(ft)}</span>`
    ).join('');
    return `
      <div class="tc-codebase-section">
        <div class="tc-codebase-header">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="#8b949e"><path d="M4.72 3.22a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 0 1 0 1.06l-3.25 3.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L7.44 7 4.72 4.28a.75.75 0 0 1 0-1.06m4.25 7.5a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 0 1.5h-2.5a.75.75 0 0 1-.75-.75"/></svg>
          <span class="tc-codebase-title">Detected Tech Stack</span>
        </div>
        <div class="tc-codebase-info">
          ${langTags ? `<div class="tc-cb-row"><span class="tc-cb-label">Languages</span><div class="tc-cb-tags">${langTags}</div></div>` : ''}
          ${stackTags ? `<div class="tc-cb-row"><span class="tc-cb-label">Frameworks & Tools</span><div class="tc-cb-tags">${stackTags}</div></div>` : ''}
          ${fileTypeTags ? `<div class="tc-cb-row"><span class="tc-cb-label">File Types</span><div class="tc-cb-tags">${fileTypeTags}</div></div>` : ''}
        </div>
      </div>`;
  }

  function buildRepoSkillsHtml(files) {
    if (!files || !files.length) return '';
    const items = files.map((f) => `
      <details class="tc-repo-skill-item">
        <summary class="tc-repo-skill-path">
          <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" style="color:#8b949e;flex-shrink:0"><path d="M3.75 1.5a.25.25 0 0 0-.25.25v11.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25V6H9.75A1.75 1.75 0 0 1 8 4.25V1.5Zm5.75.56v2.19c0 .138.112.25.25.25h2.19ZM2 1.75C2 .784 2.784 0 3.75 0h5.086c.464 0 .909.184 1.237.513l3.414 3.414c.329.328.513.773.513 1.237v8.086A1.75 1.75 0 0 1 12.25 15h-8.5A1.75 1.75 0 0 1 2 13.25Z"/></svg>
          ${escHtml(f.path)}
        </summary>
        <pre class="tc-repo-skill-content">${escHtml(f.content)}</pre>
      </details>`).join('');
    return `
      <div class="tc-repo-skills-section">
        <div class="tc-repo-skills-header">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="#8b949e"><path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8z"/></svg>
          <span class="tc-repo-skills-title">Repo Skill Files</span>
        </div>
        ${items}
      </div>`;
  }

  function renderTask(task) {
    const isDone = task.status === 'done';
    const priorityMap = { high: '#f85149', medium: '#d29922', low: '#3fb950' };
    const pColor = priorityMap[task.priority] || '#8b949e';
    return `
      <div class="tc-task${isDone ? ' tc-task--done' : ''}" data-id="${escHtml(task.id)}">
        <label class="tc-check-wrap">
          <input type="checkbox" class="tc-task-check"${isDone ? ' checked' : ''} />
          <span class="tc-checkmark"></span>
        </label>
        <div class="tc-task-body">
          <div class="tc-task-meta">
            <span class="tc-task-id">${escHtml(task.id)}</span>
            <span class="tc-task-prio" style="color:${pColor}">${escHtml(task.priority || 'medium')}</span>
          </div>
          <div class="tc-task-title">${escHtml(task.title)}</div>
          <div class="tc-task-desc">${escHtml(task.description)}</div>
        </div>
      </div>`;
  }

  function renderSuggestion(s) {
    const safeCode = escHtml(s.code || '');
    const rawCode = (s.code || '').replace(/"/g, '&quot;');
    return `
      <div class="tc-suggestion">
        <div class="tc-suggestion-header">
          <span class="tc-suggestion-title">${escHtml(s.title)}</span>
          <span class="tc-lang-badge">${escHtml(s.language || 'code')}</span>
        </div>
        <p class="tc-suggestion-desc">${escHtml(s.description)}</p>
        <div class="tc-code-wrap">
          <button class="tc-copy-snippet tc-btn tc-btn--xs" data-code="${rawCode}" title="Copy snippet">
            <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>
            Copy
          </button>
          <pre class="tc-code-block"><code>${safeCode}</code></pre>
        </div>
      </div>`;
  }

  // ── Task toggle ─────────────────────────────────────────────
  function handleTaskToggle(cb, analysis) {
    const taskEl = cb.closest('.tc-task');
    if (!taskEl) return;
    const done = cb.checked;
    taskEl.classList.toggle('tc-task--done', done);

    const id = taskEl.dataset.id;
    const allTasks = [...(analysis.uiTasks || []), ...(analysis.devTasks || [])];
    const task = allTasks.find((t) => t.id === id);
    if (task) task.status = done ? 'done' : 'pending';

    // Persist all task states so popup stays in sync
    if (ticketData) {
      const states = {};
      allTasks.forEach((t) => { states[t.id] = t.status; });
      saveTaskStates(ticketData, states);
    }

    const uiDone = (analysis.uiTasks || []).filter((t) => t.status === 'done').length;
    const devDone = (analysis.devTasks || []).filter((t) => t.status === 'done').length;
    const uiProg = document.getElementById('tc-ui-progress');
    const devProg = document.getElementById('tc-dev-progress');
    if (uiProg) uiProg.textContent = `${uiDone}/${(analysis.uiTasks || []).length} done`;
    if (devProg) devProg.textContent = `${devDone}/${(analysis.devTasks || []).length} done`;
  }
  // ── Side Panel GitHub Section ──────────────────────────────────

  async function initSidePanelGitHub() {
    if (spGh.loaded) return;
    spGh.loaded = true;
    const items = await new Promise((r) =>
      chrome.storage.sync.get(['githubToken', 'linkedRepo'], r)
    );
    spGh.token = items.githubToken || '';
    if (!spGh.token) {
      spShowState('noToken');
      document.getElementById('tc-gh-open-settings')?.addEventListener('click', () =>
        chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' })
      );
      return;
    }
    if (ticketData?.owner && ticketData?.repo) {
      spGh.owner = ticketData.owner;
      spGh.repo = ticketData.repo;
    } else if (!spGh.owner && items.linkedRepo) {
      const p = items.linkedRepo.split('/');
      spGh.owner = p[0] || '';
      spGh.repo = p[1] || '';
    }
    if (!spGh.owner || !spGh.repo) { spShowState('picker'); spLoadRepoPicker(); return; }
    spLoadRepoContent();
  }

  function spShowState(state) {
    document.getElementById('tc-gh-no-token')?.classList.toggle('tc-pane--hidden', state !== 'noToken');
    document.getElementById('tc-gh-picker')?.classList.toggle('tc-pane--hidden', state !== 'picker');
    document.getElementById('tc-gh-content')?.classList.toggle('tc-pane--hidden', state !== 'content');
  }

  async function spLoadRepoPicker() {
    spShowState('picker');
    const list = document.getElementById('tc-gh-repo-list');
    const search = document.getElementById('tc-gh-repo-search');
    list.innerHTML = '<p class="tc-empty">Loading…</p>';
    search.value = '';
    search.oninput = () => spRenderRepoPicker(search.value);
    try {
      const data = await spGhJSON('/user/repos?type=all&per_page=100&sort=updated');
      spGh.allRepos = (Array.isArray(data) ? data : []).map((r) => ({
        full_name: r.full_name, private: r.private, language: r.language || '',
      }));
      spRenderRepoPicker('');
      setTimeout(() => search.focus(), 80);
    } catch (err) {
      list.innerHTML = `<p class="tc-empty" style="color:#f85149">${escHtml(err.message)}</p>`;
    }
  }

  function spRenderRepoPicker(query) {
    const list = document.getElementById('tc-gh-repo-list');
    const q = query.toLowerCase().trim();
    const filtered = q
      ? spGh.allRepos.filter((r) => r.full_name.toLowerCase().includes(q))
      : spGh.allRepos;
    if (!filtered.length) {
      list.innerHTML = `<p class="tc-empty">${q ? 'No matching repositories.' : 'No repositories found.'}</p>`;
      return;
    }
    list.innerHTML = filtered.slice(0, 60).map((r) =>
      `<button class="tc-gh-repo-item" data-full="${escHtml(r.full_name)}">
        <span class="tc-gh-repo-item-name">${escHtml(r.full_name)}</span>
        ${r.private ? '<span class="tc-gh-badge-priv">private</span>' : ''}
        ${r.language ? `<span class="tc-gh-lang">${escHtml(r.language)}</span>` : ''}
      </button>`
    ).join('');
    list.querySelectorAll('.tc-gh-repo-item').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const parts = btn.dataset.full.split('/');
        spGh.owner = parts[0] || '';
        spGh.repo = parts[1] || '';
        await new Promise((r) => chrome.storage.sync.set({ linkedRepo: btn.dataset.full }, r));
        spLoadRepoContent();
      });
    });
  }

  async function spLoadRepoContent() {
    spShowState('content');
    document.getElementById('tc-gh-repo-name').textContent = `${spGh.owner}/${spGh.repo}`;
    document.querySelectorAll('.tc-gh-sub-tab').forEach((tab) => {
      tab.onclick = () => {
        document.querySelectorAll('.tc-gh-sub-tab').forEach((t) => t.classList.remove('tc-gh-sub-tab--act'));
        document.querySelectorAll('.tc-gh-panel').forEach((p) => p.classList.add('tc-pane--hidden'));
        tab.classList.add('tc-gh-sub-tab--act');
        document.getElementById(`tc-gh-panel-${tab.dataset.ghpanel}`)?.classList.remove('tc-pane--hidden');
      };
    });
    document.getElementById('tc-gh-change-repo').onclick = () => {
      spGh.loaded = false; spGh.owner = ''; spGh.repo = '';
      spLoadRepoPicker();
    };
    document.getElementById('tc-gh-refresh-wf').onclick = () => spLoadWfList();
    document.getElementById('tc-gh-refresh-issues').onclick = () => spLoadIssueList();
    document.getElementById('tc-gh-create-branch').onclick = () => spCreateBranch();
    document.getElementById('tc-gh-create-pr').onclick = () => spCreatePR();
    // Show create issue button if analysis exists
    if (ticketData?._analysis) {
      document.getElementById('tc-gh-issue-action-bar')?.classList.remove('tc-pane--hidden');
      document.getElementById('tc-gh-create-issue').onclick = () => spShowIssueConfirm();
    }
    await Promise.all([spLoadBranches(), spLoadWfList(), spLoadIssueList(), spLoadPRs()]);
    spPrefillPR();
    const suggested = ticketData?._analysis?.suggestedBranch;
    if (suggested) {
      const inp = document.getElementById('tc-gh-new-branch');
      if (inp && !inp.value) inp.value = suggested;
    }
  }

  async function spLoadBranches() {
    try {
      const all = [];
      let page = 1;
      while (true) {
        const data = await spGhJSON(`/repos/${spGh.owner}/${spGh.repo}/branches?per_page=100&page=${page}`);
        if (!Array.isArray(data) || !data.length) break;
        all.push(...data.map((b) => b.name));
        if (data.length < 100) break;
        page++;
      }
      const repoData = await spGhJSON(`/repos/${spGh.owner}/${spGh.repo}`);
      spGh.branches = all;
      const repoDef = repoData.default_branch || '';
      spGh.defaultBranch = spGh.branches.includes('master') ? 'master'
        : spGh.branches.includes(repoDef) ? repoDef
        : spGh.branches[0] || 'master';
      const buildOpts = (placeholder, preselect) =>
        `<option value="">${placeholder}</option>` +
        spGh.branches.map((b) =>
          `<option value="${escHtml(b)}"${b === preselect ? ' selected' : ''}>${escHtml(b)}</option>`
        ).join('');
      const selBase = document.getElementById('tc-gh-branch-base');
      if (selBase) selBase.innerHTML = buildOpts('Select source\u2026', spGh.defaultBranch);
      const selPrBase = document.getElementById('tc-gh-pr-base');
      if (selPrBase) selPrBase.innerHTML = buildOpts('Select base\u2026', spGh.defaultBranch);
      const selPrHead = document.getElementById('tc-gh-pr-head');
      if (selPrHead) selPrHead.innerHTML = buildOpts('Select compare\u2026', '');
    } catch (err) { showToast(`Branches: ${err.message}`); }
  }

  async function spLoadWfList() {
    const list = document.getElementById('tc-gh-wf-list');
    const countEl = document.getElementById('tc-gh-wf-count');
    if (!list) return;
    list.innerHTML = '<p class="tc-empty">Loading workflows…</p>';
    try {
      const data = await spGhJSON(`/repos/${spGh.owner}/${spGh.repo}/actions/workflows?per_page=100`);
      const wfs = data.workflows || [];
      if (countEl) countEl.textContent = `${wfs.length} workflow${wfs.length === 1 ? '' : 's'}`;
      if (!wfs.length) { list.innerHTML = '<p class="tc-empty">No workflows found.</p>'; return; }
      list.innerHTML = '';
      wfs.forEach((wf) => { const c = spBuildWfCard(wf); list.appendChild(c); spLoadWfLastRun(wf.id, c); });
    } catch (err) {
      list.innerHTML = `<p class="tc-empty" style="color:#f85149">${escHtml(err.message)}</p>`;
    }
  }

  function spBuildWfCard(wf) {
    const fileName = wf.path.split('/').pop();
    const isActive = wf.state === 'active';
    const opts = spGh.branches
      .map((b) => `<option value="${escHtml(b)}"${b === spGh.defaultBranch ? ' selected' : ''}>${escHtml(b)}</option>`)
      .join('');
    const card = document.createElement('div');
    card.className = 'tc-gh-wf-card';
    card.dataset.wfId = String(wf.id);
    card.innerHTML = `
      <div class="tc-gh-wf-header">
        <div class="tc-gh-wf-info">
          <span class="tc-gh-wf-name">${escHtml(wf.name)}</span>
          <span class="tc-gh-wf-file">${escHtml(fileName)}</span>
        </div>
        <span class="tc-gh-wf-badge ${isActive ? 'tc-gh-wf-badge--on' : 'tc-gh-wf-badge--off'}">${isActive ? 'ACTIVE' : 'OFF'}</span>
      </div>
      <div class="tc-gh-wf-run tc-pane--hidden">
        Last run: <span class="tc-gh-run-status"></span> <span class="tc-gh-run-time"></span>
      </div>
      <div class="tc-gh-wf-footer">
        <select class="tc-input tc-gh-wf-branch-sel"><option value="">Select branch…</option>${opts}</select>
        <button class="tc-btn tc-btn--sm tc-btn--primary tc-gh-run-btn"${isActive ? '' : ' disabled'}>
          <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0M1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0m4.879-2.773 4.264 2.559a.25.25 0 0 1 0 .428l-4.264 2.559A.25.25 0 0 1 6 10.559V5.442a.25.25 0 0 1 .379-.215"/></svg> Run
        </button>
      </div>`;
    card.querySelector('.tc-gh-run-btn').addEventListener('click', () => {
      const branch = card.querySelector('.tc-gh-wf-branch-sel').value;
      if (!branch) { showToast('Select a branch first.'); return; }
      spTriggerWorkflow(wf.id, wf.name, branch, card);
    });
    return card;
  }

  async function spTriggerWorkflow(wfId, wfName, branch, card) {
    const btn = card.querySelector('.tc-gh-run-btn');
    btn.disabled = true;
    try {
      const res = await fetch(
        `https://api.github.com/repos/${spGh.owner}/${spGh.repo}/actions/workflows/${wfId}/dispatches`,
        { method: 'POST', headers: { Authorization: `Bearer ${spGh.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: branch }) }
      );
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.message || `Dispatch failed (${res.status})`); }
      showToast(`“${wfName}” triggered on ${branch}!`);
      setTimeout(() => spLoadWfLastRun(wfId, card), 4000);
    } catch (err) { showToast(`Trigger failed: ${err.message}`); }
    finally { btn.disabled = false; }
  }

  async function spLoadWfLastRun(wfId, card) {
    try {
      card = card || document.querySelector(`[data-wf-id="${wfId}"]`);
      if (!card) return;
      const data = await spGhJSON(`/repos/${spGh.owner}/${spGh.repo}/actions/workflows/${wfId}/runs?per_page=1`);
      const run = data.workflow_runs?.[0];
      if (!run) return;
      const el = card.querySelector('.tc-gh-wf-run');
      if (!el) return;
      el.classList.remove('tc-pane--hidden');
      const colors = { success: '#3fb950', failure: '#f85149', in_progress: '#d29922', cancelled: '#8b949e' };
      const statusEl = card.querySelector('.tc-gh-run-status');
      statusEl.textContent = run.conclusion || run.status;
      statusEl.style.color = colors[run.conclusion || run.status] || '#8b949e';
      card.querySelector('.tc-gh-run-time').textContent = spRelTime(run.updated_at);
    } catch { /* silent */ }
  }

  async function spLoadIssueList() {
    const list = document.getElementById('tc-gh-issues-list');
    const countEl = document.getElementById('tc-gh-issues-count');
    if (!list) return;
    list.innerHTML = '<p class="tc-empty">Loading issues…</p>';
    try {
      const issues = await spGhJSON(
        `/repos/${spGh.owner}/${spGh.repo}/issues?state=open&per_page=50&sort=updated&direction=desc`
      );
      const real = issues.filter((i) => !i.pull_request);
      if (countEl) countEl.textContent = `${real.length} open issue${real.length === 1 ? '' : 's'}`;
      if (!real.length) { list.innerHTML = '<p class="tc-empty">No open issues.</p>'; return; }
      list.innerHTML = '';
      real.forEach((issue) => {
        const el = document.createElement('a');
        el.className = 'tc-gh-issue-row';
        el.href = issue.html_url;
        el.target = '_blank';
        el.rel = 'noopener noreferrer';
        const labels = (issue.labels || []).slice(0, 3)
          .map((l) => `<span class="tc-gh-issue-lbl" style="background:#${l.color}22;color:#${l.color};border-color:#${l.color}55">${escHtml(l.name)}</span>`)
          .join('');
        el.innerHTML = `
          <div class="tc-gh-issue-main">
            <span class="tc-gh-issue-num">#${issue.number}</span>
            <span class="tc-gh-issue-ttl">${escHtml(issue.title)}</span>
          </div>
          <div class="tc-gh-issue-meta">
            <span class="tc-gh-issue-lbls">${labels}</span>
            <span class="tc-gh-issue-time">${spRelTime(issue.updated_at)}</span>
          </div>`;
        list.appendChild(el);
      });
    } catch (err) {
      list.innerHTML = `<p class="tc-empty" style="color:#f85149">${escHtml(err.message)}</p>`;
    }
  }

  async function spCreateBranch() {
    const name = document.getElementById('tc-gh-new-branch')?.value.trim();
    const base = document.getElementById('tc-gh-branch-base')?.value;
    if (!name) { showToast('Enter a branch name.'); return; }
    if (!base) { showToast('Select a source branch.'); return; }
    const btn = document.getElementById('tc-gh-create-branch');
    btn.disabled = true; btn.textContent = 'Creating\u2026';
    try {
      const refData = await spGhJSON(`/repos/${spGh.owner}/${spGh.repo}/git/ref/heads/${encodeURIComponent(base)}`);
      const sha = refData.object.sha;
      const res = await fetch(`https://api.github.com/repos/${spGh.owner}/${spGh.repo}/git/refs`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${spGh.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: `refs/heads/${name}`, sha }),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.message || `Failed (${res.status})`); }
      showToast(`Branch created: ${name} from ${base}`);
      document.getElementById('tc-gh-new-branch').value = '';
      await spLoadBranches();
      const selHead = document.getElementById('tc-gh-pr-head');
      if (selHead) selHead.value = name;
    } catch (err) { showToast(`Failed: ${err.message}`); }
    finally { btn.disabled = false; btn.textContent = 'Create Branch'; }
  }

  async function spLoadPRs() {
    const list = document.getElementById('tc-gh-pr-list');
    if (!list) return;
    list.innerHTML = '<p class="tc-empty">Loading PRs\u2026</p>';
    try {
      const prs = await spGhJSON(
        `/repos/${spGh.owner}/${spGh.repo}/pulls?state=open&per_page=30&sort=updated&direction=desc`
      );
      if (!prs.length) { list.innerHTML = '<p class="tc-empty">No open pull requests.</p>'; return; }
      list.innerHTML = '';
      prs.forEach((pr) => {
        const el = document.createElement('div');
        el.className = 'tc-gh-pr-item';
        el.innerHTML = `
          <div class="tc-gh-pr-main">
            <span class="tc-gh-pr-num">#${pr.number}</span>
            <a class="tc-gh-pr-title-link" href="${escHtml(pr.html_url)}" target="_blank" rel="noopener noreferrer">${escHtml(pr.title)}</a>
          </div>
          <div class="tc-gh-pr-meta">
            <span class="tc-gh-pr-branch">${escHtml(pr.head.ref)}</span>
            <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor"><path d="M8.22 2.97a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l2.97-2.97H3.75a.75.75 0 0 1 0-1.5h7.44L8.22 4.03a.75.75 0 0 1 0-1.06"/></svg>
            <span class="tc-gh-pr-branch">${escHtml(pr.base.ref)}</span>
            <span class="tc-gh-pr-author">by ${escHtml(pr.user.login)}</span>
          </div>`;
        list.appendChild(el);
      });
    } catch (err) {
      list.innerHTML = `<p class="tc-empty" style="color:#f85149">${escHtml(err.message)}</p>`;
    }
  }

  async function spCreatePR() {
    const base = document.getElementById('tc-gh-pr-base')?.value;
    const head = document.getElementById('tc-gh-pr-head')?.value;
    const title = document.getElementById('tc-gh-pr-title')?.value.trim();
    const prBody = document.getElementById('tc-gh-pr-body')?.value.trim() || '';
    if (!base || !head) { showToast('Select base and compare branches.'); return; }
    if (base === head) { showToast('Base and compare branches must differ.'); return; }
    if (!title) { showToast('PR title is required.'); return; }
    const btn = document.getElementById('tc-gh-create-pr');
    btn.disabled = true; btn.textContent = 'Creating\u2026';
    try {
      const res = await fetch(`https://api.github.com/repos/${spGh.owner}/${spGh.repo}/pulls`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${spGh.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body: prBody, head, base }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `Failed (${res.status})`);
      showToast(`PR #${data.number} created!`);
      document.getElementById('tc-gh-pr-title').value = '';
      document.getElementById('tc-gh-pr-body').value = '';
      await spLoadPRs();
    } catch (err) { showToast(`Create PR failed: ${err.message}`); }
    finally { btn.disabled = false; btn.textContent = 'Create Pull Request'; }
  }

  function spPrefillPR() {
    if (!ticketData?._analysis) return;
    const analysis = ticketData._analysis;
    const typePrefix = { bug: 'fix', feature: 'feat', improvement: 'feat', chore: 'chore', refactor: 'refactor', documentation: 'docs' };
    const prefix = typePrefix[analysis.ticketType] || 'feat';
    const titleEl = document.getElementById('tc-gh-pr-title');
    if (titleEl && !titleEl.value) titleEl.value = `${prefix}: ${ticketData.title || ''}`.slice(0, 100);
    const bodyEl = document.getElementById('tc-gh-pr-body');
    if (bodyEl && !bodyEl.value && ticketData.url) {
      const ref = ticketData.id ? `${ticketData.id}: ` : '';
      bodyEl.value = `${ref}${ticketData.url}`;
    }
  }

  function spShowIssueConfirm() {
    const bar = document.getElementById('tc-gh-issue-action-bar');
    if (!bar) return;
    bar.innerHTML = `
      <span class="tc-gh-issue-confirm-msg">Create issue in <strong>${escHtml(spGh.owner)}/${escHtml(spGh.repo)}</strong>?</span>
      <div class="tc-gh-issue-confirm-btns">
        <button id="tc-gh-issue-confirm-yes" class="tc-btn tc-btn--sm tc-btn--primary">Yes, create</button>
        <button id="tc-gh-issue-confirm-no" class="tc-btn tc-btn--sm tc-btn--outline">Cancel</button>
      </div>`;
    document.getElementById('tc-gh-issue-confirm-yes').onclick = () => spCreateIssue();
    document.getElementById('tc-gh-issue-confirm-no').onclick = () => spResetIssueBar();
  }

  function spResetIssueBar() {
    const bar = document.getElementById('tc-gh-issue-action-bar');
    if (!bar) return;
    bar.innerHTML = `
      <button class="tc-btn tc-btn--sm tc-btn--primary tc-btn--full" id="tc-gh-create-issue">
        <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"/><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0zM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0z"/></svg>
        Create GitHub Issue
      </button>`;
    document.getElementById('tc-gh-create-issue').onclick = () => spShowIssueConfirm();
  }

  async function spCreateIssue() {
    const bar = document.getElementById('tc-gh-issue-action-bar');
    if (!bar) return;
    bar.innerHTML = `<span class="tc-gh-issue-confirm-msg">Creating…</span>`;
    bar.style.pointerEvents = 'none';

    const analysis = ticketData?._analysis;
    if (!analysis) { showToast('No analysis data.'); spResetIssueBar(); return; }

    const typeLabels = { bug: 'bug', feature: 'enhancement', improvement: 'enhancement', documentation: 'documentation', chore: 'enhancement', refactor: 'enhancement' };
    const label = typeLabels[analysis.ticketType] || 'enhancement';
    const title = ticketData.title
      ? `[${ticketData.id || ticketData.platform}] ${ticketData.title}`
      : `Ticket ${ticketData.id || ''}`.trim();
    const body = analysis.issueBody || spBuildFallbackIssueBody(analysis, ticketData);
    const headers = { Authorization: `Bearer ${spGh.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' };

    try {
      // Step 1: Create the issue
      const res = await fetch(`https://api.github.com/repos/${spGh.owner}/${spGh.repo}/issues`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ title, body, labels: [label] }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 401) throw new Error('Invalid or expired token.');
        if (res.status === 403) throw new Error('Token lacks permission. Ensure it has "repo" scope.');
        if (res.status === 404) throw new Error('Repository not found.');
        if (res.status === 410) throw new Error('Issues are disabled for this repository.');
        throw new Error(data.message || `GitHub API error ${res.status}`);
      }

      bar.style.pointerEvents = '';
      bar.classList.add('tc-pane--hidden');
      const banner = document.getElementById('tc-gh-issue-created');
      banner?.classList.remove('tc-pane--hidden');
      const link = document.getElementById('tc-gh-issue-link');
      if (link) { link.href = data.html_url; link.textContent = `#${data.number} — ${data.title}`; }

      showToast(`Issue #${data.number} created!`);
      spLoadIssueList();
    } catch (err) {
      showToast(`Failed: ${err.message}`);
      bar.style.pointerEvents = '';
      spResetIssueBar();
    }
  }

  function spBuildFallbackIssueBody(analysis, td) {
    const uiList = (analysis.uiTasks || []).map((t) => `- [ ] **${t.id} ${t.title}** [${t.priority || 'medium'}]: ${t.description}`).join('\n') || '- [ ] No UI tasks';
    const devList = (analysis.devTasks || []).map((t) => `- [ ] **${t.id} ${t.title}** [${t.priority || 'medium'}]: ${t.description}`).join('\n') || '- [ ] No dev tasks';
    const ref = td.url ? `[${td.id || 'Ticket'}](${td.url})` : td.id || 'N/A';
    const qaList = td.qaAcceptance
      ? td.qaAcceptance.split(/\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.startsWith('-') ? `${l}` : `- ${l}`).join('\n')
      : '- All tasks above are completed and reviewed\n- Code follows project conventions\n- No regressions introduced';
    return `### Summary\n${analysis.summary}\n\n### Ticket Context\n- **Type**: ${analysis.ticketType}\n- **Complexity**: ${analysis.complexity}\n- **Feature**: ${analysis.featureType}${td.keyDetails ? `\n- **Key Details**: ${td.keyDetails}` : ''}\n\n### Constraints & Rules\n${td.devNotes ? `- Developer Notes: ${td.devNotes}` : '- Follow existing project conventions'}${td.scope ? `\n- Scope: ${td.scope}` : ''}\n\n### Tasks\n**UI Tasks**\n${uiList}\n\n**Dev Tasks**\n${devList}\n\n### QA Acceptance\n${qaList}\n\n### Edge Cases\n- Handle empty / null data gracefully\n- Validate user inputs at system boundaries\n- Consider loading and error states\n\n### Testing Strategy\n- Unit tests for new business logic\n- Integration tests for API / data layer changes\n- Manual verification against QA acceptance criteria\n\n### References\n- Ticket: ${ref}\n- Suggested branch: \`${analysis.suggestedBranch || 'feat/implementation'}\`\n\n> This issue was generated by Ticket Analyser.`;
  }

  function spGhJSON(path) {
    return fetch(`https://api.github.com${path}`, {
      headers: { Authorization: `Bearer ${spGh.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    }).then(async (res) => {
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 401) throw new Error('Invalid or expired token.');
        if (res.status === 403) throw new Error('Access denied. Check token scopes.');
        if (res.status === 404) throw new Error('Repository not found.');
        throw new Error(data.message || `GitHub API error ${res.status}`);
      }
      return data;
    });
  }

  function spRelTime(isoStr) {
    const diff = Date.now() - new Date(isoStr).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return d < 30 ? `${d}d ago` : new Date(isoStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  // ── Utility helpers ─────────────────────────────────────────
  function extractFigmaUrls(text) {
    return [...new Set(
      (text.match(/https:\/\/(?:www\.)?figma\.com\/(?:file|design)\/[^\s"<>)]+/g) || [])
    )];
  }

  function extractSection(text, headingPattern) {
    const re = new RegExp(
      `(?:^|\\n)#+\\s*(?:${headingPattern})\\s*\\n([\\s\\S]*?)(?=\\n#+\\s|$)`,
      'i'
    );
    return (text.match(re)?.[1] || '').trim();
  }

  function guessTypeFromTitle(title) {
    const t = (title || '').toLowerCase();
    if (/\bfix\b|\bbug\b|\bcrash\b|\berror\b/.test(t)) return 'bug';
    if (/\badd\b|\bnew\b|\bfeature\b|\bimplement\b/.test(t)) return 'feature';
    if (/\bimprove\b|\bupdate\b|\brefactor\b/.test(t)) return 'improvement';
    return 'feature';
  }

  function escHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function sanitizeFilename(name) {
    return String(name)
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '');
  }

  function downloadText(content, filename) {
    const blob = new Blob([content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function showToast(msg) {
    let toast = document.getElementById('tc-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'tc-toast';
      toast.className = 'tc-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('tc-toast--show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('tc-toast--show'), 3000);
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  // ── Messages from popup ─────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'GET_TICKET_DATA') {
      sendResponse(extractTicketData());
      return true;
    }
  });
})();
