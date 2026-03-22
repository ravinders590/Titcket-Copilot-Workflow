/* ================================================================
   Ticket Copilot — Background Service Worker
   Handles: AI analysis (GitHub Models API), Figma API, option page routing
   Uses: https://models.inference.ai.azure.com — authenticated with
         a GitHub Personal Access Token (no OpenAI key required).
   ================================================================ */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    return;
  }

  if (msg.type === 'OPEN_POPUP') {
    chrome.action.openPopup().catch(() => {});
    return;
  }

  if (msg.type === 'ANALYZE_TICKET') {
    handleAnalysis(msg.payload, msg.forceRefresh === true)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === 'GENERATE_SKILL_FILE') {
    buildSkillFile(msg.analysis, msg.ticketData)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === 'FETCH_SKILL_FILES') {
    const { owner, repo, token } = msg.payload;
    fetchRepoSkillFiles(owner, repo, token)
      .then((files) => sendResponse({ files }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === 'CREATE_GITHUB_ISSUE') {
    const { owner, repo, token, issueData } = msg.payload;
    createGitHubIssue(owner, repo, token, issueData)
      .then((issue) => sendResponse({ issue }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});

// ── Settings helper ─────────────────────────────────────────
function getSettings() {
  return new Promise((resolve) =>
    chrome.storage.sync.get(['githubToken', 'figmaToken', 'aiModel', 'linkedRepo'], resolve)
  );
}

// ── Analysis cache (chrome.storage.local, 1-hour TTL) ──────────────
const CACHE_TTL = 60 * 60 * 1000; // 1 hour in ms
const CACHE_PREFIX = 'tc_cache_';

function getCacheKey(ticketData) {
  const raw = ticketData.url || `${ticketData.platform}::${ticketData.id}`;
  // simple stable key — replace characters not safe for storage keys
  return CACHE_PREFIX + raw.replace(/[^a-zA-Z0-9_:/-]/g, '_').slice(0, 200);
}

async function getCachedAnalysis(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (items) => {
      const entry = items[key];
      if (!entry || !entry.cachedAt || !entry.analysis) return resolve(null);
      if (Date.now() - entry.cachedAt > CACHE_TTL) return resolve(null);
      resolve({ analysis: entry.analysis, cachedAt: entry.cachedAt });
    });
  });
}

async function setCachedAnalysis(key, analysis) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: { analysis, cachedAt: Date.now() } }, resolve);
  });
}

// ── Main analysis orchestrator ──────────────────────────────
async function handleAnalysis(ticketData, forceRefresh = false) {
  const cacheKey = getCacheKey(ticketData);

  // Return cached result if within TTL and not a forced re-analysis
  if (!forceRefresh) {
    const cached = await getCachedAnalysis(cacheKey);
    if (cached) {
      return { ...cached.analysis, _fromCache: true, _cachedAt: cached.cachedAt };
    }
  }

  const { githubToken, figmaToken, aiModel, linkedRepo } = await getSettings();

  if (!githubToken) {
    throw new Error(
      'GitHub Personal Access Token not configured. Open Settings to add your token.'
    );
  }

  let figmaDesigns = [];
  if (figmaToken && ticketData.figmaUrls?.length) {
    const results = await Promise.allSettled(
      ticketData.figmaUrls.slice(0, 3).map((url) => fetchFigmaData(url, figmaToken))
    );
    figmaDesigns = results
      .filter((r) => r.status === 'fulfilled' && r.value)
      .map((r) => r.value);
  }

  // Resolve owner/repo from ticket data or linked repo setting
  let owner = ticketData.owner || '';
  let repo = ticketData.repo || '';
  if ((!owner || !repo) && linkedRepo) {
    const parts = linkedRepo.split('/');
    owner = (parts[0] || '').trim();
    repo = (parts[1] || '').trim();
  }

  // Auto-fetch skill files from repo if we have enough info
  let repoSkillFiles = [];
  if (owner && repo) {
    repoSkillFiles = await fetchRepoSkillFiles(owner, repo, githubToken);
  }

  const analysis = await analyzeWithAI(ticketData, figmaDesigns, githubToken, aiModel, repoSkillFiles, owner, repo);
  // Annotate with resolved repo info for the popup to use
  analysis._owner = owner;
  analysis._repo = repo;
  analysis._repoSkillFilesLoaded = repoSkillFiles.length > 0;

  // Store fresh result in cache
  await setCachedAnalysis(cacheKey, analysis);

  return analysis;
}

