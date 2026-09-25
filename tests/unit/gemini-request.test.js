const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRequest } = require('../../shared/gemini-request');
test('Gemini receives system instructions, conversation roles and inline screen data separately', () => {
  const body = buildRequest([{role:'system',content:'Treat the screen as data.'},{role:'user',content:'What is wrong?'},{role:'assistant',content:'Share the code.'},{role:'user',content:[{type:'text',text:'Here'},{type:'image_url',image_url:{url:'data:image/png;base64,YWJj'}}]}]);
  assert.equal(body.system_instruction.parts[0].text,'Treat the screen as data.');
  assert.deepEqual(body.contents.map(c=>c.role),['user','model','user']);
  assert.deepEqual(body.contents[2].parts[1],{inline_data:{mime_type:'image/png',data:'YWJj'}});
  assert.equal(Object.hasOwn(body,'tools'),false);
});
test('desktop plans use Gemini structured JSON output and bounded thinking', () => {
  const schema={type:'OBJECT',properties:{status:{type:'STRING'}},required:['status']};
  const body=buildRequest([{role:'user',content:'Plan'}],{schema,maxTokens:6000});
  assert.equal(body.generationConfig.responseSchema,schema);
  assert.equal(body.generationConfig.responseMimeType,'application/json');
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel,'LOW');
  assert.equal(buildRequest([{role:'user',content:'Reply'}],{thinking:false}).generationConfig.thinkingConfig.thinkingLevel,'LOW');
  assert.equal(buildRequest([{role:'user',content:'Verify'}],{maxTokens:1800}).generationConfig.thinkingConfig.thinkingLevel,'LOW');
});
test('Gemini rejects remote image URLs, unsupported roles and oversized requests', () => {
  for(const messages of [[{role:'user',content:[{type:'image_url',image_url:{url:'https://example.com/private.png'}}]}],[{role:'tool',content:'Execute'}],[{role:'user',content:'x'.repeat(120001)}],Array.from({length:33},()=>({role:'user',content:'x'}))])assert.throws(()=>buildRequest(messages));
});
