'use strict';
const fs=require('node:fs');
const {comparePerformance}=require('../tests/helpers/performance-budget');
const [baseline,candidate,output]=process.argv.slice(2);
if(!baseline||!candidate)throw Error('Usage: node scripts/check-performance-budget.js baseline.json candidate.json [report.json]');
const report=comparePerformance(JSON.parse(fs.readFileSync(baseline)),JSON.parse(fs.readFileSync(candidate)));
if(output)fs.writeFileSync(output,JSON.stringify(report,null,2));
console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,failures:report.checks.filter(check=>!check.passed)},null,2));
process.exitCode=report.passed?0:1;
