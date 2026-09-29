#!/usr/bin/env python3
"""Bundle all six website pages into one portable, offline HTML preview."""
import json, re, sys
from pathlib import Path
from urllib.parse import quote
ROOT=Path(__file__).resolve().parents[1]
out=Path(sys.argv[1]) if len(sys.argv)>1 else ROOT.parent/'SignalREACH-preview.html'
keys=['index','platform','integrations','docs','about','download']
pages={}
for key in keys:
 text=(ROOT/f'{key}.html').read_text(encoding='utf-8')
 pages[key]={'body':re.search(r'<body[^>]*>(.*)</body>',text,re.S).group(1),'title':re.search(r'<title>(.*?)</title>',text,re.S).group(1),'classes':'home-page' if key=='index' else 'subpage'}
router=r'''
(() => {
  const PAGES=__PAGES__;
  const api={route:{page:'index',search:'',section:''}};
  let currentSignature='';
  const signature=r=>r.page+'|'+r.search+'|'+r.section;
  function toHash(route){
    const params=new URLSearchParams(route.search);
    if(route.section)params.set('section',route.section);else params.delete('section');
    return '#/'+route.page+(params.size?'?'+params.toString():'');
  }
  function readHash(){
    if(!location.hash.startsWith('#/'))return null;
    const [key,search='']=location.hash.slice(2).split('?');
    const page=Object.hasOwn(PAGES,key)?key:'index';
    const params=new URLSearchParams(search);const section=params.get('section')||'';params.delete('section');
    return {page,search:params.size?'?'+params.toString():'',section};
  }
  function writeHash(route){try{history.pushState(null,'',toHash(route));}catch(_){/* Sandboxed previews can still navigate in memory. */}}
  api.setSection=section=>{api.route.section=section;currentSignature=signature(api.route);writeHash(api.route);};
  function render(route,write=false,focus=false){
    if(!Object.hasOwn(PAGES,route.page))return;
    window.SignalREACH?.destroy();
    document.querySelectorAll('dialog[open]').forEach(d=>d.close());
    api.route={...route};currentSignature=signature(route);
    const page=PAGES[route.page];
    document.body.innerHTML=page.body;
    document.body.className=page.classes;
    document.body.dataset.page=route.page;
    document.body.style.overflow='';
    document.title=page.title;
    if(write)writeHash(route);
    window.SignalREACH?.init();
    window.scrollTo({top:0,behavior:'instant'});
    if(focus){const h1=document.querySelector('h1');if(h1){h1.tabIndex=-1;h1.focus({preventScroll:true});}}
  }
  document.addEventListener('click',event=>{
    if(event.defaultPrevented || event.button!==0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)return;
    const link=event.target.closest?.('a[href]');if(!link || link.target==='_blank' || link.hasAttribute('download'))return;
    const href=link.getAttribute('href');
    if(href==='#main'||href==='#top'){
      event.preventDefault();const node=document.querySelector(href);node?.scrollIntoView({behavior:document.documentElement.dataset.motion==='off'?'instant':'smooth'});
      if(href==='#main'){node.tabIndex=-1;node.focus({preventScroll:true});}return;
    }
    if(!/^(index|platform|integrations|docs|about|download)\.html(?:[?#].*)?$/.test(href))return;
    const url=new URL(href,'https://signalreach-preview.invalid/');
    const page=url.pathname.slice(1).replace('.html','');
    event.preventDefault();event.stopImmediatePropagation();
    render({page,search:url.search,section:url.hash.slice(1)},true,true);
  },true);
  function onHistory(){const route=readHash();if(route&&signature(route)!==currentSignature)render(route);}
  window.addEventListener('popstate',onHistory);window.addEventListener('hashchange',onHistory);
  window.SignalREACHPreview=api;
  render(readHash()||{page:'index',search:'',section:''});
})();
'''.replace('__PAGES__',json.dumps(pages,ensure_ascii=False).replace('</','<\\/'))
text=(ROOT/'index.html').read_text(encoding='utf-8')
text=text.replace('<link rel="stylesheet" href="assets/styles.css">','<style>'+ (ROOT/'assets/styles.css').read_text(encoding='utf-8')+'</style>')
text=text.replace('<script src="assets/theme.js"></script>','<script>'+ (ROOT/'assets/theme.js').read_text(encoding='utf-8')+'</script>')
text=text.replace('<script src="assets/data.js" defer></script>','').replace('<script src="assets/app.js" defer></script>','')
svg=(ROOT/'assets/favicon.svg').read_text(encoding='utf-8')
text=text.replace('href="assets/favicon.svg"','href="data:image/svg+xml,'+quote(svg,safe='')+'"')
script='\n'+(ROOT/'assets/data.js').read_text(encoding='utf-8')+'\n'+router+'\n'+(ROOT/'assets/app.js').read_text(encoding='utf-8')
text=text.replace('</body>','<script>'+script+'</script></body>')
out.write_text(text,encoding='utf-8')
print(f'Bundled six pages into {out} ({out.stat().st_size:,} bytes)')
