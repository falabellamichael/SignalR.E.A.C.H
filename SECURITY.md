# Security

## Reporting a vulnerability

Do not publish keys, private prompts, exploit payloads with live credentials, or
user-data files in a public issue. If GitHub private vulnerability reporting is
enabled, use the repository's **Security → Report a vulnerability** flow.
Otherwise contact the maintainer privately at the address in
[`studio/package.json`](studio/package.json) to arrange secure disclosure.
Include the affected version, platform, a minimal reproduction with dummy data,
and the impact. No response-time or supported-version guarantee is published.

## Trust boundaries

- The relay requires configured API-key authentication, supports IP allow/block
  lists and failed-authentication lockout. A rotating tunnel URL is discovery,
  not authorization. Keep keys private and rotate exposed credentials.
- Studio can read and edit the selected project and execute tools with the
  user's configured permissions. Human approval, edit review and the optional
  command sandbox are code-enforced controls. Turning off review or selecting
  automatic approval intentionally grants broader authority.
- Project files, websites, provider responses and retrieved snippets are
  untrusted. Prompt delimiters help distinguish data from instructions but are
  **not** a security sandbox or a guarantee against prompt injection.
- Embedded browser pages are isolated from Studio's privileged preload bridge.
  IPC inputs still require validation; the manifest checks channel coverage,
  not complete input safety. The open audit is in `docs/STUDIO_IPC.md`.

## Credentials and local data

Studio stores connection keys using Electron `safeStorage` when a system vault
is available. Linux `basic_text` is treated as unavailable. In that case Settings
shows an explicit warning and keys remain plaintext in an owner-only settings
file. Unlock failures prevent settings writes rather than erase saved keys.
Keys are decrypted in memory for the current application session; this does not
protect against malware running as your user, privileged processes, or a
compromised Studio renderer with access to settings.

The first settings migration retains `settings.json.bak`. With an available
vault it is an `{encryptedSettings: base64}` envelope containing the original
JSON, decryptable through the same OS account's `safeStorage`. Without a vault
it is plaintext with owner-only permissions and is upgraded on a later successful
encryption migration. Do not publish either file. Moving encrypted settings to
another account/machine may require re-entering credentials.

Conversations, attachments, tool output, diagnostic logs, and exported chat files
are **not encrypted by this change** and may contain sensitive material. The
Copilot shim's token file is permission-restricted but not OS-vault-encrypted.
Review backups and exports before sharing. Prefer full-disk encryption and a
locked OS account for local protection.
