"""Coffre Windows ou secrets montés sur Linux ; aucune valeur dans les journaux."""
import os
import stat
import sys
from pathlib import Path


class MountedSecrets:
    FILES = {('FIMARO-BC-PORTAIL', 'login'): 'portal_login',
             ('FIMARO-BC-PORTAIL', 'password'): 'portal_password'}

    def __init__(self, folder=None):
        self.folder = Path(folder or os.environ.get('BC_SECRETS_DIR', '/run/secrets'))

    def get_password(self, service, account):
        name = self.FILES.get((service, account))
        if service == 'FIMARO-BC-GMAIL-IMAP':
            name = 'gmail_app_password'
        if not name:
            return None
        path = self.folder / name
        try:
            info = path.lstat()
        except FileNotFoundError:
            return None
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            raise RuntimeError('Permissions du fichier secret incorrectes : '+name)
        if info.st_size > 8192:
            raise RuntimeError('Fichier secret trop volumineux : '+name)
        return path.read_text(encoding='utf-8').strip() or None

    def set_password(self, service, account, value):
        raise RuntimeError('Configurer les secrets avec configure_cloud.py sur le serveur')


def credential_store():
    if sys.platform == 'win32':
        from keyring.backends.Windows import WinVaultKeyring
        return WinVaultKeyring()
    return MountedSecrets()
