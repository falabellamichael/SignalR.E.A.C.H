import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const theme = await readFile(new URL('../assets/theme.js', import.meta.url), 'utf8');
const download = await readFile(new URL('../assets/download.js', import.meta.url), 'utf8');
const exports = {exports: {}};
vm.runInNewContext(download, {module: exports});
const {detectOS, installers, automaticAsset} = exports.exports;
function visit(url, stored = new Map(), blocked = false) {
  let target;
  const location = new URL(url);
  location.replace = value => { target = value; };
  vm.runInNewContext(theme, {document: {documentElement: {dataset: {}}}, matchMedia: () => ({matches: false}), location, URL,
    localStorage: {getItem: key => stored.get(key), setItem: (key, value) => { if (blocked) throw Error(); stored.set(key, value); }}});
  return target;
}
test('homepage introduction appears once and preserves deep links and blocked storage', () => {
  const stored = new Map();
  assert.equal(visit('https://example.com/', stored), 'https://example.com/welcome.html');
  assert.equal(visit('https://example.com/index.html', stored), undefined);
  for (const path of ['subscription.html', 'login.html?next=profile', 'index.html#workspace', '?ref=campaign', 'SignalREACH-preview.html'])
    assert.equal(visit(`https://example.com/${path}`), undefined);
  assert.equal(visit('https://example.com/', new Map(), true), undefined);
  assert.equal(visit('file:///example/index.html'), undefined);
  const direct = new Map();
  visit('https://example.com/welcome.html', direct);
  assert.equal(visit('https://example.com/', direct), undefined);
});
test('desktop and mobile detection includes iPad desktop mode', () => {
  assert.equal(detectOS({platform: 'Win32'}), 'windows');
  assert.equal(detectOS({platform: 'MacIntel'}), 'macos');
  assert.equal(detectOS({platform: 'Linux x86_64'}), 'linux');
  assert.equal(detectOS({platform: 'MacIntel', maxTouchPoints: 5}), 'mobile');
  assert.equal(detectOS({platform: 'Linux', userAgent: 'Android'}), 'mobile');
  assert.equal(detectOS({}), 'unknown');
});
const asset = name => ({name, browser_download_url: `https://github.com/falabellamichael/SignalR.E.A.C.H/releases/download/v1/${name}`});
const setup = asset('SignalREACH.Suite.Setup.1.exe');
test('release matching excludes source/metadata, untrusted URLs and incompatible architectures', () => {
  const release = {assets: [asset('payload-manifest.json'), asset('Studio.appx'), setup, asset('REACH-arm64.exe'),
    {...asset('other.exe'), browser_download_url: 'https://example.com/other.exe'}]};
  const available = installers(release, 'windows');
  assert.equal(available.length, 2);
  assert.equal(automaticAsset(available, 'x86'), setup);
  assert.equal(automaticAsset(available, 'arm').name, 'REACH-arm64.exe');
  assert.equal(automaticAsset([setup], 'arm'), null);
  assert.equal(automaticAsset([setup], 'unknown'), null);
  assert.equal(installers(release, 'macos').length, 0);
  assert.equal(automaticAsset([asset('reach.deb'), asset('reach.rpm')], 'x86'), null);
});
async function page({auto = false, failure = false, platform = 'Win32', assets = [setup]} = {}) {
  const nodes = new Map();
  let clicks = 0, fetches = 0;
  const makeNode = () => ({children: [], textContent: '', hidden: false, value: '', addEventListener(type, fn) { this[type] = fn; },
    append(...items) { this.children.push(...items); }, replaceChildren() {this.children = [];}, click() { clicks++; }});
  const document = {getElementById(id) {if (!nodes.has(id)) nodes.set(id, makeNode()); return nodes.get(id);}, createElement: makeNode};
  let rewritten;
  vm.runInNewContext(download, {document, navigator: {platform, userAgent: platform === 'Win32' ? 'Windows NT 10.0; Win64; x64' : 'Linux x86_64'},
    location: {href: `https://example.com/download.html${auto ? '?auto=1' : ''}`, search: auto ? '?auto=1' : ''},
    history: {replaceState: (_, __, url) => { rewritten = String(url); }}, URL, URLSearchParams, AbortSignal,
    fetch: async () => { fetches++; return {ok: !failure, json: async () => ({tag_name: 'v1', assets})}; }});
  await new Promise(resolve => setImmediate(resolve));
  return {nodes, clicks, rewritten, fetches};
}
test('Windows cover arrival opens Microsoft Store once without contacting GitHub', async () => {
  const automatic = await page({auto: true});
  assert.equal(automatic.clicks, 1);
  assert.equal(automatic.rewritten, 'https://example.com/download.html');
  assert.match(automatic.nodes.get('release-status').textContent, /Microsoft Store/);
  assert.equal(automatic.nodes.get('release-downloads').children[0].href, 'https://apps.microsoft.com/detail/9P4970CQDV5R');
  assert.equal(automatic.fetches, 0);
  assert.equal((await page({failure: true})).nodes.get('release-retry').hidden, true);
  assert.equal((await page()).clicks, 0);
});
test('GitHub failure leaves a visible recovery path without starting a download', async () => {
  const result = await page({auto: true, failure: true, platform: 'Linux x86_64'});
  assert.equal(result.clicks, 0);
  assert.equal(result.nodes.get('release-retry').hidden, false);
  assert.match(result.nodes.get('release-status').textContent, /couldn’t check/);
});

