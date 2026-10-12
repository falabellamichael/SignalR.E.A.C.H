"""Pixel-art details, animation, safety, and sizing for terminal companions."""
import unittest

from tools.reach_cli.hud import display_width
from tools.reach_cli.pet_pixels import render_pixel_pet
from tools.reach_cli.pets import PET_NAMES, TerminalPet


def decode(rows):
    bits = ((1, 8), (2, 16), (4, 32), (64, 128))
    pixels = [[False] * (len(rows[0]) * 2) for _ in range(len(rows) * 4)] if rows else []
    for cy, row in enumerate(rows):
        for cx, glyph in enumerate(row):
            mask = ord(glyph) - 0x2800 if glyph != " " else 0
            for y, pair in enumerate(bits):
                for x, bit in enumerate(pair):
                    pixels[cy * 4 + y][cx * 2 + x] = bool(mask & bit)
    return pixels


def snapshot(kind="cat", behavior="looking", frame=0, position=0.12, **extra):
    return dict(kind=kind, behavior=behavior, frame=frame, position=position,
                motion=True, direction=1, **extra)


class PixelPetTests(unittest.TestCase):
    def test_species_have_distinct_detailed_pixel_art(self):
        drawings = set()
        for kind in PET_NAMES:
            rows = render_pixel_pet(snapshot(kind), 22, 3)
            pixels = decode(rows)
            drawings.add(tuple(rows))
            self.assertGreater(sum(sum(row[:-10]) for row in pixels), 50)
        self.assertEqual(len(drawings), 3)

    def test_width_and_height_are_exact_terminal_cells(self):
        for kind in PET_NAMES:
            for width in (0, 1, 2, 7, 12, 13, 16, 17, 18, 22, 28, 32):
                for height in (0, 1, 2, 3, 4, 5):
                    with self.subTest(kind=kind, width=width, height=height):
                        rows = render_pixel_pet(snapshot(kind), width, height)
                        self.assertEqual(len(rows), height)
                        self.assertTrue(all(display_width(row) == width for row in rows))
                        self.assertTrue(all(len(row) == width for row in rows))
                        self.assertTrue(all(glyph == " " or 0x2801 <= ord(glyph) <= 0x28ff
                                            for row in rows for glyph in row))

    def test_typing_paws_and_keyboard_animate_for_each_species(self):
        for kind in PET_NAMES:
            with self.subTest(kind=kind):
                frames = [render_pixel_pet(snapshot(kind, "typing", frame), 22, 3)
                          for frame in range(4)]
                self.assertGreaterEqual(len(set(map(tuple, frames))), 2)
                pixels = decode(frames[0])
                # The keyboard base sits under the two moving paws.
                self.assertGreaterEqual(sum(pixels[11][:-10]), 15)

    def test_response_faces_gestures_and_speech_bubbles_animate(self):
        # Compare mouth pixels, independently of the new bubble or tail motion.
        mouths = {'cat': (8, 5, 10, 7), 'owl': (9, 4, 12, 6),
                  'bulldog': (9, 7, 11, 8)}
        for kind in PET_NAMES:
            with self.subTest(kind=kind):
                frames = [decode(render_pixel_pet(snapshot(kind, 'speaking', frame,
                                                          position=0)))
                          for frame in range(8)]
                x0, y0, x1, y1 = mouths[kind]
                # The ten-pixel animal is bottom-aligned in a 12-pixel habitat.
                mouth_frames = {tuple(tuple(row[x0:x1 + 1])
                                      for row in pixels[y0 + 2:y1 + 3])
                                for pixels in frames}
                self.assertGreaterEqual(len(mouth_frames), 2)
                bubble_frames = {tuple(tuple(row[23:30]) for row in pixels[:7])
                                 for pixels in frames}
                self.assertGreaterEqual(len(bubble_frames), 3)
                response = render_pixel_pet(snapshot(kind, 'speaking'))
                self.assertNotEqual(response, render_pixel_pet(snapshot(kind, 'typing')))
                self.assertNotEqual(response, render_pixel_pet(snapshot(kind, 'watching')))

    def test_ai_task_poses_are_distinct_and_animated_for_every_species(self):
        for kind in PET_NAMES:
            poses = set()
            for behavior in ('pondering', 'speaking', 'searching', 'reading', 'working'):
                with self.subTest(kind=kind, behavior=behavior):
                    frames = [tuple(render_pixel_pet(snapshot(kind, behavior, frame)))
                              for frame in range(8)]
                    self.assertGreaterEqual(len(set(frames)), 3)
                    poses.add(frames[0])
            self.assertEqual(len(poses), 5)

    def test_ai_activity_props_preserve_bowl_and_fit_narrow_habitats(self):
        for kind in PET_NAMES:
            for width in (1, 7, 13, 17, 18, 22, 28):
                for height in (1, 2, 3):
                    baseline = decode(render_pixel_pet(snapshot(kind), width, height))
                    for behavior in ('pondering', 'speaking', 'searching', 'reading', 'working'):
                        with self.subTest(kind=kind, width=width, height=height,
                                          behavior=behavior):
                            for frame in (0, 3, 7):
                                rows = render_pixel_pet(snapshot(kind, behavior, frame), width, height)
                                self.assertEqual(len(rows), height)
                                self.assertTrue(all(display_width(row) == width for row in rows))
                                pixels = decode(rows)
                                if width >= 17 and height >= 2:
                                    bowl_x = width * 2 - 8
                                    self.assertEqual([row[bowl_x:] for row in pixels],
                                                     [row[bowl_x:] for row in baseline])
                                    self.assertTrue(all(not any(row[bowl_x - 2:bowl_x])
                                                        for row in pixels))

    def test_walking_moves_and_returns_without_touching_bowl(self):
        for kind in PET_NAMES:
            for width in (18, 22, 28):
                with self.subTest(kind=kind, width=width):
                    left = decode(render_pixel_pet(snapshot(kind, "walking_to_bowl", position=0), width))
                    right = decode(render_pixel_pet(snapshot(kind, "walking_to_bowl", position=1), width))
                    bowl_x = width * 2 - 8
                    self.assertEqual([row[bowl_x:] for row in left], [row[bowl_x:] for row in right])
                    self.assertTrue(all(not any(row[bowl_x - 2:bowl_x]) for row in right))
                    leftmost = min(x for row in left for x, value in enumerate(row[:bowl_x - 2]) if value)
                    rightmost = min(x for row in right for x, value in enumerate(row[:bowl_x - 2]) if value)
                    self.assertGreater(rightmost, leftmost)

    def test_snacking_depletes_food_without_moving_bowl_or_overlapping(self):
        frames = [decode(render_pixel_pet(snapshot("cat", "snacking", position=1, food=food)))
                  for food in (3, 2, 1)]
        bowl_x = 22 * 2 - 8
        self.assertEqual([row[bowl_x:] for row in frames[0][-3:]],
                         [row[bowl_x:] for row in frames[2][-3:]])
        self.assertGreater(sum(frames[0][-4][bowl_x:]), sum(frames[2][-4][bowl_x:]))
        self.assertTrue(all(not any(row[bowl_x - 2:bowl_x]) for frame in frames for row in frame))

    def test_completion_hops_and_spreads_wings_or_raises_paws(self):
        for kind in PET_NAMES:
            with self.subTest(kind=kind):
                grounded = decode(render_pixel_pet(snapshot(kind, "celebrating", frame=0)))
                hopping = decode(render_pixel_pet(snapshot(kind, "celebrating", frame=1)))
                self.assertNotEqual(grounded, hopping)
                # Top two rows gain animal pixels when the body hops upward.
                self.assertGreater(sum(sum(row[3:22]) for row in hopping[:2]),
                                   sum(sum(row[3:22]) for row in grounded[:2]))

    def test_idle_details_and_sleep_poses_change(self):
        for kind in PET_NAMES:
            with self.subTest(kind=kind):
                looking = render_pixel_pet(snapshot(kind, "looking", frame=0))
                self.assertNotEqual(looking, render_pixel_pet(snapshot(kind, "looking", frame=7)))
                self.assertNotEqual(looking, render_pixel_pet(snapshot(kind, "grooming", frame=1)))
                self.assertNotEqual(looking, render_pixel_pet(snapshot(kind, "sleeping", frame=0)))

    def test_motion_off_is_fixed_for_every_activity(self):
        for kind in PET_NAMES:
            base = render_pixel_pet(dict(snapshot(kind), motion=False))
            for behavior in ("typing", "snacking", "celebrating", "watching", "sleeping",
                             "pondering", "speaking", "searching", "reading", "working"):
                state = dict(snapshot(kind, behavior, frame=7, position=1, food=1),
                             motion=False, direction=-1)
                self.assertEqual(render_pixel_pet(state), base)

    def test_malformed_metadata_cannot_escape_the_grid(self):
        cases = (None, False, [], "\x1b[2J", {},
                 {"kind": "dog", "behavior": "\x1b[2J", "frame": "bad", "position": float("inf")},
                 {"kind": "owl", "frame": float("nan"), "position": -999, "food": "bad"},
                 {"kind": "unknown", "frame": -999, "direction": float("nan")})
        for state in cases:
            rows = render_pixel_pet(state, 22, 3)
            self.assertEqual(len(rows), 3)
            self.assertTrue(all(display_width(row) == 22 for row in rows))
            self.assertTrue(all(glyph == " " or 0x2801 <= ord(glyph) <= 0x28ff
                                for row in rows for glyph in row))

    def test_terminal_pet_snapshot_is_supported_directly(self):
        pet = TerminalPet("owl", clock=lambda: 0)
        self.assertEqual(render_pixel_pet(pet), render_pixel_pet(pet.snapshot()))


if __name__ == "__main__":
    unittest.main()
