import array
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import wave

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
mode = sys.argv[1] if len(sys.argv) > 1 else 'application'
if mode not in ('application', 'screen'):
    raise RuntimeError('Expected application or screen')
runtime = Path(tempfile.mkdtemp(prefix='sharkord-share-audio-', dir=os.environ.get('TMPDIR')))
env = {**os.environ, 'PIPEWIRE_CONFIG_DIR': str(runtime), 'PIPEWIRE_RUNTIME_DIR': str(runtime), 'PIPEWIRE_REMOTE': str(runtime / 'pipewire-0'),
       'PULSE_RUNTIME_PATH': str(runtime), 'PULSE_SERVER': f'unix:{runtime}/native',
       'PULSE_SINK': 'fixture_sink', 'SHARKORD_SHARE_FIXTURE': str(runtime), 'SHARKORD_SHARE_MODE': mode}
children = []
logs = []
try:
    config = (ROOT / 'test/audio-playback-native/pipewire.conf').read_text()
    (runtime / 'pipewire.conf').write_text(config.replace('    { name = libpipewire-module-protocol-pulse }\n', ''))
    (runtime / 'pulse.conf').write_text('''context.properties = { support.dbus = false }
context.spa-libs = { audio.convert.* = audioconvert/libspa-audioconvert support.* = support/libspa-support }
context.modules = [
 { name = libpipewire-module-protocol-native }
 { name = libpipewire-module-client-node }
 { name = libpipewire-module-adapter }
 { name = libpipewire-module-metadata }
 { name = libpipewire-module-protocol-pulse }
]
pulse.properties = { server.address = [ "unix:native" ] server.dbus-name = "" }
stream.properties = { node.autoconnect = false adapter.auto-port-config = { mode = dsp monitor = false position = preserve } }
''')
    for frequency in (440, 880, 1760):
        with wave.open(str(runtime / f'{frequency}.wav'), 'wb') as wav:
            wav.setparams((2, 2, 48000, 0, 'NONE', 'not compressed'))
            samples = array.array('h', (int(3000 * math.sin(2 * math.pi * frequency * (i // 2) / 48000)) for i in range(48000 * 12 * 2)))
            wav.writeframes(samples.tobytes())
    (runtime / 'client.conf').write_text((runtime / 'pulse.conf').read_text().replace(' { name = libpipewire-module-protocol-pulse }\n', ''))
    for binary, config_name in [('pipewire', 'pipewire.conf'), ('pipewire-pulse', 'pulse.conf')]:
        log = open(runtime / f'{binary}.log', 'w')
        logs.append(log)
        children.append(subprocess.Popen([binary, '-c', str(runtime / config_name)], env=env, stdout=log, stderr=subprocess.STDOUT))
        socket = runtime / ('pipewire-0' if binary == 'pipewire' else 'native')
        for _ in range(40):
            if socket.exists():
                break
            if children[-1].poll() is not None:
                raise RuntimeError(f'{binary} failed: {(runtime / f"{binary}.log").read_text()}')
            time.sleep(0.05)
        if not socket.exists():
            raise RuntimeError(f'No private {binary} socket')
    selected = subprocess.Popen(['paplay', '--device=fixture_sink', str(runtime / '440.wav')], env=env)
    unrelated = subprocess.Popen(['paplay', '--device=fixture_sink', str(runtime / '880.wav')], env=env)
    children += [selected, unrelated]
    env['SHARKORD_SHARE_SELECTED_PID'] = str(selected.pid)
    log = open(runtime / 'native.log', 'w')
    logs.append(log)
    electron = subprocess.Popen([str(ROOT / 'node_modules/electron/dist/electron'), str(HERE / 'probe.cjs')], env=env, stdout=log, stderr=subprocess.STDOUT)
    children.append(electron)
    linked = set()
    deadline = time.monotonic() + 16
    while electron.poll() is None and time.monotonic() < deadline:
        result = subprocess.run(['pw-dump'], env=env, capture_output=True, text=True, check=True, timeout=3)
        graph = json.loads(result.stdout)
        nodes = {o['id']: o['info']['props'] for o in graph if o['type'] == 'PipeWire:Interface:Node'}
        if any(p.get('device.api') == 'alsa' or p.get('media.class') == 'Audio/Source' for p in nodes.values()):
            raise RuntimeError('Private fixture unexpectedly contains audio hardware')
        sink = next(n for n, p in nodes.items() if p.get('node.name') == 'fixture_sink')
        ports = [o for o in graph if o['type'] == 'PipeWire:Interface:Port']
        inputs = {o['info']['props']['audio.channel']: o['id'] for o in ports if o['info']['direction'] == 'input' and int(o['info']['props'].get('node.id', -1)) == sink}
        for port in ports:
            props = port['info']['props']
            if port['info']['direction'] != 'output' or nodes.get(int(props.get('node.id', -1)), {}).get('media.class') != 'Stream/Output/Audio':
                continue
            target = inputs.get(props.get('audio.channel'))
            key = (props.get('object.serial'), target)
            if target and key not in linked:
                subprocess.run(['pw-link', str(port['id']), str(target)], env=env, capture_output=True, check=True, timeout=3)
                linked.add(key)
        time.sleep(0.08)
    if electron.poll() is None:
        raise RuntimeError('Private share fixture exceeded deadline')
    log.flush()
    print((runtime / 'native.log').read_text())
    if electron.returncode:
        raise RuntimeError(f'Native fixture failed with {electron.returncode}')
finally:
    for child in reversed(children):
        if child.poll() is None:
            child.terminate()
        try:
            child.wait(timeout=4)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    for log in logs:
        log.close()
    if any(child.poll() is None for child in children):
        raise RuntimeError('Fixture process survived cleanup')
    shutil.rmtree(runtime)
    print('private processes and temporary audio removed')
