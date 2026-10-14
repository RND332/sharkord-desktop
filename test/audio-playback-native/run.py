import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
mode = sys.argv[1] if len(sys.argv) > 1 else 'automatic'
scratch = os.environ.get('TMPDIR')
if not scratch:
    raise RuntimeError('Set TMPDIR to a scratch directory before running')
root = Path(tempfile.mkdtemp(prefix='sharkord-audio-', dir=scratch))
root.chmod(0o700)
env = os.environ.copy()
env.update(PIPEWIRE_RUNTIME_DIR=str(root), PIPEWIRE_REMOTE=str(root / 'pipewire-0'),
           PULSE_RUNTIME_PATH=str(root),
           PULSE_SERVER=f'unix:{root}/native', PULSE_SINK='fixture_sink',
           SHARKORD_AUDIO_FIXTURE_DIR=str(root), SHARKORD_AUDIO_PROBE_MODE=mode)
pwlog = open(root / 'pipewire.log', 'w')
native = open(root / 'native.log', 'w')
server_env = {**env, 'PIPEWIRE_CONFIG_DIR': str(HERE)}
pipewire = subprocess.Popen(['pipewire', '-c', 'pipewire.conf'], env=server_env, stdout=pwlog, stderr=subprocess.STDOUT)
electron = None
linked = set()
try:
    for _ in range(40):
        if (root / 'native').exists() and (root / 'pipewire-0').exists():
            break
        if pipewire.poll() is not None:
            raise RuntimeError(f'Private PipeWire failed: {root}/pipewire.log')
        time.sleep(0.1)
    result = subprocess.run(['pactl', 'list', 'short', 'sinks'], env=env, text=True, capture_output=True, timeout=4)
    print('private sinks:', result.stdout.strip(), 'errors:', result.stderr.strip())
    if result.returncode or 'fixture_sink' not in result.stdout:
        raise RuntimeError('Private fixture sink not available')
    binary = str(HERE.parent.parent / 'node_modules/electron/dist/electron')
    electron = subprocess.Popen([binary, str(HERE / 'probe.cjs')], env=env, stdout=native, stderr=subprocess.STDOUT)
    deadline = time.monotonic() + 35
    while electron.poll() is None and time.monotonic() < deadline:
        result = subprocess.run(['pw-dump'], env=env, text=True, capture_output=True, timeout=3)
        if result.returncode:
            raise RuntimeError(f'Private graph unavailable: {result.stderr}')
        graph = json.loads(result.stdout)
        nodes = {o['id']: o['info']['props'] for o in graph if o['type'] == 'PipeWire:Interface:Node'}
        if any(p.get('device.api') == 'alsa' or p.get('media.class') == 'Audio/Source' for p in nodes.values()):
            raise RuntimeError('Unexpected hardware/capture node in private graph')
        sink_id = next(n for n, p in nodes.items() if p.get('node.name') == 'fixture_sink')
        ports = [o for o in graph if o['type'] == 'PipeWire:Interface:Port']
        inputs = {o['info']['props']['audio.channel']: o['id'] for o in ports
                  if int(o['info']['props'].get('node.id', -1)) == sink_id and o['info']['direction'] == 'input'}
        for port in ports:
            props = port['info']['props']
            node_id = int(props.get('node.id', -1))
            if port['info']['direction'] != 'output' or nodes.get(node_id, {}).get('media.class') != 'Stream/Output/Audio':
                continue
            target = inputs.get(props.get('audio.channel'))
            identity = (props.get('object.serial'), target)
            if target and identity not in linked:
                link = subprocess.run(['pw-link', str(port['id']), str(target)], env=env, capture_output=True, text=True, timeout=3)
                if link.returncode == 0:
                    linked.add(identity)
                else:
                    print('link warning', link.stderr.strip())
        time.sleep(0.15)
    if electron.poll() is None:
        raise RuntimeError('Native fixture exceeded deadline')
    print('native exit:', electron.returncode, 'links:', len(linked), 'artifacts:', root)
    native.flush()
    print((root / 'native.log').read_text())
    minimum_links = 4 if electron.returncode == 0 else 2
    if electron.returncode in (0, 2) and len(linked) < minimum_links:
        raise RuntimeError('Expected both private output channels to link before and after recovery')
    sys.exit(electron.returncode)
finally:
    if electron and electron.poll() is None:
        electron.terminate()
        try:
            electron.wait(timeout=5)
        except subprocess.TimeoutExpired:
            electron.kill()
            electron.wait()
    pipewire.terminate()
    pipewire.wait(timeout=5)
    native.close()
    pwlog.close()
