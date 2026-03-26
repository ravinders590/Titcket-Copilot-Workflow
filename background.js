/* ================================================================
   Ticket Analyser — Background Service Worker
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

  if (msg.type === 'DETECT_CODEBASE') {
    const { owner, repo, token } = msg.payload;
    detectCodebase(owner, repo, token)
      .then((info) => sendResponse({ codebase: info }))
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
  let codebaseInfo = null;
  if (owner && repo) {
    [repoSkillFiles, codebaseInfo] = await Promise.all([
      fetchRepoSkillFiles(owner, repo, githubToken),
      detectCodebase(owner, repo, githubToken),
    ]);
  }

  const analysis = await analyzeWithAI(ticketData, figmaDesigns, githubToken, aiModel, repoSkillFiles, owner, repo, codebaseInfo);
  // Annotate with resolved repo info for the popup to use
  analysis._owner = owner;
  analysis._repo = repo;
  analysis._repoSkillFilesLoaded = repoSkillFiles.length > 0;
  analysis._repoSkillFiles = repoSkillFiles; // pass actual files to UI
  analysis._codebase = codebaseInfo; // pass detected tech stack to UI

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

// ── Detect codebase tech stack from repo ─────────────────────
async function detectCodebase(owner, repo, token) {
  if (!owner || !repo || !token) return null;

  // Fetch language breakdown
  const languages = await ghApiGet(`/repos/${owner}/${repo}/languages`, token) || {};
  const totalBytes = Object.values(languages).reduce((a, b) => a + b, 0) || 1;
  const langBreakdown = Object.entries(languages)
    .sort((a, b) => b[1] - a[1])
    .map(([lang, bytes]) => ({ lang, pct: Math.round((bytes / totalBytes) * 100) }));

  // Fetch root tree to identify frameworks, config files, package managers
  const rootFiles = await ghApiGet(`/repos/${owner}/${repo}/contents/`, token) || [];
  const rootNames = Array.isArray(rootFiles) ? rootFiles.map((f) => f.name) : [];

  // Detect frameworks, tools, and config
  const markers = {
    'package.json': 'Node.js / npm',
    'yarn.lock': 'Yarn',
    'pnpm-lock.yaml': 'pnpm',
    'tsconfig.json': 'TypeScript',
    'next.config.js': 'Next.js',
    'next.config.mjs': 'Next.js',
    'next.config.ts': 'Next.js',
    'nuxt.config.js': 'Nuxt.js',
    'nuxt.config.ts': 'Nuxt.js',
    'angular.json': 'Angular',
    'vue.config.js': 'Vue.js',
    'vite.config.js': 'Vite',
    'vite.config.ts': 'Vite',
    'webpack.config.js': 'Webpack',
    'tailwind.config.js': 'Tailwind CSS',
    'tailwind.config.ts': 'Tailwind CSS',
    'postcss.config.js': 'PostCSS',
    '.eslintrc.js': 'ESLint',
    '.eslintrc.json': 'ESLint',
    'eslint.config.js': 'ESLint',
    '.prettierrc': 'Prettier',
    'jest.config.js': 'Jest',
    'jest.config.ts': 'Jest',
    'vitest.config.ts': 'Vitest',
    'cypress.config.js': 'Cypress',
    'playwright.config.ts': 'Playwright',
    'Dockerfile': 'Docker',
    'docker-compose.yml': 'Docker Compose',
    'docker-compose.yaml': 'Docker Compose',
    'Cargo.toml': 'Rust / Cargo',
    'go.mod': 'Go',
    'requirements.txt': 'Python / pip',
    'pyproject.toml': 'Python',
    'setup.py': 'Python',
    'Pipfile': 'Python / Pipenv',
    'Gemfile': 'Ruby / Bundler',
    'build.gradle': 'Java / Gradle',
    'build.gradle.kts': 'Kotlin / Gradle',
    'pom.xml': 'Java / Maven',
    'composer.json': 'PHP / Composer',
    'pubspec.yaml': 'Flutter / Dart',
    '.github': 'GitHub Actions',
    'Makefile': 'Make',
    'CMakeLists.txt': 'CMake',
    '.env.example': 'Environment config',
    'prisma': 'Prisma ORM',
    'drizzle.config.ts': 'Drizzle ORM',
    'manifest.json': 'Chrome Extension / Web Manifest',
  };

  const detected = [];
  for (const name of rootNames) {
    if (markers[name]) detected.push(markers[name]);
  }

  // Try reading package.json for deeper framework detection
  let packageInfo = null;
  if (rootNames.includes('package.json')) {
    const pkgData = await ghApiGet(`/repos/${owner}/${repo}/contents/package.json`, token);
    if (pkgData?.content && pkgData.encoding === 'base64') {
      try {
        const pkgJson = JSON.parse(atob(pkgData.content.replace(/\n/g, '')));
        packageInfo = {
          name: pkgJson.name || '',
          scripts: Object.keys(pkgJson.scripts || {}),
        };
        const allDeps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };
        const fwDetect = {
          react: 'React', 'react-dom': 'React', 'next': 'Next.js',
          vue: 'Vue.js', nuxt: 'Nuxt.js', '@angular/core': 'Angular',
          svelte: 'Svelte', '@sveltejs/kit': 'SvelteKit',
          express: 'Express.js', fastify: 'Fastify', 'koa': 'Koa',
          'nest': 'NestJS', '@nestjs/core': 'NestJS',
          tailwindcss: 'Tailwind CSS', prisma: 'Prisma',
          drizzle: 'Drizzle ORM', mongoose: 'Mongoose',
          sequelize: 'Sequelize', typeorm: 'TypeORM',
          jest: 'Jest', vitest: 'Vitest', mocha: 'Mocha',
          cypress: 'Cypress', playwright: 'Playwright',
          storybook: 'Storybook', '@storybook/react': 'Storybook',
          electron: 'Electron', 'react-native': 'React Native',
          expo: 'Expo', redux: 'Redux', '@reduxjs/toolkit': 'Redux Toolkit',
          zustand: 'Zustand', mobx: 'MobX',
          graphql: 'GraphQL', '@apollo/client': 'Apollo GraphQL',
          trpc: 'tRPC', '@trpc/server': 'tRPC',
          socket: 'Socket.io', 'socket.io': 'Socket.io',
        };
        for (const [dep, label] of Object.entries(fwDetect)) {
          if (allDeps[dep]) detected.push(label);
        }
      } catch { /* malformed package.json */ }
    }
  }

  // Deduplicate
  const stack = [...new Set(detected)];

  // Determine primary language
  const primaryLang = langBreakdown[0]?.lang || 'Unknown';

  // File type summary from root
  const fileTypes = rootNames
    .filter((n) => n.includes('.'))
    .map((n) => '.' + n.split('.').pop())
    .filter((ext, i, arr) => arr.indexOf(ext) === i)
    .slice(0, 15);

  return {
    primaryLanguage: primaryLang,
    languages: langBreakdown.slice(0, 8),
    stack,
    fileTypes,
    packageInfo,
    rootFiles: rootNames.slice(0, 30),
  };
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
async function analyzeWithAI(ticketData, figmaDesigns, apiKey, model, repoSkillFiles = [], owner = '', repo = '', codebaseInfo = null) {
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

  const codebaseContext = codebaseInfo
    ? '\n\nDetected Codebase Tech Stack (CRITICAL — use these to generate framework-specific, idiomatic code and skill files):\n' +
      `- Primary Language: ${codebaseInfo.primaryLanguage}\n` +
      (codebaseInfo.languages.length ? `- Languages: ${codebaseInfo.languages.map((l) => `${l.lang} (${l.pct}%)`).join(', ')}\n` : '') +
      (codebaseInfo.stack.length ? `- Frameworks & Tools: ${codebaseInfo.stack.join(', ')}\n` : '') +
      (codebaseInfo.fileTypes.length ? `- File Types: ${codebaseInfo.fileTypes.join(', ')}\n` : '') +
      (codebaseInfo.packageInfo?.scripts?.length ? `- Available Scripts: ${codebaseInfo.packageInfo.scripts.join(', ')}\n` : '') +
      '\nYou MUST write all code suggestions, Architecture & Approach, and skillFileContent using the detected frameworks and language. For example: if React is detected, use React components/hooks; if Next.js, use App Router patterns; if Express, use Express middleware; if TypeScript is detected, all code MUST be TypeScript with proper types. Never use a framework not in the detected stack.\n'
    : '';

  const systemPrompt =
    'You are an expert software development assistant who produces precise, actionable skill files for GitHub Copilot agents. Analyze product tickets and produce structured task breakdowns. When a detected tech stack is provided, you MUST generate all code, architecture, and skill files using those specific frameworks and languages — never use generic or mismatched technologies. Always respond with valid JSON only.';

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
- Key Details (General): ${ticketData.keyDetails || 'None'}
- QA Acceptance Criteria: ${ticketData.qaAcceptance || 'None'}
- Developer Notes: ${ticketData.devNotes || 'None'}
- Figma URLs: ${ticketData.figmaUrls?.join(', ') || 'None'}
- GitHub Repository: ${repoRef}
- Attachment Images: ${ticketData.images?.length ? `${ticketData.images.length} image(s) provided below — analyze for UI designs, error states, or bug evidence` : 'None'}${figmaContext}${skillContext}${codebaseContext}${commentsContext}

Rules:
1. Determine the actual ticket type from context (bug, feature, improvement, documentation, chore, refactor).
2. If scope is empty, skip scope analysis and proceed directly using dev notes.
3. Analyze dev notes to determine what type of feature/fix should be implemented (featureType).
4. If Key Details (General) are provided, use them as primary context for understanding the ticket's purpose, requirements, and constraints. These details define the core of what needs to be done.
5. If QA Acceptance Criteria are provided, use them to define acceptance criteria, validation rules, and testing expectations. These MUST be reflected in devTasks (as testing/validation tasks) and in the skillFileContent's Implementation Guide.
6. If Figma designs are present, populate uiTasks from design requirements; otherwise infer UI tasks from description.
7. devTasks must cover backend, data, integration, and testing concerns.
8. Provide at least 3 tasks per category when enough context exists.
9. skillFileName must be kebab-case (no extension).
10. If repository skill/instruction files are provided, use them as context to produce a skillFileContent that aligns with the project's existing conventions; otherwise generate a default skill file. If Detected Codebase Tech Stack is provided, this is the HIGHEST priority context — you MUST:
   a) Write ALL code suggestions using the detected primary language and frameworks (e.g. TypeScript + React, Python + FastAPI, Go + gin).
   b) Reference detected tools in the Constraints & Rules section (e.g. "Use Prisma for database queries", "Style with Tailwind CSS classes", "Run tests with Vitest").
   c) In Architecture & Approach, describe the implementation using the detected project structure and patterns.
   d) In Testing Strategy, reference the detected test framework (Jest, Vitest, Cypress, Playwright, etc.).
   e) All suggestions must use detected file extensions (e.g. .tsx for React+TypeScript, .vue for Vue, .py for Python).
