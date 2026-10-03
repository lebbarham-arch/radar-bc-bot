import unittest
from pathlib import Path
from unittest.mock import patch
import json
from user_quotes import user_quote

ROOT = Path(__file__).resolve().parents[1]
class UserQuoteTests(unittest.TestCase):
    def article(self, name='BANANE', unit='kg'):
        return {'designation':name,'specification':name,'unit':unit,'quantity':'420','vat':'0'}
    def test_user_offer_is_exact_without_markup(self):
        settings={'test-bc':{'source':'test fixture','basis':'user offer','lines':[dict(self.article(),unit_sale_ht='12.3456',source_designation='BANANE')]}}
        with patch.dict('os.environ', {'BC_USER_QUOTE_OVERRIDES':json.dumps(settings)}):
            q=user_quote(ROOT, {'id':'test-bc','articles':[self.article()]})
        self.assertEqual(q['lines'][0]['unit_sale_ht'],'12.3456')
        self.assertTrue(q['lines'][0]['user_authorized_price'])
        self.assertNotIn('purchase_ttc',q['lines'][0])
    def test_unmatched_unit_and_product_left_blank(self):
        settings={'test-bc':{'source':'test fixture','basis':'user offer','lines':[dict(self.article(),unit_sale_ht='12.3456',source_designation='BANANE')]}}
        with patch.dict('os.environ', {'BC_USER_QUOTE_OVERRIDES':json.dumps(settings)}):
            q=user_quote(ROOT, {'id':'test-bc','articles':[self.article('PERSIL','botte'),self.article('OIGNONS VERTS')]})
        self.assertFalse(q['complete'])
        self.assertTrue(all('unit_sale_ht' not in l for l in q['lines']))
    def test_other_bcs_unaffected_and_wrong_vat_rejected(self):
        self.assertIsNone(user_quote(ROOT, {'id':'other','articles':[self.article()]}))
        a=self.article();a['vat']='20'
        settings={'test-bc':{'source':'test fixture','basis':'user offer','lines':[dict(self.article(),unit_sale_ht='12.3456',source_designation='BANANE')]}}
        with patch.dict('os.environ', {'BC_USER_QUOTE_OVERRIDES':json.dumps(settings)}):
            self.assertEqual(user_quote(ROOT, {'id':'test-bc','articles':[a]})['lines'][0]['status'],'prix à confirmer')
