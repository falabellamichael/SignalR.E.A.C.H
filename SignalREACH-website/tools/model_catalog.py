"""Public catalog copy and publisher benchmark, shared by the page generator."""
from html import escape

MODELS = [
    ('LFM3 VL 2B', 'Chat, vision & tools', 'Work with text and images, ask questions about visual content, draft writing and code, and use connected tools. The hosted model has a 131,072-token context window shared by input and output.'),
    ('BGE M3', 'Multilingual embeddings', 'Turn text into searchable representations so a retrieval system can find passages with related meaning across languages. Useful for document search and retrieval-augmented generation.'),
    ('BGE Reranker v2 M3', 'Search reranking', 'Score candidate passages against a question and put the most relevant results first. Use it after retrieval to improve the context supplied to a chat model.'),
    ('Liquid d1 Omni 600M', 'Multimodal decisions', 'Choose among defined outcomes using text, images or audio. Useful for classification and routing when you need a scored decision rather than a conversational answer.'),
    ('Liquid d1 3B', 'Text & image decisions', 'Evaluate text and images against defined questions or choices. Useful for document triage, visual classification and structured decision workflows.'),
]

# Scores transcribed from the user-supplied Liquid AI comparison image.
BENCHMARKS = [
    ('Agents', [
        ('LiveClaw', [45.60,14.70,30.37,20.36,19.94,35.77]),
        ('Claw-Eval General (EN), average', [68.64,62.63,60.74,56.14,61.96,66.53]),
        ('Claw-Eval General (EN), pass^3', [51.40,37.52,34.58,22.43,42.99,51.87]),
        ('BrowseComp-Plus (OpenClaw subset)', [37.00,26.33,16.83,21.00,24.67,38.00]),
        ('WebArena-Verified', [38.42,3.02,9.11,17.06,21.92,28.94]),
        ('EnterpriseOps-Gym', [28.20,7.94,13.41,9.86,25.96,28.97]),
        ('AutomationBench (public)', [41.29,0.94,4.71,1.92,8.67,15.10]),
    ]),
    ('Tool use', [
        ('BFCL V4', [71.39,55.89,62.65,48.25,55.12,62.83]),
        ('ToolSandbox', [80.36,78.04,68.16,69.27,75.40,76.41]),
        ('MCP-Atlas', [32.57,16.45,26.38,6.19,41.37,42.67]),
        ('τ³-bench (4 domains), average', [68.01,56.77,69.44,33.53,65.98,67.11]),
    ]),
    ('Agentic coding', [
        ('SWE-bench Verified (OpenCode)', [43.40,18.00,34.80,0.50,41.20,51.20]),
        ('SWE-bench Multilingual (OpenCode)', [23.00,8.00,15.67,0.67,23.33,35.00]),
        ('Terminal-Bench 2.1 (OpenCode)', [12.92,0.00,5.62,0.00,13.48,17.98]),
    ]),
    ('Coding', [
        ('LiveCodeBench v6', [73.46,60.57,70.52,71.00,61.99,69.86]),
        ('LiveCodeBench Pro 25Q2', [31.74,19.16,29.34,29.94,24.25,34.43]),
    ]),
]

def model_rows():
    return ''.join(f'<li class="model-row"><span class="model-name"><b>{escape(name)}</b><small>{escape(role)}</small><span class="model-description">{escape(description)}</span></span><span class="pill gold">Available</span></li>' for name, role, description in MODELS)

def benchmark_details():
    names = ['LFM3 1.7B', 'LFM2.5 2.6B', 'MiniCPM5 2B', 'Gemma 4 E4B', 'Qwen3.5 4B', 'Qwen3.5 9B']
    header = '<tr><th scope="col">Benchmark</th>' + ''.join(f'<th scope="col">{name}</th>' for name in names) + '</tr>'
    rows = ''
    for group, benchmarks in BENCHMARKS:
        rows += f'<tbody><tr class="benchmark-group"><th colspan="7" scope="rowgroup">{group}</th></tr>'
        for label, scores in benchmarks:
            cells = ''.join(f'<td>{"<strong>" if score == max(scores) else ""}{score:.2f}{"</strong>" if score == max(scores) else ""}</td>' for score in scores)
            rows += f'<tr><th scope="row">{escape(label)}</th>{cells}</tr>'
        rows += '</tbody>'
    return f'''<details class="model-benchmarks" id="model-benchmarks"><summary>Explore LFM3 benchmarks <span>Agents, tool use and coding · 16 comparisons</span></summary><div class="benchmark-content"><h3>A small text model, compared across practical tasks.</h3><p>In this comparison, LFM3 1.7B has the highest score in 7 of the 16 rows shown. Its strongest results span agent tasks, tool use and LiveCodeBench v6. Other models lead the remaining rows, including repository-level coding and MCP-Atlas, so the best choice depends on the work.</p><p><strong>These results are for the LFM3 1.7B text model, not the hosted LFM3 VL 2B model.</strong> They are publisher-reported benchmark scores, not SignalREACH service measurements or a guarantee of speed or accuracy. The comparison models below are reference points, not additional subscription offerings.</p><div class="benchmark-scroll" role="region" aria-label="LFM3 benchmark comparison; scroll horizontally for all models" tabindex="0"><table class="benchmark-table"><caption>Liquid AI comparison · higher scores are better · bold marks the highest score in each row</caption><thead>{header}</thead>{rows}</table></div><p class="benchmark-source">Source: <a href="https://huggingface.co/LiquidAI/LFM3-1.7B#benchmarks" target="_blank" rel="noopener noreferrer">Liquid AI’s LFM3 1.7B model card</a>. Scores reproduced from the supplied comparison; descriptions written for SignalREACH. Results depend on each benchmark’s evaluation setup.</p></div></details>'''
