"""Read public retail cards and archive image/PDF catalogue OCR separately.

OCR is evidence awaiting verification, never an automatically confirmed offer.
No messages, purchases or portal actions are performed by this module.
"""
import hashlib
import io
import json
import re
import subprocess
import tempfile
from datetime import datetime,timedelta
from pathlib import Path
from urllib.parse import urlparse

from sourcing import canonical

# Match a single linked product to its own price; never parse the whole page
# as one offer. Conditional loyalty/multi-buy prices are not ordinary prices.
RETAIL_CARDS = r'''els=>{
 const rows=new Map();
 for(const a of els){
  if(!a.getClientRects().length || !a.innerText.trim())continue;
  if(!/\/(?:products?|produits?|p)\//i.test(a.pathname))continue;
  let e=a.parentElement;
  for(let i=0;e&&i<7;i++,e=e.parentElement){
   const urls=new Set([...e.querySelectorAll('a[href]')].filter(n=>/\/(?:products?|produits?|p)\//i.test(n.pathname)).map(n=>n.href));
   if(urls.size>1)break;
   const raw=e.innerText;
   if(!/\b(?:DH|MAD)\b/i.test(raw))continue;
   const heading=e.querySelector('h2,h3,h4,.product-title');
   const title=(heading?heading.innerText:a.innerText).trim();
   const clone=e.cloneNode(true);
   clone.querySelectorAll('del,s,[style*="line-through"]').forEach(n=>n.remove());
   const walker=document.createTreeWalker(clone,NodeFilter.SHOW_TEXT);
   const parts=[];let node;
   while((node=walker.nextNode()))parts.push(node.nodeValue.trim());
   const clean=parts.join(' ');
   const vals=[...clean.matchAll(/(?<![\d.,])(\d+(?:[.,]\d{1,2})?)\s*(?:DH|MAD)\b/gi)].map(m=>m[1]);
   if(new Set(vals).size!==1)continue;
   rows.set(a.href,{title,url:a.href,price:vals[0],currency:'MAD',unit:'',raw,
    promotion:!!e.querySelector('del,s'),price_basis:/\bTTC\b|toutes taxes comprises/i.test(raw)?'TTC':'non précisé',
    conditional:/carte|achet[eé]s|remise|fid[eé]lit[eé]|[àa] partir|environ/i.test(raw),
    available:/ajouter au panier|acheter|en stock/i.test(raw)&&!/rupture|indisponible|[eé]puis[eé]/i.test(raw)});
   break;
  }
 }
 return [...rows.values()];
}'''


def structured_products(documents, host):
    """Schema.org Product only, with one precise, MAD-denominated Offer."""
    rows=[]
    def walk(obj):
        if isinstance(obj,list):
            for child in obj: walk(child)
        elif isinstance(obj,dict):
            types=obj.get('@type',[])
            if isinstance(types,str): types=[types]
            if 'Product' in types:
                offers=obj.get('offers',[])
                if isinstance(offers,dict): offers=[offers]
                if len(offers)==1 and isinstance(offers[0],dict):
                    offer=offers[0]
                    url=offer.get('url') or obj.get('url','')
                    if (offer.get('@type')=='Offer' and offer.get('price') is not None
                            and offer.get('priceCurrency')=='MAD' and isinstance(url,str)
                            and urlparse(url).hostname==host):
                        rows.append({'title':obj.get('name',''),'url':url,
                            'price':str(offer['price']),'currency':'MAD','unit':'',
                            'available':str(offer.get('availability','')).endswith('/InStock'),
                            'promotion':False,'price_basis':'non précisé',
                            'valid_until':offer.get('priceValidUntil'),
                            'raw':json.dumps(obj,ensure_ascii=False)})
            for key in ('@graph','itemListElement','item','mainEntity'):
                if key in obj: walk(obj[key])
    for text in documents:
        try: walk(json.loads(text))
        except (ValueError,TypeError): pass
    return rows


def read_cards(reader):
    rows=reader.page.locator('a[href]').evaluate_all(RETAIL_CARDS)
    # Public structured data complements rendered cards without inventing a
    # local store, availability, format or tax classification.
    docs=reader.page.locator('script[type="application/ld+json"]').all_text_contents()
    by_url={r['url']:r for r in structured_products(docs,reader.host)}
    by_url.update({r['url']:r for r in rows})
    return [r for r in by_url.values() if not r.get('conditional')]


ASSET_HOSTS={
    'www.bim.ma':{'www.bim.ma'},
    'www.marjane.ma':{'www.marjane.ma','api-ayaline.marjane.ma'},
    'marjane.ma':{'marjane.ma','api-ayaline.marjane.ma'},
    'carrefour.ma':{'carrefour.ma','assets.carrefour.ma'},
    'www.atacadao.ma':{'www.atacadao.ma'},
}


