"""Recherche multi-enseignes de prix publics avec correspondances contrôlées."""
import re
import json
import unicodedata
from datetime import datetime
from decimal import Decimal
from zoneinfo import ZoneInfo
from urllib.parse import urlparse
from pricing import amount


def canonical(value):
    value = ''.join(c for c in unicodedata.normalize('NFKD', value)
                    if not unicodedata.combining(c)).casefold()
    return ' '.join(re.sub(r'[^a-z0-9]+', ' ', value).split())


# Correspondances explicites : un prix par kg, pièce ou botte, jamais par index.
# Les références techniques et conditionnements non couverts restent bloqués.
RULES = {
    'banane': ('BANANE 1 KG', 'BANANE IMPORT 1KG'),
    'mandarine': ('MANDARINE 1KG',),
    'citron': ('CITRON 1KG', 'CITRON JAUNE 1KG'),
    'oignons secs': ('OIGNON SEC 1KG', 'OIGNON BLANC 1KG', 'OIGNON ROUGE 1KG'),
    'concombre': ('CONCOMBRE 1KG',),
    'courgettes': ('COURGETTE 1KG',),
    'petit pois': ('PETIT POIS 1KG',),
    'poivron vert': ('POIVRON VERT 1KG',),
    'poivron rouge': ('POIVRON ROUGE 1KG',),
    'navets': ('NAVET 1KG',),
    'betteraves': ('BETTERAVE 1KG',),
    'haricots verts': ('HARICOT VERT 1KG',),
    'aubergine': ('AUBERGINE 1KG',),
    'choux blanc': ('CHOU BLANC 1KG',),
    'persil': ('PERSIL BOTTE',),
    'menthe': ('MENTHE BOTTE',),
    'celeri': ('CELERI BOTTE',),
}
CATALOGUES = [
    'https://aswakassalam.com/product-category/fruits-legumes/',
    'https://aswakassalam.com/product-category/fruits-legumes/page/2/',
    'https://aswakassalam.com/product-category/fruits-legumes/page/3/',
    'https://aswakassalam.com/product-category/fruits-legumes/page/4/',
]
KNOWN_PRODUCTS = {
    'banane 1 kg': {'https://aswakassalam.com/produit/banane-1-kg/'},
    'banane import 1kg': {'https://aswakassalam.com/produit/banane-import-1kg/'},
}


def parse_public_offer(title, text, expected_titles):
    if canonical(title) not in {canonical(t) for t in expected_titles}:
        return None, 'produit différent'
    start = text.find(title)
    if start < 0:
        return None, 'titre absent de la fiche'
    text = re.split(r'Produits similaires', text[start:], maxsplit=1, flags=re.I)[0]
    lower = canonical(text)
    if any(s in lower for s in ('rupture de stock', 'out of stock', 'epuise')):
        return None, 'rupture de stock'
    if 'en stock' not in lower:
        return None, 'stock non renseigné'
    # Coupe les produits recommandés qui suivent les informations de disponibilité.
    head = re.split(r'Version disponible', text, maxsplit=1, flags=re.I)[0]
    values = re.findall(r'(?<![\d.,])(\d+(?:[.,]\d{1,2})?)\s*(?:Dh|MAD)\b', head, re.I)
    distinct = list(dict.fromkeys(values))
    if len(distinct) != 1:
        return None, 'prix absent ou ambigu'
    value = amount(distinct[0])
    if value <= 0:
        return None, 'prix nul'
    return value, 'prix public relevé ; quantité fournisseur non vérifiée'


