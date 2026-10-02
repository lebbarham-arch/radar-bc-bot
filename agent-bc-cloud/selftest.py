"""Chaîne simulée complète, isolée : demandes, mails/PDF, comparaison, formulaire.
Ne contacte aucun fournisseur, aucun compte Gmail, ni le portail réel.
"""
import io
import json
import tempfile
from datetime import datetime, timedelta, date
from pathlib import Path
from email.message import EmailMessage
from reportlab.pdfgen import canvas
from pricing import Prices
from portal_form import fill_prices
from supplier_followup import SupplierFollowup, line_ref
from workflow import filling_policy, MAROC


def run(with_browser=True):
    now=datetime.now(MAROC)
    articles=[{'designation':'ARTICLE A TEST','specification':'REFERENCE EXACTE A', 'unit':'U','quantity':'10','vat':'20'},
              {'designation':'ARTICLE B TEST','specification':'REFERENCE EXACTE B', 'unit':'U','quantity':'2','vat':'20'}]
    bc={'id':'SIMULATION-INTERNE','deadline':(now+timedelta(days=3)).strftime('%d/%m/%Y %H:%M'),'articles':articles,'extraction_errors':[]}
    events=[{'article':a['designation'],'leads':[{'url':'https://specialiste%d.ma/article'%i,
        'published_emails':['commercial@specialiste%d.ma'%i], 'morocco':True,'commercial_context':True} for i in range(4)]} for a in articles]
    sent=[]
    with tempfile.TemporaryDirectory(prefix='bc-chain-test-') as temp:
        root=Path(temp);prices=Prices(root/'prices.sqlite')
        followup=SupplierFollowup(root,'simulation@example.invalid',sent.append)
        assert followup.consult(bc,prices.quote(articles),events,now)['sent']==4
        assert followup.consult(bc,prices.quote(articles),events,now)['sent']==0
        assert followup.remind(now+timedelta(hours=23))==0
        assert followup.remind(now+timedelta(hours=25))==4
        requests=[json.loads(x[0]) for x in followup.db.execute('SELECT data FROM requests ORDER BY token')]
        def reply(request,price,mid,article_indices=(0,),stock='OUI',available='100',as_pdf=True):
            message=EmailMessage();message['From']=request['email'];message['To']='simulation@example.invalid'
            message['Subject']='Re: [FIMARO-BC] '+request['token'];message['Message-ID']=mid
            lines=[]
            for index in article_indices:
                a=articles[index]
                fields={'REF':line_ref(index,a),'PU_TTC':str(price if index==0 else 120),'DEVISE':'MAD','UNITE':a['unit'],
                    'QTE_DEMANDEE':a['quantity'],'QTE_DISPO':available,'STOCK':stock,'CONFORME':'OUI',
                    'VALIDE_JUSQU_A':(date.today()+timedelta(days=10)).isoformat(),'DELAI_JOURS':'3'}
                lines.extend(k+'='+v for k,v in fields.items())
            if as_pdf:
                stream=io.BytesIO();pdf=canvas.Canvas(stream);text=pdf.beginText(40,800)
                for line in lines:text.textLine(line)
                pdf.drawText(text);pdf.save()
                message.set_content('Notre devis est joint en PDF.')
                message.add_attachment(stream.getvalue(),maintype='application',subtype='pdf',filename='devis-simulation.pdf')
            else:message.set_content('\n'.join(lines))
            return message
        responses=[reply(requests[0],100,'<sim-1>'),reply(requests[1],95,'<sim-2>'),
                   reply(requests[2],70,'<sim-3>',stock='NON'),reply(requests[3],80,'<sim-4>',available='1')]
        results=followup.receive(prices,[m.as_bytes() for m in responses])
        assert results['imported_rows']==2,results
        assert followup.receive(prices,[m.as_bytes() for m in responses])['imported_rows']==0
        quote=prices.quote(articles);assert quote['lines'][0]['unit_sale_ht']=='104.50'
        assert filling_policy(bc,quote,now)=='attente des devis'
        assert filling_policy(bc,quote,now+timedelta(hours=49))=='partiel à H-24'
        partial={**quote,'allow_partial':True}
        wrong=reply(requests[0],1,'<wrong-sender>',article_indices=(0,1));wrong.replace_header('From','inconnu@example.invalid')
        assert followup.receive(prices,[wrong.as_bytes()])['imported_rows']==0
        correction=reply(requests[1],95,'<sim-complete>',article_indices=(0,1))
        assert followup.receive(prices,[correction.as_bytes()])['imported_rows']==2
        complete=prices.quote(articles)
        assert complete['complete'] and complete['lines'][1]['unit_sale_ht']=='132.00'
        assert complete['sale_ht']=='1309.00' and complete['sale_ttc']=='1570.80'
        # Redémarrage avec les mêmes fichiers : pas de redemande ni réimport.
        restarted=SupplierFollowup(root,'simulation@example.invalid',sent.append)
        assert restarted.consult(bc,complete,events,now)['sent']==0
        assert restarted.receive(prices,[correction.as_bytes()])['imported_rows']==0
        browser_result='non exécuté'
        if with_browser:
            from playwright.sync_api import sync_playwright
            html='''<!doctype html><title>Simulation BC isolée</title><table><tbody id="rows"></tbody></table><button id="save">Enregistrer simulation</button><script>
            const articles=ARTICLES;const values=JSON.parse(localStorage.getItem('saved')||'null')||articles.map(()=> '');
            articles.forEach((a,i)=>{const row=document.createElement('tr');
            [String(i+1),a.designation+'\\nCaractéristiques et spécifications :\\n'+a.specification,a.unit,a.quantity,'',a.vat,'0,00 MAD','0,00 MAD'].forEach((v,j)=>{const cell=document.createElement('td');
            if(j===4){const input=document.createElement('input');input.type='number';input.step='0.01';input.value=values[i];cell.appendChild(input);}else{cell.textContent=v;cell.style.whiteSpace='pre-line';}row.appendChild(cell);});document.getElementById('rows').appendChild(row);});
            document.getElementById('save').onclick=()=>localStorage.setItem('saved',JSON.stringify([...document.querySelectorAll('input')].map(x=>x.value)));
            </script>'''.replace('ARTICLES',json.dumps(articles))
            path=root/'form.html';path.write_text(html)
            with sync_playwright() as pw:
                browser=pw.chromium.launch(headless=True,chromium_sandbox=False)
                context=browser.new_context();page=context.new_page();page.goto(path.as_uri())
                assert fill_prices(page,partial)==1
                page.locator('#save').click();page.reload()
                assert page.locator('input').evaluate_all('els=>els.map(x=>x.value)')==['104.50','']
                assert fill_prices(page,complete,previous=partial)==2
                page.locator('#save').click()
                new=context.new_page();new.goto(path.as_uri())
                assert new.locator('input').evaluate_all('els=>els.map(x=>x.value)')==['104.50','132.00']
                new.locator('input').first.fill('999')
                try:fill_prices(new,complete,previous=complete)
                except RuntimeError:pass
                else:raise AssertionError('Prix manuel écrasé')
                browser.close();browser_result='remplissage, sauvegarde, relecture nouvelle page réussis'
        result={'simulation':'réussie','demandes_initiales':4,'relances':4,'devis_PDF_lus':5,'prix_retenu_TTC':'95.00',
            'vente_HT':'104.50','H24':'ligne inconnue vide','mise_a_jour':'132.00 HT sur ligne B',
            'doublons':'ignorés','mauvais_expediteur':'rejeté','stock_et_quantite':'contrôlés',
            'formulaire_chromium':browser_result,'envois_reels':0,'ecritures_portail_reel':0}
        print('BC_SELFTEST_OK',json.dumps(result,ensure_ascii=False),flush=True)
        return result


if __name__=='__main__':
    import sys
    run('--no-browser' not in sys.argv)
