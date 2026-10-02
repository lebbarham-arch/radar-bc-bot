"""Suivi persistant et règle de remplissage à H-24 (heure du Maroc)."""
import json
import sqlite3
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

MAROC = ZoneInfo('Africa/Casablanca')


def filling_policy(bc, quote, now=None):
    now = now or datetime.now(MAROC)
    if now.tzinfo is None:
        raise ValueError('Horodatage sans fuseau')
    try:
        deadline = datetime.strptime(bc['deadline'], '%d/%m/%Y %H:%M').replace(tzinfo=MAROC)
    except (KeyError, ValueError):
        return 'échéance non confirmée'
    if now >= deadline:
        return 'expiré'
    if bc.get('extraction_errors'):
        return 'extraction à confirmer'
    known = [line for line in quote.get('lines', []) if line.get('status') == 'chiffré']
    if not known:
        return 'aucun prix disponible'
    if quote.get('complete'):
        return 'complet'
    if deadline - now <= timedelta(hours=24):
        return 'partiel à H-24'
    return 'attente des devis'


class Workflow:
    def __init__(self, path):
        self.db = sqlite3.connect(path)
        self.db.execute('''CREATE TABLE IF NOT EXISTS bc_workflow(
            bc_id TEXT PRIMARY KEY, deadline TEXT, phase TEXT, bc TEXT,
            quote TEXT, updated_at TEXT)''')
        self.db.execute('''CREATE TABLE IF NOT EXISTS workflow_events(
            id INTEGER PRIMARY KEY, bc_id TEXT, at TEXT, phase TEXT, details TEXT)''')
        self.db.commit()

    def record(self, bc, quote, status, now=None):
        now = now or datetime.now(MAROC)
        old = self.db.execute('SELECT phase,quote FROM bc_workflow WHERE bc_id=?', (bc['id'],)).fetchone()
        raw = json.dumps(quote, ensure_ascii=False, sort_keys=True)
        self.db.execute('INSERT OR REPLACE INTO bc_workflow VALUES (?,?,?,?,?,?)',
            (bc['id'], bc['deadline'], status, json.dumps(bc, ensure_ascii=False), raw, now.isoformat()))
        if not old or old != (status, raw):
            self.db.execute('INSERT INTO workflow_events(bc_id,at,phase,details) VALUES (?,?,?,?)',
                (bc['id'], now.isoformat(), status, raw))
        self.db.commit()

    def pending(self):
        return [json.loads(row[0]) for row in self.db.execute(
            "SELECT bc FROM bc_workflow WHERE phase NOT IN ('expiré','brouillon enregistré et prix revérifiés')")]
