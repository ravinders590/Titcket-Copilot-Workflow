# Ticket Analyser — Chrome Extension

**AI-powered ticket analyser** that reads your Jira, GitHub, or Linear tickets and automatically generates task breakdowns, Copilot skill files, and GitHub issues — all from your browser.

---

## What Does It Do?

Ticket Analyser sits on top of your ticket platforms. When you open a ticket, it:

1. **Reads the ticket** — title, description, key details, QA acceptance criteria, dev notes, comments, and attached images.
2. **Analyses with AI** — Sends the data to the GitHub Models API (GPT-4o) which determines the ticket type, complexity, and produces a full task breakdown.
3. **Generates a skill file** — Creates a production-ready `.md` file that GitHub Copilot can use to implement the ticket in your IDE.
4. **Creates GitHub issues** — One click to push the analysis as a structured GitHub issue with tasks, QA criteria, edge cases, and testing strategy.

No context switching. No manual copy-paste. Open a ticket → get everything you need to start coding.

---

## Features

### Ticket Analysis
- **Auto-detect ticket type** — bug, feature, improvement, documentation, chore, or refactor
- **Complexity rating** — low, medium, or high
- **Key Details & QA Acceptance** — Reads custom Jira fields (Key Details, QA Acceptance) and markdown sections on GitHub/Linear
- **Image analysis** — Reads attached screenshots/mockups and identifies errors, UI designs, or bug evidence
- **Comment parsing** — Incorporates ticket comments as additional context

### Task Breakdown
- **UI Tasks** — Front-end work items with priority levels
- **Dev Tasks** — Backend, data, integration, and testing tasks
- **Task checkboxes** — Track progress directly in the extension; state syncs between popup and side panel

### Skill File Generation
- **Auto-generated Copilot skill file** — Complete `.md` with Ticket context, Constraints, Architecture, Tasks, QA Acceptance, Edge Cases, and Testing Strategy
- **Repo-aware** — Reads existing `.github/copilot-instructions.md`, `SKILL.md`, and `.github/instructions/` files to align with your project conventions
- **Copy or download** — One click to copy to clipboard or download as `.md`

### GitHub Integration
- **Create issues** — Push the full analysis as a GitHub issue with checklist tasks, assigned to `@github-copilot`
- **Trigger workflows** — Run GitHub Actions directly from the extension
- **Create branches** — AI-suggested branch names (e.g., `feat/TC-123-add-login-button`)
- **Create pull requests** — Pre-filled with ticket context
- **Browse open issues & PRs** — View and navigate without leaving the page

### Code Suggestions
- **2–4 code snippets** per ticket — Relevant starter code with language, description, and one-click copy

### Floating Side Panel
- **Draggable** — Grab the header to move anywhere on screen
- **Resizable** — Drag the corner to resize
- **Only appears on ticket pages** — Won't show on dashboards or non-ticket pages

### Caching
- **1-hour cache** — Avoid repeated API calls; clear or re-analyse anytime

---

## Supported Platforms

| Platform | Pages |
|----------|-------|
| **Jira Cloud** | `/browse/PROJ-123`, `/issues/PROJ-123`, board views |
| **GitHub** | `/issues/123`, `/pull/123` |
| **Linear** | `/issue/TEAM-123` |

---

## Installation (Step by Step)

### Step 1: Download the Extension

Download or clone the `ticketCopilot` folder to your computer.

### Step 2: Load in Chrome

1. Open Chrome and go to `chrome://extensions/`
2. Turn on **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `ticketCopilot` folder
5. The extension icon appears in your toolbar

### Step 3: Get a GitHub Token

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens/new?description=Ticket+Analyser)
2. Create a **Personal Access Token** with these scopes:
   - `repo` — for creating issues, branches, PRs, and reading skill files
   - `workflow` — for triggering GitHub Actions
3. Copy the token (starts with `ghp_` or `github_pat_`)

### Step 4: Configure Settings

1. Click the Ticket Analyser icon in the Chrome toolbar
2. Click the **Settings** gear icon (or right-click the icon → Options)
3. Paste your **GitHub Personal Access Token**
4. (Optional) Add a **Figma Personal Access Token** if you use Figma designs in tickets
5. (Optional) Set your preferred **AI Model** (GPT-4o recommended)
6. Click **Save**

---

## Usage (Step by Step)

### Using the Popup

