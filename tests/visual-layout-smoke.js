// Fixture-only visual and navigation audit; never opens providers, real audio or native apps.
const {app,BrowserWindow,ipcMain,session,net}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const output=path.resolve(__dirname,'../build/qa/visual-layout');fs.mkdirSync(output,{recursive:true});
const profile=fs.mkdtempSync(path.join(output,'profile-'));app.setPath('userData',profile);app.disableHardwareAcceleration();
const report={passed:false,profile,checks:[],views:[],forbidden:[],errors:[]};let main,done=false;
const forbidden=new Set(['provider-generate','provider-generate-stream','nvidia-tts-config','nvidia-tts-synthesize','open-app','close-app','arrange-app','play-spotify','reload-spotify','media-control','desktop-capture','desktop-run','desktop-undo','execute-command','update-download','update-install','check-release','conversation-live-start','set-open-at-login','open-external']);
const handle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,callback)=>handle(channel,(event,...args)=>{
 if(forbidden.has(channel)){report.forbidden.push(channel);throw Error('Disabled in visual fixture');}
 if(channel==='fetch-news-bundle')return{generatedAt:new Date().toISOString(),locationLabel:'Fixture City',topics:['technology','local'],coverage:{},articles:[{title:'Research team publishes a practical guide to more reliable desktop tools',source:'Science Review',sourceUrl:'https://example.org/',link:'https://example.org/story',pubDate:new Date().toISOString(),topics:['technology'],description:'This fixture excerpt demonstrates a realistic paragraph with enough detail to check line wrapping and comfortable reading.'},{title:'Community library opens a new study area',source:'Local Gazette',link:'https://example.org/local',pubDate:new Date().toISOString(),topics:['local'],description:'The reading area has additional desks and accessible workspaces.'}]};
 return callback(event,...args);
});
const offline=async()=>{report.forbidden.push('network');throw Error('Network disabled')};globalThis.fetch=net.fetch=offline;
app.whenReady().then(()=>{session.defaultSession.setPermissionCheckHandler(()=>false);session.defaultSession.setPermissionRequestHandler((_c,p,reply)=>{report.forbidden.push('permission:'+p);reply(false)});session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_d,reply)=>{report.forbidden.push('renderer-network');reply({cancel:true})});});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));const evaluate=(fn,...args)=>main.webContents.executeJavaScript('('+fn.toString()+')(...'+JSON.stringify(args)+')',true);
async function until(fn,label){for(let i=0;i<160;i++){if(await fn())return;await pause(30)}throw Error(label)}
async function click(selector){await evaluate(selector=>{const item=document.querySelector(selector);if(!item||!item.getClientRects().length||item.disabled)throw Error('Unavailable '+selector);item.scrollIntoView({block:'nearest'});item.click()},selector)}
async function home(){await evaluate(()=>{document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());document.querySelector('[data-screen="mainScreen"]').click()});}
async function keyboardActivate(selector) {
 await evaluate(selector => document.querySelector(selector).focus(), selector);
 main.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
 main.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
 main.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
 await pause(40);
}
async function reachable(selector) {
 const result = await evaluate(selector => {
  const element = document.querySelector(selector); element.scrollIntoView({block:'nearest',inline:'nearest'});
  const r = element.getBoundingClientRect();
  if(r.width < 4 || r.height < 4 || r.left < -2 || r.right > innerWidth + 2 || r.top < -2 || r.bottom > innerHeight + 2) return false;
  for(let parent=element.parentElement;parent;parent=parent.parentElement){
   const style=getComputedStyle(parent),bounds=parent.getBoundingClientRect();
   if(/auto|scroll|hidden|clip/.test(style.overflowY) && (r.top < bounds.top - 2 || r.bottom > bounds.bottom + 2)) return false;
  }
  return true;
 }, selector);
 assert.equal(result,true,'Control must remain reachable: '+selector);
}
// Scroll only named controls into view, inspect their real hit target, then restore
// every affected scroll position so the existing screenshot states stay unchanged.
async function reachablePanelControls(panelSelector, controls, label) {
 const result = await evaluate((panelSelector, controls) => {
  const panel = document.querySelector(panelSelector);
  if (!panel?.open) return { error: 'Panel is not open: ' + panelSelector };
  const targets = [];
  for (const control of controls) {
   const { selector, text } = typeof control === 'string' ? { selector: control } : control;
   const matches = [...panel.querySelectorAll(selector)].filter(element => text === undefined || element.textContent.trim() === text);
   if (matches.length !== 1) return { error: 'Expected one control: ' + (text || selector), matches: matches.length };
   targets.push({ element: matches[0], label: text || selector });
  }
  const scrollPositions = new Map();
  for (const { element } of targets) for (let parent = element.parentElement; parent; parent = parent.parentElement) {
   if (!scrollPositions.has(parent)) scrollPositions.set(parent, { top: parent.scrollTop, left: parent.scrollLeft });
  }
  const checked = [];
  try {
   for (const { element, label } of targets) {
    if (!element.getClientRects().length || getComputedStyle(element).visibility !== 'visible' || element.matches(':disabled')) return { error: 'Control is unavailable: ' + label };
    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const r = element.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.left < -2 || r.right > innerWidth + 2 || r.top < -2 || r.bottom > innerHeight + 2) return { error: 'Control does not fit the viewport: ' + label };
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
     const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
     const top = bounds.top + parent.clientTop, left = bounds.left + parent.clientLeft;
     if (/auto|scroll|hidden|clip/.test(style.overflowY) && (r.top < top - 2 || r.bottom > top + parent.clientHeight + 2)) return { error: 'Control is vertically clipped: ' + label };
     if (/auto|scroll|hidden|clip/.test(style.overflowX) && (r.left < left - 2 || r.right > left + parent.clientWidth + 2)) return { error: 'Control is horizontally clipped: ' + label };
    }
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit || (hit !== element && !element.contains(hit))) return { error: 'Control is covered: ' + label, hit: hit?.id || hit?.tagName || null };
    checked.push(label);
   }
   return { checked };
  } finally {
   for (const [element, position] of scrollPositions) element.scrollTo({ ...position, behavior: 'instant' });
  }
 }, panelSelector, controls);
 assert.equal(result.error, undefined, label + ': ' + (result.error || ''));
 assert.equal(result.checked.length, controls.length, label + ': every named control checked');
 report.checks.push(label + ': ' + result.checked.length + ' lower controls reachable and unobscured');
}
async function capture(name,size){await Promise.race([evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))),pause(150)]);main.webContents.invalidate();await pause(130);await main.webContents.capturePage();await pause(70);const file=path.join(output,size+'-'+name+'.png');fs.writeFileSync(file,(await main.webContents.capturePage()).toPNG());const metrics=await evaluate(()=>{
 const root=document.querySelector('dialog[open]')||[...document.querySelectorAll('.screen')].find(n=>getComputedStyle(n).display!=='none');
 const visible=n=>n.getClientRects().length&&getComputedStyle(n).visibility!=='hidden';
 const bounds=n=>{const r=n.getBoundingClientRect();return{left:Math.round(r.left),right:Math.round(r.right),top:Math.round(r.top),bottom:Math.round(r.bottom),width:Math.round(r.width),height:Math.round(r.height)}};
 return{root:root?.id,viewport:{width:innerWidth,height:innerHeight},rootBounds:root?bounds(root):null,documentOverflow:document.documentElement.scrollWidth>innerWidth+1,controls:[...(root?.querySelectorAll('button,input,select,textarea,[contenteditable="true"]')||[])].filter(visible).map(n=>({id:n.id,label:(n.getAttribute('aria-label')||n.title||n.textContent||n.placeholder||'').trim().slice(0,80),...bounds(n),horizontalTextOverflow:n.scrollWidth>n.clientWidth+2})),containers:[...(root?.querySelectorAll('.notepad-header,.notepad-content-wrapper,.news-header,.news-content-wrapper,.news-actions,.workspace-actions,nav,.notepad-ai-sidebar,.news-article-pane')||[])].filter(visible).map(n=>({id:n.id,className:n.className,...bounds(n),scrollWidth:n.scrollWidth,clientWidth:n.clientWidth}))};
 });report.views.push({name,size,file,...metrics});
 assert.equal(metrics.documentOverflow,false,size+'/'+name+': document must not scroll horizontally');
 const outside=metrics.controls.filter(control=>control.left < -2 || control.right > metrics.viewport.width+2);
 assert.deepEqual(outside.map(control=>control.id||control.label),[],size+'/'+name+': controls must fit the viewport horizontally');
 report.checks.push(size+'/'+name+': horizontal layout fits');
}
function finish(code){if(done)return;done=true;report.passed=code===0;fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,views:report.views.length,checks:report.checks,forbidden:report.forbidden,error:report.error,profile},null,2));app.exit(code)}
process.on('uncaughtException',error=>{report.error=error.stack;finish(1)});process.on('unhandledRejection',error=>{report.error=error.stack;finish(1)});
setTimeout(()=>{report.error='Visual audit exceeded 120s';finish(1)},120000).unref();require('../main');
app.whenReady().then(async()=>{try{
 await until(()=>{main=BrowserWindow.getAllWindows().find(w=>/index\.html$/.test(w.webContents.getURL()));return main&&!main.webContents.isLoading()},'Main missing');await until(()=>evaluate(()=>window.OlangaAppInitialized===true),'Initialization missing');
 // Native screenshots need a visible compositor surface. Show inactive even with
 // --hidden, never focus the window or send physical mouse/keyboard input.
 main.unmaximize();main.showInactive();
 await evaluate(()=>{window.visualErrors=[];window.addEventListener('error',event=>window.visualErrors.push(event.message));window.addEventListener('unhandledrejection',event=>window.visualErrors.push(String(event.reason)));});await evaluate(async()=>{await document.fonts.ready;isMicMuted=true;isTtsMuted=true;document.getElementById('startLocalBtn').click();setFeatureEnabled('newsScreen',true);setFeatureEnabled('notepadScreen',true);window.OlangaWorkspace.rememberFact('I prefer concise answers with a concrete next step.');window.OlangaWorkspace.rememberFact('The design review is on Friday afternoon.');const note=document.getElementById('notepadTextarea');note.textContent='Project notes\n\nKeep the interface clear, retain consistent typography, and make every action easy to find.\n\nNext review: verify the narrow window layout and keyboard navigation.';note.dispatchEvent(new Event('input',{bubbles:true}));});
 for(const [size,width,height]of[['narrow',400,550],['standard',1100,800],['wide',1600,950],['enlarged',400,650]]){
  main.webContents.setZoomFactor(size==='enlarged'?1.25:1);main.setContentSize(width,height);await pause(120);await home();await evaluate(()=>document.querySelector('#mainScreen .assistant-container').scrollTop=0);await capture('home',size);
  for(const selector of ['#textCommandInput','.desktop-task-launch','#micToggleBtn','#timerInput','#addTimerBtn','#taskInput','#addTaskBtn'])await reachable(selector);
  report.checks.push(size+': Home command, voice, timer and task controls reachable');
  await click('#workspaceOpen');await capture('workspace-activity',size);if(size==='narrow'||size==='enlarged'){for(const tab of ['1','2','4','6']){await click('[data-workspace-tab="'+tab+'"]');await evaluate(()=>document.getElementById('workspaceDialog').scrollTop=0);await capture('workspace-tab-'+tab,size);if(tab==='1')await reachablePanelControls('#workspaceDialog',['#routineName','#routineLines','#routineForm button[type="submit"]','#routineReset'],size+'/routines');}}
  for(const [tab,name]of[['5','workspace-memories'],['7','workspace-backups'],['3','workspace-updates']]){await click('[data-workspace-tab="'+tab+'"]');await evaluate(()=>document.getElementById('workspaceDialog').scrollTop=0);await capture(name,size);if(tab==='5'&&(size==='narrow'||size==='enlarged'))await reachablePanelControls('#workspaceDialog',['#learningEnabled','#factsEnabled','#factText','#factForm button[type="submit"]','#factSearch','#factSort',{selector:'#factList .workspace-item:last-child button',text:'Edit'},{selector:'#factList .workspace-item:last-child button',text:'Delete'},'#factsClear'],size+'/memories');}
  await click('#workspaceProjects');assert.equal(await evaluate(()=>document.querySelector('#workbenchDialog section:not([hidden])').dataset.workbenchPage),'projects');await capture('work-projects',size);
  await home();await click('#workspaceOpen');await click('#workspaceSchedules');assert.equal(await evaluate(()=>document.querySelector('#workbenchDialog section:not([hidden])').dataset.workbenchPage),'schedules');await capture('work-schedules',size);if(size==='narrow'||size==='enlarged'){for(const page of ['sessions','files','selection','conversation','calendar','integrations','companions','phone']){await evaluate(page=>window.openOlangaWorkbench(page),page);await evaluate(()=>document.getElementById('workbenchDialog').scrollTop=0);await capture('work-'+page,size);if(page==='files')await reachablePanelControls('#workbenchDialog',['Choose files','Preview renames','Choose destination folder','Preview moves','Show previous file operations'].map(text=>({selector:'[data-workbench-page="files"] button',text})),size+'/files');}}
  await home();await click('#workspaceOpen');await click('#workspaceExamples button');assert.equal(await evaluate(()=>document.getElementById('textCommandInput').value),'Set a timer for 25 minutes called Focus');assert.equal(await evaluate(()=>document.querySelector('dialog[open]')===null),true);report.checks.push(size+': direct Projects/Schedules and safe editable example');
  await home();await click('.desktop-task-launch');await capture('desktop-review',size);await home();await evaluate(()=>{window.visualOfflinePromise=reviewOfflineTranscript('Set a timer for twenty five minutes called Focus. Review this local transcript before sending.');});await capture('offline-review',size);await evaluate(()=>document.querySelector('dialog[open] button').click());await click('[data-screen="newsScreen"]');await until(()=>evaluate(()=>!!newsBundleData&&!newsRefreshController),'News missing');await capture('news',size);await click('#newsAiToggleBtn');await capture('news-assistant',size);await click('#newsAiCloseBtn');
  await click('[data-screen="notepadScreen"]');await capture('notes',size);
  const before=await evaluate(()=>{const note=document.getElementById('notepadTextarea');const range=document.createRange();range.setStart(note.firstChild,0);range.setEnd(note.firstChild,7);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);return{html:note.innerHTML,selection:selection.toString()};});
  await keyboardActivate('#notepadAiToggleBtn');
  assert.deepEqual(await evaluate(()=>({focused:document.activeElement.id,expanded:document.getElementById('notepadAiToggleBtn').getAttribute('aria-expanded'),controls:document.getElementById('notepadAiToggleBtn').getAttribute('aria-controls')})),{focused:'notepadAiInput',expanded:'true',controls:'notepadAiSidebar'});
  await reachable('#notepadAiInput');await reachable('#notepadAiSendBtn');await capture('notes-assistant',size);
  await keyboardActivate('#notepadAiCloseBtn');
  assert.deepEqual(await evaluate(()=>({focused:document.activeElement.id,expanded:document.getElementById('notepadAiToggleBtn').getAttribute('aria-expanded'),html:document.getElementById('notepadTextarea').innerHTML,selection:getSelection().toString()})),{focused:'notepadAiToggleBtn',expanded:'false',...before});
  await keyboardActivate('#notepadAiToggleBtn');await keyboardActivate('#notepadAiToggleBtn');
  assert.equal(await evaluate(()=>document.getElementById('notepadAiSidebar').classList.contains('hidden')),true);
  report.checks.push(size+': Notes keyboard toggle, focus return, selection and content preserved');
 }
 for (const change of ['content', 'tab']) {
  const result=await evaluate(change=>{
    const note=document.getElementById('notepadTextarea');const originalTab=currentTabId;
    const range=document.createRange();range.selectNodeContents(note);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
    document.getElementById('notepadAiToggleBtn').click();
    if(change==='tab')addNotepadTab();
    note.textContent='Changed fixture note';note.dispatchEvent(new Event('input',{bubbles:true}));
    selection.removeAllRanges();document.getElementById('notepadAiCloseBtn').click();
    const result={text:note.textContent,selection:selection.toString(),focused:document.activeElement.id};
    if(change==='tab')switchNotepadTab(originalTab);return result;
  },change);
  assert.deepEqual(result,{text:'Changed fixture note',selection:'',focused:'notepadAiToggleBtn'});
  report.checks.push('Notes does not restore stale selection after '+change+' change');
 }
 report.errors=await evaluate(()=>window.visualErrors);assert.deepEqual(report.errors,[]);assert.deepEqual(report.forbidden,[]);report.checks.push('No renderer errors, network requests, permissions or real actions');finish(0);
}catch(error){report.error=error.stack;finish(1)}});
