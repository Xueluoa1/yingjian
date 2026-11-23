// Local design preview only. Not the LibreTV backend.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.md':'text/plain; charset=utf-8'};
const port = Number(process.env.PREVIEW_PORT || 4173);
http.createServer((req,res)=>{
 let file;
 try {const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);file=path.resolve(root, '.'+(pathname==='/'?'/index.html':pathname));}
 catch {res.writeHead(400);return res.end('Bad request');}
 if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end('Forbidden');}
 fs.stat(file,(error,stat)=>{if(error||!stat.isFile()){res.writeHead(404);return res.end('Not found');}res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});fs.createReadStream(file).pipe(res);});
}).listen(port,'127.0.0.1',()=>console.log(`Yingjian UI preview: http://127.0.0.1:${port}`));
