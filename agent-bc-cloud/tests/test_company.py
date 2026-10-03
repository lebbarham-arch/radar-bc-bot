import json
import tempfile
import unittest
from pathlib import Path
from company import load_profile


class CompanyTests(unittest.TestCase):
    def test_profile_preserves_leading_zero(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'profile.json'
            path.write_text(json.dumps({'bank_rib':'0'*24,'professional_tax_number':'12345678','expected_ice':'0'*15}))
            profile=load_profile(path)
            self.assertEqual(profile['bank_rib'],'0'*24)

    def test_short_rib_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            p = Path(folder) / 'profile.json'
            p.write_text(json.dumps({'bank_rib':'123'}))
            with self.assertRaises(ValueError):
                load_profile(p)


if __name__ == '__main__':
    unittest.main()
