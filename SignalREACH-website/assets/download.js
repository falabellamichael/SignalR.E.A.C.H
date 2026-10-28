/* Windows uses Microsoft Store; other installers come from GitHub releases. */
(() => {
  'use strict';
  const windowsStore = 'https://apps.microsoft.com/detail/9P4970CQDV5R';
  const labels = {windows: 'Windows', macos: 'macOS', linux: 'Linux', mobile: 'mobile devices', unknown: 'this device'};
  function detectOS(nav) {
    const ua = nav.userAgent || '';
    if (/Android|iPhone|iPad|iPod/i.test(ua) || (/Mac/i.test(nav.platform || '') && nav.maxTouchPoints > 1)) return 'mobile';
    const platform = nav.userAgentData?.platform || nav.platform || ua;
    if (/Win/i.test(platform)) return 'windows';
    if (/Mac/i.test(platform)) return 'macos';
    if (/Linux|X11/i.test(platform)) return 'linux';
    return 'unknown';
  }
  function installers(release, os) {
    const extensions = {windows: /\.(exe|msi)$/i, macos: /\.dmg$/i, linux: /\.(AppImage|deb|rpm)$/i};
    return (release?.assets || []).filter(asset => extensions[os]?.test(asset.name) &&
      /^https:\/\/github\.com\/falabellamichael\/SignalR\.E\.A\.C\.H\/releases\/download\/[^/]+\/[^/]+$/.test(asset.browser_download_url || ''))
      .sort((a, b) => Number(/suite.*setup/i.test(b.name)) - Number(/suite.*setup/i.test(a.name)) || a.name.localeCompare(b.name));
  }
  function automaticAsset(assets, architecture) {
    // Do not guess between architectures or different Linux package formats.
    const arm = /arm|aarch/i;
    const x86 = /x64|x86|amd64|win64|ia32/i;
    const compatible = assets.filter(a => architecture === 'arm' ? arm.test(a.name) || /universal/i.test(a.name) : !arm.test(a.name));
    if (architecture === 'unknown') return compatible.find(a => /universal/i.test(a.name)) || null;
    const preferred = compatible.filter(a => /suite.*setup.*\.exe$/i.test(a.name));
    if (preferred.length === 1) return preferred[0];
    return compatible.length === 1 && (architecture !== 'arm' || !x86.test(compatible[0].name)) ? compatible[0] : null;
  }
  // Kept as pure helpers so platform/asset selection can be checked without downloads.
  const api = {detectOS, installers, automaticAsset};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document === 'undefined') return;
  const status = document.getElementById('release-status');
  if (!status) return;
  const select = document.getElementById('download-os');
  const links = document.getElementById('release-downloads');
  const retry = document.getElementById('release-retry');
  const version = document.getElementById('release-version');
  const detected = detectOS(navigator);
  select.value = detected;
  let release;
  let architecture = /arm|aarch/i.test(navigator.userAgent) ? 'arm' : /Win64|x64|x86_64|amd64/i.test(navigator.userAgent) ? 'x86' : 'unknown';
  let autoPending = new URLSearchParams(location.search).get('auto') === '1';
  // Consume the request in the URL so reloading does not download a second copy.
  if (autoPending) {
    const url = new URL(location.href);
    url.searchParams.delete('auto');
    history.replaceState(history.state, '', url);
  }
  function render() {
    links.replaceChildren();
    const os = select.value;
    if (os === 'windows') {
      retry.hidden = true;
      version.textContent = 'REACH FOR WINDOWS';
      status.textContent = 'Get the Windows version of SignalREACH from Microsoft Store.';
      const link = document.createElement('a');
      link.className = 'btn btn-primary';
      link.href = windowsStore;
      link.textContent = 'Get it from Microsoft Store';
      links.append(link);
      if (autoPending && detected === 'windows') {
        autoPending = false;
        link.click();
      }
      autoPending = false;
      return;
    }
    const assets = installers(release, os);
    version.textContent = `Latest release · ${release.tag_name}`;
    if (!assets.length) {
      status.textContent = os === 'mobile' ? 'REACH is a desktop app. Open this page on your computer to download it.' :
        os === 'unknown' ? 'Choose your operating system to see available installers.' :
        `No ${labels[os]} installer is published in this release yet. You can use the source setup guide below or check all releases.`;
      autoPending = false;
      return;
    }
    const preferred = automaticAsset(assets, architecture);
    status.textContent = preferred ? `The latest REACH installer for ${labels[os]} is ready.` : `Choose an installer for your computer. Check the architecture and package format in its filename.`;
    const candidates = preferred ? [preferred] : assets;
    candidates.forEach(asset => {
      const link = document.createElement('a');
      link.className = 'btn btn-primary';
      link.href = asset.browser_download_url;
      link.textContent = preferred ? `Download for ${labels[os]}` : asset.name;
      const size = document.createElement('span');
      size.className = 'small-note installer-name';
      size.textContent = `${asset.name}${asset.size ? ` · ${(asset.size / 1048576).toFixed(0)} MB` : ''}`;
      links.append(link, size);
      if (autoPending && preferred && os === detected) {
        autoPending = false;
        link.click();
        status.textContent = 'Your download has been requested. If it doesn’t start, use the download button below.';
      }
    });
    autoPending = false;
  }
  async function load() {
    if (select.value === 'windows') { render(); return; }
    retry.hidden = true;
    links.replaceChildren();
    status.textContent = 'Checking GitHub for the latest release…';
    try {
      // Client hints distinguish Windows ARM from an emulated x64 user agent.
      if (navigator.userAgentData?.getHighEntropyValues) {
        try {
          const hint = await Promise.race([navigator.userAgentData.getHighEntropyValues(['architecture', 'bitness']), new Promise(resolve => setTimeout(() => resolve({}), 1500))]);
          if (/arm/i.test(hint.architecture)) architecture = 'arm';
          else if (/x86/i.test(hint.architecture)) architecture = hint.bitness === '64' ? 'x86' : 'unknown';
        } catch (_) { /* Use conservative user-agent detection. */ }
      }
      const response = await fetch('https://api.github.com/repos/falabellamichael/SignalR.E.A.C.H/releases/latest', {headers: {Accept: 'application/vnd.github+json'}, signal: AbortSignal.timeout(10000)});
      if (!response.ok) throw new Error('Release lookup failed');
      release = await response.json();
      if (!release.tag_name || !Array.isArray(release.assets) || release.draft || release.prerelease) throw new Error('Invalid release');
      render();
    } catch (_) {
      if (select.value === 'windows') { render(); return; }
      autoPending = false;
      version.textContent = 'REACH releases';
      status.textContent = 'We couldn’t check the latest release. Try again, or open GitHub releases below to download directly.';
      retry.hidden = false;
    }
  }
  select.addEventListener('change', () => {
    autoPending = false;
    if (select.value === 'windows' || release) render();
    else load();
  });
  retry.addEventListener('click', load);
  load();
})();
