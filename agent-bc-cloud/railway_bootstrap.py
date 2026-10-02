"""Cloud preflight. No offer is written during the initial deployment."""
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
DATA = ROOT / 'donnees'

def preflight():
    results = []
    for url in ['https://www.marchespublics.gov.ma/', 'https://aswakassalam.com/']:
        try:
            with urlopen(Request(url, headers={'User-Agent': 'BC-Pilot-Connectivity/1.0'}), timeout=25) as response:
                results.append({'site': url, 'http_status': response.status})
        except Exception as exc:
            results.append({'site': url, 'error_type': type(exc).__name__})
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True, chromium_sandbox=True)
            page = browser.new_page()
            page.set_content('<title>BC cloud preflight</title>')
            results.append({'chromium': page.title() == 'BC cloud preflight'})
            browser.close()
    except Exception as exc:
        results.append({'chromium': False, 'error_type': type(exc).__name__, 'details': str(exc)[:6000]})
    DATA.mkdir(exist_ok=True)
    (DATA / 'preflight.json').write_text(json.dumps(results))
    print('CLOUD_PREFLIGHT', json.dumps(results), flush=True)

def main():
    preflight()
    if os.environ.get('BC_RUNTIME_READY') != '1':
        print('WAITING_CONFIGURATION: portal and Gmail secrets not configured; no draft writes.', flush=True)
        while True:
            time.sleep(3600)
    required = ['BC_PORTAL_LOGIN', 'BC_PORTAL_PASSWORD', 'BC_COMPANY_PROFILE_JSON']
    if any(not os.environ.get(key) for key in required):
        raise RuntimeError('Required runtime configuration is missing')
    folder = DATA / 'secrets'
    folder.mkdir(mode=0o700, exist_ok=True)
    values = {'portal_login': os.environ['BC_PORTAL_LOGIN'], 'portal_password': os.environ['BC_PORTAL_PASSWORD']}
    if os.environ.get('BC_GMAIL_APP_PASSWORD'):
        values['gmail_app_password'] = os.environ['BC_GMAIL_APP_PASSWORD']
    for name, value in values.items():
        path = folder / name
        fd = os.open(path, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w') as output:
            output.write(value)
    profile = json.loads(os.environ['BC_COMPANY_PROFILE_JSON'])
    (ROOT / 'company_profile.json').write_text(json.dumps(profile))
    if os.environ.get('BC_ACCOUNT_NAME'):
        config = json.loads((ROOT / 'config.json').read_text())
        config['account_name'] = os.environ['BC_ACCOUNT_NAME']
        (ROOT / 'config.json').write_text(json.dumps(config))
    if os.environ.get('BC_MAIL_CONFIG_JSON'):
        path = folder / 'mail_bridge_config.json'
        fd = os.open(path, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w') as output:
            output.write(os.environ['BC_MAIL_CONFIG_JSON'])
    os.execv(sys.executable, [sys.executable, str(ROOT / 'cloud_worker.py')])

if __name__ == '__main__':
    main()
