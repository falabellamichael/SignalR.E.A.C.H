"""Fine-grained terminal pet artwork, packed into two-by-four Braille cells.

Each output character still occupies one terminal column. The screen owner
supplies colors and paints these rows; this module emits no control sequences.
"""
import math

from .pets import TerminalPet, normalize_pet


_ART_WIDTH = 22
_ART_HEIGHT = 10
_BOWL_WIDTH = 8
_DOTS = ((0x01, 0x08), (0x02, 0x10), (0x04, 0x20), (0x40, 0x80))
_DEFAULT_PET = TerminalPet()


def _finite(value, fallback=0.0):
    try:
        number = float(value)
        return number if math.isfinite(number) else fallback
    except (TypeError, ValueError, OverflowError):
        return fallback


def _dimension(value):
    try:
        return max(0, int(value))
    except (TypeError, ValueError, OverflowError):
        return 0


def _grid(width, height):
    return [[False] * width for _ in range(height)]


def _dot(grid, x, y, value=True):
    x, y = int(x), int(y)
    if 0 <= y < len(grid) and 0 <= x < len(grid[y]):
        grid[y][x] = value


def _line(grid, x0, y0, x1, y1):
    """A small Bresenham line avoids gaps in ears, wings, tails, and whiskers."""
    x0, y0, x1, y1 = map(int, (x0, y0, x1, y1))
    dx, dy = abs(x1 - x0), -abs(y1 - y0)
    sx, sy = (1 if x0 < x1 else -1), (1 if y0 < y1 else -1)
    error = dx + dy
    while True:
        _dot(grid, x0, y0)
        if x0 == x1 and y0 == y1:
            break
        twice = error * 2
        if twice >= dy:
            error += dy
            x0 += sx
        if twice <= dx:
            error += dx
            y0 += sy


# Hand-placed silhouettes keep a full pixel of air around the face details.
_CAT = (
    '   #           #',
    '   ##         ##',
    '   # ######### #',
    '   #           #',
    ' ##      #      ##',
    '   #    # #    #',
    ' ## ####   #### ##',
    '      #     #      ##',
    '      #  #  ###   #  #',
    '     ###   ### ######',
)
_OWL = (
    '   #    ######    #',
    '   # ###      ### #',
    '  # #   #    #   # #',
    '  # # # #    # # # #',
    '  # #   # ## #   # #',
    '   # ###  #   ### #',
    '  # #            # #',
    '   # #  #   #   # #',
    '      ##########',
    '      ###    ###',
)
_BULLDOG = (
    '      #########',
    '  ####         ####',
    '  # #           # #',
    '   ##           ##',
    '    #    ###    #',
    '    #  #     #  #',
    '     ## ## ## ##',
    '      # ##### #',
    '     #       #    ##',
    '    ###     #######',
)
_CAT_WALK = (
    '             #     #',
    '             ##   ##',
    '  ##         # ### #',
    ' #  #        #     #',
    ' #          #    #  ##',
    '  #  ####### #   # #',
    '   ##        ######',
    '    #            #',
    '    #  ########  #',
    '   ## ##      ## ##',
)
_DOG_WALK = (
    '             ######',
    '           ###     ##',
    '           # #      #',
    '           # #   #  #',
    '  ##        ##     ###',
    '   # ####### #    # #',
    '    #       # #####',
    '    #            #',
    '    #  ########  #',
    '   ### ##    ## ###',
)
_CAT_SNACK = (
    '',
    '  ##',
    ' #  #',
    ' #           #    #',
    '  #  ######  ##  ##',
    '   ##      ### ## #',
    '    #      #      #',
    '    #      #  ##   #',
    '    #  #####     # ##',
    '   ###     ## ### #',
)
_DOG_SNACK = (
    '',
    '',
    '',
    '  ##         ######',
    '   # ###### ##     ##',
    '    #      ## #     #',
    '    #       # #  #  #',
    '    #       ###   ###',
    '    #  ###### #   # #',
    '   ###     ### ### #',
)
_OWL_SNACK = (
    '',
    '          ######',
    '        ##      ##',
    '       #   ####   #',
    '      #   #    #  #',
    '      #   # ## #  #',
    '      #    ####  #',
    '       # #      #####',
    '        # ######   ##',
    '        ###  ###',
)
_CAT_SLEEP = (
    '',
    '',
    '',
    '    #    #',
    '    ##  ##  ####',
    '    # ## ###    #',
    '   #  #  #       #',
    '   #    # #   ####',
    '    ###    ###   #',
    '       ##########',
)
_OWL_SLEEP = (
    '',
    '',
    '      ##########',
    '    ##          ##',
    '   # #   #  #   # #',
    '   #  ### ## ###  #',
    '  # #     #      # #',
    '   # #  #   #   # #',
    '      ##########',
    '      ###    ###',
)
_DOG_SLEEP = (
    '',
    '',
    '',
    '',
    '     #####  ######',
    '   ##     ##      #',
    '  # # ##  #        #',
    '   ##   ###     #  #',
    '    # ## #  #### ###',
    '     #####  ####',
)