class AswakSource:
    def __init__(self, browser):
        # Contexte distinct : aucun cookie du portail envoyé aux vendeurs.
        self.context = browser.new_context(locale='fr-FR')
        self.page = self.context.new_page()
        self.page.set_default_timeout(10000)
        self.catalogue = {canonical(k): set(v) for k, v in KNOWN_PRODUCTS.items()}
        self.offers = {}
        self.events = []
        self.loaded = False

    def _open(self, url):
        p = urlparse(url)
        if p.scheme != 'https' or p.hostname not in ('aswakassalam.com', 'www.aswakassalam.com'):
            raise RuntimeError('Destination fournisseur inattendue')
        self.page.goto(url, wait_until='domcontentloaded', timeout=20000)
        if urlparse(self.page.url).hostname not in ('aswakassalam.com', 'www.aswakassalam.com'):
            raise RuntimeError('Redirection fournisseur inattendue')
        text = self.page.locator('body').inner_text()
        if any(t in canonical(text) for t in ('verify you are human', 'checking your browser', 'access denied')):
            raise RuntimeError('Accès fournisseur bloqué')
        return text

    def load(self):
        if self.loaded:
            return
        self.loaded = True
        for url in CATALOGUES:
            try:
                self._open(url)
                links = self.page.locator('a[href*="/produit/"]').evaluate_all(
                    'els=>els.filter(e=>e.getClientRects().length).map(e=>({url:e.href,title:e.innerText.trim()}))')
                for link in links:
                    if link['title']:
                        self.catalogue.setdefault(canonical(link['title']), set()).add(link['url'])
            except Exception as exc:
                self.events.append({'source': url, 'error_type': type(exc).__name__})
                break

    def quote(self, articles):
        if not any(canonical(a['designation']) in RULES for a in articles):
            return []
        self.load()
        now = datetime.now(ZoneInfo('Africa/Casablanca')).isoformat()
        lines = []
        for article in articles:
            aliases = RULES.get(canonical(article['designation']))
            if aliases:
                unit = canonical(article['unit'])
                aliases = tuple(a for a in aliases if
                    (unit == 'kg' and re.search(r'1\s*kg', a, re.I)) or
                    (unit == 'botte' and 'botte' in canonical(a)))
            if (not aliases or canonical(article['specification']) not in ('', canonical(article['designation']))
                    or canonical(article['unit']) not in ('kg', 'botte')):
                lines.append({'article': article, 'status': 'prix à confirmer',
                              'reason': 'désignation ou spécification non couverte par les sources automatiques'})
                continue
            candidates = []
            notes = []
            for alias in aliases:
                for url in sorted(self.catalogue.get(canonical(alias), [])):
                    if url not in self.offers:
                        try:
                            text = self._open(url)
                            heading = self.page.locator('h1')
                            title = heading.inner_text() if heading.count() == 1 else ''
                            value, status = parse_public_offer(title, text, aliases)
                            self.offers[url] = (value, status)
                        except Exception as exc:
                            self.offers[url] = (None, type(exc).__name__)
                    value, status = self.offers[url]
                    if value is not None:
                        candidates.append((value, url))
                    else:
                        notes.append({'url': url, 'reason': status})
            if candidates:
                price, url = min(candidates)
                lines.append({'article': article, 'status': 'prix public',
                              'purchase_unit_ttc': str(price), 'source_url': url,
                              'supplier': 'Aswak Assalam', 'observed_at': now,
                              'quantity_confirmed': False,
                              'reason': 'prix public unitaire ; quantité demandée non confirmée'})
            else:
                lines.append({'article': article, 'status': 'prix à confirmer',
                              'reason': 'aucune offre conforme disponible', 'sources_checked': notes})
        return lines

    def close(self):
        self.context.close()