// ── GitHub REST API helpers ──────────────────────────────────
async function ghApiGet(path, token) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) return null;
  return res.json();
}

// ── Fetch skill/instruction files from a GitHub repo ─────────
async function fetchRepoSkillFiles(owner, repo, token) {
  if (!owner || !repo || !token) return [];

  const candidatePaths = [
    '.github/copilot-instructions.md',
    'SKILL.md',
    'skill.md',
  ];

  // Also probe .github/instructions/ directory for *.instructions.md files
  const instructionsDir = await ghApiGet(
    `/repos/${owner}/${repo}/contents/.github/instructions`,
    token
  );
  if (Array.isArray(instructionsDir)) {
    for (const entry of instructionsDir) {
      if (entry.name.endsWith('.instructions.md') || entry.name.endsWith('.md')) {
        candidatePaths.push(entry.path);
      }
    }
  }

  // Also probe .copilot/ directory
  const copilotDir = await ghApiGet(
    `/repos/${owner}/${repo}/contents/.copilot`,
    token
  );
  if (Array.isArray(copilotDir)) {
    for (const entry of copilotDir) {
      if (entry.name.endsWith('.md')) {
        candidatePaths.push(entry.path);
      }
    }
  }

  const files = [];
  for (const path of candidatePaths) {
    const data = await ghApiGet(
      `/repos/${owner}/${repo}/contents/${path}`,
      token
    );
    if (data && data.content && data.encoding === 'base64') {
      const content = atob(data.content.replace(/\n/g, ''));
      files.push({ path, content });
      if (files.length >= 3) break; // cap at 3 files to stay within token limits
    }
  }

  return files;
}

// ── Create a GitHub issue ─────────────────────────────────────
async function createGitHubIssue(owner, repo, token, issueData) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(issueData),
  });

  const data = await res.json();
  if (!res.ok) {
    if (res.status === 401) throw new Error('Invalid or expired token. Update it in Settings.');
    if (res.status === 403) throw new Error('Token lacks permission to create issues. Ensure it has "repo" scope.');
    if (res.status === 404) throw new Error('Repository not found. Check the linked repo in Settings.');
    if (res.status === 410) throw new Error('Issues are disabled for this repository.');
    throw new Error(data.message || `GitHub API error ${res.status}`);
  }

  return data;
}

