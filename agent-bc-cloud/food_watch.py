"""Independent, read-only food-price watch; append-only dated evidence.

No supplier email, order, portal write or inferred market price is permitted here.
Only exact product/unit matches with recent retail observations feed BC pricing.
"""
import argparse
import hashlib
import json
import os
import re
import sqlite3
import time
import zlib
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlparse
from sourcing import canonical, amount, public_line

ROOT = Path(__file__).resolve().parent
DATA = ROOT / 'donnees'
SOURCES = [
    ('Aswak Delivery Rabat', 'Rabat', 'https://www.aswakdelivery.com/rabat/categorie-produit/fruits-legumes/'),
    ('Aswak Drive Hay Riad', 'Rabat', 'https://www.aswakdrive.com/hayriadrabat/categorie-produit/fruits-legumes/'),
    ('Aswak Assalam', 'non précisée', 'https://aswakassalam.com/shop/'),
    ('Le Maître des Légumes', 'non précisée', 'https://lemaitredeslegumes.ma/boutique/'),
    ('Marjane', 'non précisée', 'https://www.marjane.ma/'),
    ('Carrefour', 'non précisée', 'https://carrefour.ma/catalogues/'),
    ('BIM', 'non précisée', 'https://www.bim.ma/'),
]

EXTRACT = r'''els=>els.map(e=>{
 const title=e.querySelector('.woocommerce-loop-product__title,.product-title');
 const link=e.querySelector('a.woocommerce-LoopProduct-link,a[href*="/produit/"],a[href*="/product/"]');
 const price=e.querySelector('.price');
 const current=price && (price.querySelector('ins .woocommerce-Price-amount') || (!price.querySelector('del') && price.querySelector('.woocommerce-Price-amount')));
 const amounts=current ? current.querySelectorAll('bdi') : [];
 const currency=current && current.querySelector('.woocommerce-Price-currencySymbol');
 const unit=[...e.querySelectorAll('p,span,div')].map(n=>n.textContent.trim()).find(t=>/^(?:\d+(?:[.,]\d+)?(?:\s*\/\s*\d+)?\s*(?:kg|g|gr|ml|cl|l)|botte|pièce)$/i.test(t)) || '';
 return {title:title?title.textContent.trim():'',url:link?link.href:'',unit,
 price:amounts.length===1?amounts[0].textContent.replace(/MAD|DH/gi,'').trim():'',
 currency:currency?currency.textContent.trim():'',promotion:!!(price&&price.querySelector('ins')),
 available:e.classList.contains('instock') && !!e.querySelector('.add_to_cart_button'),
 raw:e.innerText};
})'''


def normalized_unit(title, explicit=''):
    """Variable-weight pieces, packs and several sizes never become kg prices."""
    text = explicit.strip() or title
    if re.search(r'\b(lot|pack|x\s*\d+|\d+\s*x|environ)\b', canonical(title)) or re.search(r'\d\s*[-à]\s*\d', title):
        return None
    weights = re.findall(r'\b(\d+(?:[.,]\d+)?)(?:\s*/\s*(\d+))?\s*(kg|gr|g|ml|cl|l)\b', text, re.I)
    if len(weights) == 1:
        n, divisor, unit = weights[0]
        q = amount(n) / Decimal(divisor or '1')
        if q <= 0:
            return None
        unit = unit.lower()
        if unit in ('g', 'gr', 'kg'):
            return 'kg', q / (1000 if unit != 'kg' else 1)
        return 'l', q / {'ml': 1000, 'cl': 100, 'l': 1}[unit]
    if not weights:
        if re.search(r'\bbotte\b', canonical(text)):
            return 'botte', Decimal(1)
        if canonical(text) in ('piece', 'la piece', 'unite') or re.search(r'\bla piece\b', canonical(title)):
            return 'piece', Decimal(1)
    return None


