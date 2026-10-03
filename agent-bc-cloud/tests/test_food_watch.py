import tempfile
import unittest
from pathlib import Path
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from food_watch import FoodStore, normalized_unit, validate_feed
from mail_bridge import signed_payload

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

    def test_queue_strips_fragments_and_rotates_suppliers(self):
        for i in range(100):self.store.queue('Aswak','Rabat',f'https://example.ma/page/{i}')
        self.store.queue('BIM','non précisée','https://www.bim.ma/')
        self.store.queue('BIM','non précisée','https://www.bim.ma/#')
        due=self.store.due(now=self.now,limit=6,per_supplier=3)
        self.assertIn('BIM',{r['supplier'] for r in due})
        self.assertLessEqual(sum(r['supplier']=='Aswak' for r in due),3)
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM food_queue WHERE supplier='BIM'").fetchone()[0],1)

    def test_failure_backoff_and_success_daily(self):
        self.store.queue('Aswak','Rabat',self.card['url'])
        self.store.finish_page(self.card['url'],'accès ou extraction bloqué',self.now)
        self.assertEqual(self.store.due(now=self.now+timedelta(minutes=59)),[])
        self.assertEqual(len(self.store.due(now=self.now+timedelta(hours=1))),1)
        self.store.finish_page(self.card['url'],'prix relevés',self.now)
        self.assertEqual(self.store.due(now=self.now+timedelta(hours=23)),[])
        self.assertEqual(len(self.store.due(now=self.now+timedelta(hours=24))),1)

    def test_coverage_counts_products_not_repeated_observations(self):
        self.store.queue('Aswak','Rabat',self.card['url'])
        self.record(hours=1)
        self.record()
        result=self.store.coverage(self.now)[0]
        self.assertEqual(result['distinct_products_24h'],1)

    def test_expired_conditional_or_review_prices_never_feed_offer(self):
        for changes in [{'valid_until':'2020-01-01'},{'conditional':True},{'review_required':True}]:
            self.store.db.execute('DELETE FROM food_observations')
            self.record(**changes)
            self.assertEqual(self.store.candidates(ARTICLE,now=self.now),[])

    def test_unspecified_tax_stays_observation_not_purchase_ttc(self):
        self.record(price_basis='non précisé')
        self.assertEqual(self.store.candidates(ARTICLE,now=self.now),[])
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM food_observations').fetchone()[0],1)

    def test_catalogue_limit_and_explicit_known_import_alias(self):
        self.record(max_qty_displayed='2')
        self.assertEqual(self.store.candidates(ARTICLE,now=self.now),[])
        self.record(hours=0,title='BANANE IMPORT 1KG',unit='',price='16.95',url='https://example.ma/banane/')
        rows=self.store.candidates({**ARTICLE,'designation':'BANANE'},now=self.now)
        self.assertEqual(len(rows),1)
        self.assertEqual(Decimal(rows[0]['purchase_unit_ttc']),Decimal('16.95'))

    def test_signed_feed_rejects_tampering_future_dates_and_unknown_tax_is_retained(self):
        payload={'schema':'food-watch-v1','observations':[{**self.card,'supplier':'Aswak','city':'Rabat',
            'observed_at':self.now.isoformat(),'evidence':'prix et titre dans le catalogue','price_basis':'non précisé'}]}
        payload['signature']=signed_payload(payload,'test-only')
        rows=validate_feed(payload,'test-only',now=self.now)
        self.assertEqual(rows[0]['price_basis'],'non précisé')
        payload['observations'][0]['price']='1'
        with self.assertRaises(ValueError):validate_feed(payload,'test-only',now=self.now)
        payload['observations'][0]['observed_at']=(self.now+timedelta(hours=1)).isoformat()
        payload['signature']=signed_payload(payload,'test-only')
        with self.assertRaises(ValueError):validate_feed(payload,'test-only',now=self.now)
