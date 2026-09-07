"""Grounded web prompt: evidence block + [n] citations."""

import time


GROUNDING_SYSTEM = (
    "You are SignalR.E.A.C.H web chat — a search-grounded assistant.\n"
    "Use the SEARCH RESULTS and PAGE EXCERPTS below to answer accurately.\n"
    "Cite facts with [n] where n is the result number. If the evidence is\n"
    "insufficient, say so instead of guessing. Keep the answer focused and\n"
    "helpful. Today's date: {date}."
)




def build_grounded_messages(query, results, pages, rich=None):
    lines = ["SEARCH RESULTS:", ""]
    for index, result in enumerate(results, start=1):
        lines.append("[%d] %s" % (index, result["title"]))
        lines.append("    %s" % result["url"])
        if result.get("snippet"):
            lines.append("    %s" % result["snippet"])
        if index in pages and pages[index]:
            lines.append("    Excerpt: %s" % pages[index][:700])
    if rich:
        lines += ["", "INSTANT ANSWER:", rich]
    evidence = "\n".join(lines)
    user = "Question: %s\n\n%s\n\nAnswer with [n] citations." % (query, evidence)
    system = GROUNDING_SYSTEM.format(date=time.strftime("%Y-%m-%d"))
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]