def _stamp(rows):
    return [[x < len(row) and row[x] == '#' for x in range(_ART_WIDTH)]
            for row in rows]


def _clear(grid, x0, y0, x1, y1):
    for y in range(max(0, y0), min(len(grid), y1 + 1)):
        for x in range(max(0, x0), min(len(grid[y]), x1 + 1)):
            grid[y][x] = False


def _sleep_mark(grid, frame):
    x, y = (18, 0) if frame in (2, 3, 4, 5) else (17, 1)
    _line(grid, x, y, x + 2, y)
    _line(grid, x + 2, y, x, y + 2)
    _line(grid, x, y + 2, x + 2, y + 2)


def _cat(frame, behavior):
    if behavior == 'sleeping':
        grid = _stamp(_CAT_SLEEP)
        _sleep_mark(grid, frame)
        return grid
    if behavior in ('walking_to_bowl', 'walking_back', 'strolling'):
        grid = _stamp(_CAT_WALK)
        if frame == 7:
            _line(grid, 16, 4, 18, 4)
        _stride(grid, frame, 'cat')
        return grid
    if behavior == 'snacking':
        grid = _stamp(_CAT_SNACK)
        if frame in (2, 3, 6, 7):
            _dot(grid, 20, 8, False)
            _dot(grid, 20, 9)
        return grid
    grid = _stamp(_CAT)
    closed = frame == 7 or behavior in ('resting', 'settling')
    gaze = -1 if frame in (2, 3) else 1 if frame in (4, 5) else 0
    for x in (6, 12):
        if behavior == 'celebrating' and frame in (1, 2, 5, 6):
            _dot(grid, x - 1, 3)
            _dot(grid, x, 2)
            _dot(grid, x + 1, 3)
        elif closed:
            _line(grid, x - 1, 3, x + 1, 3)
        else:
            _dot(grid, x + gaze, 3)
    # A curled tail holds its shape and flicks only at the tip.
    if frame in (2, 3, 4, 5):
        _dot(grid, 20, 7, False)
        _dot(grid, 20, 6)
    if behavior == 'grooming':
        _line(grid, 12, 7, 14, 5 + frame % 2)
        _dot(grid, 13, 5)
    elif behavior == 'stretching':
        _clear(grid, 4, 7, 14, 9)
        _line(grid, 6, 7, 3, 9)
        _line(grid, 12, 7, 15, 9)
        _line(grid, 3, 9, 7, 9)
        _line(grid, 11, 9, 15, 9)
    elif behavior == 'celebrating':
        _line(grid, 6, 7, 3, 7 - frame % 2)
        _line(grid, 12, 7, 15, 7 - frame % 2)
    return grid


def _owl(frame, behavior):
    if behavior == 'sleeping':
        grid = _stamp(_OWL_SLEEP)
        _sleep_mark(grid, frame)
        return grid
    if behavior == 'snacking':
        # A dedicated side pose keeps the round disc and short triangular beak.
        grid = _stamp(_OWL_SNACK)
        if frame in (2, 3, 6, 7):
            _dot(grid, 20, 7, False)
            _dot(grid, 19, 8, False)
            _dot(grid, 20, 9)
        return grid
    grid = _stamp(_OWL)
    closed = frame == 7 or behavior in ('sleeping', 'resting', 'settling', 'snacking')
    gaze = -1 if frame in (2, 3) else 1 if frame in (4, 5) else 0
    for x in (6, 15):
        _dot(grid, x, 3, False)
        if closed:
            _clear(grid, x - 2, 2, x + 2, 4)
            _line(grid, x - 2, 3, x - 1, 4)
            _line(grid, x - 1, 4, x + 1, 4)
            _dot(grid, x + 2, 3)
        else:
            _dot(grid, x + gaze, 3)
    if behavior in ('walking_to_bowl', 'walking_back', 'strolling'):
        _stride(grid, frame, 'owl')
    if behavior in ('celebrating', 'stretching') or behavior == 'watching' and frame in (2, 3):
        _clear(grid, 0, 6, 3, 7)
        _clear(grid, 18, 6, 21, 7)
        tip = (4, 2, 1, 3)[frame % 4]
        _line(grid, 4, 6, 0, tip)
        _line(grid, 0, tip, 0, tip + 2)
        _line(grid, 17, 6, 21, tip)
        _line(grid, 21, tip, 21, tip + 2)
    elif behavior == 'grooming':
        _line(grid, 4, 6, 6, 5 - frame % 2)
    return grid


