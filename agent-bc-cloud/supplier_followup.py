"""Consultations et réponses fournisseurs, transports injectables pour simulation.

Seuls les destinataires publiés sur un site commercial marocain pertinent sont
retenus. Un devis sans référence, conformité, quantité ou disponibilité explicite
déclenche une clarification ; aucun prix n'est déduit d'une simple ressemblance.
"""
import csv
import hashlib
import io
import json
import re
import sqlite3
from datetime import datetime, timedelta, timezone, date
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from email.utils import parseaddr, make_msgid
from pathlib import Path
from urllib.parse import urlparse
from pricing import amount, fingerprint
from workflow import MAROC


def line_ref(index, article):
    return 'L%02d-%s' % (index+1, fingerprint(article)[:8].upper())


def deadline(bc):
    return datetime.strptime(bc['deadline'], '%d/%m/%Y %H:%M').replace(tzinfo=MAROC)


def needs_consultation(quote):
    return [i for i, line in enumerate(quote['lines']) if line.get('status') != 'chiffré'
            or line.get('source', {}).get('quantity_confirmed') is False]


def verified_contacts(events, article):
    contacts = {}
    for event in events:
        if event.get('article') != article['designation']:
            continue
        for lead in event.get('leads', []):
            host = (urlparse(lead.get('url', '')).hostname or '').lower().removeprefix('www.')
            if not host or not lead.get('commercial_context') or not lead.get('morocco'):
                continue
            addresses = sorted(set(lead.get('published_emails', [])))
            for address in addresses:
                address = address.strip().casefold()
                if not re.fullmatch(r'[a-z0-9.!#$%&\x27*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}', address):
                    continue
                domain = address.rsplit('@', 1)[1]
                # Une adresse personnelle n'est pas assimilée au vendeur découvert.
                if domain != host and not domain.endswith('.'+host):
                    continue
                contacts.setdefault(host, {'email': address, 'supplier': host,
                    'evidence_url': lead.get('contact_url', lead['url'])})
                break
    return list(contacts.values())[:4]


def build_request(bc, contact, indices, token, account, clarification=False):
    message = EmailMessage()
    message['From'] = account
    message['To'] = contact['email']
    message['Subject'] = '[FIMARO-BC] '+token+' '+('Précisions devis' if clarification else 'Demande de prix')
    message['Message-ID'] = make_msgid(domain=account.rsplit('@', 1)[1])
    intro = ('Merci de préciser les informations manquantes ci-dessous dans votre devis. '
             if clarification else 'Merci de nous adresser votre meilleure offre pour les articles ci-dessous. ')
    lines = ["Bonjour,", '', intro+'Demande de prix uniquement, sans commande.',
             'Consultation '+bc['id']+' ; échéance '+bc['deadline']+' (heure du Maroc).',
             'Indiquer prix TTC en MAD, disponibilité pour la quantité, délai et conformité aux caractéristiques.',
             'Merci de reprendre chaque référence de ligne, même dans un devis PDF.', '']
    for i in indices:
        a=bc['articles'][i]
        lines += [line_ref(i,a)+' : '+a['designation'], 'Caractéristiques : '+a['specification'],
                  'Quantité : '+a['quantity']+' ; unité : '+a['unit'],
                  'Format recommandé (répondre dans le mail ou PDF) :',
                  'REF='+line_ref(i,a)+'; PU_TTC=<prix>; DEVISE=MAD; UNITE='+a['unit']+
                  '; QTE_DEMANDEE='+a['quantity']+'; QTE_DISPO=<quantité>; STOCK=OUI; CONFORME=OUI; VALIDE_JUSQU_A=<AAAA-MM-JJ>; DELAI_JOURS=<nombre>', '']
    lines += ['Si vous proposez une autre référence, préciser ses différences ; elle ne sera pas assimilée à la référence demandée.',
              'Cordialement,', 'FIMARO SARL']
    message.set_content('\n'.join(lines))
    return message


