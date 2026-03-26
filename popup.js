/* ================================================================
   Ticket Analyser — Popup Logic
   ================================================================ */

document.addEventListener('DOMContentLoaded', init);

const $ = (s) => document.querySelector(s);

// ── State ────────────────────────────────────────────────────
let currentAnalysis = null;
let currentTicket = null;
let ghTabInitialized = false;

// ── Boot ─────────────────────────────────────────────────────
async function init() {
  $('#btnSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('#btnRetry').addEventListener('click', () => runAnalysis(false));
  $('#btnReanalyze').addEventListener('click', () => runAnalysis(true));
  $('#btnClearCache').addEventListener('click', async () => {
    if (!currentTicket) return;
    const key = getCacheKey(currentTicket);
    await new Promise((r) => chrome.storage.local.remove([key], r));
    toast('Cache cleared', 'success');
    runAnalysis(true);
  });
  $('#btnOpenSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  wireUpTabs();

  // If opened via FAB within the last 5 seconds, always fetch fresh data
  const { forceRefresh, tab } = await consumeFabFlag();
  await runAnalysis(forceRefresh);
  if (tab) switchToTab(tab);
}

function consumeFabFlag() {
  return new Promise((resolve) => {
    chrome.storage.local.get('tc_fab_open', (items) => {
      const entry = items.tc_fab_open;
      // Support both old number format and new object format
      const ts = entry?.ts ?? (typeof entry === 'number' ? entry : null);
      const tab = entry?.tab ?? null;
      const isFresh = ts && (Date.now() - ts) < 5000;
      if (isFresh) chrome.storage.local.remove('tc_fab_open');
      resolve(isFresh ? { forceRefresh: true, tab } : { forceRefresh: false, tab: null });
    });
  });
}

// ── Task state sync (shared with side panel via storage) ─────
const TC_TASKS_PREFIX = 'tc_tasks_';

function getTasksKey(ticketData) {
  const raw = ticketData.url || `${ticketData.platform}::${ticketData.id}`;
  return TC_TASKS_PREFIX + raw.replace(/[^a-zA-Z0-9_:/-]/g, '_').slice(0, 200);
}

function loadTaskStates(ticketData) {
  return new Promise((resolve) => {
    chrome.storage.local.get(getTasksKey(ticketData), (items) => {
      resolve(items[getTasksKey(ticketData)] || {});
    });
  });
}

function saveTaskStates(ticketData, analysis) {
  const allTasks = [...(analysis.uiTasks || []), ...(analysis.devTasks || [])];
  const states = {};
  allTasks.forEach((t) => { states[t.id] = t.status; });
  chrome.storage.local.set({ [getTasksKey(ticketData)]: states });
}

function applyTaskStates(analysis, states) {
  [...(analysis.uiTasks || []), ...(analysis.devTasks || [])].forEach((t) => {
    if (t.id in states) t.status = states[t.id];
  });
}

// ── Cache peek (mirrors background.js logic) ─────────────────
const TC_CACHE_PREFIX = 'tc_cache_';
const TC_CACHE_TTL = 60 * 60 * 1000;

function getTicketCacheKey(ticketData) {
  const raw = ticketData.url || `${ticketData.platform}::${ticketData.id}`;
  return TC_CACHE_PREFIX + raw.replace(/[^a-zA-Z0-9_:/-]/g, '_').slice(0, 200);
}

function peekTicketCache(ticketData) {
  return new Promise((resolve) => {
    const key = getTicketCacheKey(ticketData);
    chrome.storage.local.get(key, (items) => {
      const entry = items[key];
      if (!entry || !entry.cachedAt || !entry.analysis) return resolve(null);
      if (Date.now() - entry.cachedAt > TC_CACHE_TTL) return resolve(null);
      resolve({ ...entry.analysis, _fromCache: true, _cachedAt: entry.cachedAt });
    });
  });
}

// ── Core flow ─────────────────────────────────────────────────
async function runAnalysis(forceRefresh = false) {
  ghTabInitialized = false;
  showState('loading');
  setLoadingMsg('Fetching ticket data…');

  // 1. Get active tab
  let [tab] = [];
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    showError('Cannot access current tab.');
    return;
  }

  // 2. Request ticket data from content script
  let ticketData;
  try {
    ticketData = await sendToContent(tab.id, { type: 'GET_TICKET_DATA' });
  } catch {
    showState('noTicket');
    return;
  }

  if (!ticketData || !ticketData.title) {
    showState('noTicket');
    return;
  }

  currentTicket = ticketData;

  // 3. Check cache first — skip AI call entirely if a fresh result exists
  if (!forceRefresh) {
    const cached = await peekTicketCache(ticketData);
    if (cached) {
      const states = await loadTaskStates(ticketData);
      applyTaskStates(cached, states);
      currentAnalysis = cached;
      renderResults(ticketData, cached);
      return;
    }
  }

  // 4. No cache — run full AI analysis
  setLoadingMsg('Analyzing ticket with AI…');

  let analysis;
  try {
    analysis = await chrome.runtime.sendMessage({
      type: 'ANALYZE_TICKET',
      payload: ticketData,
      forceRefresh,
    });
  } catch (err) {
    showError(err.message || 'Communication error.');
    return;
  }

  if (!analysis) {
    showError('No response from background service. Try closing and reopening the popup.');
    return;
  }

  if (analysis.error) {
    showError(analysis.error);
    return;
  }

  const freshStates = await loadTaskStates(ticketData);
  applyTaskStates(analysis, freshStates);
  currentAnalysis = analysis;
  renderResults(ticketData, analysis);
}

// ── Render results ────────────────────────────────────────────
function renderResults(data, analysis) {
  renderTicketCard(data, analysis);
  renderCacheBadge(analysis);

  const uiDone = (analysis.uiTasks || []).filter((t) => t.status === 'done').length;
  const devDone = (analysis.devTasks || []).filter((t) => t.status === 'done').length;
  const uiTotal = (analysis.uiTasks || []).length;
  const devTotal = (analysis.devTasks || []).length;

  // Figma notice
  if (analysis.hasFigma) {
    $('#figmaNotice').classList.remove('hidden');
  } else {
    $('#figmaNotice').classList.add('hidden');
  }

  // Progress labels
  $('#uiProgress').textContent = `${uiDone}/${uiTotal} done`;
  $('#devProgress').textContent = `${devDone}/${devTotal} done`;

  // Task lists
  renderTaskList('#uiTaskList', analysis.uiTasks || [], 'ui');
  renderTaskList('#devTaskList', analysis.devTasks || [], 'dev');

  // Detected codebase tech stack
  const cbSection = $('#codebaseSection');
  const cbInfo = $('#codebaseInfo');
  const codebase = analysis._codebase;
  if (codebase && (codebase.stack.length || codebase.languages.length)) {
    const langTags = codebase.languages.slice(0, 5).map((l) =>
      `<span class="cb-tag cb-tag--lang">${escHtml(l.lang)} <small>${l.pct}%</small></span>`
    ).join('');
    const stackTags = codebase.stack.map((s) =>
      `<span class="cb-tag cb-tag--fw">${escHtml(s)}</span>`
    ).join('');
    const fileTypeTags = (codebase.fileTypes || []).slice(0, 10).map((ft) =>
      `<span class="cb-tag cb-tag--ft">${escHtml(ft)}</span>`
    ).join('');
    cbInfo.innerHTML = `
      ${langTags ? `<div class="cb-row"><span class="cb-label">Languages</span><div class="cb-tags">${langTags}</div></div>` : ''}
      ${stackTags ? `<div class="cb-row"><span class="cb-label">Frameworks & Tools</span><div class="cb-tags">${stackTags}</div></div>` : ''}
      ${fileTypeTags ? `<div class="cb-row"><span class="cb-label">File Types</span><div class="cb-tags">${fileTypeTags}</div></div>` : ''}
    `;
    cbSection.classList.remove('hidden');
  } else {
    cbSection.classList.add('hidden');
  }

  // Repo skill files — show loaded repo files first
  const repoSection = $('#repoSkillsSection');
  const repoList = $('#repoSkillsList');
  const repoFiles = analysis._repoSkillFiles || [];
  if (repoFiles.length) {
    repoList.innerHTML = repoFiles.map((f) => `
      <details class="repo-skill-item">
        <summary class="repo-skill-path">
          <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" style="color:#8b949e;flex-shrink:0"><path d="M3.75 1.5a.25.25 0 0 0-.25.25v11.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25V6H9.75A1.75 1.75 0 0 1 8 4.25V1.5Zm5.75.56v2.19c0 .138.112.25.25.25h2.19ZM2 1.75C2 .784 2.784 0 3.75 0h5.086c.464 0 .909.184 1.237.513l3.414 3.414c.329.328.513.773.513 1.237v8.086A1.75 1.75 0 0 1 12.25 15h-8.5A1.75 1.75 0 0 1 2 13.25Z"/></svg>
          ${escHtml(f.path)}
        </summary>
        <pre class="repo-skill-content">${escHtml(f.content)}</pre>
      </details>
    `).join('');
    repoSection.classList.remove('hidden');
  } else {
    repoSection.classList.add('hidden');
  }

  // Skill File
  const fname = sanitizeFilename(analysis.skillFileName || 'feature');
  $('#skillFilename').textContent = `${fname}.md`;
  $('#skillPreview').textContent = analysis.skillFileContent || '';

  // Skill source badge
  const badge = $('#skillSourceBadge');
  if (analysis._repoSkillFilesLoaded) {
    badge.textContent = 'from repo';
    badge.className = 'skill-source-badge skill-source-repo';
  } else {
    badge.textContent = 'AI generated';
    badge.className = 'skill-source-badge skill-source-ai';
  }

  // Suggestions
  renderSuggestions(analysis.suggestions || []);

  // Wire skill file buttons
  $('#btnCopySkill').onclick = () => {
    navigator.clipboard.writeText(analysis.skillFileContent || '');
    toast('Copied to clipboard!', 'success');
  };
  $('#btnDownloadSkill').onclick = () => {
    downloadText(analysis.skillFileContent || '', `${fname}.md`);
    toast('Skill file downloaded!', 'success');
  };

  // Wire regenerate button — re-run full analysis (force refresh)
  $('#btnRegenerateSkill').onclick = () => {
    toast('Regenerating skill file…', 'info');
    runAnalysis(true);
  };

  showState('results');

  // Wire issue creation bar after render (non-blocking)
  autoWireIssueCreation(data, analysis);
}

function renderCacheBadge(analysis) {
  const existing = document.getElementById('cacheBadge');
  if (existing) existing.remove();

  if (!analysis._fromCache || !analysis._cachedAt) return;

  const ageMs = Date.now() - analysis._cachedAt;
  const expiresInMs = (60 * 60 * 1000) - ageMs;
  const expiresInMin = Math.max(1, Math.round(expiresInMs / 60000));

  const badge = document.createElement('div');
  badge.id = 'cacheBadge';
  badge.className = 'cache-badge';
  badge.innerHTML = `
    <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" style="flex-shrink:0">
      <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm7-3.25v2.992l2.028.812a.75.75 0 0 1-.557 1.392l-2.5-1A.751.751 0 0 1 7 8.25v-3.5a.75.75 0 0 1 1.5 0Z"/>
    </svg>
    <span>Cached result &middot; expires in <strong>${expiresInMin}m</strong></span>
    <button class="cache-reanalyze-btn" id="btnCacheReanalyze">Re\u2011analyze now</button>`;

  // Insert between ticket card and tabs
  const nav = document.querySelector('#stateResults nav.tabs');
  nav.parentNode.insertBefore(badge, nav);

  document.getElementById('btnCacheReanalyze').addEventListener('click', () => runAnalysis(true));
}

function renderTicketCard(data, analysis) {
  const typeColors = {
    bug: '#f85149', feature: '#58a6ff', improvement: '#3fb950',
    documentation: '#bc8cff', chore: '#8b949e', refactor: '#d29922',
    'pull-request': '#58a6ff',
  };
  const complexityColors = { low: '#3fb950', medium: '#d29922', high: '#f85149' };
  const tc = typeColors[analysis.ticketType] || '#8b949e';
  const cc = complexityColors[analysis.complexity] || '#8b949e';

  const noScopeBadge = !analysis.hasScope
    ? `<span class="badge badge--muted">no scope</span>`
    : '';

  $('#ticketCard').innerHTML = `
    <div class="badges">
      <span class="badge" style="background:${tc}22;color:${tc};border-color:${tc}55">${escHtml(analysis.ticketType)}</span>
      <span class="badge" style="background:${cc}18;color:${cc};border-color:${cc}44">${escHtml(analysis.complexity)} complexity</span>
      ${noScopeBadge}
    </div>
    <div class="ticket-id">${escHtml(data.id)}</div>
    <div class="ticket-title">${escHtml(data.title)}</div>
    <p class="ticket-summary">${escHtml(analysis.summary)}</p>
    <div class="feature-type">
      <span class="section-label">Feature type</span>
      <span>${escHtml(analysis.featureType)}</span>
    </div>
  `;
}

function renderTaskList(selector, tasks, type) {
  const el = $(selector);
  if (!tasks.length) {
    el.innerHTML = '<p class="task-empty">No tasks generated</p>';
    return;
  }
  el.innerHTML = tasks.map((t) => buildTaskHtml(t, type)).join('');

  el.querySelectorAll('.task-check').forEach((cb) => {
    cb.addEventListener('change', () => handleTaskToggle(cb));
  });
}

function buildTaskHtml(task, type) {
  const isDone = task.status === 'done';
  const prioColors = { high: '#f85149', medium: '#d29922', low: '#3fb950' };
  const pc = prioColors[task.priority] || '#8b949e';
  return `
    <div class="task-item${isDone ? ' done' : ''}" data-id="${escHtml(task.id)}" data-type="${type}">
      <div class="task-body">
        <div class="task-meta">
          <span class="task-id">${escHtml(task.id)}</span>
          <span class="task-prio" style="color:${pc}">${escHtml(task.priority || 'medium')}</span>
        </div>
        <div class="task-title">${escHtml(task.title)}</div>
        <div class="task-desc">${escHtml(task.description)}</div>
      </div>
    </div>`;
}

function handleTaskToggle(cb) {
  const item = cb.closest('.task-item');
  if (!item) return;
  const done = cb.checked;
  item.classList.toggle('done', done);

  const id = item.dataset.id;
  if (!currentAnalysis) return;
  const allTasks = [...(currentAnalysis.uiTasks || []), ...(currentAnalysis.devTasks || [])];
  const task = allTasks.find((t) => t.id === id);
  if (task) task.status = done ? 'done' : 'pending';

  // Persist so side panel stays in sync
  if (currentTicket) saveTaskStates(currentTicket, currentAnalysis);

  const uiDone = (currentAnalysis.uiTasks || []).filter((t) => t.status === 'done').length;
  const devDone = (currentAnalysis.devTasks || []).filter((t) => t.status === 'done').length;
  $('#uiProgress').textContent = `${uiDone}/${(currentAnalysis.uiTasks || []).length} done`;
  $('#devProgress').textContent = `${devDone}/${(currentAnalysis.devTasks || []).length} done`;
}

function renderSuggestions(suggestions) {
  const list = $('#suggestionList');
  if (!suggestions.length) {
    list.innerHTML = '<p class="task-empty">No suggestions generated</p>';
    return;
  }
  list.innerHTML = suggestions.map((s) => buildSuggestionHtml(s)).join('');

  list.querySelectorAll('.copy-snippet-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.code || '');
      toast('Snippet copied!', 'success');
    });
  });
}