BRINGO_CATEGORIES = (
    'https://www.bringo.ma/fr_MA/stores/carrefour-supermarket/legumes-au-kg',
    'https://www.bringo.ma/fr_MA/stores/carrefour-hypermarket/legumes-46',
    'https://www.bringo.ma/fr_MA/stores/carrefour-hypermarket/salades-et-herbes-1',
    'https://www.bringo.ma/fr_MA/stores/carrefour-supermarket/salades-herbes',
    'https://www.bringo.ma/fr_MA/stores/carrefour-hypermarket/fruits-exotiques-1',
    'https://www.bringo.ma/fr_MA/stores/carrefour-hypermarket/fruits-47',
    'https://www.bringo.ma/fr_MA/stores/carrefour-express/fruits-54',
)
# Base du titre, unité de vente explicite sur la fiche : aucune variété exigée
# n'est effacée. Les exigences « premier choix », « lavée », etc. restent bloquées.
CARREFOUR_NAMES = {
    'banane': ('banane', 'banane import', 'banane locale'),
    'citron': ('citron jaune', 'citron vert', 'citron jaune filet', 'citron vert filet'),
    'oignons secs': ('oignon blanc sec', 'oignon sec rouge'),
    'poivron rouge': ('poivron rouge',), 'poivron vert': ('poivron vert',),
    'courgettes': ('courgette blanche', 'courgette slaoui', 'courgette beldi'),
    'haricots verts': ('haricot vert',), 'aubergine': ('aubergine',),
    'concombre': ('concombre court', 'concombre long', 'concombre filet'),
    'navets': ('navet blanc', 'navet jaune', 'navet violet', 'navet beldi'),
    'betteraves': ('betterave',), 'petit pois': ('petits pois',),
    'persil': ('persil en botte', 'persil plat botte a la piece'),
    'menthe': ('menthe en botte',),
}


def carrefour_factor(article, title):
    """Nombre d'unités BC dans un article vendu, sans arrondir le prix d'achat."""
    designation = canonical(article['designation'])
    if canonical(article['specification']) not in ('', designation):
        return None
    aliases = CARREFOUR_NAMES.get(designation, ())
    title = canonical(title)
    if canonical(article['unit']) == 'kg':
        match = re.fullmatch(r'(.+?) (\d+(?: \d+)?)\s*(kg|g)', title)
        if not match or match[1] not in aliases:
            return None
        weight = amount(match[2].replace(' ', '.'))
        return weight / 1000 if match[3] == 'g' else weight
    if canonical(article['unit']) == 'botte' and title in aliases:
        return Decimal(1)
    return None


def parse_carrefour_card(article, title, text):
    factor = carrefour_factor(article, title)
    if not factor or factor <= 0:
        return None, 'produit, exigence ou unité différente'
    lower = canonical(text)
    if any(x in lower for x in ('rupture', 'indisponible', 'depuis', 'a partir de')):
        return None, 'stock ou prix non confirmé'
    if 'ajouter au panier' not in lower:
        return None, 'offre non disponible à la vente'
    values = re.findall(r'(?<![\d.,])(\d+(?:[.,]\d{1,2})?)\s*MAD\b', text, re.I)
    if len(set(values)) != 1 or '~' in text:
        return None, 'prix absent, estimatif ou ambigu'
    price = amount(values[0])
    return (price / factor, 'prix public ; quantité non vérifiée') if price > 0 else (None, 'prix nul')


class MerchantPage:
    def __init__(self, browser, name, origin):
        self.name, self.origin = name, origin
        self.host = urlparse(origin).hostname
        self.context = browser.new_context(locale='fr-FR')
        self.page = self.context.new_page()
        self.page.set_default_timeout(10000)
        self.events = []

    def open(self, url):
        parsed = urlparse(url)
        if (parsed.scheme != 'https' or parsed.hostname != self.host
                or parsed.username or parsed.password):
            raise RuntimeError('Destination fournisseur inattendue')
        self.page.goto(url, wait_until='domcontentloaded', timeout=20000)
        if urlparse(self.page.url).hostname != self.host:
            raise RuntimeError('Redirection fournisseur inattendue')
        body = self.page.locator('body').inner_text()
        if any(t in canonical(body) for t in ('verify you are human', 'checking your browser', 'access denied')):
            raise RuntimeError('Accès fournisseur bloqué')
        return body

    def failure(self, url, exc):
        self.events.append({'supplier': self.name, 'source': url,
                            'error_type': type(exc).__name__, 'reason': str(exc)[:160]})

    def close(self):
        self.context.close()


