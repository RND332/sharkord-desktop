// Hidden Electron with synthetic WebRTC input and a private null output.
const { app, BrowserWindow, ipcMain } = require('electron');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createServer } = require('node:http');
const root = process.env.SHARKORD_AUDIO_FIXTURE_DIR;
if (!root || process.env.PULSE_SERVER !== `unix:${root}/native`) throw new Error('Private audio server required');
app.setPath('userData', join(root, 'profile'));
app.setPath('appData', join(root, 'appdata'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const mode = process.env.SHARKORD_AUDIO_PROBE_MODE || 'automatic';
if (!['automatic', 'baseline'].includes(mode)) throw new Error('Expected automatic or baseline mode');
const preferences = process.env.SHARKORD_AUDIO_PROBE_CASE === 'preferences';
const fixtureStreams = process.env.SHARKORD_AUDIO_PROBE_FAULT === 'missing-stream' ? 1 : 2;
const candidate = process.env.SHARKORD_AUDIO_CANDIDATE || join(__dirname, '../..');
if (mode === 'automatic') {
  ipcMain.handle('app:info', () => ({ version: 'audio-regression-fixture', platform: process.platform }));
  ipcMain.handle('patch:source', () => readFileSync(join(candidate, 'dist/patch.js'), 'utf8'));
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let window;
let done = false;
const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>Isolated audio regression</title><body></body>');
});
const finish = (code, value) => {
  if (done) return;
  done = true;
  console.log(JSON.stringify({ mode, ...value }));
  server.close();
  app.exit(code);
};
setTimeout(() => finish(1, { error: 'native probe deadline' }), 30000).unref();
app.whenReady().then(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, preload: mode === 'automatic' ? join(candidate, 'dist/preload.js') : undefined } });
  window.webContents.on('console-message', (_event, ...args) => console.log('renderer', ...args));
  await window.loadURL(`http://127.0.0.1:${server.address().port}`);
  if (mode === 'automatic') {
    for (let i = 0; i < 30; i++) {
      if (await window.webContents.executeJavaScript('!!document.querySelector("[data-sharkord-desktop-version]")')) break;
      await sleep(100);
    }
    if (!await window.webContents.executeJavaScript('!!document.querySelector("[data-sharkord-desktop-version]")')) throw new Error('Production preload/patch not ready');
  }
  await window.webContents.executeJavaScript(`(async () => {
    const send = new RTCPeerConnection();
    const recv = new RTCPeerConnection();
    const received = [];
    const elements = [];
    const generators = [];
    send.onicecandidate = e => e.candidate && recv.addIceCandidate(e.candidate);
    recv.onicecandidate = e => e.candidate && send.addIceCandidate(e.candidate);
    recv.ontrack = async e => {
      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.srcObject = new MediaStream([e.track]);
      audio.volume = elements.length ? 0.35 : 0.7;
      elements.push(audio);
      received.push(e.track);
      document.body.append(audio);
      await audio.play();
    };
    for (let index = 0; index < ${fixtureStreams}; index++) {
      const generator = new MediaStreamTrackGenerator({ kind: 'audio' });
      const writer = generator.writable.getWriter();
      let sample = 0;
      let writing = false;
      setInterval(async () => {
        if (writing) return;
        writing = true;
        const samples = new Float32Array(960);
        for (let i = 0; i < samples.length; i++) samples[i] = 0.1 * Math.sin(2 * Math.PI * (440 + index * 220) * (sample + i) / 48000);
        const frame = new AudioData({ format: 'f32', sampleRate: 48000, numberOfFrames: 960, numberOfChannels: 1, timestamp: Math.round(sample * 1000000 / 48000), data: samples });
        sample += 960;
        try { await writer.write(frame); } finally { frame.close(); writing = false; }
      }, 20);
      generators.push(generator);
      send.addTrack(generator, new MediaStream([generator]));
    }
    await send.setLocalDescription(await send.createOffer());
    await recv.setRemoteDescription(send.localDescription);
    await recv.setLocalDescription(await recv.createAnswer());
    await send.setRemoteDescription(recv.localDescription);
    window.fixture = { send, recv, elements, received, generators };
    window.sample = async () => {
      const report = [...(await recv.getStats()).values()];
      return {
        connection: recv.connectionState,
        elements: elements.map(e => ({ paused: e.paused, error: e.error?.code ?? null, volume: e.volume, muted: e.muted, sinkId: e.sinkId, source: e.srcObject?.id })),
        audio: report.filter(r => r.type === 'inbound-rtp' && r.kind === 'audio').map(r => ({ id: r.id, packets: r.packetsReceived, duration: r.totalSamplesDuration, energy: r.totalAudioEnergy })),
        playout: report.filter(r => r.type === 'media-playout').map(r => ({ samples: r.totalSamplesCount, duration: r.totalSamplesDuration }))
      };
    };
  })()`);
  let expectedIds;
  let expectedElements = 2;
  const sample = async () => {
    const value = await window.webContents.executeJavaScript('window.sample()');
    if (expectedIds && (value.connection !== 'connected' || value.audio.length !== 2 ||
        new Set(value.audio.map(r => r.id)).size !== 2 || value.audio.some(r => !expectedIds.has(r.id)) ||
        value.elements.length !== expectedElements)) {
      throw new Error(`Expected the same two connected audio streams: ${JSON.stringify(value)}`);
    }
    return value;
  };
  let ready;
  for (let i = 0; i < 35; i++) {
    ready = await sample();
    if (ready.playout[0]?.duration > 0.5 && ready.audio.length === 2) break;
    await sleep(200);
  }
  if (!(ready.playout[0]?.duration > 0.5)) throw new Error(`No real audio playout: ${JSON.stringify(ready)}`);
  if (ready.audio.length !== 2 || ready.elements.length !== 2 ||
      new Set(ready.audio.map(r => r.id)).size !== 2) throw new Error(`Expected exactly two incoming audio streams: ${JSON.stringify(ready)}`);
  expectedIds = new Set(ready.audio.map(r => r.id));
  if (preferences) await window.webContents.executeJavaScript(`(async () => {
    const { elements } = window.fixture;
    await elements[0].setSinkId('default');
    elements[1].muted = true;
    const paused = document.createElement('audio');
    paused.autoplay = true;
    paused.srcObject = elements[0].srcObject;
    paused.volume = 0.2;
    document.body.append(paused);
    await paused.play();
    paused.pause();
    elements.push(paused);
    await new Promise(resolve => setTimeout(resolve, 50));
  })()`);
  if (preferences) expectedElements = 3;
  const before = await sample();
  await sleep(1500);
  const running = await sample();
  if (running.playout[0].duration - before.playout[0].duration < 1) throw new Error('Pre-crash audio did not progress');
  const metric = app.getAppMetrics().find(m => m.type === 'Utility' && m.serviceName === 'audio.mojom.AudioService');
  if (!metric) throw new Error(`No fixture AudioService: ${JSON.stringify(app.getAppMetrics().map(m => ({ pid: m.pid, type: m.type, name: m.name, serviceName: m.serviceName })))}`);
  const status = readFileSync(`/proc/${metric.pid}/status`, 'utf8');
  if (!status.includes(`PPid:\t${process.pid}\n`)) throw new Error('Refusing to terminate an AudioService outside this fixture');
  const gone = new Promise(resolve => app.once('child-process-gone', (_event, details) => resolve(details)));
  console.log(JSON.stringify({ step: 'terminate fixture AudioService', pid: metric.pid, parent: process.pid }));
  process.kill(metric.pid, 'SIGKILL');
  const goneDetails = await gone;
  await sleep(400);
  const interrupted = await sample();
  await sleep(1500);
  const stalled = await sample();
  const stalledPlayoutDelta = stalled.playout[0].duration - interrupted.playout[0].duration;
  const interruptedById = new Map(interrupted.audio.map(r => [r.id, r]));
  const stalledPacketDeltas = stalled.audio.map(r => r.packets - interruptedById.get(r.id).packets);
  if (stalledPacketDeltas.some(delta => delta < 30)) throw new Error('Fixture RTP did not continue after AudioService termination');
  if (mode !== 'automatic' && stalledPlayoutDelta > 0.1) throw new Error('Did not reproduce continued RTP with stalled playout');
  await sleep(400);
  const recoveryStart = await sample();
  await sleep(1500);
  const recoveryEnd = await sample();
  const recoveredDelta = recoveryEnd.playout[0].duration - recoveryStart.playout[0].duration;
  const recoveryStartById = new Map(recoveryStart.audio.map(r => [r.id, r]));
  if (mode === 'automatic' && recoveryEnd.audio.some(r =>
      r.duration - recoveryStartById.get(r.id).duration < 1 ||
      (!preferences && r.energy <= recoveryStartById.get(r.id).energy))) {
    throw new Error('Both incoming audio streams must decode after recovery');
  }
  if (mode === 'automatic' && recoveryEnd.elements.some((e, i) => e.source !== before.elements[i].source || e.volume !== before.elements[i].volume || e.muted !== before.elements[i].muted || e.sinkId !== before.elements[i].sinkId || e.paused !== before.elements[i].paused || e.error)) throw new Error(`Recovery lost media identity/preferences or left an errored element: ${JSON.stringify({ before, recoveryEnd })}`);
  if (window.isVisible()) throw new Error('Fixture window became visible');
  finish(recoveredDelta > 1 ? 0 : 2, { goneDetails, before, running, interrupted, stalled, stalledPlayoutDelta, stalledPacketDeltas, recoveryStart, recoveryEnd, recoveredDelta });
}).catch(error => finish(1, { error: error.stack }));
