"""Historique des achats et calcul exact de la règle FIMARO."""
import csv
import hashlib
import json
import sqlite3
from datetime import date
from decimal import Decimal, ROUND_HALF_UP


def amount(value):
    result = Decimal(str(value).replace(',', '.').replace(' ', ''))
    if not result.is_finite() or result < 0:
        raise ValueError('Montant invalide')
    return result


def money(value):
    return amount(value).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)


def fingerprint(article):
    # Conserve références, exigences et unité : aucun rapprochement approximatif.
    fields = [str(article[k]).strip() for k in ('designation', 'specification', 'unit')]
    return hashlib.sha256(json.dumps(fields, ensure_ascii=False).encode()).hexdigest()


class Prices:
    def __init__(self, path):
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.execute('''CREATE TABLE IF NOT EXISTS prices (
          observation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
          purchase_ttc TEXT NOT NULL, supplier TEXT NOT NULL, source TEXT NOT NULL,
          observed_on TEXT NOT NULL, valid_until TEXT NOT NULL,
          min_qty TEXT NOT NULL, max_qty TEXT NOT NULL, in_stock INTEGER NOT NULL,
          confirmed INTEGER NOT NULL, raw TEXT NOT NULL)''')
        self.db.commit()

    def import_csv(self, path):
        count = 0
        with open(path, encoding='utf-8-sig', newline='') as stream:
            for row in csv.DictReader(stream, delimiter=';'):
                price = amount(row['purchase_ttc'])
                if price <= 0 or not row['source'] or not row['supplier']:
                    raise ValueError('Prix/source/fournisseur manquant')
                observed = date.fromisoformat(row['observed_on'])
                valid = date.fromisoformat(row['valid_until'])
                if observed > date.today() or valid < observed:
                    raise ValueError('Dates invalides')
                lo, hi = amount(row['min_qty']), amount(row['max_qty'])
                if hi < lo:
                    raise ValueError('Palier de quantité invalide')
                raw = json.dumps(row, ensure_ascii=False, sort_keys=True)
                oid = hashlib.sha256(raw.encode()).hexdigest()
                cur = self.db.execute('INSERT OR IGNORE INTO prices VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                    (oid, fingerprint(row), str(price), row['supplier'], row['source'],
                     observed.isoformat(), valid.isoformat(), str(lo), str(hi),
                     int(row['in_stock'] == 'oui'), int(row['confirmed'] == 'oui'), raw))
                count += cur.rowcount
        self.db.commit()
        return count

    def best(self, article, today=None):
        today = today or date.today()
        qty = amount(article['quantity'])
        if qty <= 0:
            raise ValueError('Quantité nulle')
        candidates = self.db.execute('''SELECT * FROM prices WHERE fingerprint=?
            AND confirmed=1 AND in_stock=1 AND valid_until>=? AND observed_on<=?''',
            (fingerprint(article), today.isoformat(), today.isoformat())).fetchall()
        candidates = [r for r in candidates if amount(r['min_qty']) <= qty <= amount(r['max_qty'])]
        if not candidates:
            return None
        return dict(min(candidates, key=lambda r: amount(r['purchase_ttc'])))

    def record_public(self, observations):
        self.db.execute('CREATE TABLE IF NOT EXISTS public_observations (id TEXT PRIMARY KEY, raw TEXT NOT NULL)')
        for observation in observations:
            raw = json.dumps(observation, ensure_ascii=False, sort_keys=True)
            oid = hashlib.sha256(raw.encode()).hexdigest()
            self.db.execute('INSERT OR IGNORE INTO public_observations VALUES (?,?)', (oid, raw))
        self.db.commit()

    def quote(self, articles, public=None):
        public = {fingerprint(p['article']): p for p in (public or []) if p['status'] == 'prix public'}
        lines = []
        for article in articles:
            price = self.best(article)
            candidate = public.get(fingerprint(article))
            if candidate and (price is None or amount(candidate['purchase_unit_ttc']) < amount(price['purchase_ttc'])):
                price = {'purchase_ttc': candidate['purchase_unit_ttc'], 'supplier': candidate['supplier'],
                         'source': candidate['source_url'], 'observed_at': candidate['observed_at'],
                         'basis': 'prix public en ligne', 'quantity_confirmed': False}
            if price is None:
                lines.append({'article': article, 'status': 'prix à confirmer'})
                continue
            qty, vat = amount(article['quantity']), amount(article['vat'])
            if vat > 100:
                raise ValueError('TVA invalide')
            pu_ht = money(amount(price['purchase_ttc']) * Decimal('1.10'))
            ht = money(pu_ht * qty)
            tva = money(ht * vat / Decimal(100))
            lines.append({'article': article, 'status': 'chiffré', 'source': price,
                          'unit_sale_ht': str(pu_ht), 'sale_ht': str(ht),
                          'sale_vat': str(tva), 'sale_ttc': str(ht + tva),
                          'purchase_ttc': str(money(amount(price['purchase_ttc']) * qty))})
        complete = bool(lines) and all(x['status'] == 'chiffré' for x in lines)
        result = {'complete': complete, 'transport_included': False, 'lines': lines}
        if complete:
            for key in ('sale_ht', 'sale_vat', 'sale_ttc', 'purchase_ttc'):
                result[key] = str(sum((amount(x[key]) for x in lines), Decimal(0)))
        return result
