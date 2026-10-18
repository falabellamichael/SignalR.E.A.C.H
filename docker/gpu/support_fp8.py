"""Native ROCm FP8 linear layers; unsupported kernels fail startup, never fall back."""
import torch
from torch import nn
from torch.nn import functional as F


class FP8Linear(nn.Module):
    def __init__(self, linear):
        super().__init__()
        weight = linear.weight.detach().float()
        scale = weight.abs().amax().clamp(min=1e-12) / 448.0
        self.register_buffer("weight", (weight / scale).to(torch.float8_e4m3fn))
        self.register_buffer("scale", scale)
        self.register_buffer("bias", linear.bias.detach() if linear.bias is not None else None)
        self.in_features = linear.in_features
        self.out_features = linear.out_features

    def forward(self, value):
        shape = value.shape
        matrix = value.reshape(-1, self.in_features)
        rows = matrix.shape[0]
        matrix = F.pad(matrix, (0, 0, 0, (-rows) % 16))
        scale = matrix.float().abs().amax().clamp(min=1e-12) / 448.0
        quantized = (matrix.float() / scale).clamp(-448, 448).to(torch.float8_e4m3fn)
        result = torch._scaled_mm(quantized, self.weight.T, scale_a=scale,
                                  scale_b=self.scale, out_dtype=value.dtype)
        if self.bias is not None:
            result = result + self.bias
        return result[:rows].reshape(*shape[:-1], self.out_features)


def quantize_linears(model):
    """Quantize aligned encoder GEMMs; retain tiny heads, embeddings and norms in FP16."""
    count = 0
    for name, child in list(model.named_children()):
        if isinstance(child, nn.Linear) and child.in_features % 16 == 0 and child.out_features % 16 == 0:
            setattr(model, name, FP8Linear(child))
            count += 1
        else:
            count += quantize_linears(child)
    return count


def storage_report(model):
    tensors = list(model.parameters()) + list(model.buffers())
    totals = {}
    for tensor in tensors:
        key = str(tensor.device) + "/" + str(tensor.dtype)
        totals[key] = totals.get(key, 0) + tensor.numel() * tensor.element_size()
    return {"tensor_bytes": sum(totals.values()), "storage_by_device_dtype": totals}
