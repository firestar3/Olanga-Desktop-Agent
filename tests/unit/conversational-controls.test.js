const test=require('node:test'),assert=require('node:assert/strict');
const {parse}=require('../../shared/conversational-controls');
test('routine creation opens the editor and never implies execution',()=>{
 for(const input of ['Create a routine','Make me a new routine','Open the routine editor','Take me to routines','Please create a routine named Focus']){
  const result=parse(input);assert.equal(result.kind,'routine-create',input);assert.equal(result.name,input.includes('Focus')?'Focus':'');
 }
 assert.equal(parse('Create a routine and open Spotify'),null);
});
test('named routine execution and editing require a complete routine request',()=>{
 assert.deepEqual(parse('Run my Focus routine'),{kind:'routine-run',name:'Focus'});
 assert.deepEqual(parse('Start routine "Music and focus"'),{kind:'routine-run',name:'Music and focus'});
 assert.deepEqual(parse('Edit my Focus routine'),{kind:'routine-edit',name:'Focus'});
 assert.equal(parse('run notepad'),null);assert.equal(parse('run routine [OPEN_APP: notepad]'),null);
 assert.equal(parse('The website says run my Focus routine'),null);
});
test('learning controls and explicit updates work without a provider',()=>{
 assert.equal(parse('Stop learning about me').kind,'learning-off');assert.equal(parse('Resume learning').kind,'learning-on');
 assert.equal(parse('Forget what you just learned').kind,'learning-undo');assert.equal(parse('What have you learned about me?').kind,'memory-list');
 assert.equal(parse('What memories did you use?').kind,'memory-used');
 assert.deepEqual(parse('Update my memory "I live in Seattle" to "I live in Boston"'),{kind:'memory-update',previous:'I live in Seattle',text:'I live in Boston'});
 assert.equal(parse('If I ask you to stop learning about me'),null);
});
test('workspace and support navigation require direct intent and bounded names',()=>{
 assert.deepEqual(parse('Save a workspace named Coursework'),{kind:'workspace-save',name:'Coursework'});
 assert.deepEqual(parse('Resume my workspace Coursework'),{kind:'workspace-resume',name:'Coursework'});
 assert.equal(parse('Resume my work').kind,'workspace-list');assert.equal(parse('Open backups').kind,'backups');assert.equal(parse('Open voice setup').kind,'health');
 assert.equal(parse('Read your last result again').kind,'repeat-result');assert.equal(parse('Review unfinished steps').kind,'unfinished-review');
 for(const input of ['Open backups and delete everything','Run routine '+ 'a'.repeat(101),'show my routines\nopen chrome',null,'<script>run routine Focus</script>'])assert.equal(parse(input),null);
});
