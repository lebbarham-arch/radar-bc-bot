"""Découverte Web ouverte : vendeurs non prédéfinis, aucune utilisation des snippets comme prix."""
import base64
import ipaddress
import json
import hashlib
import sqlite3
import re
import socket
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, quote_plus, urlparse
from sourcing import MerchantPage, canonical, products_from_json, structured_price, public_line


def destination(url):
    p = urlparse(url)
    if p.hostname in ('www.bing.com', 'bing.com') and p.path.startswith('/ck/'):
        value = parse_qs(p.query).get('u', [''])[0]
        if value.startswith('a1'):
            try:
                url = base64.urlsafe_b64decode(value[2:] + '=' * (-len(value[2:]) % 4)).decode()
            except (ValueError, UnicodeError):
                return None
    p = urlparse(url)
    if (p.scheme != 'https' or p.username or p.password or p.port not in (None, 443)
            or not p.hostname or '.' not in p.hostname or p.hostname.endswith(('.local', '.localhost'))):
        return None
    if p.hostname in ('www.marchespublics.gov.ma', 'www.bing.com', 'bing.com'):
        return None
    try:
        if not ipaddress.ip_address(p.hostname).is_global:
            return None
    except ValueError:
        pass
    return url


class WebSource(MerchantPage):
    def __init__(self, browser):
        super().__init__(browser, 'Recherche Web ouverte', 'https://www.bing.com')
        self.cache = {}
        self.search_count = 0
        self.public_hosts = set()
        folder = Path(__file__).resolve().parent / 'donnees'
        folder.mkdir(exist_ok=True)
        self.db = sqlite3.connect(folder / 'web-search.sqlite')
        self.db.execute('CREATE TABLE IF NOT EXISTS searches (article_id TEXT PRIMARY KEY, at TEXT, offers TEXT, leads TEXT)')
        self.db.execute('CREATE TABLE IF NOT EXISTS discoveries (id TEXT PRIMARY KEY, article_id TEXT, at TEXT, offers TEXT, leads TEXT)')
        self.db.execute('CREATE TABLE IF NOT EXISTS supplier_directory (host TEXT PRIMARY KEY, evidence TEXT, verified_at TEXT)')
        self.db.commit()

    def seller_page(self, url):
        url = destination(url)
        if not url:
            raise RuntimeError('Destination non publique')
        host = urlparse(url).hostname
        if host not in self.public_hosts:
            addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
            if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
                raise RuntimeError('Adresse réseau non publique')
            self.public_hosts.add(host)
        # Chaque vendeur dans un contexte sans cookies du portail.
        old_host = self.host
        self.host = host
        try:
            return self.open(url)
        finally:
            self.host = old_host

    def quote(self, articles):
        result = []
        for article in articles:
            key = (article['designation'], article['specification'], article['unit'])
            article_id = hashlib.sha256(json.dumps(key, ensure_ascii=False).encode()).hexdigest()
            prior = self.db.execute('SELECT at,offers,leads FROM searches WHERE article_id=?', (article_id,)).fetchone()
            if prior and datetime.fromisoformat(prior[0]) > datetime.now(timezone.utc) - timedelta(hours=4):
                result.extend({**offer, 'article': article} for offer in json.loads(prior[1]))
                self.events.append({'article': article['designation'], 'leads': json.loads(prior[2]), 'cached_at': prior[0]})
                continue
            if key in self.cache:
                result.extend(self.cache[key])
                continue
            if self.search_count >= 40:
                self.events.append({'supplier': self.name, 'reason': '40 articles recherchés ; suite au prochain passage'})
                break
            self.search_count += 1
            found, leads = [], []
            technical = article.get('specification', '')[:180]
            for terms in (article['designation']+' '+technical+' prix Maroc', article['designation']+' '+technical+' fournisseur Maroc devis'):
                url = self.origin+'/search?q='+quote_plus(terms)
                try:
                    self.open(url)
                    links = self.page.locator('li.b_algo h2 a').evaluate_all(
                        'els=>els.filter(e=>e.getClientRects().length).map(e=>({url:e.href,title:e.innerText.trim()}))')
                    if not links:
                        self.events.append({'source': url, 'reason': 'aucun résultat lisible ; accès ou interface à vérifier'})
                    for link in links[:8]:
                        target = destination(link['url'])
                        if target and target not in {l['url'] for l in leads}:
                            leads.append({'url': target, 'title': link['title']})
                except Exception as exc:
                    self.failure(url, exc)
            for lead in leads[:12]:
                try:
                    body = self.seller_page(lead['url'])
                    # Les contacts sont des pistes, jamais des destinataires supposés.
                    emails = self.page.locator('a[href^="mailto:"]').evaluate_all(
                        'els=>els.filter(e=>e.getClientRects().length).map(e=>e.getAttribute("href").slice(7).split("?")[0])')
                    lead['published_emails'] = sorted(set(emails))
                    relevant = any(word in canonical(body) for word in canonical(article['designation']).split() if len(word)>3)
                    lead['commercial_context'] = relevant and any(word in canonical(body) for word in ('produit','catalogue','devis','distributeur','fabricant','prix'))
                    normalized=canonical(body)
                    lead['supplier_type'] = ('fabricant' if re.search(r'(nous fabriquons|notre usine|fabricant de|fabrication de)', normalized) else
                        'grand distributeur' if re.search(r'(distributeur agree|distributeur officiel|distribution nationale|importateur distributeur)',normalized) else
                        'spécialiste' if re.search(r'(specialiste|specialise|specialisee)',normalized) else 'non classé')
                    lead['morocco'] = urlparse(lead['url']).hostname.endswith('.ma') or any(word in canonical(body) for word in ('maroc','rabat','casablanca','temara','sale'))
                    if lead['commercial_context'] and lead['morocco'] and not emails:
                        contact_links = self.page.locator('a[href]').evaluate_all('els=>els.filter(e=>e.getClientRects().length && /contact/i.test(e.innerText)).map(e=>e.href)')
                        for contact_url in contact_links[:2]:
                            if urlparse(contact_url).hostname != urlparse(lead['url']).hostname:
                                continue
                            self.seller_page(contact_url)
                            emails = self.page.locator('a[href^="mailto:"]').evaluate_all('els=>els.filter(e=>e.getClientRects().length).map(e=>e.getAttribute("href").slice(7).split("?")[0])')
                            if emails:
                                lead['published_emails'] = sorted(set(emails))
                                lead['contact_url'] = contact_url
                                break
                        # Revenir à la fiche produit pour relever son prix.
                        body = self.seller_page(lead['url'])
                    blocks = self.page.locator('script[type="application/ld+json"]').all_text_contents()
                    h1 = self.page.locator('h1:visible')
                    if h1.count() != 1:
                        continue
                    prices = []
                    for block in blocks:
                        try:
                            for product in products_from_json(json.loads(block)):
                                if canonical(product.get('name', '')) != canonical(h1.inner_text()):
                                    continue
                                price = structured_price(article, product, body)
                                if price is not None:
                                    prices.append(price)
                        except (json.JSONDecodeError, TypeError):
                            continue
                    if prices and len(set(prices)) == 1:
                        found.append(public_line(article, prices[0], lead['url'], urlparse(lead['url']).hostname,
                            'offre exacte en MAD TTC ; quantité à confirmer'))
                except Exception as exc:
                    self.failure(lead['url'], exc)
            self.events.append({'supplier': self.name, 'article': article['designation'], 'leads': leads,
                                'accepted_offers': len(found)})
            self.cache[key] = found
            self.db.execute('INSERT OR REPLACE INTO searches VALUES (?,?,?,?)',
                (article_id, datetime.now(timezone.utc).isoformat(), json.dumps(found, ensure_ascii=False), json.dumps(leads, ensure_ascii=False)))
            observed=datetime.now(timezone.utc).isoformat()
            self.db.execute('INSERT OR IGNORE INTO discoveries VALUES (?,?,?,?,?)',
                (hashlib.sha256((article_id+observed).encode()).hexdigest(),article_id,observed,json.dumps(found,ensure_ascii=False),json.dumps(leads,ensure_ascii=False)))
            for lead in leads:
                if lead.get('commercial_context') and lead.get('morocco') and lead.get('published_emails'):
                    self.db.execute('INSERT OR REPLACE INTO supplier_directory VALUES (?,?,?)',
                        (urlparse(lead['url']).hostname,json.dumps(lead,ensure_ascii=False),observed))
            self.db.commit()
            result.extend(found)
        return result

    def close(self):
        self.db.close()
        super().close()
