const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('fs'),path=require('path');
const mode=process.argv.find(x=>x.startsWith('--mode='))?.split('=')[1]||'normal';
const bounded=!process.argv.includes('--baseline');
const root=path.resolve(__dirname,'..');
const output=fs.mkdtempSync(path.join(require('os').tmpdir(),'sharkord-pcm-memory-'));
require('esbuild').buildSync({entryPoints:[path.join(root,'src/main/pcm-delivery.ts')],outfile:path.join(output,'delivery.cjs'),bundle:true,platform:'node',format:'cjs'});
const {PcmDelivery}=require(path.join(output,'delivery.cjs'));
const delivery=new PcmDelivery();delivery.start(1);
const duration=Number(process.argv.find(x=>x.startsWith('--seconds='))?.split('=')[1]||30);
app.setPath('appData',path.join(output,'appdata-'+mode+(bounded?'-bounded':'')));
app.setPath('userData',path.join(output,'userdata-'+mode+(bounded?'-bounded':'')));
app.commandLine.appendSwitch('js-flags','--expose-gc');
app.commandLine.appendSwitch('enable-precise-memory-info');
const prodPreload=fs.readFileSync(path.join(root,'dist/preload.js'),'utf8');
fs.writeFileSync(path.join(output,'preload.cjs'),prodPreload+'\nrequire("electron").contextBridge.exposeInMainWorld("probe",{ack:()=>require("electron").ipcRenderer.send("probe:ack"), ready:()=>require("electron").ipcRenderer.send("probe:ready")});');
const patch=fs.readFileSync(path.join(root,'dist/patch.js'),'utf8');
let win,timer,sampler,sent=0,acked=0,dropped=0,samples=[],started;
const setup=`
window.stats={created:0,closed:0,pending:0,maxPending:0,received:0,writes:0,gaps:0,lastEnd:0};
const AD=AudioData,G=MediaStreamTrackGenerator;
window.AudioData=function(init){const a=new AD(init);stats.created++;if(init.timestamp>stats.lastEnd+1)stats.gaps++;stats.lastEnd=init.timestamp+init.numberOfFrames/48000*1e6;const close=a.close.bind(a);a.close=()=>{stats.closed++;close()};return a};
window.MediaStreamTrackGenerator=function(init){const g=new G(init),get=g.writable.getWriter.bind(g.writable);g.writable.getWriter=()=>{const w=get(),write=w.write.bind(w);w.write=a=>{stats.pending++;stats.maxPending=Math.max(stats.maxPending,stats.pending);stats.writes++;return write(a).finally(()=>stats.pending--)};return w};return g};
const canvas=document.createElement('canvas');canvas.width=16;canvas.height=16;window.video=canvas.captureStream(1).getVideoTracks()[0];
navigator.mediaDevices.getDisplayMedia=async()=>new MediaStream([video]);
const bridge=window.sharkordDesktop;
window.sharkordDesktopForProbe={...bridge,onPcm:cb=>bridge.onPcm((chunk,firstSample)=>{stats.received++;cb(chunk,firstSample)})};
`;
const injected=setup+patch.replace('var bridge = globals.sharkordDesktop;','var bridge = window.sharkordDesktopForProbe;')+`
(async()=>{window.shared=await navigator.mediaDevices.getDisplayMedia({audio:true});probe.ready()})().catch(e=>console.error(e.stack));
`;
ipcMain.handle('patch:source',()=>injected);
ipcMain.handle('capture:acquire',()=>1);
ipcMain.handle('capture:release',()=>true);
ipcMain.handle('capture:mode',()=>true);
ipcMain.handle('app:info',()=>({version:'probe',platform:process.platform}));
ipcMain.on('pcm:ack',(_event,sessionId,sequence)=>{delivery.acknowledge(sessionId,sequence);acked++;});
ipcMain.on('probe:ready',()=>run());
function memory(){return app.getAppMetrics().map(m=>({pid:m.pid,type:m.type,rssKiB:m.memory.workingSetSize,privateKiB:m.memory.privateBytes,status:fs.existsSync(`/proc/${m.pid}/status`)?fs.readFileSync(`/proc/${m.pid}/status`,'utf8').split('\n').filter(l=>/^Vm(RSS|HWM|Data|Size|Swap):/.test(l)):[]}));}
async function sample(label){let renderer=null;try{renderer=await win.webContents.executeJavaScript('JSON.stringify({stats,...performance.memory&&{heap:performance.memory.usedJSHeapSize}})');}catch(e){renderer=String(e)}samples.push({label,elapsed:Date.now()-started,sent,acked,dropped,outstanding:sent-acked,memory:memory(),renderer:JSON.parse(renderer)});console.log(JSON.stringify(samples.at(-1)));}
async function run(){started=Date.now();await sample('start');
 const chunk=Buffer.alloc(3840); // 10 ms stereo f32
 const rate=(mode==='normal'||mode==='blocked-real')?1:100;
 timer=setInterval(()=>{for(let i=0;i<rate;i++){const packets=bounded?delivery.push(chunk):[{chunk,sessionId:1,sequence:sent+1,firstSample:sent*480}];if(packets.length===0)dropped++;for(const p of packets){win.webContents.send('pcm',p.chunk,p.sessionId,p.sequence,p.firstSample);sent++;}}},10);
 if(mode.startsWith('blocked')) {setTimeout(()=>{void win.webContents.executeJavaScript('const until=performance.now()+10000;while(performance.now()<until){};true');},2000);}
 sampler=setInterval(()=>{samples.push({label:'native',elapsed:Date.now()-started,sent,acked,dropped,outstanding:sent-acked,memory:memory()});console.log(JSON.stringify(samples.at(-1)));},1000);
 setTimeout(async()=>{clearInterval(timer);clearInterval(sampler);await sample('end');await win.webContents.executeJavaScript('shared.getTracks().forEach(t=>t.stop());globalThis.gc?.();true');await new Promise(r=>setTimeout(r,1500));await sample('stopped');fs.writeFileSync(path.join(output,mode+(bounded?'-bounded':'')+'.json'),JSON.stringify({mode,bounded,duration,electron:process.versions.electron,samples},null,2));const maxOutstanding=Math.max(...samples.map(s=>s.outstanding));const renderer=samples.find(s=>s.label==='end').renderer;console.log(JSON.stringify({result:maxOutstanding>12?'FAIL':'PASS',maxOutstanding,dropped,renderer,output}));app.exit(maxOutstanding>12?1:0)},duration*1000);
}
app.whenReady().then(async()=>{win=new BrowserWindow({show:false,webPreferences:{preload:path.join(output,'preload.cjs'),additionalArguments:['--sharkord-capture=pipewire'],backgroundThrottling:false}});win.webContents.on('console-message',(event,...args)=>console.log('renderer',event.message,...args));win.webContents.on('render-process-gone',(_,d)=>{console.log(d);app.exit(2)});fs.writeFileSync(path.join(output,'fixture.html'),'<title>PCM memory regression fixture</title>');await win.loadFile(path.join(output,'fixture.html'));});
setTimeout(()=>{console.error('watchdog');app.exit(3)},(duration+25)*1000);
