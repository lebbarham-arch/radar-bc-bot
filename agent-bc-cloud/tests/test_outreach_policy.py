import tempfile,unittest,json
from pathlib import Path
from datetime import datetime,timedelta
from email.message import EmailMessage
from unittest.mock import patch
from supplier_followup import SupplierFollowup,verified_contacts
from workflow import MAROC

class OutreachPolicyTests(unittest.TestCase):
    def test_global_cap_and_restart(self):
        with tempfile.TemporaryDirectory() as temp:
            sent=[];s=SupplierFollowup(temp,'simulation@example.invalid',sent.append);now=datetime.now(MAROC)
            for i in range(10):
                m=EmailMessage();m['To']='sales@vendor%d.ma'%i
                s.send(m,'demande',now)
            self.assertEqual(len(sent),8)
            resumed=SupplierFollowup(temp,'simulation@example.invalid',sent.append)
            self.assertFalse(resumed.allowed('sales@new.ma','demande',now))
    def test_domain_cap_and_weekly_cooldown(self):
        with tempfile.TemporaryDirectory() as temp:
            s=SupplierFollowup(temp,'simulation@example.invalid',lambda m:None);now=datetime.now(MAROC)
            m=EmailMessage();m['To']='sales@vendor.ma';s.send(m,'demande',now)
            self.assertFalse(s.allowed('contact@vendor.ma','demande',now+timedelta(days=2)))
            self.assertTrue(s.allowed('contact@vendor.ma','demande',now+timedelta(days=8)))
            self.assertTrue(s.send(m,'précision',now))
            self.assertFalse(s.send(m,'précision',now))
    def test_failed_checkpoint_prevents_send(self):
        with tempfile.TemporaryDirectory() as temp:
            sent=[];s=SupplierFollowup(temp,'simulation@example.invalid',sent.append)
            def fail():raise OSError()
            s.checkpoint=fail;m=EmailMessage();m['To']='sales@vendor.ma'
            with self.assertRaises(OSError):s.send(m)
            self.assertFalse(sent)
    def test_specialist_gate_and_priority(self):
        article={'designation':'Lampe'}
        leads=[{'url':'https://vendor%d.ma/product'%i,'morocco':True,'commercial_context':True,
            'published_emails':['sales@vendor%d.ma'%i],'supplier_type':kind}
            for i,kind in enumerate(['non classé','spécialiste','fabricant','grand distributeur'])]
        with patch.dict('os.environ',{'BC_REQUIRE_SPECIALIST':'1'}):
            contacts=verified_contacts([{'article':'Lampe','leads':leads}],article)
        self.assertEqual([c['supplier_type'] for c in contacts],['fabricant','grand distributeur','spécialiste'])