function buildSuggestionHtml(s) {
  const safeCode = escHtml(s.code || '');
  const rawCode = (s.code || '').replace(/"/g, '&quot;');
  return `
    <div class="suggestion">
      <div class="suggestion-header">
        <span class="suggestion-title">${escHtml(s.title)}</span>
        <span class="lang-badge">${escHtml(s.language || 'code')}</span>
      </div>
      <p class="suggestion-desc">${escHtml(s.description)}</p>
      <div class="code-wrap">
        <button class="btn btn-sm copy-snippet-btn" data-code="${rawCode}" title="Copy snippet">
          <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>
          Copy
        </button>
        <pre class="code-block"><code>${safeCode}</code></pre>
      </div>
    </div>`;
}

// ── Tab navigation ─────────────────────────────────────────────
function wireUpTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      document.querySelectorAll('#stateResults .pane').forEach((p) => p.classList.add('hidden'));
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      $(`#pane-${tab.dataset.pane}`)?.classList.remove('hidden');
      if (tab.dataset.pane === 'github') initGitHubTab();
    });
  });
}

function switchToTab(paneName) {
  const tab = document.querySelector(`.tab[data-pane="${paneName}"]`);
  if (!tab) return;
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.remove('active');
    t.setAttribute('aria-selected', 'false');
  });
  document.querySelectorAll('#stateResults .pane').forEach((p) => p.classList.add('hidden'));
  tab.classList.add('active');
  tab.setAttribute('aria-selected', 'true');
  $(`#pane-${paneName}`)?.classList.remove('hidden');
  if (paneName === 'github') initGitHubTab();
}

