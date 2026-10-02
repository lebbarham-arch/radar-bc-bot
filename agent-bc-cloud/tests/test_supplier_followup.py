import tempfile
import unittest
from datetime import datetime, timedelta, date
from pathlib import Path
from supplier_followup import verified_contacts, SupplierFollowup, line_ref, parse_offer
from pricing import Prices
from selftest import run
from workflow import MAROC

A={'designation':'LAMP TEST','specification':'230V EXACT','quantity':'10','unit':'U','vat':'20'}
BC={'id':'TEST','deadline':(datetime.now(MAROC)+timedelta(days=3)).strftime('%d/%m/%Y %H:%M'),'articles':[A],'extraction_errors':[]}
REQUEST={'bc':BC,'indices':[0],'supplier':'test.ma','token':'simulation'}

def valid(**changes):
    fields={'REF':line_ref(0,A),'PU_TTC':'95','DEVISE':'MAD','UNITE':'U','QTE_DEMANDEE':'10','QTE_DISPO':'10',
        'STOCK':'OUI','CONFORME':'OUI','VALIDE_JUSQU_A':(date.today()+timedelta(days=2)).isoformat(),'DELAI_JOURS':'3'}
    fields.update(changes)
    return '; '.join(k+'='+str(v) for k,v in fields.items())

class SupplierTests(unittest.TestCase):
    def test_full_pdf_mail_chain(self):
        self.assertEqual(run(False)['prix_retenu_TTC'],'95.00')
    def test_technical_noncompliance(self):
        rows,issues=parse_offer(valid(CONFORME='NON'),REQUEST,'mail');self.assertFalse(rows);self.assertTrue(issues)
    def test_wrong_quantity_unit_currency_stock(self):
        for changes in ({'QTE_DEMANDEE':'9'},{'QTE_DISPO':'1'},{'UNITE':'kg'},{'DEVISE':'EUR'},{'STOCK':'NON'}):
            rows,issues=parse_offer(valid(**changes),REQUEST,'mail');self.assertFalse(rows);self.assertTrue(issues)
    def test_expired_and_ambiguous(self):
        self.assertFalse(parse_offer(valid(VALIDE_JUSQU_A=(date.today()-timedelta(days=1)).isoformat()),REQUEST,'mail')[0])
        with self.assertRaises(ValueError):parse_offer(valid()+'; PU_TTC=1',REQUEST,'mail')
    def test_unstructured_requires_clarification(self):
        rows,issues=parse_offer('Devis total 999 DH',REQUEST,'mail');self.assertFalse(rows);self.assertTrue(issues)
    def test_address_must_match_evidenced_supplier(self):
        event={'article':A['designation'],'leads':[{'url':'https://test.ma/product','morocco':True,'commercial_context':True,'published_emails':['commercial@other.ma']}]}
        self.assertEqual(verified_contacts([event],A),[])
        event['leads'][0]['published_emails']=['commercial@test.ma']
        self.assertEqual(verified_contacts([event],A)[0]['email'],'commercial@test.ma')
    def test_three_suppliers_minimum(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);sent=[];s=SupplierFollowup(root,'simulation@example.invalid',sent.append);p=Prices(root/'prices.sqlite')
            event={'article':A['designation'],'leads':[{'url':'https://test.ma/product','morocco':True,'commercial_context':True,'published_emails':['commercial@test.ma']}]}
            self.assertEqual(s.consult(BC,p.quote([A]),[event])['sent'],0);self.assertEqual(sent,[])
    def test_uncertain_send_never_repeated(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);calls=[]
            def fail(message):calls.append(message);raise TimeoutError()
            s=SupplierFollowup(root,'simulation@example.invalid',fail);p=Prices(root/'prices.sqlite')
            event={'article':A['designation'],'leads':[{'url':'https://test%d.ma/product'%i,'morocco':True,'commercial_context':True,'published_emails':['commercial@test%d.ma'%i]} for i in range(3)]}
            s.consult(BC,p.quote([A]),[event]);s.consult(BC,p.quote([A]),[event]);s.remind(datetime.now(MAROC)+timedelta(hours=25))
            self.assertEqual(len(calls),3)

if __name__=='__main__':unittest.main()
