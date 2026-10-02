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


def fill_company(page, profile, selectors):
    def field(key):
        loc = page.locator(selectors[key])
        if loc.count() != 1 or not loc.is_visible():
            raise RuntimeError('Champ entreprise absent ou ambigu : ' + key)
        return loc
    if field('ice_selector').input_value().strip() != profile['expected_ice']:
        raise RuntimeError('ICE différent : profil entreprise non appliqué')
    rib = field('rib_selector')
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
            # La liste reste dans le DOM ; la saisie libre peut avoir un autre ID.
            marked = rib.evaluate('''select => {
                const visible = e => e.getClientRects().length && !e.disabled;
                let parent = select.parentElement;
                for (let depth=0; parent && depth<3; depth++,parent=parent.parentElement) {
                    const candidates = [...parent.querySelectorAll('input,textarea')]
                        .filter(e=>visible(e) && ['text','tel',''].includes(e.type || '') &&
                            !/adresseEntreprise|telephoneEntreprise|emailEntreprise|numeroTaxeEntreprise|iceEntreprise|cnssEntreprise/.test(e.id));
                    if (candidates.length === 1) {
                        candidates[0].setAttribute('data-agent-bc-rib','true'); return true;
                    }
                    if (candidates.length > 1) return false;
                }
                return false;
            }''')
            if not marked:
                raise RuntimeError('Champ de saisie libre RIB absent ou ambigu après activation')
            rib = page.locator('[data-agent-bc-rib="true"]')
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
