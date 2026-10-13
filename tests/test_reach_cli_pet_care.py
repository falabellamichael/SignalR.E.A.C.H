"""Deterministic attention, refusal, and forgiveness without sleeping or I/O."""
import unittest
from types import SimpleNamespace

from tools.reach_cli.pet_care import (
    ATTENTION_REMINDER_SECONDS, NEGLECT_SECONDS, FORGIVENESS_TREATS,
    parse_care_command,
)
from tools.reach_cli.pets import PET_NAMES, TerminalPet, get_client_pet, pet_status


class PetCareTests(unittest.TestCase):
    def setUp(self):
        self.now = 0.0
        self.pet = TerminalPet(clock=lambda: self.now)

    def test_warns_before_anger_at_exact_attention_boundaries(self):
        self.now = ATTENTION_REMINDER_SECONDS - 0.01
        self.assertEqual(self.pet.snapshot()["mood"], "content")
        self.now += 0.01
        self.assertEqual(self.pet.snapshot()["mood"], "lonely")
        self.assertIn("/feed /pat", self.pet.snapshot()["status"])
        self.now = NEGLECT_SECONDS - 0.01
        self.assertEqual(self.pet.snapshot()["mood"], "lonely")
        self.now += 0.01
        self.assertEqual(self.pet.snapshot()["mood"], "angry")
        self.assertEqual(self.pet.snapshot()["treats_remaining"], FORGIVENESS_TREATS)
        self.assertEqual(self.pet.snapshot()["behavior"], "sulking")
        self.assertIn("/treat x3", self.pet.snapshot()["status"])

    def test_any_accepted_attention_prevents_neglect_and_resets_reminder(self):
        for action in ("feed", "pet", "treat"):
            with self.subTest(action=action):
                self.now = 0.0
                pet = TerminalPet(clock=lambda: self.now)
                self.now = NEGLECT_SECONDS - 1
                result = pet.care(action)
                self.assertTrue(result["accepted"])
                self.assertEqual(result["mood"], "content")
                self.now += ATTENTION_REMINDER_SECONDS - 1
                self.assertEqual(pet.snapshot()["mood"], "content")
                self.now += 1
                self.assertEqual(pet.snapshot()["mood"], "lonely")

    def test_late_food_and_pats_are_rejected_even_without_an_intervening_paint(self):
        self.now = NEGLECT_SECONDS
        for action in ("feed", "pet", "feed"):
            result = self.pet.care(action)
            self.assertFalse(result["accepted"])
            self.assertEqual(result["mood"], "angry")
            self.assertEqual(result["treats_remaining"], 3)
            self.assertEqual(self.pet.snapshot()["behavior"], "refusing")
            self.assertIn("/treat x3", result["message"])
            self.now += 100
        self.assertEqual(self.pet.snapshot()["behavior"], "sulking")

    def test_only_three_treats_forgive_and_food_then_works_again(self):
        self.now = NEGLECT_SECONDS
        for remaining in (2, 1):
            result = self.pet.care("treat")
            self.assertTrue(result["accepted"])
            self.assertEqual(result["mood"], "angry")
            self.assertEqual(result["treats_remaining"], remaining)
            self.assertEqual(self.pet.snapshot()["behavior"], "treating")
            self.assertFalse(self.pet.care("feed")["accepted"])
            self.assertFalse(self.pet.care("pet")["accepted"])
            self.now += NEGLECT_SECONDS * 2
            self.assertEqual(self.pet.snapshot()["treats_remaining"], remaining)
        result = self.pet.care("treat")
        self.assertTrue(result["accepted"])
        self.assertEqual(result["mood"], "content")
        self.assertEqual(result["treats_remaining"], 0)
        self.assertEqual(result["message"], "I forgive you!")
        self.assertEqual(self.pet.snapshot()["behavior"], "forgiving")
        self.now += 4
        self.assertEqual(self.pet.snapshot()["status"], "I'm ready")
        self.assertTrue(self.pet.care("feed")["accepted"])
        self.assertTrue(self.pet.care("pet")["accepted"])
        self.now += NEGLECT_SECONDS
        self.assertEqual(self.pet.snapshot()["mood"], "angry")
        self.assertEqual(self.pet.snapshot()["treats_remaining"], 3)

    def test_switching_keeps_each_visited_companions_care_and_forgiveness(self):
        self.now = NEGLECT_SECONDS
        self.pet.care("treat")
        self.pet.select("owl")
        self.assertEqual(self.pet.snapshot()["mood"], "content")
        self.pet.care("pet")
        self.pet.select("bulldog")
        self.assertEqual(self.pet.snapshot()["mood"], "content")
        self.pet.select("cat")
        self.assertEqual(self.pet.snapshot()["mood"], "angry")
        self.assertEqual(self.pet.snapshot()["treats_remaining"], 2)
        self.assertFalse(self.pet.care("feed")["accepted"])
        self.assertFalse(self.pet.select("dragon"))
        self.assertEqual(self.pet.snapshot()["kind"], "cat")

    def test_fresh_session_has_no_offline_neglect(self):
        self.now = 24 * 60 * 60
        self.assertEqual(self.pet.snapshot()["mood"], "angry")
        fresh = TerminalPet(clock=lambda: self.now)
        self.assertEqual(fresh.snapshot()["mood"], "content")
        self.assertEqual(fresh.snapshot()["treats_remaining"], 0)

    def test_idle_snacks_typing_and_ai_responses_do_not_count_as_care(self):
        self.pet.set_activity("waiting")
        self.now = 5
        self.assertEqual(self.pet.snapshot()["behavior"], "snacking")
        self.now = NEGLECT_SECONDS - 1
        self.pet.set_activity("responding")
        self.pet.note_input("private draft does not feed the pet")
        self.pet.set_activity("complete")
        self.now += 1
        state = self.pet.snapshot()
        self.assertEqual(state["mood"], "angry")
        self.assertEqual(state["activity"], "complete")
        self.assertEqual(state["behavior"], "celebrating")
        self.assertIn("I'm done!", state["status"])

    def test_angry_pet_does_not_resume_autonomous_waiting_snacks(self):
        self.now = NEGLECT_SECONDS
        self.pet.set_activity("waiting")
        self.now += 5
        state = self.pet.snapshot()
        self.assertEqual(state["activity"], "waiting")
        self.assertEqual(state["behavior"], "sulking")
        self.assertIn("I'm working on it", state["status"])

    def test_care_animation_resumes_current_response_phase_without_restarting_it(self):
        self.pet.set_activity("responding")
        self.now = 2
        self.pet.care("pet")
        state = self.pet.snapshot()
        self.assertEqual(state["behavior"], "petting")
        self.assertEqual(state["activity"], "responding")
        self.assertIn("I'm answering...", state["status"])
        self.pet.set_activity("reading")
        self.now += 3.2
        state = self.pet.snapshot()
        self.assertEqual(state["activity"], "reading")
        self.assertEqual(state["behavior"], "reading")
        self.assertEqual(state["frame"], 4)
        self.assertEqual(state["status"], "I'm reading...")

    def test_feeding_visits_bowl_chews_and_returns_then_expires(self):
        for kind in PET_NAMES:
            with self.subTest(kind=kind):
                self.now = 0
                pet = TerminalPet(kind, clock=lambda: self.now)
                pet.care("feed")
                for when, behavior, food in (
                        (0, "walking_to_bowl", 3), (1.6, "snacking", 3),
                        (2.6, "snacking", 2), (3.6, "snacking", 1),
                        (4.8, "walking_back", 3)):
                    self.now = when
                    state = pet.snapshot()
                    self.assertEqual(state["behavior"], behavior)
                    self.assertEqual(state["food"], food)
                    self.assertEqual(state["activity"], "idle")
                self.now = 6.4
                self.assertEqual(pet.snapshot()["care_reaction"], "")

    def test_new_completion_or_stop_overrides_old_care_but_allows_fresh_attention(self):
        for activity, pose in (("complete", "celebrating"), ("error", "settling"),
                               ("cancelled", "resting"), ("blocked", "resting")):
            with self.subTest(activity=activity):
                self.now = 0
                pet = TerminalPet(clock=lambda: self.now)
                pet.set_activity("responding")
                pet.care("feed")
                self.now = 1
                pet.set_activity(activity)
                self.assertEqual(pet.snapshot()["behavior"], pose)
                self.assertEqual(pet.snapshot()["care_reaction"], "")
                self.now += 0.32
                self.assertEqual(pet.snapshot()["behavior"], pose)
                pet.care("pet")
                self.assertEqual(pet.snapshot()["behavior"], "petting")
                self.assertEqual(pet.snapshot()["activity"], activity)

    def test_motion_pause_does_not_disable_care_or_freeze_attention_status(self):
        self.pet.set_motion(False)
        normal = self.pet.render(22)
        self.pet.care("pet")
        self.now += 0.32
        self.assertEqual(self.pet.render(22), normal)
        self.now = NEGLECT_SECONDS
        self.assertEqual(self.pet.snapshot()["mood"], "angry")
        angry = self.pet.render(22)
        self.assertNotEqual(angry, normal)
        self.now += 0.32
        self.assertEqual(self.pet.render(22), angry)
        self.assertFalse(self.pet.care("feed")["accepted"])
        for _ in range(3):
            self.pet.care("treat")
        self.assertEqual(self.pet.render(22), normal)
        self.assertEqual(self.pet.snapshot()["status"], "I forgive you!")

    def test_unknown_care_is_rejected_without_mutating_pet(self):
        before = self.pet.snapshot()
        with self.assertRaises(ValueError):
            self.pet.care("launch missile")
        self.assertEqual(self.pet.snapshot(), before)

    def test_raw_snapshot_text_never_enters_care_status(self):
        state = {"activity": "reading", "mood": "angry", "kind": "cat",
                 "care_reaction": "private secret", "status": "private secret",
                 "care_status": "private secret", "treats_remaining": "bad"}
        self.assertEqual(pet_status(state), "I'm reading... · I'm angry · /treat x3")

    def test_client_reuses_pet_between_plain_commands_and_managed_header(self):
        client = SimpleNamespace(pet="cat", pet_motion=True, _terminal_pet=self.pet)
        self.now = NEGLECT_SECONDS
        get_client_pet(client).care("treat")
        self.assertIs(get_client_pet(client), self.pet)
        self.assertEqual(get_client_pet(client).snapshot()["treats_remaining"], 2)
        client.pet = "owl"
        self.assertEqual(get_client_pet(client).snapshot()["kind"], "owl")
        client.pet = "cat"
        client.pet_motion = False
        state = get_client_pet(client).snapshot()
        self.assertEqual(state["treats_remaining"], 2)
        self.assertFalse(state["motion"])

    def test_care_command_parser_accepts_only_complete_local_commands(self):
        for command, action in ((" /FEED ", "feed"), ("/pat", "pet"),
                                ("/treat", "treat"), ("/pet feed", "feed"),
                                ("/pet pet", "pet"), ("/pet treat", "treat")):
            self.assertEqual(parse_care_command(command), action)
        for text in ("/pet", "/pet cat", "/pet status", "please /feed",
                     "/feed cat", "/treats", "/pet treat now", "/feed\nquestion"):
            self.assertIsNone(parse_care_command(text), text)

    def test_ascii_care_frames_stay_inside_header_at_every_supported_size(self):
        for kind in PET_NAMES:
            for behavior in ("petting", "treating", "forgiving", "sulking", "refusing"):
                from tools.reach_cli.pets import render_pet
                for width in (0, 1, 5, 7, 12, 13, 18, 22, 80):
                    for height in (0, 1, 2, 3, 5):
                        rows = render_pet({"kind": kind, "behavior": behavior,
                                           "frame": 3}, width, height)
                        self.assertEqual(len(rows), height)
                        self.assertTrue(all(len(row) == width for row in rows))
                        self.assertTrue(all(all(32 <= ord(c) < 127 for c in row) for row in rows))


if __name__ == "__main__":
    unittest.main()
