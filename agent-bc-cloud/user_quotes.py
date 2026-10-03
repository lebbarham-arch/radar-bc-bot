"""BC-scoped user offer rates; never mix these with purchase observations."""
import json
import os
from decimal import Decimal
from portal_form import compact
from pricing import amount, money


def user_quote(root, bc):
    config = json.loads(os.environ.get('BC_USER_QUOTE_OVERRIDES', '{}'))
    override = config.get(bc['id'])
    if override is None:
        return None
    lines = []
    for article in bc['articles']:
        matches = [r for r in override['lines'] if all(compact(r[k]) == compact(article[k]) for k in ('designation', 'specification', 'unit')) and amount(r['vat']) == amount(article['vat'])]
        if len(matches) != 1:
            lines.append({'article': article, 'status': 'prix à confirmer'})
            continue
        row = matches[0]
        pu = amount(row['unit_sale_ht'])
        if pu <= 0:
            raise ValueError('Prix utilisateur invalide')
        ht = money(pu * amount(article['quantity']))
        vat = money(ht * amount(article['vat']) / Decimal(100))
        lines.append({'article':article, 'status':'chiffré', 'user_authorized_price':True,
                      'unit_sale_ht':str(pu), 'sale_ht':str(ht), 'sale_vat':str(vat), 'sale_ttc':str(ht+vat),
                      'source':{'source':override['source'], 'basis':override['basis'], 'source_designation':row['source_designation']}})
    result = {'complete': bool(lines) and all(l['status']=='chiffré' for l in lines), 'lines':lines, 'transport_included':False, 'user_override':True}
    if result['complete']:
        for k in ('sale_ht','sale_vat','sale_ttc'):
            result[k] = str(sum((amount(l[k]) for l in lines),Decimal(0)))
    return result