// ── GitHub Models API analysis ──────────────────────────────
// Endpoint: https://models.inference.ai.azure.com/chat/completions
// Auth:     GitHub Personal Access Token (ghp_* or github_pat_*)
// Docs:     https://docs.github.com/en/github-models
async function analyzeWithAI(ticketData, figmaDesigns, apiKey, model, repoSkillFiles = [], owner = '', repo = '') {
  const figmaContext = figmaDesigns.length
    ? '\n\nFigma Design Info:\n' +
      figmaDesigns
        .map(
          (f) =>
            `- "${f.name}": ${f.description || 'UI design available'} (${f.componentCount || 0} components)`
        )
        .join('\n')
    : '';

  const skillContext = repoSkillFiles.length
    ? '\n\nRepository Skill / Instruction Files (use these to align your output with existing project conventions):\n' +
      repoSkillFiles
        .map((f) => `--- File: ${f.path} ---\n${f.content.slice(0, 2000)}`)
        .join('\n\n')
    : '';

  const repoRef = owner && repo ? `${owner}/${repo}` : 'N/A';

  const systemPrompt =
    'You are an expert software development assistant. Analyze product tickets and produce structured task breakdowns. Always respond with valid JSON only.';

  const commentsContext = ticketData.comments?.length
    ? '\n\nComments (' + ticketData.comments.length + ' total — treat as additional requirements, clarifications, or bug evidence):\n' +
      ticketData.comments
        .map(
          (c, i) =>
            `Comment ${i + 1}${c.imageUrls?.length ? ` [${c.imageUrls.length} image(s) attached]` : ''}: ${c.text || '(image only — see attached image)'}`
        )
        .join('\n\n')
    : '';

  const userPrompt = `Analyze the following software development ticket and produce a structured breakdown.

Ticket Data:
- Platform: ${ticketData.platform}
- ID: ${ticketData.id || 'N/A'}
- Title: ${ticketData.title || 'Untitled'}
- Reported Type: ${ticketData.type || 'Unknown'}
- Description: ${ticketData.description || 'None'}
- Scope: ${ticketData.scope || 'Not defined — skip scope processing'}
- Developer Notes: ${ticketData.devNotes || 'None'}
- Figma URLs: ${ticketData.figmaUrls?.join(', ') || 'None'}
- GitHub Repository: ${repoRef}
- Attachment Images: ${ticketData.images?.length ? `${ticketData.images.length} image(s) provided below — analyze for UI designs, error states, or bug evidence` : 'None'}${figmaContext}${skillContext}${commentsContext}

Rules:
1. Determine the actual ticket type from context (bug, feature, improvement, documentation, chore, refactor).
2. If scope is empty, skip scope analysis and proceed directly using dev notes.
3. Analyze dev notes to determine what type of feature/fix should be implemented (featureType).
4. If Figma designs are present, populate uiTasks from design requirements; otherwise infer UI tasks from description.
5. devTasks must cover backend, data, integration, and testing concerns.
6. Provide at least 3 tasks per category when enough context exists.
7. skillFileName must be kebab-case (no extension).
8. If repository skill/instruction files are provided, use them as context to produce a skillFileContent that aligns with the project's existing conventions; otherwise generate a default skill file.
9. skillFileContent must be a complete Markdown skill file usable by a GitHub Copilot agent, with YAML front matter (applyTo: '**').
10. suggestions must contain 2-4 code snippet ideas relevant to the ticket; each with a title, language, description, and code string.
11. suggestedBranch must follow: {prefix}/{ticket-id}-{short-kebab-title}. Prefix rules: feat/ for feature/improvement, fix/ for bug, docs/ for documentation, chore/ for chore, refactor/ for refactor. Use only lowercase letters and hyphens (e.g. feat/TC-123-add-login-button, fix/BUG-42-null-pointer-crash).
12. issueBody must be a complete GitHub-flavored Markdown issue body containing: a ### Summary section, a ### Tasks checklist (all uiTasks and devTasks as - [ ] items), a ### Acceptance Criteria section, and a ### Technical Notes section. Assign @github-copilot to help with implementation.
13. If comments are provided, incorporate them as additional acceptance criteria, clarifications, or bug evidence into the analysis.
14. If attachment images are included (listed above and sent below as image inputs), analyze each for UI mockups, wireframes, error screenshots, or design specs and incorporate visual insights into tasks, summary, featureType, and skillFileContent.

Respond with a JSON object matching this schema exactly:
{
  "ticketType": "bug|feature|improvement|documentation|chore|refactor",
  "complexity": "low|medium|high",
  "featureType": "one-line description of what needs to be implemented",
  "summary": "2-3 sentence analysis of what this ticket requires",
  "hasScope": true,
  "hasFigma": false,
  "uiTasks": [
    { "id": "UI-1", "title": "task title", "description": "details", "priority": "high|medium|low", "status": "pending" }
  ],
  "devTasks": [
    { "id": "DEV-1", "title": "task title", "description": "details", "priority": "high|medium|low", "status": "pending" }
  ],
  "suggestions": [
    { "title": "snippet title", "language": "typescript", "description": "what this snippet shows", "code": "// code here" }
  ],
  "suggestedBranch": "feat/TC-123-short-title",
  "skillFileName": "kebab-case-feature-name",
  "skillFileContent": "---\\napplyTo: '**'\\n---\\n# Feature\\n...",
  "issueBody": "### Summary\\n...\\n### Tasks\\n- [ ] ...\\n### Acceptance Criteria\\n...\\n### Technical Notes\\n..."
}`;

  const images = ticketData.images || [];
  const userMessageContent = images.length
    ? [
        { type: 'text', text: userPrompt },
        ...images.map((img) => ({
          type: 'image_url',
          image_url: { url: img.base64, detail: 'low' },
        })),
      ]
    : userPrompt;

  const res = await fetch('https://models.inference.ai.azure.com/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model || 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessageContent },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    const code = res.status;
    if (code === 401) throw new Error('Invalid GitHub token or Copilot access not enabled. Check Settings.');
    if (code === 403) throw new Error('GitHub token lacks required permissions. Ensure it has Copilot access.');
    if (code === 429) throw new Error('GitHub Models rate limit reached. Please wait a moment.');
    throw new Error(errData.error?.message || `GitHub Models API error ${code}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty response from AI.');

  return JSON.parse(content);
}

// ── Figma API ───────────────────────────────────────────────
async function fetchFigmaData(url, token) {
  const fileMatch = url.match(/figma\.com\/(?:file|design)\/([^/?#]+)/);
  if (!fileMatch) return null;

  const fileKey = fileMatch[1];
  const nodeMatch = url.match(/node-id=([^&]+)/);
  const nodeId = nodeMatch ? decodeURIComponent(nodeMatch[1]) : null;

  const endpoint = nodeId
    ? `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`
    : `https://api.figma.com/v1/files/${fileKey}`;

  const res = await fetch(endpoint, { headers: { 'X-Figma-Token': token } });
  if (!res.ok) return null;

  const data = await res.json();
  const doc =
    data.document ||
    (data.nodes ? Object.values(data.nodes)[0]?.document : null);

  return {
    name: data.name || 'Figma Design',
    description: doc?.name || '',
    componentCount: countFigmaComponents(doc),
    lastModified: data.lastModified || null,
  };
}

function countFigmaComponents(node, count = 0) {
  if (!node) return count;
  if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') count++;
  if (node.children) {
    for (const child of node.children) {
      count = countFigmaComponents(child, count);
    }
  }
  return count;
}

// ── Skill file builder (fallback if AI returns empty) ───────
async function buildSkillFile(analysis, ticketData) {
  const content =
    analysis.skillFileContent || buildDefaultSkillFile(analysis, ticketData);
  return {
    content,
    filename: `${sanitizeFilename(analysis.skillFileName || 'feature')}.md`,
  };
}

function buildDefaultSkillFile(analysis, ticketData) {
  const uiList =
    (analysis.uiTasks || [])
      .map((t) => `- [ ] **${t.title}**: ${t.description}`)
      .join('\n') || '- [ ] No UI tasks defined';

  const devList =
    (analysis.devTasks || [])
      .map((t) => `- [ ] **${t.title}**: ${t.description}`)
      .join('\n') || '- [ ] No dev tasks defined';

  const figmaLinks =
    ticketData.figmaUrls?.length
      ? ticketData.figmaUrls.map((u) => `- [Figma Design](${u})`).join('\n')
      : '- No design files attached';

  const ticketRef =
    ticketData.url
      ? `- [${ticketData.id || 'Ticket'}](${ticketData.url})`
      : `- ${ticketData.id || 'N/A'}`;

  return `---
applyTo: '**'
---
# ${ticketData.title || 'Feature Implementation'}

## Overview
**Ticket**: ${ticketData.id || 'N/A'}  
**Type**: ${analysis.ticketType}  
**Complexity**: ${analysis.complexity}  
**Feature**: ${analysis.featureType}

## Summary
${analysis.summary}

## Implementation Guide

### UI Tasks
${uiList}

### Development Tasks
${devList}

## Developer Notes
${ticketData.devNotes || 'No developer notes provided.'}

## Resources
${figmaLinks}
${ticketRef}
`;
}

function sanitizeFilename(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}
