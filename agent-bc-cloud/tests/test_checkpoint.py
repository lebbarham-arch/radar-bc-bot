import base64, tempfile, sqlite3, unittest
from pathlib import Path
from unittest.mock import patch
from cryptography.fernet import Fernet
import cloud_state

class CheckpointTest(unittest.TestCase):
    def test_encrypted_backup_and_restore(self):
        sent=[]
        class SMTP:
            def __init__(self,*args,**kw):pass
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def login(self,*args):pass
            def send_message(self,message):sent.append(message.as_bytes())
        class IMAP(SMTP):
            def select(self,*args,**kw):pass
            def uid(self,action,*args):
                return ('OK',[b'1']) if action=='search' else ('OK',[(b'BODY',sent[-1])])
        with tempfile.TemporaryDirectory() as temp:
            source=Path(temp)/'source';target=Path(temp)/'restored';source.mkdir();target.mkdir()
            db=sqlite3.connect(source/'workflow.sqlite');db.execute('CREATE TABLE requests(id TEXT,state TEXT)');db.execute('INSERT INTO requests VALUES (?,?)',('test','envoyé'));db.commit();db.close()
            settings=('simulation@example.invalid','sim-only',Fernet(Fernet.generate_key()))
            with patch.object(cloud_state,'settings',return_value=settings),patch.object(cloud_state.smtplib,'SMTP_SSL',SMTP),patch.object(cloud_state.imaplib,'IMAP4_SSL',IMAP):
                cloud_state.backup(source)
                self.assertNotIn(b'envoy',sent[-1])
                self.assertEqual(cloud_state.restore(target),'checkpoint restauré')
                restored=sqlite3.connect(target/'workflow.sqlite')
                self.assertEqual(restored.execute('SELECT * FROM requests').fetchone(),('test','envoyé'))
                restored.close()

if __name__=='__main__':unittest.main()
