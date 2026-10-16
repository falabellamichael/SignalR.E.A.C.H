'use strict';
async function renderProviders() {
    const providers = await window.providerAccounts.list();
    const list = document.getElementById('providers');
    for (const provider of providers) {
        const row = document.createElement('div'); row.className = 'provider';
        const details = document.createElement('div');
        const name = document.createElement('div'); name.className = 'name'; name.textContent = provider.name;
        const domain = document.createElement('div'); domain.className = 'domain'; domain.textContent = new URL(provider.url).hostname;
        details.append(name, domain);
        const button = document.createElement('button'); button.textContent = 'Open sign-in';
        button.addEventListener('click', async () => {
            button.disabled = true;
            try {
                const result = await window.providerAccounts.open(provider.id);
                document.getElementById('status').textContent = result.error || 'Finish signing in to ' + provider.name + ' in its provider window.';
            } finally { button.disabled = false; }
        });
        row.append(details, button); list.append(row);
    }
}
renderProviders().catch(() => { document.getElementById('status').textContent = 'Provider accounts could not load. Close and reopen this setup window.'; });
