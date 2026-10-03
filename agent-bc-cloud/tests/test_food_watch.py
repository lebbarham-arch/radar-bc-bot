import tempfile
import unittest
from pathlib import Path
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from food_watch import FoodStore, normalized_unit

ARTICLE={'designation':'POIVRON VERT','specification':'','unit':'kg','quantity':'10','vat':'0'}

class WatchTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.store=FoodStore(Path(self.temp.name)/'food.sqlite')
        self.now=datetime.now(timezone.utc)
        self.card={'title':'Poivron vert 500g','unit':'500g','price':'5.50','price_basis':'TTC','currency':'MAD','url':'https://example.ma/poivron/','available':True}

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def record(self, hours=0, **changes):
        return self.store.record('Aswak','Rabat',{**self.card,**changes},(self.now-timedelta(hours=hours)).isoformat())

    def test_latest_rise_wins_and_history_remains(self):
        self.record(hours=2,price='3')
        self.record(price='5.50')
        offers=self.store.candidates(ARTICLE,now=self.now)
        self.assertEqual(len(offers),1)
        self.assertEqual(Decimal(offers[0]['purchase_unit_ttc']),Decimal('11'))
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM food_observations').fetchone()[0],2)

    def test_latest_stockout_invalidates_old_price(self):
        self.record(hours=2)
        self.record(available=False)
        self.assertEqual(self.store.candidates(ARTICLE,now=self.now),[])

    def test_stale_other_city_quality_and_wrong_variant_rejected(self):
        self.record(hours=25)
        self.assertEqual(self.store.candidates(ARTICLE,now=self.now),[])
        self.record()
        self.assertEqual(self.store.candidates(ARTICLE,cities=('Casablanca',),now=self.now),[])
        self.assertEqual(self.store.candidates({**ARTICLE,'specification':'premier choix'},now=self.now),[])
        self.assertEqual(self.store.candidates({**ARTICLE,'designation':'POIVRON ROUGE'},now=self.now),[])

    def test_no_fabricated_unit_or_currency(self):
        self.assertIsNone(normalized_unit('Ananas la pièce 1kg à 1,2kg'))
        self.assertIsNone(normalized_unit('Lot 3 bouteilles 1L'))
        self.assertEqual(normalized_unit('Farine 500g'),('kg',Decimal('.5')))
        self.assertEqual(normalized_unit('Menthe botte'),('botte',Decimal('1')))
        self.assertFalse(self.record(currency='EUR'))

    def test_queue_dedup_and_conflicting_current_observation(self):
        self.store.queue('Aswak','Rabat',self.card['url'])
        self.store.queue('Aswak','Rabat',self.card['url'])
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM food_queue').fetchone()[0],1)
        self.record()
        self.record(available=False)
        self.assertEqual(self.store.candidates(ARTICLE,now=self.now),[])

    def test_unspecified_tax_stays_observation_not_purchase_ttc(self):
        self.record(price_basis='non précisé')
        self.assertEqual(self.store.candidates(ARTICLE,now=self.now),[])
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM food_observations').fetchone()[0],1)
