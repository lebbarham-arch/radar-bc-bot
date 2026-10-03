import json
import tempfile
import unittest
from datetime import datetime, timedelta, date
from pathlib import Path
from workflow import filling_policy, Workflow, MAROC, prioritize_urls
from portal_form import validate_quote, fill_prices
from mail_bridge import signed_payload, validate_payload
from web_sources import destination
from unittest.mock import patch


ROW = {'cells': ['01', 'BANANE\nCaractéristiques et spécifications :\nBANANE',
                'kg', '420', '', '0', '0,00 MAD', '0,00 MAD'], 'inputs': 1}
A = {'designation': 'BANANE', 'specification': 'BANANE', 'unit': 'kg', 'quantity': '420', 'vat': '0'}
B = {**A, 'designation': 'MENTHE', 'specification': 'MENTHE', 'unit': 'botte'}
BC = {'id': '123', 'deadline': '05/10/2026 10:00', 'articles': [A, B], 'extraction_errors': []}
QUOTE = {'complete': False, 'lines': [{'article': A, 'status': 'chiffré', 'unit_sale_ht': '21.95'},
                                     {'article': B, 'status': 'prix à confirmer'}]}


class WorkflowTests(unittest.TestCase):
    def test_nearest_open_deadline_before_lexical_id_and_unknown(self):
        known = [{'url': 'z', 'deadline': '05/10/2026 10:00'},
                 {'url': 'b', 'deadline': '03/10/2026 16:00'},
                 {'url': 'a', 'deadline': '02/10/2026 16:00'}]
        self.assertEqual(prioritize_urls(['a', 'b', 'z', 'c', 'b'], known,
            datetime(2026, 10, 3, 2, tzinfo=MAROC)), ['b', 'z', 'a', 'c'])

    def test_h24_boundary_and_expiration(self):
        deadline = datetime(2026, 10, 5, 10, tzinfo=MAROC)
        self.assertEqual(filling_policy(BC, QUOTE, deadline-timedelta(hours=24, seconds=1)), 'attente des devis')
        self.assertEqual(filling_policy(BC, QUOTE, deadline-timedelta(hours=24)), 'partiel à H-24')
        self.assertEqual(filling_policy(BC, QUOTE, deadline), 'expiré')
        self.assertEqual(filling_policy(BC, {**QUOTE, 'complete': True}, deadline-timedelta(days=3)), 'complet')

    def test_missing_deadline_or_extraction_blocks(self):
        now = datetime(2026, 10, 4, 12, tzinfo=MAROC)
        self.assertEqual(filling_policy({**BC, 'deadline': ''}, QUOTE, now), 'échéance non confirmée')
        self.assertEqual(filling_policy({**BC, 'extraction_errors': ['erreur']}, QUOTE, now), 'extraction à confirmer')
        self.assertEqual(filling_policy(BC, {'lines': []}, now), 'aucun prix disponible')

    def test_persistent_state_and_history(self):
        with tempfile.TemporaryDirectory() as d:
            state = Workflow(Path(d)/'state.sqlite')
            state.record(BC, QUOTE, 'attente des devis')
            state.record(BC, QUOTE, 'attente des devis')
            state.record(BC, QUOTE, 'partiel à H-24')
            self.assertEqual(state.db.execute('SELECT COUNT(*) FROM workflow_events').fetchone()[0], 2)
            self.assertEqual(Workflow(Path(d)/'state.sqlite').pending()[0]['id'], BC['id'])

    def test_partial_requires_explicit_policy_and_matching_all_rows(self):
        second = {'cells': ROW['cells'].copy(), 'inputs': 1}
        second['cells'][0], second['cells'][1], second['cells'][2] = '02', 'MENTHE\nCaractéristiques et spécifications :\nMENTHE', 'botte'
        with self.assertRaises(RuntimeError):
            validate_quote([ROW, second], QUOTE)
        validate_quote([ROW, second], {**QUOTE, 'allow_partial': True})
        second['cells'][3] = '421'
        with self.assertRaises(RuntimeError):
            validate_quote([ROW, second], {**QUOTE, 'allow_partial': True})

    def test_partial_does_not_fill_missing_price_and_preserves_foreign_price(self):
        class Field:
            def __init__(self, value=''): self.value, self.writes = value, []
            def count(self): return 1
            def is_visible(self): return True
            def is_enabled(self): return True
            def input_value(self): return self.value
            def fill(self, value): self.value = value; self.writes.append(value)
            def press(self, key): pass
        fields = [Field(), Field()]
        class Row:
            def __init__(self, field): self.field = field
            def locator(self, selector): return self.field
        class Rows:
            def filter(self, **kwargs): return self
            def count(self): return len(fields)
            def nth(self, index): return Row(fields[index])
        class Page:
            def locator(self, selector): return Rows()
        with patch('portal_form.collect_rows', return_value=[]), patch('portal_form.validate_quote'):
            self.assertEqual(fill_prices(Page(), {**QUOTE, 'allow_partial': True}), 1)
            self.assertEqual(fields[1].writes, [])
            fields[0].value = '30'
            with self.assertRaises(RuntimeError):
                fill_prices(Page(), {**QUOTE, 'allow_partial': True})
            self.assertEqual(fields[1].writes, [])
            second_quote = {**QUOTE, 'allow_partial': True, 'lines': [QUOTE['lines'][0],
                {'article': B, 'status': 'chiffré', 'unit_sale_ht': '12.00'}]}
            self.assertEqual(fill_prices(Page(), second_quote, preserve_existing=True), 1)
            self.assertEqual(fields[0].value, '30')
            self.assertEqual(fields[1].value, '12.00')
            self.assertEqual(second_quote['protected_prices'], {'0': '30'})
            self.assertEqual(fields[0].writes, ['21.95'])

    def test_bridge_signature_spec_quantity_and_validity(self):
        row = {**A, 'purchase_ttc': '19.95', 'supplier': 'vendeur', 'source_mail_id': 'mail-1',
               'observed_on': '2026-10-02', 'valid_until': '2026-10-06', 'min_qty': '1', 'max_qty': '500',
               'confirmed': 'oui', 'in_stock': 'oui', 'currency': 'MAD', 'price_basis': 'TTC'}
        payload = {'bc_id': BC['id'], 'observations': [row]}
        payload['signature'] = signed_payload(payload, 'secret-de-test')
        self.assertEqual(len(validate_payload(payload, 'secret-de-test', BC, date(2026,10,2))), 1)
        tampered = json.loads(json.dumps(payload))
        tampered['observations'][0]['purchase_ttc'] = '1'
        with self.assertRaises(ValueError): validate_payload(tampered, 'secret-de-test', BC)
        for change in [{'specification': 'AUTRE'}, {'price_basis': 'HT'}, {'currency': 'EUR'}]:
            data = {'bc_id': BC['id'], 'observations': [{**row, **change}]}
            data['signature'] = signed_payload(data, 'secret-de-test')
            with self.assertRaises(ValueError): validate_payload(data, 'secret-de-test', BC, date(2026,10,2))
        self.assertEqual(validate_payload(payload, 'secret-de-test', BC, date(2026,10,7)), [])

    def test_open_web_excludes_private_and_authenticated_urls(self):
        self.assertEqual(destination('https://vendeur.ma/article'), 'https://vendeur.ma/article')
        for url in ['http://vendeur.ma', 'https://127.0.0.1/', 'https://user:password@vendeur.ma',
                    'https://www.marchespublics.gov.ma/', 'https://host.local/']:
            self.assertIsNone(destination(url))
