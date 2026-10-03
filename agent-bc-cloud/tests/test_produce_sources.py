import unittest
from decimal import Decimal
from produce_sources import card_price, produce_factor, weight
from sourcing import structured_price


def article(name='POIVRON VERT', unit='kg', spec=''):
    return {'designation': name, 'unit': unit, 'specification': spec}


class ProduceTests(unittest.TestCase):
    def test_open_web_reads_matching_weight_and_preserves_tax_controls(self):
        p = {'name': 'Poivron vert 500g', 'offers': {'@type': 'Offer', 'price': '5.50',
             'priceCurrency': 'MAD', 'availability': 'https://schema.org/InStock'}}
        self.assertEqual(structured_price(article(), p, '5.50 MAD TTC'), Decimal('11'))
        self.assertIsNone(structured_price(article(), p, '5.50 MAD HT'))
        self.assertIsNone(structured_price(article(), {**p, 'name': 'Poivron rouge 500g'}, 'TTC'))
        self.assertEqual(produce_factor(article('LAITUE (salade vert)', 'un'), 'Salade Beldia', 'Pièce'), Decimal(1))
        self.assertEqual(produce_factor(article('OIGNONS SECS'), 'Oignon rouge 1/2kg', '1/2kg'), Decimal('0.5'))
        self.assertIsNone(produce_factor(article('OIGNONS SECS'), 'Oignon vert 1/2kg', '1/2kg'))

    def test_fraction_and_grams(self):
        for unit, expected in [('1/2kg', '0.5'), ('1/4kg', '0.25'), ('250gr', '0.25'), ('1,5 kg', '1.5')]:
            self.assertEqual(weight(unit), Decimal(expected))
        for unit in ('2-3kg', '2 – 3kg', 'pièce', '0kg', '1/0kg'):
            self.assertIsNone(weight(unit))

    def test_price_currency_and_stock(self):
        card = {'title': 'Poivron vert 1/2kg فلفل أخضر', 'unit': '1/2kg',
                'price': '5,50', 'currency': 'MAD', 'available': True}
        self.assertEqual(card_price(article(), card), Decimal('11'))
        for change in ({'available': False}, {'currency': 'EUR'}, {'unit': '1 pièce'}, {'unit': '250g'}, {'price': '0'}):
            self.assertIsNone(card_price(article(), {**card, **change}))

    def test_strict_qualities_species_and_units(self):
        for a, title, unit in [(article('ORANGES NAVELLES'), 'Orange à jus 1kg', '1kg'),
                (article('POMME DE TERRE LAVEE 1ER CHOIX'), 'Pomme de terre 1kg', '1kg'),
                (article('POTIRON ROUGE'), 'Potiron 1/2kg', '1/2kg'),
                (article('CHOUX BLANC'), 'Chou blanc pièce jeune', '1/2kg'),
                (article(), 'Poivron rouge 1/2kg', '1/2kg'),
                (article(spec='origine Maroc uniquement'), 'Poivron vert 1/2kg', '1/2kg')]:
            self.assertIsNone(produce_factor(a, title, unit))
        self.assertEqual(produce_factor(article('PERSIL', 'botte', 'PERSIL'), 'Persil botte معدنوس', 'Botte'), Decimal(1))
        self.assertEqual(produce_factor(article('MANDARINE'), 'Première mandarine 1kg أول الماندرين', '1kg'), Decimal(1))