def extract_text(message):
    texts=[]
    from pypdf import PdfReader
    for part in message.walk():
        if part.get_content_type() == 'text/plain':
            texts.append(part.get_content())
        elif part.get_content_type() == 'application/pdf' or (part.get_filename() or '').lower().endswith('.pdf'):
            raw=part.get_payload(decode=True) or b''
            if len(raw)>10*1024*1024:
                raise ValueError('PDF trop volumineux')
            reader=PdfReader(io.BytesIO(raw))
            if len(reader.pages)>40:
                raise ValueError('PDF trop long')
            texts.append('\n'.join(p.extract_text() or '' for p in reader.pages))
    if not texts:
        raise ValueError('Réponse sans texte ou PDF exploitable')
    # Le texte cité de notre propre demande ne peut pas devenir un prix.
    text='\n'.join(texts)
    return re.sub(r'(?m)^>.*$', '', text)


def parse_offer(text, request, message_id, today=None):
    today=today or date.today()
    refs={line_ref(i,request['bc']['articles'][i]):request['bc']['articles'][i] for i in request['indices']}
    rows=[];issues=[]
    chunks=re.split(r'(?i)(?=\bREF\s*[:=]\s*L\d+-[A-F0-9]{8})', text)
    for chunk in chunks:
        match=re.match(r'(?i)REF\s*[:=]\s*(L\d+-[A-F0-9]{8})',chunk.strip())
        if not match:
            continue
        ref=match[1].upper()
        if ref not in refs:
            issues.append('Référence de ligne inconnue');continue
        a=refs[ref]
        fields={}
        for key,value in re.findall(r'\b([A-Z_]+)\s*[:=]\s*([^;\n\r]+)',chunk):
            value=value.strip()
            if key in fields and fields[key]!=value:
                raise ValueError('Valeurs contradictoires dans le devis')
            fields[key]=value
        required=('PU_TTC','DEVISE','UNITE','QTE_DEMANDEE','QTE_DISPO','STOCK','CONFORME','VALIDE_JUSQU_A','DELAI_JOURS')
        try:
            if any(k not in fields for k in required):
                raise ValueError('Prix, conformité, stock, quantité, validité ou délai absent')
            if fields['DEVISE']!='MAD' or fields['UNITE'].casefold()!=a['unit'].casefold():
                raise ValueError('Devise ou unité incompatible')
            if fields['STOCK']!='OUI' or fields['CONFORME']!='OUI':
                raise ValueError('Stock ou conformité non confirmé')
            if amount(fields['QTE_DEMANDEE'])!=amount(a['quantity']) or amount(fields['QTE_DISPO'])<amount(a['quantity']):
                raise ValueError('Quantité incompatible')
            valid=date.fromisoformat(fields['VALIDE_JUSQU_A'])
            if valid<today or amount(fields['PU_TTC'])<=0 or amount(fields['DELAI_JOURS'])>365:
                raise ValueError('Prix, délai ou validité invalide')
            rows.append({**a,'purchase_ttc':str(amount(fields['PU_TTC'])),
                'supplier':request['supplier'],'source':'Gmail:'+message_id,
                'observed_on':today.isoformat(),'valid_until':valid.isoformat(),
                'min_qty':a['quantity'],'max_qty':a['quantity'],'in_stock':'oui','confirmed':'oui',
                'stock_quantity':fields['QTE_DISPO'],
                'request_id':request['token'],'delivery_days':fields['DELAI_JOURS']})
        except (ValueError, KeyError, ArithmeticError) as exc:
            issues.append(ref+': '+str(exc))
    if not rows and not issues:
        issues.append('Devis non structuré ou PDF scanné : demander les précisions par ligne')
    missing = set(refs) - {line_ref(i, request['bc']['articles'][i]) for i in request['indices']
        if any(fingerprint(row)==fingerprint(request['bc']['articles'][i]) for row in rows)}
    issues.extend(ref+': ligne non confirmée' for ref in sorted(missing))
    # Plusieurs blocs pour une même ligne au sein du même devis sont ambigus.
    ids=[fingerprint(r) for r in rows]
    if len(ids)!=len(set(ids)):
        raise ValueError('Plusieurs prix pour une même ligne dans le devis')
    return rows,issues


