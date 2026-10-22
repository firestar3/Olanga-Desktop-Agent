'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function fixture({reduced=false}={}){
 const node=(...initial)=>{const values=new Set(initial);return {offsetWidth:100,classList:{add:(...names)=>names.forEach(n=>values.add(n)),remove:(...names)=>names.forEach(n=>values.delete(n)),contains:name=>values.has(name)}};};
 const setup=node('hidden'),main=node('hidden'),settings=node(),home=node(),nav=node('visible');let seq=0;
 const timers=new Map(),all=[];
 const context=vm.createContext({setupScreen:setup,mainScreen:main,screens:{mainScreen:main,settingsScreen:settings},floatingIcons:[home],
 document:{querySelector:selector=>selector==='.floating-icons'?nav:home},
 clearTimeout:id=>timers.delete(id),window:{matchMedia:()=>({matches:reduced}),setTimeout:(fn,ms)=>{const timer={id:++seq,fn,ms};all.push(timer);timers.set(timer.id,timer);return timer.id;}}});
 const source=fs.readFileSync(path.join(__dirname,'../../js/settings.js'),'utf8');
 vm.runInContext(source.slice(source.indexOf('const SETUP_INTRO_MS ='),source.indexOf('// Loads keys from the secure store')),context);
 return {context,setup,main,settings,all,timers,play:()=>context.playSetupIntroReplay()};
}
test('intro replay keeps its replay presentation mode until completion',()=>{
 const f=fixture();f.play();assert.equal(f.setup.classList.contains('setup-intro-replay'),true);assert.equal(f.settings.classList.contains('hidden'),true);
 f.all.find(t=>t.ms===7200).fn();assert.equal(f.setup.classList.contains('hidden'),true);assert.equal(f.main.classList.contains('hidden'),false);
});
test('an intro completion after another screen opens cannot force Home',()=>{
 const f=fixture();f.play();const finish=f.all.find(t=>t.ms===7200).fn;
 f.setup.classList.add('hidden');f.settings.classList.remove('hidden');finish();
 assert.equal(f.settings.classList.contains('hidden'),false);assert.equal(f.main.classList.contains('hidden'),true);
});
test('queued callbacks from an earlier replay cannot finish or advance a replacement replay',()=>{
 const f=fixture();f.play();const previous=[...f.all];f.play();
 for(const timer of previous)timer.fn();
 assert.equal(f.setup.classList.contains('hidden'),false);assert.equal(f.main.classList.contains('hidden'),true);
 assert.equal(f.setup.classList.contains('setup-intro-done'),false);
 f.all.at(-1).fn();assert.equal(f.main.classList.contains('hidden'),false);
});
test('reduced-motion replay completes without retaining a return timer',()=>{
 const f=fixture({reduced:true});f.play();f.all.find(t=>t.ms===700).fn();
 assert.equal(f.setup.classList.contains('hidden'),true);assert.equal(f.main.classList.contains('hidden'),false);
 assert.equal([...f.timers.values()].filter(t=>t.ms===700).length,0);
});
