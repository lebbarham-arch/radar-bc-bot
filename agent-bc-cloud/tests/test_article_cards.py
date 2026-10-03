import unittest
from playwright.sync_api import sync_playwright
from agent import collect_article_cards
from portal_form import collect_readonly_rows, parse_rows


def card(n, name='BANANE', qty='420', unit='kg'):
    return f'''<h2 id="article-{n}-heading"><button aria-controls="article-{n}-panel"><span>#{n:02}</span>{name}</button></h2>
    <div id="article-{n}-panel" style="display:none"><div>Caractéristiques et spécifications <span class="text-black">{name}</span></div>
    <div><span>Unité de mesure</span><div>{unit}</div></div><div><span>Quantité</span><div>{qty}</div></div>
    <div><span>TVA (%)</span><div>0</div></div></div>'''

class ArticleCardsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True, chromium_sandbox=False)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def read(self, html):
        page = self.browser.new_page()
        try:
            page.set_content(html)
            return collect_article_cards(page)
        finally:
            page.close()

    def test_all_25_collapsed_panels_are_read_without_animation(self):
        rows, errors, expected = self.read(''.join(card(i) for i in range(1, 26)))
        self.assertEqual((len(rows), errors, expected), (25, [], 25))
        self.assertEqual(rows[0]['quantity'], '420')

    def test_readonly_quote_is_read_but_never_accepted_as_editable(self):
        page = self.browser.new_page()
        try:
            page.set_content('<table><tr><td>01</td><td>BANANE\nCaractéristiques et spécifications :\nBANANE</td><td>kg</td><td>420</td><td>15,87</td><td>0</td><td>0</td><td>6665,40</td></tr></table>')
            rows=collect_readonly_rows(page)
            self.assertEqual(len(rows),1)
            self.assertEqual(parse_rows(rows,allow_readonly=True)[0]['quantity'],'420')
            with self.assertRaises(RuntimeError):parse_rows(rows)
        finally:page.close()

    def test_units_and_multiline_specs_preserved(self):
        rows, errors, _ = self.read(card(1, 'PERSIL\nFRAIS', '120', 'botte'))
        self.assertEqual(errors, [])
        self.assertEqual(rows[0]['unit'], 'botte')
        self.assertEqual(rows[0]['specification'], 'PERSIL\nFRAIS')

    def test_missing_panel_or_ambiguous_field_blocks_extraction(self):
        for html in [card(1).replace('id="article-1-panel"', 'id="other"'),
                     card(1).replace('</div></div></div>', '</div></div><div><span>Quantité</span><div>1</div></div></div>'),
                     card(2), card(1, qty='0')]:
            rows, errors, _ = self.read(html)
            self.assertEqual(rows, [])
            self.assertEqual(len(errors), 1)
