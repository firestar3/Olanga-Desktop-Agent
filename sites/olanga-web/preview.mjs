import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const pagesPreview = process.argv.includes('--pages');
const basePath = pagesPreview ? '/Olanga-Desktop-Agent/' : '/';
const port = pagesPreview ? 4174 : 4173;
const types = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.mp4':'video/mp4', '.webm':'video/webm', '.vtt':'text/vtt; charset=utf-8', '.ttf':'font/ttf', '.txt':'text/plain; charset=utf-8' };
const server = http.createServer(async (req,res) => {
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{'Allow':'GET, HEAD'});res.end();return;}
  try {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url,'http://localhost').pathname); }
    catch {res.writeHead(400);res.end('Bad request');return;}
    if(pagesPreview && pathname === basePath.slice(0,-1)){res.writeHead(301,{Location:basePath});res.end();return;}
    if(!pathname.startsWith(basePath)){res.writeHead(404);res.end('Not found');return;}
    const target = path.resolve(root,pathname.slice(basePath.length) || 'index.html');
    if(!target.startsWith(root+path.sep)){res.writeHead(403);res.end('Forbidden');return;}
    const stat = await fs.stat(target);
    if(!stat.isFile()){res.writeHead(404);res.end('Not found');return;}
    const headers={'Content-Type':types[path.extname(target)]||'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes'};
    let start=0,end=stat.size-1,status=200;
    if(req.headers.range){
      const range=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if(!range||(!range[1]&&!range[2])){res.writeHead(416,{'Content-Range':`bytes */${stat.size}`});res.end();return;}
      if(range[1]){start=Number(range[1]);if(range[2])end=Math.min(Number(range[2]),end);}
      else {start=Math.max(0,stat.size-Number(range[2]));}
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=stat.size){res.writeHead(416,{'Content-Range':`bytes */${stat.size}`});res.end();return;}
      status=206;headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`;
    }
    headers['Content-Length']=String(Math.max(0,end-start+1));
    res.writeHead(status,headers);
    if(req.method==='HEAD'||stat.size===0){res.end();return;}
    const stream=createReadStream(target,{start,end});
    stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
  }catch{if(!res.headersSent)res.writeHead(404,{'Content-Type':'text/plain'});res.end('Not found');}
});
server.listen(port,'127.0.0.1',()=>console.log(`Olanga preview: http://127.0.0.1:${port}${basePath}`));
