"""Association des prix aux lignes réelles du devis, avant toute mutation."""
from decimal import Decimal
from parsing import norm
from pricing import amount


def compact(text):
    return ' '.join(norm(text).split())


def parse_rows(rows):
    articles = []
    for row in rows:
        cells = row['cells']
        if len(cells) != 8 or row['inputs'] != 1 or not cells[0].strip().isdigit():
            raise RuntimeError('Tableau devis non reconnu')
        if int(cells[0]) != len(articles) + 1:
            raise RuntimeError('Ordre des articles non reconnu')
        parts = cells[1].split('Caractéristiques et spécifications', 1)
        if len(parts) != 2:
            raise RuntimeError('Spécifications absentes du tableau')
        designation, spec = parts[0].strip(), parts[1].lstrip(' :\n\r\t').strip()
        qty, vat = amount(cells[3]), amount(cells[5].rstrip(' %'))
        if not designation or not spec or not cells[2].strip() or qty <= 0 or vat > 100:
            raise RuntimeError('Données de ligne invalides')
        articles.append({'designation': designation, 'specification': spec, 'unit': cells[2].strip(),
                         'quantity': str(qty), 'vat': str(vat)})
    return articles


def collect_rows(page):
    return page.locator('tr').evaluate_all('''els=>els
        .filter(e=>e.getClientRects().length && e.querySelector('input[type="number"]'))
        .map(e=>({cells:[...e.cells].map(c=>c.innerText.trim()),
             inputs:e.querySelectorAll('input[type="number"]').length}))''')


def validate_quote(rows, quote):
    if not quote.get('complete') and not quote.get('allow_partial'):
        raise RuntimeError('Chiffrage incomplet : aucun prix saisi')
    articles = parse_rows(rows)
    if len(articles) != len(quote['lines']):
        raise RuntimeError('Nombre de lignes différent du chiffrage')
    for actual, line in zip(articles, quote['lines']):
        expected = line['article']
        for key in ('designation', 'specification', 'unit'):
            if compact(actual[key]) != compact(expected[key]):
                raise RuntimeError('Produit ou unité différente : saisie bloquée')
        for key in ('quantity', 'vat'):
            if amount(actual[key]) != amount(expected[key]):
                raise RuntimeError('Quantité ou TVA différente : saisie bloquée')
        if line.get('status') != 'chiffré':
            if not quote.get('allow_partial') or 'unit_sale_ht' in line:
                raise RuntimeError('Ligne non chiffrée incohérente')
            continue
        if amount(line['unit_sale_ht']) <= 0:
            raise RuntimeError('Prix non positif : saisie bloquée')
    if not any(line.get('status') == 'chiffré' for line in quote['lines']):
        raise RuntimeError('Aucun prix disponible')
    return articles


def fill_prices(page, quote, previous=None):
    validate_quote(collect_rows(page), quote)
    rows = page.locator('tr:visible').filter(has=page.locator('input[type="number"]'))
    if rows.count() != len(quote['lines']):
        raise RuntimeError('Tableau ambigu : aucun prix saisi')
    # Contrôle de tous les champs avant de remplir le premier.
    fields = []
    for index in range(rows.count()):
        field = rows.nth(index).locator('input[type="number"]')
        if field.count() != 1 or not field.is_visible() or not field.is_enabled():
            raise RuntimeError('Champ de prix non modifiable')
        existing = field.input_value().strip()
        prior = previous['lines'][index] if previous else None
        expected = amount(prior['unit_sale_ht']) if prior and prior.get('status') == 'chiffré' else Decimal(0)
        actual = amount(existing) if existing else Decimal(0)
        if actual != expected:
            raise RuntimeError('Prix existant différent du dernier brouillon vérifié : conservé')
        if prior and prior.get('status') == 'chiffré' and quote['lines'][index].get('status') != 'chiffré':
            raise RuntimeError('Prix antérieur indisponible : conservé, actualisation bloquée')
        fields.append(field)
    for field, line in zip(fields, quote['lines']):
        if line.get('status') != 'chiffré':
            # Ne saisit ni zéro ni un prix fictif dans les lignes manquantes.
            continue
        field.fill(line['unit_sale_ht'])
        field.press('Tab')
        if amount(field.input_value()) != amount(line['unit_sale_ht']):
            raise RuntimeError('Prix saisi différent : vérification nécessaire')
    return sum(line.get('status') == 'chiffré' for line in quote['lines'])