class SupplierFollowup:
    def __init__(self, data, account, send, mailbox=None):
        self.data=Path(data);self.account=account;self.send=send;self.mailbox=mailbox
        self.checkpoint = lambda: None
        self.db=sqlite3.connect(self.data/'supplier-followup.sqlite')
        self.db.execute('CREATE TABLE IF NOT EXISTS requests (token TEXT PRIMARY KEY, data TEXT, state TEXT, created TEXT, last_sent TEXT, attempts INTEGER, clarification INTEGER DEFAULT 0)')
        self.db.execute('CREATE TABLE IF NOT EXISTS replies (message_id TEXT PRIMARY KEY, token TEXT, result TEXT)')
        self.db.commit()

    def consult(self, bc, quote, events, now=None):
        now=now or datetime.now(MAROC)
        if now>=deadline(bc):return {'sent':0,'status':'expiré'}
        groups={}
        for index in needs_consultation(quote):
            contacts = verified_contacts(events,bc['articles'][index])
            if len(contacts)<3:
                continue
            for contact in contacts:
                item=groups.setdefault(contact['email'], {'contact':contact,'indices':[]})
                item['indices'].append(index)
        sent=0
        for address,item in groups.items():
            indices=sorted(set(item['indices']))
            token=hashlib.sha256(json.dumps([bc['id'],address,[(fingerprint(bc['articles'][i]),bc['articles'][i]['quantity']) for i in indices]],sort_keys=True).encode()).hexdigest()[:20]
            if self.db.execute('SELECT 1 FROM requests WHERE token=?',(token,)).fetchone():continue
            request={**item['contact'],'token':token,'bc':{k:v for k,v in bc.items() if k!='text'},'indices':indices}
            self.db.execute('INSERT INTO requests VALUES (?,?,?,?,?,?,?)',(token,json.dumps(request), 'envoi en cours',now.isoformat(),now.isoformat(),1,0));self.db.commit()
            try:
                self.checkpoint()
                self.send(build_request(bc,item['contact'],indices,token,self.account))
                self.db.execute('UPDATE requests SET state=? WHERE token=?',('envoyé',token));self.db.commit();sent+=1
                self.checkpoint()
            except Exception:
                self.db.execute('UPDATE requests SET state=? WHERE token=?',('envoi incertain',token));self.db.commit()
                # Jamais de répétition automatique d'un envoi dont le résultat est incertain.
        return {'sent':sent,'suppliers_found':len(groups),'status':'consultation envoyée' if sent else 'aucun nouveau destinataire vérifié'}

    def receive(self, prices, messages):
        imported=0;issues=[]
        for raw in messages:
            if len(raw)>15*1024*1024:continue
            message=BytesParser(policy=policy.default).parsebytes(raw)
            mid=message.get('Message-ID','')
            if not mid or self.db.execute('SELECT 1 FROM replies WHERE message_id=?',(mid,)).fetchone():continue
            subject=message.get('Subject','')
            sender=parseaddr(message.get('From',''))[1].casefold()
            token_match=re.search(r'\[FIMARO-BC\]\s*([a-f0-9]{20})',subject)
            if not token_match:continue
            token=token_match[1]
            found=self.db.execute('SELECT data,clarification FROM requests WHERE token=?',(token,)).fetchone()
            if not found:continue
            request=json.loads(found[0])
            if sender!=request['email']:continue
            try:
                rows,problems=parse_offer(extract_text(message),request,mid)
                if rows:
                    with tempfile_csv(self.data,rows) as path:imported+=prices.import_csv(path)
                issues.extend(problems)
                state='réponse conforme' if rows and not problems else 'précisions requises'
                self.db.execute('UPDATE requests SET state=? WHERE token=?',(state,token))
                self.db.execute('INSERT INTO replies VALUES (?,?,?)',(mid,token,json.dumps(problems)));self.db.commit()
                self.checkpoint()
                if problems and not found[1] and datetime.now(MAROC)<deadline(request['bc']):
                    self.db.execute('UPDATE requests SET clarification=1 WHERE token=?',(token,));self.db.commit()
                    self.checkpoint()
                    self.send(build_request(request['bc'],request,request['indices'],token,self.account,True))
            except Exception as exc:
                issues.append(type(exc).__name__+': devis non importé')
                self.db.execute('INSERT OR IGNORE INTO replies VALUES (?,?,?)',(mid,token,'échec analyse'));self.db.commit()
                if not found[1] and datetime.now(MAROC)<deadline(request['bc']):
                    self.db.execute('UPDATE requests SET state=?,clarification=1 WHERE token=?',('précisions requises',token));self.db.commit()
                    try:
                        self.checkpoint()
                        self.send(build_request(request['bc'],request,request['indices'],token,self.account,True))
                    except Exception:
                        issues.append('Demande de précision non confirmée')
        return {'imported_rows':imported,'issues':issues}

    def remind(self,now=None):
        now=now or datetime.now(MAROC);count=0
        for token,data,state,created,last,attempts,clarification in self.db.execute('SELECT * FROM requests').fetchall():
            request=json.loads(data)
            if state!='envoyé' or attempts>=3 or now>=deadline(request['bc']) or now-datetime.fromisoformat(last)<timedelta(hours=24):continue
            self.db.execute('UPDATE requests SET state=?,attempts=?,last_sent=? WHERE token=?',('envoi en cours',attempts+1,now.isoformat(),token));self.db.commit()
            try:
                self.checkpoint()
                self.send(build_request(request['bc'],request,request['indices'],token,self.account))
                self.db.execute('UPDATE requests SET state=? WHERE token=?',('envoyé',token));self.db.commit();count+=1
                self.checkpoint()
            except Exception:
                self.db.execute('UPDATE requests SET state=? WHERE token=?',('envoi incertain',token));self.db.commit()
        return count


