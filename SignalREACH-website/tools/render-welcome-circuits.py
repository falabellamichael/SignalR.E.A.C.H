"""Render an alternate welcome background: a dark PCB with signal streaks.

Faint copper traces run Manhattan routes across near-black solder mask.
Every ~1.1s an emissive signal segment draws along a route, turns its sharp
corners, and erases itself into a pad — one streak at a time, always slow.

Each streak is a curve copy whose bevel_factor_end/start drivers chase each
other along the path, so the loop is seamless as long as every streak fully
erases before frame 181 (all timings below guarantee that).

Usage:
  blender -b --python render-welcome-circuits.py -- --out DIR [--test] [--frames 1,90]
"""
import math
import os
import random
import sys

import bpy

ARGV = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = ARGV[ARGV.index('--out') + 1] if '--out' in ARGV else bpy.path.abspath('//circuit_frames')
TEST = '--test' in ARGV
PERIOD = 180  # frames 1..180
FPS = 30
random.seed(20261106)

os.makedirs(OUT, exist_ok=True)

scene = bpy.context.scene
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)


def drive(socket, expression):
    channel = socket.driver_add('default_value')
    channel.driver.expression = expression
    return channel


def drive_property(id_block, data_path, index, expression):
    channel = id_block.driver_add(data_path, index)
    channel.driver.expression = expression
    return channel


def socket(node, *names):
    for name in names:
        if name in node.inputs:
            return node.inputs[name]
    raise KeyError(f'{node.bl_idname} has none of {names}')


