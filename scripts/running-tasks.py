"""Список задач в работе у текущего офиса — чтобы не оборвать их перезапуском."""
import json, os, sys
from pathlib import Path

state_env = os.environ.get('OFFICE_STATE_FILE')
default = Path(state_env) if state_env else Path('.office/state.json')
registry = default.parent / 'offices.json'

state_file = default
if registry.exists():
    try:
        reg = json.loads(registry.read_text())
        cur = next((o for o in reg.get('offices', []) if o['id'] == reg.get('currentId')), None)
        if cur:
            state_file = Path(cur['stateFile'])
    except Exception:
        pass

if not state_file.exists():
    sys.exit(0)
try:
    state = json.loads(state_file.read_text())
except Exception:
    sys.exit(0)

running = [t['id'] for t in state.get('tasks', []) if t.get('status') == 'in_progress']
if running:
    print(', '.join(running))