11. skillFileContent must be a complete, production-ready Markdown skill file that a GitHub Copilot agent can use to implement the ticket end-to-end WITHOUT needing to read the original ticket. Use YAML front matter (applyTo: '**'). Structure MUST follow this exact layout:

   # {Ticket Title}

   ## Ticket
   - **ID**: (ticket ID)
   - **Title**: (exact ticket title)
   - **Type**: (bug / feature / improvement / etc.)
   - **Complexity**: (low / medium / high)
   - **Description**: (a thorough description synthesized from: ticket description, key details, dev notes, comments, and any visual information extracted from attached images. Be specific — mention exact field names, endpoints, component names, error messages, or UI elements.)

   ## Constraints & Rules
   (List specific technical constraints, business rules, and boundaries. E.g. "Must use async/await", "Do not modify the auth middleware", "Response time must be < 200ms". Derive these from dev notes, key details, scope, and QA criteria.)

   ## Architecture & Approach
   (Describe the recommended implementation approach: which files to modify, which patterns to follow, which services/layers are involved. Reference existing repo conventions if repo skill files were provided.)

   ## Tasks
   ### UI Tasks
   (List each UI task as: - **{ID} {Title}** [{priority}]: {description})
   ### Dev Tasks
   (List each dev task as: - **{ID} {Title}** [{priority}]: {description})

   ## QA Acceptance
   (If QA acceptance criteria are available, list every criterion verbatim then add any inferred criteria. If not available, derive acceptance criteria from the ticket requirements. Each criterion should be testable and specific.)

   ## Edge Cases & Pitfalls
   (List 2-5 edge cases, error scenarios, or common pitfalls the developer should handle. E.g. "Empty state when no data returned", "Race condition if user navigates away during save", "Token expiry mid-request".)

   ## Testing Strategy
   (Describe what tests to write: unit tests, integration tests, manual test steps. Reference the QA acceptance criteria.)

   ## References
   (Ticket URL, Figma links, related docs.)
