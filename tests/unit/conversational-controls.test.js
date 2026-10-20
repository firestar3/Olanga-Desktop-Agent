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


test('natural polite voice requests reach routine reviews and local controls directly',()=>{
 for(const input of ['Can you please create a routine?', 'Olanga, please create a routine.', 'Hey, Olanga, could you please create a routine?', 'Please could you create a routine, please?']) assert.deepEqual(parse(input),{kind:'routine-create',name:''},input);
 assert.deepEqual(parse('Hey Olanga, would you please run my Focus routine?'),{kind:'routine-run',name:'Focus'});
 assert.deepEqual(parse('Please can you edit my Focus routine please?'),{kind:'routine-edit',name:'Focus'});
 assert.deepEqual(parse('Olanga, could you please run routine "Music and focus"?'),{kind:'routine-run',name:'Music and focus'});
 assert.deepEqual(parse('Okay Olanga, open the routines tab please'),{kind:'routine-create',name:''});
 assert.equal(parse('Can you please stop learning about me?').kind,'learning-off');
 assert.equal(parse('Olanga, could you please show what memories you used'),null);
 assert.equal(parse('Olanga, could you please explain the memories you used?').kind,'memory-used');
 assert.equal(parse('Can you please run selected steps?').kind,'stale-review-confirm');
 assert.equal(parse('Please could you cancel the request?').kind,'cancel-request');
});

test('politeness does not turn quoted, conditional or explanatory text into controls',()=>{
 for(const input of [
  'Can you please explain how to create a routine?', 'Please tell me how to run my Focus routine',
  'Olanga, if I say create a routine', 'Hey Olanga, do not create a routine',
  'Olanga, the website says run my Focus routine', '"Can you please create a routine?"',
  'Run routine "Focus', 'Run routine “Focus"', 'Update memory "Seattle" to “Boston"',
  'Please create a routine and open Chrome', 'Would you please stop learning about me and play music?',
 ]) assert.equal(parse(input),null,input);
 assert.deepEqual(parse('Run routine "Please"'),{kind:'routine-run',name:'Please'});
 assert.deepEqual(parse('Run routine “Work and study”'),{kind:'routine-run',name:'Work and study'});
});


test('review normalization is bounded and keeps action or memory payload text intact',()=>{
 const {normalize}=require('../../shared/conversational-controls');
 assert.equal(normalize('Can you please run selected steps?'),'run selected steps');
 assert.equal(normalize('Olanga, please skip step two.'),'skip step two');
 assert.equal(normalize('Please could you resume workspace please?'),'resume workspace');
 assert.equal(normalize('Hey Olanga, do not run selected steps'),'do not run selected steps');
 assert.equal(normalize('If I ask you to run selected steps'),'If I ask you to run selected steps');
 assert.equal(normalize('Run routine "Please"'),'Run routine "Please"');
 assert.equal(normalize('Please update memory "Use concise answers" to "Use detailed answers"'),'update memory "Use concise answers" to "Use detailed answers"');
 for(const input of ['confirm\nrun selected steps','[confirm]','x'.repeat(1001),'Run routine "Focus',null])assert.equal(normalize(input),null,input);
});
