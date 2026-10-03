"""Live produce catalogues: explicit retail units, isolated current prices.

Unknown grades, variable weights, unavailable products and extra specifications
are rejected. Public availability never confirms the requested bulk quantity.
"""
import re
from decimal import Decimal
from sourcing import canonical, amount, MerchantPage, public_line

NAMES = {
    'banane': ('banane', 'banane du maroc'),
    'mandarine': ('mandarine', 'premiere mandarine'),
    'citron': ('citron', 'citron jaune', 'citron jaune premium'),
    'persil': ('persil', 'persil botte'),
    'menthe': ('menthe', 'menthe botte'),
    'celeri': ('celeri', 'celeri botte'),
    'concombre': ('concombre',),
    'courgettes': ('courgette', 'courgette blanche', 'courgette ronde'),
    'petit pois': ('petit pois', 'petits pois'),
    'poivron vert': ('poivron vert',),
    'poivron rouge': ('poivron rouge',),
    'navets': ('navet blanc', 'navet jaune', 'navet violet', 'navet'),
    'betteraves': ('betterave',),
    'haricots verts': ('haricot vert',),
    'aubergine': ('aubergine', 'aubergine blanche'),
    'choux blanc': ('chou blanc',),
    'oignons secs': ('oignon sec rouge', 'oignon blanc sec', 'oignon rouge', 'oignon blanc'),
    'oignons verts': ('oignon vert', 'oignons verts'),
    'potiron rouge': ('potiron rouge',),
    # Merchant product description identifies Salade Beldia as a traditional
    # lettuce, sold per piece. It is not a mixed salad or a weight-priced bag.
    'laitue salade vert': ('laitue', 'laitue verte', 'laitue sucrine', 'salade beldia'),
}


def titled_unit(title):
    weights = re.findall(r'\b\d+(?:[.,]\d+)?(?:\s*/\s*\d+)?\s*(?:kg|gr|g)\b', title, re.I)
    if len(weights) == 1:
        return weights[0]
    return 'botte' if re.search(r'\bbotte\b', canonical(title)) else ''


def weight(value):
    value = value.strip().lower().replace(',', '.')
    m = re.fullmatch(r'(\d+(?:\.\d+)?)(?:\s*/\s*(\d+))?\s*(kg|g|gr)', value)
    if not m:
        return None
    divisor = Decimal(m[2] or '1')
    if divisor <= 0:
        return None
    result = Decimal(m[1]) / divisor / (1000 if m[3] != 'kg' else 1)
    return result if result > 0 else None


def produce_factor(article, title, sale_unit):
    designation = canonical(article['designation'])
    if canonical(article['specification']) not in ('', designation):
        return None
    # Remove only an explicit exact weight, never a quality or cultivar.
    clean = re.sub(r'(?<![\d-])\b\d+(?:[.,]\d+)?(?:\s*/\s*\d+)?\s*(?:kg|gr|g)\b', '', title, flags=re.I)
    if canonical(clean) not in NAMES.get(designation, ()):
        return None
    unit = canonical(article['unit'])
    if unit == 'kg':
        factor = weight(sale_unit)
        # A title expressed in pieces cannot become an exact kilogram offer.
        if re.search(r'\b(pcs|piece|pieces|unites)\b', canonical(title)):
            return None
        weights = re.findall(r'\b\d+(?:[.,]\d+)?(?:\s*/\s*\d+)?\s*(?:kg|gr|g)\b', title, re.I)
        return factor if factor and all(weight(w) == factor for w in weights) else None
    if unit == 'botte' and canonical(sale_unit) == 'botte':
        return Decimal(1)
    if unit in ('un', 'u', 'unite', 'piece') and canonical(sale_unit) in ('piece', '1 piece'):
        return Decimal(1)
    return None


def card_price(article, card):
    factor = produce_factor(article, card['title'], card['unit'])
    if not factor or not card.get('available'):
        return None
    if canonical(card.get('currency', '')) != 'mad':
        return None
    try:
        price = amount(card['price'])
        return price / factor if price > 0 else None
    except (ValueError, ArithmeticError):
        return None


EXTRACT = """els=>els.map(e=>{
    const title=e.querySelector('.woocommerce-loop-product__title,h1.product_title');
    const link=e.querySelector('a.woocommerce-LoopProduct-link');
    const prices=e.querySelector('.price');
    const current=prices && (prices.querySelector('ins .woocommerce-Price-amount') ||
        (!prices.querySelector('del') && prices.querySelector('.woocommerce-Price-amount')));
    const amounts=current ? [...current.querySelectorAll('bdi')] : [];
    const unit=e.querySelector('.unit-of-sale,.product-unit,.woocommerce-product-details__short-description');
    const text=amounts.length===1?amounts[0].textContent:'';
    const currency=current && current.querySelector('.woocommerce-Price-currencySymbol');
    const saleUnit=unit?unit.textContent.trim():'';
    return {title:title?title.textContent.trim():'',url:link?link.href:location.href,
        unit:saleUnit,price:text.replace(/MAD/g,'').trim(),currency:currency?currency.textContent.trim():'',
        available:e.classList.contains('instock') && !!e.querySelector('.add_to_cart_button,button.single_add_to_cart_button')};
})"""


class ProduceCatalogue(MerchantPage):
    def __init__(self, browser):
        super().__init__(browser, 'Le Maître des Légumes', 'https://lemaitredeslegumes.ma')
        self.cards = None

    def quote(self, articles):
        if not any(canonical(a['designation']) in NAMES for a in articles):
            return []
        if self.cards is None:
            self.cards = []
            url = self.origin + '/boutique/'
            try:
                self.open(url)
                # Unit markup differs across WooCommerce themes. Use the exact
                # standalone unit displayed between the product title and price.
                self.cards = self.page.locator('li.product').evaluate_all(EXTRACT.replace(
                    "const saleUnit=unit?unit.textContent.trim():'';",
                    "const saleUnit=unit?unit.textContent.trim():[...e.querySelectorAll('p,span,div')].map(n=>n.textContent.trim()).find(t=>/^(?:[0-9]+(?:[.,][0-9]+)?(?:\\s*\\/\\s*[0-9]+)?\\s*(?:kg|gr|g)|botte|pièce)$/i.test(t))||'';"))
                self.events.append({'supplier': self.name, 'cards_read': len(self.cards)})
                print('Catalogue fruits et légumes :', len(self.cards), 'fiches lues', flush=True)
            except Exception as exc:
                self.failure(url, exc)
        result = []
        for article in articles:
            seen = set()
            for card in self.cards:
                price = card_price(article, card)
                if price is not None and card['url'] not in seen:
                    seen.add(card['url'])
                    result.append(public_line(article, price, card['url'], self.name,
                        'catalogue marchand actuel, prix de vente et unité explicites ; quantité demandée non confirmée'))
        print('Catalogue fruits et légumes :', len({r['article']['designation'] for r in result}), 'articles avec prix public', flush=True)
        return result
