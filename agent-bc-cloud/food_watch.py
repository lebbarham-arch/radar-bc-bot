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
from urllib.parse import urlparse, urldefrag
from sourcing import canonical, amount, public_line

ROOT = Path(__file__).resolve().parent
DATA = ROOT / 'donnees'
SOURCES = [
    ('Aswak Delivery Rabat', 'Rabat', 'https://www.aswakdelivery.com/rabat/categorie-produit/fruits-legumes/'),
    ('Aswak Drive Hay Riad', 'Rabat', 'https://www.aswakdrive.com/hayriadrabat/categorie-produit/fruits-legumes/'),
    ('Aswak Assalam', 'non précisée', 'https://aswakassalam.com/shop/'),
    ('Le Maître des Légumes', 'non précisée', 'https://lemaitredeslegumes.ma/boutique/'),
    ('Marjane', 'non précisée', 'https://www.marjane.ma/contenu/nos-catalogues'),
    ('Carrefour', 'non précisée', 'https://carrefour.ma/catalogues/'),
    ('BIM', 'non précisée', 'https://www.bim.ma/'),
    ('Atacadao', 'non précisée', 'https://www.atacadao.ma/'),
]
from sourcing import BRINGO_CATEGORIES
SOURCES += [('Carrefour via Bringo', 'non précisée', url) for url in BRINGO_CATEGORIES]

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