def allowed_asset(url,host):
    p=urlparse(url)
    return (p.scheme=='https' and p.hostname in ASSET_HOSTS.get(host,set())
            and not p.username and not p.password and p.port in (None,443))


def discover_assets(reader):
    if reader.host=='www.bim.ma':
        values=reader.page.locator('.carousel-item img').evaluate_all(
            'els=>els.map(e=>({url:e.src,label:e.alt||""}))')
    else:
        values=reader.page.locator('a[href],img').evaluate_all(r'''els=>els.map(e=>({
            url:e.href||e.currentSrc||e.src,label:e.innerText||e.alt||''
        })).filter(e=>/\.pdf(?:\?|$)|catalog|depliant/i.test(e.url+' '+e.label))''')
    return list({r['url']:r for r in values if allowed_asset(r['url'],reader.host)}.values())


def extract_document(data,content_type):
    """Bounded sequential OCR. Keep text for review, never guess price pairs."""
    with tempfile.TemporaryDirectory() as folder:
        source=Path(folder)/'source'
        source.write_bytes(data)
        images=[]
        text=''
        if 'pdf' in content_type or data.startswith(b'%PDF'):
            from pypdf import PdfReader
            pdf=PdfReader(io.BytesIO(data))
            text='\n'.join((p.extract_text() or '') for p in list(pdf.pages)[:12])
            if len(text.strip())>=100:
                return text[:120000],'pdf-text'
            subprocess.run(['pdftoppm','-f','1','-l','6','-scale-to','2400','-png',str(source),str(Path(folder)/'page')],
                           check=True,capture_output=True,timeout=60)
            images=sorted(Path(folder).glob('page-*.png'))
        elif content_type.startswith('image/'):
            images=[source]
        else:
            raise ValueError('Format catalogue non reconnu')
        for image in images:
            result=subprocess.run(['tesseract',str(image),'stdout','-l','fra+ara+eng','--psm','11'],
                                  check=True,capture_output=True,timeout=45)
            text+='\n'+result.stdout.decode('utf-8',errors='replace')
        return text[:120000],'ocr-a-verifier'


def read_assets(store,reader,supplier,city,observed_at,limit=3):
    assets=discover_assets(reader)
    for row in assets:
        store.db.execute('INSERT OR IGNORE INTO food_documents(url,supplier,city,label,state) VALUES (?,?,?,?,?)',
                         (row['url'],supplier,city,row['label'],'à lire'))
    store.db.commit()
    cutoff=(datetime.fromisoformat(observed_at)-timedelta(hours=24)).isoformat()
    pending=store.db.execute('SELECT * FROM food_documents WHERE supplier=? AND (state IN (?,?) OR checked_at<?) ORDER BY checked_at,url LIMIT ?',
                            (supplier,'à lire','lecture en échec',cutoff,limit)).fetchall()
    count=0
    for row in pending:
        try:
            if not allowed_asset(row['url'],reader.host): continue
            # Redirects are validated before fetching their destination.
            url=row['url']
            for _ in range(4):
                response=reader.context.request.get(url,timeout=20000,max_redirects=0)
                if 300<=response.status<400:
                    from urllib.parse import urljoin
                    url=urljoin(url,response.headers.get('location',''))
                    response.dispose()
                    if not allowed_asset(url,reader.host):raise ValueError('Redirection catalogue interdite')
                    continue
                break
            if response.status!=200:raise ValueError('Catalogue HTTP '+str(response.status))
            if int(response.headers.get('content-length','0'))>8*1024*1024:raise ValueError('Catalogue trop grand')
            data=response.body()
            content_type=response.headers.get('content-type','').split(';')[0]
            response.dispose()
            if len(data)>8*1024*1024:raise ValueError('Catalogue trop grand')
            text,method=extract_document(data,content_type)
            state='à vérifier' if text.strip() else 'illisible'
            digest=hashlib.sha256(data).hexdigest()
            store.db.execute('UPDATE food_documents SET checked_at=?,sha256=?,method=?,text=?,state=? WHERE url=?',
                             (observed_at,digest,method,text,state,row['url']))
            identifier=hashlib.sha256((row['url']+observed_at+digest).encode()).hexdigest()
            store.db.execute('INSERT OR IGNORE INTO food_document_versions VALUES (?,?,?,?,?,?,?)',
                             (identifier,row['url'],observed_at,digest,method,text,state))
            count+=1
        except Exception as exc:
            store.db.execute('UPDATE food_documents SET checked_at=?,state=?,method=? WHERE url=?',
                             (observed_at,'lecture en échec',type(exc).__name__,row['url']))
        store.db.commit()
    remaining=store.db.execute('SELECT count(*) FROM food_documents WHERE supplier=? AND state IN (?,?)',
                               (supplier,'à lire','lecture en échec')).fetchone()[0]
    return {'documents_discovered':len(assets),'documents_read':count,'documents_pending':remaining}
