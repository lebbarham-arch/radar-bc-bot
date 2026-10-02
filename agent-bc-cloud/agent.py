"""Pilote local BC. Ne signe et ne soumet jamais une offre."""
import argparse
import getpass
import json
import os
import re
import sqlite3
import sys
import unicodedata
import io
import zipfile
from datetime import datetime
from pathlib import Path
from credentials import credential_store
from urllib.parse import urljoin, urlparse
from zoneinfo import ZoneInfo
from pricing import Prices, amount
from parsing import extract_articles
from company import load_profile, fill_company, PORTAL_SELECTORS
from sourcing import PublicSources
from workflow import Workflow, filling_policy
from mail_bridge import receive as receive_supplier_prices, publish as publish_supplier_need
from portal_form import collect_rows, parse_rows, fill_prices, validate_quote

ROOT = Path(__file__).resolve().parent
DATA = ROOT / 'donnees'
ORIGIN = 'https://www.marchespublics.gov.ma'
LIST_URL = ORIGIN + '/bdc/entreprise/consultation/'
LOGIN_URL = ORIGIN + '/index.php?page=entreprise.EntrepriseHome'
SERVICE = 'FIMARO-BC-PORTAIL'


def norm(value):
    return ''.join(c for c in unicodedata.normalize('NFKD', value)
                   if not unicodedata.combining(c)).casefold()


def check_url(url):
    p = urlparse(url)
    if p.scheme != 'https' or p.hostname != 'www.marchespublics.gov.ma' or p.username or p.password:
        raise RuntimeError('Destination portail inattendue')
    return url


def setup():
    store = credential_store()
    print('Enregistrement local dans le coffre Windows. Aucune transmission à ChatGPT.')
    login = input('Login du portail : ').strip()
    password = getpass.getpass('Mot de passe du portail : ')
    if not login or not password:
        raise RuntimeError('Identifiants incomplets')
    store.set_password(SERVICE, 'login', login)
    store.set_password(SERVICE, 'password', password)
    print('Identifiants enregistrés. La reconnexion sera automatique.')


def challenge(page):
    text = norm(page.locator('body').inner_text())
    signals = ['verify you are human', 'verification humaine', 'unusual traffic',
               'checking your browser', 'je ne suis pas un robot', 'i am not a robot']
    if any(s in text for s in signals):
        raise RuntimeError('Vérification humaine du portail : intervention nécessaire')
    if page.locator('iframe[src*="recaptcha"],iframe[src*="hcaptcha"]').count():
        raise RuntimeError('CAPTCHA du portail : intervention nécessaire')


def signed_in(page, config):
    text = norm(page.locator('body').inner_text())
    return norm(config['account_name']) in text and 'vous n\'etes pas authentifie' not in text


def login(page, config):
    print('Connexion au portail...', flush=True)
    page.goto(LOGIN_URL, wait_until='domcontentloaded')
    challenge(page)
    if signed_in(page, config):
        return
    store = credential_store()
    username = store.get_password(SERVICE, 'login')
    password = store.get_password(SERVICE, 'password')
    if not username or not password:
        raise RuntimeError('Identifiants du portail non configurés sur cet hôte')
    check_url(page.url)
    # Sélecteurs observés sur le formulaire officiel le 02/10/2026.
    user_field = page.locator('input[name="ctl0$CONTENU_PAGE$login"]')
    pass_field = page.locator('input[name="ctl0$CONTENU_PAGE$password"]')
    submit = page.locator('#ctl0_CONTENU_PAGE_authentificationButton')
    for control in (user_field, pass_field, submit):
        if control.count() != 1 or not control.is_visible():
            raise RuntimeError('Formulaire de connexion modifié')
    user_field.fill(username)
    pass_field.fill(password)
    submit.click()
    page.wait_for_load_state('domcontentloaded')
    challenge(page)
    try:
        page.get_by_text(config['account_name'], exact=False).first.wait_for(timeout=15000)
    except Exception:
        raise RuntimeError('Connexion non confirmée ; vérifier le compte localement') from None
    if not signed_in(page, config):
        raise RuntimeError('Compte connecté non confirmé')
    print('Connexion confirmée.', flush=True)
    # Aucun storage_state ou mot de passe enregistré dans les rapports.