// ── UI State management ───────────────────────────────────────
function showState(name) {
  ['noTicket', 'loading', 'error', 'results'].forEach((s) => {
    const el = document.getElementById(`state${cap(s)}`);
    if (el) el.classList.toggle('hidden', s !== name);
  });
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function showError(msg) {
  $('#errorMsg').textContent = msg;
  showState('error');
}

function setLoadingMsg(msg) {
  $('#loadingMsg').textContent = msg;
}

// ── Content script bridge ─────────────────────────────────────
function sendToContent(tabId, msg) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tabId, msg, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

// ── Utilities ─────────────────────────────────────────────────
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

function toast(msg, type = 'info') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 3500);
}

// ================================================================
// Issue Creation
// ================================================================

async function autoWireIssueCreation(ticketData, analysis) {
  // Reset banners from previous analysis
  $('#issueActionBar').classList.add('hidden');
  $('#issueCreatedBanner').classList.add('hidden');

  const owner = analysis._owner || '';
  const repo = analysis._repo || '';

  const items = await new Promise((r) =>
    chrome.storage.sync.get(['githubToken', 'linkedRepo'], r)
  );
  const token = items.githubToken || '';
  let resolvedOwner = owner;
  let resolvedRepo = repo;

  if ((!resolvedOwner || !resolvedRepo) && items.linkedRepo) {
    const parts = items.linkedRepo.split('/');
    resolvedOwner = (parts[0] || '').trim();
    resolvedRepo = (parts[1] || '').trim();
  }

  if (!token || !resolvedOwner || !resolvedRepo) return;

  $('#issueRepoChip').textContent = `${resolvedOwner}/${resolvedRepo}`;
  $('#issueActionBar').classList.remove('hidden');

  // First click shows confirmation; confirmed click creates
  $('#btnCreateIssue').onclick = () =>
    showIssueConfirm(ticketData, analysis, resolvedOwner, resolvedRepo, token);
}

