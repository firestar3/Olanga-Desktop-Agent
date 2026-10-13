'use strict';
// Measures the real packaged executable with a disposable profile and silence
// supplied by Chromium's fake capture device. Never opens the physical mic.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn } = require('node:child_process');
const net = require('node:net'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const { percentile } = require('./helpers/latency-stats');
const output = path.join(root, 'build/qa/resources');
fs.mkdirSync(output, {recursive:true});
const label = process.env.OLANGA_BENCH_LABEL || 'current';
assert.match(label,/^[a-z0-9-]+$/i);
const defaultSamples=Number(process.env.OLANGA_BENCH_SAMPLES||20);
const sampleCounts={default:defaultSamples,voiceReady:Number(process.env.OLANGA_BENCH_VOICE_SAMPLES||defaultSamples)};
for(const value of Object.values(sampleCounts)) assert(Number.isInteger(value) && value>=5,'Sample counts must be integers of at least five.');
const exe = path.resolve(root, process.env.OLANGA_BENCH_EXE || 'dist/win-unpacked/Olanga.exe');
const profile = fs.mkdtempSync(path.join(output,label+'-profile-'));
const wave = path.join(profile,'silence.wav');
const wav = Buffer.alloc(44+16000*2*10);
wav.write('RIFF'); wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);
wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);
wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);
wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);fs.writeFileSync(wave,wav);
let child,socket,log='',seq=0;
const started = Date.now();
const pending=new Map(), pause=ms=>new Promise(r=>setTimeout(r,ms));
const report={label,exe,profile,sampleCounts,startedAt:new Date().toISOString(),logicalProcessors:os.availableParallelism(),gpuDisabled:false,sourceCommit:process.env.OLANGA_BENCH_COMMIT || null,syntheticMicrophone:true,physicalMicrophone:false,providerCalls:false,memoryMetrics:{privateMiB:'median private committed memory; not resident RAM',workingSetMiB:'median total working set; shared pages may be counted in multiple processes',privateWorkingSetMiB:'one end-of-phase private resident RAM snapshot, excluding shared pages; CIM runs after CPU sampling'},phases:[]};
async function port(){
 const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const p=server.address().port;await new Promise(r=>server.close(r));return p;
}
function send(method,params={}){
 return new Promise((resolve,reject)=>{
  const id=++seq;
  const timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timed out'))},90000);
  pending.set(id,{resolve:x=>{clearTimeout(timer);resolve(x)},reject:e=>{clearTimeout(timer);reject(e)}});
  socket.send(JSON.stringify({id,method,params}));
 });
}
async function evaluate(expression){
 const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
 if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);
 return r.result?.value;
}
function run(file,args){
 return new Promise((resolve,reject)=>{
 const proc=spawn(file,args,{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
 let text='',errors='';
 proc.stdout.on('data',b=>text+=b);proc.stderr.on('data',b=>errors+=b);
 proc.on('error',reject);proc.on('exit',c=>c===0?resolve(text):reject(Error(errors||'Sampler exited '+c)));
 });
}
// Snapshot only at phase boundaries; no diagnostic polling or animation loop.
function collectRendererState(){
 const rendered=node=>!!node?.getClientRects?.().length && getComputedStyle(node).display!=='none' && getComputedStyle(node).visibility!=='hidden';
 const main=document.getElementById('mainScreen'),canvas=document.getElementById('orbCanvas'),orb=document.getElementById('orb');
 return {
  state:currentState,micMuted:isMicMuted,mic:!!micStream,voskReady:isVoskReady,
  documentHidden:document.hidden,nativeVisibility:window.OlangaVisibility?.isVisible?.() ?? null,heapBytes:performance.memory?.usedJSHeapSize,
  rendering:{
   visibleScreens:[...document.querySelectorAll('.screen')].filter(rendered).map(node=>node.id),
   mainDisplay:main?getComputedStyle(main).display:null,
   canvasRects:canvas?[...canvas.getClientRects()].map(({x,y,width,height})=>({x,y,width,height})):[],
   canvasFrameId:typeof animationFrameId==='undefined'?null:animationFrameId,
   orb:orb?{rendered:rendered(orb),display:getComputedStyle(orb).display,animation:getComputedStyle(orb).animationName}:null,
   runningAnimations:document.getAnimations().filter(animation=>animation.playState==='running' && rendered(animation.effect?.target)).map(animation=>{
    const node=animation.effect.target;
    return {target:node.id||node.className||node.tagName,screen:node.closest('.screen')?.id||null,name:animation.animationName||animation.transitionProperty||null,playState:animation.playState};
   }),
   activeElement:document.activeElement?.id||document.activeElement?.tagName||null,
   visualsPaused:document.body.classList.contains('app-visuals-paused'),
   viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},userAgent:navigator.userAgent
  }
 };
}
function assertPhaseState(name,state){
 if(name.includes('voice-ready')) assert(state.mic && state.voskReady && !state.micMuted, 'Voice input must be ready');
 if(name.includes('muted')) assert(state.micMuted, 'Microphone must be muted');
 if(state.nativeVisibility !== null) assert.equal(state.nativeVisibility,name.startsWith('visible-'), 'Wrong native visibility');
 const expectedScreen=name==='visible-settings'?'settingsScreen':'mainScreen';
 assert.deepEqual(state.rendering.visibleScreens,[expectedScreen],'Wrong screen for '+name+': '+JSON.stringify(state.rendering));
 if(expectedScreen==='settingsScreen') assert.equal(state.rendering.mainDisplay,'none','Main must be hidden while measuring Settings');
 else assert.notEqual(state.rendering.mainDisplay,'none','Main must remain the selected screen');
}
async function performanceSnapshot(){
 const {metrics}=await send('Performance.getMetrics');
 const wanted=new Set(['Timestamp','TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration','LayoutCount','RecalcStyleCount']);
 return Object.fromEntries(metrics.filter(metric=>wanted.has(metric.name)).map(metric=>[metric.name,metric.value]));
}
function performanceDelta(before,after){
 return Object.fromEntries(Object.keys(before).filter(name=>Number.isFinite(before[name]) && Number.isFinite(after[name])).map(name=>[name,after[name]-before[name]]));
}
function collectResumeReadiness(){
 const tracks=micStream?.getAudioTracks?.()||[];
 return {
  ready:!isMicMuted && isVoskReady && !!micStream && audioContext?.state==='running',
  micMuted:isMicMuted,modelReady:isVoskReady,
  modelPresent:typeof voskModel!=='undefined' && !!voskModel,
  modelLoading:typeof voskModelLoadPromise!=='undefined' && !!voskModelLoadPromise,
  recognizerPresent:typeof voskRecognizer!=='undefined' && !!voskRecognizer,
  micPresent:!!micStream,micActive:micStream?.active??null,
  captureReady:!!micStream && micStream.active!==false && tracks.some(track=>track.enabled && track.readyState==='live'),
  audioContextState:audioContext?.state||null
 };
}
function observeResumeStages(stages,state,elapsed){
 for(const [key,ready] of [['modelReadyMs',state.modelReady],['captureReadyMs',state.captureReady],['audioContextRunningMs',state.audioContextState==='running'],['readyMs',state.ready]]){
  if(ready && stages[key]===null) stages[key]=elapsed;
 }
 stages.lastState=state;
}
function phaseSampleCount(name){return name.includes('voice-ready')?sampleCounts.voiceReady:sampleCounts.default;}
const median=a=>[...a].sort((x,y)=>x-y)[Math.floor(a.length/2)];
async function sample(name,settle=8000){
 console.log('Settling '+name);await pause(settle);
 const state=await evaluate('('+collectRendererState.toString()+')()');
 assertPhaseState(name,state);
 const requestedSamples=phaseSampleCount(name);
 const performanceBefore=await performanceSnapshot();
 const text=await run(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'tests/resource-sample.ps1'),'-Executable',exe,'-Samples',String(requestedSamples)]);
 const performanceAfter=await performanceSnapshot();
 const stateAfter=await evaluate('('+collectRendererState.toString()+')()');
 assertPhaseState(name,stateAfter);
 // CDP deltas include sampler startup and the existing end-of-phase CIM query;
 // CPU and resident-memory metrics still come from the unchanged OS sampler.
 const rendererPerformance={before:performanceBefore,after:performanceAfter,delta:performanceDelta(performanceBefore,performanceAfter)};
 const raw=JSON.parse(text.replace(/^\uFEFF/,''));
 assert(raw.samples.length >= 5, 'Too few process samples');
 for (const row of raw.samples) assert(row.processes.every(p => Number.isFinite(p.cpuSeconds)), 'Missing CPU counters');
 const privateSnapshot=raw.privateWorkingSetSnapshot;
 assert(privateSnapshot && Number.isFinite(privateSnapshot.privateWorkingSetBytes) && privateSnapshot.privateWorkingSetBytes >= 0, 'Missing private resident RAM snapshot');
 assert(privateSnapshot.processes.length > 0 && privateSnapshot.processes.every(p => Number.isFinite(p.privateWorkingSetBytes) && p.privateWorkingSetBytes >= 0), 'Incomplete private resident RAM counters');
 assert.equal(privateSnapshot.privateWorkingSetBytes,privateSnapshot.processes.reduce((sum,p)=>sum+p.privateWorkingSetBytes,0),'Private resident RAM total does not match process counters');
 const prior=new Map();let previousElapsed=null; for(const item of raw.samples){let used=0;for(const proc of item.processes){if(prior.has(proc.pid))used+=Math.max(0,proc.cpuSeconds-prior.get(proc.pid));prior.set(proc.pid,proc.cpuSeconds)}item.cpuCorePercent=previousElapsed===null?0:100*used/(item.elapsed-previousElapsed);previousElapsed=item.elapsed;} raw.samples.shift();
 const summary={cpuP50:percentile(raw.samples.map(s=>s.cpuCorePercent),.5),cpuP95:percentile(raw.samples.map(s=>s.cpuCorePercent),.95),workingSetP95MiB:percentile(raw.samples.map(s=>s.workingSetBytes),.95)/1048576,privateMiB:median(raw.samples.map(s=>s.privateBytes))/1048576,workingSetMiB:median(raw.samples.map(s=>s.workingSetBytes))/1048576,privateWorkingSetMiB:privateSnapshot.privateWorkingSetBytes/1048576,cpuCorePercent:raw.samples.reduce((a,s)=>a+s.cpuCorePercent,0)/raw.samples.length,processCount:raw.samples[0].processes.length};
 report.phases.push({name,requestedSamples,measuredIntervals:raw.samples.length,state,stateAfter,rendererPerformance,summary,...raw});
 fs.writeFileSync(path.join(output,label+'.json'),JSON.stringify(report,null,2));
 console.log(name+': '+JSON.stringify(summary));
}
(async()=>{
 try{
 const debugPort=await port(),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 child=spawn(exe,['--hidden','--user-data-dir='+profile,'--remote-debugging-address=127.0.0.1','--remote-debugging-port='+debugPort,'--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--use-file-for-fake-audio-capture='+wave],{windowsHide:true,stdio:['ignore','pipe','pipe'],env});
 child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
 let target;
 for(let i=0;i<180;i++){try{target=(await(await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json()).find(t=>/app\.asar[\\/]index\.html$/.test(t.url))}catch{}if(target&&log.includes(profile))break;await pause(200)}
 assert(target?.webSocketDebuggerUrl,'No isolated packaged renderer');
 socket=new WebSocket(target.webSocketDebuggerUrl);
 await new Promise((r,j)=>{socket.addEventListener('open',r,{once:true});socket.addEventListener('error',j,{once:true})});
 socket.addEventListener('message',e=>{const m=JSON.parse(String(e.data)),p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)});
 await send('Network.enable');await send('Network.setBlockedURLs',{urls:['http://*','https://*']});
 for(let i=0;i<100;i++){if(await evaluate("document.readyState==='complete' && typeof initVosk==='function' && !!window.OlangaWorkspace && !!window.electronAPI"))break;await pause(150)}
 report.startupReadyMs=Date.now()-started;
 report.version=await evaluate('window.electronAPI.getAppInfo()');
 await send('Performance.enable');
 await evaluate("document.getElementById('startLocalBtn').click(); muteTts(); window.electronAPI.expandWindow(); void 0");
 await sample('visible-idle');
 await evaluate("document.querySelector('[data-screen=settingsScreen]').click(); void 0");
 await sample('visible-settings');
 await evaluate("document.querySelector('[data-screen=mainScreen]').click(); void 0");
 await evaluate('window.electronAPI.close(); void 0');
 await sample('tray-idle');
 await evaluate('(async()=>{await initVosk();await initMicrophone();window.electronAPI.expandWindow();return {ready:isVoskReady,mic:!!micStream}})()');
 await sample('visible-voice-ready',12000);
 await evaluate('window.electronAPI.close(); void 0');
 await sample('tray-voice-ready');
 await evaluate('muteMic(); void 0');
 await sample('tray-muted',18000);
 await evaluate('window.electronAPI.expandWindow(); void 0');
 await sample('visible-muted');
 report.coldVoiceResumeSamples=[];
 report.coldVoiceResumeStages=[];
 const repetitions=Math.max(3,Math.min(10,Number(process.env.OLANGA_BENCH_RESUME_REPS)||3));
 for(let repetition=0;repetition<repetitions;repetition++){
   if(repetition){await evaluate('muteMic(); void 0');await pause(18000);}
   const readinessExpression='('+collectResumeReadiness.toString()+')()';
   const before=await evaluate(readinessExpression);
   const stages={before,modelReadyMs:null,captureReadyMs:null,audioContextRunningMs:null,readyMs:null};
   report.coldVoiceResumeStages.push(stages);
   assert(before.micMuted && !before.modelReady && !before.modelPresent && !before.modelLoading,'Cold resume must start muted with the model unloaded: '+JSON.stringify(before));
   const resumeStarted=Date.now();
   await evaluate('unmuteMic(); void 0');
   stages.unmuteReturnedMs=Date.now()-resumeStarted;
   // Reuse the existing 100 ms poll; timings are first observations, not
   // instrumented model events or measurements of physical microphone audio.
   for(let i=0;i<200;i++){
    const state=await evaluate(readinessExpression);
    observeResumeStages(stages,state,Date.now()-resumeStarted);
    if(state.ready)break;await pause(100);
   }
   const resumed=await evaluate(readinessExpression);
   observeResumeStages(stages,resumed,Date.now()-resumeStarted);
   assert(resumed.ready,'Voice failed to resume after sustained mute');
   report.coldVoiceResumeSamples.push(Date.now()-resumeStarted);
 }
 report.voiceResumeMs=report.coldVoiceResumeSamples[0];
 report.coldVoiceResume={samples:repetitions,p50:percentile(report.coldVoiceResumeSamples,.5),p95:percentile(report.coldVoiceResumeSamples,.95)};
 report.passed=true;
 }catch(e){report.passed=false;report.error=e.stack;console.error(e)}
 finally{
  socket?.close();
  if(child?.pid&&child.exitCode===null){try{await run('taskkill.exe',['/PID',String(child.pid),'/T','/F'])}catch{}}
  report.finishedAt=new Date().toISOString();
  fs.writeFileSync(path.join(output,label+'.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(output,label+'.log'),log);
  process.exitCode=report.passed?0:1;
 }
})();