12. suggestions must contain 2-4 code snippet ideas relevant to the ticket; each with a title, language, description, and code string. The language field MUST match the primary detected language (e.g. "typescript" not "javascript" if TypeScript is detected). All code MUST use the detected frameworks — for example, if React is detected, show React component code; if NestJS is detected, show NestJS controller/service code. Never provide generic code when the tech stack is known.
13. suggestedBranch must follow: {prefix}/{ticket-id}-{short-kebab-title}. Prefix rules: feat/ for feature/improvement, fix/ for bug, docs/ for documentation, chore/ for chore, refactor/ for refactor. Use only lowercase letters and hyphens (e.g. feat/TC-123-add-login-button, fix/BUG-42-null-pointer-crash).
14. issueBody must be a complete GitHub-flavored Markdown issue body that mirrors the skill file structure so the issue and skill file stay in sync. It MUST contain these sections in order:
   ### Summary
   (2-3 sentence overview of what this ticket requires.)
   ### Ticket Context
   - **Type**: bug/feature/improvement/etc.
   - **Complexity**: low/medium/high
   - **Feature**: featureType one-liner
   - **Key Details**: key details if provided, otherwise omit
   ### Constraints & Rules
   (Bullet list of technical constraints, business rules, and boundaries derived from dev notes, scope, and QA criteria.)
   ### Tasks
   **UI Tasks**
   (Each UI task as - [ ] **{ID} {Title}** [{priority}]: {description})
   **Dev Tasks**
   (Each dev task as - [ ] **{ID} {Title}** [{priority}]: {description})
   ### QA Acceptance
   (QA acceptance criteria as a checklist. Use QA criteria from the ticket if provided; otherwise derive from requirements.)
   ### Edge Cases
   (2-5 edge cases or pitfalls as bullet items.)
   ### Testing Strategy
   (Unit tests, integration tests, manual steps.)
   ### References
   (Ticket URL, Figma links, suggested branch in backticks.)
   > This issue was generated by Ticket Analyser. Assign @github-copilot for AI-assisted implementation.