function showIssueConfirm(ticketData, analysis, owner, repo, token) {
  const bar = $('#issueActionBar');
  // Swap the action bar into confirmation mode
  bar.innerHTML = `
    <span class="issue-confirm-msg">Create issue in <strong>${escHtml(owner)}/${escHtml(repo)}</strong>?</span>
    <div class="issue-confirm-btns">
      <button id="btnIssueConfirmYes" class="btn btn-sm btn-primary">Yes, create</button>
      <button id="btnIssueConfirmNo" class="btn btn-sm btn-outline">Cancel</button>
    </div>`;

  $('#btnIssueConfirmYes').onclick = () => handleCreateGhIssue(ticketData, analysis, owner, repo, token);
  $('#btnIssueConfirmNo').onclick = () => autoWireIssueCreation(ticketData, analysis);
}

async function handleCreateGhIssue(ticketData, analysis, owner, repo, token) {
  const bar = $('#issueActionBar');
  bar.innerHTML = `<span class="issue-confirm-msg">Creating…</span>`;
  bar.style.pointerEvents = 'none';

  const typeLabels = {
    bug: 'bug', feature: 'enhancement', improvement: 'enhancement',
    documentation: 'documentation', chore: 'enhancement', refactor: 'enhancement',
  };
  const label = typeLabels[analysis.ticketType] || 'enhancement';

  const title = ticketData.title
    ? `[${ticketData.id || ticketData.platform}] ${ticketData.title}`
    : `Ticket ${ticketData.id || ''}`.trim();

  const body = analysis.issueBody || buildFallbackIssueBody(analysis, ticketData);

  try {
    // Step 1: Create the issue
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title, body, labels: [label] }),
    });

    const data = await res.json();
    if (!res.ok) {
      if (res.status === 401) throw new Error('Invalid or expired token. Update it in Settings.');
      if (res.status === 403) throw new Error('Token lacks permission to create issues. Ensure it has "repo" scope.');
      if (res.status === 404) throw new Error('Repository not found. Check the linked repo in Settings.');
      if (res.status === 410) throw new Error('Issues are disabled for this repository.');
      throw new Error(data.message || `GitHub API error ${res.status}`);
    }

    const issue = data;

    bar.style.pointerEvents = '';
    $('#issueActionBar').classList.add('hidden');
    const banner = $('#issueCreatedBanner');
    banner.classList.remove('hidden');
    const link = $('#issueCreatedLink');
    link.href = issue.html_url;
    link.textContent = `#${issue.number} \u2014 ${issue.title}`;

    toast(`Issue #${issue.number} created successfully!`, 'success');
    // Refresh the open issues list to include the newly created issue
    loadGhOpenIssues(true);
  } catch (err) {
    toast(`Failed to create issue: ${err.message}`, 'error');
    bar.style.pointerEvents = '';
    autoWireIssueCreation(ticketData, analysis);
  }
}

function buildFallbackIssueBody(analysis, ticketData) {
  const uiList = (analysis.uiTasks || [])
    .map((t) => `- [ ] **${t.id} ${t.title}** [${t.priority || 'medium'}]: ${t.description}`)
    .join('\n') || '- [ ] No UI tasks';
  const devList = (analysis.devTasks || [])
    .map((t) => `- [ ] **${t.id} ${t.title}** [${t.priority || 'medium'}]: ${t.description}`)
    .join('\n') || '- [ ] No dev tasks';
  const ref = ticketData.url
    ? `[${ticketData.id || 'Ticket'}](${ticketData.url})`
    : ticketData.id || 'N/A';
  const qaList = ticketData.qaAcceptance
    ? ticketData.qaAcceptance.split(/\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.startsWith('-') ? `${l}` : `- ${l}`).join('\n')
    : '- All tasks above are completed and reviewed\n- Code follows project conventions\n- No regressions introduced';

  return `### Summary\n${analysis.summary}\n\n### Ticket Context\n- **Type**: ${analysis.ticketType}\n- **Complexity**: ${analysis.complexity}\n- **Feature**: ${analysis.featureType}${ticketData.keyDetails ? `\n- **Key Details**: ${ticketData.keyDetails}` : ''}\n\n### Constraints & Rules\n${ticketData.devNotes ? `- Developer Notes: ${ticketData.devNotes}` : '- Follow existing project conventions'}${ticketData.scope ? `\n- Scope: ${ticketData.scope}` : ''}\n\n### Tasks\n**UI Tasks**\n${uiList}\n\n**Dev Tasks**\n${devList}\n\n### QA Acceptance\n${qaList}\n\n### Edge Cases\n- Handle empty / null data gracefully\n- Validate user inputs at system boundaries\n- Consider loading and error states\n\n### Testing Strategy\n- Unit tests for new business logic\n- Integration tests for API / data layer changes\n- Manual verification against QA acceptance criteria\n\n### References\n- Ticket: ${ref}\n- Suggested branch: \`${analysis.suggestedBranch || 'feat/implementation'}\`\n\n> This issue was generated by Ticket Analyser. Assign @github-copilot for AI-assisted implementation.`;
}

