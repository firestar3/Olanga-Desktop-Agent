// Real renderer, disposable profile; no providers, microphone or native actions.
const {app,BrowserWindow,ipcMain,session,net}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const output=path.resolve(__dirname,'../build/qa');fs.mkdirSync(output,{recursive:true});
app.setPath('userData',fs.mkdtempSync(path.join(output,'workspace-recovery-profile-')));app.disableHardwareAcceleration();
if(!process.argv.includes('--hidden'))process.argv.push('--hidden');
const report={passed:false,runtime:process.versions.electron,checks:[],forbidden:[],errors:[],downloads:[],screenshots:[]};
let downloadSequence=0;
const forbidden=new Set(['provider-generate','provider-generate-stream','nvidia-tts-config','nvidia-tts-synthesize','open-app','arrange-app','close-app','play-spotify','reload-spotify','media-control','desktop-capture','desktop-run','desktop-undo','fetch-news-bundle','check-release','update-download','update-install','set-open-at-login']);
const handle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,callback)=>handle(channel,(event,...args)=>{if(forbidden.has(channel)){report.forbidden.push(channel);throw Error('Fixture blocked '+channel);}return callback(event,...args);});
globalThis.fetch=async()=>{report.forbidden.push('main-fetch');throw Error('Network blocked');};
net.fetch=async()=>{report.forbidden.push('net-fetch');throw Error('Network blocked');};
app.on('web-contents-created',(_,contents)=>{contents.on('preload-error',(_,file,error)=>report.errors.push(error.message));contents.on('render-process-gone',(_,details)=>report.errors.push(details.reason));});
app.whenReady().then(()=>{
 session.defaultSession.setPermissionCheckHandler(()=>false);
 session.defaultSession.setPermissionRequestHandler((_,permission,callback)=>{report.forbidden.push('permission:'+permission);callback(false);});
 session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(detail,callback)=>{report.forbidden.push('network:'+new URL(detail.url).origin);callback({cancel:true});});
 session.defaultSession.on('will-download',(_,item)=>{const filename=item.getFilename();if(!['olanga-workspace-backup.json','olanga-workspace-recovery.json'].includes(filename)){report.forbidden.push('download:'+filename);item.cancel();return;}const target=path.join(output,'fixture-'+(++downloadSequence)+'-'+filename);item.setSavePath(target);item.once('done',(_,state)=>report.downloads.push({filename,state,path:target}));});
});
let main,finished=false;const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const evaluate=(fn,...args)=>main.webContents.executeJavaScript('('+fn.toString()+')(...'+JSON.stringify(args)+')',true);
async function waitFor(fn,label){const start=Date.now();while(Date.now()-start<10000){if(await fn())return;await pause(35);}throw Error(label);}
async function ready(){await waitFor(()=>evaluate(()=>!!window.OlangaWorkspace&&!!window.OlangaWorkspaceHealth&&!!window.openOlangaWorkbench&&document.querySelector('[data-workbench-tab="schedules"]')),'Workspace did not initialize');await evaluate(()=>{isTtsMuted=true;isMicMuted=true;window.__warmCalls=0;warmProviderConnection=()=>{window.__warmCalls++;};navigator.mediaDevices.getUserMedia=async()=>{throw Error('Fixture microphone blocked');};});}
async function reload(){await new Promise(resolve=>{main.webContents.once('did-finish-load',resolve);main.webContents.reload();});await ready();}
async function click(selector){await evaluate(selector=>{const node=document.querySelector(selector);if(!node||!node.getClientRects().length||node.disabled)throw Error('Missing visible enabled control '+selector);node.scrollIntoView({block:'nearest'});node.focus();node.click();},selector);await pause(30);}
async function review(label){await evaluate(label=>{const control=[...document.querySelectorAll('#workspaceBackupReview[open] button')].find(node=>node.textContent===label);if(!control||!control.getClientRects().length||control.disabled)throw Error('Missing review '+label);control.click();},label);await pause(40);}
async function chooseBackup(text){await evaluate(text=>{const transfer=new DataTransfer();transfer.items.add(new File([text],'fixture.json',{type:'application/json'}));const input=document.getElementById('workspaceImportFile');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));},text);await waitFor(()=>evaluate(()=>!!document.querySelector('#workspaceBackupReview[open]')?.open),'No restore review');}
async function recoveryButton(key,label){await evaluate((key,label)=>{
 const index=OlangaWorkspace.listRecoveryCopies().findIndex(copy=>copy.key===key);
 const row=document.querySelectorAll('#workspaceRecoveryCopies > .workspace-item')[index];
 const control=row&&[...row.querySelectorAll('button')].find(button=>button.textContent===label);
 if(index<0||!control||!control.getClientRects().length||control.disabled)throw Error('Missing retained-copy control '+label);
 control.scrollIntoView({block:'nearest'});control.focus();control.click();
},key,label);await pause(40);}
async function check(name,fn){await fn();report.checks.push({name,passed:true});}
async function screenshot(name){await pause(120);main.webContents.invalidate();await main.webContents.capturePage();await pause(80);const target=path.join(output,'workspace-recovery-'+name+'.png');fs.writeFileSync(target,(await main.webContents.capturePage()).toPNG());report.screenshots.push(target);}
function finish(code){if(finished)return;finished=true;fs.writeFileSync(path.join(output,'workspace-recovery-smoke.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));app.exit(code);}
const deadline=setTimeout(()=>{report.error='Workspace recovery smoke timed out';finish(1);},120000);deadline.unref();
require('../main');
app.whenReady().then(async()=>{try{
 await waitFor(()=>{main=BrowserWindow.getAllWindows().find(win=>/[\\/]index\.html$/.test(win.webContents.getURL()));return main&&!main.webContents.isLoading();},'Main renderer missing');await ready();main.setMinimumSize(0,0);main.setSize(1000,900);main.webContents.setZoomFactor(1);
 await click('#startLocalBtn');
 await check('Direct Projects, Schedules and Updates navigation runs no commands',async()=>{
  await click('#workspaceOpen');await click('#workspaceProjects');assert.equal(await evaluate(()=>!document.querySelector('[data-workbench-page="projects"]').hidden),true);await evaluate(()=>document.getElementById('workbenchDialog').close());
  await click('#workspaceOpen');await click('#workspaceSchedules');assert.equal(await evaluate(()=>!document.querySelector('[data-workbench-page="schedules"]').hidden),true);await evaluate(()=>document.getElementById('workbenchDialog').close());
  await click('#workspaceOpen');await click('#workspaceUpdates');assert.equal(await evaluate(()=>!document.querySelector('[data-workspace-page="3"]').hidden),true);
 });
 await check('Example selection prefills an editable command without dispatch or connection warmup',async()=>{
  await evaluate(()=>openOlangaWorkspace('0'));await click('#workspaceExamples button');assert.deepEqual(await evaluate(()=>({value:document.getElementById('textCommandInput').value,focused:document.activeElement.id,activity:OlangaWorkspace.snapshot().activity.length,warm:window.__warmCalls})),{value:'Set a timer for 25 minutes called Focus',focused:'textCommandInput',activity:0,warm:0});
 });
 let backup;
 await check('Memories search and sorting use explicit saved records',async()=>{
  await evaluate(()=>{OlangaWorkspace.rememberFact('Zebra project preference');OlangaWorkspace.rememberFact('Alpha birthday reminder');OlangaWorkspace.saveRoutine({name:'Fixture focus',lines:['Set a timer for 25 minutes called Focus']},OlangaIntents.parse);openOlangaWorkspace('5');const sort=document.getElementById('factSort');sort.value='alphabetical';sort.dispatchEvent(new Event('change'));});
  assert.equal(await evaluate(()=>document.querySelector('#factList strong').textContent),'Alpha birthday reminder');
  await evaluate(()=>{const search=document.getElementById('factSearch');search.value='zebra';search.dispatchEvent(new Event('input'));});assert.equal(await evaluate(()=>document.querySelectorAll('#factList .workspace-item').length),1);assert.equal(await evaluate(()=>document.getElementById('factCount').textContent),'1 of 2 saved memories');
  await evaluate(()=>{document.getElementById('factSearch').value='';document.getElementById('factSearch').dispatchEvent(new Event('input'));});await screenshot('memories');backup=await evaluate(()=>JSON.stringify(OlangaWorkspace.exportPersonal()));
 });
 await check('A newer backup selection wins over a delayed older file read',async()=>{
  await evaluate(backup=>{openOlangaWorkspace('7');const older=JSON.parse(backup);older.content.facts=older.content.facts.slice(0,1);window.__fileText=File.prototype.text;File.prototype.text=function(){return this.name==='slow.json'?new Promise(resolve=>{window.__releaseBackupRead=()=>resolve(JSON.stringify(older));}):window.__fileText.call(this);};const input=document.getElementById('workspaceImportFile');for(const filename of ['slow.json','newer.json']){const transfer=new DataTransfer();transfer.items.add(new File([backup],filename,{type:'application/json'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));}},backup);
  await waitFor(()=>evaluate(()=>!!document.querySelector('#workspaceBackupReview[open]')?.open),'Newer backup preview missing');await evaluate(()=>{window.__releaseBackupRead();File.prototype.text=window.__fileText;});await pause(40);
  assert.equal(await evaluate(()=>document.querySelectorAll('#workspaceBackupReview[open]').length),1);assert.match(await evaluate(()=>document.querySelector('#workspaceBackupReview[open]').textContent),/Memories: 2 current → 2 in backup/);await review('Cancel');
 });
 await check('Export downloads only personal content; cancelling import changes nothing',async()=>{
  await evaluate(()=>openOlangaWorkspace('7'));assert.equal(await evaluate(()=>document.getElementById('workspaceImportFile').getClientRects().length),0);await click('#workspaceExport');await waitFor(()=>report.downloads.length>0,'Backup download missing');assert.equal(report.downloads[0].state,'completed');assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(report.downloads[0].path,'utf8')).content),['facts','aliases','playlists','routines']);
  const before=await evaluate(()=>localStorage.getItem(OlangaProductivity.KEY));await chooseBackup(backup);await review('Cancel');assert.equal(await evaluate(()=>localStorage.getItem(OlangaProductivity.KEY)),before);
 });
 await check('Restore review rejects stale previews and never executes imported routines',async()=>{
  await chooseBackup(backup);await evaluate(()=>OlangaWorkspace.rememberFact('Saved after preview'));await review('Replace saved Workspace content');assert.match(await evaluate(()=>document.querySelector('#workspaceBackupReview[open] [role="alert"]').textContent),/changed after preview/);await review('Cancel');
  await chooseBackup(backup);await review('Replace saved Workspace content');assert.deepEqual(await evaluate(()=>({facts:OlangaWorkspace.snapshot().facts.length,runs:OlangaWorkspace.snapshot().runs.length,activity:OlangaWorkspace.snapshot().activity.length,copies:OlangaWorkspace.listRecoveryCopies().length})),{facts:2,runs:0,activity:0,copies:1});
 });
 await check('Corrupt storage keeps ordinary activity in session and reports blocked edits truthfully',async()=>{
  await evaluate(()=>localStorage.setItem(OlangaProductivity.KEY,'{fixture original'));await reload();await evaluate(()=>{const id=OlangaWorkspace.begin(),step=OlangaWorkspace.step(id,'VOLUME_STATUS');OlangaWorkspace.receipt(id,step,'completed','fixture');OlangaWorkspace.finish(id,'completed');openOlangaWorkspace('5');});
  assert.equal(await evaluate(()=>localStorage.getItem(OlangaProductivity.KEY)),'{fixture original');assert.equal(await evaluate(()=>document.getElementById('workspaceRecoveryNotice').hidden),false);
  await click('#factsEnabled');assert.equal(await evaluate(()=>document.getElementById('factsEnabled').checked),true);assert.match(await evaluate(()=>document.getElementById('workspaceStatus').textContent),/needs recovery/);
 });
 await check('Recovery reset requires a verified copy and explicit confirmation; copy survives restart',async()=>{
  await click('#workspaceRecoveryOpen');assert.equal(await evaluate(()=>document.getElementById('workspaceRecoveryReset').hidden),true);await click('#workspaceRecoveryBackup');await click('#workspaceRecoveryDownload');await waitFor(()=>report.downloads.length===2,'Recovery download missing');assert.equal(JSON.parse(fs.readFileSync(report.downloads[1].path,'utf8')).raw,'{fixture original');
  await click('#workspaceRecoveryReset');await review('Cancel');assert.equal(await evaluate(()=>localStorage.getItem(OlangaProductivity.KEY)),'{fixture original');await click('#workspaceRecoveryReset');await review('Reset Workspace storage');await reload();await evaluate(()=>openOlangaWorkspace('7'));assert.equal(await evaluate(()=>OlangaWorkspace.recoveryStatus().blocked),false);assert.equal(await evaluate(()=>OlangaWorkspace.listRecoveryCopies().length),2);
  await screenshot('backups');main.setSize(400,850);await pause(100);await screenshot('narrow');assert.equal(await evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);assert.equal(await evaluate(()=>document.getElementById('workspaceDialog').scrollWidth<=document.getElementById('workspaceDialog').clientWidth+1),true);
 });
 let validCopy,damagedCopy;
 await check('Retained recovery-copy download preserves exact bytes and reviewed restoration restores only personal content',async()=>{
  main.setSize(1000,900);await click('#workspaceRecoveryRefresh');
  const copies=await evaluate(()=>OlangaWorkspace.listRecoveryCopies().map(copy=>({...copy,text:OlangaWorkspace.recoveryBackupText(copy.key),raw:JSON.parse(OlangaWorkspace.recoveryBackupText(copy.key)).raw})));
  validCopy=copies.find(copy=>copy.raw&&copy.raw.includes('Zebra project preference'));damagedCopy=copies.find(copy=>copy.raw==='{fixture original');
  assert.ok(validCopy&&damagedCopy,'Both valid and damaged retained records must survive restart');
  const downloadsBefore=report.downloads.length;
  await recoveryButton(validCopy.key,'Download');await waitFor(()=>report.downloads.length===downloadsBefore+1,'Retained-copy download missing');
  const download=report.downloads.at(-1);assert.equal(download.state,'completed');assert.equal(download.filename,'olanga-workspace-recovery.json');assert.equal(path.dirname(download.path),output);assert.equal(fs.readFileSync(download.path,'utf8'),validCopy.text);
  const current=await evaluate(()=>localStorage.getItem(OlangaProductivity.KEY));
  await recoveryButton(validCopy.key,'Review personal content');await waitFor(()=>evaluate(()=>!!document.querySelector('#workspaceBackupReview[open]')?.open),'Retained-copy review missing');
  assert.match(await evaluate(()=>document.querySelector('#workspaceBackupReview[open]').textContent),/Memories: 0 current → 3 in backup/);assert.match(await evaluate(()=>document.querySelector('#workspaceBackupReview[open]').textContent),/Saved after preview/);
  assert.equal(await evaluate(()=>localStorage.getItem(OlangaProductivity.KEY)),current,'Preview must not replace active content');
  await review('Cancel');assert.equal(await evaluate(()=>localStorage.getItem(OlangaProductivity.KEY)),current,'Cancelling review must keep current content');
  await recoveryButton(validCopy.key,'Review personal content');await review('Replace saved Workspace content');
  const restored=await evaluate(()=>JSON.parse(localStorage.getItem(OlangaProductivity.KEY))),original=JSON.parse(validCopy.raw),unchanged=JSON.parse(current);
  for(const key of ['facts','aliases','playlists','routines']){assert.deepEqual(restored[key],original[key],key+' must restore exactly');delete restored[key];delete unchanged[key];}
  assert.deepEqual(restored,unchanged,'Restoration must preserve nonpersonal Workspace state');
  assert.equal(await evaluate(()=>OlangaWorkspace.listRecoveryCopies().length),3,'Restore must retain an additional verified copy');
  assert.equal(await evaluate(()=>OlangaWorkspace.snapshot().runs.length),0,'Reviewing or restoring a routine must never run it');
 });
 await check('A damaged retained copy can be downloaded but its restore review refuses without replacing current data',async()=>{
  const before=await evaluate(()=>localStorage.getItem(OlangaProductivity.KEY));
  await recoveryButton(damagedCopy.key,'Review personal content');
  assert.equal(await evaluate(()=>!!document.querySelector('#workspaceBackupReview[open]')?.open),false);assert.match(await evaluate(()=>document.getElementById('workspaceStatus').textContent),/damaged.*cannot be restored automatically/);
  assert.equal(await evaluate(()=>localStorage.getItem(OlangaProductivity.KEY)),before);
  const downloadsBefore=report.downloads.length;await recoveryButton(damagedCopy.key,'Download');await waitFor(()=>report.downloads.length===downloadsBefore+1,'Damaged retained-copy download missing');
  const download=report.downloads.at(-1);assert.equal(download.state,'completed');assert.equal(download.filename,'olanga-workspace-recovery.json');assert.equal(path.dirname(download.path),output);assert.equal(fs.readFileSync(download.path,'utf8'),damagedCopy.text);
 });
 await check('Retained-copy deletion requires confirmation and removes only that copy across restart',async()=>{
  const before=await evaluate(()=>({current:localStorage.getItem(OlangaProductivity.KEY),copies:OlangaWorkspace.listRecoveryCopies().map(copy=>({key:copy.key,text:OlangaWorkspace.recoveryBackupText(copy.key)}))}));
  await recoveryButton(validCopy.key,'Delete copy');assert.match(await evaluate(()=>document.querySelector('#workspaceBackupReview[open]').textContent),/Current Workspace content is unchanged/);await review('Cancel');
  assert.equal(await evaluate(key=>OlangaWorkspace.recoveryBackupText(key),validCopy.key),validCopy.text);assert.equal(await evaluate(()=>localStorage.getItem(OlangaProductivity.KEY)),before.current);
  await recoveryButton(validCopy.key,'Delete copy');await review('Delete recovery copy');
  assert.equal(await evaluate(key=>localStorage.getItem(key),validCopy.key),null);assert.match(await evaluate(()=>document.getElementById('workspaceStatus').textContent),/Recovery copy deleted/);
  await reload();await evaluate(()=>openOlangaWorkspace('7'));
  const after=await evaluate(()=>({current:localStorage.getItem(OlangaProductivity.KEY),copies:OlangaWorkspace.listRecoveryCopies().map(copy=>({key:copy.key,text:OlangaWorkspace.recoveryBackupText(copy.key)}))}));
  assert.equal(after.current,before.current);assert.deepEqual(after.copies,before.copies.filter(copy=>copy.key!==validCopy.key));
  assert.equal(await evaluate(()=>document.querySelectorAll('#workspaceRecoveryCopies > .workspace-item').length),2);
 });
 assert.deepEqual(report.forbidden,[]);assert.deepEqual(report.errors,[]);report.passed=true;finish(0);
}catch(error){report.error=error.stack;finish(1);}});