def unique_control(page, selector):
    loc = page.locator(selector)
    if loc.count() != 1 or not loc.is_visible() or not loc.is_enabled():
        raise RuntimeError('Contrôle absent, ambigu ou désactivé')
    return loc


def bdc_signed_in(page):
    """Confirmer l'identité sur l'espace BC, pas seulement l'ancien portail."""
    check_url(page.url)
    if '/bdc/' not in page.url:
        return False
    identity = page.locator('#dropdownMenuButton1')
    if identity.count() != 1 or not identity.is_visible():
        return False
    name = norm(identity.inner_text()).strip()
    if not name or 'invite' in name:
        return False
    if page.get_by_role('link', name='vous connecter', exact=True).count():
        return False
    return True


def open_bdc(page):
    print('Ouverture de l’espace BC par le menu du portail...', flush=True)
    menu = page.get_by_role('link', name="Avis d'achat en cours", exact=True)
    if menu.count() != 1 or not menu.is_visible():
        raise RuntimeError('Menu Avis d’achat en cours absent : transition BC non effectuée')
    # Utiliser le lien du portail conserve les étapes de transfert de session.
    # Aucun cookie reconstruit et aucun paramètre de connexion deviné.
    if menu.get_attribute('target') == '_blank':
        with page.expect_popup(timeout=15000) as popup:
            menu.click()
        page = popup.value
    else:
        opened = []
        def new_page(new):
            opened.append(new)
        page.context.on('page', new_page)
        try:
            menu.click()
            # Certains liens JavaScript ouvrent un onglet sans attribut target.
            page.wait_for_timeout(1000)
            if opened:
                page = opened[-1]
        finally:
            page.context.remove_listener('page', new_page)
    page.wait_for_load_state('domcontentloaded')
    challenge(page)
    if not bdc_signed_in(page):
        # Diagnostic limité aux titres de contrôles et au chemin, sans secrets.
        diagnostic = {'url_path': urlparse(page.url).path,
            'buttons': page.locator('button').all_text_contents(),
            'link_labels': page.locator('a').all_text_contents()}
        (DATA / 'transition-bc.json').write_text(json.dumps(diagnostic, ensure_ascii=False, indent=2), encoding='utf-8')
        raise RuntimeError('Espace BC non connecté : le transfert de session doit être diagnostiqué')
    print('Connexion à l’espace BC confirmée.', flush=True)
    return page


def discover(page, config):
    print('Recherche des consultations...', flush=True)
    links = set(config.get('seeds', []))
    seen = set()
    page.goto(LIST_URL, wait_until='domcontentloaded')
    if not bdc_signed_in(page):
        raise RuntimeError('Session BC perdue lors de l’ouverture de la liste')
    for _ in range(config['max_pages']):
        print('Lecture de la page', _ + 1, flush=True)
        challenge(page)
        content = page.locator('body').inner_text()
        if content in seen:
            break
        seen.add(content)
        for href in page.locator('a[href*="/consultation/show/"]').evaluate_all(
                '(els) => els.map(e => e.href)'):
            if re.fullmatch(r'https://www\.marchespublics\.gov\.ma/bdc/entreprise/consultation/show/\d+', href):
                links.add(href)
        next_link = page.get_by_role('link', name=re.compile(r'^(Suivant|Suivante|›|»)$'))
        if next_link.count() != 1 or not next_link.is_visible():
            break
        if next_link.get_attribute('aria-disabled') == 'true':
            break
        next_link.click()
        page.wait_for_load_state('domcontentloaded')
    return sorted(links)


def labeled(text, label):
    # Texte officiel avec une étiquette puis sa valeur sur la ligne suivante.
    values = [x.strip() for x in text.splitlines() if x.strip()]
    for i, value in enumerate(values[:-1]):
        if norm(value) == norm(label):
            return values[i + 1]
    return ''