// ================================================================
// GitHub Workflow Automation
// ================================================================

let ghCfg = { token: '', owner: '', repo: '' };
let ghBranches = [];
let ghDefaultBranch = 'master';
let ghContentWired = false;
let ghAllRepos = [];

// ── GitHub tab init ────────────────────────────────────────────
async function initGitHubTab() {
  if (ghTabInitialized) return;
  ghTabInitialized = true;

  await resolveGitHubConfig();

  if (!ghCfg.token) {
    showGhState('noToken');
    $('#btnGhOpenSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());
    return;
  }

  if (!ghCfg.owner || !ghCfg.repo) {
    ghTabInitialized = false; // allow re-entry after picker selection
    showGhState('picker');
    await loadRepoPicker();
    return;
  }

  await loadGhRepoContent();
}

// ── GitHub state switcher ─────────────────────────────────────
function showGhState(state) {
  $('#ghNoRepo').classList.toggle('hidden', state === 'content');
  $('#ghNoToken').classList.toggle('hidden', state !== 'noToken');
  $('#ghRepoPicker').classList.toggle('hidden', state !== 'picker');
  $('#ghRepoContent').classList.toggle('hidden', state !== 'content');
}

// ── Repo Picker ─────────────────────────────────────────────────
async function loadRepoPicker() {
  const list = $('#ghRepoPickerList');
  const search = $('#ghRepoSearch');
  list.innerHTML = '<p class="task-empty">Loading repositories…</p>';
  search.value = '';
  search.oninput = () => renderRepoPicker(search.value);
  $('#btnRefreshRepos').onclick = () => { ghAllRepos = []; loadRepoPicker(); };

  try {
    const data = await ghJSON('/user/repos?type=all&per_page=100&sort=updated');
    ghAllRepos = (Array.isArray(data) ? data : []).map((r) => ({
      full_name: r.full_name,
      description: r.description || '',
      private: r.private,
      language: r.language || '',
    }));
    renderRepoPicker('');
    setTimeout(() => search.focus(), 80);
  } catch (err) {
    list.innerHTML = `<p class="task-empty" style="color:var(--red)">${escHtml(err.message)}</p>`;
  }
}

function renderRepoPicker(query) {
  const list = $('#ghRepoPickerList');
  const q = query.toLowerCase().trim();
  const filtered = q
    ? ghAllRepos.filter(
        (r) =>
          r.full_name.toLowerCase().includes(q) ||
          r.description.toLowerCase().includes(q)
      )
    : ghAllRepos;

  if (!filtered.length) {
    list.innerHTML = q
      ? '<p class="task-empty">No matching repositories.</p>'
      : '<p class="task-empty">No repositories found.</p>';
    return;
  }

  list.innerHTML = filtered
    .slice(0, 60)
    .map(
      (r) => `
    <button class="gh-repo-item" data-full="${escHtml(r.full_name)}">
      <div class="gh-repo-item-row">
        <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" style="color:var(--text3);flex-shrink:0"><path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8z"/></svg>
        <span class="gh-repo-item-name">${escHtml(r.full_name)}</span>
        ${r.private ? '<span class="gh-repo-badge">private</span>' : ''}
        ${r.language ? `<span class="gh-repo-lang">${escHtml(r.language)}</span>` : ''}
      </div>
      ${r.description ? `<p class="gh-repo-item-desc">${escHtml(r.description)}</p>` : ''}
    </button>`
    )
    .join('');

  list.querySelectorAll('.gh-repo-item').forEach((btn) => {
    btn.addEventListener('click', () => selectGhRepo(btn.dataset.full));
  });
}

async function selectGhRepo(fullName) {
  const parts = fullName.split('/');
  ghCfg.owner = parts[0] || '';
  ghCfg.repo = parts[1] || '';
  await new Promise((r) => chrome.storage.sync.set({ linkedRepo: fullName }, r));
  ghTabInitialized = true;
  await loadGhRepoContent();
}

// ── Repo content initializer ───────────────────────────────────
async function loadGhRepoContent() {
  showGhState('content');
  $('#ghRepoName').textContent = `${ghCfg.owner}/${ghCfg.repo}`;

  // Wire static listeners only once across repo switches
  if (!ghContentWired) {
    ghContentWired = true;
    wireUpGhSubTabs();
    $('#btnRefreshGhWf').addEventListener('click', () => loadGhWorkflows());
    $('#btnGhCreatePR').addEventListener('click', handleGhCreatePR);
    $('#btnGhCreateBranch').addEventListener('click', handleGhCreateBranch);
    $('#btnUseSuggestedBranch').addEventListener('click', () => {
      const val = $('#ghSuggestedBranch').textContent;
      if (val) $('#ghNewBranch').value = val;
    });
    $('#btnChangeRepo').addEventListener('click', () => {
      ghTabInitialized = false;
      ghCfg.owner = '';
      ghCfg.repo = '';
      showGhState('picker');
      loadRepoPicker();
    });
  }

  showGhLoading();
  await loadGhBranches();
  await Promise.all([loadGhWorkflows(), loadGhPRs()]);
  prefillPRFromTicket();
  prefillBranchFromTicket();
  populateGhIssuesPanel();
}

async function resolveGitHubConfig() {
  const items = await new Promise((r) =>
    chrome.storage.sync.get(['githubToken', 'linkedRepo'], r)
  );
  ghCfg.token = items.githubToken || '';

  if (currentTicket?.owner && currentTicket?.repo) {
    ghCfg.owner = currentTicket.owner;
    ghCfg.repo = currentTicket.repo;
    return;
  }

  if (items.linkedRepo) {
    const parts = items.linkedRepo.split('/');
    ghCfg.owner = (parts[0] || '').trim();
    ghCfg.repo = (parts[1] || '').trim();
  }
}

function wireUpGhSubTabs() {
  const pane = $('#pane-github');
  pane.querySelectorAll('.sub-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      pane.querySelectorAll('.sub-tab').forEach((t) => t.classList.remove('active'));
      pane.querySelectorAll('.gh-panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      $(`#panelGh${tab.dataset.ghpane}`)?.classList.add('active');
      if (tab.dataset.ghpane === 'Issues') populateGhIssuesPanel();
    });
  });
}

