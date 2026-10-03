import json
import unittest
from catalogue_readers import structured_products,allowed_asset

class CatalogueTests(unittest.TestCase):
    def product(self,**offer):
        return json.dumps({'@type':'Product','name':'Lait entier 1L','url':'https://www.marjane.ma/product/lait',
            'offers':{'@type':'Offer','price':'7.95','priceCurrency':'MAD',
                'availability':'https://schema.org/InStock',**offer}})

    def test_single_precise_product_offer(self):
        rows=structured_products([self.product()],'www.marjane.ma')
        self.assertEqual(rows[0]['price'],'7.95')
        self.assertTrue(rows[0]['available'])
        self.assertEqual(rows[0]['price_basis'],'non précisé')

    def test_aggregate_wrong_currency_and_external_url_rejected(self):
        for override in [{'@type':'AggregateOffer'},{'priceCurrency':'EUR'},
                         {'url':'https://unknown.example/product/lait'}]:
            self.assertEqual(structured_products([self.product(**override)],'www.marjane.ma'),[])

    def test_out_of_stock_and_expiry_preserved(self):
        row=structured_products([self.product(availability='https://schema.org/OutOfStock',priceValidUntil='2020-01-01')],'www.marjane.ma')[0]
        self.assertFalse(row['available'])
        self.assertEqual(row['valid_until'],'2020-01-01')

    def test_asset_hosts_and_credentials(self):
        self.assertTrue(allowed_asset('https://assets.carrefour.ma/catalogues/one.pdf','carrefour.ma'))
        for url in ['https://unknown.example/a.pdf','http://www.bim.ma/a.jpg',
                    'https://secret@www.bim.ma/a.jpg','https://127.0.0.1/a.jpg']:
            self.assertFalse(allowed_asset(url,'www.bim.ma'))