def read_bc(page, url, config):
    page.goto(check_url(url), wait_until='domcontentloaded')
    challenge(page)
    if not bdc_signed_in(page):
        raise RuntimeError('Session BC absente sur le détail de la consultation')
    expand = page.get_by_role('button', name='Tout afficher', exact=True)
    if expand.count() == 1:
        expand.click()
    text = page.locator('body').inner_text()
    object_text = labeled(text, 'Objet')
    location = labeled(text, "Lieu d'exécution")
    deadline = labeled(text, 'Date limite de réception des devis')
    try:
        # Windows doit utiliser le fuseau Maroc ; l'installateur vérifie ce point.
        expired = datetime.strptime(deadline, '%d/%m/%Y %H:%M').replace(tzinfo=ZoneInfo('Africa/Casablanca')) <= datetime.now(ZoneInfo('Africa/Casablanca'))
    except ValueError:
        expired = True
    region = any(norm(r) in norm(location) for r in config['regions'])
    category = labeled(text, 'Nature de prestation')
    relevant = any(norm(k) in norm(object_text + ' ' + category) for k in config['keywords'])
    excluded = 'animaux' in norm(category) or 'animale' in norm(object_text)
    articles, extraction_errors = extract_articles(text)
    rows = collect_rows(page)
    if rows:
        try:
            articles = parse_rows(rows)
            extraction_errors = []
        except RuntimeError as exc:
            extraction_errors = [{'reason': str(exc)}]
    return {'id': url.rsplit('/', 1)[-1], 'url': url, 'object': object_text,
            'location': location, 'deadline': deadline,
            'eligible': region and relevant and not expired and not excluded,
            'articles': articles, 'extraction_errors': extraction_errors, 'text': text}


def save_draft(page, bc, quote, adapter, ledger):
    if bc.get('extraction_errors'):
        return 'extraction incomplète : saisie bloquée'
    if not adapter:
        return save_observed_form(page, bc, quote, ledger)
    if not quote['complete']:
        return 'prix à confirmer'
    text = norm(bc['text'])
    if any(x in text for x in ('devis deja depose', 'devis depose', 'brouillon', 'devis signe')):
        return 'offre existante : conservée'
    if ledger.execute('SELECT 1 FROM drafts WHERE bc_id=?', (bc['id'],)).fetchone():
        return 'déjà enregistré par cet agent : conservé'
    if len(adapter['price_selectors']) != len(quote['lines']):
        return 'configuration incompatible avec le nombre de lignes'
    # Adaptateur propre à CE BC et validé après observation locale.
    if str(adapter.get('bc_id')) != bc['id']:
        return 'adaptateur absent pour ce BC'
    if not adapter.get('validated_on'):
        return 'adaptateur non validé'
    prepare = unique_control(page, adapter['open_selector'])
    label = norm(prepare.inner_text())
    if any(w in label for w in ('sign', 'soumet', 'depos', 'valider')):
        raise RuntimeError('Bouton de préparation engageant ou ambigu')
    prepare.click()
    challenge(page)
    if not adapter.get('company_selectors'):
        return 'champs entreprise à configurer : saisie bloquée'
    fill_company(page, load_profile(ROOT / 'company_profile.json'), adapter['company_selectors'])
    for line, selector in zip(quote['lines'], adapter['price_selectors']):
        unique_control(page, selector).fill(line['unit_sale_ht'])
    save = unique_control(page, adapter['save_selector'])
    if norm(save.inner_text()).strip() != 'enregistrer comme brouillon':
        raise RuntimeError('Le bouton doit être exactement Enregistrer comme brouillon')
    save.click()
    page.locator(adapter['success_selector']).wait_for(state='visible', timeout=15000)
    if norm(adapter['success_text']) not in norm(page.locator(adapter['success_selector']).inner_text()):
        raise RuntimeError('Enregistrement non confirmé')
    page.reload(wait_until='domcontentloaded')
    for line, selector in zip(quote['lines'], adapter['price_selectors']):
        if unique_control(page, selector).input_value().replace(',', '.') != line['unit_sale_ht']:
            raise RuntimeError('Prix persisté différent : vérification nécessaire')
    evidence = DATA / ('brouillon-' + bc['id'] + '-' + datetime.now().strftime('%Y%m%d-%H%M%S') + '.png')
    page.screenshot(path=str(evidence), full_page=True)
    ledger.execute('INSERT OR REPLACE INTO drafts VALUES (?,?,?,?)',
                   (bc['id'], datetime.now().isoformat(), json.dumps(quote), str(evidence)))
    ledger.commit()
    return 'brouillon enregistré et prix revérifiés'


