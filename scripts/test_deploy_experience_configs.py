import math
import unittest

from scripts.deploy_experience_configs import roblox_json_equal


class RobloxJsonEqualTests(unittest.TestCase):
    def test_large_integer_matches_same_roblox_number(self):
        value = 1_300_000_000_000_000_000_000_000_000_000
        self.assertTrue(roblox_json_equal(value, float(value)))

    def test_nested_config_uses_number_semantics(self):
        expected = {
            "rooms": [
                {"index": 46, "blockMaxHP": 1_300_000_000_000_000_000_000_000_000_000},
            ],
        }
        actual = {
            "rooms": [
                {"index": 46.0, "blockMaxHP": float(expected["rooms"][0]["blockMaxHP"])},
            ],
        }
        self.assertTrue(roblox_json_equal(expected, actual))

    def test_detects_different_roblox_number(self):
        value = 1_300_000_000_000_000_000_000_000_000_000
        self.assertFalse(
            roblox_json_equal(
                value,
                math.nextafter(float(value), math.inf),
            )
        )

    def test_boolean_is_not_number(self):
        self.assertFalse(roblox_json_equal(True, 1))


if __name__ == "__main__":
    unittest.main()
