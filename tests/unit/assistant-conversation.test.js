const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
function fixture(){
 const calls={spoken:[],errors:[],media:[],volumes:[],opened:[],used:[]}, data=new Map();
 const store=require('../../shared/productivity').createStore({getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)});
 const el=()=>({textContent:'',classList:{add(){},remove(){}}});
 const window={addEventListener(){},OlangaWorkspace:store,OlangaActivity:store,electronAPI:{mediaControl:async (c,spotify,value)=>{calls.media.push(c);calls.volumes.push(value);return{ok:true,verified:true,message:'Volume is 75%.'};},openApp:async n=>{calls.opened.push(n);return{ok:true,verified:true,message:n+' is open.'};}},OlangaDesktop:{cancel(){}},OlangaMemoryView:{learned(r){calls.learned=r;},used(f){calls.used=f;},lastUsed:()=>calls.used}};
 const context={window,AbortController,DOMException,setTimeout:(...args)=>{const t=setTimeout(...args);t.unref();return t;},clearTimeout,console:{log(){},warn(){},error(){}},OlangaIntents:require('../../shared/fast-intents'),OlangaGemini:require('../../shared/gemini-request'),OlangaTurnLifecycle:require('../../shared/turn-lifecycle'),OlangaTurnCorrections:require('../../shared/turn-corrections'),OlangaMemoryLearning:require('../../shared/memory-learning'),OlangaConversationalControls:require('../../shared/conversational-controls'),apiKey:'',apiKeys:[],apiKeyRotation:false,nvidiaApiKey:'',currentKeyIndex:0,State:{THINKING:'thinking',IDLE:'idle',LISTENING:'listening',SPEAKING:'speaking'},currentState:'idle',isMicMuted:true,micStream:null,hasSpokenDuringRecording:false,activeTasks:[],conversationHistory:[],isRecording:false,followUpTimer:null,userText:el(),aiText:el(),transcriptUser:el(),transcriptAi:el(),hint:el(),userCity:'',userState:'',userCountry:'',setState:s=>context.currentState=s,speakResponse:async t=>{calls.spoken.push(t);return{status:'completed'};},speakResponseAndThen:async(t,cb)=>{calls.spoken.push(t);cb();return{status:'completed'};},showError:t=>calls.errors.push(t)};
 vm.createContext(context);for(const file of ['assistant-controls','assistant'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../../js/'+file+'.js'),'utf8'),context);
 const say=async text=>context.processTextCommandWithGemini(text);
 context.sendTextToGemini=context.callGeminiSpecialist=()=>{throw new Error('Provider is forbidden in this fixture');};
 return{context,calls,store,say};
}
test('normal conversation learns, revises, pauses and undoes memory without a provider',async()=>{
 const {say,store,calls}=fixture();await say('I prefer brief answers.');assert.equal(store.snapshot().facts[0].text,'I prefer concise answers');
 await say('I live in Seattle');const city=store.snapshot().facts.find(f=>f.slot==='city');
 await say('I now live in Boston');assert.equal(store.snapshot().facts.find(f=>f.slot==='city').id,city.id);assert.equal(store.snapshot().facts.find(f=>f.slot==='city').text,'I live in Boston');
 await say('forget what you just learned');assert.equal(store.snapshot().facts.find(f=>f.slot==='city').text,'I live in Seattle');
 await say('pause learning');await say('My favorite color is blue');assert.equal(store.snapshot().facts.some(f=>f.slot==='favorite-color'),false);
 await say('resume learning');await say('My favorite color is blue');assert.equal(store.snapshot().facts.find(f=>f.slot==='favorite-color').text,'My favorite color is blue');assert.deepEqual(calls.opened,[]);
});
test('a manually saved detail needs a spoken replacement answer and keeps its identity',async()=>{
 const {say,store,calls}=fixture();const fact=store.rememberFact('I live in Seattle');await say('I now live in Boston');assert.equal(store.snapshot().facts[0].text,'I live in Seattle');assert.match(calls.spoken.at(-1),/Should I replace/);
 await say('yes');assert.equal(store.snapshot().facts.length,1);assert.equal(store.snapshot().facts[0].id,fact.id);assert.equal(store.snapshot().facts[0].text,'I live in Boston');assert.match(calls.spoken.at(-1),/Updated/);
});
test('declining and cancelling a pending memory replacement never changes the saved detail',async()=>{
 const {context,say,store}=fixture();store.rememberFact('I live in Seattle');await say('I live in Boston');await say('no');assert.equal(store.snapshot().facts[0].text,'I live in Seattle');
 await say('I live in Boston');context.cancelAssistantRequest();await say('yes');assert.equal(store.snapshot().facts[0].text,'I live in Seattle');
});
test('memory selection uses the current question and cannot learn a model response',async()=>{
 const {context,store,calls}=fixture();store.learnFromUserText('I live in Seattle. I prefer jazz music. My favorite color is blue. I prefer brief answers.');
 const facts=context.selectedAssistantMemories('What is the weather near my city?');assert.ok(facts.some(f=>f.text==='I live in Seattle'));assert.ok(facts.some(f=>f.text==='I prefer concise answers'));assert.equal(facts.some(f=>/jazz|blue/.test(f.text)),false);
 const request=context.beginAssistantRequest();await context.finishAssistantTurn('My name is Model Invented. I live in Boston.',false,request);assert.equal(store.snapshot().facts.some(f=>/Model Invented|Boston/.test(f.text)),false);assert.deepEqual(calls.opened,[]);
});
test('forgetting or disabling a consumed memory clears retained and visible repeatable answers',async()=>{
 for(const disable of [false,true]){const {context,store}=fixture();const fact=store.rememberFact('I live in Seattle');const request=context.beginAssistantRequest();context.markMemoryContextUsed([fact.id]);await context.finishAssistantTurn('You live in Seattle.',false,request);assert.equal(context.window.OlangaTurns.snapshot().canRepeatResult,true);
 if(disable)store.preference('factsEnabled',false);else store.deleteFact(fact.id);
 assert.equal(context.window.OlangaTurns.snapshot().canRepeatResult,false);assert.equal(context.window.OlangaTurns.snapshot().resultText,'');await assert.rejects(()=>context.repeatAssistantResult(),/no previous result/i);assert.doesNotMatch(context.aiText.textContent,/Seattle/);}
});
test('forgetting a consumed memory stops its in-flight reply without retaining it on cancellation',async()=>{
 const {context,store}=fixture();const fact=store.rememberFact('I live in Seattle');let finish;
 context.speakResponse=()=>new Promise(resolve=>{finish=resolve;});const request=context.beginAssistantRequest();context.markMemoryContextUsed([fact.id]);const pending=context.finishAssistantTurn('You live in Seattle.',false,request);await new Promise(r=>setImmediate(r));store.deleteFact(fact.id);finish({status:'completed'});await pending;assert.equal(request.signal.aborted,true);await assert.rejects(()=>context.repeatAssistantResult(),/no previous result/i);
});
test('speech failure retains completed actions and repeating the result never dispatches again',async()=>{
 const {context,say,calls}=fixture();context.speakResponse=async t=>{calls.spoken.push(t);return{status:'failed'};};await say('set volume to 75%');const snapshot=context.window.OlangaTurns.snapshot();assert.equal(snapshot.outcome,'completed');assert.equal(snapshot.steps[0].state,'completed');assert.equal(snapshot.speechStatus,'failed');assert.equal(snapshot.canRepeatResult,true);
 context.speakResponse=async t=>{calls.spoken.push(t);return{status:'completed'};};await say('repeat the result');assert.deepEqual(calls.media,['VOLUME_SET']);assert.equal(calls.volumes[0],75);assert.equal(calls.spoken.at(-1),'Volume is 75%.');
});
test('only confirmed unfinished steps enter a fresh review; completed and uncertain effects cannot replay',async()=>{
 const {context}=fixture();let reviewed;context.window.reviewOlangaUnfinished=async record=>{reviewed=record;return{message:'Review opened'};};const request=context.beginAssistantRequest();context.setAssistantPlan(request,['[OPEN_APP: notepad]','[VOLUME_SET: 75]','[OPEN_APP: calculator]','[MEDIA_PAUSE]']);for(const [i,state]of ['completed','uncertain','failed','skipped'].entries())context.updateAssistantStep(request,i,state);request.failed=true;await context.finishAssistantTurn('Some steps did not finish.',false,request);await context.reviewAssistantUnfinished();assert.deepEqual(Array.from(reviewed.steps,s=>s.command),['[OPEN_APP: calculator]','[MEDIA_PAUSE]']);
});
test('a dispatched native failure is uncertain and cannot offer an automatic retry',async()=>{
 const {context,say}=fixture();context.window.electronAPI.openApp=async()=>({ok:false,dispatched:true,pending:true,message:'Windows is still responding.'});await say('open notepad');const snapshot=context.window.OlangaTurns.snapshot();assert.equal(snapshot.steps[0].state,'uncertain');assert.equal(snapshot.canReviewUnfinished,false);
});
test('routine editor voice request uses the exact destination and never dispatches a native command',async()=>{
 const {context,say,calls}=fixture();let opened;context.window.openOlangaRoutineEditor=(name,edit)=>{opened={name,edit};return{message:'Editor open.'};};await say('create a routine named Focus');assert.deepEqual(opened,{name:'Focus',edit:false});assert.deepEqual(calls.opened,[]);assert.deepEqual(calls.media,[]);
});
test('a restore blocks commands and automatic learning until the transaction ends',async()=>{
 const {context,say,store,calls}=fixture();context.window.OlangaBackupCenter={isBusy:()=>true};await say('I live in Seattle');await say('open notepad');assert.equal(store.snapshot().facts.length,0);assert.deepEqual(calls.opened,[]);assert.match(calls.spoken.at(-1),/restore to finish/);
});

test('recognized voice facts learn once and answer locally after final transcription',async()=>{
 const {context,store,calls}=fixture();context.apiKey='fixture';context.blobToBase64=async()=>'';context.transcribeAssistantAudio=async()=> 'I prefer brief answers';await context.processAudioBlobWithGemini({});assert.equal(store.snapshot().facts.length,1);assert.equal(store.snapshot().facts[0].source,'conversation');assert.match(calls.spoken.at(-1),/keep that in mind/i);assert.deepEqual(calls.errors,[]);
});

test('learning a fact never swallows a separate user request in the same turn',async()=>{
 const {context,store,calls,say}=fixture();context.apiKey='fixture';let requests=0;context.sendTextToGemini=async()=>{requests++;return 'RESPONSE: Seattle grew from a port city.';};await say('I live in Seattle. Explain its history');assert.equal(store.snapshot().facts.find(f=>f.slot==='city').text,'I live in Seattle');assert.equal(requests,1);assert.match(calls.spoken.at(-1),/grew from/);
});

test('a conflicting manual fact answers the remaining request before asking for replacement',async()=>{
 const {context,store,calls,say}=fixture();const old=store.rememberFact('I live in Seattle');context.apiKey='fixture';let requests=0;
 context.sendTextToGemini=async()=>{requests++;const memories=context.selectedAssistantMemories('weather in my city');assert.equal(memories.some(f=>f.id===old.id),false);return 'RESPONSE: Boston has a long history.';};
 await say('I live in Boston. Explain its history');assert.equal(requests,1);assert.equal(store.snapshot().facts[0].text,'I live in Seattle');
 assert.match(calls.spoken.at(-1),/^Boston has a long history\.[\s\S]*Should I replace/);assert.equal(context.hasAssistantReview(),true);
 await say('yes');assert.equal(store.snapshot().facts[0].text,'I live in Boston');assert.equal(store.snapshot().facts[0].id,old.id);assert.equal(requests,1);
});

test('a failed mixed answer never opens an unspoken memory confirmation',async()=>{
 const {context,store,calls,say}=fixture();store.rememberFact('I live in Seattle');context.apiKey='fixture';context.sendTextToGemini=async()=>{throw new Error('Fixture: provider unavailable');};
 await say('I live in Boston. Explain its history');assert.equal(context.hasAssistantReview(),false);assert.doesNotMatch(calls.spoken.at(-1),/Should I replace/);
 await say('confirm');assert.match(calls.spoken.at(-1),/no open review/);assert.equal(store.snapshot().facts[0].text,'I live in Seattle');
});

test('a simple city statement cannot replace and discard other details inside one saved memory',async()=>{
 const {context,store,calls,say}=fixture();const text='I live in Seattle. My sister is Priya';store.rememberFact(text);
 await say('I live in Boston');assert.equal(store.snapshot().facts[0].text,text);assert.match(calls.spoken.at(-1),/also contains other details.*kept it intact/);assert.equal(context.hasAssistantReview(),false);
 await say('confirm');assert.equal(store.snapshot().facts[0].text,text);assert.match(calls.spoken.at(-1),/no open review/);assert.deepEqual(calls.errors,[]);
});

test('mixed statements about compound memories retain their answer and never propose a destructive shortcut',async()=>{
 const {context,store,calls,say}=fixture();const old=store.rememberFact('I live in Seattle. My sister is Priya');context.apiKey='fixture';let requests=0;
 context.sendTextToGemini=async()=>{requests++;assert.equal(context.selectedAssistantMemories('where I live').some(f=>f.id===old.id),false);return 'RESPONSE: Boston has a long history.';};
 await say('I live in Boston. Explain its history');assert.equal(requests,1);assert.equal(store.snapshot().facts[0].text,old.text);assert.equal(calls.spoken.at(-1),'Boston has a long history.');assert.equal(context.hasAssistantReview(),false);
});

test('memory-use explanations follow the last answered request and a local action clears older provider evidence',async()=>{
 const {context,store,calls,say}=fixture();const fact=store.rememberFact('I live in Seattle');const request=context.beginAssistantRequest();
 context.selectedAssistantMemories('What is the weather in my city?');await context.finishAssistantTurn('It is cool today.',false,request);
 await say('what memories did you use');assert.match(calls.spoken.at(-1),/I used these saved details: I live in Seattle/);
 await say('set volume to 75%');await say('what memories did you use');assert.equal(calls.spoken.at(-1),'No saved memories were used in the last answer.');
 assert.equal(store.snapshot().facts[0].id,fact.id);
});

test('direct action-specialist memory selection marks revocation dependencies without history-context construction',()=>{
 const {context,store}=fixture();const fact=store.rememberFact('My favorite band is Radiohead');const request=context.beginAssistantRequest();
 assert.equal(context.selectedAssistantMemories('play my favorite band')[0].id,fact.id);store.deleteFact(fact.id);assert.equal(request.signal.aborted,true);
});

test('bare cancel is local after interruption and never needs Gemini',async()=>{const {say,calls}=fixture();await say('cancel');assert.equal(calls.spoken.at(-1),'Cancelled. Completed actions stay completed.');assert.deepEqual(calls.errors,[]);});

test('stale spoken confirmations cannot generate actions or call a provider',async()=>{const {say,calls}=fixture();for(const input of ['run selected steps','yes run selected steps','confirm','resume workspace']){await say(input);assert.match(calls.spoken.at(-1),/no open review/);}assert.deepEqual(calls.errors,[]);assert.deepEqual(calls.opened,[]);assert.deepEqual(calls.media,[]);});

test('repeating a paraphrased memory keeps its dependency and deletion stops speech and removes the paraphrase',async()=>{
 const {context,store}=fixture();const fact=store.rememberFact('my locker code is 4312');const request=context.beginAssistantRequest();context.markMemoryContextUsed([fact.id]);await context.finishAssistantTurn('Your number is four three one two.',false,request);let finish;context.speakResponse=()=>new Promise(resolve=>{finish=resolve;});const pending=context.repeatAssistantResult();await new Promise(r=>setImmediate(r));store.deleteFact(fact.id);finish({status:'completed'});await pending;assert.equal(context.window.OlangaTurns.snapshot().outcome,'cancelled');assert.equal(context.window.OlangaTurns.snapshot().canRepeatResult,false);assert.equal(context.conversationHistory.some(item=>/four three one two/.test(item.text)),false);await assert.rejects(()=>context.repeatAssistantResult(),/no previous result/i);
});


test('search receives relevant learned city and units without unrelated memories or an extra model call', async () => {
 const {context,store}=fixture();store.learnFromUserText('I live in Seattle');store.learnFromUserText('I prefer Celsius');store.learnFromUserText('My favorite color is blue');
 const request=context.beginAssistantRequest();let body,calls=0;
 context.callGeminiGenerate=async(_model,input)=>{calls++;body=input;return 'The forecast is cool.';};
 await context.answerWithGoogleSearch('What is the weather here?',request.signal);
 const data=JSON.parse(body.contents[0].parts[0].text);
 assert.ok(data.memories.includes('I live in Seattle'));assert.ok(data.memories.some(text=>/Celsius/.test(text)));assert.equal(data.memories.some(text=>/blue/.test(text)),false);assert.equal(calls,1);
 assert.match(body.system_instruction.parts[0].text,/current request first/);assert.match(body.system_instruction.parts[0].text,/no preferred or requested temperature unit/);
 store.preference('factsEnabled',false);const next=context.beginAssistantRequest();await context.answerWithGoogleSearch('What is the weather here?',next.signal);assert.equal(JSON.parse(body.contents[0].parts[0].text).memories,undefined);
});

test('forgetting a memory consumed by an in-flight search cancels its pending provider response', async () => {
 const {context,store}=fixture();const fact=store.rememberFact('I live in Seattle');context.apiKey='fixture';let finish,called=false;
 context.window.electronAPI.providerGenerate=()=>{called=true;return new Promise(resolve=>{finish=resolve;});};
 const request=context.beginAssistantRequest(),pending=context.answerWithGoogleSearch('What is the weather here?',request.signal);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(called,true);assert.ok(request.contextMemoryIds.includes(fact.id));
 store.deleteFact(fact.id);await assert.rejects(pending,{name:'AbortError'});finish({ok:true,text:'A late answer about Seattle.'});assert.equal(request.signal.aborted,true);
});

test('a typed compound command parses once per turn and reused plans cannot be mutated by callers', async () => {
 const {context,say,calls}=fixture(),intents=context.OlangaIntents;let parses=0;
 context.OlangaIntents={...intents,parse(...args){parses++;return intents.parse(...args);}};
 await say('open notepad and set volume to 75%');assert.equal(parses,1);assert.deepEqual(calls.opened,['notepad']);assert.deepEqual(calls.media,['VOLUME_SET']);
 await say('open notepad and set volume to 75%');assert.equal(parses,2,'A new turn has its own parse');
 context.beginAssistantRequest();const plan=context.assistantLocalIntents('open notepad');plan[0].command='[OPEN_APP: calculator]';
 assert.equal(context.assistantLocalIntents('open notepad')[0].command,'[OPEN_APP: notepad]');
});

test('request-scoped parsing invalidates immediately when saved app names change',()=>{
 const {context,store}=fixture();store.remember('aliases','desk','Notepad');store.preference('memoryEnabled',true);context.beginAssistantRequest();
 assert.equal(context.assistantLocalIntents('open desk')[0].command,'[OPEN_APP: Notepad]');store.forget('aliases','desk');store.remember('aliases','desk','Calculator');
 assert.equal(context.assistantLocalIntents('open desk')[0].command,'[OPEN_APP: Calculator]');store.preference('memoryEnabled',false);assert.equal(context.assistantLocalIntents('open desk'),null);
});

test('the final transcript cannot reuse a different rough-transcript action plan',async()=>{
 const {context,calls}=fixture();context.apiKey='fixture';context.blobToBase64=async()=>'';context.transcribeAssistantAudio=async()=> 'open calculator';
 await context.processAudioBlobWithGemini({}, {rough:'open notepad'});assert.deepEqual(calls.opened,['calculator']);assert.deepEqual(calls.errors,[]);
});

test('polite routine confirmations reach the existing fresh review with no model call',async()=>{
 const {context,say,calls}=fixture();let active=true,heard;
 context.window.OlangaRoutineControl={hasReview:()=>active,answerReview:async goal=>{heard=goal;active=false;return{handled:true,message:'Selected steps completed.'};}};
 await say('Olanga, can you please run selected steps?');assert.equal(heard,'run selected steps');assert.equal(calls.spoken.at(-1),'Selected steps completed.');assert.deepEqual(calls.errors,[]);
 await say('Olanga, can you please run selected steps?');assert.match(calls.spoken.at(-1),/no open review/);
});


test('supported personal facts answer locally, reflect corrections, and retain deletion dependencies',async()=>{
 const {context,store,say,calls}=fixture();await say('My name is Aarav');await say('I live in Seattle');await say('I prefer Celsius');
 for(const [question,answer]of [["What's my name?",'Your name is Aarav.'],['Where do I live?','You live in Seattle.'],['What temperature units do I prefer?','You prefer Celsius.']]){await say(question);assert.equal(calls.spoken.at(-1),answer);}
 await say('I now live in Boston');await say('Where do I live?');assert.equal(calls.spoken.at(-1),'You live in Boston.');assert.deepEqual(calls.errors,[]);
 const city=store.snapshot().facts.find(f=>f.slot==='city');store.deleteFact(city.id);assert.equal(context.window.OlangaTurns.snapshot().canRepeatResult,false);assert.doesNotMatch(context.aiText.textContent,/Boston/);
});

test('local recall never guesses missing, conflicting or disabled memories and preserves mixed requests',async()=>{
 const {context,store,say,calls}=fixture();context.apiKey='fixture';let providers=0;context.sendTextToGemini=async()=>{providers++;return 'RESPONSE: Please clarify that detail.';};
 await say('What is my favorite color?');assert.equal(providers,1);
 store.rememberFact('I live in Seattle');store.preference('factsEnabled',false);await say('Where do I live?');assert.equal(providers,2);
 store.preference('factsEnabled',true);await say('Where do I live? Also explain its history.');assert.equal(providers,3);assert.equal(calls.spoken.at(-1),'Please clarify that detail.');
});


test('verified result synthesis starts before acknowledgment ends, with no optimistic receipt',async()=>{
 const {context,say,calls}=fixture();const events=[];let acknowledge,verify;
 context.speakAssistantAcknowledgement=()=>new Promise(resolve=>{acknowledge=resolve;events.push('ack');});
 context.window.electronAPI.mediaControl=()=>new Promise(resolve=>{verify=resolve;events.push('dispatch');});
 const handle={};context.prepareAssistantResponseSpeech=(text,options)=>{events.push('prepare');assert.equal(text,'System volume is 75%.');assert.equal(options.signal.aborted,false);return handle;};
 context.speakResponse=async(text,options)=>{events.push('speak');assert.equal(options.preparedSpeech,handle);return{status:'completed'};};
 const pending=say('set volume to 75%');await new Promise(r=>setImmediate(r));assert.deepEqual(events,['ack','dispatch']);
 verify({ok:true,verified:true,message:'System volume is 75%.'});await new Promise(r=>setImmediate(r));assert.deepEqual(events,['ack','dispatch','prepare']);assert.equal(context.aiText.textContent,'System volume is 75%.');
 acknowledge();await pending;assert.deepEqual(events,['ack','dispatch','prepare','speak']);assert.deepEqual(calls.errors,[]);
});

test('cancelled prepared receipt is discarded without playback and optional preparation failure falls back',async()=>{
 const {context,calls}=fixture();let acknowledge;const handle={},discarded=[];context.prepareAssistantResponseSpeech=()=>handle;context.discardPreparedAssistantSpeech=value=>discarded.push(value);
 const request=context.beginAssistantRequest();request.acknowledgement=new Promise(resolve=>{acknowledge=resolve;});const pending=context.finishAssistantTurn('System volume is 75%.',false,request);
 context.cancelAssistantRequest();acknowledge();await pending;assert.deepEqual(discarded,[handle]);assert.deepEqual(calls.spoken,[]);
 context.prepareAssistantResponseSpeech=()=>{throw Error('Optional prefetch unavailable');};await context.finishAssistantTurn('Playback paused.',false,context.beginAssistantRequest());assert.deepEqual(calls.spoken,['Playback paused.']);
});

test('personal result prefetch receives memory sensitivity and the follow-up speech handle',async()=>{
 const {context,store}=fixture();const fact=store.rememberFact('My name is Aarav');const request=context.beginAssistantRequest();context.markMemoryContextUsed([fact.id]);const handle={};
 context.prepareAssistantResponseSpeech=(text,options)=>{assert.equal(options.memorySensitive,true);return handle;};context.speakResponseAndThen=async(text,callback,options)=>{assert.equal(options.preparedSpeech,handle);return{status:'completed'};};await context.finishAssistantTurn('Your name is Aarav. Anything else?',true,request);
});


test('contradictory compound manual memory blocks local guessing and automatic overwrites',async()=>{
 const {context,store,calls,say}=fixture();const original=store.rememberFact('I live in Boston. I live in Chicago');
 await say('I live in Seattle');assert.deepEqual(store.memorySnapshot().facts.map(f=>f.text),[original.text]);assert.match(calls.spoken.at(-1),/also contains other details.*kept it intact/);assert.equal(context.hasAssistantReview(),false);
 store.rememberFact('I live in Portland');assert.equal(store.recallFact('Where do I live?'),null);
});
