/* SignalREACH homepage chat: local, deterministic, and dependency-free.
 * Extend TOPICS to add knowledge. No network, storage, DOM, or code execution here.
 * All text is curated example content, not a live product/API guarantee. */
(() => {
  'use strict';
  const TOPICS = [
  {
    "id": "overview",
    "label": "What is REACH?",
    "group": "Start",
    "keywords": [
      "signalreach",
      "signal reach",
      "what is reach",
      "what can reach do",
      "what can you do",
      "features",
      "overview",
      "capabilities",
      "explain reach",
      "what does reach do"
    ],
    "summary": "SignalREACH brings project context and AI conversations into a connected workspace. This website lets you explore Studio, the relay, the VS Code extension, and the tray bridge without connecting an account.",
    "steps": [
      "Explore the product surfaces on the Platform page.",
      "Choose a surface that fits your workflow.",
      "Use its setup guide and configure a compatible endpoint in the real application."
    ],
    "example": "A typical workflow: open a project → select relevant files → ask for a plan → review the proposed changes.",
    "next": [
      "studio",
      "install",
      "integrations"
    ],
    "actions": [
      "platform",
      "tour"
    ]
  },
  {
    "id": "install",
    "label": "Get started",
    "group": "Start",
    "keywords": [
      "install",
      "installation",
      "download",
      "setup",
      "set up",
      "getting started",
      "get started",
      "start using",
      "prerequisite",
      "requirements",
      "windows",
      "macos",
      "linux"
    ],
    "summary": "Start with the Download page and the upstream setup guide for your operating system. This website is a preview, not an installer or a running Studio instance.",
    "steps": [
      "Choose your operating system on the Download page.",
      "Check the current prerequisites in the linked project guide.",
      "Follow the source setup instructions, then configure an endpoint in the application."
    ],
    "example": "To run this website package locally:\ncd SignalREACH-website\nnpm start\n\nOpen http://127.0.0.1:4173. The separate Studio app has its own setup.",
    "next": [
      "endpoints",
      "studio",
      "network"
    ],
    "actions": [
      "install",
      "docs"
    ]
  },
  {
    "id": "studio",
    "label": "REACH Studio",
    "group": "Start",
    "keywords": [
      "studio",
      "desktop app",
      "electron",
      "workspace app",
      "project workspace",
      "open project",
      "desktop workspace"
    ],
    "summary": "REACH Studio is the project workspace: files, an editor, and conversations stay close together. The panel on this page is only an interactive illustration of that workflow.",
    "steps": [
      "Open or create a project in the actual Studio application.",
      "Select the files that matter to your request.",
      "Configure a model connection and review its output before applying changes."
    ],
    "example": "Try this prompt in a configured workspace: “Read the selected files, explain the architecture, and propose the smallest change for a new feature.”",
    "next": [
      "files",
      "agents",
      "endpoints"
    ],
    "actions": [
      "studio",
      "platform"
    ]
  },
  {
    "id": "relay",
    "label": "Relay and API",
    "group": "Connect",
    "keywords": [
      "relay",
      "api server",
      "proxy",
      "openai compatible",
      "openai-compatible",
      "rest api",
      "chat completions",
      "api integration",
      "api endpoint",
      "api"
    ],
    "summary": "The relay provides an OpenAI-compatible connection surface. Use the base URL, access policy, and model catalog of the relay you actually run; this demo sends no API requests.",
    "steps": [
      "Confirm the relay is running and note its base URL.",
      "Supply the access key required by the host.",
      "Select a model that the endpoint exposes and test a small request in your client."
    ],
    "example": "Connection fields:\nBase URL: <your-host>/v1\nAPI key: <configured outside this website>\nModel: <model ID from your endpoint>",
    "next": [
      "endpoints",
      "apikey",
      "streaming"
    ],
    "actions": [
      "endpoint"
    ]
  },
  {
    "id": "vscode",
    "label": "VS Code extension",
    "group": "Start",
    "keywords": [
      "vs code",
      "vscode",
      "visual studio code",
      "extension",
      "editor integration",
      "ide",
      "code editor"
    ],
    "summary": "The project includes a VS Code extension for REACH chat and coding. Install and configure the actual extension to use workspace context; the website cannot inspect your editor.",
    "steps": [
      "Follow the extension setup guide.",
      "Configure a supported provider route and choose an available model.",
      "Attach the relevant files and review the proposed code changes."
    ],
    "example": "A useful editor prompt: “Explain this selected function, identify one edge case, and suggest a focused regression test.”",
    "next": [
      "files",
      "debugging",
      "endpoints"
    ],
    "actions": [
      "editor"
    ]
  },
  {
    "id": "tray",
    "label": "Tray bridge",
    "group": "Connect",
    "keywords": [
      "tray",
      "bridge",
      "system tray",
      "desktop bridge",
      "background app",
      "provider bridge",
      "local bridge"
    ],
    "summary": "The tray bridge is a separate project surface used by provider routes that need a local bridge. Follow the route’s guide and keep the required application running.",
    "steps": [
      "Identify whether your chosen route needs the tray bridge.",
      "Follow its configuration and access instructions.",
      "Verify the local bridge before debugging the client connection."
    ],
    "example": "Connection checklist: client settings → local bridge status → provider access → selected model.",
    "next": [
      "network",
      "integrations",
      "endpoints"
    ],
    "actions": [
      "platform",
      "integrations"
    ]
  },
  {
    "id": "endpoints",
    "label": "Connect a model",
    "group": "Connect",
    "keywords": [
      "endpoint",
      "connect",
      "connection settings",
      "base url",
      "server url",
      "configure model",
      "connect a model",
      "connect an endpoint",
      "host url",
      "v1"
    ],
    "summary": "In the real application, enter your endpoint’s base URL, required access key, and an available model ID. This local demo does not open a connection or collect credentials.",
    "steps": [
      "Confirm the host is running and copy its documented base URL.",
      "Enter the required key only in the application’s connection settings.",
      "Choose an exposed model and test a short prompt."
    ],
    "example": "Use placeholders in shared examples:\nBase URL: <your-endpoint>/v1\nKey: YOUR_REACH_KEY\nModel: YOUR_MODEL_ID",
    "next": [
      "models",
      "apikey",
      "network"
    ],
    "actions": [
      "endpoint"
    ]
  },
  {
    "id": "local",
    "label": "Local models",
    "group": "Connect",
    "keywords": [
      "local model",
      "local ai",
      "offline model",
      "offline ai",
      "ollama",
      "lm studio",
      "localhost",
      "127 0 0 1",
      "self hosted",
      "self-hosted",
      "on device",
      "on-device"
    ],
    "summary": "For a local host, first verify that it exposes the compatible API your client expects. Copy the base URL and model ID from that host. This browser demo cannot detect installed models.",
    "steps": [
      "Start the local model host and make the intended model available.",
      "Check the host’s documented API compatibility and access requirements.",
      "Connect from the actual client; localhost means the machine running that client."
    ],
    "example": "“It runs on my desktop but not my phone” often means a localhost URL is pointing at the phone rather than the desktop. Check the network path without making a private service public.",
    "next": [
      "endpoints",
      "models",
      "network"
    ],
    "actions": [
      "endpoint"
    ]
  },
  {
    "id": "models",
    "label": "Model selection",
    "group": "Connect",
    "keywords": [
      "model",
      "models",
      "model id",
      "model catalog",
      "choose model",
      "switch model",
      "which model",
      "llm",
      "provider",
      "gpt",
      "claude",
      "gemini",
      "qwen"
    ],
    "summary": "The configured host determines which models you can select. Use its real model catalog rather than an example ID; this website has no live model inventory.",
    "steps": [
      "Check the models exposed by your configured endpoint.",
      "Choose one that supports your task and required input types.",
      "Test with a small request before adding a large project context."
    ],
    "example": "Comparison checklist: task fit, context needs, supported inputs, response time, and the host’s usage limits. The demo does not benchmark or rank providers.",
    "next": [
      "endpoints",
      "attachments",
      "pricing"
    ],
    "actions": [
      "integrations",
      "endpoint"
    ]
  },
  {
    "id": "apikey",
    "label": "API keys",
    "group": "Connect",
    "keywords": [
      "api key",
      "api keys",
      "access key",
      "token",
      "bearer",
      "credential",
      "credentials",
      "authentication key",
      "secret",
      "key settings"
    ],
    "summary": "Keep real keys out of this chat and out of public source files. Add credentials only in the real application’s connection settings or the storage mechanism described by its guide.",
    "steps": [
      "Get the required credential from your endpoint host.",
      "Configure it through the application’s supported settings.",
      "Use placeholders in shared commands and rotate a key if it was exposed."
    ],
    "example": "Safe shared example: Authorization: Bearer YOUR_REACH_KEY\nNever replace that placeholder with a real key in a public repository.",
    "next": [
      "authentication",
      "privacy",
      "endpoints"
    ],
    "actions": [
      "privacy",
      "endpoint"
    ]
  },
  {
    "id": "streaming",
    "label": "Streaming responses",
    "group": "Connect",
    "keywords": [
      "stream",
      "streaming",
      "sse",
      "server sent events",
      "token streaming",
      "stream response",
      "typewriter"
    ],
    "summary": "Streaming lets a compatible endpoint deliver a response incrementally. The animated text here only simulates that feeling with a local timer; no model is generating it.",
    "steps": [
      "Check whether your actual endpoint and client support streaming.",
      "Use the streaming option described in the API guide.",
      "Handle cancellation and errors instead of leaving the interface in a loading state."
    ],
    "example": "The website chat has a Stop control while text appears. Stopping it does not cancel an AI request, because no request was sent.",
    "next": [
      "relay",
      "network",
      "limits"
    ],
    "actions": [
      "endpoint"
    ]
  },
  {
    "id": "integrations",
    "label": "Integrations",
    "group": "Connect",
    "keywords": [
      "integration",
      "integrations",
      "supported apps",
      "compatible apps",
      "connect tools",
      "tools",
      "client",
      "clients",
      "third party"
    ],
    "summary": "Explore the Integrations page for project-related connection surfaces. The cards explain setup requirements; clicking one here does not connect an account or activate a provider.",
    "steps": [
      "Filter the integration directory by the type of connection.",
      "Open a card and review its requirements.",
      "Configure the integration in the actual application using its linked guide."
    ],
    "example": "Try the directory search for “Studio”, then open its details. You can clear the search to return to the full directory.",
    "next": [
      "relay",
      "vscode",
      "tray"
    ],
    "actions": [
      "integrations"
    ]
  },
  {
    "id": "files",
    "label": "Project context",
    "group": "Workspace",
    "keywords": [
      "context",
      "file",
      "files",
      "folder",
      "workspace",
      "readme",
      "selected file",
      "attach file",
      "project files",
      "codebase",
      "repository context"
    ],
    "summary": "Good context is relevant context. Select the files needed for the task and describe the desired result. The sample files in this website are illustrative, not files from your computer.",
    "steps": [
      "State the change and how you will judge success.",
      "Include the relevant source, nearby types, and an example input or error.",
      "Ask for a focused plan before making broad edits."
    ],
    "example": "“Using app.tsx and theme.css, add an accessible empty state. Keep the layout and theme variables unchanged. Include a test for an empty result.”",
    "next": [
      "debugging",
      "workflow",
      "attachments"
    ],
    "actions": [
      "files",
      "studio"
    ]
  },
  {
    "id": "attachments",
    "label": "Images and attachments",
    "group": "Workspace",
    "keywords": [
      "attachment",
      "attachments",
      "image",
      "images",
      "screenshot",
      "screenshots",
      "photo",
      "vision",
      "multimodal",
      "upload"
    ],
    "summary": "Use the actual application’s attachment controls where supported. The selected route and model must support the input type. This demo cannot upload or analyze an image.",
    "steps": [
      "Check that your chosen model and route accept the attachment type.",
      "Include only the relevant file or image and remove sensitive information.",
      "Describe the exact question rather than relying on the attachment alone."
    ],
    "example": "For a UI screenshot: “Identify layout problems at this viewport. Keep the existing palette and explain each proposed fix.”",
    "next": [
      "models",
      "files",
      "privacy"
    ],
    "actions": [
      "editor"
    ]
  },
  {
    "id": "agents",
    "label": "Agent teams",
    "group": "Workspace",
    "keywords": [
      "agent",
      "agents",
      "agent team",
      "agent teams",
      "team",
      "teams",
      "multi agent",
      "multi-agent",
      "collaborate",
      "planner",
      "reviewer",
      "autonomous"
    ],
    "summary": "REACH Studio supports custom personas and collaborating agent teams. Give each role a clear responsibility, then review the combined result. This website’s team view is a sample role map.",
    "steps": [
      "Assign a planner to break the task into small changes.",
      "Assign a builder to implement the agreed scope.",
      "Assign a reviewer to check behavior, safety, and tests."
    ],
    "example": "Planner: define acceptance criteria.\nBuilder: make one focused change.\nReviewer: check edge cases and regressions.\nYou: approve the result.",
    "next": [
      "personas",
      "workflow",
      "tests"
    ],
    "actions": [
      "agents",
      "studio"
    ]
  },
  {
    "id": "personas",
    "label": "Custom personas",
    "group": "Workspace",
    "keywords": [
      "persona",
      "personas",
      "system prompt",
      "role prompt",
      "custom assistant",
      "assistant role",
      "custom instructions",
      "personality"
    ],
    "summary": "A persona gives an assistant a consistent role and instructions. Define its task, boundaries, and expected output rather than relying on a name alone.",
    "steps": [
      "Write the role and the job it should perform.",
      "Specify constraints such as preserving public interfaces.",
      "Ask for a concrete result with tests or other evidence."
    ],
    "example": "“Act as a code reviewer. Focus on correctness and maintainability. Cite the affected function, explain the failure case, and suggest the smallest repair.”",
    "next": [
      "agents",
      "workflow",
      "tests"
    ],
    "actions": [
      "studio"
    ]
  },
  {
    "id": "workflow",
    "label": "Plan → build → review",
    "group": "Workspace",
    "keywords": [
      "workflow",
      "plan",
      "planning",
      "build review",
      "iterate",
      "next step",
      "project plan",
      "task breakdown",
      "how should i work"
    ],
    "summary": "Start with a small, testable goal. Bring in the right context, request an approach, and review the result before expanding the scope.",
    "steps": [
      "Plan: define the task and acceptance criteria.",
      "Build: change the smallest relevant surface.",
      "Review: run the checks and inspect the diff."
    ],
    "example": "For this chat upgrade: expand intent matching → add follow-up controls → test ambiguous prompts and mobile layouts → review the generated site.",
    "next": [
      "files",
      "agents",
      "tests"
    ],
    "actions": [
      "studio",
      "tour"
    ]
  },
  {
    "id": "website",
    "label": "Build a website",
    "group": "Build",
    "keywords": [
      "website",
      "web site",
      "landing page",
      "homepage",
      "home page",
      "build a website",
      "build a site",
      "create a website",
      "new site",
      "webpage",
      "portfolio"
    ],
    "summary": "Start a website with its audience, main action, and content outline. Then build a responsive shell before adding animation. I can show a local starter plan, not generate arbitrary production files.",
    "steps": [
      "Define the visitor and the main call to action.",
      "Build the header, hero, useful content sections, and footer.",
      "Test narrow screens, keyboard access, and reduced motion."
    ],
    "example": "<main>\n  <section aria-labelledby=\"hero-title\">\n    <h1 id=\"hero-title\">Your next idea.</h1>\n    <p>A clear promise for your visitors.</p>\n    <a href=\"#features\">Explore features</a>\n  </section>\n  <section id=\"features\">…</section>\n</main>",
    "next": [
      "responsive",
      "themes",
      "accessibility"
    ],
    "actions": [
      "files"
    ]
  },
  {
    "id": "react",
    "label": "React starter",
    "group": "Build",
    "keywords": [
      "react",
      "tsx",
      "jsx",
      "component",
      "components",
      "hooks",
      "use state",
      "usestate",
      "react component"
    ],
    "summary": "Keep components focused on one responsibility, and model interaction state explicitly. The actual website demo is dependency-free JavaScript; this is a small illustrative React example.",
    "steps": [
      "Separate the content data from the rendering component.",
      "Represent selection or expansion with state.",
      "Test the empty, active, and disabled states."
    ],
    "example": "function TopicButton({ label, onChoose }) {\n  return (\n    <button type=\"button\" onClick={onChoose}>\n      {label}\n    </button>\n  );\n}",
    "next": [
      "javascript",
      "tests",
      "accessibility"
    ],
    "actions": [
      "files"
    ]
  },
  {
    "id": "css",
    "label": "CSS and layouts",
    "group": "Build",
    "keywords": [
      "css",
      "stylesheet",
      "styles",
      "styling",
      "grid",
      "flexbox",
      "layout",
      "spacing",
      "border",
      "font",
      "typography"
    ],
    "summary": "Use shared design tokens for colors and spacing, then build layouts that can shrink without forcing horizontal page overflow. Keep the original theme variables as the source of truth.",
    "steps": [
      "Reuse the existing palette and spacing variables.",
      "Prefer flexible grid or flex layouts over fixed widths.",
      "Check long text, code blocks, and narrow screens."
    ],
    "example": ".cards {\n  display: grid;\n  grid-template-columns:\n    repeat(auto-fit, minmax(min(100%, 16rem), 1fr));\n  gap: 1rem;\n}\n.card { min-width: 0; }",
    "next": [
      "responsive",
      "themes",
      "animation"
    ],
    "actions": [
      "theme-file"
    ]
  },
  {
    "id": "responsive",
    "label": "Mobile and responsive",
    "group": "Build",
    "keywords": [
      "responsive",
      "mobile",
      "tablet",
      "phone",
      "small screen",
      "breakpoint",
      "overflow",
      "horizontal scroll",
      "media query",
      "narrow screen"
    ],
    "summary": "Design for the space available rather than a specific device name. Let content wrap, keep controls reachable, and put long code in its own scrollable region.",
    "steps": [
      "Check the page at 320, 390, 768, and 1440 pixels wide.",
      "Test long labels, long URLs, and open menus.",
      "Keep touch controls usable and verify that the page itself does not scroll sideways."
    ],
    "example": ".panel { min-width: 0; }\n.message { overflow-wrap: anywhere; }\n.code { max-width: 100%; overflow-x: auto; }\n@media (max-width: 48rem) {\n  .columns { grid-template-columns: 1fr; }\n}",
    "next": [
      "accessibility",
      "css",
      "performance"
    ],
    "actions": [
      "theme-file"
    ]
  },
  {
    "id": "animation",
    "label": "Animation and motion",
    "group": "Build",
    "keywords": [
      "animation",
      "animations",
      "animate",
      "animated",
      "motion",
      "transition",
      "transitions",
      "hover",
      "fade",
      "reduced motion",
      "parallax"
    ],
    "summary": "Use motion to show what changed, not to hide the content. This website can animate replies and transitions, while respecting the motion control and reduced-motion setting.",
    "steps": [
      "Favor small transform and opacity transitions.",
      "Keep interaction usable when animation is disabled.",
      "Cancel timers when a view closes, resets, or changes route."
    ],
    "example": ".card { transition: transform .2s ease; }\n.card:hover { transform: translateY(-2px); }\n@media (prefers-reduced-motion: reduce) {\n  .card { transition: none; }\n  .card:hover { transform: none; }\n}",
    "next": [
      "accessibility",
      "performance",
      "streaming"
    ],
    "actions": [
      "theme-file"
    ]
  },
  {
    "id": "accessibility",
    "label": "Accessibility",
    "group": "Build",
    "keywords": [
      "accessibility",
      "accessible",
      "a11y",
      "screen reader",
      "keyboard",
      "contrast",
      "aria",
      "focus",
      "semantic",
      "tab key"
    ],
    "summary": "Start with semantic controls, meaningful labels, visible focus, and keyboard access. Check the interface in both themes instead of assuming that a color combination is readable.",
    "steps": [
      "Use buttons for actions and links for navigation.",
      "Name each control and make focus visible.",
      "Check keyboard order, response announcements, and reduced-motion behavior."
    ],
    "example": "<button type=\"button\" aria-expanded=\"false\"\n        aria-controls=\"topics\">\n  Browse topics\n</button>\n<div id=\"topics\" hidden>…</div>",
    "next": [
      "responsive",
      "themes",
      "tests"
    ],
    "actions": [
      "theme-file"
    ]
  },
  {
    "id": "javascript",
    "label": "JavaScript patterns",
    "group": "Build",
    "keywords": [
      "javascript",
      "js",
      "event listener",
      "dom",
      "function",
      "async",
      "promise",
      "abortcontroller",
      "vanilla js",
      "javascript example"
    ],
    "summary": "Separate matching logic from DOM rendering, and keep user-entered text out of innerHTML. Explicit state and cleanup make interactive previews easier to test.",
    "steps": [
      "Make the intent matcher a pure, testable unit.",
      "Render prompts with textContent.",
      "Remove listeners and cancel timers when the view is destroyed."
    ],
    "example": "const controller = new AbortController();\nbutton.addEventListener(\"click\", handleClick, {\n  signal: controller.signal\n});\n// When the view is removed:\ncontroller.abort();",
    "next": [
      "debugging",
      "tests",
      "refactor"
    ],
    "actions": [
      "files"
    ]
  },
  {
    "id": "debugging",
    "label": "Debug an error",
    "group": "Build",
    "keywords": [
      "debug",
      "debugging",
      "bug",
      "bugs",
      "error",
      "errors",
      "broken",
      "not working",
      "does not work",
      "doesnt work",
      "fix",
      "exception",
      "crash",
      "console error"
    ],
    "summary": "Start with the exact error and the smallest reproducible case. This chat can offer a checklist, but it cannot inspect your machine or diagnose code that was not provided.",
    "steps": [
      "Write down the expected behavior and what actually happened.",
      "Capture the relevant error without secrets or private data.",
      "Narrow the failing step and add a regression test after fixing it."
    ],
    "example": "Bug report template:\nExpected: …\nActual: …\nSteps to reproduce: …\nRelevant error: …\nRecent change: …",
    "next": [
      "network",
      "tests",
      "files"
    ],
    "actions": [
      "troubleshooting",
      "support"
    ]
  },
  {
    "id": "tests",
    "label": "Tests and QA",
    "group": "Build",
    "keywords": [
      "test",
      "tests",
      "testing",
      "qa",
      "unit test",
      "regression",
      "playwright",
      "browser test",
      "assert",
      "smoke test"
    ],
    "summary": "Test behavior, not only a happy-path screenshot. For this chat, check keyword matching, follow-ups, fast submissions, reset during typing, and layout at narrow widths.",
    "steps": [
      "Unit-test the intent matcher with exact phrases, typos, and unrelated text.",
      "Exercise buttons, links, keyboard access, and cancellation in a browser.",
      "Check both themes and confirm that the demo sends no model requests."
    ],
    "example": "Useful cases:\n“401 error” → authentication\n“conect a modle” → connection help\n“this is unrelated” → honest fallback\nReset while typing → no stale reply",
    "next": [
      "debugging",
      "accessibility",
      "git"
    ],
    "actions": [
      "files"
    ]
  },
  {
    "id": "refactor",
    "label": "Refactor safely",
    "group": "Build",
    "keywords": [
      "refactor",
      "refactoring",
      "clean up code",
      "clean code",
      "maintainability",
      "modular",
      "architecture",
      "organize code",
      "restructure"
    ],
    "summary": "Preserve behavior first, then improve the structure around it. A data-driven intent catalog is easier to extend than a long chain of overlapping substring checks.",
    "steps": [
      "Write regression cases for the current behavior.",
      "Separate content, matching, and rendering.",
      "Review the diff and rerun the checks before expanding the feature set."
    ],
    "example": "Chat structure:\nchat-engine.js → topics and intent matching\nchat-ui.js → controls and rendering\napp.js → website lifecycle integration",
    "next": [
      "tests",
      "javascript",
      "git"
    ],
    "actions": [
      "files"
    ]
  },
  {
    "id": "performance",
    "label": "Performance",
    "group": "Build",
    "keywords": [
      "performance",
      "speed",
      "slow",
      "lag",
      "latency",
      "optimize",
      "optimization",
      "memory",
      "lightweight",
      "bundle size"
    ],
    "summary": "Keep the preview lightweight and avoid doing unnecessary work while it is hidden. Measure a concrete interaction before deciding what to optimize.",
    "steps": [
      "Bound conversation history and input length.",
      "Clean up listeners and timers when navigation changes.",
      "Measure startup, scrolling, and typing on a narrow-screen browser."
    ],
    "example": "This chat caps its in-memory history and uses a local topic catalog. The UI does not download a model or contact a third-party service.",
    "next": [
      "animation",
      "tests",
      "refactor"
    ],
    "actions": [
      "files"
    ]
  },
  {
    "id": "docs",
    "label": "Documentation",
    "group": "Start",
    "keywords": [
      "docs",
      "documentation",
      "guide",
      "guides",
      "read the docs",
      "manual",
      "reference",
      "instructions",
      "readme guide"
    ],
    "summary": "The Docs page has focused guides for setup, Studio, endpoints, the editor, privacy, and troubleshooting. Use the linked upstream documentation for the actual application.",
    "steps": [
      "Open Docs and choose a guide.",
      "Search for a term such as “security” or “endpoint”.",
      "Follow upstream links when you need installation or provider-specific details."
    ],
    "example": "Need to configure a model? Open Docs → Connect an endpoint.\nSeeing an access error? Open Docs → Troubleshooting.",
    "next": [
      "install",
      "endpoints",
      "privacy"
    ],
    "actions": [
      "docs"
    ]
  },
  {
    "id": "writing",
    "label": "Writing and copy",
    "group": "Build",
    "keywords": [
      "writing",
      "write copy",
      "copywriting",
      "content",
      "headline",
      "tagline",
      "marketing copy",
      "product copy",
      "description",
      "write a bio"
    ],
    "summary": "Good product copy says what the visitor can do and what happens next. Keep claims specific and avoid promising features that the product has not demonstrated.",
    "steps": [
      "Identify the audience and the problem.",
      "Write one clear benefit without unsupported metrics.",
      "Make the next action concrete."
    ],
    "example": "Headline: “Keep your next idea in reach.”\nSupporting copy: “Bring the conversation and project context into one workspace.”\nAction: “Explore the platform.”",
    "next": [
      "website",
      "docs",
      "overview"
    ],
    "actions": [
      "platform"
    ]
  },
  {
    "id": "git",
    "label": "Git and GitHub",
    "group": "Build",
    "keywords": [
      "git",
      "github",
      "commit",
      "push",
      "pull request",
      "branch",
      "repository",
      "version control",
      "diff",
      "git status"
    ],
    "summary": "Keep changes scoped and inspect the diff before committing. This demo can explain the workflow; it cannot commit, push, or inspect a repository for you.",
    "steps": [
      "Run git status and inspect the files you intend to change.",
      "Run the project’s tests and review git diff.",
      "Stage only the intended files and use a descriptive commit message."
    ],
    "example": "git status\ngit diff -- SignalREACH-website\n# Review changes and run tests before staging.",
    "next": [
      "tests",
      "deploy",
      "refactor"
    ],
    "actions": [
      "repo"
    ]
  },
  {
    "id": "deploy",
    "label": "Publish the website",
    "group": "Build",
    "keywords": [
      "deploy",
      "deployment",
      "publish",
      "hosting",
      "host website",
      "github pages",
      "netlify",
      "vercel",
      "static site",
      "go live"
    ],
    "summary": "This website is static. Build its deployment folder and upload that folder’s contents to your static host. Publishing the site does not run the separate Studio app or enable live AI.",
    "steps": [
      "Run npm test and npm run build in the website folder.",
      "Deploy the contents of dist with relative assets preserved.",
      "Verify all six pages, theme switching, and the chat on the hosted URL."
    ],
    "example": "cd SignalREACH-website\nnpm test\nnpm run build\n\nDeploy the CONTENTS of dist/.",
    "next": [
      "tests",
      "limits",
      "privacy"
    ],
    "actions": [
      "docs"
    ]
  },
  {
    "id": "authentication",
    "label": "401 / 403 access errors",
    "group": "Troubleshoot",
    "keywords": [
      "401",
      "403",
      "unauthorized",
      "unauthorised",
      "forbidden",
      "access denied",
      "authentication failed",
      "invalid key",
      "invalid api key",
      "key rejected",
      "permission denied"
    ],
    "summary": "An access error needs a credentials and permissions check, not an authentication bypass. Confirm the host, key, and access policy in the actual client.",
    "steps": [
      "Verify that you are calling the intended host.",
      "Check the credential and whether it has access to that route or model.",
      "Consult the host’s error message and guide; keep secrets out of bug reports."
    ],
    "example": "Safe debugging note: “The request returns 401 from the configured endpoint. The Authorization header is present; the secret value is redacted.”",
    "next": [
      "apikey",
      "endpoints",
      "privacy"
    ],
    "actions": [
      "troubleshooting",
      "endpoint"
    ]
  },
  {
    "id": "notfound",
    "label": "404 / missing model",
    "group": "Troubleshoot",
    "keywords": [
      "404",
      "not found",
      "model missing",
      "missing model",
      "unknown model",
      "model not found",
      "no models",
      "wrong url",
      "route missing",
      "invalid model"
    ],
    "summary": "A missing route or model may come from a wrong base URL, path, or model ID. Compare the request with the endpoint’s actual API and model catalog.",
    "steps": [
      "Verify the base URL and avoid accidentally duplicating /v1.",
      "Check the route exposed by the host.",
      "Use an available model ID instead of a placeholder."
    ],
    "example": "Check separately:\nBase URL → correct host and prefix\nRoute → supported API path\nModel → exact ID listed by that host",
    "next": [
      "endpoints",
      "models",
      "relay"
    ],
    "actions": [
      "troubleshooting",
      "endpoint"
    ]
  },
  {
    "id": "rateLimit",
    "label": "429 / usage limits",
    "group": "Troubleshoot",
    "keywords": [
      "429",
      "rate limit",
      "rate limited",
      "too many requests",
      "quota",
      "usage limit",
      "exceeded",
      "throttled",
      "throttling"
    ],
    "summary": "A usage-limit response comes from the configured service, not this local demo. Check the host’s quota and retry guidance rather than repeatedly resending the same request.",
    "steps": [
      "Read the response and any retry guidance.",
      "Reduce concurrent requests or wait as instructed by the service.",
      "Review the account’s applicable limits in the provider’s own interface."
    ],
    "example": "A bounded retry policy stops after a small number of attempts and lets the user cancel. Do not turn an access or billing error into an endless retry loop.",
    "next": [
      "pricing",
      "performance",
      "support"
    ],
    "actions": [
      "troubleshooting"
    ]
  },
  {
    "id": "network",
    "label": "Connection troubleshooting",
    "group": "Troubleshoot",
    "keywords": [
      "cannot connect",
      "cant connect",
      "could not connect",
      "connection refused",
      "connection failed",
      "network error",
      "timeout",
      "timed out",
      "unreachable",
      "offline",
      "server down",
      "failed to fetch",
      "wont connect",
      "not connecting",
      "does not connect",
      "502",
      "503",
      "500"
    ],
    "summary": "Check the connection path in order: host status, URL, access, then the client. A localhost address points at the device running the client, not another computer.",
    "steps": [
      "Confirm that the endpoint or required bridge is running.",
      "Verify the configured URL and that the client can reach it.",
      "Check the actual error for access, browser-policy, or server failures."
    ],
    "example": "Desktop works, phone fails: check whether the phone is using a desktop localhost URL. Browser fails, native client works: investigate the browser’s console and CORS configuration.",
    "next": [
      "endpoints",
      "cors",
      "authentication"
    ],
    "actions": [
      "troubleshooting"
    ]
  },
  {
    "id": "cors",
    "label": "Browser / CORS errors",
    "group": "Troubleshoot",
    "keywords": [
      "cors",
      "cross origin",
      "cross-origin",
      "preflight",
      "mixed content",
      "blocked by browser",
      "access control allow origin",
      "browser blocked"
    ],
    "summary": "A browser client is subject to browser security rules that a native client may not share. Fix the server’s intended origin policy or deployment configuration; do not disable browser protections.",
    "steps": [
      "Read the exact browser-console error.",
      "Check the endpoint’s intended origin, method, and header policy.",
      "Use a supported connection path and avoid putting secrets into a public browser bundle."
    ],
    "example": "Useful report: page origin, endpoint origin, failing method, and the redacted browser error. These details help separate CORS, mixed-content, and access problems.",
    "next": [
      "network",
      "apikey",
      "relay"
    ],
    "actions": [
      "troubleshooting",
      "privacy"
    ]
  },
  {
    "id": "contextProblems",
    "label": "Missing project context",
    "group": "Troubleshoot",
    "keywords": [
      "ignoring files",
      "cant see files",
      "cannot see files",
      "wrong context",
      "missing context",
      "context window",
      "too much context",
      "context too long",
      "hallucination",
      "hallucinate",
      "wrong answer"
    ],
    "summary": "Check what context was actually selected and whether the model can handle it. More files do not automatically produce a better answer; relevant files and a clear question matter.",
    "steps": [
      "Confirm the required files or attachments were selected in the real application.",
      "Reduce the task to the relevant functions and examples.",
      "Ask the assistant to distinguish file evidence from assumptions, then verify the result."
    ],
    "example": "“Use only the selected source files. Cite the function that supports each conclusion. Say what is missing rather than inventing unseen behavior.”",
    "next": [
      "files",
      "models",
      "workflow"
    ],
    "actions": [
      "studio"
    ]
  },
  {
    "id": "privacy",
    "label": "Privacy and security",
    "group": "Explore",
    "keywords": [
      "privacy",
      "security",
      "private",
      "data storage",
      "save messages",
      "store messages",
      "tracking",
      "analytics",
      "cookies",
      "confidential",
      "encrypted",
      "encryption"
    ],
    "summary": "This chat uses local scripted replies. Prompts stay in the current page’s memory and are not sent to an AI endpoint or saved by the website. Theme and motion preferences are stored locally when available.",
    "steps": [
      "Do not enter passwords, API keys, or other secrets.",
      "Reset the chat to clear its current conversation.",
      "Review the real application and provider policies separately before connecting a model."
    ],
    "example": "The Export button creates a local text file only when you choose it. Anyone you share that file with can read its contents.",
    "next": [
      "limits",
      "apikey",
      "support"
    ],
    "actions": [
      "privacy"
    ]
  },
  {
    "id": "pricing",
    "label": "Pricing and availability",
    "group": "Explore",
    "keywords": [
      "price",
      "pricing",
      "cost",
      "paid",
      "free",
      "subscription",
      "billing",
      "license",
      "licence",
      "how much",
      "payment"
    ],
    "summary": "This preview does not contain a verified pricing catalog or live provider availability. Review the project’s current license and each provider’s own terms before using the real application.",
    "steps": [
      "Check the current project documentation and license.",
      "Review your selected provider’s access and usage terms.",
      "Treat sample model names and setup text as guidance, not a promise of availability."
    ],
    "example": "This local scripted chat does not make model calls. Connecting the real application is a separate step with the host’s own requirements.",
    "next": [
      "models",
      "limits",
      "install"
    ],
    "actions": [
      "repo"
    ]
  },
  {
    "id": "themes",
    "label": "Light and dark themes",
    "group": "Explore",
    "keywords": [
      "theme",
      "themes",
      "color",
      "colors",
      "colour",
      "colours",
      "design",
      "palette",
      "gold",
      "charcoal",
      "dark mode",
      "light mode",
      "dark theme",
      "light theme",
      "ivory"
    ],
    "summary": "The signature charcoal and gold remain at the center of the design. Light mode uses warm ivory surfaces. This is a scripted website demo; theme changes only affect this preview.",
    "steps": [
      "Use the header switch or the theme buttons in this reply.",
      "Inspect the sample theme.css file.",
      "Check readable text, focus outlines, and borders in both modes."
    ],
    "example": ":root {\n  --bg: #161618;\n  --gold: #d4af37;\n}\n[data-theme=\"light\"] {\n  --bg: #f7f5ee;\n}",
    "next": [
      "css",
      "accessibility",
      "animation"
    ],
    "actions": [
      "light",
      "dark",
      "theme-file"
    ]
  },
  {
    "id": "shortcuts",
    "label": "Chat commands",
    "group": "Explore",
    "keywords": [
      "shortcut",
      "shortcuts",
      "keyboard shortcut",
      "commands",
      "slash command",
      "help menu",
      "clear chat",
      "reset chat",
      "export chat",
      "browse topics"
    ],
    "summary": "Use topic buttons or type a question. Follow up with “tell me more”, “show an example”, or “what next”. Slash commands give you quick access to the demo controls.",
    "steps": [
      "/topics opens the topic browser; /random chooses a topic.",
      "/example or /steps expands the current topic.",
      "/clear resets the chat; /export downloads the current transcript."
    ],
    "example": "/help\n/topics\n/random\n/steps\n/example\n/clear\n/export",
    "next": [
      "overview",
      "limits",
      "website"
    ],
    "actions": [
      "topics"
    ]
  },
  {
    "id": "limits",
    "label": "What this demo can do",
    "group": "Explore",
    "keywords": [
      "demo",
      "heuristic",
      "scripted",
      "are you ai",
      "real ai",
      "live ai",
      "chatbot",
      "bot",
      "limitations",
      "limits",
      "how do you work",
      "are you real",
      "what are you",
      "offline demo"
    ],
    "summary": "I am a local, heuristic website guide—not a live language model. I match topics and keywords, remember the current topic for follow-ups, and show prepared examples or preview actions.",
    "steps": [
      "Ask about the product, setup, coding examples, or troubleshooting.",
      "Use follow-up chips and response styles to explore a topic.",
      "Open the actual application and configure a provider for live AI assistance."
    ],
    "example": "Supported: “Connect a model” → “step by step” → “show an example”.\nNot supported: reading your PC, checking live prices, executing code, or generating arbitrary answers.",
    "next": [
      "shortcuts",
      "overview",
      "install"
    ],
    "actions": [
      "topics",
      "tour"
    ]
  },
  {
    "id": "support",
    "label": "Help with the project",
    "group": "Start",
    "keywords": [
      "support",
      "contact",
      "report bug",
      "issue tracker",
      "maintainer",
      "feedback",
      "report issue",
      "help me",
      "need help",
      "help"
    ],
    "summary": "Choose a relevant guide first. For a reproducible product issue, use the project’s issue tracker and include enough detail to reproduce it without exposing secrets.",
    "steps": [
      "State the product surface and what you expected.",
      "List the smallest steps that reproduce the issue.",
      "Include a redacted error and the relevant environment details."
    ],
    "example": "Issue title: “Connection test fails after changing the base URL”\nInclude: expected result, actual error, reproduction steps, and version details. Omit credentials.",
    "next": [
      "debugging",
      "docs",
      "network"
    ],
    "actions": [
      "support",
      "docs"
    ]
  },
  {
    "id": "greeting",
    "label": "Hello, REACH",
    "group": "Explore",
    "keywords": [
      "hello",
      "hi",
      "hey",
      "hiya",
      "good morning",
      "good afternoon",
      "good evening",
      "how are you",
      "greetings",
      "yo"
    ],
    "summary": "Hello! Pick a topic below or ask about setup, models, agent teams, design, or troubleshooting. I can also show short code examples and guide you around this preview.",
    "steps": [
      "Choose a topic or type a question.",
      "Ask “tell me more” to expand the answer.",
      "Try an example or a related topic to keep exploring."
    ],
    "example": "Try: “Build a responsive website”, “Connect a model”, or “My endpoint returns 401”.",
    "next": [
      "website",
      "endpoints",
      "agents"
    ],
    "actions": [
      "topics"
    ]
  },
  {
    "id": "thanks",
    "label": "Thanks",
    "group": "Explore",
    "keywords": [
      "thanks",
      "thank you",
      "thx",
      "cheers",
      "great thanks",
      "appreciate it",
      "awesome",
      "nice",
      "cool"
    ],
    "summary": "You’re welcome. We can keep exploring, open a guide, or reset the demo for a fresh start.",
    "steps": [
      "Use a follow-up chip for the next topic.",
      "Export the conversation to keep a local copy.",
      "Reset when you are finished."
    ],
    "example": "Try “what next” for a related topic, or /topics to browse the whole catalog.",
    "next": [
      "website",
      "agents",
      "install"
    ],
    "actions": [
      "topics"
    ]
  },
  {
    "id": "goodbye",
    "label": "Goodbye",
    "group": "Explore",
    "keywords": [
      "bye",
      "goodbye",
      "see you",
      "see ya",
      "good night",
      "later",
      "farewell"
    ],
    "summary": "See you next time. Your prompts stay in this page’s memory unless you choose to export them. Reset the chat to clear the current conversation.",
    "steps": [
      "Export only when you want a local copy.",
      "Reset to clear the demo conversation.",
      "Use Get started when you are ready to explore the actual application."
    ],
    "example": "Type /clear for a fresh conversation, or /help to keep exploring.",
    "next": [
      "install",
      "privacy",
      "overview"
    ],
    "actions": [
      "install"
    ]
  }
];
  const BY_ID = new Map(TOPICS.map(topic => [topic.id, topic]));
  const MAX_INPUT = 600;
  const SOCIAL = new Set(['greeting', 'thanks', 'goodbye']);
  const STOP = new Set('a an the and or but i me my we you your our this that these those to of in on for with without is are be do does can could would will it its please tell about how what why when where show have want need im id really some just more give help'.split(' '));
  const normalize = value => String(value ?? '').slice(0, MAX_INPUT).normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  const prepared = TOPICS.map(topic => ({topic, phrases: topic.keywords.map(normalize)}));
  const contains = (text, phrase) => (` ${text} `).includes(` ${phrase} `);
  // Bounded edit distance. Only longer tokens qualify; never fuzzy-match error codes.
  function near(a, b) {
    if (a === b) return true;
    if (a.length < 5 || b.length < 5 || /\d/.test(a + b) || a[0] !== b[0]) return false;
    const limit = Math.min(a.length, b.length) >= 8 ? 2 : 1;
    if (Math.abs(a.length - b.length) > limit) return false;
    let before = Array.from({length:b.length + 1}, (_, i) => i), older;
    for (let i = 1; i <= a.length; i++) {
      const row = [i];
      for (let j = 1; j <= b.length; j++) {
        row[j] = Math.min(row[j - 1] + 1, before[j] + 1, before[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j], older[j - 2] + 1);
      }
      older = before; before = row;
    }
    return before[b.length] <= limit;
  }
  const options = ids => ids.map(id => BY_ID.get(id)).filter(Boolean).map(topic => ({id:topic.id, label:topic.label, prompt:topic.keywords[0]}));
  function rank(text) {
    const allWords = normalize(text).split(' ').filter(Boolean);
    const words = [...new Set(allWords)].filter(word => !STOP.has(word));
    return prepared.map(({topic, phrases}) => {
      let best = 0, hits = 0;
      for (const phrase of phrases) {
        const parts = phrase.split(' ');
        if (contains(text, phrase)) { best = Math.max(best, 5 + (parts.length - 1) * 5); hits++; }
        else if (parts.some(part => !STOP.has(part)) && allWords.some((_, start) =>
          start + parts.length <= allWords.length && parts.every((part, index) => near(allWords[start + index], part)))) {
          best = Math.max(best, 3 + (parts.length - 1) * 3);
        }
      }
      // Specific failure phrases take precedence over generic model/API words.
      if (best && topic.group === 'Troubleshoot' && topic.id !== 'contextProblems') {
        // 'Offline model/demo' is not itself a network failure.
        if (topic.id !== 'network' || /\b(cannot|cant|failed|refused|wont|timeout|timed out|unreachable|down|error|500|502|503)\b/.test(text) || !contains(text, 'offline')) best += 12;
      }
      if (SOCIAL.has(topic.id) && words.length > 3) best = Math.max(0, best - 5);
      // Generic pleasantries/help should not eclipse a concrete task or provider.
      if (topic.id === 'support' && words.length > 1 && !/\b(support|contact|issue|report|maintainer|feedback)\b/.test(text)) best = Math.max(0, best - 8);
      if (best && topic.id === 'debugging') {
        if (/\b(debug|debugging|fix|broken|crash)\b/.test(text)) best += 10;
        else if (contains(text, 'error')) best += 3;
      }
      if (best && topic.id === 'website' && /\b(build|create|make)\b.*\b(website|site|homepage|landing page)\b/.test(text)) best += 5;
      if (best && topic.id === 'local' && /\b(ollama|lm studio)\b/.test(text)) best += 7;
      return {id:topic.id, score:best ? best + Math.min(hits, 3) * 0.5 : 0};
    }).filter(item => item.score >= 3).sort((a, b) => b.score - a.score);
  }
  function createSession() {
    let lastIntent = null, visits = Object.create(null), nextIntent = null;
    function reset() { lastIntent = null; nextIntent = null; visits = Object.create(null); }
    function reply(raw, settings = {}) {
      const text = normalize(raw);
      const mode = ['quick','steps','example'].includes(settings.mode) ? settings.mode : 'quick';
      const command = String(raw ?? '').trim().toLowerCase();
      if (!text) return null;
      if (/^\/(clear|reset)$/.test(command)) { reset(); return {command:'clear'}; }
      if (command === '/export') return {command:'export'};
      if (command === '/topics') return {command:'topics'};
      let forced = BY_ID.has(settings.intent) ? settings.intent : null;
      let style = mode, followup = false;
      if (command === '/help') { forced = 'shortcuts'; style = 'example'; }
      if (command === '/random') {
        const choices = TOPICS.filter(topic => !SOCIAL.has(topic.id) && topic.id !== lastIntent);
        forced = choices[(visits.__random = (visits.__random || 0) + 7) % choices.length].id;
      }
      if (!forced && /^(yes|yes please|sure|ok|okay|go ahead|sounds good|do that)$/.test(text)) {
        forced = nextIntent || lastIntent || 'overview'; followup = true;
      }
      if (!forced && /^(what next|whats next|next|next step|next steps|another topic|anything else)$/.test(text)) {
        forced = nextIntent || 'install'; followup = true;
      }
      if (!forced && /^(more|more detail|more details|tell me more|explain more|elaborate|go deeper|explain that|explain it|continue|how|how do i do that|step by step|steps|show steps|in detail)$/.test(text)) {
        forced = lastIntent || 'overview'; style = 'steps'; followup = true;
      }
      if (!forced && /^(example|examples|show an example|show me an example|give me an example|show me code|code example|sample|sample code|show code)$/.test(text)) {
        forced = lastIntent || 'website'; style = 'example'; followup = true;
      }
      if (!forced && /^(shorter|brief|briefly|quick|simpler|summarize|summarise|tldr)$/.test(text)) {
        forced = lastIntent || 'overview'; style = 'quick'; followup = true;
      }
      if (command === '/steps') { forced = lastIntent || 'overview'; style = 'steps'; followup = true; }
      if (command === '/example') { forced = lastIntent || 'website'; style = 'example'; followup = true; }
      if (!forced && /\b(step by step|in detail|detailed|show steps)\b/.test(text)) style = 'steps';
      if (!forced && /\b(example|sample code|code snippet)\b/.test(text)) style = 'example';
      const matches = forced ? [] : rank(text);
      const id = forced || matches[0]?.id;
      if (!id) return {
        intent:'fallback', title:'Let’s narrow it down.',
        text:'I do not have a prepared answer for that yet. I am a local, scripted demo—not a live AI. Choose a topic, mention a feature or error, or ask for a coding example.',
        steps:[], example:'', actions:['topics'], suggestions:options(['overview','website','endpoints','debugging']),
        matched:false, mode:style, alternatives:[]
      };
      const topic = BY_ID.get(id);
      visits[id] = (visits[id] || 0) + 1;
      const repeat = visits[id] > 1 && style === 'quick' && !followup;
      lastIntent = id; nextIntent = topic.next[0] || 'overview';
      return {
        intent:id, title:topic.label, text:topic.summary,
        steps: style === 'steps' || repeat ? [...topic.steps] : [],
        example:style === 'example' ? topic.example : '',
        actions:[...topic.actions], suggestions:options(topic.next),
        matched:true, mode:style, contextual:followup,
        alternatives:matches.filter(item => item.id !== id && item.score >= 5 && !SOCIAL.has(item.id)).slice(0,2).map(item => ({id:item.id,label:BY_ID.get(item.id).label}))
      };
    }
    return {reply, reset, getContext:() => ({lastIntent, nextIntent})};
  }
  globalThis.SignalREACHChat = Object.freeze({
    createSession, normalize, maxInput:MAX_INPUT,
    topics:Object.freeze(TOPICS.map(topic => Object.freeze({id:topic.id,label:topic.label,group:topic.group,keywords:Object.freeze([...topic.keywords])}))),
    keywordCount:TOPICS.reduce((n, topic) => n + topic.keywords.length, 0),
    actions:Object.freeze({
      platform:{label:'Explore Platform',href:'platform.html'},
      install:{label:'Get started',href:'download.html'},
      docs:{label:'Open Docs',href:'docs.html'},
      studio:{label:'Studio guide',href:'docs.html#studio'},
      endpoint:{label:'Connection guide',href:'docs.html#endpoint'},
      editor:{label:'Editor guide',href:'docs.html#editor'},
      privacy:{label:'Privacy guide',href:'docs.html#security'},
      troubleshooting:{label:'Troubleshooting guide',href:'docs.html#troubleshooting'},
      integrations:{label:'Explore integrations',href:'integrations.html'},
      support:{label:'Project issues',href:'https://github.com/falabellamichael/SignalR.E.A.C.H/issues'},
      repo:{label:'Open source repository',href:'https://github.com/falabellamichael/SignalR.E.A.C.H'},
      files:{label:'View sample README',kind:'file',value:'README.md'},
      'theme-file':{label:'View theme.css',kind:'file',value:'theme.css'},
      light:{label:'Try light theme',kind:'theme',value:'light'},
      dark:{label:'Try dark theme',kind:'theme',value:'dark'},
      agents:{label:'View agent team',kind:'preview',value:'agents'},
      tour:{label:'Take the tour',kind:'tour'},
      topics:{label:'Browse topics',kind:'topics'}
    })
  });
})();
