"""Behavioral checks for the CLI header's clock-driven ASCII companions."""
import unittest

from tools.reach_cli.pets import PET_NAMES, TerminalPet, normalize_pet, render_pet


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class TerminalPetTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.pet = TerminalPet(clock=self.clock)

    def test_species_are_distinct_and_selection_is_validated(self):
        self.assertEqual(PET_NAMES, ("cat", "owl", "bulldog"))
        self.assertEqual(normalize_pet(" Micro Bulldog "), "bulldog")
        self.assertEqual(normalize_pet("dog"), "bulldog")
        self.assertIsNone(normalize_pet("dinosaur"))
        sprites = set()
        for kind in PET_NAMES:
            self.assertTrue(self.pet.select(kind))
            self.assertEqual(self.pet.snapshot()["kind"], kind)
            sprites.add(tuple(self.pet.render(22)))
        self.assertEqual(len(sprites), 3)
        self.assertFalse(self.pet.select("dinosaur"))
        self.assertEqual(self.pet.snapshot()["kind"], "bulldog")

    def test_typing_expires_and_same_length_edits_refresh_it(self):
        private_draft = "not retained anywhere"
        self.pet.note_input(private_draft)
        self.assertEqual(self.pet.snapshot()["activity"], "typing")
        self.assertIn("[====]", "".join(self.pet.render(22)))
        self.clock.advance(1.0)
        self.pet.note_input("x" * len(private_draft))
        self.clock.advance(1.0)
        self.assertEqual(self.pet.snapshot()["activity"], "typing")
        self.clock.advance(0.21)
        self.assertEqual(self.pet.snapshot()["activity"], "idle")
        self.assertNotIn("draft", self.pet.snapshot())
        self.assertNotIn(private_draft, repr(vars(self.pet)))
        self.assertEqual(self.pet._draft_length, len(private_draft))

    def test_completion_survives_input_clear_then_expires(self):
        self.pet.set_activity("complete")
        self.pet.note_input("")
        self.assertEqual(self.pet.snapshot()["behavior"], "celebrating")
        self.clock.advance(0.32)
        self.assertIn("^", "".join(self.pet.render(22)))
        self.clock.advance(2.8)
        self.assertEqual(self.pet.snapshot()["activity"], "complete")
        self.clock.advance(0.09)
        self.assertEqual(self.pet.snapshot()["activity"], "idle")

    def test_frequent_typing_extends_expiry_without_resetting_paw_animation(self):
        for kind in PET_NAMES:
            with self.subTest(kind=kind):
                clock = FakeClock()
                pet = TerminalPet(kind, clock=clock)
                frames = set()
                for keystroke in range(20):
                    pet.note_input("x" * (keystroke + 1))
                    frames.add(tuple(pet.render(22)))
                    self.assertEqual(pet.snapshot()["activity"], "typing")
                    clock.advance(0.1)
                self.assertGreaterEqual(len(frames), 4)
                # The last input was at 1.9s; animation continues for its TTL.
                clock.advance(0.9)
                self.assertEqual(pet.snapshot()["activity"], "typing")
                clock.advance(0.21)
                self.assertEqual(pet.snapshot()["activity"], "idle")
                pet.note_input("new draft")
                self.assertEqual(pet.snapshot()["activity"], "typing")
                self.assertEqual(pet.snapshot()["frame"], 0)

    def test_repeated_typing_activity_keeps_phase_and_restarts_after_expiry(self):
        self.pet.set_activity("typing")
        self.clock.advance(0.32)
        self.pet.set_activity("typing")
        self.assertEqual(self.pet.snapshot()["frame"], 2)
        self.clock.advance(1.0)
        self.assertEqual(self.pet.snapshot()["activity"], "typing")
        self.clock.advance(0.21)
        self.assertEqual(self.pet.snapshot()["activity"], "idle")
        self.pet.set_activity("typing")
        self.assertEqual(self.pet.snapshot()["frame"], 0)

    def test_new_completion_after_expiry_starts_another_celebration(self):
        self.pet.set_activity("complete")
        self.clock.advance(3.3)
        self.assertEqual(self.pet.snapshot()["activity"], "idle")
        self.pet.set_activity("complete")
        self.assertEqual(self.pet.snapshot()["behavior"], "celebrating")
        self.assertEqual(self.pet.snapshot()["frame"], 0)

    def test_waiting_walks_to_bowl_eats_and_walks_back_for_each_species(self):
        for kind in PET_NAMES:
            with self.subTest(kind=kind):
                clock = FakeClock()
                pet = TerminalPet(kind, clock=clock)
                pet.set_activity("waiting")
                observations = []
                for when in (0.0, 1.0, 3.0, 5.0, 7.0, 8.0, 10.0, 12.0, 14.0):
                    clock.now = when
                    state = pet.snapshot()
                    observations.append(state)
                    rows = pet.render(28)
                    self.assertIn(rows[2][-5:], ("[:::]", "[ : ]", "[ . ]"))
                    self.assertEqual(rows[2][-6], " ")
                self.assertEqual(observations[0]["position"], 0.0)
                self.assertLess(observations[1]["position"], observations[2]["position"])
                self.assertEqual(observations[3]["behavior"], "snacking")
                self.assertEqual(observations[3]["food"], 3)
                self.assertEqual(observations[4]["food"], 1)
                self.assertEqual(observations[4]["position"], 1.0)
                self.assertGreater(observations[5]["position"], observations[6]["position"])
                self.assertEqual(observations[6]["direction"], -1)
                self.assertEqual(observations[7]["position"], 0.0)
                self.assertEqual(observations[8]["behavior"], "curious")
                self.assertEqual(observations[8]["food"], 3)

    def test_snack_bowl_depletes_then_refills_in_the_same_place(self):
        self.pet.set_activity("waiting")
        bowls = []
        for when in (5.0, 6.0, 7.0, 8.0):
            self.clock.now = when
            row = self.pet.render(22)[2]
            self.assertEqual(row[-6], " ")
            bowls.append(row[-5:])
        self.assertEqual(bowls, ["[:::]", "[ : ]", "[ . ]", "[:::]"])

    def test_compact_pets_close_eyes_and_tap_keyboard(self):
        for kind in PET_NAMES:
            pet = TerminalPet(kind, clock=self.clock)
            pet.set_activity("error")
            self.assertIn("-", pet.render(12)[1])
            self.assertNotIn("o", pet.render(12)[1])
            pet.set_activity("typing")
            before = pet.render(12)[2]
            self.clock.advance(0.16)
            after = pet.render(12)[2]
            self.assertIn("[==]", before)
            self.assertIn("[==]", after)
            self.assertNotEqual(before, after)

    def test_repeated_waiting_updates_do_not_restart_walk(self):
        self.pet.set_activity("waiting")
        self.clock.advance(6.0)
        self.pet.set_activity("waiting")
        self.pet.note_input("")
        self.assertEqual(self.pet.snapshot()["behavior"], "snacking")

    def test_idle_has_grooming_stretch_sleep_and_stroll(self):
        expected = ((0, "looking"), (4, "grooming"), (7, "stretching"),
                    (9, "sleeping"), (13, "curious"), (17, "strolling"))
        for when, behavior in expected:
            self.clock.now = when
            self.assertEqual(self.pet.snapshot()["behavior"], behavior)

    def test_error_and_cancel_do_not_celebrate(self):
        for activity in ("error", "cancelled"):
            pet = TerminalPet(clock=self.clock)
            pet.set_activity("complete")
            pet.set_activity(activity)
            self.assertEqual(pet.snapshot()["activity"], activity)
            self.assertNotEqual(pet.snapshot()["behavior"], "celebrating")
            self.assertNotIn("*", "".join(pet.render(22)))
            self.clock.advance(2.41)
            self.assertEqual(pet.snapshot()["activity"], "idle")

    def test_motion_off_is_visually_fixed_across_states_and_time(self):
        for kind in PET_NAMES:
            pet = TerminalPet(kind, clock=self.clock, motion=False)
            original = pet.render(22)
            for activity in ("typing", "waiting", "responding", "complete", "error"):
                pet.set_activity(activity)
                self.clock.advance(0.48)
                self.assertEqual(pet.render(22), original)
                self.assertFalse(pet.snapshot()["motion"])
            pet.set_motion(True)
            pet.set_activity("waiting")
            self.clock.advance(6)
            self.assertNotEqual(pet.render(22), original)

    def test_frames_change_while_typing_and_responding(self):
        for activity in ("typing", "responding", "complete"):
            pet = TerminalPet(clock=self.clock)
            pet.set_activity(activity)
            first = pet.render(22)
            self.clock.advance(0.32)
            self.assertNotEqual(pet.render(22), first)

    def test_ai_status_and_pose_follow_activity_without_retaining_draft(self):
        expected = {
            "thinking": ("pondering", "I'm thinking..."),
            "responding": ("speaking", "I'm answering..."),
            "searching": ("searching", "I'm searching..."),
            "reading": ("reading", "I'm reading..."),
            "writing": ("working", "I'm editing files..."),
            "running": ("working", "I'm running a command..."),
            "checking": ("working", "I'm checking..."),
        }
        for activity, (behavior, status) in expected.items():
            with self.subTest(activity=activity):
                self.pet.set_activity(activity)
                self.clock.advance(0.32)
                self.pet.note_input("private follow-up draft")
                state = self.pet.snapshot()
                self.assertEqual(state["activity"], activity)
                self.assertEqual(state["behavior"], behavior)
                self.assertEqual(state["status"], status)
                self.assertEqual(state["frame"], 2)
                self.assertNotIn("private follow-up draft", repr(vars(self.pet)))

    def test_paused_pet_keeps_status_live_and_resumes_current_ai_activity(self):
        self.pet.set_motion(False)
        still = self.pet.render(22)
        for activity in ("thinking", "responding", "searching", "reading",
                         "writing", "running", "checking", "blocked"):
            self.pet.set_activity(activity)
            self.clock.advance(0.32)
            self.assertEqual(self.pet.render(22), still)
            self.assertEqual(self.pet.snapshot()["activity"], activity)
        self.assertEqual(self.pet.snapshot()["status"], "I need your help")
        self.clock.advance(60)
        self.assertEqual(self.pet.snapshot()["activity"], "blocked")
        self.pet.set_activity("responding")
        self.pet.set_motion(True)
        self.assertEqual(self.pet.snapshot()["behavior"], "speaking")
        self.assertNotEqual(self.pet.render(22), still)

    def test_all_rows_are_exact_ascii_width_after_resize(self):
        for kind in PET_NAMES:
            for activity in ("idle", "typing", "waiting", "thinking", "responding",
                             "searching", "reading", "writing", "running", "checking",
                             "blocked", "complete", "error", "cancelled"):
                pet = TerminalPet(kind, clock=self.clock)
                pet.set_activity(activity)
                self.clock.advance(0.8)
                for width in (0, 1, 2, 5, 7, 12, 13, 16, 17, 18, 22, 60, 120):
                    for height in (0, 1, 2, 3, 5):
                        with self.subTest(kind=kind, activity=activity,
                                          width=width, height=height):
                            rows = pet.render(width, height)
                            self.assertEqual(len(rows), height)
                            self.assertTrue(all(len(row) == width for row in rows))
                            self.assertTrue(all(all(32 <= ord(c) < 127 for c in row)
                                                for row in rows))

    def test_snapshot_renderer_bounds_untrusted_numbers_and_defaults(self):
        state = {"kind": "dog", "behavior": "celebrating", "position": float("inf"),
                 "frame": "bad", "direction": float("nan")}
        self.assertTrue(all(len(row) == 22 for row in render_pet(state, 22)))
        self.assertEqual(len(render_pet(width=20)), 3)
        with self.assertRaises(ValueError):
            self.pet.set_activity("launch missile")


if __name__ == "__main__":
    unittest.main()
