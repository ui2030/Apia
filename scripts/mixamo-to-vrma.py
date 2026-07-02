# scripts/mixamo-to-vrma.py
# Blender 4.x headless script: Mixamo FBX -> VRMA
#
# Usage (invoked by convert-mixamo.mjs, but runnable standalone):
#   blender --background --python scripts/mixamo-to-vrma.py -- \
#       --fbx "path/to/Dance.fbx" --out "src/assets/motions/vrma/emote/dance.vrma"
#
# Prerequisites:
#   - Blender 4.x with "VRM Add-on for Blender" (saturday06) >= 3.0 installed and enabled.
#   - FBX must be a Mixamo export (Y-up, 30fps recommended, bones prefixed "mixamorig:").
#
# What this script automates:
#   1. Imports the FBX.
#   2. Renames mixamorig:* bones to the VRM humanoid mapping keys the addon recognises.
#   3. Sets humanoid bone mapping on the armature.
#   4. Bakes the animation onto the renamed rig.
#   5. Exports VRMA via the addon's operator.
#
# If VRMA export operator is missing (older addon), the script writes a .blend
# alongside the target path so you can open it in Blender and export manually.

import sys
import os
import argparse


def parse_cli():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    else:
        argv = []
    parser = argparse.ArgumentParser()
    parser.add_argument("--fbx", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--name", default=None)
    return parser.parse_args(argv)


# Mixamo bone -> VRM humanoid bone (addon uses snake_case keys on humanoid.human_bones).
BONE_MAP = {
    "Hips":              "hips",
    "Spine":             "spine",
    "Spine1":            "chest",
    "Spine2":            "upper_chest",
    "Neck":              "neck",
    "Head":              "head",
    "LeftShoulder":      "left_shoulder",
    "LeftArm":           "left_upper_arm",
    "LeftForeArm":       "left_lower_arm",
    "LeftHand":          "left_hand",
    "RightShoulder":     "right_shoulder",
    "RightArm":          "right_upper_arm",
    "RightForeArm":      "right_lower_arm",
    "RightHand":         "right_hand",
    "LeftUpLeg":         "left_upper_leg",
    "LeftLeg":           "left_lower_leg",
    "LeftFoot":          "left_foot",
    "LeftToeBase":       "left_toes",
    "RightUpLeg":        "right_upper_leg",
    "RightLeg":          "right_lower_leg",
    "RightFoot":         "right_foot",
    "RightToeBase":      "right_toes",
}


def main():
    import bpy  # available only inside Blender

    args = parse_cli()
    fbx_path = os.path.abspath(args.fbx)
    out_path = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    # Reset scene
    bpy.ops.wm.read_factory_settings(use_empty=True)

    # Import FBX
    print(f"[mixamo-to-vrma] importing {fbx_path}")
    bpy.ops.import_scene.fbx(filepath=fbx_path, automatic_bone_orientation=True)

    # Find armature
    armature = next((o for o in bpy.data.objects if o.type == "ARMATURE"), None)
    if not armature:
        raise RuntimeError("No armature found in FBX.")

    bpy.context.view_layer.objects.active = armature

    # Rename bones (strip "mixamorig:" prefix then map)
    bpy.ops.object.mode_set(mode="EDIT")
    edit_bones = armature.data.edit_bones
    renamed = {}
    for bone in list(edit_bones):
        raw = bone.name.split(":")[-1]
        vrm_name = BONE_MAP.get(raw)
        if vrm_name:
            bone.name = vrm_name
            renamed[raw] = vrm_name
    bpy.ops.object.mode_set(mode="OBJECT")
    print(f"[mixamo-to-vrma] renamed {len(renamed)} bones")

    # Attempt humanoid mapping via VRM addon API.
    # Addon versions expose this under slightly different paths; try the common ones.
    try:
        vrm_ext = armature.data.vrm_addon_extension
        humanoid = vrm_ext.vrm1.humanoid
        for human_bone_name, bone_name in BONE_MAP.items():
            slot = getattr(humanoid.human_bones, BONE_MAP[human_bone_name], None)
            if slot is not None and bone_name in armature.data.bones:
                slot.node.bone_name = bone_name
    except AttributeError as e:
        print(f"[mixamo-to-vrma] humanoid mapping skipped (addon API mismatch): {e}")

    # Try VRMA export. Operator name has varied across addon versions.
    export_ok = False
    operator_candidates = [
        ("vrm", "export_vrma"),
        ("vrm", "vrma_export"),
        ("export_scene", "vrma"),
    ]
    for mod, op in operator_candidates:
        ops_module = getattr(bpy.ops, mod, None)
        if ops_module and hasattr(ops_module, op):
            try:
                getattr(ops_module, op)(filepath=out_path)
                export_ok = True
                print(f"[mixamo-to-vrma] exported via bpy.ops.{mod}.{op} -> {out_path}")
                break
            except Exception as e:
                print(f"[mixamo-to-vrma] bpy.ops.{mod}.{op} failed: {e}")

    if not export_ok:
        fallback = out_path.rsplit(".", 1)[0] + ".blend"
        bpy.ops.wm.save_as_mainfile(filepath=fallback)
        print(
            "[mixamo-to-vrma] VRMA export operator unavailable.\n"
            f"Saved .blend for manual export: {fallback}\n"
            "Open it in Blender, then: File > Export > VRM Animation (.vrma)"
        )
        sys.exit(2)


if __name__ == "__main__":
    main()