15. If comments are provided, incorporate them as additional acceptance criteria, clarifications, or bug evidence into the analysis.
16. If attachment images are included (listed above and sent below as image inputs), analyze each for UI mockups, wireframes, error screenshots, error messages, stack traces, console logs, or design specs. Determine whether each image shows an error/bug (identify the error type, message, and likely root cause) or a feature/design (identify UI elements, layout, interactions). Incorporate ALL visual insights into tasks, summary, featureType, and especially into the skillFileContent — the skill file's Ticket Description and Implementation Guide must reflect what was observed in the images so the Copilot agent has full visual context even without seeing the images.

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
      .map((t) => `- **${t.id} ${t.title}** [${t.priority || 'medium'}]: ${t.description}`)
      .join('\n') || '- No UI tasks defined';

  const devList =
    (analysis.devTasks || [])
      .map((t) => `- **${t.id} ${t.title}** [${t.priority || 'medium'}]: ${t.description}`)
      .join('\n') || '- No dev tasks defined';

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

## Ticket
- **ID**: ${ticketData.id || 'N/A'}
- **Title**: ${ticketData.title || 'Untitled'}
- **Type**: ${analysis.ticketType}
- **Complexity**: ${analysis.complexity}
- **Description**: ${ticketData.description || analysis.summary || 'No description provided.'}

## Constraints & Rules
${ticketData.devNotes ? `- Developer Notes: ${ticketData.devNotes}` : '- Follow existing project conventions'}
${ticketData.scope ? `- Scope: ${ticketData.scope}` : ''}

## Architecture & Approach
**Feature**: ${analysis.featureType}

${analysis.summary}

## Tasks

### UI Tasks
${uiList}

### Dev Tasks
${devList}

## QA Acceptance
${ticketData.qaAcceptance || '- Verify all tasks are completed and tested\n- Code follows project conventions\n- No regressions introduced'}

## Edge Cases & Pitfalls
- Handle empty / null data gracefully
- Validate user inputs at system boundaries
- Consider loading and error states in the UI

## Testing Strategy
- Unit tests for new business logic
- Integration tests for API / data layer changes
- Manual verification against QA acceptance criteria above

## References
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
