"""Render the welcome page background: a water droplet hit played backwards.

Concentric ripple rings converge inward on dark water under static
elongated light streaks. Everything moving is driver-driven with integer
cycle counts across frames 1..181, so the rendered 1..180 loop is seamless.

Usage:
  blender -b --python render-welcome-water.py -- --out DIR [--test]

--test renders four low-res stills (frames 1, 12, 60, 120) for look checks.
"""
import math
import os
import sys

import bpy

ARGV = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = ARGV[ARGV.index('--out') + 1] if '--out' in ARGV else bpy.path.abspath('//water_frames')
TEST = '--test' in ARGV
PERIOD = 180  # frames 1..180 rendered; keys/drivers evaluated through 181 for loop wrap
FPS = 30

os.makedirs(OUT, exist_ok=True)

scene = bpy.context.scene
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)


def drive(socket, expression):
    """Attach a frame-driven expression so motion is exactly linear/periodic."""
    channel = socket.driver_add('default_value')
    channel.driver.expression = expression
    return channel


def socket(node, *names):
    for name in names:
        if name in node.inputs:
            return node.inputs[name]
    raise KeyError(f'{node.bl_idname} has none of {names}')


# ---------------------------------------------------------------- water surface
mat = bpy.data.materials.new('DarkWater')
mat.use_nodes = True
nt = mat.node_tree
nodes, links = nt.nodes, nt.links
nodes.clear()

out = nodes.new('ShaderNodeOutputMaterial')
bsdf = nodes.new('ShaderNodeBsdfPrincipled')
socket(bsdf, 'Base Color').default_value = (0.004, 0.028, 0.033, 1.0)
socket(bsdf, 'Roughness').default_value = 0.1
socket(bsdf, 'IOR').default_value = 1.33
socket(bsdf, 'Coat Weight', 'Clearcoat').default_value = 0.35
socket(bsdf, 'Coat Roughness', 'Clearcoat Roughness').default_value = 0.05
links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])

tex = nodes.new('ShaderNodeTexCoord')

center = nodes.new('ShaderNodeCombineXYZ')
for axis in range(3):
    center.inputs[axis].default_value = 0.5

dist = nodes.new('ShaderNodeVectorMath')
dist.operation = 'DISTANCE'
links.new(tex.outputs['Generated'], dist.inputs[0])
links.new(center.outputs['Vector'], dist.inputs[1])

# Amplitude envelope: quiet at the impact point, strong mid-field, gone at the rim.
env_in = nodes.new('ShaderNodeValToRGB')
env_in.color_ramp.elements[0].position = 0.03
env_in.color_ramp.elements[0].color = (0, 0, 0, 1)
env_in.color_ramp.elements[1].position = 0.11
env_in.color_ramp.elements[1].color = (1, 1, 1, 1)
links.new(dist.outputs['Value'], env_in.inputs['Fac'])

env_out = nodes.new('ShaderNodeValToRGB')
env_out.color_ramp.elements[0].position = 0.40
env_out.color_ramp.elements[0].color = (1, 1, 1, 1)
env_out.color_ramp.elements[1].position = 0.68
env_out.color_ramp.elements[1].color = (0, 0, 0, 1)
links.new(dist.outputs['Value'], env_out.inputs['Fac'])

env = nodes.new('ShaderNodeMath')
env.operation = 'MULTIPLY'
links.new(env_in.outputs['Color'], env.inputs[0])
links.new(env_out.outputs['Color'], env.inputs[1])


def wave(name, scale, distortion, detail, rings_per_loop):
    node = nodes.new('ShaderNodeTexWave')
    node.name = name
    node.wave_type = 'RINGS'
    node.rings_direction = 'Z'
    node.wave_profile = 'SIN'
    socket(node, 'Scale').default_value = scale
    socket(node, 'Distortion').default_value = distortion
    socket(node, 'Detail').default_value = detail
    socket(node, 'Detail Roughness').default_value = 0.7
    links.new(tex.outputs['Generated'], socket(node, 'Vector'))
    # The ring pattern repeats every 2*pi of phase (verified empirically);
    # negative travel pulls the rings inward toward the impact point.
    drive(socket(node, 'Phase Offset'), f'-{rings_per_loop}*2*pi*(frame-1)/{PERIOD}')
    return node


rings_main = wave('MainRings', scale=22, distortion=2.2, detail=2, rings_per_loop=10)
rings_fine = wave('FineRings', scale=35, distortion=3.5, detail=3, rings_per_loop=16)  # ~matched radial speed

# Slow broad swell so the surface never reads as flat vinyl.
swell = nodes.new('ShaderNodeTexWave')
swell.wave_type = 'BANDS'
swell.bands_direction = 'X'
swell.wave_profile = 'SIN'
socket(swell, 'Scale').default_value = 1.6
socket(swell, 'Distortion').default_value = 3.0
socket(swell, 'Detail').default_value = 2
links.new(tex.outputs['Generated'], socket(swell, 'Vector'))
drive(socket(swell, 'Phase Offset'), f'-1*2*pi*(frame-1)/{PERIOD}')

mix_rings = nodes.new('ShaderNodeMath')
mix_rings.operation = 'MULTIPLY_ADD'
links.new(rings_main.outputs['Color'], mix_rings.inputs[0])
mix_rings.inputs[1].default_value = 0.55
links.new(rings_fine.outputs['Color'], mix_rings.inputs[2])

