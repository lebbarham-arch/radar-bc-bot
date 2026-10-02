"""Service Linux persistant : passage horaire, verrou et arrêt de tout le groupe enfant."""
import argparse
import fcntl
import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / 'donnees'
HEALTH = DATA / 'service-status.json'


def write_status(data):
    DATA.mkdir(exist_ok=True)
    data['heartbeat'] = datetime.now(timezone.utc).isoformat()
    temporary = HEALTH.with_suffix('.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
    temporary.replace(HEALTH)


def run_cycle(command=None, timeout=3000):
    command = command or [sys.executable, '-u', str(ROOT / 'agent.py'), 'run']
    started = datetime.now(timezone.utc).isoformat()
    write_status({'phase': 'en cours', 'started_at': started})
    with (DATA / 'execution-cloud.log').open('a', encoding='utf-8') as log:
        log.write('\nPassage cloud : '+started+'\n')
        log.flush()
        child = subprocess.Popen(command, cwd=ROOT, stdout=log, stderr=log, start_new_session=True)
        try:
            code = child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
            log.write('Passage interrompu après le délai maximal ; aucune répétition d’une sauvegarde incertaine.\n')
            code = 124
    write_status({'phase': 'attente' if code == 0 else 'dernier passage bloqué',
                  'started_at': started, 'finished_at': datetime.now(timezone.utc).isoformat(),
                  'last_return_code': code})
    return code


def health():
    try:
        status = json.loads(HEALTH.read_text())
        age = (datetime.now(timezone.utc)-datetime.fromisoformat(status['heartbeat'])).total_seconds()
        return 0 if 0 <= age < 3900 and status.get('last_return_code', 0) == 0 else 1
    except (ValueError, KeyError, OSError):
        return 1


def main(once=False):
    DATA.mkdir(exist_ok=True)
    with (DATA / 'cloud.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        while True:
            started = time.monotonic()
            code = run_cycle()
            if once:
                return code
            # La fréquence est mesurée depuis le début, pas depuis la fin du passage.
            time.sleep(max(1, 3600-(time.monotonic()-started)))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--once', action='store_true')
    parser.add_argument('--health', action='store_true')
    parser.add_argument('--status', action='store_true')
    args = parser.parse_args()
    if args.health:
        raise SystemExit(health())
    if args.status:
        print(HEALTH.read_text() if HEALTH.exists() else '{"phase":"non démarré"}')
    else:
        raise SystemExit(main(args.once))
