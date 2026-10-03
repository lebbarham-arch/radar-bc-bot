"""Checkpoints SQLite chiffrés dans la boîte FIMARO pour les redéploiements.

Aucun identifiant n'est archivé. La clé reste dans la variable privée du service.
"""
import base64
import hashlib
import io
import json
import os
import sqlite3
import tempfile
import zipfile
import imaplib
import smtplib
from pathlib import Path
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from cryptography.fernet import Fernet
from credentials import credential_store

SUBJECT='[FIMARO-BC-STATE-v1]'

def settings():
    config=json.loads(Path(os.environ['BC_MAIL_BRIDGE_CONFIG']).read_text())
    password=credential_store().get_password('FIMARO-BC-GMAIL-IMAP',config['account'])
    if not password:raise RuntimeError('Checkpoint Gmail non connecté')
    key=base64.urlsafe_b64encode(hashlib.sha256(config['secret'].encode()).digest())
    return config['account'],password,Fernet(key)

def backup(folder):
    folder=Path(folder);account,password,cipher=settings();data=io.BytesIO()
    with tempfile.TemporaryDirectory() as temp:
        with zipfile.ZipFile(data,'w',zipfile.ZIP_DEFLATED) as archive:
            for source in sorted(folder.glob('*.sqlite')):
                target=Path(temp)/source.name
                connection=sqlite3.connect(source)
                destination=sqlite3.connect(target)
                try:connection.backup(destination)
                finally:destination.close();connection.close()
                archive.write(target,source.name)
    raw=data.getvalue()
    if len(raw)>15*1024*1024:raise RuntimeError('Checkpoint trop volumineux')
    encrypted=cipher.encrypt(raw)
    message=EmailMessage();message['From']=message['To']=account;message['Subject']=SUBJECT
    message.set_content('Checkpoint automatique chiffré de l’agent BC. Aucun mot de passe inclus.')
    message.add_attachment(encrypted,maintype='application',subtype='octet-stream',filename='checkpoint.enc')
    with imaplib.IMAP4_SSL('imap.gmail.com',timeout=30) as mailbox:
        mailbox.login(account,password)
        status,_=mailbox.append('INBOX',None,None,message.as_bytes())
        if status!='OK':raise RuntimeError('Checkpoint IMAP non sauvegardé')

def restore(folder):
    folder=Path(folder)
    if any(folder.glob('*.sqlite')):return 'état local présent'
    account,password,cipher=settings()
    with imaplib.IMAP4_SSL('imap.gmail.com',timeout=30) as mailbox:
        mailbox.login(account,password);mailbox.select('INBOX',readonly=True)
        status,values=mailbox.uid('search',None,'SUBJECT','"'+SUBJECT+'"')
        if status!='OK':raise RuntimeError('Lecture checkpoint impossible')
        uids=values[0].split()
        if not uids:return 'premier lancement sans checkpoint'
        status,parts=mailbox.uid('fetch',uids[-1],'(BODY.PEEK[])')
        if status!='OK':raise RuntimeError('Checkpoint indisponible')
        raw=next(p[1] for p in parts if isinstance(p,tuple))
    message=BytesParser(policy=policy.default).parsebytes(raw)
    attachments=[p.get_payload(decode=True) for p in message.walk() if p.get_filename()=='checkpoint.enc']
    if len(attachments)!=1:raise RuntimeError('Checkpoint invalide')
    payload=cipher.decrypt(attachments[0])
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        entries=archive.infolist()
        if sum(e.file_size for e in entries)>40*1024*1024:raise RuntimeError('Checkpoint décompressé trop grand')
        for entry in entries:
            if Path(entry.filename).name!=entry.filename or not entry.filename.endswith('.sqlite'):
                raise RuntimeError('Fichier checkpoint interdit')
        for entry in entries:
            (folder/entry.filename).write_bytes(archive.read(entry))
    return 'checkpoint restauré'