def save_observed_form(page, bc, quote, ledger):
    if not quote['complete'] and not quote.get('allow_partial'):
        return 'prix à confirmer : BC passé'
    stored = ledger.execute('SELECT quote FROM drafts WHERE bc_id=?', (bc['id'],)).fetchone()
    previous = json.loads(stored[0]) if stored else None
    def vector(value):
        return [line.get('unit_sale_ht') for line in value['lines']]
    if previous and vector(previous) == vector(quote):
        return 'brouillon inchangé : conservé'
    ledger.execute('CREATE TABLE IF NOT EXISTS draft_attempts (bc_id TEXT PRIMARY KEY, state TEXT, attempted_at TEXT)')
    attempt = ledger.execute('SELECT state FROM draft_attempts WHERE bc_id=?', (bc['id'],)).fetchone()
    if attempt and attempt[0] != 'vérifié':
        return 'tentative précédente : contrôle manuel requis avant nouvelle sauvegarde'
    if not bdc_signed_in(page):
        raise RuntimeError('Session BC perdue : saisie bloquée')
    if any(s in norm(bc['text']) for s in ('devis deja depose', 'devis depose', 'devis signe')):
        return 'offre existante : conservée'
    validate_quote(collect_rows(page), quote)
    save = unique_control(page, '#button-enregistrer')
    if norm(save.inner_text()).strip() != 'enregistrer comme brouillon':
        raise RuntimeError('Bouton brouillon différent : saisie bloquée')
    fill_company(page, load_profile(ROOT / 'company_profile.json'), PORTAL_SELECTORS)
    if previous:
        validate_quote(collect_rows(page), previous)
    count = fill_prices(page, quote, previous)
    print('  ', count, 'prix saisis et relus.', flush=True)
    evidence = DATA / ('saisie-' + bc['id'] + '-' + datetime.now().strftime('%Y%m%d-%H%M%S') + '.png')
    page.screenshot(path=str(evidence), full_page=True)
    # Écrit AVANT le clic : une réponse serveur incertaine ne déclenche pas un second envoi.
    ledger.execute('INSERT OR REPLACE INTO draft_attempts VALUES (?,?,?)', (bc['id'], 'en cours', datetime.now().isoformat()))
    ledger.commit()
    if filling_policy(bc, quote) == 'expiré':
        ledger.execute('UPDATE draft_attempts SET state=? WHERE bc_id=?', ('échéance dépassée sans clic', bc['id']))
        ledger.commit()
        return 'échéance dépassée pendant la saisie : brouillon non enregistré'
    save.click()
    page.wait_for_load_state('domcontentloaded')
    verified = False
    verification = page.context.new_page()
    for attempt in range(3):
        page.wait_for_timeout(1000)
        verification.goto(check_url(bc['url']), wait_until='domcontentloaded')
        if not bdc_signed_in(verification):
            break
        try:
            validate_quote(collect_rows(verification), quote)
            fields = verification.locator('tr:visible').filter(has=verification.locator('input[type="number"]')).locator('input[type="number"]')
            verified = fields.count() == len(quote['lines']) and all(
                (line.get('status') != 'chiffré' and (not fields.nth(i).input_value().strip() or amount(fields.nth(i).input_value()) == 0)) or
                (line.get('status') == 'chiffré' and fields.nth(i).input_value().strip() and amount(fields.nth(i).input_value()) == amount(line['unit_sale_ht']))
                for i, line in enumerate(quote['lines']))
        except (RuntimeError, ValueError):
            verified = False
        if verified:
            break
    if not verified:
        verification.close()
        ledger.execute('UPDATE draft_attempts SET state=? WHERE bc_id=?', ('à vérifier', bc['id']))
        ledger.commit()
        return 'saisie effectuée ; sauvegarde non confirmée : ne pas répéter automatiquement'
    verification.screenshot(path=str(evidence), full_page=True)
    verification.close()
    ledger.execute('INSERT OR REPLACE INTO drafts VALUES (?,?,?,?)', (bc['id'], datetime.now().isoformat(), json.dumps(quote), str(evidence)))
    ledger.execute('UPDATE draft_attempts SET state=? WHERE bc_id=?', ('vérifié', bc['id']))
    ledger.commit()
    return 'brouillon enregistré et prix revérifiés'


