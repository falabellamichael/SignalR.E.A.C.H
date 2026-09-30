# Branching website conversations

The website now includes 50 authored conversation trees, with three follow-up branches per tree and two reply variations at each node: 200 nodes and 400 authored replies. They extend the original product-topic router rather than replacing its technical guidance. The combined topic browser has 94 entries and the combined router registers 1,410 keyword/phrase entries, including branch triggers (not necessarily unique phrases).

This is still a clearly labelled local scripted demo. It does not call an AI endpoint, browse the web, read visitor files, connect accounts, or execute user input.

## Try the conversations

- `hey, how are you?` -> `I'm tired` -> `tiny task` -> `tell me more` -> `show an example`
- `I'm bored` -> `a riddle` -> `hint` -> `answer`
- `good morning` -> `coffee first` -> `tea actually`
- `project idea` -> `website` -> `portfolio` -> `yes`
- `hey, my endpoint returns 401` -> `thanks` -> `continue`

Free text and the suggestion buttons use the same router. A branch can lead to another conversation or back into an existing product topic. Specific technical errors take priority over casual greetings. Ordinary follow-ups keep their context; unsupported requests receive an honest fallback.

`/conversation`, `/chat`, and `/randomchat` cycle through the 50 conversation openings. Existing `/help`, `/topics`, `/steps`, `/example`, `/random`, `/export`, and `/clear` controls remain available. Typing `call me Alex` sets an optional first name only for the current page session; `forget my name`, Reset, or a reload clears it. Exported transcripts are separate files the visitor explicitly chooses to save.

## Conversation catalog

1. Hey, how are you?
2. Good morning
3. Good evening
4. What's up?
5. Who are you?
6. Let's get acquainted
7. I'm having a good day
8. I'm tired
9. I'm bored
10. Too much to do
11. Give me a little motivation
12. Thank you
13. Sorry about that
14. This is pretty cool
15. See you later
16. Tell me a joke
17. Give me something curious
18. A little riddle
19. Let's get creative
20. Help me name an idea
21. Tell me a tiny story
22. Let's talk about music
23. Help me focus
24. I keep putting it off
25. Help me plan my day
26. I want to learn something
27. I'm not sure I can do it
28. How do I give good feedback?
29. Let's work as a team
30. Help me make a decision
31. A low-key weekend idea
32. Coffee break conversation
33. A tiny turtle detour
34. Notice a small win
35. Let's find a project idea
36. Be my coding buddy
37. Shape a website idea
38. Choose a design direction
39. Let's debug this together
40. Make a testing plan
41. Explain it simply
42. Let's brainstorm
43. I'm staring at a blank page
44. Find the right writing tone
45. Is this an AI or a demo?
46. What happens to this chat?
47. Which REACH surface fits?
48. I'm back
49. I'm not following
50. That's not what I meant

## Source and build

Edit `assets/chat-conversations.js`. `S(...)` defines an opening; each `B(...)` defines a branch, its trigger phrases, two authored replies, and its next destination. Destinations are `talk:<conversation-id>`, existing product-topic IDs, or `@resume` for the last technical topic. Keep IDs unique and preserve the explicit demo disclosures.

`npm run build` prepends the extension to the existing UI adapter in `dist/assets/chat-ui.js`. The base `chat-engine.js` remains unchanged, and no additional runtime request is needed. `npm start` builds and serves `dist/`, so local preview matches the deployment. For a file-based preview, build first and open `dist/index.html`; opening the unbundled source index directly will not load the extension. The older standalone `SignalREACH-preview.html` is a separate historical snapshot and is not the deployed site.

## Validation

Run `npm test`, then `npm run build`. The full suite contains 1,285 tests: the original 89 tests plus 1,196 extension tests covering every registered opening and branch trigger, suggestions, variations, styles, cross-conversation paths, original technical routing, name isolation, reset, invalid input, and production bundling. The Pages workflow runs the suite before building and deploying.

Offline Chromium checks exercised the actual bundled scripts and stylesheet: desktop and 390px/320px layouts, searchable topics, multi-turn chat, suggestions, examples, export, reset, optional name handling, text-only rendering of HTML input, theme switching, and interruptible typing. These checks reported no JavaScript errors or external requests. They used an in-memory document because the test environment restricts browser URL navigation.