class FoodStore:
    def __init__(self, path):
        self.db = sqlite3.connect(path, timeout=30)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA busy_timeout=30000')
        self.db.executescript('''
        CREATE TABLE IF NOT EXISTS food_observations (
          id TEXT PRIMARY KEY, observed_at TEXT NOT NULL, supplier TEXT NOT NULL,
          city TEXT NOT NULL, source_url TEXT NOT NULL, title TEXT NOT NULL,
          unit TEXT, factor TEXT, price TEXT NOT NULL, available INTEGER NOT NULL,
          promotion INTEGER NOT NULL, raw TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS food_lookup ON food_observations(source_url,observed_at);
        CREATE TABLE IF NOT EXISTS food_pages (
          id TEXT PRIMARY KEY, observed_at TEXT, source_url TEXT, evidence BLOB);
        CREATE TABLE IF NOT EXISTS food_queue (
          url TEXT PRIMARY KEY, supplier TEXT, city TEXT, checked_at TEXT, status TEXT);
        ''')
        self.db.commit()

    def queue(self, supplier, city, url):
        self.db.execute('INSERT OR IGNORE INTO food_queue VALUES (?,?,?,NULL,NULL)', (url,supplier,city))
        self.db.commit()

    def record(self, supplier, city, card, observed_at):
        if canonical(card.get('currency','')) not in ('mad','dh') or not card.get('title') or not card.get('url'):
            return False
        try:
            price = amount(card['price'])
            if price <= 0:
                return False
            conversion = normalized_unit(card['title'], card.get('unit',''))
        except (ValueError, ArithmeticError):
            return False
        raw = json.dumps(card, ensure_ascii=False, sort_keys=True)
        oid = hashlib.sha256((supplier+city+observed_at+raw).encode()).hexdigest()
        self.db.execute('INSERT OR IGNORE INTO food_observations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
            (oid,observed_at,supplier,city,card['url'],card['title'],
             conversion[0] if conversion else None,str(conversion[1]) if conversion else None,
             str(price),int(bool(card.get('available'))),int(bool(card.get('promotion'))),raw))
        self.db.commit()
        return True

    def candidates(self, article, cities=('Rabat','Salé','Témara','Casablanca'), now=None):
        now = now or datetime.now(timezone.utc)
        cutoff = (now-timedelta(hours=24)).isoformat()
        rows = self.db.execute('''SELECT * FROM food_observations o WHERE observed_at>=?
            AND NOT EXISTS (SELECT 1 FROM food_observations n
              WHERE n.supplier=o.supplier AND n.city=o.city AND n.source_url=o.source_url
              AND n.observed_at>o.observed_at)''', (cutoff,)).fetchall()
        from produce_sources import produce_factor
        result = []
        for row in rows:
            if not row['available'] or row['city'] not in cities:
                continue
            peers = [r for r in rows if r['source_url']==row['source_url'] and r['supplier']==row['supplier'] and r['city']==row['city']]
            if len({(r['price'],r['available'],r['unit'],r['factor']) for r in peers})>1:
                continue
            card = json.loads(row['raw'])
            from produce_sources import titled_unit
            sale_unit = card.get('unit') or titled_unit(row['title'])
            factor = produce_factor(article,row['title'],sale_unit)
            if factor is None:
                # Packaged groceries need an exact SKU/title and exact unit.
                if (canonical(article['designation']) != canonical(row['title'])
                    or canonical(article.get('specification','')) not in ('',canonical(row['title']))
                    or canonical(article['unit']) not in ('un','u','unite','piece')):
                    continue
                factor = Decimal(1)
            observation = public_line(article,amount(row['price'])/factor,row['source_url'],row['supplier'],
                'veille alimentaire régionale ; prix de détail affiché, volume demandé à confirmer')
            observation.update(observed_at=row['observed_at'],city=row['city'],promotion=bool(row['promotion']))
            result.append(observation)
        return result

    def close(self):
        self.db.close()