mix_swell = nodes.new('ShaderNodeMath')
mix_swell.operation = 'MULTIPLY_ADD'
links.new(swell.outputs['Color'], mix_swell.inputs[0])
mix_swell.inputs[1].default_value = 0.18
links.new(mix_rings.outputs[0], mix_swell.inputs[2])

height = nodes.new('ShaderNodeMath')
height.operation = 'MULTIPLY'
links.new(mix_swell.outputs[0], height.inputs[0])
links.new(env.outputs[0], height.inputs[1])

# The droplet itself: a dome that swells once per loop, peaking at the seam.
dome_r = nodes.new('ShaderNodeMath')
dome_r.operation = 'DIVIDE'
links.new(dist.outputs['Value'], dome_r.inputs[0])
dome_r.inputs[1].default_value = 0.055

dome_sq = nodes.new('ShaderNodeMath')
dome_sq.operation = 'MULTIPLY'
links.new(dome_r.outputs[0], dome_sq.inputs[0])
links.new(dome_r.outputs[0], dome_sq.inputs[1])

dome_neg = nodes.new('ShaderNodeMath')
dome_neg.operation = 'MULTIPLY'
links.new(dome_sq.outputs[0], dome_neg.inputs[0])
dome_neg.inputs[1].default_value = -1.0

dome_exp = nodes.new('ShaderNodeMath')
dome_exp.operation = 'EXPONENT'
links.new(dome_neg.outputs[0], dome_exp.inputs[0])

pulse = nodes.new('ShaderNodeValue')
pulse.name = 'DomePulse'
drive(pulse.outputs[0], f'0.5+0.5*cos(2*pi*(frame-1)/{PERIOD})')

dome = nodes.new('ShaderNodeMath')
dome.operation = 'MULTIPLY'
links.new(dome_exp.outputs[0], dome.inputs[0])
links.new(pulse.outputs[0], dome.inputs[1])

dome_amp = nodes.new('ShaderNodeMath')
dome_amp.operation = 'MULTIPLY'
links.new(dome.outputs[0], dome_amp.inputs[0])
dome_amp.inputs[1].default_value = 1.4

height_sum = nodes.new('ShaderNodeMath')
height_sum.operation = 'ADD'
links.new(height.outputs[0], height_sum.inputs[0])
links.new(dome_amp.outputs[0], height_sum.inputs[1])

bump = nodes.new('ShaderNodeBump')
socket(bump, 'Strength').default_value = 0.45
socket(bump, 'Distance').default_value = 0.09
links.new(height_sum.outputs[0], socket(bump, 'Height'))

micro = nodes.new('ShaderNodeTexNoise')
socket(micro, 'Scale').default_value = 60
socket(micro, 'Detail').default_value = 2.5
socket(micro, 'Roughness').default_value = 0.65
links.new(tex.outputs['Generated'], socket(micro, 'Vector'))

micro_bump = nodes.new('ShaderNodeBump')
socket(micro_bump, 'Strength').default_value = 0.04
socket(micro_bump, 'Distance').default_value = 0.015
links.new(micro.outputs['Fac'], socket(micro_bump, 'Height'))
links.new(bump.outputs['Normal'], micro_bump.inputs['Normal'])
links.new(micro_bump.outputs['Normal'], socket(bsdf, 'Normal'))

# Gentle radial vignette keeps the edges dark like the macro record shot.
vignette_mix = nodes.new('ShaderNodeMixRGB')
vignette_mix.blend_type = 'MULTIPLY'
vignette_mix.inputs[0].default_value = 1.0
vignette_mix.inputs[1].default_value = (0.004, 0.028, 0.033, 1.0)

lift = nodes.new('ShaderNodeMath')
lift.operation = 'MULTIPLY_ADD'
links.new(env_out.outputs['Color'], lift.inputs[0])
lift.inputs[1].default_value = 0.55
lift.inputs[2].default_value = 0.45
links.new(lift.outputs[0], vignette_mix.inputs[2])
links.new(vignette_mix.outputs['Color'], socket(bsdf, 'Base Color'))

# ---------------------------------------------------------------- water plane
bpy.ops.mesh.primitive_plane_add(size=12, location=(0, 0, 0))
plane = bpy.context.object
plane.name = 'WaterSurface'
plane.data.materials.append(mat)

# ---------------------------------------------------------------- light
# One enormous softbox so far above that its reflection covers the whole
# surface: a shapeless sheen, not a fixture. The sky-gradient world adds
# ambient so the troughs keep their deep-teal read.
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
# Aimed slightly above the impact point so the crater projects to dead
# frame-center (measured to ~0.50 of frame height at this tilt).
cam.rotation_euler = (math.radians(19.35), 0, 0)
scene.camera = cam

# ---------------------------------------------------------------- render setup
for engine in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE', 'CYCLES'):
    try:
        scene.render.engine = engine
        break
    except TypeError:
        continue
print(f'ENGINE {scene.render.engine}')
if hasattr(scene, 'eevee'):
    for prop, value in (('taa_render_samples', 64), ('taa_samples', 64)):
        if hasattr(scene.eevee, prop):
            setattr(scene.eevee, prop, value)
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

scene.render.resolution_x = 1920
scene.render.resolution_y = 1080
scene.render.resolution_percentage = 25 if TEST else 100
scene.render.fps = FPS
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGB'
scene.frame_start = 1
scene.frame_end = PERIOD

if TEST:
    frames = (1, 12, 60, 120)
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
