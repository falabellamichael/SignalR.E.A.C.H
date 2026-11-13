#!/usr/bin/env python3
"""Create a new, weight-only LFM3 compression candidate from local weights.

The existing model directory is never modified. Qualification and promotion
are separate operations; a successful export is not evidence of model quality.
"""

import argparse
import json
import os
from pathlib import Path
import shutil


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, help="Existing local model directory")
    parser.add_argument("--output", required=True, help="New output directory")
    parser.add_argument("--kind", required=True, choices=("omni", "vl"))
    parser.add_argument("--scheme", default="W8A16", choices=("W8A16", "W4A16", "FP8_DYNAMIC"))
    parser.add_argument("--scope", default="all", choices=("all", "text-mlp"),
                        help="text-mlp preserves all attention projections at BF16")
    parser.add_argument("--threads", type=int, default=2)
    args = parser.parse_args()

    model_path = Path(args.model).resolve(strict=True)
    output_path = Path(args.output).resolve()
    if output_path.exists() or output_path == model_path or model_path in output_path.parents:
        parser.error("output must be a new directory outside the source model")

    # This export runs beside live GPU services. Keep it on CPU and use the
    # eager quantizer: the installed ROCm Triton W4 path uses a CUDA-only op.
    os.environ["ROCR_VISIBLE_DEVICES"] = ""
    os.environ["HIP_VISIBLE_DEVICES"] = ""
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    os.environ["CT_ENFORCE_EAGER"] = "1"
    import torch
    from llmcompressor import oneshot
    from llmcompressor.modifiers.quantization import QuantizationModifier
    from transformers import AutoModelForImageTextToText, AutoModelForMultimodalLM, AutoProcessor

    torch.set_num_threads(args.threads)
    # With TP2, each attention gate has only eight output columns; ROCm's
    # FP8 scaled matrix multiply requires a multiple of sixteen. Keeping this
    # tiny projection in BF16 also avoids format-specific sharding issues.
    ignored = ["re:.*gate_proj.*", "re:.*conv.*", "re:.*vision_tower.*",
               "re:.*multi_modal_projector.*", "lm_head"]
    if args.kind == "omni":
        ignored += ["re:.*audio_encoder.*", "re:.*audio_projector.*", "re:.*depth_decoder.*"]
    cls = AutoModelForMultimodalLM if args.kind == "omni" else AutoModelForImageTextToText
    print(f"Loading {args.kind} weights on CPU: {model_path}", flush=True)
    model = cls.from_pretrained(str(model_path), dtype=torch.bfloat16, trust_remote_code=True,
                                local_files_only=True, device_map="cpu")
    processor = AutoProcessor.from_pretrained(str(model_path), trust_remote_code=True,
                                              local_files_only=True)
    targets = "Linear" if args.scope == "all" else [
        r"re:.*language_model\.layers\.\d+\.feed_forward\.(?:w1|w2|w3)$"]
    recipe = QuantizationModifier(targets=targets, scheme=args.scheme, ignore=ignored)
    print(f"Compressing with {args.scheme}; multimodal components stay uncompressed", flush=True)
    oneshot(model=model, recipe=recipe, trust_remote_code_model=True)
    output_path.mkdir(parents=True, exist_ok=False)
    # Transformers 5.21 rejects the vendor's greedy generation config during
    # save because it includes temperature/top_k alongside do_sample=false.
    # Normalize only for serialization, then restore the original file below.
    if model.generation_config.do_sample is False:
        model.generation_config.temperature = None
        model.generation_config.top_k = None
    model.save_pretrained(str(output_path), save_compressed=True)
    processor.save_pretrained(str(output_path))
    original_generation = model_path / "generation_config.json"
    if original_generation.is_file():
        shutil.copyfile(original_generation, output_path / "generation_config.json")
    # LLM Compressor expands ignore regexes to Hugging Face module names.
    # The custom vLLM adapter uses a different language-model prefix, so keep
    # a name-independent regex as well or it will try to quantize this BF16
    # tensor again when constructing the TP-sharded gate projection.
    config_path = output_path / "config.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    runtime_ignore = config["quantization_config"]["ignore"]
    gate_regex = r"re:.*\.gate_proj$"
    if gate_regex not in runtime_ignore:
        runtime_ignore.append(gate_regex)
    if args.scope == "text-mlp":
        runtime_target = r"re:.*(?:language_model|language\.model)\.layers\.\d+\.feed_forward\.(?:w1|w2|w3|w13)$"
        groups = config["quantization_config"]["config_groups"]
        if len(groups) != 1:
            raise RuntimeError("Expected one quantization group for text MLP-only compression")
        runtime_targets = next(iter(groups.values()))["targets"]
        if runtime_target not in runtime_targets:
            runtime_targets.append(runtime_target)
    config_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    (output_path / "reach-quantization.json").write_text(json.dumps({
        "source": str(model_path), "kind": args.kind, "scheme": args.scheme, "scope": args.scope,
        "ignore": ignored, "calibration": "RTN; no calibration dataset",
    }, indent=2) + "\n", encoding="utf-8")
    print(f"Saved candidate {output_path}", flush=True)


if __name__ == "__main__":
    main()
