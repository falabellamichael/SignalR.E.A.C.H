import { gzipSync, gunzipSync } from 'node:zlib';

export const MAX_REPLAY_BYTES = 1024 * 1024;
export const MAX_STREAM_BYTES = 32 * MAX_REPLAY_BYTES;
export const STREAM_ENCODING = 'gzip-base64';

export function streamRecord(body) {
  const record = { contentType: 'text/event-stream', body };
  if (Buffer.byteLength(JSON.stringify(record)) <= MAX_REPLAY_BYTES) return record;
  return { contentType: record.contentType, encoding: STREAM_ENCODING,
    body: gzipSync(body, { level: 1 }).toString('base64') };
}

export function replayBody(record) {
  if (record.encoding === undefined) return record.body;
  if (record.contentType !== 'text/event-stream' || record.encoding !== STREAM_ENCODING
    || Buffer.byteLength(record.body) > MAX_REPLAY_BYTES) throw new Error('Invalid stream replay');
  return gunzipSync(Buffer.from(record.body, 'base64'), { maxOutputLength: MAX_STREAM_BYTES }).toString('utf8');
}
