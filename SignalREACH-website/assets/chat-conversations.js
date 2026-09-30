/* 50 authored conversation trees for the SignalREACH website demo.
 * This is a deterministic script, not an AI model. No network, persistence,
 * arbitrary code execution, or access to the visitor's files is involved.
 * build.mjs prepends this extension to chat-ui.js after the base engine loads.
 */
(() => {
  'use strict';
  const base = globalThis.SignalREACHChat;
  if (!base || base.conversationVersion) return;
  const split = text => text.split('|').map(value => value.trim()).filter(Boolean);
  const B = (id, label, keys, first, second, next) => ({id, label, keywords:split(keys), replies:[first, second], next});
  const S = (id, label, group, keys, first, second, branches) => ({id, label, group, keywords:split(keys), replies:[first, second], branches});
  const SCENES = [
    S('hello','Hey, how are you?','Small talk','hey how are you|hello|hi|hey|hiya|yo|how are you|hows it going|how you doing|hello there|how are ya',
      'Hey! Ready to chat and help you find a good starting point. How is your day going — feeling good, a little tired, or already working on something?',
      'Hey, welcome back to the conversation! We can keep it casual or turn an idea into a next step. How are things on your side?', [
      B('good','I’m doing well','im good|im doing well|doing good|pretty good|great|good|feeling good|fine thanks','Good to hear! Want to keep that momentum going with a project idea, or take a quick creative detour?','Nice! We could put that energy into something useful or keep things light. A project idea is one place to start.','talk:project'),
      B('tired','A little tired','im tired|a little tired|tired|sleepy|long day|exhausted','Then let’s keep this low-pressure. We can choose one tiny task, sketch a plan for later, or just chat for a moment.','No need to turn this into a marathon. A small finishable task or a clean stopping point might be enough for now.','talk:tired'),
      B('working','Working on a project','working on something|working|on a project|building something|busy coding','What kind of project has your attention — a website, a coding problem, or an idea you are still shaping?','Let’s give the work a starting point. Pick the kind of project, then we can follow a more specific path.','talk:project')]),
    S('morning','Good morning','Small talk','good morning|morning reach|morning|starting my day|new day',
      'Good morning! What would make today feel useful: a clear plan, a focused first task, or an easy start with a little conversation?',
      'Morning! Before the to-do list gets noisy, let’s pick one thing worth moving forward. Planning, focus, or a slower start?', [
      B('plan','Plan my day','plan my day|plan|schedule|organize today','Start with one result that would make the day worthwhile. Then give it a realistic place in your day instead of filling every gap.','A useful plan leaves room for interruptions. Choose the main result first; the smaller jobs can fit around it.','talk:day'),
      B('focus','Help me focus','focus|first task|concentrate|get going','Choose one task and define what finished looks like. A small, clear target is easier to begin than an entire project.','Let’s make the first task specific: one section, one test, or one decision. Everything else can wait for the next block.','talk:focus'),
      B('coffee','Coffee first','coffee|coffee first|slow start|tea|easy start','Fair enough — no heroic productivity speech before the first sip. Shall we keep it light or collect a few ideas for later?','A slower start is still a start. We can have a low-stakes chat while the day finds its rhythm.','talk:coffee')]),
    S('evening','Good evening','Small talk','good evening|evening|end of the day|wrapping up|winding down',
      'Good evening! Are you wrapping up a piece of work, looking back on the day, or getting tomorrow out of your head and onto a page?',
      'Evening! We can close one loose end, notice a small win, or make tomorrow’s first step easier. Which sounds right?', [
      B('reflect','Reflect on today','reflect|look back|today went|review my day','Try three questions: what moved forward, what got in the way, and what deserves another attempt? A rough answer to each is enough.','Reflection does not need a perfect scorecard. Notice one useful thing you learned and one thing worth changing tomorrow.','talk:wins'),
      B('unwind','Keep it light','unwind|relax|keep it light|just chat|take it easy','Let’s switch gears. A small story, a harmless joke, or a playful riddle can be a good change of pace.','Work can stop being the topic for a bit. Pick something creative and we’ll take the conversation there.','talk:story'),
      B('tomorrow','Set up tomorrow','tomorrow|next day|prepare|plan ahead','Leave tomorrow a clear handoff: what you were doing, the next small action, and anything needed to begin.','Write a short note to future-you rather than a giant new list. One obvious next action can make restarting easier.','talk:day')]),
    S('whatsup','What’s up?','Small talk','whats up|sup|whats happening|what are you up to|whatcha doing|how is it going',
      'Hey! I’m here in demo-guide mode: ready for a conversation, an idea session, or a tour of SignalREACH. What are you in the mood for?',
      'Nothing happening behind the scenes here — just a local chat demo ready to explore a few paths with you. Casual chat, creative ideas, or product questions?', [
      B('chat','Just chatting','just chatting|chat|hang out|nothing much|not much','That works. We can start with how your day is going, try a riddle, or wander into a creative prompt.','No project brief required. A simple check-in is a perfectly good place to begin.','talk:hello'),
      B('ideas','Give me an idea','idea|ideas|inspire me|brainstorm','Let’s choose the size of the idea first: something you could sketch today, build this week, or explore without committing to it.','A useful idea needs a direction, not instant perfection. We can start practical, playful, or a little experimental.','talk:brainstorm'),
      B('explore','Show me around','explore|show me around|tour|look around','Let’s take the product route. The Platform page separates the different REACH surfaces, and the tour gives a guided overview.','We can explore the workspace, the connection side, or the editor integration without connecting any accounts in this demo.','overview')]),
    S('identity','Who are you?','Small talk','who are you|what is your name|whats your name|introduce yourself|who made you|who built you',
      'I’m REACH, the interactive guide on this website. Brought to you by: SimpleRAG Developers. My replies here are authored conversation branches, not live model output.',
      'You’re chatting with SignalREACH’s local demo guide. I can follow prepared conversation paths and point you toward the real product guides. What would you like to explore?', [
      B('capabilities','What can we discuss?','what can we discuss|capabilities|what can you do|help with','We can talk through creative ideas, everyday planning, coding workflows, and the product’s setup topics. Specific keywords and follow-ups choose the prepared replies.','Think of this as an interactive sample conversation library with useful product links, rather than an assistant connected to your computer.','overview'),
      B('real','Is this real AI?','real ai|are you real|ai or scripted|scripted|live model','This website chat is scripted. The conversational wording and typing animation do not mean an AI model is running or reading your files.','No live model is answering this chat. The actual application has its own model-connection setup, separate from the website demonstration.','talk:demo'),
      B('privacy','What do you remember?','remember|memory|privacy|my data','Only this page’s active chat session holds the conversation context. Reset clears it; a reload starts fresh. Export is a separate action you choose.','The conversation layer does not write your prompts to browser storage or send them to a server. Theme preferences are handled separately by the existing site.','talk:privacy')]),
    S('name','Let’s get acquainted','Small talk','lets get acquainted|can you remember my name|call me|my name is|nice to meet you',
      'Nice to meet you! You can say “call me Alex” to use a first name in this page session, or skip that and go straight to an idea.',
      'Good to have you here. A name is optional; this demo only keeps it in the current chat session and clears it when you reset.', [
      B('skip','Skip the name','skip|no name|rather not|anonymous','Absolutely — no personal details needed. We can jump straight into something you would like to build or explore.','We can keep this anonymous and still have a useful conversation. Let’s choose a topic instead.','talk:project'),
      B('memory','How does memory work?','how does memory work|memory|how long|stored','This is short-lived page memory, not an account profile. Reset or reload the page to start again without that context.','A name and the active conversation path stay in this session only. They are not added to a database by this demo.','talk:privacy'),
      B('meet','Let’s talk','lets talk|nice to meet you too|talk|continue','Let’s start simply: are you in a creative mood, trying to make progress, or just checking things out?','We have a few directions to choose from. Casual chat is fine, and so is jumping right into a project.','talk:hello')]),
    S('great','I’m having a good day','Small talk','im having a good day|im happy|feeling great|feeling good today|im excited|today is great|im doing great',
      'That sounds like a good moment to enjoy. Want to celebrate a small win, channel the energy into a project, or try something creative?',
      'Nice! We can mark what went well or turn the good momentum into a small next step. What feels most appealing?', [
      B('celebrate','Celebrate a win','celebrate|small win|a win|something went well','Give the win a name, even if it seems small. Finishing a tricky section or finally starting something can both count.','Let’s not rush past what worked. Notice the action you took and the progress it created.','talk:wins'),
      B('build','Put it into a project','build|project|make something|use the energy','Let’s pick something small enough to finish a first version. A tiny website feature or a useful personal tool could be a good target.','Keep the first version modest so the momentum turns into something tangible rather than a sprawling plan.','talk:project'),
      B('creative','Try something creative','creative|create|something fun|fun','We can invent a name, open a short story, or generate a few directions for an idea. Which kind of creativity fits the mood?','Let’s give the imagination a little room. Start with a playful prompt, then keep whichever part catches your attention.','talk:creative')]),
    S('tired','I’m tired','Small talk','im tired|a little tired|sleepy|long day|feeling drained|low energy|exhausted|worn out',
      'Sounds like you have had a lot on your plate. Let’s keep this gentle: a tiny task, a stopping-point note, or a conversation that does not need much effort?',
      'We can lower the ambition for this moment. One small finish or a clear plan for later is enough; there is no need to force a big session.', [
      B('tiny','Choose a tiny task','tiny task|small task|one thing|small win','Pick something with an obvious finish: name a file clearly, write a task title, or note one unanswered question. Stop after that small result.','A tiny task should remove friction, not quietly become five more tasks. Define the stopping point before you begin.','talk:procrastination'),
      B('later','Leave a note for later','later|tomorrow|stop|stopping point|leave a note','Write: “I was working on __. Next I should __. I will need __.” That gives the next session a place to start.','A short handoff to yourself can be more useful than trying to push through another complicated decision right now.','talk:day'),
      B('chat','Just talk for a bit','just talk|chat|keep it light|nothing demanding','Let’s keep it easy. We could make up a tiny story or swap the work talk for a gentle joke.','No productivity assignment attached. Pick a light conversation path and we’ll stay there for a moment.','talk:story')]),
    S('bored','I’m bored','Small talk','im bored|bored|entertain me|nothing to do|give me something fun|kill some time',
      'Let’s give the boredom a direction. Want a riddle, a programmer joke, or a tiny creative challenge?',
      'We can make this interesting without turning it into homework. Pick a puzzle, a laugh, or a small invention.', [
      B('riddle','Give me a riddle','riddle|puzzle|challenge my brain','Here is a tiny one: what has keys but cannot open a door? Take a guess, or ask for a hint.','Puzzle time: it has keys, but no locks to open. What could it be?','talk:riddle'),
      B('joke','Tell me a joke','joke|make me laugh|funny|tell me a joke','My imaginary task list said “be spontaneous.” I scheduled it for Thursday. Want a programmer-flavoured one next?','I asked my to-do list for a break. It added “take a break” as another task. We can keep the jokes going.','talk:joke'),
      B('challenge','A creative challenge','creative challenge|invent|creative|challenge','Invent an app with exactly one button. Give it a name, say what the button does, and explain why someone would press it twice.','Tiny challenge: design a useful tool whose entire explanation fits on a sticky note. What is the one thing it helps with?','talk:creative')]),
    S('overwhelmed','Too much to do','Small talk','im overwhelmed|overwhelmed|too much to do|dont know where to start|everything at once|so many tasks',
      'Let’s make the next decision smaller. We can choose one priority, break down a task, or get the whole list out of your head first.',
      'You do not have to solve the entire pile in one move. Which would help more right now: selecting, simplifying, or making a rough list?', [
      B('priority','Choose one priority','priority|choose one|most important|pick one','Choose the item that either unblocks something else or has a real deadline. Define one visible result rather than the entire project.','Ask which task would make the remaining work easier. That is a practical candidate for the first small block.','talk:decision'),
      B('breakdown','Break a task down','break it down|breakdown|smaller steps|simplify','Write the task as an outcome, then list only the first three actions needed to reach it. Make the first action something you can physically begin.','Replace a broad label like “finish website” with “write the hero heading” or “test the mobile menu.” Concrete actions are easier to inspect.','talk:focus'),
      B('list','Get it onto a page','make a list|write it down|brain dump|list','Make a rough list without sorting it. Then mark what needs action, what needs a decision, and what can wait.','The first list is just a place to put things, not a promise to finish everything today. Sorting can come after it exists.','talk:day')]),
    S('motivation','Give me a little motivation','Momentum','motivate me|motivation|need encouragement|encourage me|help me get started|i can do this',
      'You do not need a dramatic restart. Pick one action small enough to begin now and clear enough to know when it is finished.',
      'Let’s trade the huge goal for a useful first move. A rough first attempt gives you something to improve; an untouched plan does not.', [
      B('start','Help me start','start|first move|begin|lets do it','Open the thing you need and write one sentence describing the result. The next step is to make the smallest visible piece of that result.','Make starting mechanical: open the project, choose one file, and define one change. You can judge the result after it exists.','talk:procrastination'),
      B('stuck','I’m still stuck','stuck|cant start|not working|still stuck','Then the first action may still be too vague. Is the obstacle missing information, uncertainty about quality, or simply too large a task?','Being stuck is a useful signal to inspect the task, not a verdict on your ability. Let’s shrink it or identify the missing piece.','talk:confidence'),
      B('win','I finished something','finished|did it|done|small win','That is progress worth noticing. Record what changed, then decide whether the next move is another small step or a clean stopping point.','You turned an intention into a result. Keep the useful part of the process and make the next step just as concrete.','talk:wins')]),
    S('thanks','Thank you','Small talk','thanks|thank you|thx|ty|cheers|appreciate it|thanks a lot|thank you so much',
      'You’re welcome! We can continue the last useful topic, try a different direction, or leave things there.',
      'Glad that helped. Shall we build on it, switch gears, or call this a good stopping point?', [
      B('continue','Continue the last topic','continue|yes|keep going|same topic','Let’s pick up the last product topic rather than start from scratch. Here is the route back into that guidance.','We can build on the previous technical discussion. I’ll use the context still held in this page session.','@resume'),
      B('different','Try something different','different|new topic|switch gears|something else','Sure — a different direction it is. We can go creative, practical, or purely conversational.','Let’s open a fresh path without clearing the session. A little brainstorming is a flexible place to start.','talk:brainstorm'),
      B('finish','That’s all for now','thats all|all done|finish|bye|done for now','A good place to stop. You can export the conversation yourself or reset it before leaving.','All set. Nothing from this chat is sent to a model, and you control whether to save an exported copy.','talk:bye')]),
    S('sorry','Sorry about that','Small talk','sorry|my bad|oops|sorry about that|apologies|wrong message|mistyped',
      'No problem. You can rephrase, pick a different topic, or reset the chat and start clean.',
      'All good — a mistaken message does not need a big explanation. Where would you like the conversation to go instead?', [
      B('rephrase','Let me rephrase','rephrase|try again|say it differently|clarify','Go ahead with a short phrase describing the topic. This demo works best with a clear keyword and then a follow-up.','A simpler version is fine. Mention the subject first, then choose one of the conversation branches that fits.','talk:confused'),
      B('different','Choose another topic','different topic|new topic|something else','Let’s switch direction. We can talk about an idea, a coding workflow, or something lighter.','Fresh topic, same session. Pick an area that sounds useful and we’ll continue from there.','talk:project'),
      B('reset','How do I reset?','reset|start over|clear chat|fresh start','Use the Reset button or type /clear to erase the current demo conversation and its short-lived context.','Reset is an action you control in the chat toolbar. It also clears any name given during this page session.','shortcuts')]),
    S('compliment','This is pretty cool','Small talk','this is cool|youre awesome|you are awesome|great job|nice work|i like this|looks great|impressive',
      'Thanks! Want to explore how the demo works, try another conversation path, or jump into a project idea?',
      'Appreciate that. The interesting part is what you explore next: the conversation branches, the product, or something you could build.', [
      B('how','How does it work?','how does it work|how|under the hood|explain','It matches prepared keywords, keeps the active conversation path, and selects an authored reply variation. The typing effect is local animation.','The natural wording is scripted rather than generated by a live model. Follow-ups use session context to choose a relevant branch.','talk:demo'),
      B('again','Try another conversation','another conversation|another|keep chatting|try more','Let’s pick a fresh path: a riddle, a story opening, or a little creative brainstorming.','There are plenty of directions to sample. A playful prompt is a good way to see a different branch.','talk:creative'),
      B('build','I want to build something','build something|project|build|make an app','Let’s start with who the project helps and one thing it should do well. Then keep the first version small.','A focused first version is easier to test than a long feature list. We can choose a project shape next.','talk:project')]),
    S('bye','See you later','Small talk','bye|goodbye|see you|see ya|later|farewell|good night|im leaving',
      'See you later! You can export this conversation before leaving, or reset it for a clean start. No need to keep the session open.',
      'Take care. Your next conversation can begin fresh, and any exported copy is something you choose to save locally.', [
      B('export','How do I save this?','save this|save|export|keep a copy','Use the export button or type /export. The website creates a text file only when you ask it to.','Export gives you a local transcript. Review it before sharing, especially if you typed anything personal.','shortcuts'),
      B('clear','Clear before leaving','clear|reset|erase|start clean','Type /clear or use the Reset button. That clears the visible conversation and session context.','The reset control is the clean-start option. It does not delete a transcript you previously exported to your own device.','shortcuts'),
      B('stay','Actually, one more thing','one more thing|actually|stay|not yet','Of course — we can keep going. Would you rather resume a product topic or try a new conversation?', 'No rush to close the chat. Let’s find the next useful direction.','talk:return')]),
    S('joke','Tell me a joke','Play','tell me a joke|joke|make me laugh|something funny|programmer joke|got any jokes',
      'Why did the imaginary developer bring a ladder to the meeting? The requirements kept getting higher. Want another, a gentler one, or the explanation?',
      'My fictional app has a “Do everything” button. So far, it is excellent at displaying the button. Want another little joke?', [
      B('another','Another programmer joke','another joke|another|programmer|one more|more jokes','My code and I agreed to take a break. It immediately threw an exception. We are still negotiating the terms.','I named my unfinished project “Final.” Now every new folder is a plot twist.','talk:joke'),
      B('gentle','Keep it wholesome','wholesome|gentle|clean joke|not about code','A tiny turtle opened a delivery service. Its slogan was “Eventually, with care.” It remains a fictional business with very patient customers.','An imaginary cloud tried stand-up comedy. The audience said its jokes went over their heads.','talk:turtle'),
      B('explain','Explain the joke','explain|dont get it|why funny|explanation','The joke treats changing project requirements as something physically getting taller, so the developer brings a ladder. It is a deliberately silly literal interpretation.','It is wordplay: ordinary work language gets treated as a physical event. No elaborate hidden meaning required.','talk:riddle')]),
    S('curiosity','Give me something curious','Play','fun fact|something interesting|interesting fact|make me think|curious|surprise me',
      'Try this tiny thought experiment: write every number from 1 to 10, then pair the first with the last. What do you notice about each pair?',
      'A small pattern puzzle: pair 1 with 10, 2 with 9, and keep going. Each pair reaches the same total. Want to finish it or try a different puzzle?', [
      B('answer','Show the pattern','answer|show me|pattern|tell me','Each pair adds to 11: there are five pairs, so the total is 5 × 11 = 55. Grouping the numbers changes how easy the sum is to see.','The pairs are 1+10, 2+9, 3+8, 4+7, and 5+6. Five elevens give 55.','talk:riddle'),
      B('code','Turn it into code','code|program it|javascript|example','A tiny JavaScript version is: Array.from({length: 10}, (_, i) => i + 1).reduce((sum, n) => sum + n, 0). It sums the same ten numbers.','For an explicit loop: let total = 0; for (let n = 1; n <= 10; n++) total += n; The expected total is 55.','javascript'),
      B('different','A different challenge','different|another puzzle|different challenge|riddle','Try a word-based riddle instead: what has keys but cannot open a door? You can ask for a hint before the answer.','Let’s move from numbers to words. A simple riddle gives us a different kind of pattern to notice.','talk:riddle')]),
    S('riddle','A little riddle','Play','give me a riddle|riddle|puzzle time|brain teaser|what has keys|puzzle',
      'What has keys but cannot open a door? You can take a guess, ask for a hint, or reveal the answer.',
      'Here is the riddle again: plenty of keys, but none will unlock a door. What object fits?', [
      B('hint','Give me a hint','hint|clue|help me guess|not sure','Think about something you might play or type on, rather than something you keep on a key ring.','These keys are useful for making notes or entering letters. The riddle accepts more than one sensible answer.','talk:riddle'),
      B('answer','Reveal the answer','answer|reveal|piano|keyboard|tell me','A piano or a computer keyboard both fit. Nice thing about this riddle: there is not just one reasonable interpretation.','A keyboard works, and so does a piano. Their keys do something other than operate a door lock.','talk:curiosity'),
      B('another','Try a different riddle','another|different riddle|next puzzle|one more','What gets bigger when you take something away? A hole. That one flips the usual expectation about adding and removing.','Here is another, with the answer: what has a face and hands but no arms? A clock.','talk:joke')]),
    S('creative','Let’s get creative','Create','lets get creative|creative challenge|creative mood|be creative|spark creativity|imagination',
      'Let’s make a small creative playground. We can invent a product, name a strange idea, or begin a short story. Which direction catches your attention?',
      'Start with an odd constraint: one button, three words, or a world where something ordinary works differently. Pick a direction and we’ll build from it.', [
      B('invent','Invent a tiny product','invent|product|one button|tiny app','Imagine a one-button app that saves a “restart note” for the task you are leaving. The first version only needs to capture and show that note.','Tiny product idea: a desk-side checklist with exactly three slots. It is intentionally too small to become an endless backlog.','talk:project'),
      B('name','Name an idea','name|naming|brand name|title','Let’s give the idea a personality before choosing a name: playful, professional, or technical. The tone changes the options.','A useful name can hint at the feeling or job of the product. We can try a few fictional directions next.','talk:naming'),
      B('story','Start a story','story|fiction|write a story|imagine a world','The first message arrived from a computer that had been unplugged for years: “Please do not update the clock.” Want to take that into science fiction or something cozier?','At closing time, the little repair shop received a parcel addressed to “Whoever still fixes impossible things.” That is our fictional opening.','talk:story')]),
    S('naming','Help me name an idea','Create','name my app|name an idea|naming ideas|brand name ideas|help me name|choose a name',
      'Let’s pick a tone first. Should the name feel playful, professional, or clearly technical? These will be fictional brainstorming options, not availability checks.',
      'A name is easier to shape once the feeling is clear. We can try friendly, understated, or developer-oriented directions; none are checked for trademark or domain availability.', [
      B('playful','Playful names','playful|fun|friendly|cute','A few fictional directions: Buttonbud, Idea Sprout, or Pocket Spark. Each suggests a small, approachable tool rather than an all-purpose platform.','Try Doodle Dock, Pebble Plan, or Tiny Launch as creative placeholders. Keep the one whose tone matches the project.','talk:brainstorm'),
      B('professional','Professional names','professional|clean|serious|understated','Possible working titles: Clearstep, Northline, or Plainview Studio. Treat these as tone experiments and check availability before using one.','Try a quiet, descriptive direction such as Taskline or Project Ledger. A practical subtitle can explain the actual product.','talk:writing'),
      B('technical','Technical names','technical|developer|dev|code focused','Fictional placeholders: ContextForge, Stacknote, or Branchlight. Choose a name that suggests the job without promising capabilities you have not built.','You could explore Patchroom, Querydesk, or Buildlane as working names. These are brainstorms, not verified brands.','talk:project')]),
    S('story','Tell me a tiny story','Create','tell me a story|short story|story time|write a story|tiny story|make up a story',
      'Let’s make up a short story. Choose a science-fiction mystery, a cozy little scene, or a tiny adventure.',
      'We can take a fictional opening in three directions: strange technology, a warm everyday moment, or an unexpected journey. Which one?', [
      B('scifi','Science-fiction mystery','sci fi|science fiction|space|mystery','The station’s last engineer found a message in tomorrow’s maintenance log: “Bring two cups.” At sunrise, someone knocked from inside the empty airlock.','The ship kept receiving a distress signal in its own voice. The captain answered with one question: “Which version of us are you?”','talk:creative'),
      B('cozy','Something cozy','cozy|warm|gentle|quiet story','The little café kept a shelf for unfinished projects. One rainy afternoon, a stranger returned to finish a scarf — and found a note from the person who had kept it safe.','Every evening, the old shopkeeper wound a clock that no longer told time. It was simply the moment when the neighbours knew tea was ready.','talk:evening'),
      B('adventure','A tiny adventure','adventure|journey|explore|quest','The map showed one instruction: “Turn left where the road gives up.” Mara packed a sandwich, took a pencil, and decided the map needed a better ending.','A tiny turtle found a door painted on a stone. When it knocked politely, the mountain asked whether it had an appointment.','talk:turtle')]),
    S('music','Let’s talk about music','Play','lets talk music|music|what should i listen to|music mood|focus music|playlist vibe',
      'What kind of mood are you after — calm focus, a little energy, or something to unwind with? I can suggest a listening direction, but I cannot play music from this demo.',
      'Let’s choose the job for the music before the sound. Is it background company, a creative boost, or a way to wind down?', [
      B('focus','A focus mood','focus|study|concentration|background','You could try an instrumental, low-distraction direction and see whether it suits the task. Keep the volume comfortable and notice whether it helps you stay with the work.','For a focus experiment, choose something that does not keep pulling your attention toward lyrics or sudden changes. Your own response matters more than the label.','talk:focus'),
      B('energy','Something energetic','energy|energetic|upbeat|creative boost','Pick an upbeat sound you already enjoy, then give the work a clear target. Music can set the atmosphere; it does not need to carry the whole task.','A little momentum can start with a familiar favourite and one finishable action. No specific track or streaming service is being opened here.','talk:motivation'),
      B('chill','Time to unwind','chill|unwind|relax|calm','A gentler, familiar sound might fit the moment. We can also switch the conversation away from work and into a quiet fictional story.','Choose a pace that feels comfortable rather than another thing to optimize. This can simply be a change of atmosphere.','talk:evening')]),
    S('focus','Help me focus','Momentum','help me focus|i cant focus|cant concentrate|focus session|stay focused|distractions',
      'Let’s set up a small focus block: choose one result, remove one distraction, and decide when you will stop to review.',
      'Focus needs a target. What would you like to make concrete first: the task, the surroundings, or the finish line?', [
      B('target','Define one target','target|one result|task|what to work on','Turn “work on the app” into something observable, such as “show an empty state when the list has no items.” One target is enough for this block.','Choose a result you could point to afterwards: a test, a paragraph, a working button, or a decision written down.','talk:project'),
      B('distraction','Reduce distractions','distraction|notifications|tabs|surroundings','Close the unrelated tabs and put a note somewhere for ideas that interrupt you. You can return to that note when the current block ends.','Instead of following every new thought, park it on a short later-list. That keeps the current task from changing shape every minute.','talk:procrastination'),
      B('timer','Set a stopping point','timer|time block|stop|finish line','Choose a short interval on your own timer and a specific stopping condition. This website will not start a real timer or send a reminder.','Decide what you will review at the end of the block. Keep the interval realistic; the useful part is a bounded attempt, not a perfect streak.','talk:day')]),
    S('procrastination','I keep putting it off','Momentum','im procrastinating|procrastinating|putting it off|cant get started|avoiding the task|start small',
      'Let’s find the friction instead of adding pressure. Is the task unclear, too large, or difficult to begin because the first version might be rough?',
      'We can make starting easier without pretending the whole task is easy. Choose the obstacle: uncertainty, size, or perfection.', [
      B('unclear','The task is unclear','unclear|confusing|dont understand|uncertain','Write down what is known, what is unknown, and the next question that would unblock progress. The first task may be getting an answer rather than building.','A useful first move is to remove one uncertainty. Define the missing decision before trying to complete the entire project.','talk:decision'),
      B('large','It feels too big','too big|large|too much|overwhelming','Shrink the task to a visible first slice. For a website, that might be one heading and one working link rather than the whole homepage.','Choose the smallest version that still teaches you something. You can add the next slice after checking the first one.','talk:focus'),
      B('perfect','I want it to be perfect','perfect|perfection|afraid of mistakes|not good enough','Give the first attempt a different job: make the idea inspectable. It does not need to be final before it can be useful.','A rough draft is allowed to be a draft. Set one criterion to improve on the second pass rather than demanding every criterion immediately.','talk:confidence')]),
    S('day','Help me plan my day','Momentum','plan my day|daily plan|organize my day|todays priorities|make a daily plan|plan tomorrow',
      'Let’s make a flexible day plan, not a wall of obligations. Choose a main priority, decide where it fits, and leave room to review.',
      'A practical day plan can be three lines: one must-move item, one useful smaller task, and a clear stopping point. Which part should we shape?', [
      B('priorities','Pick the priorities','priorities|main task|most important|priority','Separate what truly needs action today from what merely feels loud. Pick one main result and one smaller result that would still make the day useful.','Use a real deadline or an unblocking effect as a reason to prioritize. Avoid treating every item as equally urgent.','talk:decision'),
      B('time','Make room for the work','time|schedule|calendar|time block','Place the main task into a realistic open block in your own calendar. This demo does not read or change your calendar.','Allow space for transitions and interruptions instead of packing every minute. A plan should help you adapt, not make every adjustment feel like failure.','talk:focus'),
      B('review','Review at the end','review|reflection|end of day|check progress','At the end, note what moved, what remains, and the next starting action. That makes the next session easier to enter.','Close the plan with evidence, not just a feeling: a thing completed, a question answered, or a blocker identified.','talk:wins')]),
    S('learning','I want to learn something','Momentum','i want to learn|learn something|learning plan|learn a new skill|teach me something|where to learn',
      'Let’s choose the learning shape: a beginner-friendly explanation, a tiny practice exercise, or a way to check what you already understand.',
      'A useful learning session has a small target and a way to try it. Would you like an explanation, practice, or a self-check?', [
      B('beginner','Start simply','beginner|start simply|basics|new to this','Pick one concept and explain what it is for before worrying about every detail. We can use a prepared coding example as a concrete starting point.','Start with a small mental model, then test it on an example. You do not need the entire landscape before taking a first step.','talk:simple'),
      B('practice','Give me a practice task','practice|exercise|try it|hands on','Tiny exercise: write a function that doubles a number, then check it with 0, a positive number, and a negative number. Describe what should happen before running it.','Practice prompt: make a button change its label when pressed. Keep it simple, then decide how you would verify the behavior.','javascript'),
      B('check','Check my understanding','check understanding|quiz|self check|test me','Explain the idea in three sentences: what it does, when you would use it, and one way it can go wrong. Then compare that explanation with a trusted guide.','Try changing one part of an example and predicting the result before running it. The comparison can reveal which part needs another look.','tests')]),
    S('confidence','I’m not sure I can do it','Momentum','not sure i can do it|im not good enough|im a beginner|doubting myself|lack confidence|i keep making mistakes',
      'Being unsure does not mean you need to solve everything alone or all at once. We can choose a small practice step, review a mistake, or clarify what help is needed.',
      'Let’s measure the next attempt by what it teaches you. A focused task and a way to check it are more useful than a verdict about your ability.', [
      B('mistake','Learn from a mistake','mistake|made a mistake|failed|something went wrong','Describe what you expected, what happened, and the smallest case that shows the difference. That turns the mistake into something you can investigate.','A mistake is easier to work with once it becomes a reproducible example rather than a vague feeling that everything is wrong.','debugging'),
      B('practice','Pick a practice step','practice|small step|try|beginner task','Choose one behavior to build and one way to test it. A simple button, a short function, or a clear paragraph all work as practice targets.','Keep the exercise small enough that you can finish a first pass and inspect it. Complexity can come later.','talk:learning'),
      B('help','Ask for useful help','ask for help|help|support|what should i ask','A useful help request includes the goal, the exact obstacle, what you tried, and a small relevant example. Leave out credentials and unrelated personal information.','Give the other person a clear question rather than the whole unresolved project. Specific context makes the next exchange easier.','talk:feedback')]),
    S('feedback','How do I give good feedback?','Momentum','give good feedback|feedback on an idea|constructive feedback|review feedback|how to give feedback',
      'Useful feedback points to something specific and gives the next revision a direction. We can make it clearer, kinder, or more actionable.',
      'Let’s separate observation from preference: what happened, why it matters to the goal, and what you suggest trying next.', [
      B('specific','Make it specific','specific|clear|concrete|observation','Replace “this is confusing” with “I could not tell which button saved the change.” The second version names an observable problem.','Point to the exact moment or element that caused friction. That gives the person something they can inspect and test.','talk:design'),
      B('kind','Keep it considerate','kind|considerate|gentle|respectful','Describe the work rather than judging the person. You can be direct about a problem without making it a statement about someone’s ability.','Try “This section did not give me enough context” instead of “You explained it badly.” The issue stays clear without making it personal.','talk:team'),
      B('action','Suggest a next step','actionable|next step|suggestion|improvement','Suggest a small change and a way to evaluate it: “Try a clearer label, then ask a fresh reader what they expect it to do.”','A good next step is testable. Keep the revision narrow enough that you can tell whether it solved the original issue.','tests')]),
    S('team','Let’s work as a team','Momentum','teamwork|work as a team|collaborate on this|team handoff|divide the work|working together',
      'Let’s make the collaboration concrete. We can define roles, create a clear handoff, or decide how the work gets reviewed.',
      'A small team plan works better when the outcome, responsibilities, and review points are visible. Which part needs attention first?', [
      B('roles','Define the roles','roles|responsibilities|divide work|who does what','Give each role a clear output: one person frames the problem, one makes the change, and one checks it against the goal. Adjust that split to the project.','Avoid assigning several people the same vague task. Name the result each role is responsible for and where the pieces meet.','agents'),
      B('handoff','Write a handoff','handoff|pass it on|context|transfer','A handoff should say what changed, what is still uncertain, how it was checked, and what the next person needs to do.','Include enough context to continue without replaying the whole history. Link to the relevant work and name any unresolved decisions.','workflow'),
      B('review','Review together','review|check work|quality|approval','Agree on the acceptance criteria before reviewing. Then separate blockers from preferences so the next revision has a clear order.','Review the actual result against the stated goal. A short reproducible check is more useful than a general “looks fine.”','tests')]),
    S('decision','Help me make a decision','Momentum','help me decide|make a decision|weigh options|compare my options|cant decide|decision framework',
      'Let’s define the decision rather than jump to an answer. We can set criteria, compare trade-offs, or design a small experiment.',
      'A useful decision process makes uncertainty visible. What matters most here: clarifying priorities, understanding costs, or testing an assumption?', [
      B('criteria','Set clear criteria','criteria|priorities|what matters|requirements','List the must-haves separately from preferences. Include constraints you cannot change, then check each option against the same questions.','Choose a small set of criteria tied to the goal. Too many vague criteria can make every option look both good and bad.','talk:project'),
      B('tradeoffs','Look at trade-offs','trade offs|tradeoffs|pros and cons|costs','For each option, name what it makes easier and what it makes harder. Write down the assumptions behind those judgments.','Trade-offs become clearer when you include maintenance, effort, and what you might need to undo later, not only the initial attraction.','workflow'),
      B('experiment','Test before committing','experiment|prototype|test it|try first','Build the smallest test that answers the uncertain question. Decide what evidence would change your mind before running it.','A reversible trial can be more informative than a long debate. Keep the test focused on the assumption that matters most.','tests')]),
    S('weekend','A low-key weekend idea','Play','weekend idea|something to do this weekend|low key weekend|weekend project|weekend plans',
      'Let’s keep the idea simple and local to your own space: make something creative, finish a tiny personal project, or leave room to unwind.',
      'What kind of weekend pace sounds good — playful, practical, or deliberately unhurried? These are general ideas, not live event listings.', [
      B('creative','Make something creative','creative|art|make something|playful','Try a one-page fictional travel journal for an imaginary place, or invent a tiny product with a name and a sketch. No big commitment needed.','Give yourself an unusual constraint, like telling a story in six sentences or designing an app with one button.','talk:creative'),
      B('practical','A tiny useful project','practical|useful|project|build','Make a small tool for a task you repeatedly do by hand: a checklist, a notes page, or a simple tracker. Keep the first version personal and focused.','A weekend-sized project should have a stopping point. Choose one useful behavior and leave the extras for another time.','talk:project'),
      B('relax','Keep it unhurried','relax|rest|unhurried|nothing busy','Leave some of the time unplanned. A familiar activity, a quiet story, or a small creative detour can be enough without turning the day into a checklist.','A low-key weekend does not need an achievement report. We can simply choose a lighter conversation direction.','talk:evening')]),
    S('coffee','Coffee break conversation','Play','coffee break|coffee|tea break|coffee first|tea|quick break',
      'Coffee-break mode: no giant roadmap required. Are we chatting over an imaginary cup, collecting a tiny idea, or heading back to the work gently?',
      'Let’s give the task list a moment offstage. We can keep it light, sketch one idea, or make the return to work easier.', [
      B('tea','Tea, actually','tea actually|tea|not coffee|water','Tea, water, or an entirely imaginary beverage all qualify. The important part here is the change of pace, not what is in the cup.','Beverage correction accepted. We can continue with a small joke or a relaxed conversation.','talk:joke'),
      B('idea','One small idea','idea|small idea|brainstorm|something creative','Tiny idea: a “where I left off” note with three fields — task, next action, and blocker. It could be a useful little personal project.','What about a personal dashboard with exactly one useful number and one next action? Constraints can keep the first version manageable.','talk:project'),
      B('return','Back to work','back to work|return|focus|get going','Before diving back in, choose the first small action. You do not need to rebuild the entire plan just to restart.','Give yourself an obvious re-entry point: one file, one paragraph, or one test. That is enough for the next block.','talk:focus')]),
    S('turtle','A tiny turtle detour','Play','turtle|turtles|tiny turtle|shell yeah|turtle story|tell me about turtles',
      'A tiny fictional turtle has joined the brainstorm. Its proposed project plan is “small steps, sturdy shell, finish one thing.” Shall we give it a story, a project, or a slogan?',
      'Meet our imaginary turtle project manager: very patient, strongly in favour of manageable tasks, and unwilling to schedule meetings during lettuce time. What should it do next?', [
      B('story','Give the turtle a story','story|adventure|turtle story|fiction','The turtle arrived at the finish line carrying a little sign: “I also fixed the path.” Nobody had asked, but everyone appreciated the smoother journey home.','A tiny turtle opened a repair shop for broken plans. Its first rule was simple: make the next step small enough to take.','talk:story'),
      B('project','A turtle-sized project','project|app|build|tiny project','Let’s imagine a turtle-themed habit checklist with just one daily action. The first version can be one button and a friendly completion state.','A small project brief: show one task, let the visitor mark it done, and make resetting clear. Everything else is optional for the first pass.','website'),
      B('slogan','Give it a slogan','slogan|motto|name|shell','“Small steps. Solid shell.” Or, for the imaginary product team: “Slow down enough to ship the right thing.”','A playful option: “Shell we make progress?” A calmer one: “Steady work, one step at a time.”','talk:naming')]),
    S('wins','Notice a small win','Momentum','small win|i did it|finished something|made progress|celebrate a win|finally finished',
      'That deserves a moment. What changed — did you finish something, understand something, or finally begin a task you had been avoiding?',
      'Progress does not have to be dramatic to count. Let’s name the result and decide whether the next move is continuing, reflecting, or stopping cleanly.', [
      B('finish','I finished a task','finished|completed|done|shipped','Give the finished task a quick check against its goal. Then note any follow-up separately so “done” does not instantly turn into an endless new scope.','A finish is worth marking clearly. Confirm the result, capture any loose end, and decide deliberately whether to continue.','tests'),
      B('learn','I figured something out','learned|understood|figured it out|solved it','Write the explanation in your own words while it is fresh. A tiny example or regression test can make the lesson easier to revisit.','You can turn the insight into something reusable: a note, a test, or a clearer comment in the relevant place.','docs'),
      B('next','Choose the next step','next|keep going|continue|another step','Keep the next step as concrete as the one you finished. Choose a visible result rather than expanding back into the entire project.','Before adding more work, ask which next action would be most useful. Momentum can include a sensible stopping point.','talk:focus')]),
    S('project','Let’s find a project idea','Build together','project idea|i want to build something|working on a project|side project idea|make something useful|what should i build',
      'Let’s choose a project shape: a small website, a personal tracker, or a repetitive task you would like to simplify. Which one sounds useful?',
      'A good first version helps one person do one thing. Pick a website, a tiny data view, or an automation idea and we’ll narrow it down.', [
      B('website','A small website','website|site|landing page|portfolio','Start with one visitor and one action you want them to take. Then sketch a heading, a short explanation, and a clear next step.','A compact site brief is enough to begin: who it is for, what it offers, and what the visitor should do next.','talk:site'),
      B('tracker','A personal tracker','tracker|dashboard|data|personal tool','Make a small tracker for something you already record manually. Choose one entry format and one useful summary before adding charts or accounts.','A first version could be a list of entries and a total. Test whether that is useful before making the interface more elaborate.','javascript'),
      B('automation','Simplify a repeated task','automation|automate|repetitive|save time','Write the manual steps first, then identify one safe, repeatable part. Keep review or confirmation around any action that could affect other people or delete information.','Start with a harmless output such as a draft report or a renamed copy, not an irreversible bulk operation. Test with sample data.','workflow')]),
    S('coding','Be my coding buddy','Build together','coding buddy|help me code|lets code together|pair programming|coding partner|work through code',
      'Let’s work through a coding path. Are you trying to understand a piece of code, investigate a bug, or review a change before using it?',
      'We can choose an explanation, a debugging checklist, or a review plan. This demo gives prepared guidance; it does not read or modify your actual files.', [
      B('explain','Understand some code','understand|explain code|explain|what does it do','Start with the inputs, the output, and the important state changes. Then trace one small example through the function.','A useful explanation follows what happens to one piece of data rather than paraphrasing every line without context.','javascript'),
      B('bug','Work through a bug','bug|debug|error|broken','Name the expected result and the observed result, then reduce the problem to the smallest reproducible case.','Before changing anything, find a repeatable way to see the failure. That gives the eventual fix something concrete to prove.','talk:bug'),
      B('review','Review a change','review|check code|refactor|look over it','Check the goal, the changed behavior, and the tests that cover it. Keep unrelated cleanup separate from the fix where possible.','Review small diffs against explicit acceptance criteria. Ask what new edge case the change introduces, not only whether the happy path works.','refactor')]),
    S('site','Shape a website idea','Build together','website idea|plan a landing page|portfolio idea|shape a website|website brief|plan my website',
      'Let’s choose the kind of website: a landing page, a portfolio, or a simple product showcase. Each needs a slightly different main action.',
      'What should a visitor accomplish on the first page? Learn about one offer, inspect your work, or understand a product?', [
      B('landing','A landing page','landing page|landing|one offer|sign up','Lead with the outcome, explain the offer plainly, and make the next action easy to find. Do not invent customer counts or testimonials to make it look established.','A landing-page first pass can be one strong heading, a short benefit explanation, a preview, and a clear action.','website'),
      B('portfolio','A portfolio','portfolio|my work|show projects|personal site','Show a few projects with the problem, your contribution, and something inspectable such as a demo or source link. Concrete work is more useful than vague claims.','Give each project a short story: what it does, what you built, and what you learned. Keep navigation and contact details easy to find.','website'),
      B('product','A product showcase','product|showcase|store|catalog','Make the product’s purpose, current capabilities, and next step clear. Keep demo interactions distinct from features that actually run.','A showcase should help visitors understand the product without pretending a visual preview is the working application.','talk:design')]),
    S('design','Choose a design direction','Build together','design direction|design mood|choose a visual style|how should it look|visual direction|design this with me',
      'Let’s choose a design direction without changing everything at once: theme, layout, or interaction details. Which matters first?',
      'We can explore the existing light and dark themes, think about layout, or review the small interactions that make a page easier to use.', [
      B('theme','Explore the themes','theme|dark|light|colors|colour','Try the site’s theme control and compare readability, contrast, and hierarchy in both modes. The actual button changes the website theme; this reply itself does not.','A useful theme review checks more than the background: links, muted text, focus states, borders, and empty states all need attention.','themes'),
      B('layout','Think through the layout','layout|spacing|structure|mobile','Start with the content order on a narrow screen. Then add columns only where they make relationships clearer rather than merely filling space.','Check whether the page still makes sense when stacked vertically. Clear headings and a consistent action hierarchy matter before decorative details.','responsive'),
      B('interaction','Refine the interactions','interaction|animation|buttons|motion','Make the important controls work with keyboard focus and clear feedback. Motion should support the change, not be the only way to understand it.','Review loading, empty, success, and error states. An interface feels more complete when it explains what happened and what is possible next.','accessibility')]),
    S('bug','Let’s debug this together','Build together','debug this together|walk me through a bug|debugging conversation|help me investigate|something is not working',
      'Let’s approach it in order: reproduce the behavior, read the exact error, and test one focused change. Which stage are you at?',
      'A useful debugging conversation separates symptoms from guesses. Can you reproduce it, do you have an error, or are you checking a proposed fix?', [
      B('reproduce','Reproduce the problem','reproduce|reproduction|steps|happens sometimes','Write the shortest sequence that shows the issue and note the expected result. Try removing unrelated inputs until the failure still happens with a smaller case.','Intermittent issues need observations too: when it happens, which inputs were used, and what changed recently. Keep sensitive data out of the report.','debugging'),
      B('error','Use the error message','error message|error|stack trace|logs','Read the exact message and identify which component produced it. A missing resource, access rejection, and network failure need different checks.','Use a redacted error and the relevant context. Avoid changing several settings at once, or it becomes hard to tell what helped.','debugging'),
      B('fix','Check a proposed fix','fix|patch|solution|verify','Run the original reproduction and add a regression check where possible. Also test a nearby case that should keep working.','A fix is stronger when you can show the failure before it and the expected behavior afterwards. Keep the diff focused.','tests')]),
    S('testing','Make a testing plan','Build together','testing plan|plan my tests|how should i test|test strategy|qa plan|check the edge cases',
      'Let’s choose the kind of check: a small unit test, an edge-case pass, or a regression test for a specific bug.',
      'Start with the behavior you need confidence in. We can test a function, challenge unusual inputs, or lock in a bug fix.', [
      B('unit','A unit test','unit test|unit|function|small test','Give a small function a known input and assert the expected output. Keep the test focused enough that a failure points to one behavior.','Start with an ordinary case, then add a boundary that matters to the function. Avoid a test that merely repeats the implementation.','tests'),
      B('edge','Check edge cases','edge cases|edge|empty|invalid input|boundary','Try empty input, missing values, repeated actions, and the relevant size limits. Choose cases based on the behavior rather than collecting random unusual inputs.','For an interface, include keyboard use, a narrow screen, loading or failure states, and repeated activation of the same control.','tests'),
      B('regression','Protect a bug fix','regression|bug fix|prevent it returning|reproduction','Turn the original failure into a check that fails before the fix and passes afterwards. Then keep it close to the affected behavior.','A focused regression test explains what must not break again. Name the user-visible behavior so the test remains understandable later.','tests')]),
    S('simple','Explain it simply','Build together','explain it simply|simple explanation|explain like a beginner|plain english|make it easier to understand|simple coding analogy',
      'Let’s choose a prepared explanation style: an analogy, a short sequence of steps, or a concrete coding example.',
      'A simple explanation should keep the important idea intact. We can use a familiar comparison, trace the steps, or look at an example.', [
      B('analogy','Use an analogy','analogy|compare it|metaphor|familiar example','Think of a function as a small workshop: it receives inputs, does a defined job, and returns a result. The useful question is what goes in and what should come out.','A function is like a recipe with explicit ingredients and a result. The analogy helps with the basic shape, though real code can also involve state and side effects.','javascript'),
      B('steps','Walk through the steps','steps|step by step|sequence|walk through','For a small function: identify the input, follow each transformation, and check the returned value. Trace one concrete input rather than keeping everything abstract.','Start at the entry point, name what changes, and stop at the output. Then try one input that sits near a boundary.','javascript'),
      B('example','Show a tiny example','example|tiny example|show code|concrete','For example, const double = n => n * 2; returns 8 when called as double(4). The input is 4, the transformation is multiplication by 2, and the result is 8.','A small example: const isEmpty = items => items.length === 0; returns true for [] and false for [1]. The expected input here is an array.','javascript')]),
    S('brainstorm','Let’s brainstorm','Create','lets brainstorm|brainstorm with me|brainstorm|give me ideas|idea session|explore ideas',
      'Let’s choose the phase: create several rough directions, narrow them down, or turn one into a first step. There is no need to do all three at once.',
      'We can go wide, choose, or begin. Which would be more useful: more options, a clearer choice, or a practical next action?', [
      B('wide','Generate a few directions','more options|go wide|ideas|options|generate','Three small directions: a restart-note app, a one-screen project showcase, or a checklist that limits itself to three tasks. Treat them as starting points to reshape.','Try one useful tool, one playful experience, and one learning project. Comparing different kinds of ideas can reveal what actually interests you.','talk:project'),
      B('narrow','Narrow the options','narrow|choose|pick one|prioritize','Compare the ideas using one real goal and one constraint. Which one has a useful first version you could realistically inspect or test?','Keep the idea that best fits the job you are trying to do, not necessarily the one with the longest feature list. Write down the trade-off.','talk:decision'),
      B('action','Turn an idea into a step','next step|action|begin|start building','Write a one-sentence brief, then name the smallest visible piece. A sketch, a heading, or one working interaction can be enough to test the direction.','Choose a first action that creates something reviewable. You can improve a concrete draft more easily than an endlessly expanding intention.','talk:focus')]),
    S('blank','I’m staring at a blank page','Create','blank page|writers block|staring at a blank page|dont know what to write|start a draft|need an opening',
      'Let’s give the blank page a small job. We can write a working headline, build a three-part outline, or use a rough sample opening.',
      'The first draft only needs to give you something to react to. Which would help most: a heading, a structure, or a sample first paragraph?', [
      B('headline','A working headline','headline|title|heading|first line','Try a descriptive placeholder: “A simpler way to keep your project in context.” Then check whether it matches what the product actually does.','A useful working headline states an outcome without exaggerating it. Keep the wording specific enough that the body can explain it.','talk:writing'),
      B('outline','A three-part outline','outline|structure|sections|three parts','Use three sections: the problem, the approach, and the next step. Put one rough sentence under each before polishing any of them.','Start with “What is happening?”, “Why does this approach help?”, and “What should the reader do next?” The answers create a basic structure.','writing'),
      B('opening','Show a sample opening','opening|sample|first paragraph|example','Sample copy: “Your project already has enough moving parts. This workspace brings the relevant files and conversation together, so the next step is easier to see.”','Sample opening: “Start with the work in front of you. Keep the useful context nearby, choose a clear next action, and build from there.”','talk:writing')]),
    S('writing','Find the right writing tone','Create','writing tone|tone of voice|make it sound friendly|rewrite in a different tone|copywriting ideas|help with wording',
      'Let’s explore a tone using a prepared sample: friendly, formal, or concise. This demo will show examples rather than rewrite arbitrary text with a live model.',
      'We can compare three ways to express the same idea. Should the sample feel welcoming, professional, or brief?', [
      B('friendly','Make it friendly','friendly|warm|casual|welcoming','Friendly sample: “Bring your idea. We’ll help you find a clear place to start, keep the useful context close, and take the next step.”','Warm sample: “A little less jumping between tools, a little more room for the work you want to do. Start with one project.”','writing'),
      B('formal','Make it professional','formal|professional|business|polished','Professional sample: “SignalREACH presents a connected workspace for project context, model configuration, and AI-assisted workflows. Review the setup guide to begin.”','Formal sample: “Explore the available product surfaces, confirm the relevant requirements, and follow the documented setup for your environment.”','writing'),
      B('concise','Keep it concise','concise|short|shorter|brief','Concise sample: “Your models. Your context. A clearer next step.” The short version works only when the surrounding page explains the details.','Brief sample: “Keep the work and the conversation together.” Use supporting copy to clarify the actual capabilities.','writing')]),
    S('demo','Is this an AI or a demo?','About this chat','is this real ai|are you a real ai|is this scripted|ai or demo|how does this chat work|is a model answering',
      'This chat is a local, scripted demonstration. Keywords choose authored conversation paths, and short-lived session context makes follow-ups more relevant. No AI request is sent.',
      'The natural replies and typing animation are part of the demo. There is no live model behind this website chat, and it cannot access your computer or accounts.', [
      B('branches','Explain the branches','branches|keywords|how|routing','Each conversation has an opening and several follow-up branches. A reply such as “I’m tired” or “show an example” is interpreted using both keywords and the active path.','The extension adds 50 conversation trees to the existing product-topic engine. It chooses from prepared reply variations instead of generating unrestricted answers.','limits'),
      B('live','Where does real AI happen?','real ai|live|actual app|connect model','The actual product has separate setup and connection controls. Follow its guide and configure a compatible endpoint there; this webpage does not activate a model for you.','Use the documented application workflow for live AI functionality. The website remains a preview even when its conversation sounds natural.','install'),
      B('limits','What can’t this do?','limits|cannot do|cant do|limitations','It cannot read your files, browse live information, connect accounts, or genuinely reason about arbitrary requests. Unmatched messages get an honest fallback and relevant choices.','It also cannot send messages, start real reminders, or run code on your behalf. Action buttons only perform the website actions they explicitly describe.','limits')]),
    S('privacy','What happens to this chat?','About this chat','what happens to this chat|is this chat saved|are my messages sent|conversation privacy|do you store my name|chat memory',
      'The conversation extension uses page memory only. It does not send prompts to a server or save them in browser storage. You can reset the session or explicitly export a text copy.',
      'This chat’s path and optional first name last for the current page session. Reset or reload starts fresh; exported files are separate copies you choose to create.', [
      B('memory','Explain session memory','memory|session|remember|how long','Session memory holds the current path so “yes” and “tell me more” can refer to it. It is not long-term memory or an account profile.','Each chat session gets its own context. The conversation layer does not use localStorage, cookies, or a network request to preserve it.','privacy'),
      B('export','Explain exporting','export|download chat|save copy|transcript','Export creates a local text transcript after you click the control or type /export. Review the contents before sharing it with anyone.','An exported file is under your control on your device. Resetting the on-page conversation does not erase that separate file.','shortcuts'),
      B('reset','Clear the session','reset|clear|forget|erase','Type /clear or press Reset. The conversation, active branch, reply-variation counts, and optional first name are cleared for the session.','Reloading also creates a fresh session. The site’s existing theme and motion preferences are separate from the conversation memory.','shortcuts')]),
    S('choose','Which REACH surface fits?','Build together','which reach surface|help me choose a surface|where should i start with reach|which part should i use|choose a workspace',
      'Let’s start from where you want to work: a standalone project workspace, your existing editor, or the endpoint and relay side.',
      'Different surfaces fit different starting points. Would you rather explore Studio, stay inside VS Code, or learn about hosting a connection?', [
      B('studio','A standalone workspace','studio|standalone|desktop workspace|own workspace','Explore the Studio guide for the standalone project workspace. Check the current setup requirements there before installing or configuring anything.','Studio is the product route for keeping files and conversations in a dedicated workspace. The guide is the right next stop.','studio'),
      B('editor','Stay in my editor','editor|vs code|vscode|existing editor','The VS Code route keeps the workflow in your editor. Follow the extension documentation for its actual installation and provider setup.','Use the editor guide rather than treating this website preview as an installed extension. Configuration happens in the real product.','vscode'),
      B('relay','Explore the relay','relay|endpoint|host|api','Start with the relay and endpoint guidance. Your actual host’s URL, access policy, and model catalog determine how clients connect.','The website can explain the connection fields, but it will not start a relay or verify a server for you.','relay')]),
    S('return','I’m back','Small talk','im back|back again|hello again|returned|where were we|lets continue chatting',
      'Welcome back to the conversation. We can resume the last product topic still in this session, choose something new, or start clean.',
      'Good to continue. I only have the context still held on this page, not a history from earlier visits. Where would you like to go?', [
      B('resume','Resume the last topic','resume|where were we|last topic|continue|pick up','Let’s return to the last product guidance held in this session. A page reload would have cleared that history.','We can pick up the technical path from this page session rather than imply I remember a different visit.','@resume'),
      B('new','Start a new topic','new topic|new|different|fresh topic','Let’s choose a fresh direction: an idea, a creative prompt, or a practical task. No need to clear the whole chat to switch subjects.','A new topic can begin with a short phrase. Let’s start with something you might like to make.','talk:project'),
      B('clean','Start completely fresh','start over|clean|reset|fresh start','Use Reset or /clear to clear the current conversation and optional name. Then the next message begins a new session path.','A full reset is available in the toolbar. Nothing needs to be sent to a server to clear this local demo context.','shortcuts')]),
    S('confused','I’m not following','About this chat','im confused|i dont understand|not following|that confused me|can you clarify|what do you mean',
      'Let’s make the next reply easier to follow. Would a simpler explanation, a concrete example, or a different topic help most?',
      'We can slow the explanation down without adding a wall of text. Choose an analogy, an example, or a new direction.', [
      B('simpler','Use a simpler explanation','simpler|plain english|explain simply|analogy','Let’s use a small prepared example instead of broad terminology. We can explain a function through its input, its job, and its result.','A simple explanation starts with what the thing is for, then shows one ordinary case. Details can come after that foundation.','talk:simple'),
      B('example','Show a concrete example','example|show me|concrete|sample','For the conversation demo itself: “hey” opens a greeting; “I’m tired” takes the low-energy branch; “tiny task” continues that topic. Those are scripted transitions.','A concrete demo path is “I’m bored” → “a riddle” → “hint” → “answer.” The replies follow the selected path rather than a live model.','talk:demo'),
      B('different','Change the subject','different|change subject|new topic|something else','No problem — let’s change the subject rather than repeat an explanation that is not helping. A creative prompt is one alternative.','We can leave that thread behind and choose a new starting point. The topic browser is also available.','talk:brainstorm')]),
    S('disagree','That’s not what I meant','About this chat','not what i meant|thats wrong|wrong answer|you misunderstood|not helpful|missed the point|you got it wrong',
      'Thanks for the correction. This scripted demo can choose the wrong branch. We can clarify the topic, try a different angle, or reset the conversation.',
      'Let’s correct the direction rather than pretend I understood. A specific keyword or a topic choice works better than repeating the same mismatch.', [
      B('clarify','Clarify the topic','clarify|rephrase|try again|specific','Mention the subject directly, such as “endpoint 401,” “website layout,” or “a story.” That helps the prepared router choose a more specific path.','A short subject and a clear question are useful here. This demo cannot interpret every arbitrary request like a live language model.','talk:confused'),
      B('angle','Try another angle','different angle|another way|alternative|different','Let’s choose another way into the idea: a concrete example, a small first action, or a comparison of options.','A different angle can be more useful than a longer version of the same answer. We can return to a simple explanation.','talk:simple'),
      B('reset','Find a fresh start','reset|start over|fresh start|clear','Use Reset or /clear to erase the active path. You can also choose any topic directly without clearing the transcript.','The topic browser gives you explicit choices when keyword matching misses the mark. A reset is optional, not required to switch topics.','shortcuts')])
  ];
  const byId = new Map(SCENES.map(scene => [scene.id, scene]));
  const baseTopics = new Map(base.topics.map(topic => [topic.id, topic]));
  const social = new Map([['greeting','hello'],['thanks','thanks'],['goodbye','bye']]);
  const token = (scene, branch) => `talk:${scene.id}${branch ? '/' + branch.id : ''}`;
  const normalize = value => base.normalize(value)
    .replace(/\bu\b/g,'you').replace(/\br\b/g,'are')
    .replace(/\bhe+y+\b/g,'hey').replace(/\bhi{2,}\b/g,'hi').replace(/\bhello+\b/g,'hello');
  const contains = (text, phrase) => (` ${text} `).includes(` ${phrase} `);
  function score(text, keys) {
    let best = 0;
    for (const key of keys) {
      const phrase = normalize(key);
      if (text === phrase) best = Math.max(best, 100 + phrase.split(' ').length * 4);
      else if (contains(text, phrase)) best = Math.max(best, 10 + phrase.split(' ').length * 5);
    }
    return best;
  }
  function resolve(id) {
    if (typeof id !== 'string' || !id.startsWith('talk:')) return null;
    const [sceneId, branchId, extra] = id.slice(5).split('/');
    const scene = byId.get(sceneId);
    if (!scene || extra !== undefined) return null;
    const branch = branchId ? scene.branches.find(item => item.id === branchId) : null;
    return branchId && !branch ? null : {scene, branch};
  }
  function targetChoice(id, session) {
    if (id === '@resume') id = session.getContext().lastIntent || 'overview';
    const node = resolve(id);
    if (node) return {id, label:node.branch?.label || node.scene.label, prompt:(node.branch || node.scene).keywords[0]};
    const topic = baseTopics.get(id);
    return topic ? {id, label:topic.label, prompt:topic.keywords[0]} : null;
  }
  function createSession() {
    const original = base.createSession();
    let active = null, name = '', lastProduct = null, randomIndex = 0;
    const visits = new Map();
    const reset = () => { original.reset(); active = null; name = ''; lastProduct = null; randomIndex = 0; visits.clear(); };
    function delegate(raw, settings = {}) {
      const result = original.reply(raw, settings);
      if (result?.matched && !social.has(result.intent)) { lastProduct = result.intent; active = null; }
      return result;
    }
    function choices(node) {
      const result = node.scene.branches.filter(branch => branch !== node.branch).map(branch => ({id:token(node.scene,branch),label:branch.label,prompt:branch.keywords[0]}));
      if (node.branch) {
        const next = targetChoice(node.branch.next === '@resume' ? lastProduct || 'overview' : node.branch.next,original);
        if (next) result.unshift(next);
      }
      return result.slice(0,4);
    }
    function render(node, mode = 'quick', contextual = false, customText = '') {
      active = node;
      const item = node.branch || node.scene, id = token(node.scene,node.branch);
      const count = visits.get(id) || 0; visits.set(id,count + 1);
      let text = customText || item.replies[count % item.replies.length];
      if (!customText && name && node.scene.id === 'hello' && !node.branch) text = `${name}, ${text[0].toLowerCase()}${text.slice(1)}`;
      const suggestions = choices(node);
      const exampleBranch = node.branch || node.scene.branches[0];
      const example = mode === 'example' ? `Example scripted conversation:\nYou: ${node.scene.keywords[0]}\nREACH: ${node.scene.replies[0]}\nYou: ${exampleBranch.keywords[0]}\nREACH: ${exampleBranch.replies[0]}` : '';
      return {intent:id, title:item.label, text,
        steps:mode === 'steps' ? suggestions.map(choice => `Try “${choice.prompt}” — ${choice.label}.`) : [],
        example, actions:[], suggestions, matched:true, mode, contextual, alternatives:[], conversation:true};
    }
    function continueTo(id, mode) {
      if (id === '@resume') id = lastProduct || 'overview';
      const target = resolve(id);
      if (target) return render(target,mode,true);
      return delegate(baseTopics.get(id)?.keywords[0] || 'what is reach',{intent:baseTopics.has(id) ? id : 'overview',mode});
    }
    function reply(raw, settings = {}) {
      const source = String(raw ?? '').trim().slice(0,base.maxInput), text = normalize(source);
      if (!text) return null;
      const mode = ['quick','steps','example'].includes(settings.mode) ? settings.mode : 'quick';
      const command = source.toLowerCase();
      if (/^\/(clear|reset)$/.test(command)) { reset(); return {command:'clear'}; }
      if (['/topics','/export'].includes(command)) return original.reply(source,settings);
      if (['/conversation','/chat','/randomchat'].includes(command)) return render({scene:SCENES[randomIndex++ % SCENES.length],branch:null},mode);
      if (command === '/help') {
        const result = delegate(source,settings);
        return {...result,text:result.text + ' Use /conversation for a scripted conversation path, or browse the conversation groups in Topics.'};
      }
      // Optional, deliberately narrow first-name input. No extraction from arbitrary messages.
      const introduction = source.match(/^(?:my name is|call me)\s+([A-Za-z][A-Za-z -]{0,29})[.!]?$/i);
      if (introduction && !/\b(?:an|a|the|maybe|something|anything|tomorrow)\b/i.test(introduction[1])) {
        name = introduction[1].trim().replace(/\s+/g,' ');
        return render({scene:byId.get('name'),branch:null},mode,false,`Nice to meet you, ${name}! I’ll use that name in this page session only. We can chat, explore an idea, or skip straight to the product guides.`);
      }
      if (/^(?:do you remember my name|remember my name|whats my name|what is my name)$/.test(text)) {
        return render({scene:byId.get('name'),branch:null},mode,true,name ? `You asked me to call you ${name} in this page session. Reset or reload clears that information.` : 'You have not given me a name in this page session. You can say “call me Alex,” or continue without sharing one.');
      }
      if (/^(?:forget my name|clear my name|dont use my name)$/.test(text)) { name = ''; return render({scene:byId.get('name'),branch:null},mode,true,'The optional name has been cleared from this session. We can keep chatting without it.'); }
      let forced = resolve(settings.intent);
      if (!forced && social.has(settings.intent)) forced = {scene:byId.get(social.get(settings.intent)),branch:null};
      if (forced) return render(forced,mode,Boolean(forced.branch));
      if (baseTopics.has(settings.intent)) return delegate(source,settings);
      if (active) {
        // Follow the suggested next conversation without requiring the visitor to
        // click its title first (hello -> tired -> tiny task, bored -> riddle -> hint).
        const nextScene = active.branch ? resolve(active.branch.next)?.scene : null;
        const localScenes = [...(nextScene && nextScene !== active.scene ? [nextScene] : []),active.scene];
        const exactBranch = localScenes.flatMap(scene => scene.branches.map(branch => ({scene,branch})))
          .find(node => node.branch.keywords.some(key => normalize(key) === text));
        if (!command.startsWith('/') && exactBranch) {
          if (exactBranch.branch.next === '@resume' && lastProduct) return continueTo('@resume',mode);
          return render(exactBranch,mode,true);
        }
        if (/^(?:yes|yeah|yep|yes please|sure|ok|okay|go ahead|sounds good|do that|lets do it)$/.test(text)) {
          return active.branch ? continueTo(active.branch.next,mode) : render({scene:active.scene,branch:active.scene.branches[0]},mode,true);
        }
        if (/^(?:no|nope|not really|no thanks|nah)$/.test(text)) return render(active,mode,true,'No problem — we can take another direction. Choose a different option below, or mention a new topic.');
        if (/^(?:more|more detail|more details|tell me more|explain more|elaborate|go deeper|explain that|continue|how|step by step|steps|show steps|in detail)$/.test(text) || command === '/steps') return render(active,'steps',true);
        if (/^(?:example|examples|show an example|show me an example|give me an example|sample|sample code|show code)$/.test(text) || command === '/example') return render(active,'example',true);
        if (/^(?:shorter|brief|briefly|quick|simpler|summarize|summarise|tldr)$/.test(text)) return render(active,'quick',true);
        if (/^(?:what next|whats next|next|next step|next steps)$/.test(text)) return active.branch ? continueTo(active.branch.next,mode) : render({scene:active.scene,branch:active.scene.branches[0]},mode,true);
        if (/^(?:another topic|something else|change topic|new topic)$/.test(text)) return render({scene:SCENES[(SCENES.indexOf(active.scene) + 1) % SCENES.length],branch:null},mode,true);
      }
      if (command.startsWith('/')) return delegate(source,settings);
      const roots = SCENES.map(scene => ({scene,score:score(text,scene.keywords)})).filter(item => item.score).sort((a,b) => b.score-a.score);
      const root = roots[0];
      const nextScene = active?.branch ? resolve(active.branch.next)?.scene : null;
      const localScenes = active ? [...(nextScene && nextScene !== active.scene ? [nextScene] : []),active.scene] : [];
      const branches = localScenes.flatMap(scene => scene.branches.map(branch => ({scene,branch,score:score(text,branch.keywords)})))
        .filter(item => item.score).sort((a,b) => b.score-a.score);
      const branch = branches[0];
      // Probe without mutating the real product session. Concrete errors should beat a greeting.
      const probe = base.createSession().reply(source);
      const technical = probe?.matched && !social.has(probe.intent);
      const technicalTopic = technical ? baseTopics.get(probe.intent) : null;
      const productScore = technicalTopic ? score(text,technicalTopic.keywords) : 0;
      const specificError = /\b(?:401|403|404|429|500|502|503|cors|econnrefused)\b/.test(text);
      if (technical && specificError) return delegate(source,settings);
      if (branch && branch.score >= (root?.score || 0) && (branch.score >= 100 || !technical || branch.score >= productScore + 5)) return render({scene:branch.scene,branch:branch.branch},mode,true);
      if (root && (!technical || root.score >= 100 || root.score >= productScore + 10)) return render({scene:root.scene,branch:null},mode);
      if (technical) return delegate(source,settings);
      if (root) return render({scene:root.scene,branch:null},mode);
      if (branch) return render({scene:branch.scene,branch:branch.branch},mode,true);
      if (social.has(probe?.intent)) return render({scene:byId.get(social.get(probe.intent)),branch:null},mode);
      if (active) return {...render(active,mode,true,'I do not have an authored branch for that message yet. I’m a local scripted demo, not a live AI. Choose a related option below or name a different topic.'),matched:false};
      return delegate(source,settings);
    }
    return {reply,reset,getContext:() => ({...original.getContext(),lastIntent:active ? token(active.scene,active.branch) : original.getContext().lastIntent,conversationId:active?.scene.id || null,branchId:active?.branch?.id || null,name,lastProduct})};
  }
  // Freeze exported authoring data so one visitor session cannot mutate another's catalog.
  for (const scene of SCENES) {
    for (const branch of scene.branches) { Object.freeze(branch.keywords); Object.freeze(branch.replies); Object.freeze(branch); }
    Object.freeze(scene.keywords); Object.freeze(scene.replies); Object.freeze(scene.branches); Object.freeze(scene);
  }
  const topics = [...base.topics.filter(topic => !social.has(topic.id)), ...SCENES.map(scene => Object.freeze({id:token(scene),label:scene.label,group:scene.group,keywords:scene.keywords}))];
  const phrases = SCENES.reduce((sum,scene) => sum + scene.keywords.length + scene.branches.reduce((n,branch) => n + branch.keywords.length,0),0);
  globalThis.SignalREACHChat = Object.freeze({...base, createSession,normalize,topics:Object.freeze(topics),
    conversationVersion:1,conversationCount:SCENES.length,conversationNodeCount:SCENES.reduce((n,scene) => n+1+scene.branches.length,0),
    conversationReplyCount:SCENES.reduce((n,scene) => n+scene.replies.length+scene.branches.reduce((m,branch) => m+branch.replies.length,0),0),
    keywordCount:base.keywordCount + phrases,conversations:Object.freeze(SCENES)});
})();
