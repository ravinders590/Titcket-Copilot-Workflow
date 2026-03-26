/* ================================================================
   Ticket Analyser — Options Page Logic
   ================================================================ */

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  wireUp();
});

const $ = (s) => document.querySelector(s);

// ── Load saved settings ────────────────────────────────────────
function loadSettings() {
  chrome.storage.sync.get(
    ['githubToken', 'figmaToken', 'aiModel', 'platformJira', 'platformGitHub', 'platformLinear', 'linkedRepo'],
    (items) => {
      $('#githubToken').value = items.githubToken || '';
      $('#figmaToken').value = items.figmaToken || '';
      $('#aiModel').value = items.aiModel || 'gpt-4o';
      $('#platformJira').checked = items.platformJira !== false;
      $('#platformGitHub').checked = items.platformGitHub !== false;
      $('#platformLinear').checked = items.platformLinear !== false;
      $('#linkedRepo').value = items.linkedRepo || '';
    }
  );
}

// ── Wire up interactions ───────────────────────────────────────
function wireUp() {
  // Toggle GitHub token visibility
  $('#toggleGHToken').addEventListener('click', () => toggleVisibility('#githubToken'));

  // Toggle Figma key visibility
  $('#toggleFigmaKey').addEventListener('click', () => toggleVisibility('#figmaToken'));

  // Save
  $('#settingsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    saveSettings();
  });

  // Test key
  $('#btnTestKey').addEventListener('click', testApiKey);
}

// ── Save settings ──────────────────────────────────────────────
function saveSettings() {
  const githubToken = $('#githubToken').value.trim();
  const figmaToken = $('#figmaToken').value.trim();
  const aiModel = $('#aiModel').value;
  const platformJira = $('#platformJira').checked;
  const platformGitHub = $('#platformGitHub').checked;
  const platformLinear = $('#platformLinear').checked;
  const linkedRepo = $('#linkedRepo').value.trim();

  if (!githubToken) {
    showStatus('GitHub Personal Access Token is required.', 'error');
    return;
  }

  chrome.storage.sync.set(
    { githubToken, figmaToken, aiModel, platformJira, platformGitHub, platformLinear, linkedRepo },
    () => {
      if (chrome.runtime.lastError) {
        showStatus(`Save failed: ${chrome.runtime.lastError.message}`, 'error');
      } else {
        showStatus('Settings saved successfully!', 'success');
      }
    }
  );
}

// ── Test GitHub token ──────────────────────────────────────────
async function testApiKey() {
  const key = $('#githubToken').value.trim();
  if (!key) {
    showStatus('Enter a GitHub Personal Access Token to test.', 'error');
    return;
  }

  const btn = $('#btnTestKey');
  btn.disabled = true;
  btn.textContent = 'Testing…';
  showStatus('Contacting GitHub…', 'success');

  try {
    // Verify the token is valid via the GitHub user endpoint
    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/vnd.github+json',
      },
    });

    if (!userRes.ok) {
      if (userRes.status === 401) {
        showStatus('Invalid GitHub token. Please check and try again.', 'error');
      } else {
        showStatus(`Unexpected response: HTTP ${userRes.status}`, 'error');
      }
      return;
    }

    const user = await userRes.json();

    // Verify GitHub Models API access
    const modelsRes = await fetch('https://models.inference.ai.azure.com/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        max_tokens: 5,
      }),
    });

    if (modelsRes.ok) {
      showStatus(`Connected as @${user.login}. GitHub Models API access confirmed!`, 'success');
    } else if (modelsRes.status === 403) {
      showStatus(`Token valid (@${user.login}) but no GitHub Copilot / Models access. Enable Copilot on your account.`, 'error');
    } else {
      showStatus(`Token valid (@${user.login}) but Models API returned HTTP ${modelsRes.status}.`, 'error');
    }
  } catch {
    showStatus('Network error. Check your internet connection.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0M1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0m4.879-2.773 4.264 2.559a.25.25 0 0 1 0 .428l-4.264 2.559A.25.25 0 0 1 6 10.559V5.442a.25.25 0 0 1 .379-.215"/></svg> Test Connection`;
  }
}

// ── Helpers ────────────────────────────────────────────────────
function toggleVisibility(selector) {
  const inp = $(selector);
  inp.type = inp.type === 'password' ? 'text' : 'password';
}

function showStatus(msg, type) {
  const el = $('#status');
  el.textContent = msg;
  el.className = `status ${type}`;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  if (type === 'success') {
    el._t = setTimeout(() => el.classList.add('hidden'), 4000);
  }
}
