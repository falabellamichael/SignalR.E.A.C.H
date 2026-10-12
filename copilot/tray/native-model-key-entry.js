'use strict';
// Standalone native enrollment: no renderer, HTTP service, relay/admin lookup,
// account change, provider request or tray lifecycle operation.
const { app, safeStorage, dialog } = require('electron');
const path = require('node:path');
const { createModelCredentialStore, credentialOrigin } = require('./model-credentials');
const { promptForModelKey } = require('./native-model-key');
app.setPath('userData', path.join(app.getPath('appData'), 'signalreach-copilot-tray'));
app.whenReady().then(async () => {
    try {
        const index = process.argv.indexOf('--origin');
        const origin = credentialOrigin(index < 0 ? '' : process.argv[index + 1]);
        const store = createModelCredentialStore({
            file: path.join(app.getPath('appData'), 'signalreach-copilot-tray', 'model-discovery-key.json'),
            safeStorage, prompt: promptForModelKey
        });
        const saved = await store.promptForOrigin(origin);
        if (saved) dialog.showMessageBoxSync({ type: 'info', title: 'SignalREACH', message: 'The model-discovery key was encrypted and saved locally.', detail: 'Activation in the running tray is still pending. No real model or chat request was made by this key-entry window.' });
        app.exit(saved ? 0 : 2);
    } catch (_) {
        dialog.showErrorBox('SignalREACH', 'Secure key entry could not complete. No plaintext key was saved.');
        app.exit(1);
    }
});
