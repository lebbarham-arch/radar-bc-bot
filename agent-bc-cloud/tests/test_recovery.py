import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from agent import finish_pricing, error_details
from workflow import Workflow


class RecoveryTests(unittest.TestCase):
    def exercise(self, save_error=None, mail_error=None):
        bc = {'id': 'any-bc', 'deadline': '01/01/2099 16:00', 'text': '', 'extraction_errors': []}
        quote = {'complete': True, 'needs_confirmation': False,
                 'lines': [{'status': 'chiffré', 'unit_sale_ht': '11.00'}]}
        with tempfile.TemporaryDirectory() as folder:
            workflow = Workflow(Path(folder) / 'workflow.sqlite')
            with patch.dict('os.environ', {'BC_ALLOW_DRAFT_WRITES': '1'}), \
                 patch('agent.filling_policy', return_value='partiel à H-24'), \
                 patch('agent.publish_supplier_need', side_effect=mail_error, return_value='envoyé') as mail, \
                 patch('agent.save_draft', side_effect=save_error, return_value='brouillon enregistré et prix revérifiés') as save:
                quote['needs_confirmation'] = True
                status = finish_pricing(None, bc, quote, {}, None, workflow)
                row = workflow.db.execute('SELECT phase,quote FROM bc_workflow').fetchone()
                return status, quote, row, mail.call_count, save.call_count

    def test_portal_failure_keeps_prices_and_dispatches_followup(self):
        status, quote, row, mailed, saved = self.exercise(RuntimeError('Formulaire modifié'))
        self.assertIn('saisie bloquée', status)
        self.assertEqual(mailed, 1)
        self.assertEqual(saved, 1)
        self.assertIn('11.00', row[1])
        self.assertEqual(quote['draft_error']['stage'], 'enregistrement du brouillon')

    def test_mail_failure_does_not_block_available_prices(self):
        status, quote, row, mailed, saved = self.exercise(mail_error=RuntimeError('IMAP indisponible'))
        self.assertEqual(status, 'brouillon enregistré et prix revérifiés')
        self.assertEqual(saved, 1)
        self.assertIn('followup_error', quote)

    def test_provider_error_does_not_log_secrets(self):
        try:
            raise Exception('password=SENSITIVE_VALUE_123 https://private.example')
        except Exception as exc:
            detail = error_details(exc, 'test')
        self.assertNotIn('SENSITIVE_VALUE_123', str(detail))


if __name__ == '__main__':
    unittest.main()