class CarrefourSource(MerchantPage):
    def __init__(self, browser):
        super().__init__(browser, 'Carrefour via Bringo', 'https://www.bringo.ma')
        self.cards = None
        self.details = {}

    def load(self):
        if self.cards is not None:
            return
        self.cards = []
        visited = set()
        queue = list(BRINGO_CATEGORIES)
        # Pagination suivie depuis les liens réellement présents, limite explicite.
        while queue and len(visited) < 15:
            url = queue.pop(0)
            if url in visited:
                continue
            visited.add(url)
            try:
                self.open(url)
                # Un bloc doit contenir exactement un produit distinct : évite de
                # mélanger son prix et celui d'un produit voisin.
                cards = self.page.locator('a[href*="/products/"]').evaluate_all('''els=>els.filter(e=>e.getClientRects().length && e.innerText.trim()).map(e=>{
                    let p=e.parentElement;
                    for(let i=0;p && i<7;i++,p=p.parentElement){
                        const urls=new Set([...p.querySelectorAll('a[href*="/products/"]')].map(a=>a.href));
                        const t=p.innerText;
                        if(urls.size===1 && /MAD/.test(t) && /Ajouter au panier/i.test(t))
                            return {title:e.innerText.trim(),url:e.href,text:t};
                        if(urls.size>1) break;
                    }
                    return null;
                }).filter(Boolean)''')
                self.cards.extend(cards)
                links = self.page.locator('a[href]').evaluate_all(
                    'els=>els.filter(e=>e.getClientRects().length).map(e=>({url:e.href,text:e.innerText.trim()}))')
                path = urlparse(url).path
                for link in links:
                    p = urlparse(link['url'])
                    if p.hostname == self.host and p.path == path and (
                            re.fullmatch(r'[1-9]\d?', link['text']) or link['text'] == '100'):
                        if link['url'] not in visited and link['url'] not in queue:
                            queue.append(link['url'])
                self.events.append({'supplier': self.name, 'source': url, 'cards_read': len(cards)})
            except Exception as exc:
                self.failure(url, exc)

    def quote(self, articles):
        if not any(canonical(a['designation']) in CARREFOUR_NAMES for a in articles):
            return []
        self.load()
        offers = []
        for article in articles:
            for card in self.cards:
                price, status = parse_carrefour_card(article, card['title'], card['text'])
                if price is not None:
                    # La catégorie peut encore afficher un article dont la fiche
                    # annonce une rupture. On relit la fiche avant de l'utiliser.
                    if card['url'] not in self.details:
                        try:
                            text = self.open(card['url'])
                            h1 = self.page.locator('h1:visible')
                            title = h1.first.inner_text() if h1.count() else ''
                            start = text.find(title) if title else -1
                            main = re.split(r'Produits similaires', text[start:], maxsplit=1, flags=re.I)[0] if start >= 0 else ''
                            main = re.split(r'Préférences|Numéro du produit', main, maxsplit=1, flags=re.I)[0]
                            self.details[card['url']] = (title, main)
                        except Exception as exc:
                            self.failure(card['url'], exc)
                            self.details[card['url']] = ('', '')
                    title, main = self.details[card['url']]
                    # Les prix « depuis » sont conservés comme pistes seulement.
                    if canonical(title) != canonical(card['title']) or any(
                            s in canonical(main) for s in ('rupture', 'indisponible', 'depuis', 'a partir de')):
                        continue
                    values = re.findall(r'(?<![\d.,])(\d+(?:[.,]\d{1,2})?)\s*MAD\b', main, re.I)
                    if len(set(values)) != 1 or amount(values[0]) / carrefour_factor(article, title) != price:
                        continue
                    offers.append(public_line(article, price, card['url'], self.name,
                                              'prix public converti dans l’unité BC ; quantité non vérifiée'))
        return offers


