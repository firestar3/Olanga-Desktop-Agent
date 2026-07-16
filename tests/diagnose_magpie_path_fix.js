const { app, safeStorage } = require('electron');
const http2 = require('http2');
const fs = require('fs');
const path = require('path');
app.setName('olanga-control');
const FID = '877104f7-e885-42b9-8de8-f6e4c6303969';
const PATHS = [
  '/nvidia.riva.tts.RivaSpeechSynthesis/Synthesize',
  '/nvidia.riva.tts.RivaSpeechSynthesis/GetRivaSynthesisConfig',
  '/nvidia.riva.RivaSpeechSynthesis/Synthesize'
];
function encodeVarint(v){let c=v>>>0;const b=[];while(c>127){b.push((c&0x7f)|0x80);c>>>=7;}b.push(c);return Uint8Array.from(b);}
function fld(n,t,b){const u=new Uint8Array(b);const out=[];out.push(encodeVarint((n<<3)|t));if(t===2){out.push(encodeVarint(u.length));out.push(u);}else out.push(encodeVarint(b));return Buffer.concat(out.map(x=>Buffer.from(x)));}
function buildReq(){
  return Buffer.concat([
    fld(1,2,Buffer.from('Hello from corrected path test.','utf8')),
    fld(2,2,Buffer.from('en-US','utf8')),
    fld(3,0,1),
    fld(4,0,22050),
    fld(5,2,Buffer.from('Magpie-Multilingual.EN-US.Sofia','utf8'))
  ]);
}
function frame(msg){const p=Buffer.from(msg);const f=Buffer.allocUnsafe(5+p.length);f.writeUInt8(0,0);f.writeUInt32BE(p.length,1);p.copy(f,5);return f;}
function call(apiKey, pathName, body){
  return new Promise((resolve)=>{
    const c=http2.connect('https://grpc.nvcf.nvidia.com:443');
    let hdr={}, tr={}, chunks=[];
    const req=c.request({':method':'POST',':path':pathName,':scheme':'https',':authority':'grpc.nvcf.nvidia.com:443','content-type':'application/grpc','te':'trailers','authorization':`Bearer ${apiKey}`,'function-id':FID});
    req.on('response',h=>hdr=h); req.on('data',d=>chunks.push(d)); req.on('trailers',t=>tr=t);
    req.on('end',()=>{c.close(); resolve({pathName, http:hdr[':status'], gs:tr['grpc-status']||hdr['grpc-status'], gm:tr['grpc-message']||hdr['grpc-message']||'', bytes:Buffer.concat(chunks).length});});
    req.end(frame(body));
  });
}
app.whenReady().then(async()=>{
  const store=JSON.parse(fs.readFileSync(path.join(app.getPath('userData'),'secure-store.json'),'utf8'));
  const apiKey=safeStorage.decryptString(Buffer.from(store.nvidia_api_key,'base64')).trim();
  console.log('KEY_PREFIX', apiKey.slice(0,8)+'...');
  const body=buildReq();
  for (const p of PATHS){
    const empty = p.includes('GetRiva') ? Buffer.alloc(0) : body;
    const r=await call(apiKey,p,empty);
    console.log(JSON.stringify(r));
  }
  app.exit(0);
});
