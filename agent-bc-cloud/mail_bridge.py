"""Reçoit les prix analysés et signés par le suivi Gmail, via IMAP.

Ne déduit jamais un prix d'un texte libre ou d'un PDF non analysé.
Le mot de passe d'application reste dans le coffre Windows.
"""
import csv
import os
import getpass
import hashlib
import hmac
import imaplib
import json
import sqlite3
import smtplib
import tempfile
from datetime import date
from email import policy
from email.parser import BytesParser
from email.utils import parseaddr, make_msgid
from email.message import EmailMessage
from pathlib import Path
from pricing import amount, fingerprint
from credentials import credential_store

ROOT = Path(__file__).resolve().parent
CONFIG = Path(os.environ.get('BC_MAIL_BRIDGE_CONFIG', ROOT / 'mail_bridge_config.json'))
SERVICE = 'FIMARO-BC-GMAIL-IMAP'


def signed_payload(data, secret):
    body = {k: v for k, v in data.items() if k != 'signature'}
    raw = json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
    return hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()


def validate_payload(data, secret, bc, today=None):
    today = today or date.today()
    if not hmac.compare_digest(str(data.get('signature', '')), signed_payload(data, secret)):
        raise ValueError('Signature du transfert invalide')
    if str(data.get('bc_id')) != str(bc['id']):
        raise ValueError('BC différent')
    articles = {fingerprint(a): a for a in bc['articles']}
    rows = []
    for row in data.get('observations', []):
        if fingerprint(row) not in articles:
            raise ValueError('Produit ou spécification inconnue')
        expected = articles[fingerprint(row)]
        if row.get('confirmed') != 'oui' or row.get('in_stock') != 'oui':
            continue
        if (row.get('currency') != 'MAD' or row.get('price_basis') != 'TTC'
                or not row.get('source_mail_id') or not row.get('supplier')
                or amount(row['purchase_ttc']) <= 0):
            raise ValueError('Prix fournisseur non documenté')
        if not amount(row['min_qty']) <= amount(expected['quantity']) <= amount(row['max_qty']):
            continue
        observed, valid = date.fromisoformat(row['observed_on']), date.fromisoformat(row['valid_until'])
        if observed > today or valid < today or valid < observed:
            continue
        rows.append({**row, 'source': 'Gmail:'+row['source_mail_id']})
    return rows


def setup():
    config = json.loads(CONFIG.read_text(encoding='utf-8'))
    print('Connexion du suivi Gmail au poste Windows : '+config['account'])
    print('Saisissez une seule fois le mot de passe Google d’application, pas le mot de passe habituel.')
    password = getpass.getpass('Mot de passe d’application (16 caractères) : ').replace(' ', '')
    if len(password) != 16:
        raise ValueError('Mot de passe d’application attendu')
    # Vérifie la connexion avant d'enregistrer le secret.
    with imaplib.IMAP4_SSL('imap.gmail.com', timeout=30) as mailbox:
        mailbox.login(config['account'], password)
    credential_store().set_password(SERVICE, config['account'], password)
    print('Connexion vérifiée et enregistrée dans le coffre Windows.')