# ---------------------------------------------------------------- materials
def principled(name, base, roughness, metallic=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get('Principled BSDF')
    socket(bsdf, 'Base Color').default_value = (*base, 1.0)
    socket(bsdf, 'Roughness').default_value = roughness
    socket(bsdf, 'Metallic').default_value = metallic
    return m


board_mat = principled('SolderMask', (0.006, 0.038, 0.020), 0.55)
copper_mat = principled('Copper', (0.30, 0.12, 0.045), 0.38, metallic=0.9)
dark_mat = principled('Components', (0.010, 0.012, 0.016), 0.4, metallic=0.2)
hole_mat = principled('ViaHole', (0.001, 0.001, 0.001), 0.9)

streak_mat = bpy.data.materials.new('SignalPulse')
streak_mat.use_nodes = True
sn, sl = streak_mat.node_tree.nodes, streak_mat.node_tree.links
sn.clear()
sout = sn.new('ShaderNodeOutputMaterial')
sem = sn.new('ShaderNodeEmission')
sem.inputs['Color'].default_value = (0.10, 0.95, 0.35, 1.0)
sem.inputs['Strength'].default_value = 7.0
sl.new(sem.outputs[0], sout.inputs['Surface'])

# Subtle solder-mask texture so the board is not a flat void.
bnt = board_mat.node_tree
tex = bnt.nodes.new('ShaderNodeTexNoise')
socket(tex, 'Scale').default_value = 85
socket(tex, 'Detail').default_value = 2
socket(tex, 'Roughness').default_value = 0.6
bump = bnt.nodes.new('ShaderNodeBump')
socket(bump, 'Strength').default_value = 0.12
socket(bump, 'Distance').default_value = 0.02
coord = bnt.nodes.new('ShaderNodeTexCoord')
bnt.links.new(coord.outputs['Generated'], socket(tex, 'Vector'))
bnt.links.new(tex.outputs['Fac'], socket(bump, 'Height'))
bnt.links.new(bump.outputs['Normal'], socket(bnt.nodes.get('Principled BSDF'), 'Normal'))

# ---------------------------------------------------------------- board
bpy.ops.mesh.primitive_plane_add(size=12, location=(0, 0, 0))
board = bpy.context.object
board.name = 'Board'
board.data.materials.append(board_mat)

# ---------------------------------------------------------------- routing
FIELD_X, FIELD_Y = 3.3, 2.5


def route():
    """A Manhattan-ish PCB route: straight segments, 45/90 degree corners."""
    x, y = random.uniform(-FIELD_X, FIELD_X), random.uniform(-FIELD_Y, FIELD_Y)
    pts = [(x, y)]
    angle = random.choice([0, 45, 90, 135, 180, 225, 270, 315])
    for _ in range(random.randint(3, 6)):
        angle = (angle + random.choice([-90, -45, 0, 45, 90])) % 360
        step = random.uniform(0.5, 1.7)
        x = max(-FIELD_X, min(FIELD_X, x + step * math.cos(math.radians(angle))))
        y = max(-FIELD_Y, min(FIELD_Y, y + step * math.sin(math.radians(angle))))
        pts.append((x, y))
    out = [pts[0]]
    for p in pts[1:]:
        if (p[0] - out[-1][0]) ** 2 + (p[1] - out[-1][1]) ** 2 > 0.02:
            out.append(p)
    return out if len(out) > 2 else route()


def curve_object(name, points, bevel, z):
    data = bpy.data.curves.new(name, 'CURVE')
    data.dimensions = '3D'
    data.bevel_depth = bevel
    data.bevel_resolution = 0
    data.resolution_u = 1
    spline = data.splines.new('POLY')
    spline.points.add(len(points) - 1)
    for point, (x, y) in zip(spline.points, points):
        point.co = (x, y, z, 1.0)
    obj = bpy.data.objects.new(name, data)
    scene.collection.objects.link(obj)
    return obj


def cylinder(name, radius, depth, location, material):
    bpy.ops.mesh.primitive_cylinder_add(vertices=20, radius=radius, depth=depth, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(material)
    return obj


routes = [route() for _ in range(16)]
for i, points in enumerate(routes):
    trace = curve_object(f'Trace{i}', points, 0.016, 0.006)
    trace.data.materials.append(copper_mat)
    # Pad at each end, a via at some corners.
    for end in (points[0], points[-1]):
        cylinder('Pad', 0.055, 0.018, (end[0], end[1], 0.004), copper_mat)
    if len(points) > 4 and random.random() < 0.6:
        vx, vy = points[len(points) // 2]
        cylinder('ViaRing', 0.032, 0.018, (vx, vy, 0.004), copper_mat)
        cylinder('ViaHole', 0.014, 0.022, (vx, vy, 0.006), hole_mat)

# A few IC blocks and connectors sell the motherboard read.
for _ in range(3):
    bpy.ops.mesh.primitive_cube_add(size=1)
    chip = bpy.context.object
    chip.name = 'Chip'
    chip.scale = (random.uniform(0.35, 0.7), random.uniform(0.25, 0.45), 0.05)
    chip.location = (random.uniform(-FIELD_X, FIELD_X), random.uniform(-FIELD_Y, FIELD_Y), 0.05)
    chip.rotation_euler[2] = random.choice([0, math.pi / 4])
    chip.data.materials.append(dark_mat)

# ---------------------------------------------------------------- streaks
# Signal pulses: a lit segment that draws down the route then erases behind.
DRAW = 26   # frames to draw the full route
LAG = 16    # frames before the tail starts chasing
for k, points in enumerate(random.sample(routes, 5)):
    pulse = curve_object(f'Pulse{k}', points, 0.016, 0.010)
    pulse.data.materials.append(streak_mat)
    start_frame = 8 + k * 32  # one fires roughly every 1.1s
    assert start_frame + DRAW + LAG <= PERIOD
    drive_property(pulse.data, 'bevel_factor_end', -1,
                   f'min(1,max(0,(frame-{start_frame})/{DRAW}))')
    drive_property(pulse.data, 'bevel_factor_start', -1,
                   f'min(1,max(0,(frame-{start_frame + LAG})/{DRAW}))')

# ---------------------------------------------------------------- light
# Same shapeless-sky setup as the water render: one giant softbox whose
# reflection covers the board, plus the gradient world for ambient.
data = bpy.data.lights.new('SkySoftbox', 'AREA')
data.energy = 1500.0
data.color = (0.45, 0.68, 0.85)
data.shape = 'DISK'
data.size = 26.0
softbox = bpy.data.objects.new('SkySoftbox', data)
scene.collection.objects.link(softbox)
softbox.location = (0.0, 0.0, 14.0)

world = bpy.data.worlds.new('OvercastSky')
world.use_nodes = True
wn, wl = world.node_tree.nodes, world.node_tree.links
wn.clear()
wout = wn.new('ShaderNodeOutputWorld')
wbg = wn.new('ShaderNodeBackground')
wtex = wn.new('ShaderNodeTexCoord')
wsep = wn.new('ShaderNodeSeparateXYZ')
wramp = wn.new('ShaderNodeValToRGB')
wramp.color_ramp.elements[0].position = 0.0
wramp.color_ramp.elements[0].color = (0.004, 0.010, 0.020, 1)
mid = wramp.color_ramp.elements.new(0.35)
mid.color = (0.020, 0.055, 0.085, 1)
wramp.color_ramp.elements[1].position = 0.8
wramp.color_ramp.elements[1].color = (0.055, 0.14, 0.18, 1)
wl.new(wtex.outputs['Normal'], wsep.inputs[0])
wl.new(wsep.outputs['Z'], wramp.inputs['Fac'])
wl.new(wramp.outputs['Color'], wbg.inputs['Color'])
wbg.inputs['Strength'].default_value = 1.4
wl.new(wbg.outputs[0], wout.inputs['Surface'])
scene.world = world

# ---------------------------------------------------------------- camera
cam_data = bpy.data.cameras.new('Camera')
cam_data.lens = 55
cam_data.sensor_width = 36
cam_data.dof.use_dof = True
cam_data.dof.focus_distance = 10.2
cam_data.dof.aperture_fstop = 7.0
cam = bpy.data.objects.new('Camera', cam_data)
scene.collection.objects.link(cam)
cam.location = (0, -3.4, 9.6)
cam.rotation_euler = (math.radians(19.35), 0, 0)
scene.camera = cam

# ---------------------------------------------------------------- render
for engine in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE', 'CYCLES'):
    try:
        scene.render.engine = engine
        break
    except TypeError:
        continue
print(f'ENGINE {scene.render.engine}')
try:
    scene.view_settings.view_transform = 'AgX'
except TypeError:
    pass
for look in ('AgX - Medium High Contrast', 'AgX - Medium High Contrast Look', 'Medium High Contrast'):
    try:
        scene.view_settings.look = look
        break
    except TypeError:
        continue
scene.view_settings.exposure = -0.2

# Compositor fog glow makes the emissive streaks bloom; threshold keeps the
# dim copper and the softbox sheen out of it. Blender 5 builds compositing
# as a node group on the scene.
try:
    comp_tree = bpy.data.node_groups.new('Comp', 'CompositorNodeTree')
    comp_tree.interface.new_socket('Image', in_out='INPUT', socket_type='NodeSocketColor')
    comp_tree.interface.new_socket('Image', in_out='OUTPUT', socket_type='NodeSocketColor')
    scene.compositing_node_group = comp_tree
    cn, cl = comp_tree.nodes, comp_tree.links
    rlayers = cn.new('CompositorNodeRLayers')
    glare = cn.new('CompositorNodeGlare')
    for value in ('FOG_GLOW', 'BLOOM'):
        try:
            glare.inputs['Type'].default_value = value
            break
        except TypeError:
            continue
    for name, value in (('Quality', 'High'), ('Threshold', 1.0), ('Size', 0.5)):
        try:
            glare.inputs[name].default_value = value
        except (KeyError, TypeError):
            pass
    group_out = cn.new('NodeGroupOutput')
    cl.new(rlayers.outputs['Image'], glare.inputs['Image'])
    cl.new(glare.outputs['Image'], group_out.inputs['Image'])
except Exception as error:
    print(f'NO GLOW ({error})')

scene.render.resolution_x = 1920
scene.render.resolution_y = 1080
scene.render.resolution_percentage = 25 if TEST else 100
scene.render.fps = FPS
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGB'
scene.frame_start = 1
scene.frame_end = PERIOD

if TEST:
    frames = (1, 90)
    if '--frames' in ARGV:
        frames = [int(f) for f in ARGV[ARGV.index('--frames') + 1].split(',')]
    for frame in frames:
        scene.frame_set(frame)
        scene.render.filepath = os.path.join(OUT, f'test_{frame:04d}.png')
        bpy.ops.render.render(write_still=True)
        print(f'TEST FRAME {frame} -> {scene.render.filepath}')
else:
    scene.render.filepath = os.path.join(OUT, 'frame_####.png')
    bpy.ops.render.render(animation=True)
    print(f'LOOP FRAMES -> {OUT}')
