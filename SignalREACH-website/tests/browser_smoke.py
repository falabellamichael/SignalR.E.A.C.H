#!/usr/bin/env python3
"""Browser interaction checks for the self-contained preview.
Requires Python Playwright and Chromium. No network navigation is needed.
Usage: python tests/browser_smoke.py [path-to-SignalREACH-preview.html]
Set CHROMIUM_EXECUTABLE when Chromium is not installed in Playwright's cache.
"""
import json, os, sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
ROOT=Path(__file__).resolve().parents[1]
PREVIEW=Path(sys.argv[1]) if len(sys.argv)>1 else ROOT.parent/'SignalREACH-preview.html'
checks=[]
def check(name,condition=True):
    assert condition, name
    checks.append(name)
with sync_playwright() as p:
    executable=os.environ.get('CHROMIUM_EXECUTABLE')
    args={'headless':True}
    if executable: args['executable_path']=executable
    browser=p.chromium.launch(**args)
    page=browser.new_page(viewport={'width':1440,'height':1000},color_scheme='dark',reduced_motion='reduce')
    page.set_default_timeout(5000)
    errors=[]; requests=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.on('request',lambda r:requests.append(r.url))
    page.set_content(PREVIEW.read_text(encoding='utf-8'),wait_until='load')
    def click(selector): page.locator(selector).first.click()
    def route(key):
        if page.viewport_size['width']<800:page.set_viewport_size({'width':1440,'height':1000})
        click(f'a[href="{key}.html"]')
        expect(page.locator('body')).to_have_attribute('data-page',key)
    check('Home initializes',page.locator('h1').count()==1)
    check('Dark theme shows one icon',page.locator('.theme-toggle svg:visible').count()==1)
    click('.theme-toggle');expect(page.locator('html')).to_have_attribute('data-theme','light')
    check('Light theme shows one icon',page.locator('.theme-toggle svg:visible').count()==1)
    click('[data-preview="agents"]');expect(page.locator('#preview-agents')).to_be_visible()
    check('Agent preview tab')
    page.locator('[data-preview="agents"]').press('Home');expect(page.locator('#preview-workspace')).to_be_visible()
    check('Keyboard tab navigation')
    click('[data-file="theme.css"]');expect(page.locator('#editor-code')).to_contain_text('--gold: #d4af37')
    click('[data-file="README.md"]');expect(page.locator('#editor-file-name')).to_have_text('README.md')
    check('Example file switching')
    page.locator('#demo-input').fill('<img src=x onerror="window.xss=true"> Tell me about themes')
    click('#demo-form button');expect(page.locator('#demo-log')).to_have_attribute('aria-busy','false')
    expect(page.locator('#demo-log .chat-message').last).to_contain_text('scripted website demo')
    check('Demo response and escaped prompt',page.evaluate('window.xss !== true') and page.locator('#demo-log img').count()==0)
    for step,expected in [('context','The right files.'),('build','Keep the work moving.')]:
        click(f'[data-step="{step}"]');expect(page.locator('#workflow-panel')).to_contain_text(expected)
    check('Workflow panels')
    for language,expected in [('python','import'),('javascript','fetch'),('curl','curl')]:
        click(f'[data-language="{language}"]');expect(page.locator('#api-example')).to_contain_text(expected)
    check('Three code languages')
    click('[data-copy="api-example"]');expect(page.locator('.toast')).to_have_class('toast visible')
    check('Clipboard action provides feedback')
    click('[data-open-tour]');expect(page.locator('#tour-dialog')).to_be_visible()
    click('[data-tour-next]');expect(page.locator('#tour-title')).to_contain_text('Connect')
    click('[data-tour-next]');expect(page.locator('#tour-title')).to_contain_text('direction')
    page.keyboard.press('Escape');expect(page.locator('#tour-dialog')).not_to_be_visible()
    check('Tour progression and Escape')
    route('platform');expect(page.locator('html')).to_have_attribute('data-theme','light')
    check('Theme retained across routes')
    for key,title in [('relay','Relay & control'),('editor','REACH for VS Code'),('tray','bridge within'),('studio','REACH Studio')]:
        click(f'[data-platform="{key}"]');expect(page.locator('#platform-stage h2')).to_contain_text(title)
    check('All four platform panels')
    route('integrations')
    check('Nine integration cards',page.locator('.integration-card:visible').count()==9)
    click('[data-filter="bridges"]');check('Bridge filter narrows results',0<page.locator('.integration-card:visible').count()<9)
    page.locator('#integration-search').fill('there-is-no-such-provider');expect(page.locator('#integration-empty')).to_be_visible()
    click('#clear-integrations');check('Search empty state and clear',page.locator('.integration-card:visible').count()==9)
    page.locator('#integration-search').fill('Studio');check('Integration search',page.locator('.integration-card:visible').count()==1)
    click('.integration-card:visible [data-integration]');expect(page.locator('#integration-dialog')).to_be_visible()
    page.keyboard.press('Escape');expect(page.locator('#integration-dialog')).not_to_be_visible()
    check('Integration detail dialog')
    route('docs')
    for key in ['studio','endpoint','editor','security','troubleshooting','quickstart']:
        click(f'.docs-nav [data-doc="{key}"]');expect(page.locator(f'.docs-nav [data-doc="{key}"]')).to_have_attribute('aria-current','page')
    check('Six documentation articles')
    page.locator('#docs-search').fill('security');expect(page.locator('.doc-result')).to_have_count(1)
    click('.doc-result');expect(page.locator('#docs-article h2')).to_contain_text('Know what')
    check('Documentation search and navigation')
    route('download')
    for key,title in [('windows','Windows'),('macos','macOS'),('linux','Linux')]:
        click(f'[data-os="{key}"]');expect(page.locator('#os-panel')).to_contain_text(title)
    check('Three operating-system tabs')
    route('index');page.set_viewport_size({'width':390,'height':844})
    click('.menu-toggle');expect(page.locator('.menu-toggle')).to_have_attribute('aria-expanded','true')
    page.keyboard.press('Escape');expect(page.locator('.menu-toggle')).to_have_attribute('aria-expanded','false')
    click('.menu-toggle');click('#primary-nav a[href="platform.html"]');expect(page.locator('body')).to_have_attribute('data-page','platform')
    check('Mobile menu, Escape, and route selection')
    layouts=[]
    for key in ['index','platform','integrations','docs','about','download']:
        route(key)
        for width in [320,390,768,1024,1440]:
            page.set_viewport_size({'width':width,'height':900})
            size=page.evaluate('({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight})')
            check(f'{key}: no overflow at {width}px',size['scrollWidth']<=width)
            layouts.append({'page':key,**size})
    check('Reduced-motion preference honored',page.locator('html').get_attribute('data-motion')=='off')
    check('No browser JavaScript errors',not errors)
    check('No outgoing requests in offline demo',not requests)
    browser.close()
print(json.dumps({'passed':len(checks),'checks':checks,'layouts':layouts,'pageErrors':errors,'requests':requests},indent=2))