def public_line(article, price, url, supplier, reason):
    return {'article': article, 'status': 'prix public', 'purchase_unit_ttc': str(price),
            'source_url': url, 'supplier': supplier,
            'observed_at': datetime.now(ZoneInfo('Africa/Casablanca')).isoformat(),
            'quantity_confirmed': False, 'reason': reason}


def products_from_json(value):
    if isinstance(value, list):
        for item in value:
            yield from products_from_json(item)
    elif isinstance(value, dict):
        types = value.get('@type', [])
        if 'Product' in ([types] if isinstance(types, str) else types):
            yield value
        for key in ('@graph', 'itemListElement', 'item'):
            if key in value:
                yield from products_from_json(value[key])


def structured_price(article, product, visible_text=''):
    # Exact title AND full requested specification, no keyword resemblance.
    factor = Decimal(1)
    if canonical(article['unit']) in ('kg', 'botte'):
        from produce_sources import produce_factor, titled_unit
        factor = produce_factor(article, product.get('name', ''), titled_unit(product.get('name', '')))
        if factor is None:
            return None
    elif canonical(product.get('name', '')) != canonical(article['designation']):
        return None
    spec = canonical(article['specification'])
    if spec not in ('', canonical(article['designation'])) and spec not in canonical(product.get('description', '')):
        return None
    if canonical(article['unit']) not in ('un', 'u', 'unite', 'piece', 'kg', 'botte'):
        return None
    if re.search(r'\b(lot|pack|paquet|boite|coffret)\b', canonical(product.get('name', ''))):
        return None
    if not re.search(r'\bTTC\b', visible_text, re.I) or re.search(r'\b(prix\s+HT|hors\s+taxes)\b', visible_text, re.I):
        return None
    offers = product.get('offers', [])
    offers = [offers] if isinstance(offers, dict) else offers
    prices = []
    for offer in offers:
        if (offer.get('@type') != 'Offer' or offer.get('priceCurrency') != 'MAD'
                or str(offer.get('availability', '')).rsplit('/', 1)[-1] != 'InStock'):
            continue
        # A quantity tier must not silently become the unit price.
        if offer.get('eligibleQuantity') or offer.get('priceSpecification'):
            continue
        try:
            price = amount(offer['price'])
            if price > 0:
                prices.append(price)
        except (KeyError, ValueError, ArithmeticError):
            continue
    return prices[0] / factor if prices and len(set(prices)) == 1 else None