def inspect_form():
    """Observe les lignes et teste les champs entreprise sans enregistrer."""
    from playwright.sync_api import sync_playwright
    DATA.mkdir(exist_ok=True)
    config = json.loads((ROOT / 'config.json').read_text(encoding='utf-8-sig'))
    result = {'version': '0.5.0-cloud-pilote', 'read_only': False, 'saved': False, 'bc_id': '387737'}
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True, chromium_sandbox=sys.platform != 'win32')
            page = browser.new_page(locale='fr-FR')
            page.set_default_timeout(15000)
            login(page, config)
            result['classic_login'] = 'confirmée'
            page = open_bdc(page)
            result['bdc_login'] = 'confirmée'
            page.goto(ORIGIN + '/bdc/entreprise/consultation/show/387737', wait_until='domcontentloaded')
            challenge(page)
            check_url(page.url)
            if not bdc_signed_in(page):
                raise RuntimeError('Espace BC affiche Invité après ouverture du détail')
            print('Récupération automatique du dossier joint...', flush=True)
            result['attachment'] = download_attachment(page, result['bc_id'])
            # Observation de la structure uniquement : aucune valeur d'input ni jeton.
            result['controls'] = page.locator('input,select,textarea,button,a').evaluate_all('''els => els
                .filter(e => e.getClientRects().length && e.type !== 'password' && e.type !== 'hidden')
                .map(e => ({tag:e.tagName.toLowerCase(), id:e.id, name:e.getAttribute('name'),
                           type:e.getAttribute('type'), label:[...(e.labels || [])].map(x=>x.innerText).join(' '),
                           text:(e.tagName==='BUTTON'||e.tagName==='A')?e.innerText.trim():null,
                           href:e.tagName==='A' && e.getAttribute('href') &&
                              e.getAttribute('href').startsWith('/bdc/')?e.getAttribute('href'):null,
                           disabled:!!e.disabled}))''')
            result['form_already_visible'] = page.get_by_role('button', name='Enregistrer comme brouillon', exact=True).count() > 0
            result['price_rows'] = page.locator('tr').evaluate_all('''els => els
                .filter(e => e.getClientRects().length && e.querySelector('input[type="number"]'))
                .map(e => ({text:e.innerText.trim(), cells:[...e.cells].map(c=>c.innerText.trim()),
                    number_inputs:[...e.querySelectorAll('input[type="number"]')].map(i=>({
                        id:i.id, name:i.getAttribute('name'), disabled:i.disabled,
                        min:i.getAttribute('min'), step:i.getAttribute('step')}))}))''')
            if result['form_already_visible']:
                try:
                    fill_company(page, load_profile(ROOT / 'company_profile.json'), PORTAL_SELECTORS)
                    result['company_fields'] = 'RIB et taxe saisis et relus ; ICE vérifié ; aucun enregistrement'
                except Exception as exc:
                    result['company_fields'] = 'bloqué : ' + type(exc).__name__
                    if isinstance(exc, RuntimeError):
                        result['company_fields'] += ' : ' + str(exc)
                result['bank_controls_after'] = page.locator('[id^="entreprise_infos_devis_form_compte"], #esl-a').evaluate_all(
                    'els => els.map(e=>({tag:e.tagName.toLowerCase(),id:e.id,name:e.getAttribute("name"),type:e.getAttribute("type")}))')
                result['visible_fields_after'] = page.locator('input,select,textarea').evaluate_all('''els => els
                    .filter(e=>e.getClientRects().length && e.type !== 'hidden' && e.type !== 'password')
                    .map(e=>({tag:e.tagName.toLowerCase(),id:e.id,name:e.getAttribute('name'),
                        type:e.getAttribute('type'),label:[...(e.labels||[])].map(x=>x.innerText).join(' ')}))''')
            result['status'] = 'observation terminée'
            browser.close()
    except RuntimeError as exc:
        result.update(status='bloqué', reason=str(exc))
    except Exception as exc:
        result.update(status='bloqué', reason='Erreur technique : '+type(exc).__name__)
    output = DATA / ('diagnostic-formulaire-'+datetime.now().strftime('%Y%m%d-%H%M%S-%f')+'.json')
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print('Diagnostic créé :', output, flush=True)
    print('État :', result['status'], flush=True)
    return 0 if result['status'] == 'observation terminée' else 1


