'use strict';
/* CLI timing/care semantics; artwork is generated directly from pet_pixels.py. */
(() => {
  const names = { cat: 'Cat', owl: 'Owl', bulldog: 'Micro bulldog' };
  const status = { idle:"I'm ready", typing:"I'm listening...", waiting:"I'm working on it...", thinking:"I'm thinking...", responding:"I'm answering...", searching:"I'm searching...", reading:"I'm reading...", writing:"I'm editing files...", running:"I'm running a command...", checking:"I'm checking...", blocked:'I need your help', complete:"I'm done!", error:'I hit a snag', cancelled:"I've stopped" };
  const transient = { typing:1.2, complete:3.2, error:2.4, cancelled:2.4 };
  const reactions = { feed:6.4, pet:3.2, treat:3.2, forgive:4, refuse_food:2.4, refuse_pet:2.4 };
  const ease = x => { x = Math.max(0,Math.min(1,x)); return x*x*(3-2*x); };
  function animation(activity,t) {
    if (activity === 'waiting') {
      const p=t%14;
      return p<1?['curious',0,1]:p<5?['walking_to_bowl',ease((p-1)/4),1]:p<8?['snacking',1,1]:p<12?['walking_back',1-ease((p-8)/4),-1]:['resting',0,-1];
    }
    const direct={typing:'typing',thinking:'pondering',responding:'speaking',searching:'searching',reading:'reading',writing:'working',running:'working',checking:'working',error:'settling',cancelled:'resting',blocked:'resting'};
    if (activity==='complete') return ['celebrating',.35+.06*Math.sin(t*5),1];
    if (direct[activity]) return [direct[activity],.12,1];
    const p=t%24;
    return p<4?['looking',.12,1]:p<7?['grooming',.12,1]:p<9?['stretching',.12,1]:p<13?['sleeping',.12,1]:p<16?['curious',.12,1]:p<20?['strolling',.12+.5*ease((p-16)/4),1]:['strolling',.62-.5*ease((p-20)/4),-1];
  }
  class Pet {
    constructor(clock=()=>performance.now()/1000) { this.clock=clock;this.kind='cat';this.activity='idle';this.changed=clock();this.lastTyped=null;this.states={};this.select('cat'); }
    select(kind) { if (!names[kind]) return;this.kind=kind;this.states[kind] ||= {attention:this.clock(),angry:false,treats:0,reaction:'',at:this.clock()}; }
    setActivity(activity) {
      if (!status[activity]) activity='idle';
      const now=this.clock();
      const expired=transient[this.activity] && now-(this.activity==='typing'?this.lastTyped:this.changed)>=transient[this.activity];
      if(this.activity!==activity || expired) {
        if(['complete','error','cancelled','blocked'].includes(activity)) Object.values(this.states).forEach(s=>s.reaction='');
        this.activity=activity;this.changed=now;
      }
      if(activity==='typing') this.lastTyped=now;
    }
    care(action) {
      if(!['feed','pet','treat'].includes(action)) return;
      this.snapshot();const s=this.states[this.kind];const now=this.clock();
      let reaction=action;
      if(s.angry && action!=='treat') reaction=action==='feed'?'refuse_food':'refuse_pet';
      else if(s.angry) { if(--s.treats===0) {s.angry=false;s.attention=now;reaction='forgive';} }
      else s.attention=now;
      s.reaction=reaction;s.at=now;
      return this.snapshot();
    }
    snapshot(motion=true) {
      const now=this.clock(),s=this.states[this.kind];
      if(!s.angry && now-s.attention>=600) {s.angry=true;s.treats=3;}
      let activity=this.activity,t=Math.max(0,now-this.changed);
      const age=now-(activity==='typing'?this.lastTyped:this.changed);
      if(transient[activity] && age>=transient[activity]) { t=age-transient[activity];activity='idle'; }
      let [behavior,position,direction]=animation(activity,t);
      let food=behavior==='snacking'?Math.max(1,3-Math.trunc((t%14-5))):3;
      const mood=s.angry?'angry':now-s.attention>=300?'lonely':'content';
      const reaction=now-s.at<(reactions[s.reaction]||0)?s.reaction:'';
      if(reaction) {
        t=now-s.at;food=3;
        if(reaction==='feed') {
          if(t<1.6) {behavior='walking_to_bowl';position=t/1.6;direction=1;}
          else if(t<4.8) {behavior='snacking';position=1;direction=1;food=Math.max(1,3-Math.trunc(t-1.6));}
          else {behavior='walking_back';position=Math.max(0,1-(t-4.8)/1.6);direction=-1;}
        } else {behavior=({pet:'petting',treat:'treating',forgive:'forgiving',refuse_food:'refusing',refuse_pet:'refusing'})[reaction];position=.12;direction=1;}
      } else if(mood==='angry' && ['idle','waiting'].includes(activity)) {behavior='sulking';position=.12;direction=-1;}
      let frame=Math.trunc((t+1e-9)/.16)%8;
      if(!motion) {behavior='looking';position=.12;direction=1;frame=0;}
      let care='';
      if(reaction==='feed') care='Dinner! Thank you.';
      else if(reaction==='pet') care=({cat:'Prrrr... more please!',owl:'Happy hoots!',bulldog:'Happy snuffles!'})[this.kind];
      else if(reaction==='forgive') care='I forgive you!';
      else if(mood==='angry') care=(({refuse_food:'No food!',refuse_pet:'No pats!',treat:'Still grumpy'})[reaction]||"I'm angry")+' · /treat x'+s.treats;
      else if(reaction==='treat') care="Yum! You're my favorite.";
      else if(mood==='lonely') care='I miss you · /feed /pat';
      return {kind:this.kind,activity,behavior,position,direction,frame,food,mood,status:care?(['idle','typing'].includes(activity)?care:status[activity]+' · '+care):status[activity]};
    }
  }
  function pixels(state) {
    const key=`${state.behavior}/${state.mood==='angry'?1:0}/${state.frame}/${state.direction}/${state.behavior==='snacking'?state.food:3}`;
    const frames=window.ReachCliPetFrames[state.kind][key];
    const packed=atob(frames[Math.round(state.position*(frames.length-1))]);
    const dots=[];const bits=[[1,8],[2,16],[4,32],[64,128]];
    for(let cy=0;cy<3;cy++) for(let cx=0;cx<22;cx++) for(let dy=0;dy<4;dy++) for(let dx=0;dx<2;dx++) if(packed.charCodeAt(cy*22+cx)&bits[dy][dx]) dots.push([cx*2+dx,cy*4+dy]);
    return dots;
  }
  window.ReachCliPet={Pet,animation,pixels,names};
})();
