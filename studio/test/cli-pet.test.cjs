'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');
const context={window:{},performance:{now:()=>0},atob:s=>Buffer.from(s,'base64').toString('binary')};
for(const name of ['cli-pet-frames.js','cli-pet.js']) vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../renderer',name),'utf8'),context);
const {Pet,pixels}=context.window.ReachCliPet;
test('CLI care rules, transient timing, and species memory',()=>{
  let now=0;const pet=new Pet(()=>now);
  pet.setActivity('waiting');now=6;assert.equal(pet.snapshot().behavior,'snacking');
  pet.setActivity('responding');assert.equal(pet.care('pet').behavior,'petting');assert.equal(pet.snapshot().activity,'responding');
  now=607;assert.equal(pet.snapshot().mood,'angry');assert.equal(pet.care('feed').behavior,'refusing');
  pet.care('treat');pet.care('treat');assert.equal(pet.snapshot().mood,'angry');pet.care('treat');assert.equal(pet.snapshot().behavior,'forgiving');
  pet.setActivity('complete');assert.equal(pet.snapshot().behavior,'celebrating');now+=3.2;assert.equal(pet.snapshot().activity,'idle');
  pet.select('owl');assert.equal(pet.snapshot().mood,'content');assert.equal(pet.snapshot(false).behavior,'looking');
});
test('all generated CLI frame masks decode into bounded original pixels',()=>{
  for(const [kind,entries] of Object.entries(context.window.ReachCliPetFrames)) for(const [key,frames] of Object.entries(entries)) {
    const [behavior,angry,frame,direction,food]=key.split('/');
    for(const position of [0,.5,1]) {
      const dots=pixels({kind,behavior,mood:angry==='1'?'angry':'content',frame:+frame,direction:+direction,food:+food,position});
      assert.ok(dots.length>0,key);assert.ok(dots.every(([x,y])=>x>=0&&x<44&&y>=0&&y<12),key);
    }
    assert.ok(frames.every(f=>Buffer.from(f,'base64').length===66));
  }
});