class SearchMerchant(MerchantPage):
    """Utilise le champ de recherche public du vendeur, puis ses fiches JSON-LD."""
    def __init__(self, browser, name, origin):
        super().__init__(browser, name, origin)
        self.cache = {}
        self.search_count = 0

    def quote(self, articles):
        offers = []
        for article in articles:
            # Les kilogrammes/bottes sont traités par les lecteurs alimentaires.
            if canonical(article['unit']) not in ('un', 'u', 'unite', 'piece'):
                continue
            key = (article['designation'], article['specification'], article['unit'])
            if key not in self.cache:
                if self.search_count >= 20:
                    self.events.append({'supplier': self.name, 'reason': 'limite de 20 recherches atteinte dans cette exécution'})
                    continue
                self.search_count += 1
                self.cache[key] = self.search(article)
            offers.extend(self.cache[key])
        return offers

    def search(self, article):
        found = []
        try:
            self.open(self.origin)
            search = self.page.locator('input:visible')
            candidates = search.evaluate_all('''els=>els.map(e=>({id:e.id,name:e.name,type:e.type,
                placeholder:e.placeholder})).filter(e=>e.type==='search' ||
                /recherch|search/i.test(e.placeholder+' '+e.name+' '+e.id))''')
            if len(candidates) != 1:
                raise RuntimeError('Champ de recherche absent ou ambigu')
            field = candidates[0]
            if field['id']:
                locator = self.page.locator('[id='+json.dumps(field['id'])+']:visible')
            elif field['name']:
                locator = self.page.locator('input[name='+json.dumps(field['name'])+']:visible')
            else:
                raise RuntimeError('Champ de recherche sans identifiant')
            locator.fill(article['designation'])
            locator.press('Enter')
            self.page.wait_for_load_state('domcontentloaded')
            self.page.wait_for_timeout(1000)
            if urlparse(self.page.url).hostname != self.host:
                raise RuntimeError('Redirection fournisseur inattendue')
            links = self.page.locator('a[href]:visible').evaluate_all(
                'els=>els.map(e=>({url:e.href,title:e.innerText.trim()}))')
            urls = sorted({l['url'] for l in links if canonical(l['title']) == canonical(article['designation'])
                           and urlparse(l['url']).hostname == self.host})[:6]
            if not urls:
                self.events.append({'supplier': self.name, 'article': article['designation'],
                                    'reason': 'aucune fiche avec titre exact dans les résultats'})
            for url in urls:
                try:
                    body = self.open(url)
                    heading = self.page.locator('h1:visible')
                    if heading.count() != 1 or canonical(heading.inner_text()) != canonical(article['designation']):
                        continue
                    blocks = self.page.locator('script[type="application/ld+json"]').all_text_contents()
                    prices = []
                    for block in blocks:
                        try:
                            for product in products_from_json(json.loads(block)):
                                price = structured_price(article, product, body)
                                if price is not None:
                                    prices.append(price)
                        except (json.JSONDecodeError, TypeError):
                            continue
                    if prices and len(set(prices)) == 1:
                        found.append(public_line(article, prices[0], url, self.name,
                                                 'fiche exacte et offre MAD en stock ; quantité non vérifiée'))
                    else:
                        self.events.append({'supplier': self.name, 'source': url,
                                            'reason': 'prix structuré, stock ou spécifications non confirmés'})
                except Exception as exc:
                    self.failure(url, exc)
        except Exception as exc:
            self.failure(self.origin, exc)
        return found


class PublicSources:
    def __init__(self, browser):
        from web_sources import WebSource
        from produce_sources import ProduceCatalogue
        self.readers = [ProduceCatalogue(browser), AswakSource(browser), CarrefourSource(browser),
                        SearchMerchant(browser, 'Marjane Mall', 'https://www.marjanemall.ma'),
                        SearchMerchant(browser, 'Bricoma', 'https://www.bricoma.ma'), WebSource(browser)]
        self.events = []

    def quote(self, articles):
        observations = []
        from pathlib import Path
        path = Path(__file__).resolve().parent / 'donnees' / 'food-watch.sqlite'
        if path.exists():
            from food_watch import FoodStore
            watch = FoodStore(path)
            try:
                for article in articles:
                    observations.extend(watch.candidates(article))
            finally:
                watch.close()
        for reader in self.readers:
            print('Recherche fournisseur :', getattr(reader, 'name', 'Aswak Assalam'), flush=True)
            try:
                observations.extend(reader.quote(articles))
            except Exception as exc:
                self.events.append({'supplier': getattr(reader, 'name', 'Aswak Assalam'),
                                    'error_type': type(exc).__name__})
            self.events.extend(reader.events)
            reader.events.clear()
        result = []
        for article in articles:
            candidates = [o for o in observations if o['article'] == article and o['status'] == 'prix public']
            if candidates:
                best = dict(min(candidates, key=lambda o: amount(o['purchase_unit_ttc'])))
                best['compared_offers'] = candidates
                result.append(best)
            else:
                result.append({'article': article, 'status': 'prix à confirmer',
                               'reason': 'aucune offre conforme parmi les enseignes consultées',
                               'sources_checked': [o for o in observations if o['article'] == article]})
        return result

    def close(self):
        for reader in self.readers:
            reader.close()