function showGhLoading() {
  const list = $('#ghWorkflowList');
  if (list) list.innerHTML = '<p class="task-empty">Loading\u2026</p>';
}

// ── Issues panel ticket card ───────────────────────────────────
function populateGhIssuesPanel() {
  const container = $('#ghIssueTicketRef');
  if (!container) return;

  if (!currentTicket || !currentAnalysis) {
    container.innerHTML = '<p class="task-empty">Analyze a ticket to create a GitHub issue.</p>';
    return;
  }

  const typeColors = {
    bug: '#f85149', feature: '#58a6ff', improvement: '#3fb950',
    documentation: '#bc8cff', chore: '#8b949e', refactor: '#d29922',
  };
  const complexityColors = { low: '#3fb950', medium: '#d29922', high: '#f85149' };
  const tc = typeColors[currentAnalysis.ticketType] || '#8b949e';
  const cc = complexityColors[currentAnalysis.complexity] || '#8b949e';

  container.innerHTML = `
    <div class="gh-issue-ticket-card">
      <div class="gh-issue-ticket-badges">
        <span class="badge" style="background:${tc}22;color:${tc};border-color:${tc}55">${escHtml(currentAnalysis.ticketType)}</span>
        <span class="badge" style="background:${cc}18;color:${cc};border-color:${cc}44">${escHtml(currentAnalysis.complexity)}</span>
      </div>
      <div class="gh-issue-ticket-id">${escHtml(currentTicket.id || currentTicket.platform || '')}</div>
      <div class="gh-issue-ticket-title">${escHtml(currentTicket.title || '')}</div>
      <p class="gh-issue-ticket-summary">${escHtml(currentAnalysis.summary || '')}</p>
    </div>`;

  // Re-wire issue creation for the current ticket/analysis state
  autoWireIssueCreation(currentTicket, currentAnalysis);

  // Load open issues for the linked repo
  loadGhOpenIssues();

  const refreshBtn = $('#btnRefreshOpenIssues');
  if (refreshBtn) {
    refreshBtn.onclick = () => loadGhOpenIssues(true);
  }
}

async function loadGhOpenIssues(forceRefresh = false) {
  const list = $('#ghOpenIssuesList');
  const countEl = $('#ghOpenIssuesCount');
  if (!list) return;

  // Ensure GitHub config is resolved before fetching
  if (!ghCfg.token || !ghCfg.owner || !ghCfg.repo) {
    await resolveGitHubConfig();
  }
  if (!ghCfg.owner || !ghCfg.repo || !ghCfg.token) return;

  const refreshBtn = $('#btnRefreshOpenIssues');
  if (refreshBtn) refreshBtn.classList.add('spinning');

  list.innerHTML = '<p class="task-empty">Loading issues…</p>';

  try {
    // Fetch up to 50 most recently updated open issues
    const issues = await ghJSON(
      `/repos/${ghCfg.owner}/${ghCfg.repo}/issues?state=open&per_page=50&sort=updated&direction=desc`
    );
    // Filter out pull requests (GitHub returns PRs in issue list)
    const realIssues = issues.filter((i) => !i.pull_request);

    countEl.textContent = `${realIssues.length} open issue${realIssues.length === 1 ? '' : 's'}`;

    if (!realIssues.length) {
      list.innerHTML = '<p class="task-empty">No open issues in this repository.</p>';
      return;
    }

    list.innerHTML = '';
    realIssues.forEach((issue) => list.appendChild(buildOpenIssueRow(issue)));
  } catch (err) {
    list.innerHTML = `<p class="task-empty" style="color:var(--red)">${escHtml(err.message)}</p>`;
  } finally {
    if (refreshBtn) refreshBtn.classList.remove('spinning');
  }
}

function buildOpenIssueRow(issue) {
  const el = document.createElement('a');
  el.className = 'gh-open-issue-row';
  el.href = issue.html_url;
  el.target = '_blank';
  el.rel = 'noopener noreferrer';

  const labels = (issue.labels || [])
    .slice(0, 3)
    .map((l) => `<span class="gh-open-issue-label" style="background:#${l.color}22;color:#${l.color};border-color:#${l.color}55">${escHtml(l.name)}</span>`)
    .join('');

  const assignee = issue.assignee
    ? `<img class="gh-open-issue-avatar" src="${escHtml(issue.assignee.avatar_url)}" alt="${escHtml(issue.assignee.login)}" title="${escHtml(issue.assignee.login)}" />`
    : '';

  const updated = formatRelativeTime(issue.updated_at);

  el.innerHTML = `
    <div class="gh-open-issue-main">
      <span class="gh-open-issue-num">#${issue.number}</span>
      <span class="gh-open-issue-title">${escHtml(issue.title)}</span>
    </div>
    <div class="gh-open-issue-meta">
      <span class="gh-open-issue-labels">${labels}</span>
      <span class="gh-open-issue-right">${assignee}<span class="gh-open-issue-time">${updated}</span></span>
    </div>`;
  return el;
}

