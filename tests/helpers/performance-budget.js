'use strict';
const PHASES=['visible-idle','visible-settings','tray-idle','visible-voice-ready','tray-voice-ready','tray-muted','visible-muted'];
// Defined before candidate measurements. These tolerate normal desktop noise;
// passing is a regression budget, not proof of a performance improvement.
const BUDGETS=Object.freeze({
 privateWorkingSetMiB: {ratio:1.20, allowance:16},
 workingSetP95MiB: {ratio:1.20, allowance:16},
 cpuP95: {ratio:1.35, allowance:2}
});
function comparePerformance(baseline,candidate){
 if(!baseline?.passed||!candidate?.passed)throw Error('Both complete benchmark runs must pass.');
 if(baseline.logicalProcessors!==candidate.logicalProcessors)throw Error('Use the same machine and logical processor count.');
 if(!baseline.syntheticMicrophone||!candidate.syntheticMicrophone||baseline.physicalMicrophone||candidate.physicalMicrophone||baseline.providerCalls||candidate.providerCalls)throw Error('These budgets require matching synthetic microphone, provider-free runs.');
 const checks=[];
 const add=(name,before,after,rule)=>{
  if(!Number.isFinite(before)||before<0||!Number.isFinite(after)||after<0)throw Error('Missing valid metric: '+name);
  const limit=Math.max(before*rule.ratio,before+rule.allowance);
  checks.push({name,baseline:before,candidate:after,limit,passed:after<=limit});
 };
 for(const phase of PHASES){
  const before=baseline.phases.find(item=>item.name===phase),after=candidate.phases.find(item=>item.name===phase);
  if(!before||!after)throw Error('Missing required phase: '+phase);
  for(const [metric,rule] of Object.entries(BUDGETS))add(phase+':'+metric,before.summary[metric],after.summary[metric],rule);
 }
 add('startup-ready-ms',baseline.startupReadyMs,candidate.startupReadyMs,{ratio:1.35,allowance:1000});
 if(baseline.coldVoiceResume?.samples<3||candidate.coldVoiceResume?.samples<3)throw Error('At least three cold resume samples are required.');
 add('cold-voice-resume-p95-ms',baseline.coldVoiceResume?.p95,candidate.coldVoiceResume?.p95,{ratio:1.35,allowance:500});
 return {passed:checks.every(check=>check.passed),checks,budgets:BUDGETS,coverage:'One Windows machine; synthetic microphone; no cloud or acoustic latency.'};
}
module.exports={comparePerformance,PHASES,BUDGETS};