def receive(prices, workflow, data_folder):
    if not CONFIG.is_file():
        return {'status': 'liaison Gmail non configurée'}
    config = json.loads(CONFIG.read_text(encoding='utf-8'))
    password = credential_store().get_password(SERVICE, config['account'])
    if not password:
        return {'status': 'liaison Gmail non connectée : secret gmail_app_password requis'}
    ledger = sqlite3.connect(data_folder / 'mail_bridge.sqlite')
    ledger.execute('CREATE TABLE IF NOT EXISTS received (message_id TEXT PRIMARY KEY, bc_id TEXT, imported_rows INTEGER)')
    imported = 0
    issues = []
    with imaplib.IMAP4_SSL('imap.gmail.com', timeout=30) as mailbox:
        mailbox.login(config['account'], password)
        mailbox.select('INBOX', readonly=True)
        status, values = mailbox.uid('search', None, 'SUBJECT', '"[AGENT-BC-PRIX]"')
        if status != 'OK':
            raise RuntimeError('Recherche de transferts Gmail impossible')
        for uid in values[0].split()[-100:]:
            status, parts = mailbox.uid('fetch', uid, '(BODY.PEEK[])')
            if status != 'OK':
                continue
            raw = next((p[1] for p in parts if isinstance(p, tuple)), b'')
            if len(raw) > 5*1024*1024:
                continue
            message = BytesParser(policy=policy.default).parsebytes(raw)
            mid = message.get('Message-ID', '')
            if not mid or ledger.execute('SELECT 1 FROM received WHERE message_id=?', (mid,)).fetchone():
                continue
            if parseaddr(message.get('From', ''))[1].casefold() != config['account'].casefold():
                continue
            try:
                blocks = [p.get_content() for p in message.walk() if p.get_content_type() in ('text/plain', 'application/json')]
                payload = None
                for block in blocks:
                    try:
                        candidate = json.loads(block.decode() if isinstance(block, bytes) else block)
                        if isinstance(candidate, dict):
                            payload = candidate
                            break
                    except (ValueError, UnicodeError):
                        continue
                if payload is None:
                    raise ValueError('Transfert JSON absent')
                found = workflow.db.execute('SELECT bc FROM bc_workflow WHERE bc_id=?', (str(payload['bc_id']),)).fetchone()
                if not found:
                    raise ValueError('BC pas encore relevé par le poste Windows')
                bc = json.loads(found[0])
                rows = validate_payload(payload, config['secret'], bc)
                if rows:
                    fields = ['designation', 'specification', 'unit', 'purchase_ttc', 'supplier', 'source',
                              'observed_on', 'valid_until', 'min_qty', 'max_qty', 'in_stock', 'confirmed']
                    with tempfile.NamedTemporaryFile('w', suffix='.csv', encoding='utf-8', newline='', delete=False, dir=data_folder) as f:
                        writer = csv.DictWriter(f, fields, delimiter=';', extrasaction='ignore')
                        writer.writeheader()
                        writer.writerows(rows)
                        name = f.name
                    try:
                        imported += prices.import_csv(name)
                    finally:
                        Path(name).unlink(missing_ok=True)
                ledger.execute('INSERT INTO received VALUES (?,?,?)', (mid, bc['id'], len(rows)))
                ledger.commit()
            except (ValueError, KeyError, TypeError, StopIteration) as exc:
                issues.append({'message_id': mid, 'reason': str(exc)})
    ledger.close()
    return {'status': 'connectée', 'imported_rows': imported, 'issues': issues}


def publish(bc, quote, data_folder):
    """Transmet les nouveaux besoins au suivi distant, sans doublonner les envois."""
    config = json.loads(CONFIG.read_text(encoding='utf-8'))
    password = credential_store().get_password(SERVICE, config['account'])
    if not password:
        return 'liaison Gmail non connectée sur cet hôte'
    body = {'bc_id': bc['id'], 'bc': {k: v for k, v in bc.items() if k != 'text'},
            'known_prices': [{k: line.get(k) for k in ('article', 'status', 'unit_sale_ht', 'source')}
                             for line in quote['lines']], 'type': 'besoin de prix'}
    # Un même ensemble de prix/besoins n'est publié qu'une fois ; les dates
    # de simples relectures des pages fournisseurs ne changent pas l'identité.
    identity = [bc['id'], bc['deadline'], bc['articles'], [line.get('unit_sale_ht') for line in quote['lines']]]
    oid = hashlib.sha256(json.dumps(identity, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    ledger = sqlite3.connect(data_folder / 'mail_bridge.sqlite')
    ledger.execute('CREATE TABLE IF NOT EXISTS outbound (id TEXT PRIMARY KEY, state TEXT)')
    if ledger.execute('SELECT 1 FROM outbound WHERE id=?', (oid,)).fetchone():
        ledger.close()
        return 'besoin déjà transmis'
    body['signature'] = signed_payload(body, config['secret'])
    message = EmailMessage()
    message['From'] = message['To'] = config['account']
    message['Subject'] = '[AGENT-BC-SUIVI] '+bc['id']
    message['Message-ID'] = make_msgid(domain='gmail.com')
    message.set_content(json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(',', ':')))
    ledger.execute('INSERT INTO outbound VALUES (?,?)', (oid, 'en cours'))
    ledger.commit()
    try:
        with imaplib.IMAP4_SSL('imap.gmail.com', timeout=30) as mailbox:
            mailbox.login(config['account'], password)
            status,_=mailbox.append('INBOX',None,None,message.as_bytes())
            if status!='OK':raise RuntimeError('Besoin de prix non déposé dans Gmail')
        ledger.execute('UPDATE outbound SET state=? WHERE id=?', ('envoyé', oid))
        ledger.commit()
    finally:
        ledger.close()
    return 'besoin transmis au suivi Gmail'


if __name__ == '__main__':
    try:
        setup()
    except Exception as exc:
        print('Connexion non terminée :', type(exc).__name__, str(exc))
        raise SystemExit(1)
