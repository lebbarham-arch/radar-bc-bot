"""Profil affecté au compte du portail, distinct de la signature fournisseurs FIMARO."""
import json
import re

PORTAL_SELECTORS = {
    'ice_selector': '#entreprise_infos_devis_form_iceEntreprise',
    'rib_selector': '#entreprise_infos_devis_form_compteBancaire',
    'tax_selector': '#entreprise_infos_devis_form_numeroTaxeEntreprise',
    'rib_toggle_selector': '#esl-a',
}

def load_profile(path):
    profile = json.loads(path.read_text(encoding='utf-8-sig'))
    rib = profile.get('bank_rib', '')
    if not re.fullmatch(r'\d{24}', rib):
        raise ValueError('RIB incomplet : 24 chiffres attendus')
    if not re.fullmatch(r'\d+', profile.get('professional_tax_number', '')):
        raise ValueError('Taxe professionnelle absente')
    if not re.fullmatch(r'\d{15}', profile.get('expected_ice', '')):
        raise ValueError('ICE attendu absent')
    return profile


def resolve_rib(page, selector):
    """Recognize both rendered modes; never infer a RIB from another field."""
    configured = page.locator(selector)
    if configured.count() == 1 and configured.is_visible() and configured.is_enabled():
        return configured
    # A saved draft can reopen directly in free-entry mode with the select hidden.
    # Strong names/labels first, then a narrowly scoped sibling of the configured field.
    selected = page.evaluate(r'''selector => {
        document.querySelectorAll('[data-agent-bc-rib]').forEach(e => e.removeAttribute('data-agent-bc-rib'));
        const visible = e => e.getClientRects().length && !e.disabled &&
            ['text','tel',''].includes(e.type || '');
        const normalized = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        const matches = [...document.querySelectorAll('input,textarea')].filter(e => {
            const label = [...(e.labels || [])].map(x => x.innerText).join(' ');
            return visible(e) && /comptebancaire|\brib\b|compte bancaire|releve.{0,12}identite bancaire/.test(
                normalized(e.id + ' ' + e.name + ' ' + label));
        });
        let candidates = matches;
        if (!candidates.length) {
            const anchor = document.querySelectorAll(selector);
            if (anchor.length !== 1) return false;
            let parent = anchor[0].parentElement;
            for (let depth=0; parent && depth<3; depth++,parent=parent.parentElement) {
                const found = [...parent.querySelectorAll('input,textarea')].filter(e => visible(e) &&
                    !/adresseEntreprise|telephoneEntreprise|emailEntreprise|numeroTaxeEntreprise|iceEntreprise|cnssEntreprise/.test(e.id));
                if (found.length) { candidates = found; break; }
            }
        }
        if (candidates.length !== 1) return false;
        candidates[0].setAttribute('data-agent-bc-rib', 'true');
        return true;
    }''', selector)
    if selected:
        return page.locator('[data-agent-bc-rib="true"]')
    controls = page.locator('input,select,textarea').evaluate_all(
        "els => els.filter(e => /compte|rib|bancaire/i.test(e.id+' '+e.name)).map(e => ({id:e.id,tag:e.tagName,type:e.type,visible:!!e.getClientRects().length,disabled:!!e.disabled}))")
    print('RIB_CONTROLS', json.dumps(controls, ensure_ascii=False), flush=True)
    raise RuntimeError('Champ RIB absent ou ambigu dans les deux modes')


def fill_company(page, profile, selectors):
    def field(key):
        loc = page.locator(selectors[key])
        if loc.count() != 1 or not loc.is_visible():
            raise RuntimeError('Champ entreprise absent ou ambigu : ' + key)
        return loc
    if field('ice_selector').input_value().strip() != profile['expected_ice']:
        raise RuntimeError('ICE différent : profil entreprise non appliqué')
    rib = resolve_rib(page, selectors['rib_selector'])
    if rib.evaluate('e => e.tagName.toLowerCase()') == 'select':
        matching = rib.locator('option').evaluate_all(
            '(els, rib) => els.filter(e => e.value === rib).length', profile['bank_rib'])
        if matching == 1:
            rib.select_option(value=profile['bank_rib'])
        else:
            toggle = page.locator(selectors.get('rib_toggle_selector', '#esl-a'))
            if toggle.count() != 1 or not toggle.is_visible() or toggle.inner_text().strip() != 'Activer la saisie libre':
                raise RuntimeError('Activation de la saisie libre RIB absente ou ambiguë')
            toggle.click()
            rib = resolve_rib(page, selectors['rib_selector'])
            if rib.evaluate('e => e.tagName.toLowerCase()') == 'select':
                raise RuntimeError('Saisie libre RIB non activée')
    for key, value in [('rib_selector', profile['bank_rib']),
                       ('tax_selector', profile['professional_tax_number'])]:
        loc = rib if key == 'rib_selector' else field(key)
        if not loc.is_enabled():
            raise RuntimeError('Champ entreprise non modifiable : ' + key)
        if loc.evaluate('e => e.tagName.toLowerCase()') == 'select':
            loc.select_option(value=value)
        else:
            loc.fill(value)
        if loc.input_value().strip() != value:
            raise RuntimeError('Valeur entreprise non confirmée : ' + key)