function formatRelativeTime(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(isoStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ── GitHub API helpers ─────────────────────────────────────────
function ghFetch(path, opts = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${ghCfg.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...opts.headers,
    },
  });
}

async function ghJSON(path, opts = {}) {
  const res = await ghFetch(path, opts);
  const data = await res.json();
  if (!res.ok) {
    if (res.status === 401) throw new Error('Invalid or expired token. Update it in Settings.');
    if (res.status === 403) throw new Error('Access denied. Ensure the token has "repo" and "workflow" scopes.');
    if (res.status === 404) throw new Error('Repository not found. Check the linked repo in Settings.');
    throw new Error(data.message || `GitHub API error ${res.status}`);
  }
  return data;
}

// ── Branches ──────────────────────────────────────────────────
async function fetchAllBranches() {
  const all = [];
  let page = 1;
  while (true) {
    const data = await ghJSON(
      `/repos/${ghCfg.owner}/${ghCfg.repo}/branches?per_page=100&page=${page}`
    );
    if (!Array.isArray(data) || !data.length) break;
    all.push(...data.map((b) => b.name));
    if (data.length < 100) break;
    page++;
  }
  return all;
}

async function loadGhBranches() {
  try {
    const [allBranches, repoData] = await Promise.all([
      fetchAllBranches(),
      ghJSON(`/repos/${ghCfg.owner}/${ghCfg.repo}`),
    ]);
    ghBranches = allBranches;
    const repoDef = repoData.default_branch || '';
    ghDefaultBranch = ghBranches.includes('master') ? 'master'
      : ghBranches.includes(repoDef) ? repoDef
      : ghBranches[0] || 'master';
    populateGhSelect('#ghPrBase', ghBranches, 'Select base\u2026', ghDefaultBranch);
    populateGhSelect('#ghPrHead', ghBranches, 'Select compare\u2026', '');
    populateGhSelect('#ghBranchBase', ghBranches, 'Select source\u2026', ghDefaultBranch);
  } catch (err) {
    toast(`Failed to load branches: ${err.message}`, 'error');
  }
}

function populateGhSelect(selector, items, placeholder, preselect) {
  const el = $(selector);
  if (!el) return;
  el.innerHTML = `<option value="">${placeholder}</option>` +
    items.map((i) => `<option value="${escHtml(i)}"${i === preselect ? ' selected' : ''}>${escHtml(i)}</option>`).join('');
}

// ── Workflows ──────────────────────────────────────────────────
async function loadGhWorkflows() {
  const list = $('#ghWorkflowList');
  const countEl = $('#ghWfCount');
  list.innerHTML = '<p class="task-empty">Loading workflows\u2026</p>';
  try {
    const data = await ghJSON(`/repos/${ghCfg.owner}/${ghCfg.repo}/actions/workflows?per_page=100`);
    const wfs = data.workflows || [];
    countEl.textContent = `${wfs.length} workflow${wfs.length === 1 ? '' : 's'}`;
    if (!wfs.length) {
      list.innerHTML = '<p class="task-empty">No workflows found in this repository.</p>';
      return;
    }
    list.innerHTML = '';
    wfs.forEach((wf) => list.appendChild(buildGhWfCard(wf)));
    wfs.forEach((wf) => loadGhWfLastRun(wf.id));
  } catch (err) {
    list.innerHTML = `<p class="task-empty" style="color:var(--red)">${escHtml(err.message)}</p>`;
  }
}

function buildGhWfCard(wf) {
  const fileName = wf.path.split('/').pop();
  const isActive = wf.state === 'active';
  const branchOpts = ghBranches
    .map((b) => `<option value="${escHtml(b)}"${b === ghDefaultBranch ? ' selected' : ''}>${escHtml(b)}</option>`)
    .join('');

  const card = document.createElement('div');
  card.className = 'gh-wf-card';
  card.dataset.wfId = String(wf.id);
  card.innerHTML = `
    <div class="gh-wf-header">
      <div class="gh-wf-info">
        <span class="gh-wf-name">${escHtml(wf.name)}</span>
        <span class="gh-wf-file">${escHtml(fileName)}</span>
      </div>
      <span class="gh-wf-badge ${isActive ? 'gh-wf-active' : 'gh-wf-inactive'}">${isActive ? 'active' : 'disabled'}</span>
    </div>
    <div class="gh-wf-last-run hidden">
      <span class="gh-run-label">Last run:</span>
      <span class="gh-run-status"></span>
      <span class="gh-run-time"></span>
    </div>
    <div class="gh-wf-footer">
      <select class="gh-input gh-wf-branch-sel">
        <option value="">Select branch\u2026</option>
        ${branchOpts}
      </select>
      <button class="btn btn-sm btn-primary gh-run-btn" ${isActive ? '' : 'disabled'}>
        <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0M1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0m4.879-2.773 4.264 2.559a.25.25 0 0 1 0 .428l-4.264 2.559A.25.25 0 0 1 6 10.559V5.442a.25.25 0 0 1 .379-.215"/></svg>
        Run
      </button>
    </div>`;

  card.querySelector('.gh-run-btn').addEventListener('click', () => {
    const branch = card.querySelector('.gh-wf-branch-sel').value;
    if (!branch) return toast('Select a branch first.', 'error');
    triggerGhWorkflow(wf.id, wf.name, branch, card);
  });
  return card;
}

