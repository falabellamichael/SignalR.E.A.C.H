import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const root=new URL('../renderer/',import.meta.url);
export default async function(page){
 await page.setContent('<div class="singular-col-info"><div class="singular-github-auth"><span class="conn-badge off">GitHub not connected</span><button class="ghost small">Connect in Plugins / MCP</button></div></div>');
 for(const file of ['styles.css','singular-panel.css'])await page.addStyleTag({content:await fs.readFile(new URL(file,root),'utf8')});
 for(const width of [200,240,337,380]){
  await page.locator('.singular-col-info').evaluate((el,width)=>el.style.width=width+'px',width);
  const result=await page.locator('.singular-github-auth').evaluate(row=>{
   const r=row.getBoundingClientRect();
   return {overflow:row.scrollWidth>row.clientWidth,children:[...row.children].map(el=>{const b=el.getBoundingClientRect();return {inside:b.left>=r.left&&b.right<=r.right&&b.top>=r.top&&b.bottom<=r.bottom,clipped:el.scrollWidth>el.clientWidth};})};
  });
  assert.equal(result.overflow,false,`row overflows at ${width}px`);
  for(const child of result.children){assert.equal(child.inside,true);assert.equal(child.clipped,false);}
 }
 return {githubConnectionRowFits:true,widths:[200,240,337,380]};
}
