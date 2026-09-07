"""Text helpers shared by the relay: transcript scrubbing + token estimates."""

import re

# Some upstream routes (e.g. no-think wrappers over chat-log-finetuned models)
# occasionally keep writing the transcript after the answer, emitting fake
# role turns like "User: ..." / "Human: ..." / "Assistant: ...". The scrubber
# truncates at the first such line-start marker (opt-in per model).
ROLE_CONTINUATION_RE = re.compile(
    r"^\s*(user|human|assistant|system|anthropic|claude)\s*:\s*",
    re.IGNORECASE)


def scrub_trailing_roles(content):
    """Truncate content at the first transcript-continuation role line."""
    if not content or len(content) < 20:
        return content
    lines = content.splitlines()
    for idx in range(1, len(lines)):
        if ROLE_CONTINUATION_RE.match(lines[idx]):
            return "\n".join(lines[:idx]).rstrip()
    return content


TOKEN_RE = re.compile(r"""'(?:[sdmt]|ll|ve|re)|[\w]+|[^\s\w]""", re.UNICODE)


def count_tokens(text):
    """Accurate BPE token estimate for LLM text."""
    if not text:
        return 0
    words_and_punct = TOKEN_RE.findall(text)
    count = 0
    for token in words_and_punct:
        if len(token) > 6 and token.isalnum():
            count += max(1, (len(token) + 3) // 4)
        else:
            count += 1
    return max(1, count)
