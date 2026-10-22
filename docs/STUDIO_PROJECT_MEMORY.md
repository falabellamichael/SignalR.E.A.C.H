# Studio project memory

Studio now saves a derived project-local checkpoint after successful conversation
compaction. The full conversation remains in Studio's existing transcript store.
This is a first version of REACH's memory layout, not an implementation of an
external ICM standard.

```
.reach/memory/
  index.json
  summaries/<checkpoint-id>.json
  tasks/
  decisions/
  findings/
  archive/
```

Only summaries and the derived index are populated automatically in this version.
Each summary links to the preceding checkpoint for that conversation, records its
project identity, and carries SHA-256 fingerprints for eligible source paths
reported by transcript metadata. Sources not present in that metadata are not
invented. A summary is explicitly unverified historical context, not a new instruction.

Before requests, Studio selects up to three keyword-relevant checkpoints from the
same project and conversation. Whole records must fit within 5% of the configured
context target, capped at 1,800 characters. Existing wire-budget checks still
apply. Retrieved blocks are removed before compaction to prevent summary feedback
loops. Current task state, pending approvals, and exact edit arguments remain
governed by the existing compaction protections.

Changed, missing, oversized, or inaccessible source files mark the retrieved
record as stale. The model is told to reread source. Path traversal and symbolic
links are rejected. The index can be rebuilt from records and is not used as the
authority for retrieval. Storage is capped at 200 records; oversized summaries
are skipped instead of truncated. Automatic retention/archival is not yet enabled.

Known endpoint credentials and common credential patterns are redacted before
writing. This is best-effort redaction, not a guarantee that arbitrary private
text can be identified. Treat this directory as private project data; exclude it
from version control or shared archives when appropriate. Conversation summaries
may contain project information just as the original conversation does.

Set an agent's `settings.projectMemory` to `false` to disable writing and retrieval.
There is no dedicated settings control yet. Deleting `.reach/memory` removes the
derived memory without deleting the original Studio transcript. Cross-agent
sharing, semantic embeddings, graph traversal, and automatic promotion of facts
are intentionally not part of this first version.
