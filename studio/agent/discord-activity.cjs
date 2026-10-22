'use strict';

// Show actual tool events, never model claims or raw commands/credentials.
function describeTool(tool, args = {}) {
  const name = String(tool || 'unknown');
  if (/shell|terminal|exec/.test(name)) {
    return /\b(?:python\d*(?:\.\d+)?|py)\b/i.test(String(args.command || '')) ? 'Python via terminal' : 'Terminal command';
  }
  if (/websearch|web_search|search_web/.test(name)) return 'Web search';
  if (/browse|fetch|web\./.test(name)) return 'Web page retrieval';
  if (/^browser[._]/.test(name)) return 'Browser automation';
  if (/read/.test(name)) return 'Read files or connected data';
  if (/search|glob|list/.test(name)) return 'Search or list workspace';
  if (/write|edit|patch/.test(name)) return 'Propose or apply file changes';
  if (/test/.test(name)) return 'Run tests';
  if (/^mcp[._]/.test(name)) return 'MCP tool';
  return 'Tool: ' + name.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 70);
}

function activityLine(event) {
  if (event.type === 'request-start') return 'Generating a response' + (event.model ? ' with ' + String(event.model).replace(/[^a-zA-Z0-9_.:/-]/g, '').slice(0, 80) : '') + '...';
  if (event.type === 'reasoning') return 'Thinking through the request...';
  if (event.type === 'jev-policy') return event.severity === 'error' || event.reason === 'failed'
    ? 'Response review flagged a problem. Check the run details in Studio.' : 'Reviewing the response...';
  if (event.type === 'run-state' && ['blocked', 'waiting_edits', 'stopped'].includes(event.status)) return 'Run status: ' + event.status.replaceAll('_', ' ');
  if (event.type === 'tool-call') return 'Started: ' + describeTool(event.tool, event.arguments);
  if (event.type === 'tool-result') return (event.pending ? 'Awaiting review: ' : event.ok === true ? 'Succeeded: ' : 'Failed: ') + describeTool(event.tool);
  if (event.type === 'compaction-start') return 'Compressing conversation context';
  if (event.type === 'approval-wait') return 'Waiting for your approval';
  return '';
}
module.exports = { describeTool, activityLine };