def _bulldog(frame, behavior):
    if behavior == 'sleeping':
        grid = _stamp(_DOG_SLEEP)
        _sleep_mark(grid, frame)
        return grid
    if behavior in ('walking_to_bowl', 'walking_back', 'strolling'):
        grid = _stamp(_DOG_WALK)
        _stride(grid, frame, 'bulldog')
        return grid
    if behavior == 'snacking':
        grid = _stamp(_DOG_SNACK)
        if frame in (2, 3, 6, 7):
            _dot(grid, 20, 9)
        return grid
    grid = _stamp(_BULLDOG)
    closed = frame == 7 or behavior in ('resting', 'settling')
    _dot(grid, 6, 2)
    _dot(grid, 14, 2)
    for x in (7, 13):
        if behavior == 'celebrating' and frame in (1, 2, 5, 6):
            _dot(grid, x - 1, 3)
            _dot(grid, x, 2)
            _dot(grid, x + 1, 3)
        elif closed:
            _line(grid, x - 1, 3, x + 1, 3)
        else:
            _dot(grid, x, 3)
    # A tiny asymmetrical ear fold and short wagging nub distinguish the pup.
    _dot(grid, 3, 2 if frame in (2, 3) else 3)
    if frame in (2, 3, 4, 5):
        _clear(grid, 17, 8, 19, 9)
        _line(grid, 17, 8, 19, 7)
    if behavior in ('grooming', 'watching', 'celebrating') and frame in (1, 2, 5, 6):
        _line(grid, 10, 6, 10, 7)
    if behavior == 'stretching':
        _line(grid, 5, 8, 2, 9)
        _line(grid, 14, 8, 17, 9)
    elif behavior == 'celebrating':
        _line(grid, 6, 7, 3, 6)
        _line(grid, 14, 7, 17, 6)
    return grid


def _keyboard(grid, frame, kind):
    # Only the front paws move. Ears, cheeks, wing tips and tails survive.
    _clear(grid, 2, 7, 17, 9)
    _line(grid, 2, 9, 17, 9)
    _dot(grid, 2, 8)
    _dot(grid, 17, 8)
    for x in (4, 7, 10, 13, 16):
        _dot(grid, x, 8)
    anchors = (6, 15) if kind == 'owl' else (6, 13)
    for side, x in enumerate(anchors):
        down = frame % 4 in ((0, 1) if side == 0 else (2, 3))
        paw_y = 8 if down else 7
        _line(grid, x, 6, x, paw_y)
        _line(grid, x - 1, paw_y, x + 1, paw_y)


def _stride(grid, frame, kind):
    if kind == 'owl':
        _clear(grid, 5, 9, 16, 9)
        for x in ((5, 13) if frame % 4 < 2 else (7, 14)):
            _line(grid, x, 9, x + 2, 9)
    else:
        _clear(grid, 2, 9, 20, 9)
        feet = (3, 7, 13, 17) if frame % 4 < 2 else (5, 8, 12, 16)
        for x in feet:
            _line(grid, x, 8, x + 1, 9)
            _dot(grid, x, 9)


def _speaking(grid, frame, kind):
    """Move the mouth and gesture while keeping each animal's face intact."""
    open_mouth = frame in (1, 2, 4, 6)
    if kind == 'cat':
        _clear(grid, 8, 5, 10, 6)
        if open_mouth:
            _line(grid, 8, 5, 10, 5)
            _dot(grid, 8, 6)
            _dot(grid, 10, 6)
            _dot(grid, 9, 7)
        else:
            _line(grid, 8, 6, 10, 6)
        _line(grid, 6, 7, 3, 6 if frame % 4 < 2 else 8)
        _line(grid, 12, 7, 15, 8 if frame % 4 < 2 else 6)
    elif kind == 'owl':
        _clear(grid, 9, 4, 12, 6)
        if open_mouth:
            _line(grid, 10, 4, 11, 4)
            _dot(grid, 9, 5)
            _dot(grid, 12, 5)
            _line(grid, 10, 6, 11, 6)
        else:
            _line(grid, 9, 4, 12, 4)
            _line(grid, 10, 5, 11, 5)
            _dot(grid, 10, 6)
        _clear(grid, 0, 6, 3, 7)
        _clear(grid, 18, 6, 21, 7)
        _line(grid, 4, 6, 0, 5 if frame % 4 < 2 else 7)
        _line(grid, 17, 6, 21, 7 if frame % 4 < 2 else 5)
    else:
        _clear(grid, 9, 7, 11, 8)
        if open_mouth:
            _dot(grid, 9, 7)
            _dot(grid, 11, 7)
            _dot(grid, 10, 8)
        else:
            _line(grid, 9, 7, 11, 7)
        _line(grid, 5, 8, 2, 6 if frame % 4 < 2 else 7)
        _line(grid, 14, 8, 17, 7 if frame % 4 < 2 else 6)