class tempfile_csv:
    def __init__(self,folder,rows):self.folder,self.rows=folder,rows
    def __enter__(self):
        import tempfile
        f=tempfile.NamedTemporaryFile('w',suffix='.csv',encoding='utf-8',newline='',delete=False,dir=self.folder)
        self.path=Path(f.name)
        with f:
            writer=csv.DictWriter(f,fieldnames=list(self.rows[0]),delimiter=';');writer.writeheader();writer.writerows(self.rows)
        return self.path
    def __exit__(self,*args):self.path.unlink(missing_ok=True)


def connected(data):
    import imaplib, smtplib, os
    from credentials import credential_store
    config=json.loads(Path(os.environ.get('BC_MAIL_BRIDGE_CONFIG',Path(__file__).parent/'mail_bridge_config.json')).read_text())
    password=credential_store().get_password('FIMARO-BC-GMAIL-IMAP',config['account'])
    if not password:raise RuntimeError('Gmail non configuré')
    def send(message):
        with smtplib.SMTP_SSL('smtp.gmail.com',465,timeout=30) as smtp:
            smtp.login(config['account'],password);smtp.send_message(message)
    followup=SupplierFollowup(data,config['account'],send)
    def receive(prices):
        messages=[]
        with imaplib.IMAP4_SSL('imap.gmail.com',timeout=30) as mailbox:
            mailbox.login(config['account'],password);mailbox.select('INBOX',readonly=True)
            status,values=mailbox.uid('search',None,'SUBJECT','"[FIMARO-BC]"')
            if status!='OK':raise RuntimeError('Recherche réponses fournisseurs impossible')
            for uid in values[0].split()[-200:]:
                status,parts=mailbox.uid('fetch',uid,'(BODY.PEEK[])')
                if status=='OK':
                    for part in parts:
                        if not isinstance(part,tuple):continue
                        message=BytesParser(policy=policy.default).parsebytes(part[1])
                        authentication=' '.join(message.get_all('Authentication-Results',[]))
                        if re.search(r'\bdmarc=pass\b',authentication,re.I):messages.append(part[1])
        return followup.receive(prices,messages)
    followup.receive_connected=receive
    return followup