def download_attachment(page, bc_id):
    """Télécharge via le lien observé et lit les PDF sans exécuter le ZIP."""
    from pypdf import PdfReader
    links = page.locator('a[href^="/bdc/entreprise/consultation/download/' + str(bc_id) + '/"]')
    if links.count() != 1:
        return {'status': 'pièce jointe absente ou multiple'}
    check_url(urljoin(ORIGIN, links.get_attribute('href')))
    try:
        with page.expect_download(timeout=30000) as event:
            links.click()
        download = event.value
        folder = DATA / 'pieces_jointes'
        folder.mkdir(exist_ok=True)
        path = folder / (str(bc_id) + '-dossier.zip')
        download.save_as(str(path))
        if path.stat().st_size > 32 * 1024 * 1024:
            return {'status': 'téléchargé ; trop volumineux pour lecture automatique', 'file': str(path)}
        documents = []
        with zipfile.ZipFile(path) as archive:
            for info in archive.infolist():
                if info.is_dir():
                    continue
                doc = {'name': info.filename}
                if info.filename.lower().endswith('.pdf') and info.file_size <= 16 * 1024 * 1024:
                    try:
                        pdf = PdfReader(io.BytesIO(archive.read(info)))
                        pages = [(p.extract_text() or '') for p in list(pdf.pages)[:50]]
                        doc.update(text='\n'.join(pages), page_count=len(pdf.pages),
                                   needs_ocr=not any(t.strip() for t in pages))
                    except Exception as exc:
                        doc['error_type'] = type(exc).__name__
                else:
                    doc['status'] = 'format non lu ou taille excessive'
                documents.append(doc)
        print('Dossier téléchargé :', path, flush=True)
        return {'status': 'téléchargé', 'file': str(path), 'documents': documents}
    except Exception as exc:
        return {'status': 'échec de récupération', 'error_type': type(exc).__name__}