def _pondering(grid, frame, kind):
    # One paw or wing scratches outside the face; the eye discs remain clear.
    anchor, elbow, temple = {
        'cat': ((13, 8), (18, 6), (17, 3)),
        'owl': ((17, 7), (21, 6), (20, 3)),
        'bulldog': ((14, 8), (20, 6), (18, 3)),
    }[kind]
    _line(grid, *anchor, *elbow)
    scratch_y = temple[1] + (frame // 2) % 2
    _line(grid, *elbow, temple[0], scratch_y)
    _dot(grid, temple[0] - 1, scratch_y)


def _reading(grid, frame, kind):
    # An open book has a dipped spine and angled page edges, unlike the keys.
    _clear(grid, 3, 7, 17, 9)
    _line(grid, 3, 7, 9, 8)
    _line(grid, 9, 8, 16, 7)
    _line(grid, 3, 7, 3, 9)
    _line(grid, 16, 7, 16, 9)
    _line(grid, 3, 9, 8, 9)
    _line(grid, 10, 9, 16, 9)
    _line(grid, 9, 8, 9, 9)
    # A turning page and alternating page-holding paws supply the motion.
    page_x = (11, 12, 10, 8)[frame // 2]
    _line(grid, 9, 9, page_x, 7)
    _dot(grid, 4, 8)
    _dot(grid, 15, 8)
    if kind == 'owl':
        _dot(grid, 2, 7)
        _dot(grid, 17, 7)


def _sprite(kind, behavior, frame):
    drawing = {'cat': _cat, 'owl': _owl, 'bulldog': _bulldog}[kind](frame, behavior)
    if behavior == 'typing':
        _keyboard(drawing, frame, kind)
    elif behavior == 'working':
        _keyboard(drawing, frame + 2, kind)
    elif behavior == 'speaking':
        _speaking(drawing, frame, kind)
    elif behavior == 'pondering':
        _pondering(drawing, frame, kind)
    elif behavior == 'reading':
        _reading(drawing, frame, kind)
    elif behavior == 'searching':
        # Brow shading reads as peering into the distance at this tiny scale.
        side = -1 if frame < 4 else 1
        eye_y = 2
        eye_x = {'cat': 6, 'owl': 6, 'bulldog': 7}[kind] if side < 0 else {
            'cat': 12, 'owl': 15, 'bulldog': 13}[kind]
        _line(drawing, eye_x - 1, eye_y, eye_x + 1, eye_y)
        _dot(drawing, eye_x + side * 2, eye_y + 1)
    return drawing


def _fit(drawing, width, height):
    width, height = min(_ART_WIDTH, width), min(_ART_HEIGHT, height)
    if width == _ART_WIDTH and height == _ART_HEIGHT:
        return drawing
    result = _grid(width, height)
    for y, row in enumerate(drawing):
        for x, value in enumerate(row):
            if value:
                _dot(result, x * width // _ART_WIDTH, y * height // _ART_HEIGHT)
    return result


def _bowl(canvas, x, floor, food):
    # The upper food pixels change, while rim/base stay anchored to the floor.
    _line(canvas, x, floor - 2, x + 7, floor - 2)
    _line(canvas, x, floor - 2, x + 2, floor)
    _line(canvas, x + 7, floor - 2, x + 5, floor)
    _line(canvas, x + 2, floor, x + 5, floor)
    for offset in (2, 4, 6)[:food]:
        _dot(canvas, x + offset, floor - 3)


def _activity_mark(canvas, behavior, frame, left, right):
    """Draw compact task props only when a clear lane is available."""
    if right - left < 7 or len(canvas) < 8:
        return
    x, y = left, 1
    if behavior == 'speaking':
        # A seven-pixel speech bubble with streaming dots and a tiny tail.
        _line(canvas, x + 1, y, x + 5, y)
        _line(canvas, x, y + 1, x, y + 3)
        _line(canvas, x + 6, y + 1, x + 6, y + 3)
        _line(canvas, x + 1, y + 4, x + 5, y + 4)
        _dot(canvas, x + 1, y + 5)
        for offset in (1, 3, 5)[:1 + frame % 3]:
            _dot(canvas, x + offset, y + 2)
    elif behavior == 'pondering':
        _dot(canvas, x, y + 5)
        _dot(canvas, x + 2, y + 3)
        for offset in (0, 2, 4)[:1 + (frame // 2) % 3]:
            _dot(canvas, x + 2 + offset, y + 1)
    elif behavior == 'searching':
        # A round lens scans left and right, with a diagonal handle.
        x += (frame // 2) % 2
        _line(canvas, x + 1, y, x + 3, y)
        _line(canvas, x, y + 1, x, y + 3)
        _line(canvas, x + 4, y + 1, x + 4, y + 3)
        _line(canvas, x + 1, y + 4, x + 3, y + 4)
        _line(canvas, x + 4, y + 4, x + 5, y + 5)
        _dot(canvas, x + 2, y + 2)
    elif behavior == 'working':
        # Short lines appear as the pet produces work beside its keyboard.
        for row in range(3):
            length = 2 + (frame + row * 2) % 5
            _line(canvas, x, y + row * 2, x + length, y + row * 2)


def _pack(canvas, width, height):
    rows = []
    for cy in range(height):
        row = []
        for cx in range(width):
            mask = 0
            for dy, bits in enumerate(_DOTS):
                for dx, bit in enumerate(bits):
                    if canvas[cy * 4 + dy][cx * 2 + dx]:
                        mask |= bit
            row.append(chr(0x2800 + mask) if mask else " ")
        rows.append("".join(row))
    return rows


def render_pixel_pet(pet_or_snapshot=None, width=22, height=3):
    """Render an animated, detailed habitat as exact-width terminal cells.

    Snapshots contain animation metadata only. Unrecognized fields or state
    names cannot introduce text, control characters, or arbitrary artwork.
    """
    width, height = _dimension(width), _dimension(height)
    if not width or not height:
        return [""] * height if not width else []
    source = _DEFAULT_PET if pet_or_snapshot is None else pet_or_snapshot
    state = source.snapshot() if isinstance(source, TerminalPet) else source
    state = state if isinstance(state, dict) else {}
    kind = normalize_pet(state.get("kind")) or "cat"
    motion = bool(state.get("motion", True))
    behavior = str(state.get("behavior", "looking")) if motion else "looking"
    frame = int(_finite(state.get("frame"))) % 8 if motion else 0
    position = max(0.0, min(1.0, _finite(state.get("position"), 0.12))) if motion else 0.12
    direction = -1 if motion and _finite(state.get("direction"), 1) < 0 else 1
    food = int(max(1, min(3, _finite(state.get("food"), 3)))) if behavior == "snacking" else 3
    pixel_width, pixel_height = width * 2, height * 4
    canvas = _grid(pixel_width, pixel_height)
    bowl_x = pixel_width - _BOWL_WIDTH if pixel_width >= 34 and pixel_height >= 8 else None
    right_limit = bowl_x - 2 if bowl_x is not None else pixel_width
    drawing = _fit(_sprite(kind, behavior, frame), right_limit, pixel_height)
    animal_width, animal_height = len(drawing[0]), len(drawing)
    animal_x = round(position * max(0, right_limit - animal_width))
    spare_height = pixel_height - animal_height
    hop = min(spare_height, (0, 2, 1, 0)[frame % 4]) if behavior == "celebrating" else 0
    if behavior in ("walking_to_bowl", "walking_back", "strolling"):
        hop = min(spare_height, frame % 2)
    animal_y = spare_height - hop
    for y, row in enumerate(drawing):
        for x, value in enumerate(row):
            if value:
                drawn_x = x if direction > 0 else animal_width - x - 1
                _dot(canvas, animal_x + drawn_x, animal_y + y)
    if behavior == "celebrating":
        if hop:
            for x in range(animal_x + 5, min(right_limit, animal_x + animal_width - 4), 3):
                _dot(canvas, x, pixel_height - 1)
        for x, y in ((animal_x - 2, 1 + frame % 2),
                     (animal_x + animal_width + 1, 3 - frame % 2)):
            if 0 <= x < right_limit:
                _dot(canvas, x, y)
                _dot(canvas, x - 1, y)
                _dot(canvas, x + 1, y)
                _dot(canvas, x, y - 1)
                _dot(canvas, x, y + 1)
    _activity_mark(canvas, behavior, frame, animal_x + animal_width + 1, right_limit)
    if bowl_x is not None:
        _bowl(canvas, bowl_x, pixel_height - 1, food)
    return _pack(canvas, width, height)