def collect(limit=24):
    from playwright.sync_api import sync_playwright
    from sourcing import MerchantPage
    DATA.mkdir(exist_ok=True)
    store=FoodStore(DATA/'food-watch.sqlite')
    for source in SOURCES:
        store.queue(*source)
    cutoff=(datetime.now(timezone.utc)-timedelta(hours=24)).isoformat()
    # Rotate by least recently visited; a daily cycle does not restart at page 1.
    work=store.db.execute('SELECT * FROM food_queue WHERE checked_at IS NULL OR checked_at<? ORDER BY checked_at LIMIT ?', (cutoff,limit)).fetchall()
    summary={'started_at':datetime.now(timezone.utc).isoformat(),'pages':[],'observations':0}
    with sync_playwright() as pw:
        browser=pw.chromium.launch(headless=True,chromium_sandbox=False)
        for task in work:
            now=datetime.now(timezone.utc).isoformat()
            reader=MerchantPage(browser,task['supplier'],task['url'])
            entry={'supplier':task['supplier'],'city':task['city'],'url':task['url']}
            try:
                body=reader.open(task['url'])
                cards=reader.page.locator('li.product').evaluate_all(EXTRACT)
                count=0
                for card in cards:
                    if urlparse(card['url']).hostname==reader.host:
                        count+=int(store.record(task['supplier'],task['city'],card,now))
                entry.update(cards=len(cards),observations=count,status='prix relevés' if count else 'aucun prix structuré : extraction à compléter')
                evidence=json.dumps({'body':body[:120000],'cards':cards},ensure_ascii=False).encode()
                eid=hashlib.sha256((task['url']+now).encode()).hexdigest()
                store.db.execute('INSERT INTO food_pages VALUES (?,?,?,?)',(eid,now,task['url'],zlib.compress(evidence)))
                links=reader.page.locator('a[href]').evaluate_all('els=>els.map(e=>({url:e.href,text:e.innerText.trim()}))')
                prefix='/'+task['url'].split('/',3)[3].split('/')[0]+'/' if reader.host in ('www.aswakdelivery.com','www.aswakdrive.com') else '/'
                for link in links:
                    parsed=urlparse(link['url'])
                    if (parsed.hostname==reader.host and parsed.scheme=='https' and not parsed.query
                        and parsed.path.startswith(prefix)
                        and any(s in parsed.path for s in ('product-category/','categorie-produit/','/shop/page/','/boutique/page/'))):
                        # Food aisles only, excludes cleaning and non-food.
                        if any(t in canonical(parsed.path) for t in ('fruits','legumes','epicerie','boucherie','volaille','poisson','cremerie','lait','fromage','boisson','boulangerie','surgel','charcuterie','oeuf')) or '/shop/page/' in parsed.path or '/boutique/page/' in parsed.path:
                            store.queue(task['supplier'],task['city'],link['url'])
                summary['observations']+=count
            except Exception as exc:
                entry.update(status='accès ou extraction bloqué',error_type=type(exc).__name__,detail=str(exc)[:180])
            finally:
                reader.close()
            store.db.execute('UPDATE food_queue SET checked_at=?,status=? WHERE url=?',(now,entry['status'],task['url']))
            store.db.commit()
            summary['pages'].append(entry)
            print('FOOD_WATCH_PAGE',json.dumps(entry,ensure_ascii=False),flush=True)
        browser.close()
    summary['total_observations']=store.db.execute('SELECT count(*) FROM food_observations').fetchone()[0]
    summary['queued_pages']=store.db.execute('SELECT count(*) FROM food_queue').fetchone()[0]
    store.close()
    (DATA/'food-watch-status.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
    print('FOOD_WATCH_COMPLETE',json.dumps(summary,ensure_ascii=False),flush=True)
    if os.environ.get('BC_STATE_CHECKPOINT')=='1':
        from cloud_state import backup
        backup(DATA)
        print('FOOD_WATCH_CHECKPOINT_OK',flush=True)
    return summary


def main(loop=False):
    while True:
        try:
            collect()
        except Exception as exc:
            print('FOOD_WATCH_ERROR',type(exc).__name__,str(exc)[:180],flush=True)
            if not loop:
                return 1
        if not loop:
            return 0
        time.sleep(3600)


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--loop',action='store_true')
    raise SystemExit(main(parser.parse_args().loop))
