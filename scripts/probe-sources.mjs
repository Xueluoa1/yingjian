import fs from 'node:fs/promises';
const seed=JSON.parse(await fs.readFile(new URL('../config/initial-sources.json',import.meta.url),'utf8'));
const results=[]; let cursor=0;
async function worker(){while(cursor<seed.sources.length){const source=seed.sources[cursor++];const start=Date.now();let result={id:source.id,name:source.name,url:source.url};try{const url=new URL(source.url);url.searchParams.set('ac','videolist');url.searchParams.set('wd','地球');const response=await fetch(url,{signal:AbortSignal.timeout(15000),headers:{'User-Agent':'Mozilla/5.0 (compatible; YingjianLAN/0.1)'}});if(!response.ok)throw new Error(`HTTP ${response.status}`);const body=await response.text();let data;try{data=JSON.parse(body)}catch{throw new Error('返回的不是 JSON 采集接口')};if(!Array.isArray(data.list)&&data.list!==null)throw new Error('缺少 Apple CMS list 字段');result={...result,ok:true,latency:Date.now()-start,count:data.list?.length||0};}catch(error){result={...result,ok:false,latency:Date.now()-start,error:error.message,cause:error.cause?.code||''}}results.push(result);console.log(`${result.ok?'OK':'FAIL'} ${result.name} ${result.latency}ms ${result.ok?result.count+' results':result.error+' '+result.cause}`)}}
await Promise.all(Array.from({length:4},worker));
results.sort((a,b)=>Number(a.id.split('-')[1])-Number(b.id.split('-')[1]));
await fs.mkdir(new URL('../test-results/',import.meta.url),{recursive:true});
await fs.writeFile(new URL('../test-results/source-probe.json',import.meta.url),JSON.stringify({checkedAt:new Date().toISOString(),query:'地球',sourceRepository:seed.origin,results},null,2));
console.log(`Reachable ${results.filter(x=>x.ok).length}/${results.length}`);
