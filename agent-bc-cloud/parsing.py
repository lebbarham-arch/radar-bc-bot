"""Extraction des blocs affichés : aucune spécification multilignes tronquée."""
import re
import unicodedata


def norm(value):
    return ''.join(c for c in unicodedata.normalize('NFKD', value)
                   if not unicodedata.combining(c)).casefold()


LABELS = ('Caractéristiques et spécifications', 'Unité de mesure',
          'Quantité', 'TVA (%)', 'Garanties exigées')


def sections(segment):
    result = {}
    current = None
    header = []
    known = {norm(x): x for x in LABELS}
    for raw in segment.splitlines():
        line = raw.strip()
        key = known.get(norm(line))
        if key:
            current = key
            result.setdefault(current, [])
        elif current:
            result[current].append(raw.rstrip())
        elif line:
            header.append(line)
    return '\n'.join(header).strip(), {k: '\n'.join(v).strip() for k, v in result.items()}


def extract_articles(text):
    # Les en-têtes d'articles du portail commencent par # suivi d'un numéro.
    # #07/2026 désigne un avis, pas une ligne d'article #07 suivie d'un espace.
    blocks = re.split(r'(?m)^[ \t]*#[ \t]*\d+(?=\s|$)[ \t]*', text)[1:]
    articles, errors = [], []
    for index, block in enumerate(blocks, 1):
        designation, values = sections(block.lstrip())
        required = LABELS[:4]
        missing = [k for k in required if not values.get(k)]
        if not designation:
            missing.append('Désignation')
        if missing:
            errors.append({'article_index': index, 'missing': missing})
            continue
        # Unité, quantité et TVA sont scalaires : une continuation inattendue bloque.
        scalar_labels = LABELS[1:4]
        if any('\n' in values[k] for k in scalar_labels):
            errors.append({'article_index': index, 'reason': 'champ scalaire multilignes'})
            continue
        articles.append({'designation': designation,
                         'specification': values[LABELS[0]],
                         'unit': values[LABELS[1]], 'quantity': values[LABELS[2]],
                         'vat': values[LABELS[3]]})
    if not blocks:
        errors.append({'reason': 'aucun en-tête article reconnu'})
    return articles, errors
