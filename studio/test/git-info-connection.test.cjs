'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {getGitInfo}=require('../agent/plugins.cjs');
test('GitHub App Connection is reported even without a git repository',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reach-git-info-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const settings={plugins:{github:{enabled:true,accessToken:'fixture-token',username:'fixture-user'}}};
 for(const target of [dir,path.join(dir,'missing'),'']){
  const info=getGitInfo(target,settings);
  assert.equal(info.isGit,false);assert.equal(info.githubConnected,true);assert.equal(info.githubUser,'fixture-user');
  assert.equal(JSON.stringify(info).includes('fixture-token'),false);
 }
 assert.equal(getGitInfo(dir,{plugins:{github:{...settings.plugins.github,enabled:false}}}).githubConnected,false);
});