# Regional Aswak uses div cards rather than li.product; find the smallest
# ancestor pairing a product link with its own single current price.
REGIONAL_EXTRACT = r'''els=>{
 const found=new Map();
 for(const a of els){
  if(!/\/(produit|product)\//.test(a.href)||/add-to-cart/.test(a.href))continue;
  let e=a.parentElement;
  for(let i=0;e&&i<7;i++,e=e.parentElement){
   const amounts=e.querySelectorAll('.offer-price .woocommerce-Price-amount,.price .woocommerce-Price-amount');
   const titles=[...e.querySelectorAll('a[href]')].filter(n=>n.href===a.href&&n.innerText.trim());
   if(!amounts.length)continue;
   const price=e.querySelector('.offer-price,.price');
   const active=price&&(price.querySelector('ins .woocommerce-Price-amount')||(!price.querySelector('del')&&price.querySelector('.woocommerce-Price-amount')));
   if(!active||e.querySelectorAll('.offer-price,.price').length!==1||!titles.length)break;
   const heading=e.querySelector('.woocommerce-loop-product__title,.product-title,h2,h3,h5');
   const title=(heading?heading.innerText:titles[0].innerText).trim().replace(/^-\d+%\s*/, '');
   const raw=e.innerText;
   found.set(a.href,{title,url:a.href,unit:'',price:active.innerText.replace(/MAD|DH/gi,'').trim(),
    currency:(active.querySelector('.woocommerce-Price-currencySymbol')||{}).innerText||'',
    available:!/(rupture|indisponible|épuisé)/i.test(raw)&&!!e.querySelector('[href*="add-to-cart"],.add_to_cart_button'),
    promotion:!!price.querySelector('ins'),raw,
    max_qty_displayed:(e.querySelector('input[name="quantity"]')||{}).max||null});
   break;
  }
 }
 return [...found.values()];
}'''


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
        CREATE TABLE IF NOT EXISTS food_meta (key TEXT PRIMARY KEY,value TEXT);
        CREATE TABLE IF NOT EXISTS food_feed_received (message_id TEXT PRIMARY KEY,observations INTEGER);
        CREATE TABLE IF NOT EXISTS food_documents (
          url TEXT PRIMARY KEY,supplier TEXT,city TEXT,label TEXT,checked_at TEXT,
          sha256 TEXT,method TEXT,text TEXT,state TEXT);
        CREATE TABLE IF NOT EXISTS food_runs (
          id TEXT PRIMARY KEY,started_at TEXT,finished_at TEXT,summary TEXT);
        CREATE TABLE IF NOT EXISTS food_document_versions (
          id TEXT PRIMARY KEY,url TEXT,observed_at TEXT,sha256 TEXT,method TEXT,text TEXT,state TEXT);
        ''')
        columns={r[1] for r in self.db.execute('PRAGMA table_info(food_queue)')}
        for name,kind in [('next_check_at','TEXT'),('failures','INTEGER DEFAULT 0')]:
            if name not in columns:
                self.db.execute('ALTER TABLE food_queue ADD COLUMN '+name+' '+kind)
        # Old checkpoints may contain URLs ending in an empty fragment.
        for row in self.db.execute('SELECT * FROM food_queue').fetchall():
            clean=urldefrag(row['url'])[0]
            if clean!=row['url']:
                self.db.execute('INSERT OR IGNORE INTO food_queue(url,supplier,city,checked_at,status,next_check_at,failures) VALUES (?,?,?,?,?,?,?)',
                    (clean,row['supplier'],row['city'],row['checked_at'],row['status'],row['next_check_at'],row['failures']))
                self.db.execute('DELETE FROM food_queue WHERE url=?',(row['url'],))
        self.db.commit()

    def queue(self, supplier, city, url):
        url=urldefrag(url)[0]
        self.db.execute('INSERT OR IGNORE INTO food_queue(url,supplier,city) VALUES (?,?,?)', (url,supplier,city))
        self.db.commit()

    def due(self, now=None, limit=48, per_supplier=6):
        now=now or datetime.now(timezone.utc)
        cutoff=(now-timedelta(hours=24)).isoformat()
        # Round robin prevents Aswak's hundreds of discovered pages from
        # starving BIM, Marjane or Carrefour indefinitely.
        return self.db.execute('''SELECT * FROM (
          SELECT *,ROW_NUMBER() OVER(PARTITION BY supplier ORDER BY checked_at,url) AS rank
          FROM food_queue WHERE (next_check_at IS NOT NULL AND next_check_at<=?)
          OR (next_check_at IS NULL AND (checked_at IS NULL OR checked_at<?)))
          WHERE rank<=? ORDER BY rank,checked_at,supplier LIMIT ?''',
          (now.isoformat(),cutoff,per_supplier,limit)).fetchall()

    def finish_page(self, url, status, now, has_prices=False, pending=False):
        row=self.db.execute('SELECT failures FROM food_queue WHERE url=?',(url,)).fetchone()
        failed=status in ('accès ou extraction bloqué','aucun prix structuré : extraction à compléter')
        failures=(row['failures'] or 0)+1 if failed else 0
        # Access/extraction errors are retried with bounded backoff; successful
        # pages are daily, catalogue OCR pending pages hourly.
        hours=min(6,2**min(failures-1,3)) if failed else (1 if pending else 24)
        self.db.execute('UPDATE food_queue SET checked_at=?,status=?,next_check_at=?,failures=? WHERE url=?',
            (now.isoformat(),status,(now+timedelta(hours=hours)).isoformat(),failures,url))
        self.db.commit()

    def coverage(self, now):
        cutoff=(now-timedelta(hours=24)).isoformat()
        result=[]
        for row in self.db.execute('SELECT DISTINCT supplier FROM food_queue ORDER BY supplier'):
            supplier=row['supplier']
            prices=self.db.execute('SELECT count(*) FROM (SELECT DISTINCT city,source_url FROM food_observations WHERE supplier=? AND observed_at>=?)',(supplier,cutoff)).fetchone()[0]
            pages=self.db.execute('SELECT count(*) FROM food_queue WHERE supplier=? AND checked_at>=?',(supplier,cutoff)).fetchone()[0]
            review=self.db.execute('SELECT count(*) FROM food_documents WHERE supplier=? AND state=?',(supplier,'à vérifier')).fetchone()[0]
            result.append({'supplier':supplier,'distinct_products_24h':prices,'pages_checked_24h':pages,
                'documents_to_verify':review,'coverage':'prix affichés relevés' if prices else 'documents à vérifier' if review else 'aucun prix récupéré'})
        return result

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
        cursor=self.db.execute('INSERT OR IGNORE INTO food_observations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
            (oid,observed_at,supplier,city,card['url'],card['title'],
             conversion[0] if conversion else None,str(conversion[1]) if conversion else None,
             str(price),int(bool(card.get('available'))),int(bool(card.get('promotion'))),raw))
        self.db.commit()
        return cursor.rowcount == 1

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
            if card.get('conditional') or card.get('review_required'):
                continue
            if card.get('valid_until'):
                try:
                    if datetime.fromisoformat(card['valid_until']).date()<now.date():continue
                except ValueError:continue
            if card.get('price_basis') != 'TTC':
                continue
            if card.get('max_qty_displayed') and amount(card['max_qty_displayed']) < amount(article['quantity']):
                continue
            from produce_sources import titled_unit
            sale_unit = card.get('unit') or titled_unit(row['title'])
            factor = produce_factor(article,row['title'],sale_unit)
            if factor is None:
                from sourcing import RULES
                aliases=RULES.get(canonical(article['designation']),())
                if (canonical(row['title']) in {canonical(t) for t in aliases}
                    and canonical(article.get('specification','')) in ('',canonical(article['designation']))
                    and row['unit']==canonical(article['unit']) and row['factor']):
                    factor=amount(row['factor'])
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


def validate_feed(payload, secret, now=None):
    import hmac
    from mail_bridge import signed_payload
    now=now or datetime.now(timezone.utc)
    if not hmac.compare_digest(str(payload.get('signature','')),signed_payload(payload,secret)):
        raise ValueError('Signature veille invalide')
    if payload.get('schema')!='food-watch-v1' or not isinstance(payload.get('observations'),list) or len(payload['observations'])>1000:
        raise ValueError('Format veille invalide')
    result=[]
    for row in payload['observations']:
        timestamp=datetime.fromisoformat(row['observed_at'])
        if timestamp.tzinfo is None or timestamp>now or timestamp<now-timedelta(days=90):
            raise ValueError('Date de relevé invalide')
        p=urlparse(row['url'])
        if p.scheme!='https' or p.username or p.password or not p.hostname or '.' not in p.hostname or p.port not in (None,443):
            raise ValueError('Source veille invalide')
        if row.get('currency')!='MAD' or row.get('price_basis') not in ('TTC','HT','non précisé'):
            raise ValueError('Devise ou base prix invalide')
        if not row.get('title') or not row.get('supplier') or not row.get('evidence') or amount(row['price'])<=0:
            raise ValueError('Relevé non documenté')
        if type(row.get('available')) is not bool:
            raise ValueError('Disponibilité non documentée')
        if row.get('max_qty_displayed'):
            amount(row['max_qty_displayed'])
        result.append({**row,'observed_at':timestamp.astimezone(timezone.utc).isoformat()})
    return result


def receive_feed(store):
    """Authenticated self-mail bridge: catalogue data, never portal instructions."""
    import imaplib
    from email import policy
    from email.parser import BytesParser
    from email.utils import parseaddr
    from credentials import credential_store
    config_path=os.environ.get('BC_MAIL_BRIDGE_CONFIG')
    if not config_path:
        return 0
    config=json.loads(Path(config_path).read_text())
    password=credential_store().get_password('FIMARO-BC-GMAIL-IMAP',config['account'])
    count=0
    with imaplib.IMAP4_SSL('imap.gmail.com',timeout=30) as mailbox:
        mailbox.login(config['account'],password)
        mailbox.select('INBOX',readonly=True)
        status,values=mailbox.uid('search',None,'SUBJECT','"[AGENT-FOOD-PRIX]"')
        if status!='OK':
            raise RuntimeError('Recherche veille Gmail impossible')
        for uid in values[0].split()[-40:]:
            status,parts=mailbox.uid('fetch',uid,'(BODY.PEEK[])')
            if status!='OK':continue
            raw=next((p[1] for p in parts if isinstance(p,tuple)),b'')
            if not raw or len(raw)>5*1024*1024:continue
            message=BytesParser(policy=policy.default).parsebytes(raw)
            mid=message.get('Message-ID','')
            if (not mid or parseaddr(message.get('From',''))[1].casefold()!=config['account'].casefold()
                or store.db.execute('SELECT 1 FROM food_feed_received WHERE message_id=?',(mid,)).fetchone()):continue
            try:
                payload=None
                for part in message.walk():
                    if part.get_content_type() not in ('text/plain','application/json'):continue
                    body=part.get_content()
                    if isinstance(body,bytes):body=body.decode('utf-8')
                    try:
                        data=json.loads(body)
                    except ValueError:continue
                    if isinstance(data,dict):payload=data;break
                if payload is None:raise ValueError('JSON de veille absent')
                rows=validate_feed(payload,config['secret'])
                imported=0
                for row in rows:
                    imported+=int(store.record(row['supplier'],row.get('city','non précisée'),row,row['observed_at']))
                store.db.execute('INSERT INTO food_feed_received VALUES (?,?)',(mid,imported))
                store.db.commit()
                count+=imported
            except (ValueError,KeyError,TypeError,ArithmeticError):
                print('FOOD_FEED_REJECTED',mid,flush=True)
    print('FOOD_FEED_IMPORTED',count,flush=True)
    return count


def collect(limit=None):
    from playwright.sync_api import sync_playwright
    from sourcing import MerchantPage
    from catalogue_readers import read_cards, read_assets
    DATA.mkdir(exist_ok=True)
    store=FoodStore(DATA/'food-watch.sqlite')
    try:
        receive_feed(store)
    except Exception as exc:
        print('FOOD_FEED_ERROR',type(exc).__name__,flush=True)
    for source in SOURCES:
        store.queue(*source)
    if not store.db.execute("SELECT 1 FROM food_meta WHERE key='regional-parser-v3'").fetchone():
        store.db.execute("UPDATE food_queue SET checked_at=NULL WHERE supplier LIKE 'Aswak%'")
        store.db.execute("INSERT INTO food_meta VALUES ('regional-parser-v3','ready')")
        store.db.commit()
    limit=limit or int(os.environ.get('BC_FOOD_PAGES_PER_PASS','48'))
    if not store.db.execute("SELECT 1 FROM food_meta WHERE key='catalogue-readers-v4'").fetchone():
        store.db.execute("UPDATE food_queue SET next_check_at=NULL,checked_at=NULL WHERE supplier IN ('BIM','Marjane','Carrefour','Carrefour via Bringo','Atacadao')")
        store.db.execute("INSERT INTO food_meta VALUES ('catalogue-readers-v4','ready')")
        store.db.commit()
    work=store.due(limit=limit)
    summary={'started_at':datetime.now(timezone.utc).isoformat(),'pages':[],'observations':0}
    with sync_playwright() as pw:
        browser=pw.chromium.launch(headless=True,chromium_sandbox=False)
        for task in work:
            now=datetime.now(timezone.utc).isoformat()
            reader=MerchantPage(browser,task['supplier'],task['url'])
            entry={'supplier':task['supplier'],'city':task['city'],'url':task['url']}
            try:
                body=reader.open(task['url'])
                cards=reader.page.locator('.product').evaluate_all(EXTRACT)
                if reader.host in ('www.aswakdelivery.com','www.aswakdrive.com'):
                    cards=reader.page.locator('a[href]').evaluate_all(REGIONAL_EXTRACT)
                elif reader.host in ('www.marjane.ma','marjane.ma','carrefour.ma','www.bringo.ma','www.atacadao.ma'):
                    cards=read_cards(reader)
                count=0
                for card in cards:
                    if urlparse(card['url']).hostname==reader.host:
                        if card.get('price_basis')!='TTC':
                            card['price_basis']='TTC' if re.search(r'prix[^\n]{0,70}(?:TTC|toutes taxes comprises)',body,re.I) else 'non précisé'
                        count+=int(store.record(task['supplier'],task['city'],card,now))
                entry.update(cards=len(cards),observations=count,status='prix relevés' if count else 'aucun prix structuré : extraction à compléter')
                if reader.host in ('www.bim.ma','www.marjane.ma','marjane.ma','carrefour.ma','www.atacadao.ma'):
                    entry.update(read_assets(store,reader,task['supplier'],task['city'],now))
                    if not count and entry['documents_discovered']:
                        entry['status']='catalogue collecté : prix à vérifier'
                evidence=json.dumps({'body':body[:120000],'cards':cards},ensure_ascii=False).encode()
                eid=hashlib.sha256((task['url']+now).encode()).hexdigest()
                store.db.execute('INSERT INTO food_pages VALUES (?,?,?,?)',(eid,now,task['url'],zlib.compress(evidence)))
                links=reader.page.locator('a[href]').evaluate_all('els=>els.map(e=>({url:e.href,text:e.innerText.trim()}))')
                prefix='/'+task['url'].split('/',3)[3].split('/')[0]+'/' if reader.host in ('www.aswakdelivery.com','www.aswakdrive.com') else '/'
                for link in links:
                    parsed=urlparse(link['url'])
                    if (parsed.hostname==reader.host and parsed.scheme=='https' and not parsed.query
                        and not parsed.fragment and parsed.path.startswith(prefix)
                        and any(s in parsed.path for s in ('product-category/','categorie-produit/','/shop/page/','/boutique/page/'))):
                        # Food aisles only, excludes cleaning and non-food.
                        if any(t in canonical(parsed.path) for t in ('fruits','legumes','epicerie','boucherie','volaille','poisson','cremerie','lait','fromage','boisson','boulangerie','surgel','charcuterie','oeuf','biscuit','confiser','terroir','patisserie')) or '/shop/page/' in parsed.path or '/boutique/page/' in parsed.path:
                            store.queue(task['supplier'],task['city'],link['url'])
                    if (parsed.scheme=='https' and parsed.hostname==reader.host and not parsed.fragment
                        and reader.host in ('marjane.ma','www.marjane.ma','carrefour.ma')
                        and any(t in parsed.path for t in ('/new-catalog/','/catalogue/','/catalogues/'))):
                        store.queue(task['supplier'],task['city'],link['url'])
                    if (reader.host=='www.bringo.ma' and parsed.hostname==reader.host
                        and parsed.path==urlparse(task['url']).path and re.fullmatch(r'\d{1,3}',link['text'])):
                        store.queue(task['supplier'],task['city'],link['url'])
                summary['observations']+=count
            except Exception as exc:
                entry.update(status='accès ou extraction bloqué',error_type=type(exc).__name__,detail=str(exc)[:180])
            finally:
                reader.close()
            store.finish_page(task['url'],entry['status'],datetime.fromisoformat(now),
                              pending=bool(entry.get('documents_pending')))
            summary['pages'].append(entry)
            print('FOOD_WATCH_PAGE',json.dumps(entry,ensure_ascii=False),flush=True)
        browser.close()
    summary['total_observations']=store.db.execute('SELECT count(*) FROM food_observations').fetchone()[0]
    summary['queued_pages']=store.db.execute('SELECT count(*) FROM food_queue').fetchone()[0]
    summary['coverage']=store.coverage(datetime.now(timezone.utc))
    summary['finished_at']=datetime.now(timezone.utc).isoformat()
    store.db.execute('INSERT INTO food_runs VALUES (?,?,?,?)',
        (summary['started_at'],summary['started_at'],summary['finished_at'],json.dumps(summary,ensure_ascii=False)))
    store.db.commit()
    store.close()
    (DATA/'food-watch-status.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
    print('FOOD_WATCH_COMPLETE',json.dumps(summary,ensure_ascii=False),flush=True)
    print('FOOD_WATCH_COVERAGE',json.dumps(summary['coverage'],ensure_ascii=False),flush=True)
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
