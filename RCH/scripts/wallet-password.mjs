import { timingSafeEqual } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { WalletError, validateNewPassword } from './wallet.mjs';

// Passwords are accepted only from a real terminal with echo disabled. Projects'
// captured command logs, pipes, argv, and environment variables are not inputs.
export function hiddenPassword(prompt, { input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw new WalletError('Open macOS Terminal to enter your password privately. This command will not accept a password through Projects logs, pipes, arguments, or chat.');
  }
  return new Promise((resolve, reject) => {
    let characters = [], settled = false;
    const decoder = new StringDecoder('utf8');
    const wasRaw = input.isRaw;
    function finish(error) {
      if (settled) return;
      settled = true;
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onEnd);
      process.off('SIGTERM', onCancel);
      process.off('SIGINT', onCancel);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
      output.write('\n');
      const value = error ? null : Buffer.from(characters.join('').normalize('NFKC'), 'utf8');
      characters = [];
      if (error) reject(error); else resolve(value);
    }
    const onCancel = () => finish(new WalletError('Password entry cancelled; no password change was made.'));
    const onEnd = () => finish(new WalletError('Password entry was interrupted; no password change was made.'));
    function onData(chunk) {
      for (const char of decoder.write(chunk)) {
        if (char === '\r' || char === '\n') { finish(); return; }
        if (char === '\u0003' || char === '\u0004') { onCancel(); return; }
        if (char === '\u007f' || char === '\b') { characters.pop(); continue; }
        if (char === '\u0015') { characters = []; continue; }
        if (/[\p{Cc}\p{Cf}]/u.test(char)) { finish(new WalletError('Use printable characters in the password.')); return; }
        characters.push(char);
        if (Buffer.byteLength(characters.join(''), 'utf8') > 256) { finish(new WalletError('Password must be at most 256 UTF-8 bytes.')); return; }
      }
    }
    input.setRawMode(true);
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onEnd);
    process.once('SIGTERM', onCancel);
    process.once('SIGINT', onCancel);
    input.resume();
    output.write(prompt);
  });
}

export async function choosePassword() {
  const first = await hiddenPassword('Choose your wallet password (12+ characters; typing is hidden): ');
  let second;
  try {
    validateNewPassword(first);
    second = await hiddenPassword('Enter the same password again: ');
    if (first.length !== second.length || !timingSafeEqual(first, second)) throw new WalletError('Passwords do not match; no password change was made.');
    return Buffer.from(first);
  } finally { first.fill(0); second?.fill(0); }
}