def run():
    DATA.mkdir(exist_ok=True)
    config = json.loads((ROOT / 'config.json').read_text(encoding='utf-8-sig'))
    prices = Prices(DATA / 'prix.sqlite')
    prices.import_csv(ROOT / 'prix_confirmes.csv')
    ledger = sqlite3.connect(DATA / 'suivi.sqlite')
    ledger.execute('CREATE TABLE IF NOT EXISTS drafts (bc_id TEXT PRIMARY KEY, saved_at TEXT, quote TEXT, evidence TEXT)')
    workflow = Workflow(DATA / 'workflow.sqlite')
    try:
        mail_status = receive_supplier_prices(prices, workflow, DATA)
    except Exception as exc:
        mail_status = {'status': 'liaison Gmail bloquée', 'error_type': type(exc).__name__}
    print('Gmail :', mail_status['status'], flush=True)
    print('Agent BC — contrôle de session BC, pilote 0.5.0-cloud', flush=True)
    report = {'started_at': datetime.now().isoformat(), 'version': '0.5.0-cloud-pilote',
              'signed_or_submitted': False, 'results': [], 'status': 'en cours', 'gmail': mail_status,
              'limitations': ['Découverte limitée aux pages parcourues et références initiales.',
                 'Recherche Web ouverte et lecteurs vendeurs ; reconnaissance automatique stricte et partielle. Transfert Gmail signé disponible, mais connexion IMAP Windows requise une fois.',
                 'Demandes et analyse des devis assurées par le suivi Gmail distant ; suivi des attributaires non implémenté.']}
    from playwright.sync_api import sync_playwright
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True, chromium_sandbox=sys.platform != 'win32')
            context = browser.new_context(locale='fr-FR')
            page = context.new_page()
            page.set_default_timeout(15000)
            login(page, config)
            report['classic_login'] = 'confirmée'
            page = open_bdc(page)
            report['bdc_login'] = 'confirmée'
            report['login'] = 'confirmée'
            sources = PublicSources(browser)
            urls = sorted(set(discover(page, config)) | {bc['url'] for bc in workflow.pending()} | {ORIGIN + '/bdc/entreprise/consultation/show/382678'})
            report['consultations_seen'] = len(urls)
            print(len(urls), 'consultations à vérifier.', flush=True)
            for index, url in enumerate(urls, 1):
                print('Consultation', index, '/', len(urls), ':', url.rsplit('/', 1)[-1], flush=True)
                try:
                    if url.rsplit('/', 1)[-1] == '387737' or url.rsplit('/', 1)[-1] in config.get('skip_bc_ids', []):
                        report['results'].append({'url': url, 'status': 'BC écarté : désignation ou conditionnement ambigu'})
                        continue
                    bc = read_bc(page, url, config)
                    if not bc['eligible']:
                        report['results'].append({'url': url, 'status': 'écarté ou échéance/zone non confirmée'})
                        continue
                    workflow.record({k: v for k, v in bc.items() if k != 'text'}, prices.quote(bc['articles']), 'recherche des prix')
                    print('  Recherche des prix publics...', flush=True)
                    public = sources.quote(bc['articles']) if not bc['extraction_errors'] else []
                    prices.record_public(public)
                    quote = prices.quote(bc['articles'], public)
                    if bc['extraction_errors']:
                        quote['complete'] = False
                        for key in ('sale_ht', 'sale_vat', 'sale_ttc', 'purchase_ttc'):
                            quote.pop(key, None)
                    policy = filling_policy(bc, quote)
                    quote['allow_partial'] = policy == 'partiel à H-24'
                    if policy in ('complet', 'partiel à H-24') and os.environ.get('BC_ALLOW_DRAFT_WRITES', '0') != '1':
                        status = 'lecture seule : prix disponibles, sauvegarde désactivée'
                    elif policy in ('complet', 'partiel à H-24'):
                        status = save_draft(page, bc, quote, config.get('draft_adapter'), ledger)
                    else:
                        status = policy
                    workflow.record({k: v for k, v in bc.items() if k != 'text'}, quote, status)
                    if not quote['complete'] and not bc['extraction_errors']:
                        try:
                            quote['supplier_followup'] = publish_supplier_need(bc, quote, DATA)
                        except Exception as exc:
                            quote['supplier_followup'] = 'transmission non confirmée : '+type(exc).__name__
                    print('  ', len(bc['articles']), 'lignes ;', status, flush=True)
                    # Diagnostics de texte uniquement sur une page de consultation, jamais le login.
                    snapshot = DATA / (bc['id'] + '.txt')
                    snapshot.write_text(bc['text'], encoding='utf-8')
                    bc.pop('text')
                    report['results'].append({'bc': bc, 'quote': quote, 'public_search': public, 'status': status})
                except Exception as exc:
                    report['results'].append({'url': url, 'status': 'traitement interrompu',
                                              'error_type': type(exc).__name__})
            report['source_errors'] = sources.events
            sources.close()
            context.close()
            browser.close()
            report['status'] = 'terminé'
    except RuntimeError as exc:
        report['status'] = 'bloqué'
        report['reason'] = str(exc)
    except Exception as exc:
        report['status'] = 'bloqué'
        report['reason'] = 'Erreur technique : ' + type(exc).__name__
    report['finished_at'] = datetime.now().isoformat()
    report['eligible_count'] = sum('bc' in r for r in report['results'])
    report['article_count'] = sum(len(r.get('bc', {}).get('articles', [])) for r in report['results'])
    report['saved_drafts'] = sum(r.get('status') == 'brouillon enregistré et prix revérifiés' for r in report['results'])
    target = DATA / ('rapport-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f') + '.json')
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print('Rapport :', target)
    print('État :', report['status'])
    print('BC retenus :', report['eligible_count'], '| Lignes :', report['article_count'],
          '| Brouillons enregistrés :', report['saved_drafts'])
    if report.get('reason'):
        print(report['reason'])
    return 1 if report['status'] == 'bloqué' else 0


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['setup', 'run', 'import-prices', 'inspect'])
    args = parser.parse_args()
    DATA.mkdir(exist_ok=True)
    try:
        if args.action == 'setup':
            setup()
        elif args.action == 'run':
            sys.exit(run())
        elif args.action == 'inspect':
            sys.exit(inspect_form())
        else:
            print('Observations ajoutées :', Prices(DATA / 'prix.sqlite').import_csv(ROOT / 'prix_confirmes.csv'))
    except RuntimeError as exc:
        print(str(exc))
        sys.exit(1)
