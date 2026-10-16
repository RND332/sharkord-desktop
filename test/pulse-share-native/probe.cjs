// private PulseAudio -> production tap/preload/patch -> real WebRTC audio, without a system picker.
const { app, BrowserWindow, ipcMain } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { spawn } = require('node:child_process');
const { buildSync } = require('esbuild');
const fixture = process.env.SHARKORD_SHARE_FIXTURE;
const selectedPid = Number(process.env.SHARKORD_SHARE_SELECTED_PID);
const mode = process.env.SHARKORD_SHARE_MODE;
if (!fixture || process.env.PULSE_SERVER !== `unix:${fixture}/native` || !Number.isSafeInteger(selectedPid)) {
  throw new Error('Private share runner required');
}
const root = join(__dirname, '../..');
const tapEntry = process.env.SHARKORD_SHARE_TAP_ENTRY || join(root, 'src/main/tap.ts');
for (const [name, entry] of [['tap', tapEntry], ['delivery', join(root, 'src/main/pcm-delivery.ts')]]) {
  buildSync({ entryPoints: [entry], outfile: join(fixture, `${name}.cjs`), bundle: true, platform: 'node', format: 'cjs' });
}
const { TapCapture, readProcessIdentity, parseGraph, defaultRunner } = require(join(fixture, 'tap.cjs'));
const { PcmDelivery } = require(join(fixture, 'delivery.cjs'));
const tapName = `sharkord_share_fixture_${process.pid}`;
const tap = new TapCapture({ tapName, pollMs: 80, log: (...args) => console.log('fixture tap:', ...args) });
const delivery = new PcmDelivery();
app.setPath('userData', join(fixture, 'profile'));
app.setPath('appData', join(fixture, 'appdata'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
let window;
let own;
let finished = false;
let bytes = 0;
let peak = 0;
let invalid = 0;
let acknowledgements = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const finish = async (code, result) => {
  if (finished) return;
  finished = true;
  tap.stop();
  delivery.stop();
  own?.kill();
  await sleep(180);
  try {
    const graph = parseGraph(await defaultRunner('pw-dump', ['-i', '0']), tapName);
    result.tapRemoved = graph.tapNodeId === null;
    if (!result.tapRemoved) code = 1;
  } catch (error) {
    result.cleanupError = String(error);
    code = 1;
  }
  console.log(JSON.stringify({ mode, ...result }));
  app.exit(code);
};
ipcMain.handle('app:info', () => ({ version: 'share-audio-fixture', platform: 'linux' }));
ipcMain.handle('patch:source', () => `
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const sourceVideo = canvas.captureStream(10);
  navigator.mediaDevices.getDisplayMedia = async () => sourceVideo;
` + readFileSync(join(root, 'dist/patch.js'), 'utf8'));
ipcMain.handle('capture:mode', () => true);
ipcMain.handle('capture:acquire', () => {
  const identity = readProcessIdentity(selectedPid);
  if (!identity) throw new Error('Selected fixture ended');
  delivery.start(1);
  if (!tap.start(mode === 'screen' ? { kind: 'screen' } : {
    kind: 'application', processId: selectedPid, processStartTime: identity.startTime
  })) throw new Error('Tap did not start');
  return 1;
});
ipcMain.handle('capture:release', () => { tap.stop(); delivery.stop(); return true; });
ipcMain.on('pcm:ack', (_event, session, sequence) => { acknowledgements++; delivery.acknowledge(session, sequence); });
tap.onData(chunk => {
  bytes += chunk.length;
  for (let i = 0; i + 4 <= chunk.length; i += 4) {
    const sample = chunk.readFloatLE(i);
    if (!Number.isFinite(sample)) invalid++;
    else peak = Math.max(peak, Math.abs(sample));
  }
  for (const packet of delivery.push(chunk)) {
    if (!window.isDestroyed()) window.webContents.send('pcm', packet.chunk, packet.sessionId, packet.sequence, packet.firstSample);
  }
});
setTimeout(() => finish(1, { error: 'share audio deadline' }), 12000).unref();
app.whenReady().then(async () => {
  own = spawn('paplay', ['--device=fixture_sink', join(fixture, '1760.wav')], { stdio: 'ignore' });
  window = new BrowserWindow({ show: false, webPreferences: {
    backgroundThrottling: false, preload: join(root, 'dist/preload.js'), additionalArguments: ['--sharkord-capture=pipewire']
  } });
  writeFileSync(join(fixture, 'index.html'), '<title>Private screen audio regression</title>');
  await window.loadFile(join(fixture, 'index.html'));
  for (let i = 0; i < 40; i++) {
    if (await window.webContents.executeJavaScript('!!document.querySelector("[data-sharkord-desktop-version]")')) break;
    await sleep(50);
  }
  const result = await window.webContents.executeJavaScript(`(async () => {
    const shared = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    const [track] = shared.getAudioTracks();
    if (!track) throw new Error('Production patch returned no audio');
    const sender = new RTCPeerConnection();
    const receiver = new RTCPeerConnection();
    sender.onicecandidate = event => event.candidate && receiver.addIceCandidate(event.candidate);
    receiver.onicecandidate = event => event.candidate && sender.addIceCandidate(event.candidate);
    const received = new Promise(resolve => { receiver.ontrack = event => resolve(event.track); });
    sender.addTrack(track, shared);
    await sender.setLocalDescription(await sender.createOffer());
    await receiver.setRemoteDescription(sender.localDescription);
    await receiver.setLocalDescription(await receiver.createAnswer());
    await sender.setRemoteDescription(receiver.localDescription);
    const remoteTrack = await received;
    const audio = document.createElement('audio');
    audio.srcObject = new MediaStream([remoteTrack]);
    document.body.append(audio);
    await audio.play();
    const context = new AudioContext({ sampleRate: 48000 });
    const analyser = context.createAnalyser();
    analyser.fftSize = 32768;
    analyser.smoothingTimeConstant = 0;
    context.createMediaStreamSource(new MediaStream([remoteTrack])).connect(analyser);
    const silent = context.createGain(); silent.gain.value = 0;
    analyser.connect(silent).connect(context.destination);
    await context.resume();
    await new Promise(resolve => setTimeout(resolve, 3500));
    const bins = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(bins);
    const level = hz => {
      const bin = Math.round(hz * analyser.fftSize / context.sampleRate);
      return Math.max(...bins.slice(bin - 3, bin + 4));
    };
    const stats = [...(await receiver.getStats()).values()].find(r => r.type === 'inbound-rtp' && r.kind === 'audio');
    const output = { selected440dB: level(440), unrelated880dB: level(880), own1760dB: level(1760),
      connection: receiver.connectionState, packets: stats?.packetsReceived, energy: stats?.totalAudioEnergy,
      sender: [...(await sender.getStats()).values()].filter(r => r.type === 'media-source').map(r => ({kind:r.kind,audioLevel:r.audioLevel,totalAudioEnergy:r.totalAudioEnergy})),
      track: {enabled: track.enabled, muted: track.muted, state: track.readyState} };
    shared.getTracks().forEach(track => track.stop());
    sender.close(); receiver.close(); await context.close();
    return output;
  })()`);
  const unrelatedOk = mode === 'screen' ? result.unrelated880dB > -45 : result.unrelated880dB < -55;
  const passed = result.selected440dB > -45 && unrelatedOk && result.own1760dB < -55 &&
    result.connection === 'connected' && result.packets > 30 && result.energy > 0 && !window.isVisible();
  await finish(passed ? 0 : 1, { ...result, bytes, peak, invalid, acknowledgements, hidden: !window.isVisible(), passed });
}).catch(error => finish(1, { error: error.stack }));