test('other desktop platforms retain automatic GitHub installer downloads', async () => {
  const installer = asset('REACH-x64.AppImage');
  const result = await page({auto: true, platform: 'Linux x86_64', assets: [installer]});
  assert.equal(result.clicks, 1);
  assert.equal(result.fetches, 1);
  assert.equal(result.nodes.get('release-downloads').children[0].href, installer.browser_download_url);
});

const welcomeAccount = await readFile(new URL('../assets/welcome-account.js', import.meta.url), 'utf8');
function accountHints({session = null, known = false, blocked = false} = {}) {
  const nodes = new Map(['welcome-account','welcome-account-title','welcome-signin','welcome-profile'].map(id => [id, {}]));
  const persistent = new Map(known ? [['signalreach.account.known', '1']] : []);
  const sessions = new Map(session === null ? [] : [['signalreach.account.session', session]]);
  const events = {};
  vm.runInNewContext(welcomeAccount, {
    document: {getElementById: id => nodes.get(id)},
    sessionStorage: {getItem: key => {if (blocked) throw Error('blocked'); return sessions.get(key);}},
    localStorage: {getItem: key => {if (blocked) throw Error('blocked'); return persistent.get(key);}, setItem: (key,value) => persistent.set(key,value)},
    window: {addEventListener: (event, fn) => {events[event] = fn;}}
  });
  return {nodes, persistent, sessions, events};
}
test('new visitors get Sign Up Today and invalid or unavailable cache never shows an account', () => {
  for (const options of [{}, {session: '{broken'}, {session: '{"accessToken":""}'}, {blocked: true}]) {
    const h = accountHints(options);
    assert.equal(h.nodes.get('welcome-account-title').textContent, 'Sign Up Today');
    assert.equal(h.nodes.get('welcome-account').href, 'login.html?subscribe=1');
    assert.equal(h.nodes.get('welcome-profile').hidden, true);
    assert.equal(h.nodes.get('welcome-signin').hidden, false);
  }
});
test('a known account without a session offers Sign In without claiming signed-in access', () => {
  const h = accountHints({known: true});
  assert.equal(h.nodes.get('welcome-account-title').textContent, 'Sign In');
  assert.equal(h.nodes.get('welcome-profile').hidden, true);
});
test('cached sign-in shows Your account and back navigation reflects logout', () => {
  const h = accountHints({session: '{"accessToken":"test-session"}'});
  assert.equal(h.nodes.get('welcome-account-title').textContent, 'Your account');
  assert.equal(h.nodes.get('welcome-account').href, 'profile.html');
  assert.equal(h.nodes.get('welcome-profile').hidden, false);
  assert.equal(h.nodes.get('welcome-signin').hidden, true);
  assert.deepEqual([...h.persistent.entries()], [['signalreach.account.known', '1']]);
  h.sessions.clear(); h.events.pageshow();
  assert.equal(h.nodes.get('welcome-account-title').textContent, 'Sign In');
  assert.equal(h.nodes.get('welcome-profile').hidden, true);
});