async function triggerGhWorkflow(wfId, wfName, branch, card) {
  const btn = card.querySelector('.gh-run-btn');
  btn.disabled = true;
  try {
    const res = await ghFetch(
      `/repos/${ghCfg.owner}/${ghCfg.repo}/actions/workflows/${wfId}/dispatches`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: branch }),
      }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `Dispatch failed (${res.status})`);
    }
    toast(`"${wfName}" triggered on ${branch}!`, 'success');
    setTimeout(() => loadGhWfLastRun(wfId, card), 4000);
  } catch (err) {
    toast(`Trigger failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function loadGhWfLastRun(wfId, card) {
  try {
    const cardEl = card || document.querySelector(`[data-wf-id="${wfId}"]`);
    if (!cardEl) return;
    const runs = await ghJSON(
      `/repos/${ghCfg.owner}/${ghCfg.repo}/actions/workflows/${wfId}/runs?per_page=1`
    );
    if (!runs.workflow_runs.length) return;
    const run = runs.workflow_runs[0];
    const lastRunEl = cardEl.querySelector('.gh-wf-last-run');
    lastRunEl.classList.remove('hidden');
    const conclusion = run.conclusion || run.status;
    let cls = 'pending';
    if (run.conclusion === 'success') cls = 'success';
    else if (run.conclusion === 'failure') cls = 'failure';
    const statusEl = lastRunEl.querySelector('.gh-run-status');
    statusEl.textContent = conclusion;
    statusEl.className = `gh-run-status ${cls}`;
    lastRunEl.querySelector('.gh-run-time').textContent = timeAgo(new Date(run.created_at));
  } catch {
    // silently ignore
  }
}

// ── Pull Requests ──────────────────────────────────────────────
async function loadGhPRs() {
  const list = $('#ghPrList');
  list.innerHTML = '<p class="task-empty">Loading PRs\u2026</p>';
  try {
    const prs = await ghJSON(
      `/repos/${ghCfg.owner}/${ghCfg.repo}/pulls?state=open&per_page=30&sort=updated&direction=desc`
    );
    if (!prs.length) {
      list.innerHTML = '<p class="task-empty">No open pull requests.</p>';
      return;
    }
    list.innerHTML = prs.map((pr) => `
      <div class="gh-pr-item">
        <div class="gh-pr-item-main">
          <span class="gh-pr-num">#${pr.number}</span>
          <span class="gh-pr-title">${escHtml(pr.title)}</span>
        </div>
        <div class="gh-pr-meta">
          <span class="gh-pr-branch">${escHtml(pr.head.ref)}</span>
          <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor"><path d="M8.22 2.97a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l2.97-2.97H3.75a.75.75 0 0 1 0-1.5h7.44L8.22 4.03a.75.75 0 0 1 0-1.06"/></svg>
          <span class="gh-pr-branch">${escHtml(pr.base.ref)}</span>
          <span class="gh-pr-author">by ${escHtml(pr.user.login)}</span>
        </div>
      </div>`).join('');
  } catch (err) {
    list.innerHTML = `<p class="task-empty" style="color:var(--red)">${escHtml(err.message)}</p>`;
  }
}

async function handleGhCreatePR() {
  const base = $('#ghPrBase').value;
  const head = $('#ghPrHead').value;
  const title = $('#ghPrTitle').value.trim();
  const body = $('#ghPrBody').value.trim();

  if (!base || !head) return toast('Select base and compare branches.', 'error');
  if (base === head) return toast('Base and compare branches must differ.', 'error');
  if (!title) return toast('PR title is required.', 'error');

  const btn = $('#btnGhCreatePR');
  btn.disabled = true;
  btn.textContent = 'Creating\u2026';
  try {
    const pr = await ghJSON(`/repos/${ghCfg.owner}/${ghCfg.repo}/pulls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body: body || '', head, base }),
    });
    toast(`PR #${pr.number} created!`, 'success');
    $('#ghPrTitle').value = '';
    $('#ghPrBody').value = '';
    await loadGhPRs();
  } catch (err) {
    toast(`Create PR failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create Pull Request';
  }
}

// ── Branch ─────────────────────────────────────────────────────
async function handleGhCreateBranch() {
  const name = $('#ghNewBranch').value.trim();
  const base = $('#ghBranchBase').value;

  if (!name) return toast('Enter a branch name.', 'error');
  if (!base) return toast('Select a source branch.', 'error');
  if (!/^[\w.\-/]+$/.test(name)) return toast('Branch name contains invalid characters.', 'error');

  const btn = $('#btnGhCreateBranch');
  btn.disabled = true;
  try {
    const refData = await ghJSON(
      `/repos/${ghCfg.owner}/${ghCfg.repo}/git/ref/heads/${encodeURIComponent(base)}`
    );
    const sha = refData.object.sha;
    await ghJSON(`/repos/${ghCfg.owner}/${ghCfg.repo}/git/refs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: `refs/heads/${name}`, sha }),
    });
    toast(`Branch "${name}" created from "${base}"!`, 'success');
    $('#ghNewBranch').value = '';
    await loadGhBranches();
    populateGhSelect('#ghPrHead', ghBranches, 'Select compare\u2026', name);
  } catch (err) {
    toast(`Create branch failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ── Pre-fill from ticket data ──────────────────────────────────
function prefillPRFromTicket() {
  if (!currentTicket || !currentAnalysis) return;
  const typePrefix = { bug: 'fix', feature: 'feat', improvement: 'feat', chore: 'chore', refactor: 'refactor', documentation: 'docs' };
  const prefix = typePrefix[currentAnalysis.ticketType] || 'feat';
  const title = `${prefix}: ${currentTicket.title || ''}`.slice(0, 100);
  $('#ghPrTitle').value = title;
  if (currentTicket.url) {
    const ref = currentTicket.id ? `${currentTicket.id}: ` : '';
    $('#ghPrBody').value = `${ref}${currentTicket.url}`;
  }
}

function prefillBranchFromTicket() {
  if (!currentAnalysis?.suggestedBranch) return;
  const el = $('#ghBranchSuggest');
  const val = $('#ghSuggestedBranch');
  if (el && val) {
    val.textContent = currentAnalysis.suggestedBranch;
    el.classList.remove('hidden');
  }
}

// ── Time helper ────────────────────────────────────────────────
function timeAgo(date) {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