1. Open a ticket in Jira, GitHub, or Linear
2. Click the **Ticket Analyser** icon in the Chrome toolbar
3. The extension reads the ticket and shows a loading spinner
4. After a few seconds, you see the full analysis:
   - **Ticket card** — type, complexity, summary
   - **Tasks tab** — UI tasks and Dev tasks with checkboxes
   - **Skill File tab** — generated `.md` file ready for Copilot
   - **Copilots tab** — code snippets and suggestions
   - **Workflows tab** — GitHub repo management (issues, PRs, branches, actions)

### Using the Floating Panel (Side Panel)

1. Open a ticket in Jira, GitHub, or Linear
2. A green **"Copilot"** button appears at the bottom-right of the page
3. Click it to open the floating analysis panel
4. **Drag** the header bar to move it anywhere
5. **Resize** by dragging the bottom-right corner
6. The panel has the same tabs as the popup (Tasks, Skill File, Copilots, Workflows)

### Creating a GitHub Issue

1. Analyse a ticket (popup or side panel)
2. Go to the **Workflows** tab
3. Select or search for your repository
4. Click **Create GitHub Issue**
5. Confirm — the issue is created with:
   - Full task checklist (UI + Dev tasks)
   - QA Acceptance criteria
   - Edge cases and testing strategy
   - Assigned to `@github-copilot`

### Generating & Using a Skill File

1. Analyse a ticket
2. Go to the **Skill File** tab
3. Click **Copy** or **Download**
4. Place the downloaded `.md` file in your project:
   - `.github/instructions/` folder, or
   - `.copilot/` folder, or
   - Project root as `SKILL.md`
5. GitHub Copilot in your IDE will now use this file as context when implementing the ticket

### Triggering a Workflow

1. Go to **Workflows** tab → **Workflows** sub-tab
2. Select a branch from the dropdown next to the workflow
3. Click **Run**

### Creating a Branch

1. Go to **Workflows** tab → **Branch** sub-tab
2. The AI-suggested branch name is pre-filled (e.g., `feat/PROJ-123-add-login`)
3. Select a source branch
4. Click **Create Branch**

### Creating a Pull Request

1. Go to **Workflows** tab → **Pull Requests** sub-tab
2. Select base and compare branches
3. Title is pre-filled from the ticket
4. Click **Create Pull Request**

---

## Settings Reference

| Setting | Required | Description |
|---------|----------|-------------|
| **GitHub Token** | Yes | Personal Access Token with `repo` + `workflow` scopes |
| **AI Model** | No | GPT-4o (default), GPT-4o Mini, o1, or o1 Mini |
| **Figma Token** | No | Enables fetching Figma component data from linked designs |
| **Linked Repo** | No | Auto-detected from GitHub tickets; manually set for Jira/Linear |
| **Platform toggles** | No | Enable/disable injection on Jira, GitHub, or Linear |

---

## How It Works (Architecture)

```
Ticket Page (Jira / GitHub / Linear)
        │
        ▼
   content.js ── extracts ticket data + images
        │
        ▼
   background.js ── calls GitHub Models API (GPT-4o)
        │           ── fetches Figma designs (optional)
        │           ── reads repo skill files from GitHub
        │
        ▼
   AI returns structured JSON
        │
        ▼
   popup.js / content.js ── renders results
                           ── task management
                           ── skill file download
                           ── GitHub issue/PR/branch creation
```

---

## File Structure

```
ticketCopilot/
├── manifest.json     ← Extension config (Manifest v3)
├── background.js     ← Service worker: AI analysis, GitHub API, Figma API
├── content.js        ← Injected on ticket pages: extraction, FAB, side panel
├── content.css       ← Styles for injected elements
├── popup.html/js/css ← Extension popup UI
├── options.html/js/css ← Settings page
└── icons/            ← Extension icons (16, 48, 128px)
```

---

## FAQ

**Q: Do I need an OpenAI API key?**
No. The extension uses the GitHub Models API, which is free with a GitHub account that has Copilot access.

**Q: Is my data sent anywhere?**
Ticket data is sent to the GitHub Models API (`models.inference.ai.azure.com`) for analysis. No data is stored on any server. Cached results are stored locally in your browser.

**Q: Why doesn't the button appear?**
The button only appears on ticket pages (not dashboards, boards, or settings). Make sure the page has fully loaded.

**Q: Can I use it on private Jira boards?**
Yes. The content script runs in the context of your authenticated browser session.

**Q: How do I clear the cache?**
Click the trash icon next to "Re-analyse Ticket" in the popup or side panel.

---

## Version

**v1.1.0** — Ticket Analyser

---
