#pragma once

#include "history/ProjectHistory.hpp"
#include "libslic3r/Model.hpp"
#include "libslic3r/TriangleMesh.hpp"

namespace Slic3r::Neo::History::Codec {

// Capture the mutable object records and shared immutable mesh payloads used
// by Neo's object-history store.  The codec is deliberately independent of
// bridge-owned state and receives the model it serializes explicitly.
ModelState capture_model_state(const Model& model);

// Reconstruct a transient model from a retained history state.  model_template
// supplies the non-history model defaults needed while materializing a fresh
// object graph; it is never accessed through bridge-global state.
Model stage_model(const Model& model_template, const RestoreState& restored);

bool model_state_equal(const ModelState& lhs, const ModelState& rhs);

} // namespace Slic3r::Neo::History::Codec
