const test=require('node:test'),assert=require('node:assert/strict');
const {comparePerformance,PHASES}=require('../helpers/performance-budget');
const fixture=()=>({passed:true,logicalProcessors:16,syntheticMicrophone:true,physicalMicrophone:false,providerCalls:false,startupReadyMs:1000,coldVoiceResume:{samples:3,p95:2000},phases:PHASES.map(name=>({name,summary:{privateWorkingSetMiB:200,workingSetP95MiB:400,cpuP95:1}}))});
test('performance budgets accept measured desktop noise but flag material memory, CPU and wake regressions',()=>{
 const baseline=fixture(),candidate=fixture();
 candidate.phases[0].summary.cpuP95=2;
 assert.equal(comparePerformance(baseline,candidate).passed,true);
 candidate.phases[0].summary.privateWorkingSetMiB=300;
 candidate.phases[1].summary.cpuP95=7;
 candidate.coldVoiceResume.p95=8000;
 const report=comparePerformance(baseline,candidate);assert.equal(report.passed,false);assert.equal(report.checks.filter(check=>!check.passed).length,3);
});
test('incomplete, different-machine and incompatible coverage cannot pass a performance budget',()=>{
 for(const change of [v=>v.passed=false,v=>v.logicalProcessors=4,v=>v.providerCalls=true,v=>v.phases.pop(),v=>v.coldVoiceResume.samples=1,v=>v.phases[0].summary.cpuP95=NaN]){
  const candidate=fixture();change(candidate);assert.throws(()=>comparePerformance(fixture(),candidate));
 }
});
